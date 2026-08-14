#!/usr/bin/env python3
"""
Fig 2b -- manual placements per animal per frame, against rig size.

What the reprojection-aided protocol actually changes: a labeller places two anchor
views by hand and then only CORRECTS the reprojections that land outside tolerance.
Traditional labelling is C x N placements; the protocol is 2 x N plus the measured
correction rate on the remaining C - 2 views.

The correction rate p is MEASURED, not assumed: it is 1 - (fraction of held-out
reprojections landing within tau px of that view's own detection), taken from the
data-anchored curve rather than from the comparison against the reference 3D, which
would flatter a two-anchor solve.

ONE RIG SIZE WAS MEASURED, AND THE ARTWORK MUST NOT SUGGEST MORE. Every one of the
50 BMimica sessions is a FIVE-camera rig -- `{s["cameras"] for s in per_session}` is
`{5}` -- so `p` is a single number measured at C = 5, from a two-anchor solve with
three held-out views. C = 2, 3 and 4 are therefore exactly as much a model as
C = 6, 7, 8 are. Two earlier drafts got this wrong in the same way and each time the
fix was too small: the first drew markers out to C = 8, and the second drew them at
C = 2, 3, 4, 5 inside a band labelled "p measured, C <= 5", which reads as FOUR
measured rig sizes and puts a spurious boundary at C = 5. Both the band and the
extra markers are gone. There is now exactly ONE filled marker on the panel, at
C = 5 on the aided curve, because that is the one place a measurement exists; every
other point on either curve is a model, and the note in the top-left corner says so
in those words -- "Both curves are a model" -- without dividing the axes into
regions. The ratio is quoted at that measured rig size and nowhere else.

THE TWO CURVES ARE NOT THE SAME KIND OF CLAIM AND ARE NOT DRAWN THE SAME WAY.
`traditional = C x 15` is a PREMISE -- that a labeller places every node in every
view -- and nothing about it was measured at any C, not even at C = 5. The aided
curves carry a correction rate measured on real held-out views. Until this pass both
got a 2.0 pt stroke and a white-ringed marker at C = 5, so the assumption borrowed
the measurement's authority and no reader could have told which was which. The
assumed curve is now lighter (1.4 pt), LONG-dashed (so it reads as a different kind
of line from the short-dashed tau = 5 px curve rather than as its sibling), carries
NO marker, is named "traditional (assumed)" in the key, and has its premise spelled
out under the axis as the identity it is: "assumed: 15 nodes x C views". Four
signals for one distinction, because at 57 mm any one of them alone is missable.

Every integer C is ticked. C is a count of cameras, not a continuum, and with only
`2, 4, 6, 8` ticked the single measured marker at C = 5 sat between two ticks and the
reader had to interpolate to find out which rig it belonged to.

N = 15 is a PER-ANIMAL skeleton, so the ordinate is per animal per frame.

Source: figs/out/fig2.json.

    python3 figs/panels/fig2_02_placements_vs_rig.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (MUTED, GREY, INK, SALMON, TEAL, deposit, footnote,  # noqa: E402
                       panel, save, text_legend, use)

NODES = 15          # per-animal skeleton
CMAX = 8            # model out to an 8-camera rig
TAU_MAIN = 10.0     # px, the headline tolerance
TAU_STRICT = 5.0


def build():
    ps = load("fig2.json")["per_session"]
    # Asserted, not assumed: `ncam` is the rig size p was measured at, and the panel
    # marks exactly that C. If a future run mixed rig sizes, the right fix would be
    # several markers with several p values, not one marker quietly standing for a
    # mixture -- so the mixture has to fail loudly here rather than be averaged.
    cams = {s["cameras"] for s in ps}
    if len(cams) != 1:
        sys.exit(f"fig2.json mixes rig sizes {sorted(cams)}; p is a single number "
                 "and this panel would mislabel which C it belongs to")
    ncam = cams.pop()
    acc = {t: median([s["held_out_vs_observation"][f"acc{int(t)}"] for s in ps])
           for t in (TAU_STRICT, TAU_MAIN)}
    p = {t: 1 - a for t, a in acc.items()}

    rows = []
    for c in range(2, CMAX + 1):
        # `measured` is TRUE FOR ONE C. `c <= ncam` was wrong: it marked C = 2, 3, 4
        # as measured when no 2-, 3- or 4-camera session exists in the corpus.
        row = {"cameras": c, "traditional": c * NODES, "measured": c == ncam}
        for t in (TAU_STRICT, TAU_MAIN):
            row[f"aided_tau{int(t)}"] = 2 * NODES + (c - 2) * NODES * p[t]
            # THE PANEL'S QUANTITY SINCE 2026-08-13 (review: "instead of the y axis
            # being manual placements per frame, labour-free labels per frame"). Same
            # model, same numbers, stated as the benefit rather than the cost: of the
            # CN placements a traditional pass would make, this many arrive correct
            # from the reprojection and are never touched. It is a DERIVED column, not
            # a new measurement, and both are deposited so the old framing is
            # recoverable from the CSV.
            row[f"free_tau{int(t)}"] = c * NODES - row[f"aided_tau{int(t)}"]
        rows.append(row)
    return pd.DataFrame(rows), ncam, p


def main():
    use()
    df, ncam, p = build()
    deposit(df, 2, "fig2b_placements_vs_rig.csv")

    # A reserved band ABOVE the plot holds the two series names. They used to be
    # written onto the data with `annotate_series`, and there is nowhere on this plot
    # to put them: "traditional" landed on its own rising line and
    # "reprojection-aided" sat across the dashed tau = 5 px curve.
    #
    # THREE slots for TWO entries, for the same reason as Fig 2c: `text_legend`'s
    # 0.052 stack pitch is 7.7 pt against a 8.9 pt glyph box, so at key=2 the lines
    # overlapped and the first sat 0.8 pt from the page edge.
    fig, ax = panel("third", "std", key=3)
    # THE TWO CURVES ARE NOT THE SAME KIND OF OBJECT, so they are not drawn the same
    # way. `traditional = C x 15` is a PREMISE about how labelling is done -- nothing
    # about it was measured at any C -- while the aided curves carry a correction rate
    # measured on real held-out views. Drawn identically (both 2.0 pt solid, both with
    # a white-ringed marker) the assumption borrowed the authority of the measurement.
    # It is now a lighter LONG-dashed line with no marker, and the key names it
    # "(assumed)": long dashes so it cannot be read as the same kind of line as the
    # short-dashed tau = 5 px curve, and no marker because a marker on this panel
    # means "a measurement exists here" and none does on this curve -- not even at
    # C = 5. Weight, dash and marker all say the same thing, because one signal alone
    # is easy to miss at 57 mm.
    # THE SALMON LINE IS THE DENOMINATOR, NOT A SERIES OF FREE LABELS. It is C x N,
    # every label the frame needs; the teal curves are how many of those the
    # reprojection supplies for nothing. Naming it "all placements by hand" on an axis
    # of FREE labels said that labelling everything by hand yields the most free
    # labels, which is exactly backwards -- hand labelling yields none. The axis is
    # therefore "labels per animal per frame" and each line says which labels it
    # counts. (Caught in review, 2026-08-14.)
    ax.plot(df.cameras, df.traditional, color=SALMON, lw=1.4, ls=(0, (6, 2.5)))
    ax.plot(df.cameras, df[f"free_tau{int(TAU_MAIN)}"], color=TEAL, lw=2.0)
    ax.plot(df.cameras, df[f"free_tau{int(TAU_STRICT)}"], color=TEAL, lw=1.2,
            ls=(0, (2.5, 1.5)))

    # ONE filled marker on the whole panel, at the ONE rig size p was measured on, on
    # the ONE curve that carries a measurement. A marker here means "a measurement
    # exists at this C" and nothing else, so there is nothing left for a reader to
    # mistake for four measured rigs -- or for a measured traditional cost.
    m = df[df.measured]
    assert len(m) == 1, m
    ax.plot(m.cameras, m[f"free_tau{int(TAU_MAIN)}"], "o", color=TEAL, ms=5.5,
            mec="white", mew=1.0, zorder=5)

    # THE TOLERANCES MOVED INTO THE KEY. On the old quantity the two teal curves ran
    # apart at the right edge and could be labelled there; on this one they converge
    # toward the ceiling, and both end-labels landed on a stroke (the τ = 10 label
    # read as naming the salmon line, and τ = 5 sat across the solid curve). The key
    # band is free and names each line once.
    # SHORT ENOUGH FOR 57 mm: "of those, free from reprojection, τ = 10 px" is 43
    # characters at 8 pt and ran off the panel (lint: CLIPPED, TRUNCATED). "free by
    # reprojection" carries the same relation to the line above it, which already says
    # what the total is.
    text_legend(ax, [("labels needed, C × N (assumed)", SALMON),
                     ("free by reprojection, τ = 10 px", TEAL),
                     ("free by reprojection, τ = 5 px", TEAL)], "above",
                xy=(0.14, 0.972), dy=0.064, transform=fig.transFigure)

    # The two tolerances stay ON the plot, because each one names a specific curve
    # and there are two teal curves. Both are pushed well clear of the line they
    # label -- 6 units above the dashed one, 7 below the solid one -- since at this
    # panel size a 2.0 pt line is ~2.5 data units thick on its own.

    # What is measured and what is not, in the empty wedge above the traditional line
    # on the left -- INSIDE the axes, because the panel saves at an exact size and
    # anything above y = 1 in axes coordinates is cut off rather than accommodated.
    # It goes here, and not under the x axis as a `footnote`, only because the wedge
    # is free: a footnote would have cost three lines of a 52 mm panel's height.
    #
    # Deliberately NOT a shaded region and NOT a rule at C = 5. Any region label
    # ("measured" left of a boundary, "model" right of it) is false here -- the whole
    # curve is a model except one point -- and a boundary drawn anywhere is the
    # misreading this panel had. Two flat sentences and one marker cannot be
    # partitioned into regions by eye.
    # Left-aligned just inside the y spine rather than centred: centred, the leading
    # glyph hung over the spine and read as clipped.
    ax.text(2.12, CMAX * NODES * 1.10 * 0.985,
            f"one measured rig (marker): C = {ncam}.\nBoth curves are a model.",
            color=MUTED, ha="left", va="top", fontsize=7, linespacing=1.35)

    # The ratio, at the measured rig size only. The label sits to the RIGHT of the
    # arrow, in the wedge between the dashed tau = 5 px curve and the traditional
    # line: to the left of the arrow, and at the arrow's own mid-height, it crossed
    # the traditional line and the dashed curve respectively.
    aided = df.loc[df.cameras == ncam, f"aided_tau{int(TAU_MAIN)}"].iloc[0]
    trad = ncam * NODES
    free = trad - aided
    # BOTH READINGS OF THE SAME MEASURED POINT, because the panel changed which one
    # it plots and the paper quotes the other. The arrow spans the free labels at the
    # measured rig; the label gives the count, the share of CN it is, and the
    # placements-ratio the abstract uses -- all three are the same arithmetic.
    ax.annotate("", (ncam - 0.35, 0), (ncam - 0.35, free),
                arrowprops=dict(arrowstyle="<->", lw=0.8, color=INK))
    # TWO SHORT LINES: the one-line form ran off the right edge of a 57 mm panel.
    ax.text(ncam + 0.15, free * 0.55,
            f"{free:.0f} of {trad:.0f} free\n{free / trad:.0%} · "
            f"{trad / aided:.1f}× fewer", ha="left", va="center", fontsize=6.5,
            fontweight="bold", color=INK, linespacing=1.35)

    # Every integer: C is a count, and the one measured marker sits at C = 5, which
    # the old [2, 4, 6, 8] left between ticks.
    ax.set_xticks(list(range(2, CMAX + 1)))
    # Explicit, because the shorter axes (the key band above it) made the locator
    # stop at 100 while the traditional line runs to 120 -- the reader should not
    # have to extrapolate past the last tick to read the top of a curve.
    ax.set_yticks([0, 40, 80, 120])
    ax.set_xlabel("cameras in the rig, C")
    # WHAT the assumption is, since "(assumed)" in the key says only that there is
    # one. This is the premise the whole comparison rests on -- a labeller placing
    # every one of the 15 nodes in every one of the C views -- and it is the panel's
    # single biggest unmeasured quantity, so it is stated on the artwork rather than
    # left to the caption. Written as the identity it is -- 15 x C -- because that is
    # the most direct way to say "this curve is arithmetic, not data", and it echoes
    # the word "assumed" in the key so the two are unmistakably the same claim.
    # Under the axis and not in the wedge with the measurement note: the wedge takes
    # two 7 pt lines before a third runs into the traditional line itself, and one
    # centred line under a 57 mm axis takes ~30 characters before it reaches the
    # panel edge (the full sentence, 37 characters, cleared the edge by 0.2 mm).
    footnote(ax, f"assumed: {NODES} nodes × C views")
    ax.set_ylabel("labels\nper animal per frame")
    ax.set_xlim(2, CMAX)
    ax.set_ylim(0, CMAX * NODES * 1.10)
    save(fig, 2, "b", "placements_vs_rig")


if __name__ == "__main__":
    main()
