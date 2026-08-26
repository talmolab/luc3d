#!/usr/bin/env python
"""Fig 5a's 3D reconstruction, rendered in the cage_scene.py house aesthetic.

Eric, 2026-08-16: replace fig5a's matplotlib stick-figure with a Blender render
matching renders/cage_two_mice.png — matte PBR ball-and-stick skeletons with
translucent body membranes, soft area lights, orthographic isometric camera.
This is a DIFFERENT dataset from the SLAP-2M cage sessions (no cage geometry
exists for it), so the volume is a plain translucent rectangular box: grey
translucent walls (flat_translucent, so they cannot go black when back-lit)
plus dark ink edge tubes, exactly the cage rendering's wall vocabulary on a
simple cuboid. NO cameras are rendered — the panel shows the five real views
as 2D projections beside this render; drawing camera bodies at made-up spots
would contradict them.

Everything scene-side is imported from cage_scene.py (materials, geometry
primitives, build_animal, lights, camera, Cycles setup); the two animals take
fig5's Set2 colours (teal #66C2A5 / pink #E78AC3, as in every fig5 panel) by
overriding cage_scene.TAB10[0]/[1] before build_animal caches its materials.

Data: ../out/fig5_views.json — pose_mm (2 animals x 15 nodes x 3, mm, z up);
floor_mm is subtracted so the floor is z = 0, and the scene is recentred on
the pose bounding-box midpoint so the box, lights and camera live at the
origin. The box is 260 x 260 x 140 mm sitting on the floor (pose xy extent is
~172 x 151 mm, heights to ~100 mm above floor).

THE SHIPPING COMMAND IS THE ONE BELOW, and it is not the argparse defaults. The
example here used to read `--azim 220 --elev 20 --res 2200 1650`, which is a
different camera and a different frame aspect from the render Fig 5a actually
carries; re-rendering from it silently changed the panel's viewpoint (caught by
Eric, 2026-08-19). The authoritative copy also lives in
panels/fig5_05_upright_views.py, whose BOX_MM must stay in step with `--box`.

  bpyenv/bin/python fig4a_scene.py --azim 255 --elev 22 --ortho 0.335 \
      --box 230 230 140 --samples 200 --res 1900 1900 \
      --out renders/fig4a_upright.png
"""
import argparse
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cage_scene as cs  # noqa: E402  (materials, primitives, animals, rig)

VIEWS_JSON = os.path.join(HERE, "..", "out", "fig5_views.json")

# fig5's two animals -- male/female (blue/red), matching every other fig5 panel
# (2026-08-21: was Set2 teal/pink, retired once every other fig5 panel moved to
# explicit male=blue/female=red; this was the one place still carrying the old
# palette, so the render disagreed with its own figure).
CA, CB = "#4393C3", "#D6604D"
# Color-space compensation (2026-08-16): cage_scene.hex2rgba feeds raw sRGB
# component values (/255) straight into Blender's LINEAR color sockets, which
# lightens every material well above its intended color — the systemic pastel
# wash in these renders. Rather than change cage_scene (its reference renders
# are approved as-is), we pre-LINEARIZE fig5's hexes (sRGB EOTF), so the
# raw-/255 interpretation lands on the correct linear values and the lit mice
# match the 2D projection views drawn in the true male/female colours.
CA_LIT, CB_LIT = "#0b3c6f", "#89180f"  # linearized male/female x0.8 (lighting lift)


def load_pose(path):
    """(2, 15, 3) in meters: floor at z=0, xy recentred on the bbox midpoint."""
    import json
    with open(path) as f:
        d = json.load(f)
    P = np.asarray(d["pose_mm"], float)                    # mm, z = height
    P[:, :, 2] -= d["floor_mm"]                            # floor -> z = 0
    mid = (P[:, :, :2].reshape(-1, 2).min(0) + P[:, :, :2].reshape(-1, 2).max(0)) / 2
    P[:, :, :2] -= mid                                     # box/camera at origin
    # a couple of tail keypoints triangulated a few mm below the floor; clamp
    # them onto it (visualization only — cage_scene's --clamp-tail, floor case)
    P[:, :, 2] = np.maximum(P[:, :, 2], 0.0005 / cs.MM)
    return P * cs.MM, d["nodes"]


def build_box(sx, sy, sz, M, coll, azim_deg=255.0):
    """The plain translucent volume as a CUTAWAY: only the two walls FACING
    AWAY from the render camera carry the grey film (the near walls and the
    lid would sit between the camera and the animals and wash their colors
    toward pastel — measured 2026-08-16: the albedo-darkening attempt barely
    moved the lit color; the front film was the desaturant). All 12 edges stay
    as dark ink tubes, so the volume still reads as a closed box; the box
    floor keeps the cage-floor grey for real shadows."""
    hx, hy = sx / 2, sy / 2
    C = {  # 8 corners: b=floor, t=top
        "b00": (-hx, -hy, 0), "b10": (hx, -hy, 0), "b11": (hx, hy, 0), "b01": (-hx, hy, 0),
        "t00": (-hx, -hy, sz), "t10": (hx, -hy, sz), "t11": (hx, hy, sz), "t01": (-hx, hy, sz),
    }
    faces = {
        "floor": ["b00", "b10", "b11", "b01"],
        "wall_s": ["b00", "b10", "t10", "t00"],
        "wall_e": ["b10", "b11", "t11", "t10"],
        "wall_n": ["b11", "b01", "t01", "t11"],
        "wall_w": ["b01", "b00", "t00", "t01"],
        "lid": ["t00", "t10", "t11", "t01"],
    }
    import math as _m
    # `v` is the HORIZONTAL DIRECTION FROM THE SCENE TOWARD THE CAMERA, matching
    # cage_scene.setup_render_camera, so a wall whose outward normal has a positive
    # dot with it is a NEAR wall, between the camera and the animals.
    v = (_m.cos(_m.radians(azim_deg)), _m.sin(_m.radians(azim_deg)))
    normals = {"wall_s": (0, -1), "wall_e": (1, 0), "wall_n": (0, 1), "wall_w": (-1, 0)}
    for name, loop in faces.items():
        if name == "lid":
            continue                       # cutaway: no lid film
        if name in normals:
            n = normals[name]
            # SENSE CORRECTED 2026-08-19. This test read `< 0.2` and therefore kept
            # the film on exactly the two walls the docstring says it removes: at the
            # default azimuth of 220 the near walls are wall_s and wall_w, and those
            # were the two being filled while the far walls got edges only. The
            # panel was being viewed through the very film the cutaway exists to
            # remove, which is the pastel wash the note above blames on it. Now the
            # NEAR walls are edges only and the far walls keep the film as a backdrop
            # (Eric: "make that front facing surface completely transparent").
            if n[0] * v[0] + n[1] * v[1] > -0.2:
                continue                   # near/side wall: edges only
        mat = M["cage_floor"] if name == "floor" else M["cage_wall"]
        cs.ngon(f"box_{name}", np.array([C[k] for k in loop], float), mat, coll)
    edges = [("b00", "b10"), ("b10", "b11"), ("b11", "b01"), ("b01", "b00"),
             ("t00", "t10"), ("t10", "t11"), ("t11", "t01"), ("t01", "t00"),
             ("b00", "t00"), ("b10", "t10"), ("b11", "t11"), ("b01", "t01")]
    for i, (a, b) in enumerate(edges):
        cs.tube(f"box_edge_{i}", np.array([C[a], C[b]], float), 0.0022, M["ink"], coll)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--views", default=VIEWS_JSON)
    ap.add_argument("--azim", type=float, default=220.0)
    ap.add_argument("--elev", type=float, default=20.0)
    ap.add_argument("--ortho", type=float, default=0.42)
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--res", type=int, nargs=2, default=[1600, 1200])
    ap.add_argument("--box", type=float, nargs=3, default=[260.0, 260.0, 140.0],
                    metavar=("SX", "SY", "SZ"),
                    help="volume dimensions in mm (stated on the panel — keep "
                         "panels/fig5_05_upright_views.py's text in sync)")
    ap.add_argument("--out", default=os.path.join(HERE, "renders", "fig4a_upright.png"))
    args = ap.parse_args()

    # fig5's animal colours instead of viz_08's tab10 — build_animal reads
    # TAB10[track], so overriding the first two slots recolours both mice
    cs.TAB10[0], cs.TAB10[1] = CA_LIT, CB_LIT

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    pose, nodes = load_pose(args.views)

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    # walls as the flat film (same back-lit-black failure mode as membranes)
    M["cage_wall"] = cs.flat_translucent(
        "cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    sx, sy, sz = (v * cs.MM for v in args.box)
    build_box(sx, sy, sz, M, scn_coll, azim_deg=args.azim)
    for tr in range(pose.shape[0]):
        cs.build_animal(tr, pose[tr], nodes, M, scn_coll)

    # room floor a hair below the box floor, big enough to hold every shadow
    floor = cs.box("room_floor", (6.0, 6.0, 0.02), (0, 0, 0), M["floor"], scn_coll)
    floor.location = (0, 0, -0.012)

    focus = (0.0, 0.0, 0.05)                   # lights: on the animals
    cs.setup_lighting(focus)
    cs.setup_cycles(args.samples, args.res)
    cs.setup_render_camera((0.0, 0.0, 0.055), args.azim, args.elev, args.ortho)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cs.render_to(args.out)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
