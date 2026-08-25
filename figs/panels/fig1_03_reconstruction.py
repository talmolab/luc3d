#!/usr/bin/env python3
"""
Fig 1d -- the triangulated 3D next to the image it came from, then the whole rig.
(Was 1c until 2026-08-16, when the cage render became the figure's opening
panel -- Eric.)

THREE TILES, AND THE ORDER IS THE ARGUMENT: the camera's video with the tracked
overlays, the triangulated 3D pose those overlays produce, and the apparatus that
produced it -- the movement-fitted arena volume ringed by the calibrated cameras.
Reading left to right you go from pixels to geometry to the rig that connects them.

THE TWO 3D TILES ARE BLENDER RENDERS SINCE 2026-08-25 (Eric: "lets do nice blender
renders of the pose (center) and the camera rig (right) more like our other blender
rigs ... with the arena floor plane ... inferred from the trajectories ... shown
with the cameras like we have been visualizing the other arenas in the fig3 and
fig1a. we just need to make those look a bit nicer, i think they look like a mess
atm"). They used to be the app's own three.js canvases, which cost this panel a
long war of attrition documented in this file's git history: one-device-pixel
frustum lines that PRINT THINNER the larger the export (LineBasicMaterial ignores
linewidth), screen-space camera labels that shrink as the canvas grows, hand
re-measured content bboxes that silently slid off the content on every re-export.
All of that is gone: the tiles are now `blender-images/renders/fig1d_pose.png` and
`fig1d_rig.png`, rendered by `blender-images/fig1d_scene.py` from the deposit
`figs/fig1_hardfight_scene.py` writes -- the same cage_scene.py house aesthetic as
Fig 1a's two arena renders, framed COMPUTATIONALLY at exactly this panel's cell
aspects, so they are placed full-frame with no crop constants to re-measure.

WHAT KEEPS THE TILES HONEST. The pose render is the app's OWN reconstruction at
this same frame -- `node figs/fig1d_pose_export.mjs` runs the identical
trackAll + triangulateAll the video tile's overlays come from and exports the
per-identity 3D with its identity colours, so the mice match the overlays by
construction (deposit cross-check: app-vs-offline median keypoint distance ~1 mm).
It is no longer drawn from cam 0's calibrated viewpoint (that comparability was
the old center tile's argument, and it cost legibility: cam 0 looks straight
down, so the pose read as a flat smear); the render uses the Fig 1a family's
corner view instead, and the ARENA FLOOR PLANE under the mice ties it to the rig
tile, whose box floor is the same fitted rectangle.

THE RIG TILE SHOWS 7 OF 8 CAMERAS, keeping Eric's 2026-08-19 ruling from the old
tile ("not visualize that camera in the bottom left, there is too much black
space") -- Camera3_sideC sits ~350 mm beyond the next furthest camera and framing
on it shrinks everything else by ~30%; see fig1d_scene.py's docstring. The legend
must keep saying 7 of 8 (FIGURE-LEGENDS.md).

FRAME 198 since 2026-08-16 (see fig1_tracking.mjs for the choice's argument). The
video tile is still the app's own export (`after-f{frame}-Camera0_mid.png`, from
`node figs/fig1_tracking.mjs`), cropped to the manifest's content bbox -- but
since 2026-08-25 it is a CLEAN frame (`exportViews` with `overlay: false`) and
the identity-coloured skeletons are drawn HERE, in matplotlib, with
`src.skeleton_style.draw_pose_overlay` from the manifest's per-node
`details[].points` -- the same Fig 13c/d photo-overlay style, at the same stroke
weights as Fig 1c's after-tiles (keep POSE_* in sync with fig1_02_tracking.py),
so 1c-after and this tile read as the same drawing.

TILE SIZE. The row is 180 mm wide but only ~32 mm tall, so the tiles are
HEIGHT-limited: the crops are tight on the content vertically and open out to a
landscape aspect horizontally, which fills the row at no cost in magnification.
The Blender tiles are RENDERED at their cells' aspects (1.95 and 1.50), so their
"crop" is the full frame.

    python3 figs/panels/fig1_03_reconstruction.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.style import INK, SPAN, mm, save, tile, use  # noqa: E402
from src.skeleton_style import SLAP_NODES, draw_pose_overlay  # noqa: E402

import numpy as np  # noqa: E402

RENDERS = Path(__file__).resolve().parent.parent / "blender-images" / "renders"

VIEW_CAM = "Camera0_mid"

#: Skeleton stroke weights for the video tile, in ON-PAGE points. KEEP IN SYNC
#: with fig1_02_tracking.py's POSE_* -- this tile sits one row under 1c's
#: after-tiles, shows the same camera at near-identical magnification, and must
#: read as the same drawing. (See there for how they were scaled down from
#: Fig 13's lw=1.23 / ms=2.82.)
POSE_LW = 0.85
POSE_MS = 1.9
POSE_DOT_EDGE_LW = 0.45

#: (file, badge, badge colour, content bbox in source px, tile aspect w:h).
#: bbox None = the manifest's own content bbox (video tile); "full" = the whole
#: frame (the Blender tiles are rendered AT their cell aspect, nothing to crop).
#: The video tile keeps the white badge of the app exports; the Blender tiles
#: sit on a near-white room, so their badges are ink.
TILES = [
    ("after-f{frame}-Camera0_mid.png", "cam 0 mid", "white", None, 1.87),
    ("fig1d_pose.png", "triangulated 3D", INK, "full", 1.95),
    ("fig1d_rig.png", "Hard Fight rig", INK, "full", 1.50),
]
#: Breathing room added to the bbox HEIGHT, as a fraction of it -- the number that
#: sets how big everything prints, so it stays small. Applies to the video tile;
#: the Blender tiles carry their margin inside the render (fig1d_scene.FIT_MARGIN).
TILE_PAD = 0.07


def crop_to_aspect(bbox, src_w, src_h, aspect, pad):
    """`bbox` (source pixels) opened out to exactly `aspect`, clamped to the frame.

    Height comes from the bbox plus `pad`; width follows from `aspect`. When the
    window would fall outside the frame it is SLID rather than shrunk, so the tile
    keeps the aspect its cell was sized for -- a shrunk window would leave a gap
    and quietly change that tile's magnification.
    """
    x0, y0, x1, y1 = bbox
    h = min((y1 - y0) * (1 + pad), src_h)
    w = min(h * aspect, src_w)
    h = min(h, w / aspect)              # aspect wins if the width had to clamp
    cx = min(max((x0 + x1) / 2, w / 2), src_w - w / 2)
    cy = min(max((y0 + y1) / 2, h / 2), src_h - h / 2)
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


def main():
    use()
    j = load("fig1.json")
    bbox = None
    details = []
    for v in j["after"]:
        if v["name"] == VIEW_CAM:
            b = v["bbox"]
            bbox = (b["x0"], b["y0"], b["x1"], b["y1"])
            details = v["details"]

    # `details[].points` rows are in the SESSION skeleton's node order --
    # checked against the plotting skeleton's, not assumed (a re-ordered
    # skeleton would draw edges between the wrong joints).
    if j.get("skeletonNodes") != SLAP_NODES:
        sys.exit(f"fig1.json skeletonNodes != skeleton_style.SLAP_NODES:\n"
                 f"  manifest: {j.get('skeletonNodes')}\n  expected: {SLAP_NODES}")

    # The video tile's overlays and the Blender pose tile must be in the SAME
    # identity palette; the pose deposit carries the palette it exported with.
    # Report rather than assert -- a silent mismatch is what shipped once.
    pal = (j.get("identityPalette") or {}).get("identities") or []
    print("  identity palette (from fig1.json): "
          + ", ".join(f"{d['name']} {d['color']}" for d in pal))
    hf = load("fig1_hardfight_scene.json")
    print("  blender pose palette (fig1_hardfight_scene.json): "
          + ", ".join(hf["pose_colors"]))
    if [d["color"] for d in pal] != hf["pose_colors"]:
        print("  *** PALETTE MISMATCH between app export and blender deposit ***")

    fig, axes = plt.subplots(1, 3, figsize=(mm(SPAN["full"]), mm(35.0)),
                             layout="constrained",
                             gridspec_kw={"width_ratios": [a for *_, a in TILES]})
    # `rect` is `(left, bottom, WIDTH, HEIGHT)`, NOT `(left, bottom, right, top)`.
    # (History: written as the latter it pushed the tiles off the top of the page.)
    fig.get_layout_engine().set(rect=(0, 0.0, 1, 1.0), wspace=0.01,
                                w_pad=0.004, h_pad=0.004)
    for ax, (name_tpl, badge, bcol, crop, aspect) in zip(axes, TILES):
        name = name_tpl.format(frame=j["frame"])
        p = (OUT / name) if "{" in name_tpl or name.startswith("after") \
            else (RENDERS / name)
        if not p.exists():
            src = ("`node figs/fig1_tracking.mjs`" if name.startswith("after") else
                   "`blender-images/bpyenv/bin/python blender-images/fig1d_scene.py"
                   f" --mode {'pose' if 'pose' in name else 'rig'} --samples 200`")
            sys.exit(f"missing {p} — run {src}")
        # bbox=None: read the frame whole, then crop by setting the view limits.
        # imshow puts source pixels in data coordinates, so the axes shows exactly
        # the window asked for, keeps aspect='equal' (no stretching), and the badge
        # -- drawn in axes coordinates -- still lands in the tile's own corner.
        tile(ax, p, None, badge=badge, badge_color=bcol, corner="lower right")
        sh, sw = ax.images[0].get_array().shape[:2]
        window = (0, 0, sw, sh) if crop == "full" else (crop or bbox)
        pad = 0.0 if crop == "full" else TILE_PAD
        x0, y0, x1, y1 = crop_to_aspect(window, sw, sh, aspect, pad)
        ax.set_xlim(x0, x1)
        ax.set_ylim(y1, y0)           # imshow's y axis runs downwards
        if crop is None:
            # The video tile: identity-coloured Fig 13-style skeletons over the
            # clean frame, from the manifest's per-node points (source pixels =
            # imshow data coordinates; NaN nodes are skipped).
            for d in details:
                pts = np.array([q if q else (np.nan, np.nan)
                                for q in d["points"]], float)
                draw_pose_overlay(ax, pts, d["color"] or "#000000",
                                  lw=POSE_LW, ms=POSE_MS,
                                  dot_edge_lw=POSE_DOT_EDGE_LW, zorder=4.0)

    # The stat line ("3 animals triangulated from 8 cameras - 45/45 3D nodes
    # filled") is caption text and lives in figs/FIGURE-LEGENDS.md.
    print(f"  {j['stats']['groupsThisFrame']} animals from "
          f"{j['stats']['nCameras']} cameras, "
          f"{j['stats']['nodes3dFilled']}/{j['stats']['nodes3d']} 3D nodes filled")
    save(fig, 1, "d", "reconstruction")


if __name__ == "__main__":
    main()
