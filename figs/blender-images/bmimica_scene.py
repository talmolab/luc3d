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
"""
import argparse
import json
import math
import os
import sys

import bpy
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
    # half uses tab10 blue/orange and the two halves must read as one pair)
    for tr in range(pose.shape[0]):
        if not np.isnan(pose[tr]).all():
            cs.build_animal(tr, pose[tr], S["nodes"], M, scn_coll)

    # ---- framing: the arena box and the camera bodies, nothing else. Fitted BEFORE
    # the mounting hardware is built, because the rods have to be told how far to run
    # to leave the top of the frame (see build_ceiling below).
    hs = side / 2
    C_all = np.array([c["centre_mm"] for c in cams], float) * cs.MM
    corners = np.array([[cx + sx * hs, cy + sy * hs, z]
                        for sx in (-1, 1) for sy in (-1, 1) for z in (0.0, height)])
    cam_pts = np.concatenate([C_all, C_all + CAM_PAD, C_all - CAM_PAD])
    view_focus, ortho, res, y_top = fit_frame(np.vstack([corners, cam_pts]), (cx, cy),
                                              args.azim, args.elev)
    if args.ortho:
        ortho = args.ortho
    if args.res:
        res = tuple(args.res)
    print(f"framing: ortho {ortho:.3f} m, res {res[0]}x{res[1]} "
          f"(aspect {res[1] / res[0]:.3f}), focus "
          f"({view_focus[0]:.3f}, {view_focus[1]:.3f}, {view_focus[2]:.3f})")

    def ceiling_for(C):
        """The z at which a world-vertical rod at C's (x, y) leaves the top of the
        frame, plus a margin. cage_scene's fixed 1.5 m is right for the cage's
        framing and WRONG here -- this frame is 1.5 m tall, so at any elevation
        above ~25 deg a 1.5 m rod stopped in mid-air inside the picture."""
        _, up = screen_axes(args.azim, args.elev)
        # solve C_xy . up_xy + z * up_z = y_top + margin
        return float((y_top + 0.10 - C[0] * up[0] - C[1] * up[1]) / up[2])

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
    cs.setup_lighting((float(np.nanmean(pose[:, :, 0])),
                       float(np.nanmean(pose[:, :, 1])),
                       float(np.nanmean(pose[:, :, 2]))))
    cs.setup_cycles(args.samples, res)
    cs.setup_render_camera(view_focus, args.azim, args.elev, ortho)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cs.render_to(args.out)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
