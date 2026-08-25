#!/usr/bin/env python
"""Blender renders of Fig 1d's two 3D tiles: the HardFight pose, and its rig.

Eric, 2026-08-25: "for the 3d views in fig1d lets do nice blender renders of the
pose (center) and the camera rig (right) more like our other blender rigs with
the arena floor plane shown for the Hard Fight dataset inferred from the
trajectories, it is also a rectangular prism or cube like volume, it should be
shown with the cameras like we have been visualizing the other arenas in the
fig3 and fig1a." The old tiles were the app's own three.js canvases -- one-pixel
frustum lines and unlit skeletons ("they look like a mess atm").

Two modes, one deposit (../out/fig1_hardfight_scene.json, written by
figs/fig1_hardfight_scene.py -- nothing in this file measures anything):

  --mode pose   the three mice at the panel's frame, ball-and-stick in the
                app's own identity colours (pre-linearized, see below), standing
                on the movement-fitted arena floor plane (the cage_floor film +
                ink edge tubes -- the floor of the box the rig mode draws, so
                the two tiles share their ground). Tight on the animals.
  --mode rig    the whole apparatus: the movement-fitted box (fig5a_scene's
                cutaway translucent volume -- a RECTANGULAR prism here, the
                measured 496 x 321 mm footprint, not squared up) with the mice
                inside and the eight calibrated cameras around it on their
                mounting hardware, exactly how cage_scene.py/bmimica_scene.py
                stage SLAP-2M's and BMimica's arenas in Fig 1a.

Everything scene-side is cage_scene.py's vocabulary (materials, primitives,
ball-and-stick animals, lights, Cycles/OptiX, the camera body + support
hardware) plus fig5a_scene.build_box, so Fig 1's three arena renders read as one
family. Framing is COMPUTED, not typed (bmimica_scene.fit_frame), but forced to
the panel cell's aspect so the render needs no crop: the panel places these
tiles full-frame.

IDENTITY COLOURS ARE PRE-LINEARIZED (fig5a_scene's fix): cage_scene.hex2rgba
feeds raw sRGB /255 values into Blender's LINEAR colour sockets, which washes
every material toward pastel. The deposit's palette hexes (#00b478 / #e69f00 /
#56b4e9 -- the same Okabe-Ito triple the video tile's overlays carry) go
through the sRGB EOTF (x0.8 lighting lift, fig5a's constant) before build_animal
sees them, so the LIT mice land near the palette the panel and video tile use.

RIG FRAMING EXCLUDES Camera3_sideC, KEEPING ERIC'S 2026-08-19 RULING on the old
tile ("not visualize that camera in the bottom left, there is too much black
space, lets look at the mice and the other cameras a bit more"): sideC sits
~350 mm beyond the next furthest camera (y = -793 vs -477), and framing on it
shrinks everything else by ~30%. The camera is still BUILT -- if its hardware
enters the window it appears honestly -- but the window is fitted to the other
seven, and the panel legend keeps saying 7 of 8 cameras.

  bpyenv/bin/python fig1d_scene.py --mode pose --samples 200   # ~1 min (A40)
  bpyenv/bin/python fig1d_scene.py --mode rig  --samples 200
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
import cage_scene as cs                      # noqa: E402
from bmimica_scene import screen_axes       # noqa: E402
from fig5a_scene import build_box            # noqa: E402

SCENE_JSON = os.path.join(HERE, "..", "out", "fig1_hardfight_scene.json")
CAM_PAD = 0.045     # bmimica_scene's framing pad around a camera body, m
FIT_MARGIN = 0.030  # margin around the content box on the image plane, m
LONG_EDGE = 2000


def lin_hex(h, lift=0.8):
    """sRGB hex -> hex whose raw-/255 reading IS the intended linear colour
    (fig5a_scene's pre-linearization, computed instead of hand-typed)."""
    v = []
    for i in (1, 3, 5):
        c = int(h[i:i + 2], 16) / 255.0
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        v.append(max(0, min(255, round(c * lift * 255))))
    return "#%02x%02x%02x" % tuple(v)


def fit_frame_aspect(content, centre_xy, azim_deg, elev_deg, aspect,
                     margin=FIT_MARGIN, long_edge=LONG_EDGE):
    """bmimica_scene.fit_frame, with the window FORCED to `aspect` (w:h > 1):
    the tight fit is widened along whichever axis falls short, so the content
    stays centred and the render drops into its panel cell with no crop.
    Returns (view_focus, ortho_scale, (res_x, res_y), y_top)."""
    right, up = screen_axes(azim_deg, elev_deg)
    sx, sy = content @ right, content @ up
    x0, x1 = sx.min() - margin, sx.max() + margin
    y0, y1 = sy.min() - margin, sy.max() + margin
    span_x, span_y = x1 - x0, y1 - y0
    if span_x / span_y < aspect:
        grow = span_y * aspect - span_x
        x0, x1 = x0 - grow / 2, x1 + grow / 2
    else:
        grow = span_x / aspect - span_y
        y0, y1 = y0 - grow / 2, y1 + grow / 2
    ortho = x1 - x0                                  # aspect > 1: x is the long edge
    res = (long_edge, max(2, int(round(long_edge / aspect))))
    base = np.array([centre_xy[0], centre_xy[1], 0.0])
    focus = (base + ((x0 + x1) / 2 - base @ right) * right
             + ((y0 + y1) / 2 - base @ up) * up)
    return tuple(focus), ortho, res, y1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mode", choices=["pose", "rig"], required=True)
    ap.add_argument("--scene", default=SCENE_JSON)
    ap.add_argument("--out", default=None,
                    help="default renders/fig1d_<mode>.png")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--azim", type=float, default=None,
                    help="default 218 (rig -- the Fig 1a family's corner view, "
                         "bmimica_scene) / 263 (pose -- Eric, 2026-08-25: 'turn "
                         "the camera around to the right so we can see the blue "
                         "a little better', then 'you revolved the camera to the "
                         "left not to the right as i wanted' when a first pass "
                         "picked 190. Rightward means azim ABOVE 218 here: swept "
                         "233/248/263/278; 263 opens the blue mouse and stands it "
                         "clear at frame left, 248 merges it with the orange "
                         "tail, 278 pushes it into the frame edge)")
    ap.add_argument("--elev", type=float, default=22.0)
    ap.add_argument("--aspect", type=float, default=None,
                    help="window w:h; defaults 1.95 (pose) / 1.50 (rig) -- the "
                         "panel's cell aspects (panels/fig1_03_reconstruction.py)")
    ap.add_argument("--cam-scale", type=float, default=1.0)
    ap.add_argument("--long-edge", type=int, default=LONG_EDGE)
    ap.add_argument("--exclude-frame-cams", nargs="*", default=["Camera3_sideC"],
                    help="cameras left out of the rig scene (see docstring)")
    ap.add_argument("--height-mm", type=float, default=None,
                    help="override the deposit's box height (diagnostics)")
    args = ap.parse_args()
    if args.azim is None:
        args.azim = 263.0 if args.mode == "pose" else 218.0
    aspect = args.aspect or (1.95 if args.mode == "pose" else 1.50)
    out = args.out or os.path.join(HERE, "renders", f"fig1d_{args.mode}.png")

    with open(args.scene) as f:
        S = json.load(f)
    arena = S["arena"]
    sx, sy = arena["x_span_mm"] * cs.MM, arena["y_span_mm"] * cs.MM
    sz = (args.height_mm or arena["height_mm"]) * cs.MM
    cx, cy = (v * cs.MM for v in arena["centre_xy_mm"])
    pose = np.asarray(S["pose_mm"], float) * cs.MM       # (A, 15, 3) m, floor z = 0
    cams = S["cameras"]
    colors = [lin_hex(c) for c in S["pose_colors"]]
    print(f"{S['session']} frame {S['frame']} ({args.mode}): arena "
          f"{arena['x_span_mm']:.0f} x {arena['y_span_mm']:.0f} x "
          f"{arena['height_mm']:.0f} mm, {len(cams)} cameras, "
          f"{pose.shape[0]} animals {S['pose_colors']}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    M["cage_wall"] = cs.flat_translucent(
        "cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    # ---- the animals, in the app's identity colours ----------------------------
    for tr in range(pose.shape[0]):
        if not np.isnan(pose[tr]).all():
            cs.build_animal(tr, pose[tr], S["nodes"], M, scn_coll, colors=colors)

    hx, hy = sx / 2, sy / 2
    if args.mode == "rig":
        # the movement-fitted volume + all 8 cameras (framed on 7, see docstring)
        box_coll = bpy.data.collections.new("arena")
        scn_coll.children.link(box_coll)
        build_box(sx, sy, sz, M, box_coll, azim_deg=args.azim)
        for ob in box_coll.objects:
            ob.location = (ob.location[0] + cx, ob.location[1] + cy, ob.location[2])
        # sideC is EXCLUDED FROM THE SCENE, not just the window: framed-out but
        # built, its body floated half-clipped at the frame edge, which reads as
        # a defect rather than a crop. 7 of 8 cameras, as the legend says.
        cams = [c for c in cams if c["name"] not in args.exclude_frame_cams]
        C_all = np.array([c["centre_mm"] for c in cams], float) * cs.MM
        corners = np.array([[cx + ux * hx, cy + uy * hy, z]
                            for ux in (-1, 1) for uy in (-1, 1) for z in (0.0, sz)])
        # low cameras stand on rods to the room floor (build_camera_support):
        # include each stand's foot so no rod is cut at the bottom of the frame
        feet = np.array([[c[0], c[1], 0.0] for c in C_all if c[2] <= 0.4])
        content = np.vstack([corners, C_all + CAM_PAD, C_all - CAM_PAD, feet])
    else:
        # the arena FLOOR PLANE only (the rig box's own floor + ink edges), the
        # frame tight on the animals
        floor_coll = bpy.data.collections.new("arena_floor")
        scn_coll.children.link(floor_coll)
        Cn = {"b00": (cx - hx, cy - hy, 0), "b10": (cx + hx, cy - hy, 0),
              "b11": (cx + hx, cy + hy, 0), "b01": (cx - hx, cy + hy, 0)}
        cs.ngon("arena_floor", np.array([Cn[k] for k in ("b00", "b10", "b11", "b01")],
                                        float), M["cage_floor"], floor_coll)
        for i, (a, b) in enumerate([("b00", "b10"), ("b10", "b11"),
                                    ("b11", "b01"), ("b01", "b00")]):
            cs.tube(f"floor_edge_{i}", np.array([Cn[a], Cn[b]], float), 0.0022,
                    M["ink"], floor_coll)
        P = pose.reshape(-1, 3)
        content = P[~np.isnan(P).any(1)]

    view_focus, ortho, res, y_top = fit_frame_aspect(
        content, (cx, cy), args.azim, args.elev, aspect,
        long_edge=args.long_edge)
    print(f"framing: ortho {ortho:.3f} m, res {res[0]}x{res[1]}, focus "
          f"({view_focus[0]:.3f}, {view_focus[1]:.3f}, {view_focus[2]:.3f})")

    if args.mode == "rig":
        _, up = screen_axes(args.azim, args.elev)

        def ceiling_for(C):
            """where a vertical rod at C leaves the top of frame (bmimica_scene)"""
            return float((y_top + 0.10 - C[0] * up[0] - C[1] * up[1]) / up[2])

        for c, C in zip(cams, C_all):
            R_c2w = np.stack([np.asarray(c["right"], float),
                              np.asarray(c["down"], float),
                              np.asarray(c["forward"], float)], axis=1)
            cs.build_camera_unit(c["name"], C, R_c2w.tolist(), M, scn_coll,
                                 None, body_scale=args.cam_scale)
            cs.build_camera_support(c["name"], C, M, scn_coll, -0.012,
                                    ceiling=ceiling_for(C))

    # room floor a hair below the arena floor, big enough for every shadow
    floor = cs.box("room_floor", (30.0, 30.0, 0.02), (0, 0, 0), M["floor"], scn_coll)
    floor.location = (cx, cy, -0.012)

    aim_pt = tuple(float(np.nanmean(pose[:, :, k])) for k in range(3))
    cs.setup_lighting(aim_pt)
    cs.setup_cycles(args.samples, res)
    # the fight clinch stacks many membrane films on one ray (bmimica_scene's
    # black-patch failure at cage_scene's 32)
    bpy.context.scene.cycles.transparent_max_bounces = 256
    cs.setup_render_camera(view_focus, args.azim, args.elev, ortho)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    cs.render_to(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
