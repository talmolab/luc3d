#!/usr/bin/env python3
"""
Fig 1b -- what LUC3D does, end to end. (Was 1a until 2026-08-16, when the cage
render became the figure's opening panel -- Eric.)

Five stages, left to right, with the two that are contributions of this paper marked.
Everything downstream of "per-view detections" runs in the browser with no install,
which is the claim the Fig 1e table's "Install: none / Runs in: browser" row makes
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
#: CALIBRATION: SIDE INPUT -> STAGE, TWICE (2026-08-13, then 2026-08-17). It began
#: glued to "videos", which implied it arrives with them; review 2026-08-13 ("just
#: videos and make calibration separate?") made it a labelled arrow entering
#: `triangulate`, which is where it is actually consumed -- a detector needs no
#: calibration. Then Eric added a browser calibration tool and asked for it in the
#: schematic; it was drawn as a box ABOVE the row, and then (same day) as a SEVENTH
#: CHEVRON IN the row: "lets add the calibration as another tab in the pipeline in line
#: with the others not as a separate thing, then we should called in an OpenCV.js
#: browser tool and then include it in the green 'this work' underlining".
#:
#: SO IT SITS IMMEDIATELY BEFORE `cross-view re-ID` (Eric, correcting a first pass that
#: put it before `triangulate`: "calibration goes before cross-view re-ID!"). That is
#: also the technically right edge, and the reason is easy to miss: the cross-view
#: tracker is the FIRST stage that consumes calibration, not triangulation. Its cost
#: model carries a 3D term -- the one Fig 3d ablates, where switching it off costs 632
#: switches per 100,000 -- and a 3D term means triangulating candidate groupings, which
#: needs the calibration. Calibration before re-ID is therefore the real data
#: dependency, and `.toml` is named on the arrow between those two.
#:
#: It also keeps the contributed stages a CONTIGUOUS run, which is what the "this work"
#: bracket is drawn from: at position 1 the bracket would have to span `2D pose`
#: (SLEAP's, not ours) to reach the rest.
STAGES = [
    ("videos", "N cameras", False, "cameras"),
    ("2D pose", "SLEAP or similar", False, "tiles2d"),
    ("calibrate", "OpenCV.js\nbrowser tool", True, "checkerboard"),
    ("cross-view\nre-ID", "1 identity / animal", True, "tilesid"),
    ("triangulate", "DLT, N ≥ 2 views", True, "volume3d"),
    ("proofread 3D", "3D + reproj.", True, "instances3d"),
    ("export", ".slp 2.8 / H5", True, "file"),
]

#: The stage whose INCOMING arrow carries the calibration file, by index into STAGES --
#: the FIRST stage that consumes it, which is the cross-view tracker (see above).
CALIB_CONSUMER = 3

#: Chevron geometry. The box holds the ICON ONLY and the label sits under it --
#: see `main()` for why the label is no longer inside the chevron.
W, H, GAP, NOTCH = 2.05, 1.05, 0.36, 0.24

#: Vertical extent of the drawing, in data units, cut to the INK. Top: the chevron's
#: top edge at H/2 plus half of its 1.1 pt stroke (0.02 units). Bottom: the baseline
#: of the "this work" label, which sits at about -2.10 -- measured off the render, not
#: guessed. The panel used to declare (-2.22, H/2 + 0.30), i.e. 0.28 units of pure
#: white above the chevrons, which is 2.8 mm of the figure at the scale below.
#: `calibrate`'s sub-label WRAPS to a second line, which the "this work" bracket has to
#: clear -- hence a bottom of -2.45 and a bracket at -2.05, against -2.20 and -1.80 in
#: the one-line era. The top carries the `.toml` label above the row's fifth arrow.
YLIM = (-2.45, H / 2 + 0.46)   # 0.34 clipped the .toml label (lint_text.py)

#: Millimetres per data unit. THIS, NOT THE PANEL HEIGHT, IS THE FIXED QUANTITY.
#: `blank()` sets aspect='equal' and the drawing is 14.8 units wide against 2.8 tall,
#: so 180 mm of width is never the constraint: the axes is HEIGHT-bound and the scale
#: is axes_height / (YLIM range). Every chevron, icon, arrow and bracket therefore
#: prints at (panel height) x (this scale) -- but the TEXT does not, because fontsize
#: is in points. So shrinking the panel closes the gaps BETWEEN the label lines in
#: millimetres while the type stays 7.5/6.5 pt, and at the old 32 mm the sub-label
#: baseline already cleared the two-line labels ("videos + / calibration") by only
#: 0.6 mm. The height is consequently derived from the scale and the ink, and the
#: only thing that came out of it is dead margin. 9.85 was the value the 32 mm version
#: rendered at.
#:
#: RAISED 9.85 -> 11.60 -> 10.35 on 2026-08-17 (Eric: "make the images and text a bit
#: bigger for legibility", then calibration moved INTO the row). At 9.85 the headroom
#: was real and unused: the drawing was 14.80 x 9.85 = 145.8 mm wide inside a 180 mm
#: full-span axes, i.e. 34 mm of the row was empty, because with `aspect='equal'` the
#: axes is HEIGHT-bound and 180 mm of width was never the constraint. 11.60 took 96% of
#: the 12.11 ceiling that 6 stages allowed.
#:
#: THE SEVENTH STAGE SPENDS MOST OF THAT BACK, and it is arithmetic, not a choice: 7
#: chevrons and 6 gaps span 7W + 6*GAP = 16.51 units, +0.70 of margin, so the ceiling
#: falls to 179.3 / 17.21 = 10.42 mm per unit. Above it the aspect fit silently SHRINKS
#: the drawing instead of enlarging it, so a bigger number here would make the panel
#: smaller. 10.35 is that ceiling with a rounding margin -- still +5% on every mark
#: against the 9.85 the panel shipped at, and the type stays at the raised sizes below,
#: which is where most of the legibility gain lives.
MM_PER_UNIT = 10.35
#: Type sizes. Raised on 2026-08-17 (7.5 / 6.5 / 7.0 before) so the text grows with the
#: marks rather than shrinking against them. Fontsize is in POINTS, so it does NOT fall
#: with MM_PER_UNIT -- the seventh stage cost the marks 11% and the type nothing.
#:
#: THE STAGE PITCH IS THE CONSTRAINT AND IT IS NOW FIXED: 7 stages across 179.3 mm is
#: 24.9 mm each, whatever W and GAP are set to. One sub-label does not fit in it at
#: 7.5 pt -- "OpenCV.js browser tool" measures 29.6 mm on one line -- so it WRAPS, to
#: 15.4 mm on two. Wrapping rather than shrinking keeps one type size across the row.
#: Every other label clears the pitch: the widest is "1 identity / animal" at 21.9 mm
#: (88%), then "SLEAP or similar" 21.5 and "DLT, N >= 2 views" 21.0. All of those are
#: MEASURED off the rendered text, not estimated from a characters-times-average-width
#: rule, which had "OpenCV.js browser tool" wrong by 4 mm; `_check_text_fits` re-measures
#: them on every build and fails it if one outgrows its pitch.
LABEL_PT, SUB_PT, BRACKET_PT = 8.5, 7.5, 8.0
#: Icon size in data units. 0.50 before 2026-08-17; the multi-view glyphs are
#: `TILES_W * s` wide (see src/diagram.icon), so this is what sets how much of the
#: chevron's spare width they spend.
ICON_S = 0.56
#: constrained_layout's outer pad, in mm. Nothing is drawn outside the axes here, and
#: the assembler already leaves 4.5 mm of lead above every row for the panel letter,
#: so the default 1.06 mm on each side is 2.1 mm of dead figure.
PAD_MM = 0.35
#: Panel height in mm: the ink, at the scale above, plus the outer pad. Was 32.0.
ROW_MM = MM_PER_UNIT * (YLIM[1] - YLIM[0]) + 2 * PAD_MM



def _check_text_fits(fig, ax, texts):
    """Fail the build if any label or sub-label is wider than its stage pitch.

    The pitch is fixed by arithmetic (7 stages across the full span), so a label that
    outgrows it does not look tight -- it touches its neighbour's, and at 7.5 pt in a
    grey that is exactly the kind of collision nobody notices in a 285 mm figure. This
    measures the rendered extents instead of trusting a characters-times-average-width
    estimate, which is what got "OpenCV.js browser tool" wrong by 3 mm on the first
    pass. Tolerance: 96% of the pitch, i.e. at least 1 mm of clear air between
    neighbours."""
    fig.canvas.draw()
    per_unit = (ax.transData.transform((1, 0))[0]
                - ax.transData.transform((0, 0))[0])            # px per data unit
    pitch_px = (W + GAP) * per_unit
    bad = []
    for t in texts:
        w = t.get_window_extent(fig.canvas.get_renderer()).width
        if w > 0.96 * pitch_px:
            bad.append(f"{t.get_text()!r} {w / per_unit * MM_PER_UNIT:.1f} mm")
    if bad:
        raise SystemExit(
            f"text wider than the {(W + GAP) * MM_PER_UNIT:.1f} mm stage pitch: "
            + "; ".join(bad) + " -- wrap it with \\n or shorten it; do NOT shrink the "
            "type, which would break the row's single size")


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

    texts = []
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
        icon(ax, kind, x + W / 2 - ICON_S / 2, -ICON_S / 2, s=ICON_S, color=color)
        texts.append(ax.text(x + W / 2, -H / 2 - 0.16, label, ha="center", va="top",
                             color=INK, fontsize=LABEL_PT, linespacing=1.25))
        # Sub-labels are all on ONE baseline rather than hung off their own label,
        # so the row reads as a row even though some labels wrap and some do not.
        texts.append(ax.text(x + W / 2, -1.42, sub, ha="center", va="top",
                             color=MUTED, fontsize=SUB_PT, linespacing=1.25))

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
    # THE ARTEFACT, NAMED ON THE EDGE THAT CARRIES IT. `calibrate` is a stage in the
    # row now, so the calibration file is what crosses the arrow into `triangulate`
    # rather than a side input into it. Named above that one arrow, in MUTED: the row's
    # other arrows carry the animals' data and need no label, and the space above the
    # chevrons is otherwise empty.
    ax.text(CALIB_CONSUMER * (W + GAP) - GAP / 2, H / 2 + 0.10, ".toml",
            ha="center", va="bottom", color=MUTED, fontsize=SUB_PT)

    # ONE bracket under the three stages this paper contributes, as in the legacy
    # figure. Per-stage "this paper" tags said the same thing three times and did
    # not show that the three are a single contiguous contribution.
    ours = [i for i, (_, _, o, _k) in enumerate(STAGES) if o]
    x0 = ours[0] * (W + GAP)
    x1 = ours[-1] * (W + GAP) + W
    yb = -2.05
    ax.plot([x0, x0, x1, x1], [yb + 0.14, yb, yb, yb + 0.14], color=TEAL, lw=0.9)
    ax.text((x0 + x1) / 2, yb - 0.10, "this work", ha="center", va="top",
            color=TEAL, fontsize=BRACKET_PT, fontweight="bold")
    span = len(STAGES) * (W + GAP) - GAP

    ax.set_xlim(-0.35, span + 0.35)
    ax.set_ylim(*YLIM)
    _check_text_fits(fig, ax, texts)
    save(fig, 1, "b", "pipeline")


if __name__ == "__main__":
    main()
