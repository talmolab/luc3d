#!/usr/bin/env python3
"""
DESIGN EXPLORATION for Fig 13a's lower half -- the greedy / Chen et al. 2020
cross-view assignment schematic. Not wired into any figure; writes one
comparison sheet for Eric to choose from (Eric, 2026-08-25: "i wonder if we can
improve the abstract diagram for the hungarian matching greedy per-view
assignment, separately show me some options that actually do the Chen et al
2020 method and show it better than an H in a square and an arow with the
circles under it").

WHAT THE SHIPPED VERSION SHOWS, AND WHY IT IS THIN. `panels/fig3_01_association.
draw_greedy` draws, per camera: a camera icon, a square containing the letter
"H", an arrow to the next camera, and three identity dots. That is a picture of
"something happens, then something happens again" -- it names the Hungarian
solve but shows none of its mechanics, and nothing at all of what makes this
Chen et al.'s method rather than any other sequential matcher.

THE MECHANICS IT SHOULD BE SHOWING (figs/FRESH-ANCHOR.md, Methods ▸ Cross-view
tracker, which is this repo's own description of the ported algorithm):
  * each identity is a persistent TARGET holding, per camera, its most recent
    matched detection, plus a 3D ANCHOR = DLT triangulation over those;
  * views are processed SEQUENTIALLY within a frame;
  * per view, an affinity matrix (targets x that view's detections) is solved
    as a ONE-TO-ONE assignment by the Hungarian algorithm -- jointly, so no
    target picks its match independently;
  * affinity = a 2D term (anchor REPROJECTED into the view vs the detection,
    attenuated by exp(-lambda*dt)) + a 3D term (anchor vs the rays
    BACK-PROJECTED through the detection, rewarded inside a distance threshold);
  * the matched detection replaces that camera's retained detection and the
    anchor is RE-TRIANGULATED before the next view is scored.
The anchor is the whole point: it is the persistent state that makes this
greedy pass work at all, and it is the thing Fig 13g's sweep and the
fresh-anchor result are about. None of it is currently drawn.

    .venv/bin/python figs/_explore_greedy_diagram.py

Writes figures/drafts/greedy-options.png -- six strips at the panel's true
size (88 x 28.29 mm native, the half that `grid(2, 1, ...)` gives this box,
which lands at ~77.5 x 24.9 mm once fig13 scales the a/b stack by 0.88), so
they are compared at print size. Strip 0 is the shipped drawing for reference.
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.patches import Circle, FancyArrowPatch, Rectangle

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
from src.diagram import blank, icon  # noqa: E402
from src.style import (GREY, INK, MUTED, TEAL, identity, mm, use)  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import panels.fig3_01_association as A  # noqa: E402

OUT = FIGS / "figures" / "drafts" / "greedy-options.png"

W_MM, H_MM = 88.0, 28.29          # the strip the greedy box actually gets
NCAM, NA = 4, 3
ID_IDX = A.ID_IDX                  # green / orange / blue, the panel's own slots

#: strip-local units: x in [0, 11.5], y in [0, 3.7] ~ the shipped box's frame
XMAX, YMAX = 11.5, 3.70
Y_TITLE, Y_SUB = 3.36, 2.84
Y_BAND = 0.15                      # floor of the content band
BAND_TOP = 2.46                    # nothing in the band may cross this
BAND_H = BAND_TOP - Y_BAND


def head(ax, title, sub):
    ax.text(0.05, Y_TITLE, title, fontweight="bold", color=TEAL, fontsize=7.5,
            va="center")
    ax.text(0.05, Y_SUB, sub, color=MUTED, fontsize=8.0, va="center")


def frame(ax, tag):
    blank(ax)
    ax.set_aspect("auto")
    ax.set_xlim(-0.1, XMAX + 0.1)
    ax.set_ylim(0, YMAX)
    ax.text(XMAX + 0.02, YMAX - 0.08, tag, ha="right", va="top",
            fontsize=6.5, color=GREY, style="italic")


# ---------------------------------------------------------------- 0. shipped
def opt_shipped(ax):
    frame(ax, "0 · shipped")
    head(ax, "Greedy per-view assignment", "LUC3D · C Hungarian solves, O(C·A³)")
    y_cam, y_h = Y_BAND + 1.35, Y_BAND + 0.35
    for i in range(NCAM):
        x = 0.7 + i * 2.35
        icon(ax, "camera", x, y_cam, s=0.62, color=INK)
        ax.add_patch(Rectangle((x, y_h), 0.72, 0.62, fill=False, ec=TEAL, lw=0.9))
        ax.text(x + 0.36, y_h + 0.31, "H", ha="center", va="center", color=TEAL,
                fontsize=7, fontweight="bold")
        for a in range(NA):
            ax.plot([x + 0.14 + a * 0.26], [Y_BAND + 0.18], "o", ms=5.0,
                    mfc=identity(ID_IDX[a]), mec="white", mew=0.6, zorder=4)
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.86, y_h + 0.31), (x + 2.2, y_h + 0.31),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))


# ------------------------------------------------- 1. anchor carried + updated
def opt_anchor_chain(ax):
    """The PERSISTENT STATE made visible: one anchor travelling left to right,
    re-triangulated after every camera commits. The camera row is the same row
    the exhaustive half uses, so the two stack in register."""
    frame(ax, "1 · anchor chain")
    head(ax, "Greedy per-view assignment", "LUC3D · anchor → assign → re-triangulate, ×C")
    y_cam = Y_BAND + 1.98
    y_anch = Y_BAND + 0.62
    ax.plot([0.15, XMAX - 0.15], [y_anch, y_anch], color=GREY, lw=0.7,
            ls=(0, (2.2, 1.8)), zorder=1)
    ax.text(0.15, y_anch + 0.42, "3D anchor", color=MUTED, fontsize=6.0, va="bottom")
    for i in range(NCAM):
        x = 0.95 + i * 2.55
        icon(ax, "camera", x - 0.31, y_cam, s=0.62, color=INK)
        # the two affinity terms, drawn as what they are: a reprojection DOWN
        # into the view and a ray back UP from the detection.
        ax.add_patch(FancyArrowPatch((x, y_anch + 0.16), (x, y_cam - 0.22),
                                     arrowstyle="-|>", mutation_scale=6,
                                     color=TEAL, lw=0.8, ls=(0, (1.6, 1.2)),
                                     shrinkA=0, shrinkB=0))
        # committed detection for this camera, in the winning identity's hue
        ax.plot([x], [y_cam - 0.36], "o", ms=4.6, mfc=identity(ID_IDX[i % NA]),
                mec="white", mew=0.6, zorder=5)
        # the anchor node, re-triangulated after this camera commits
        ax.plot([x], [y_anch], "o", ms=5.4, mfc="white", mec=TEAL, mew=1.2, zorder=5)
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.16, y_anch), (x + 2.39, y_anch),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=1.0, shrinkA=0, shrinkB=0))
    ax.text(0.15, Y_BAND + 0.06, "each camera commits, then the anchor is re-solved",
            ha="left", va="center", color=MUTED, fontsize=6.0)


# -------------------------------------------------------- 2. the cost matrix
def opt_matrix(ax):
    """What "Hungarian" actually means: one A x A cost matrix per camera, and a
    ONE-TO-ONE selection through it -- exactly one cell per row and column."""
    frame(ax, "2 · cost matrix per camera")
    head(ax, "Greedy per-view assignment", "LUC3D · one A×A assignment per camera")
    cell = 0.29
    y_top = Y_BAND + 1.62
    rng = np.random.default_rng(3)
    PERM = [(0, 1, 2), (1, 0, 2), (0, 2, 1), (2, 0, 1)]
    for i in range(NCAM):
        PICK = [(a, PERM[i][a]) for a in range(NA)]
        x0 = 0.95 + i * 2.55
        icon(ax, "camera", x0 + 0.12, Y_BAND + 1.98, s=0.52, color=INK)
        # target rows are identity-coloured; detection columns are neutral
        for a in range(NA):
            ax.plot([x0 - 0.22], [y_top - (a + 0.5) * cell], "o", ms=3.6,
                    mfc=identity(ID_IDX[a]), mec="white", mew=0.5, zorder=5)
        for a in range(NA):
            for d in range(NA):
                chosen = (a, d) in PICK
                v = 0.86 if chosen else 0.10 + 0.28 * rng.random()
                ax.add_patch(Rectangle((x0 + d * cell, y_top - (a + 1) * cell),
                                       cell, cell, facecolor=TEAL, alpha=v,
                                       edgecolor="white", lw=0.5, zorder=3))
        for (a, d) in PICK:
            ax.add_patch(Rectangle((x0 + d * cell, y_top - (a + 1) * cell),
                                   cell, cell, fill=False, edgecolor=INK,
                                   lw=1.0, zorder=6))
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x0 + NA * cell + 0.10, y_top - 1.5 * cell),
                                         (x0 + 2.30, y_top - 1.5 * cell),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text(0.05, Y_BAND + 0.08, "rows = targets · columns = this view's detections · "
            "outlined = the one-to-one assignment",
            color=MUTED, fontsize=6.0, va="center")


# ------------------------------------------------- 3. the two affinity terms
def opt_terms(ax):
    """WHAT IS BEING SCORED. Left: the geometry of one target-detection pair --
    the anchor reprojected into the view (2D term) and the detection's ray
    back-projected to the anchor (3D term). Right: the resulting assignment,
    repeated per camera."""
    frame(ax, "3 · what the affinity is")
    head(ax, "Greedy per-view assignment", "LUC3D · score against a 3D anchor, assign, repeat")
    # --- geometry cartoon, left third
    cx, cy = 1.45, Y_BAND + 1.62          # camera
    ix0, ix1 = 0.75, 2.35                 # image plane span
    iy = Y_BAND + 0.92
    anchor = (1.90, Y_BAND + 0.20)
    icon(ax, "camera", cx - 0.30, cy, s=0.58, color=INK)
    ax.plot([ix0, ix1], [iy, iy - 0.16], color=INK, lw=0.9, solid_capstyle="round")
    # anchor, its reprojection, and the detection it is scored against
    ax.plot(*anchor, "o", ms=5.4, mfc="white", mec=TEAL, mew=1.2, zorder=5)
    ax.text(anchor[0] + 0.52, anchor[1] + 0.30, "3D anchor", color=TEAL, fontsize=6.0,
            va="center", ha="left")
    reproj = (1.42, iy - 0.07)
    det = (1.00, iy - 0.02)
    ax.add_patch(FancyArrowPatch(anchor, reproj, arrowstyle="-|>", mutation_scale=6,
                                 color=TEAL, lw=0.8, ls=(0, (1.6, 1.2)),
                                 shrinkA=3, shrinkB=1))
    ax.plot(*reproj, "o", ms=3.4, mfc="none", mec=TEAL, mew=1.0, zorder=5)
    ax.plot(*det, "o", ms=4.4, mfc=identity(ID_IDX[1]), mec="white", mew=0.6, zorder=5)
    ax.plot([det[0], reproj[0]], [det[1], reproj[1]], color=INK, lw=1.2, zorder=4)
    ax.text((det[0] + reproj[0]) / 2, det[1] + 0.20, "2D", color=INK, fontsize=6.0,
            ha="center", fontweight="bold")
    # ray back through the detection, toward the anchor -> the 3D term
    d = np.array(det) - np.array([cx, cy])
    far = np.array(det) + d / np.linalg.norm(d) * 1.35
    ax.plot([cx, far[0]], [cy, far[1]], color=GREY, lw=0.7, ls=(0, (2.0, 1.6)), zorder=2)
    ax.plot([anchor[0], far[0]], [anchor[1], far[1]], color=TEAL, lw=1.2, zorder=4)
    ax.text((anchor[0] + far[0]) / 2 - 0.10, (anchor[1] + far[1]) / 2 - 0.22, "3D",
            color=TEAL, fontsize=6.0, ha="center", fontweight="bold")
    ax.add_patch(Circle(anchor, 0.42, fill=False, ec=TEAL, lw=0.6,
                        ls=(0, (1.4, 1.4)), zorder=2))
    ax.text(3.05, Y_BAND + 1.30, "affinity =", color=INK, fontsize=6.5, va="center")
    ax.text(3.05, Y_BAND + 0.78, "2D·e$^{-λΔt}$ + 3D", color=INK, fontsize=6.5,
            va="center")
    # --- the per-camera chain, right two-thirds
    for i in range(NCAM):
        x = 5.55 + i * 1.48
        icon(ax, "camera", x, Y_BAND + 1.90, s=0.52, color=INK)
        ax.add_patch(Rectangle((x - 0.02, Y_BAND + 0.72), 0.64, 0.58, fill=False,
                               ec=TEAL, lw=0.9))
        for a in range(NA):
            ax.plot([x + 0.09 + a * 0.22], [Y_BAND + 1.01], "o", ms=3.4,
                    mfc=identity(ID_IDX[a]), mec="white", mew=0.5, zorder=5)
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.68, Y_BAND + 1.01),
                                         (x + 1.24, Y_BAND + 1.01),
                                         arrowstyle="-|>", mutation_scale=6,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text(5.55, Y_BAND + 0.22, "assign one-to-one, commit, re-triangulate → next view",
            color=MUTED, fontsize=6.0, va="center")


# ------------------------------------------ 4. same material as the mesh above
def opt_commit(ax):
    """DIRECTLY COMPARABLE WITH THE EXHAUSTIVE HALF: identical camera columns and
    detection dots, but only ONE camera's candidate edges are live at a time and
    the chosen matching is committed before the next column is looked at. The
    contrast with the full mesh above is then the whole message."""
    frame(ax, "4 · commit as you go")
    head(ax, "Greedy per-view assignment", "LUC3D · C Hungarian solves, O(C·A³)")
    y_dots = [Y_BAND + 0.42, Y_BAND + 0.90, Y_BAND + 1.38]
    y_cam = Y_BAND + 2.05
    # the matching actually chosen in each gap -- a PERMUTATION, not the
    # identity, or the picture shows no matching structure at all.
    PERM = [(1, 0, 2), (0, 2, 1), (2, 1, 0)]
    xs = [1.15 + i * 2.35 for i in range(NCAM)]
    live = 1                      # the gap currently being solved
    for i, x in enumerate(xs):
        icon(ax, "camera", x - 0.30, y_cam, s=0.62, color=INK)
        for a in range(NA):
            solved = i <= live
            ax.plot([x], [y_dots[a]], "o", ms=5.0,
                    mfc=identity(ID_IDX[a]) if solved else "white",
                    mec="white" if solved else GREY, mew=0.6, zorder=5)
    for g in range(NCAM - 1):
        for a in range(NA):
            for b in range(NA):
                chosen = PERM[g][a] == b
                if g < live:                       # already committed
                    if not chosen:
                        continue
                    col, lw, al = identity(ID_IDX[a]), 1.5, 1.0
                elif g == live:                    # being solved now
                    col = identity(ID_IDX[a]) if chosen else GREY
                    lw, al = (1.5, 1.0) if chosen else (0.5, 0.55)
                else:                              # not looked at yet
                    continue
                ax.plot([xs[g], xs[g + 1]], [y_dots[a], y_dots[b]],
                        color=col, lw=lw, alpha=al, zorder=3 + chosen)
    for xmid, txt in ((xs[0] + 1.18, "committed"), (xs[1] + 1.18, "solving now"),
                      (xs[2] + 1.18, "not yet seen")):
        ax.text(xmid, Y_BAND + 0.06, txt, fontsize=6.0, color=MUTED, ha="center",
                va="center")


# ------------------------------- 5. anchor rail + the assignment that feeds it
def opt_anchor_matrix(ax):
    """OPTIONS 1 AND 2 TOGETHER. 1 shows the persistent anchor but not what the
    solve is; 2 shows the solve but not the state it is scored against. This
    draws both: a compact A x A assignment above each camera, and the anchor
    rail underneath being re-solved after each one commits."""
    frame(ax, "5 · anchor rail + assignment")
    head(ax, "Greedy per-view assignment", "LUC3D · assign against a 3D anchor, then re-solve it")
    cell = 0.26
    y_top = Y_BAND + 2.30
    y_anch = Y_BAND + 0.42
    PERM = [(0, 1, 2), (1, 0, 2), (0, 2, 1), (2, 0, 1)]
    rng = np.random.default_rng(11)
    ax.plot([0.15, XMAX - 0.15], [y_anch, y_anch], color=GREY, lw=0.7,
            ls=(0, (2.2, 1.8)), zorder=1)
    for i in range(NCAM):
        x0 = 1.05 + i * 2.55
        for a in range(NA):
            ax.plot([x0 - 0.20], [y_top - (a + 0.5) * cell], "o", ms=3.2,
                    mfc=identity(ID_IDX[a]), mec="white", mew=0.5, zorder=5)
            for d in range(NA):
                chosen = PERM[i][a] == d
                ax.add_patch(Rectangle((x0 + d * cell, y_top - (a + 1) * cell),
                                       cell, cell,
                                       facecolor=TEAL, alpha=0.85 if chosen else
                                       0.10 + 0.24 * rng.random(),
                                       edgecolor="white", lw=0.5, zorder=3))
                if chosen:
                    ax.add_patch(Rectangle((x0 + d * cell, y_top - (a + 1) * cell),
                                           cell, cell, fill=False, edgecolor=INK,
                                           lw=0.9, zorder=6))
        # the solve feeds the anchor, and the anchor is what it was scored on
        ax.add_patch(FancyArrowPatch((x0 + 0.5 * NA * cell, y_top - NA * cell - 0.05),
                                     (x0 + 0.5 * NA * cell, y_anch + 0.15),
                                     arrowstyle="-|>", mutation_scale=6,
                                     color=TEAL, lw=0.8, shrinkA=0, shrinkB=0))
        ax.plot([x0 + 0.5 * NA * cell], [y_anch], "o", ms=5.2, mfc="white",
                mec=TEAL, mew=1.2, zorder=5)
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x0 + 0.5 * NA * cell + 0.16, y_anch),
                                         (x0 + 2.55 + 0.5 * NA * cell - 0.16, y_anch),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=1.0, shrinkA=0, shrinkB=0))
    ax.text(0.15, Y_BAND + 0.02, "3D anchor, re-triangulated after every view commits",
            color=MUTED, fontsize=6.0, va="center")


def main():
    use()
    opts = [opt_shipped, opt_anchor_chain, opt_matrix, opt_terms, opt_commit,
            opt_anchor_matrix]
    fig, axes = plt.subplots(len(opts), 1,
                             figsize=(mm(W_MM), mm(H_MM * len(opts))),
                             layout="constrained")
    fig.get_layout_engine().set(h_pad=0.02, w_pad=0.0)
    for f, ax in zip(opts, axes):
        f(ax)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=400, facecolor="white")
    print(f"wrote {OUT.relative_to(FIGS.parent)}  "
          f"({len(opts)} strips at {W_MM:g} x {H_MM:g} mm each)")


if __name__ == "__main__":
    main()
