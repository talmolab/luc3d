#!/usr/bin/env python
"""Blender render of a BMimica session: the movement-fitted arena + animals + cameras.

Eric, 2026-08-17: "add a similar plot for the BMimica data as we did for SLAP-2M ...
to the right of the slap2m blender image in figure1 since there is so much white
space ... the cube volume should be as big as the whole space covered by their
movement, they are in a square so we should fit the cube to their overall movement to
approximate the floor, and then yes use the calibrations to place the cameras like we
did in the slap2m images."

So this is `cage_scene.py`'s render for the OTHER corpus, and it deliberately reuses
that script for everything scene-side (materials, primitives, ball-and-stick animals,
lights, Cycles/OptiX setup, the camera body + ceiling-rod hardware) plus
`fig5a_scene.py`'s cutaway translucent box, so the two Fig 1a halves read as one pair.
The three differences from SLAP-2M are all data, not style:

  1. NO CAGE RECONSTRUCTION EXISTS for BMimica -- there is no
     `aligned_cage_points3d.h5` -- so the volume is a box on the FOOTPRINT the animals
     actually covered (0.1-99.9 percentile x/y span, squared up), drawn with
     `fig5a_scene.build_box`'s wall vocabulary. Since 2026-08-17 that box is a CUBE on
     that footprint -- 650 mm, 4.4x the animals' own 147 mm vertical extent, which is
     what the deposit's earlier `height_mm` was and what printed as a shallow tray
     under cameras a metre up (Eric: "the volume of the cube needs to be much higher
     ... 4 or 5 times taller"). The height comes from the deposit, so
     `figs/fig1_bmimica_scene.py --height-mode movement` recovers the old render;
     the reasoning, including what the real arena's clear walls do and do not license,
     is in that script's docstring.
  2. FIVE cameras, not eight, and they are an OVERHEAD ARRAY: one looking straight
     down from 1.35 m and four tilted ~17 deg inward from ~1.0 m, ringing a 0.65 m
     arena. Nothing here assumes a camera count -- the list is whatever the session's
     `calibration/*_calibration.toml` holds.
  3. The 3D and the calibration are in DIFFERENT frames, so the cameras have to be
     carried into the P-frame by the alignment Fig 2/4/5 already fit.
  4. The pose is a MUTUAL UPRIGHT DISPLAY -- both animals rearing, noses converging --
     picked by a stated rule, not by hand (Eric: "lets choose a frame where it is more
     clear what the mice are doing"). Two animals lying flat, which is what the old
     maximise-plan-extent rule returned, read as two smears at 50 mm on the page.

All three come out of `../out/fig1_bmimica_scene.json`, which
`figs/fig1_bmimica_scene.py` deposits; nothing in this file measures anything.

FRAMING IS COMPUTED, NOT TYPED. The content box (arena corners + camera bodies) is
projected onto the render camera's screen axes and the orthographic scale, the aim
point and the output resolution all follow from it, so the frame is tight with no crop
constant to re-measure. The ceiling rods are deliberately EXCLUDED from that box and
run off the top of the image -- the same device `cage_scene.py` uses, and the reason
`panels/fig1_00_render.py` keeps y = 0 on the SLAP-2M crop.

  bpyenv/bin/python bmimica_scene.py                     # ~1 min, Cycles/OptiX (A40)
  bpyenv/bin/python bmimica_scene.py --samples 256       # the shipped still

VIDEO MODE mirrors `cage_scene.py --video` (same per-frame re-pose machinery, same
resume-safe absolute frame names, same --orbit/--orbit-range semantics) but the
framing is sweep-aware: this scene's frame is COMPUTED from the content, and both
the window and the ceiling-rod heights depend on azimuth, so an orbit fits ONE
fixed focus/ortho/res that covers every azimuth of the sweep (`fit_sweep`) and
rods run high enough to leave the frame at every azimuth. BMimica records at
150.105 fps (the deposit's `fps`), so STEP 5 encoded at 30 fps is real time to
0.07% — rendering all 9,000 frames for a 150 fps mp4 would quintuple the render
for playback no display shows. The 60 s clip around the shipped still (frame
56806, azim 218), 30 s either side, with the still's own view at the midpoint:

  bpyenv/bin/python bmimica_scene.py --video 52301 61311 5 --orbit 60 --azim 188 \
      --samples 96 --long-edge 1280 --outdir renders/video_bmimica60
  ffmpeg -framerate 30 -start_number 52301 -i renders/video_bmimica60/f%05d.png \
      -c:v libx264 -pix_fmt yuv420p -crf 20 renders/bmimica_arena_60s.mp4
"""
import argparse
import json
import math
import os
import sys

import bpy
import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cage_scene as cs            # noqa: E402  materials, primitives, animals, rig
from fig5a_scene import build_box  # noqa: E402  the cutaway translucent volume

SCENE_JSON = os.path.join(HERE, "..", "out", "fig1_bmimica_scene.json")

#: half-size (m) of a camera unit's body+lens, used only to pad the framing box so a
#: camera cannot be clipped by the auto-fit. `cage_scene.build_camera_unit` builds a
#: 42 x 42 x 58 mm body plus a lens standing 39 mm off the mount.
CAM_PAD = 0.045
#: extra margin (m) around the content box, in scene units on the image plane
FIT_MARGIN = 0.035
#: the rendered image's long edge, px. The short edge follows from the content aspect.
LONG_EDGE = 2000


def screen_axes(azim_deg, elev_deg):
    """The orthographic camera's right / up unit vectors, matching
    `cage_scene.setup_render_camera`'s azimuth/elevation placement."""
    a, e = math.radians(azim_deg), math.radians(elev_deg)
    right = np.array([-math.sin(a), math.cos(a), 0.0])
    up = np.array([-math.cos(a) * math.sin(e), -math.sin(a) * math.sin(e),
                   math.cos(e)])
    return right, up


def fit_frame(content, centre_xy, azim_deg, elev_deg, margin=FIT_MARGIN):
    """Frame the content box tightly.

    Returns (view_focus, ortho_scale, (res_x, res_y), y_top). `ortho_scale` is
    Blender's frustum size along the LARGER sensor dimension, so the resolution is
    chosen from the content aspect and the scale is that dimension's span. `y_top` is
    the window's upper edge on the screen-up axis, which is what tells the ceiling
    rods how far they have to run to leave the frame."""
    right, up = screen_axes(azim_deg, elev_deg)
    sx, sy = content @ right, content @ up
    x0, x1 = sx.min() - margin, sx.max() + margin
    y0, y1 = sy.min() - margin, sy.max() + margin
    span_x, span_y = x1 - x0, y1 - y0
    if span_y >= span_x:
        res = (max(2, int(round(LONG_EDGE * span_x / span_y))), LONG_EDGE)
        ortho = span_y
    else:
        res = (LONG_EDGE, max(2, int(round(LONG_EDGE * span_y / span_x))))
        ortho = span_x
    # re-centre: shift a point on the arena floor along the two screen axes so its
    # projection lands on the window centre (right/up are orthogonal to the view
    # direction, so this cannot change what is in frame)
    base = np.array([centre_xy[0], centre_xy[1], 0.0])
    focus = (base + ((x0 + x1) / 2 - base @ right) * right
             + ((y0 + y1) / 2 - base @ up) * up)
    return tuple(focus), ortho, res, y1


def fit_sweep(content, centre_xy, azims, elev_deg, margin=FIT_MARGIN,
              long_edge=LONG_EDGE, force_res=None):
    """`fit_frame` for an orbit: ONE fixed focus / ortho / res that keeps the
    content box in frame at EVERY azimuth of the sweep.

    Anchors the focus at the sweep-midpoint azimuth's tight fit, then widens the
    window to the worst-case projected extent across `azims`. By default the
    resolution follows the content aspect (long edge `long_edge`); with
    `force_res` the resolution is EXACTLY that, and the ortho is the smallest
    window of that aspect containing the content (the content is tall, so a
    forced landscape frame gains white margins left and right — the same airy
    composition cage_two_mice_60s.mp4 has). Returns
    (view_focus, ortho_scale, (res_x, res_y)); the window half-height the
    ceiling rods need is derived from ortho/res in main (Blender's ortho_scale
    spans the LARGER resolution dimension). Auto-fitted resolutions are rounded
    even for yuv420p encoding."""
    focus, _, _, _ = fit_frame(content, centre_xy, azims[len(azims) // 2],
                               elev_deg, margin)
    f = np.asarray(focus)
    half_x = half_y = 0.0
    for a in azims:
        right, up = screen_axes(a, elev_deg)
        sx, sy = content @ right - f @ right, content @ up - f @ up
        half_x = max(half_x, -sx.min(), sx.max())
        half_y = max(half_y, -sy.min(), sy.max())
    span_x, span_y = 2 * (half_x + margin), 2 * (half_y + margin)
    if force_res is not None:
        res = tuple(force_res)
        if res[0] >= res[1]:
            ortho = max(span_x, span_y * res[0] / res[1])
        else:
            ortho = max(span_x * res[1] / res[0], span_y)
        return tuple(focus), ortho, res
    if span_y >= span_x:
        res = (max(2, int(round(long_edge * span_x / span_y))), long_edge)
        ortho = span_y
    else:
        res = (long_edge, max(2, int(round(long_edge * span_y / span_x))))
        ortho = span_x
    res = tuple(r + (r % 2) for r in res)
    return tuple(focus), ortho, res


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scene", default=SCENE_JSON)
    ap.add_argument("--out", default=os.path.join(HERE, "renders", "bmimica_arena.png"))
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--azim", type=float, default=218.0,
                    help="near the arena corner, so the square floor reads widest; "
                         "cage_scene's 205 on a square would be 6% narrower")
    ap.add_argument("--elev", type=float, default=22.0,
                    help="cage_scene.py's elevation, so the pair matches")
    ap.add_argument("--cam-scale", type=float, default=1.0)
    ap.add_argument("--res", type=int, nargs=2, default=None,
                    help="override the auto-fitted resolution")
    ap.add_argument("--ortho", type=float, default=None,
                    help="override the auto-fitted orthographic scale")
    ap.add_argument("--video", nargs=3, type=int, metavar=("START", "END", "STEP"),
                    help="render a frame range from the deposit's points3d h5 "
                         "instead of the deposit's one still frame")
    ap.add_argument("--outdir", default=os.path.join(HERE, "renders", "video_bmimica"))
    ap.add_argument("--orbit", type=float, default=0.0,
                    help="degrees of render-camera azimuth sweep across the video")
    ap.add_argument("--orbit-range", nargs=2, type=int, metavar=("START", "END"),
                    help="frame range the orbit spans (defaults to --video's); "
                         "lets parallel workers render disjoint chunks of one sweep")
    ap.add_argument("--long-edge", type=int, default=LONG_EDGE,
                    help="rendered long edge, px (1280 for video parity with "
                         "cage_two_mice_60s.mp4)")
    ap.add_argument("--transparent-bounces", type=int, default=256,
                    help="Cycles transparent_max_bounces. cage_scene's 32 is NOT "
                         "enough here: two rearing mice in a clinch stack ~22 "
                         "membrane films on one ray (plus box walls), and a ray "
                         "grazing a fan-triangulated membrane edge-on crosses many "
                         "of its triangles -- exhausted rays paint torso patches "
                         "BLACK (video60 f61161: 344 black px at 32, 0 at 256; "
                         "diffs >20 confined to the patch, so bounce-cap re-renders "
                         "stay splice-safe)")
    args = ap.parse_args()

    with open(args.scene) as f:
        S = json.load(f)
    arena = S["arena"]
    side = arena["side_mm"] * cs.MM
    height = arena["height_mm"] * cs.MM
    cx, cy = (v * cs.MM for v in arena["centre_xy_mm"])
    pose = np.asarray(S["pose_mm"], float) * cs.MM        # (A, N, 3) m, floor z = 0
    cams = S["cameras"]
    print(f"{S['session']} frame {S['frame']}: arena {arena['side_mm']:.1f} mm square"
          f" x {arena['height_mm']:.1f} mm, {len(cams)} cameras, "
          f"{pose.shape[0]} animals")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    # walls as the flat film, as both other renders do (a lit translucent panel goes
    # BLACK from its unlit side; see cage_scene.flat_translucent)
    M["cage_wall"] = cs.flat_translucent(
        "cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    # ---- the movement-fitted arena. build_box is centred on the origin, so the
    # whole scene is shifted to the arena centre instead (the offset is ~2 mm).
    box_coll = bpy.data.collections.new("arena")
    scn_coll.children.link(box_coll)
    build_box(side, side, height, M, box_coll, azim_deg=args.azim)
    for ob in box_coll.objects:
        ob.location = (ob.location[0] + cx, ob.location[1] + cy, ob.location[2])

    # ---- the animals, in cage_scene's tab10 colours (NOT recoloured: the SLAP-2M
    # half uses tab10 blue/orange and the two halves must read as one pair).
    # Video mode instead builds/re-poses them per frame in the render loop below.
    if not args.video:
        for tr in range(pose.shape[0]):
            if not np.isnan(pose[tr]).all():
                cs.build_animal(tr, pose[tr], S["nodes"], M, scn_coll)

    # ---- framing: the arena box and the camera bodies, nothing else. Fitted BEFORE
    # the mounting hardware is built, because the rods have to be told how far to run
    # to leave the top of the frame (see build_ceiling below). An orbit sweeps the
    # azimuth, so the sweep fit covers every azimuth with one window (fit_sweep).
    hs = side / 2
    C_all = np.array([c["centre_mm"] for c in cams], float) * cs.MM
    corners = np.array([[cx + sx * hs, cy + sy * hs, z]
                        for sx in (-1, 1) for sy in (-1, 1) for z in (0.0, height)])
    cam_pts = np.concatenate([C_all, C_all + CAM_PAD, C_all - CAM_PAD])
    content = np.vstack([corners, cam_pts])
    if args.video and args.orbit:
        azims = list(np.linspace(args.azim, args.azim + args.orbit, 61))
        view_focus, ortho, res = fit_sweep(
            content, (cx, cy), azims, args.elev, long_edge=args.long_edge,
            force_res=tuple(args.res) if args.res else None)
    else:
        azims = [args.azim]
        view_focus, ortho, res, _ = fit_frame(content, (cx, cy), args.azim,
                                              args.elev)
        if args.long_edge != LONG_EDGE:
            scale = args.long_edge / max(res)
            res = tuple(max(2, int(round(r * scale))) for r in res)
        if args.res:
            res = tuple(args.res)
    if args.ortho:
        ortho = args.ortho
    # the window's half-height on the screen-up axis, for the ceiling rods:
    # Blender's ortho_scale spans the LARGER resolution dimension
    half_h = (ortho * res[1] / res[0] if res[0] >= res[1] else ortho) / 2
    print(f"framing: ortho {ortho:.3f} m, res {res[0]}x{res[1]} "
          f"(aspect {res[1] / res[0]:.3f}), focus "
          f"({view_focus[0]:.3f}, {view_focus[1]:.3f}, {view_focus[2]:.3f})")

    def ceiling_for(C):
        """The z at which a world-vertical rod at C's (x, y) leaves the top of the
        frame, plus a margin, at EVERY azimuth the render will visit.
        cage_scene's fixed 1.5 m is right for the cage's framing and WRONG here --
        this frame is 1.5 m tall, so at any elevation above ~25 deg a 1.5 m rod
        stopped in mid-air inside the picture."""
        z = 0.0
        for a in azims:
            _, up = screen_axes(a, args.elev)
            y_top = np.asarray(view_focus) @ up + half_h
            # solve C_xy . up_xy + z * up_z = y_top + margin
            z = max(z, float((y_top + 0.10 - C[0] * up[0] - C[1] * up[1]) / up[2]))
        return z

    # ---- the real cameras, placed exactly as cage_scene places SLAP-2M's ---------
    # cage_scene.build_camera_unit wants cam->world, whose COLUMNS are the camera's
    # right / down / forward axes in world coordinates; the deposit carries those
    # three axes already rotated into the P-frame.
    for c, C in zip(cams, C_all):
        R_c2w = np.stack([np.asarray(c["right"], float),
                          np.asarray(c["down"], float),
                          np.asarray(c["forward"], float)], axis=1)
        cs.build_camera_unit(c["name"], C, R_c2w.tolist(), M, scn_coll,
                             None, body_scale=args.cam_scale)
        cs.build_camera_support(c["name"], C, M, scn_coll, -0.012,
                                ceiling=ceiling_for(C))

    # Room floor a hair below the arena floor. 30 m, not cage_scene's 6 m: this frame
    # is 1.5 m tall and looks 1.5 m ABOVE the floor, so a 6 m slab put its own far
    # EDGE (the horizon) diagonally across the top-right corner of the first render.
    floor = cs.box("room_floor", (30.0, 30.0, 0.02), (0, 0, 0), M["floor"], scn_coll)
    floor.location = (cx, cy, -0.012)

    # Lights aim at the ANIMALS, not at the middle of the volume. Those are the same
    # point only while the box is the movement extent; with the box a cube on the
    # footprint (2026-08-17) its mid-height is 325 mm and the animals top out near
    # 130 mm, so `height * 0.5` pointed the key light a body length above them.
    # For a video the aim is the window-mean animal position (a fixed light rig,
    # like cage_scene's; the animals stay within centimetres of that mean's height).
    if args.video:
        start, end, step = args.video
        with h5py.File(S["points3d"]) as f:
            trx = f["tracks"][start:end] * 1000.0 * cs.MM   # (F, A, N, 3) m
        aim_pt = tuple(float(np.nanmean(trx[:, :, :, k])) for k in range(3))
    else:
        aim_pt = (float(np.nanmean(pose[:, :, 0])),
                  float(np.nanmean(pose[:, :, 1])),
                  float(np.nanmean(pose[:, :, 2])))
    cs.setup_lighting(aim_pt)
    cs.setup_cycles(args.samples, res)
    # override cage_scene's 32 -- see --transparent-bounces
    bpy.context.scene.cycles.transparent_max_bounces = args.transparent_bounces
    cam = cs.setup_render_camera(view_focus, args.azim, args.elev, ortho)

    if args.video:
        # cage_scene's video loop verbatim: absolute frame names (resume/parallel-
        # safe), re-pose animals in place, orbit shared across workers via
        # --orbit-range. STEP is the caller's fps contract (see the docstring).
        frames = list(range(start, end, step))
        os.makedirs(args.outdir, exist_ok=True)
        o0, o1 = args.orbit_range if args.orbit_range else (start, end)
        animals = {}  # track -> handles; rebuilt only if the live-track set changes
        for i, fr in enumerate(frames):
            outpath = os.path.join(args.outdir, f"f{fr:05d}.png")
            if os.path.exists(outpath):
                continue
            if args.orbit:
                az = args.azim + args.orbit * (fr - o0) / max(1, o1 - o0 - 1)
                el = math.radians(args.elev)
                d = cs.Vector(cam.location) - cs.Vector(view_focus)
                cam.location = cs.Vector(view_focus) + d.length * cs.Vector(
                    (math.cos(el) * math.cos(math.radians(az)),
                     math.cos(el) * math.sin(math.radians(az)),
                     math.sin(el)))
                cs.aim(cam, view_focus)
            pts = trx[fr - start]
            live = [tr for tr in range(pts.shape[0]) if not np.isnan(pts[tr]).all()]
            if set(live) != set(animals):
                cs.clear_animals(scn_coll)
                animals = {tr: cs.build_animal(tr, pts[tr], S["nodes"], M, scn_coll)
                           for tr in live}
            else:
                for tr in live:
                    cs.update_animal(animals[tr], pts[tr])
            cs.render_to(outpath)
            print(f"[{i + 1}/{len(frames)}] frame {fr}", flush=True)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        cs.render_to(args.out)
        print("wrote", args.out)


if __name__ == "__main__":
    main()
