#!/usr/bin/env python3
"""
Fig 2a -- the reprojection-aided labelling protocol, staged in the real app.

EIGHT TILES ACROSS FOUR STEPS, ALL FROM THE APP. `fig2_protocol.mjs` drives LUC3D
itself: it labels two anchor views, sets every other view's weight to 0 through the
app's own Camera Views panel so the solve genuinely uses only those two, then reads
back the reprojections and the app's own per-view errors. Nothing here is drawn by
hand, and an earlier pass of this rewrite -- which replaced all eight tiles with a
synthetic five-camera cartoon -- threw away the only evidence the panel had.

  1  label two anchor views          -- cam 1 topB, cam 6 sideL
  2  triangulate from ONLY those two -- schematic + the resulting 3D
  3  reprojections appear            -- cam 0 mid, cam 2 topC, neither labelled
  4  accept or nudge                 -- magnified, with the measured error split

THE NUMBERS IN STEP 4 ARE MEASURED, not chosen: the two anchor views land low
because they were labelled, while the other six sit higher because they were only
reprojected into. That spread is what a labeller accepts or nudges, and it is
exactly why Fig 5 needed its OWN all-views staging -- reusing this deliberately
crippled two-anchor frame there would have inflated every residual by construction.

THIS PROTOCOL IS NOT NOVEL AND THE FIGURE MUST NOT IMPLY IT IS. JARVIS's
AnnotationTool already "leverages the multi camera recordings by projecting your
manual annotations on a subset of those cameras to the remaining ones" and shows a
reprojection error bar; Label3D is the direct predecessor for reprojection-aided
multi-camera 3D labelling. What is new here is the browser implementation and, above
all, the QUANTIFICATION in panels b-d. Both are named in Fig 1d and must be cited.

Source: figs/out/fig2-protocol.json + figs/out/fig2p-*.png
        (node figs/fig2_protocol.mjs)

    python3 figs/panels/fig2_01_protocol.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.diagram import blank, icon, point, ray  # noqa: E402
from src.style import GREY, INK, SALMON, SPAN, TEAL, mm, save, tile, use  # noqa: E402

STEPS = ["1  label 2 anchor views", "2  triangulate",
         "3  reprojections appear", "4  accept or nudge"]
REPROJ_CAMS = ["Camera0_mid", "Camera2_topC"]


def bbox_of(views, name):
    for v in views:
        if v["name"] == name:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def schematic(ax):
    """Two solid rays in from the anchors, several dashed reprojections out."""
    blank(ax)
    px, py = 1.6, 0.0
    for cy in (1.6, -1.6):                       # the two anchor cameras
        icon(ax, "camera", -2.3, cy - 0.3, s=0.6, color=INK)
        ray(ax, -1.6, cy, px, py, color=INK, lw=0.9)
    for cy in (1.8, 0.0, -1.8):                  # the views reprojected into
        icon(ax, "camera", 4.0, cy - 0.3, s=0.6, color=GREY)
        ray(ax, px, py, 3.9, cy, color=TEAL, ls=(0, (2.0, 1.5)))
    point(ax, px, py, color=SALMON, r=0.17)
    ax.text(px, py + 0.35, "3D", ha="center", va="bottom", color=SALMON,
            fontsize=6.5, fontweight="bold")
    ax.text(-2.4, -2.6, "2 views labelled", color=INK, fontsize=6.5)
    ax.text(-2.4, -3.2, "other 6: weight 0", color=GREY, fontsize=6.5)
    ax.text(5.0, -2.6, "rest reprojected", color=TEAL, fontsize=6.5, ha="right")
    ax.set_xlim(-2.6, 5.2)
    ax.set_ylim(-3.6, 2.6)


def main():
    use()
    p = load("fig2-protocol.json")
    anchors = p["anchors"]
    va, vr = p["views"]["anchor"], p["views"]["reproj"]

    # The measured split: the two anchor views against the six reprojected into.
    per = p["reprojErrorsTwoAnchors"]
    a_vals = [e["perView"][c] for e in per for c in anchors]
    o_vals = [v for e in per for c, v in e["perView"].items() if c not in anchors]

    fig = plt.figure(figsize=(mm(SPAN["full"]), mm(78.0)), layout="constrained")
    fig.get_layout_engine().set(rect=(0, 0, 1, 0.925))
    gs = fig.add_gridspec(2, 4)
    cells = {(r, c): fig.add_subplot(gs[r, c]) for r in (0, 1) for c in range(4)}

    # --- 1: the two anchor views ------------------------------------------
    for r, cam in enumerate(anchors):
        f = OUT / f"fig2p-anchor-f150-{cam}.png"
        if not f.exists():
            sys.exit(f"missing figs/out/{f.name} — run `node figs/fig2_protocol.mjs`")
        tile(cells[(r, 0)], f, bbox_of(va, cam),
             badge=f"{cam.split('_', 1)[1]} · anchor", pad=0.06)

    # --- 2: the solve, and what it produced -------------------------------
    schematic(cells[(0, 1)])
    tile(cells[(1, 1)], OUT / "fig2p-3d-animals.png", None,
         badge="3D from the 2 anchors")

    # --- 3: two views nobody labelled -------------------------------------
    for r, cam in enumerate(REPROJ_CAMS):
        tile(cells[(r, 2)], OUT / f"fig2p-reproj-f150-{cam}.png", bbox_of(vr, cam),
             badge=f"{cam.split('_', 1)[1]} · not labelled", pad=0.06)

    # --- 4: magnified, and the measured error split -----------------------
    b = bbox_of(vr, "Camera0_mid")
    zoom = (b[0], b[1], b[0] + (b[2] - b[0]) * 0.6, b[1] + (b[3] - b[1]) * 0.6)
    tile(cells[(0, 3)], OUT / "fig2p-reproj-f150-Camera0_mid.png", zoom,
         badge="magnified", pad=0.0)

    ax = cells[(1, 3)]
    blank(ax)
    ax.set_aspect("auto")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    for i, (t, c, w) in enumerate([
            ("2-anchor solve, this frame", INK, "bold"),
            (f"anchor views {min(a_vals):.1f}–{max(a_vals):.1f} px", INK, "normal"),
            (f"the other 6 {min(o_vals):.1f}–{max(o_vals):.1f} px", TEAL, "normal"),
            ("dotted = reprojected", GREY, "normal"),
            ("solid = detected", GREY, "normal")]):
        ax.text(0.0, 0.95 - i * 0.17, t, color=c, fontweight=w, fontsize=7, va="top")

    for k, title in enumerate(STEPS):
        x = cells[(0, k)].get_position().x0
        fig.text(x, 0.94, title, ha="left", va="bottom", fontweight="bold",
                 color=INK, fontsize=8)

    save(fig, 2, "a", "protocol")


if __name__ == "__main__":
    main()
