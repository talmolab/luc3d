#!/usr/bin/env python3
"""
Fig 4a -- the three triangulation solvers, and what actually separates them.

THE NAMING IS WRONG IN THE APP'S UI AND THIS PANEL DOES NOT REPEAT IT. LUCID's
menu calls the middle solver "Bundle Adjustment", but it holds the cameras FIXED,
so it is non-linear TRIANGULATION (aniposelib's `optim_points`). True joint bundle
adjustment is a separate function, `bundleAdjustCameras`, deliberately not wired to
the UI because rewriting a project's calibration invalidates every 3D point derived
from it. `pose/triangulation.js` says so itself. The panel therefore shows THREE
boxes, not two, and each is labelled with its status in the shipped app.

What is drawn, per solver, is the one distinction that matters:
  * which error it minimises  -- straight (algebraic) vs bowed (geometric, in the
    camera's native distorted pixels);
  * whether the cameras move  -- padlock vs double arrow;
  * whether it iterates       -- the loop on the third box.

This is a nomenclature correction, not a result, which is why it leads as a
schematic and carries no numbers.

    python3 figs/panels/fig4_01_solvers.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, camera, free, lock, point, ray, residual, loop  # noqa: E402
from src.style import grid, GREY, INK, PERIWINKLE, TEAL, save, use  # noqa: E402

SOLVERS = [
    dict(title="Linear DLT", sub="algebraic error · closed form",
         tag="app default", color=PERIWINKLE, fixed=True, curved=False,
         iterative=False),
    dict(title="Non-linear triangulation", sub="geometric error · native pixels",
         tag="app menu: “Bundle Adjustment”", color=TEAL, fixed=True, curved=True,
         iterative=False),
    dict(title="Joint bundle adjustment", sub="cameras + structure · iterative",
         tag="not wired to the UI", color=GREY, fixed=False, curved=True,
         iterative=True),
]


def draw(ax, s):
    blank(ax)
    cy_hi, cy_lo = 1.9, -1.9
    px, py = 3.4, 0.0

    for cy in (cy_hi, cy_lo):
        camera(ax, 0.0, cy, s=0.62, color=INK)
        ray(ax, 0.7, cy, px, py)
        if s["fixed"]:
            lock(ax, 0.0, cy - 1.1, s=0.62)
        else:
            free(ax, 0.05, cy - 1.05, s=0.62, color=s["color"])

    point(ax, px, py, color=INK)
    residual(ax, px, py, px + 1.5, py + 1.0, s["color"], curved=s["curved"])
    if s["iterative"]:
        loop(ax, px + 0.75, py - 1.3, r=0.5, color=s["color"], label="repeat")

    ax.set_xlim(-1.4, 5.6)
    ax.set_ylim(-3.6, 4.4)
    # Title block reads top-down: what it is, what it minimises, what the app calls it.
    ax.text(-1.4, 4.3, s["title"], fontweight="bold", va="top", color=INK)
    ax.text(-1.4, 3.6, s["sub"], va="top", color=GREY, fontsize=7)
    ax.text(-1.4, 3.0, s["tag"], va="top", color=s["color"], fontsize=7)


def main():
    use()
    fig, axes = grid(1, 3, span="full", row=50.0, despine=False)
    for ax, s in zip(axes, SOLVERS):
        draw(ax, s)
    fig.subplots_adjust(wspace=0.05)
    save(fig, 4, "a", "solvers")


if __name__ == "__main__":
    main()
