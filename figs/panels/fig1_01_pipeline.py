#!/usr/bin/env python3
"""
Fig 1a -- what LUC3D does, end to end.

Five stages, left to right, with the two that are contributions of this paper marked.
Everything downstream of "per-view detections" runs in the browser with no install,
which is the claim the Fig 1d table's "Install: none / Runs in: browser" row makes
and this panel visualises.

WHAT IS AND IS NOT OURS. The detector is not: 2D pose comes from SLEAP or any other
per-view predictor, and LUC3D consumes `.slp`. The contributions are the cross-view
association (Fig 3) and the reprojection-aided annotation and proofreading loop
(Figs 2 and 5). Marking them explicitly keeps the schematic from reading as a claim
over the whole pipeline.

Drawn as flat chevrons at one stroke weight, Cheese3D-style: no gradients, no
drop shadows, no 3D boxes.

    python3 figs/panels/fig1_01_pipeline.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon  # noqa: E402
from src.style import grid, GREY, INK, SALMON, TEAL, save, use  # noqa: E402

#: label, sub-label, is-a-contribution-of-this-paper
#: SIX stages, matching the legacy figure. Export is not decoration: emitting SLP
#: 2.8 with the columnar /session_data is what makes the 3D readable by SLEAP, and
#: dropping it made the pipeline look like a dead end.
STAGES = [
    ("videos +\ncalibration", "N cameras, .toml", False, "cameras"),
    ("2D pose", "SLEAP or similar", False, "skeleton"),
    ("cross-view\nre-ID", "1 identity / animal", True, "ids"),
    ("triangulate", "DLT, N ≥ 2 views", True, "triangulate"),
    ("proofread 3D", "3D + reproj.", True, "check"),
    ("export", ".slp 2.8 / H5", False, "file"),
]

W, H, GAP, NOTCH = 2.05, 1.55, 0.36, 0.26



def chevron(ax, x, y, ours):
    color = TEAL if ours else GREY
    pts = [(x, y - H / 2), (x + W - NOTCH, y - H / 2), (x + W, y),
           (x + W - NOTCH, y + H / 2), (x, y + H / 2), (x + NOTCH, y)]
    ax.add_patch(Polygon(pts, closed=True, facecolor="none", edgecolor=color,
                         lw=1.1, joinstyle="miter"))
    return color


def main():
    use()
    fig, ax = grid(1, 1, span="full", row=32.0, despine=False)
    blank(ax)

    for i, (label, sub, ours, kind) in enumerate(STAGES):
        x = i * (W + GAP)
        color = chevron(ax, x, 0.0, ours)
        # Icon above, label below -- the legacy arrangement. The icons carry the
        # pipeline on their own, which is what makes it a schematic and not a row
        # of captions.
        icon(ax, kind, x + W / 2 - 0.24, 0.16, s=0.48, color=color)
        ax.text(x + W / 2, -0.14, label, ha="center", va="top", color=INK,
                fontsize=7.5, linespacing=1.2)
        ax.text(x + W / 2, -H / 2 - 0.26, sub, ha="center", va="top", color=GREY,
                fontsize=6.5)

        if i:
            ax.add_patch(FancyArrowPatch(
                (x - GAP + 0.06, 0), (x + 0.04, 0), arrowstyle="-|>",
                mutation_scale=7, color=GREY, lw=0.9, shrinkA=0, shrinkB=0))

    # ONE bracket under the three stages this paper contributes, as in the legacy
    # figure. Per-stage "this paper" tags said the same thing three times and did
    # not show that the three are a single contiguous contribution.
    ours = [i for i, (_, _, o, _k) in enumerate(STAGES) if o]
    x0 = ours[0] * (W + GAP)
    x1 = ours[-1] * (W + GAP) + W
    yb = -H / 2 - 0.62
    ax.plot([x0, x0, x1, x1], [yb + 0.16, yb, yb, yb + 0.16], color=TEAL, lw=0.9)
    ax.text((x0 + x1) / 2, yb - 0.12, "this work", ha="center", va="top",
            color=TEAL, fontsize=7, fontweight="bold")
    span = len(STAGES) * (W + GAP) - GAP

    ax.set_xlim(-0.35, span + 0.35)
    ax.set_ylim(-H / 2 - 1.55, H / 2 + 0.30)
    save(fig, 1, "a", "pipeline")


if __name__ == "__main__":
    main()
