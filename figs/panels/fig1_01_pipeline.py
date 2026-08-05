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

#: Chevron geometry. The box holds the ICON ONLY and the label sits under it --
#: see `main()` for why the label is no longer inside the chevron.
W, H, GAP, NOTCH = 2.05, 1.05, 0.36, 0.24



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
        # ICON INSIDE THE CHEVRON, LABEL UNDER IT. The label used to sit inside the
        # chevron too, and it did not fit: a chevron is narrowest exactly where the
        # notch cuts it, so the two-line labels ("videos + / calibration",
        # "cross-view / re-ID") dropped through the bottom edge and the widest
        # one-line label ("proofread 3D") ran out through the right point. Under the
        # box there is the whole pitch to write in, so nothing has to be shrunk
        # below the 7.5 pt this row already uses.
        icon(ax, kind, x + W / 2 - 0.25, -0.25, s=0.50, color=color)
        ax.text(x + W / 2, -H / 2 - 0.16, label, ha="center", va="top", color=INK,
                fontsize=7.5, linespacing=1.25)
        # Sub-labels are all on ONE baseline rather than hung off their own label,
        # so the row reads as a row even though some labels wrap and some do not.
        ax.text(x + W / 2, -1.42, sub, ha="center", va="top", color=GREY,
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
    yb = -1.80
    ax.plot([x0, x0, x1, x1], [yb + 0.14, yb, yb, yb + 0.14], color=TEAL, lw=0.9)
    ax.text((x0 + x1) / 2, yb - 0.10, "this work", ha="center", va="top",
            color=TEAL, fontsize=7, fontweight="bold")
    span = len(STAGES) * (W + GAP) - GAP

    ax.set_xlim(-0.35, span + 0.35)
    ax.set_ylim(-2.22, H / 2 + 0.30)
    save(fig, 1, "a", "pipeline")


if __name__ == "__main__":
    main()
