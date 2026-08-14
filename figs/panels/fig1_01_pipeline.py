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
from src.style import MUTED, grid, GREY, INK, SALMON, TEAL, save, use  # noqa: E402

#: label, sub-label, is-a-contribution-of-this-paper
#: SIX stages, matching the legacy figure. Export is not decoration: emitting SLP
#: 2.8 with the columnar /session_data is what makes the 3D readable by SLEAP, and
#: dropping it made the pipeline look like a dead end.
#: Icons are the pipeline's own objects (review 2026-08), not generic marks:
#: "2D pose" is two animals' poses in ONE colour (identity does not exist yet),
#: "triangulate" is one animal's 3D pose over a ground plane, and "proofread 3D"
#: is the two re-identified instances in the identity palette -- the same mini
#: pose at three stages, so the row reads as one object moving through the
#: pipeline. The glyphs live in src/diagram.py `icon()`.
#: EXPORT IS OURS (review 2026-08-13). It was marked False, which made the pipeline
#: read as ending in someone else's format. Emitting SLP 2.8 with the columnar
#: `/session_data` is this work -- it is what makes the 3D and the identities readable
#: by SLEAP at all -- so it joins the contributed run, and the "this work" bracket
#: (drawn from the contiguous run of contributed stages) now reaches the end of the row.
#:
#: CALIBRATION IS A SIDE INPUT, NOT PART OF STAGE 1 (review 2026-08-13: "just videos
#: and make calibration separate?"). It used to be glued to "videos", which implied it
#: arrives with them. It is a separate artefact, and it is consumed at TRIANGULATION,
#: not at 2D pose -- a detector needs no calibration. It is therefore drawn as a
#: labelled arrow entering the triangulate stage from below; see `main()`.
STAGES = [
    ("videos", "N cameras", False, "cameras"),
    ("2D pose", "SLEAP or similar", False, "tiles2d"),
    ("cross-view\nre-ID", "1 identity / animal", True, "tilesid"),
    ("triangulate", "DLT, N ≥ 2 views", True, "volume3d"),
    ("proofread 3D", "3D + reproj.", True, "instances3d"),
    ("export", ".slp 2.8 / H5", True, "file"),
]

#: Which stage the calibration side-input points at, by index into STAGES.
CALIB_STAGE = 3

#: Chevron geometry. The box holds the ICON ONLY and the label sits under it --
#: see `main()` for why the label is no longer inside the chevron.
W, H, GAP, NOTCH = 2.05, 1.05, 0.36, 0.24

#: Vertical extent of the drawing, in data units, cut to the INK. Top: the chevron's
#: top edge at H/2 plus half of its 1.1 pt stroke (0.02 units). Bottom: the baseline
#: of the "this work" label, which sits at about -2.10 -- measured off the render, not
#: guessed. The panel used to declare (-2.22, H/2 + 0.30), i.e. 0.28 units of pure
#: white above the chevrons, which is 2.8 mm of the figure at the scale below.
#: Where the calibration side-input's arrow starts, above the chevron row. The top of
#: YLIM follows from it plus the 6.5 pt label, which is why the two are declared together.
CAL_Y = H / 2 + 0.30
YLIM = (-2.20, CAL_Y + 0.42)

#: Millimetres per data unit. THIS, NOT THE PANEL HEIGHT, IS THE FIXED QUANTITY.
#: `blank()` sets aspect='equal' and the drawing is 14.8 units wide against 2.8 tall,
#: so 180 mm of width is never the constraint: the axes is HEIGHT-bound and the scale
#: is axes_height / (YLIM range). Every chevron, icon, arrow and bracket therefore
#: prints at (panel height) x (this scale) -- but the TEXT does not, because fontsize
#: is in points. So shrinking the panel closes the gaps BETWEEN the label lines in
#: millimetres while the type stays 7.5/6.5 pt, and at the old 32 mm the sub-label
#: baseline already cleared the two-line labels ("videos + / calibration") by only
#: 0.6 mm. The height is consequently derived from the scale and the ink, and the
#: only thing that came out of it is dead margin. 9.85 is the value the 32 mm version
#: rendered at, so the marks print at exactly the size they did before.
MM_PER_UNIT = 9.85
#: constrained_layout's outer pad, in mm. Nothing is drawn outside the axes here, and
#: the assembler already leaves 4.5 mm of lead above every row for the panel letter,
#: so the default 1.06 mm on each side is 2.1 mm of dead figure.
PAD_MM = 0.35
#: Panel height in mm: the ink, at the scale above, plus the outer pad. Was 32.0.
ROW_MM = MM_PER_UNIT * (YLIM[1] - YLIM[0]) + 2 * PAD_MM



def chevron(ax, x, y, ours):
    color = TEAL if ours else GREY
    pts = [(x, y - H / 2), (x + W - NOTCH, y - H / 2), (x + W, y),
           (x + W - NOTCH, y + H / 2), (x, y + H / 2), (x + NOTCH, y)]
    ax.add_patch(Polygon(pts, closed=True, facecolor="none", edgecolor=color,
                         lw=1.1, joinstyle="miter"))
    return color


def main():
    use()
    fig, ax = grid(1, 1, span="full", row=ROW_MM, despine=False)
    # `w_pad`/`h_pad` are INCHES. Trimmed to PAD_MM because the axes holds every mark
    # this panel draws -- there is no tick label or title outside it to make room for.
    fig.get_layout_engine().set(w_pad=PAD_MM / 25.4, h_pad=PAD_MM / 25.4)
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
        # The three multi-view glyphs are WIDE (see src/diagram.icon): they are
        # centred on the same point and spend the chevron's spare width, which is what
        # lets three camera tiles stay legible at this scale.
        icon(ax, kind, x + W / 2 - 0.25, -0.25, s=0.50, color=color)
        ax.text(x + W / 2, -H / 2 - 0.16, label, ha="center", va="top", color=INK,
                fontsize=7.5, linespacing=1.25)
        # Sub-labels are all on ONE baseline rather than hung off their own label,
        # so the row reads as a row even though some labels wrap and some do not.
        ax.text(x + W / 2, -1.42, sub, ha="center", va="top", color=MUTED,
                fontsize=6.5)

        if i:
            ax.add_patch(FancyArrowPatch(
                (x - GAP + 0.06, 0), (x + 0.04, 0), arrowstyle="-|>",
                mutation_scale=7, color=GREY, lw=0.9, shrinkA=0, shrinkB=0))

    # CALIBRATION, ENTERING WHERE IT IS ACTUALLY USED. An arrow up into the
    # triangulate chevron rather than a word inside stage 1: 2D pose does not need
    # calibration and triangulation cannot proceed without it, and the figure should
    # say which. Drawn in MUTED so it reads as an input to the row, not a stage in it.
    # ABOVE the row, not below it: under the chevron the label landed on the
    # "triangulate" caption and its sub-label ("DLT, N >= 2 views"), which is the one
    # band of this panel that is already full. Above the chevrons nothing is drawn at
    # all, and an input arriving from outside the row reads correctly as an input.
    cx_cal = CALIB_STAGE * (W + GAP) + W / 2
    ax.text(cx_cal, CAL_Y + 0.10, "calibration (.toml)", ha="center", va="bottom",
            color=MUTED, fontsize=6.5)
    ax.add_patch(FancyArrowPatch((cx_cal, CAL_Y + 0.06), (cx_cal, H / 2 + 0.03),
                                 arrowstyle="-|>", mutation_scale=6,
                                 color=MUTED, lw=0.8, shrinkA=0, shrinkB=0))

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
    ax.set_ylim(*YLIM)
    save(fig, 1, "a", "pipeline")


if __name__ == "__main__":
    main()
