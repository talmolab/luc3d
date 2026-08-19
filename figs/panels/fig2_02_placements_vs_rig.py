#!/usr/bin/env python3
"""
Fig 2b -- manual placements per animal per frame, against rig size.

THE PANEL PLOTS LABELS *NEEDED*, ALL THREE CURVES, AND IT IS BACK TO THAT ON
PURPOSE. From 2026-08-13 to 2026-08-18 the ordinate was labels *free* by
reprojection for the two aided curves while the salmon baseline stayed C x N --
two different quantities on one axis. The reader had to subtract one from the
other to recover the number they came for (how many labels a human places), and
the panel's own arithmetic ran backwards: MORE free labels is better, MORE
needed labels is worse, and both directions were drawn upward in the same
frame. Reverted at Eric's instruction (2026-08-18): "cant we just depict how
many labels are needed given these reprojections? rather than free by
reprojection? the graph is too confusing otherwise". `aided_tau*` is the
primitive the model computes; `free_tau*` was the derived column. Both are still
deposited, so either framing is recoverable from the CSV.

EVERY CURVE IS NAMED ON ITSELF, WHICH IS THE OTHER HALF OF THE SAME FIX. The key
was three `text_legend` lines with the two teal tolerances in the SAME colour and
nothing in a text-only key able to say which of them was the solid line and which
the dashed one -- so the encoding was unreadable by construction (Eric, same
message: "uses a dotted line for one and a solid line for another but does not
explain which or label which"). On the labels-needed quantity the three curves
FAN APART to the right (120 / 65 / 35 at C = 8) instead of converging toward a
ceiling, which is exactly what makes end-of-curve labels possible here and was
not possible on the free-label quantity. So the key band is gone -- `annotate_series`'s
form, each line labelled in its own colour at its own right end -- and the panel
gets that band's ~11 mm back as plot height.

What the reprojection-aided protocol actually changes: a labeller places two anchor
views by hand and then only CORRECTS the reprojections that land outside tolerance.
Traditional labelling is C x N placements; the protocol is 2 x N plus the measured
correction rate on the remaining C - 2 views.

The correction rate p is MEASURED, not assumed: it is 1 - (fraction of held-out
reprojections landing within tau px of that view's own detection), taken from the
data-anchored curve rather than from the comparison against the reference 3D, which
would flatter a two-anchor solve.

ONE RIG SIZE WAS MEASURED, AND THE ARTWORK MUST NOT SUGGEST MORE. Every one of the
50 Mouse-Dyad-10M sessions is a FIVE-camera rig -- `{s["cameras"] for s in per_session}` is
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
    # NO KEY BAND (`key=0`): every curve is named at its own right end now, and the
    # band the three-line key reserved was ~0.21 of the panel height (dy 0.064 x 3
    # plus pad) -- ~11 mm of a 52 mm panel, handed back to the plot.
    fig, ax = panel("third", "std")
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
    ax.plot(df.cameras, df[f"aided_tau{int(TAU_MAIN)}"], color=TEAL, lw=2.0)
    ax.plot(df.cameras, df[f"aided_tau{int(TAU_STRICT)}"], color=TEAL, lw=1.2,
            ls=(0, (2.5, 1.5)))

    # ONE filled marker on the whole panel, at the ONE rig size p was measured on, on
    # the ONE curve that carries a measurement. A marker here means "a measurement
    # exists at this C" and nothing else, so there is nothing left for a reader to
    # mistake for four measured rigs -- or for a measured traditional cost.
    m = df[df.measured]
    assert len(m) == 1, m
    ax.plot(m.cameras, m[f"aided_tau{int(TAU_MAIN)}"], "o", color=TEAL, ms=5.5,
            mec="white", mew=1.0, zorder=5)

    # EACH CURVE NAMED AT ITS OWN RIGHT END, in its own colour: the labels-needed
    # quantity fans the three apart (120 / 65 / 35 at C = 8), so every one has clear
    # air above its endpoint and no key is needed to say which line is which. All
    # three are right-anchored at C = 8 so they cannot run off a 57 mm panel, and all
    # three sit ABOVE the line they name -- a 1.4-2.0 pt stroke is ~2.5 data units
    # thick here, so a label hung under a line prints through it.
    # THE CURVES ARE NAMED BY WHAT THE LABELLER DOES, not by their tolerance (Eric,
    # 2026-08-18). "manual labeling" is the C x N denominator; "accept" is the
    # tau = 10 px curve, where the reprojection is taken as it lands; "nudge" is the
    # stricter tau = 5 px curve, where more of them get corrected by hand. The
    # tolerances themselves are in the caption. Styles are unchanged, so the long
    # dash is still the assumed curve and the short dash still the strict one.
    ax.text(CMAX, CMAX * NODES + 4.0, "manual labeling", ha="right",
            va="bottom", color=SALMON, fontsize=7, fontweight="bold")
    ax.text(CMAX, df[f"aided_tau{int(TAU_STRICT)}"].iloc[-1] + 2.5,
            "nudge", ha="right", va="bottom", color=TEAL,
            fontsize=7, fontweight="bold")
    ax.text(CMAX, df[f"aided_tau{int(TAU_MAIN)}"].iloc[-1] + 2.5,
            "accept", ha="right", va="bottom", color=TEAL,
            fontsize=7, fontweight="bold")

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
    # 0.90, not 0.985: the C x N dashed line passes y ~ 115 near C = 7, exactly
    # where the second text line used to end (review round 3).
    # BELOW the salmon end-label and clear of the salmon LINE, which is the binding
    # constraint: this note is left-anchored inside the y spine while the line it must
    # not touch descends leftward, so the note's usable width shrinks with its height.
    # At y = 110 the C x N line is at C = 7.3, and the shortened second line ("every
    # curve here is a model", 26 characters at 7 pt) ends near C = 6.6. The old
    # 31-character "All three curves are the model." ran through the dashes -- the key
    # band used to hold the axes down far enough to hide that.
    # TWO SHORT LINES AT y = 118, and both numbers are set by the salmon line, not by
    # taste: the note is left-anchored at the spine while the C x N line descends
    # leftward, so each line's usable width is whatever that line leaves at that
    # height. Line 1 ends near C = 6.4 where the line is at C = 7.1-7.9; line 2 ends
    # near C = 5.1 where it is at C = 6.4-7.1. Above y = 118 is the C x N end-label's
    # own box. The 31-character "All three curves are the model." this replaces ran
    # straight through the dashes once the key band stopped holding the axes down.
    # The FULL statement -- one measured rig, every other point a model, at C < 5
    # exactly as much as at C > 5 -- is in the caption, in bold, and has been all along.
    # THE MEASURED-VS-MODEL NOTE IS GONE from the artwork (Eric, 2026-08-18: "we
    # dont need the other text like 'marker = measurement rig C=5' no need for
    # 'curves are the model'"). The statement it carried -- one measured rig, every
    # other point a model -- is in the caption, and the single filled marker still
    # marks the measured C on the artwork.

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
    # THE ARROW NOW SPANS THE SAVING, which on this quantity is the GAP between the
    # two curves (aided -> C x N) rather than a distance from zero. On the free-label
    # quantity the same saving was the aided curve's own height, so the arrow ran from
    # the axis; here an arrow from 0 would measure the labels still being placed.
    ax.annotate("", (ncam - 0.35, aided), (ncam - 0.35, trad),
                arrowprops=dict(arrowstyle="<->", lw=0.8, color=INK))
    # BELOW the arrow's foot, in the empty band under the τ = 10 px curve: everything
    # from C = 3 rightward and y < 30 is clear on this quantity, whereas the wedge
    # between the salmon line and the τ = 5 px curve -- where this label sat -- is
    # crossed by one or the other at every height the arrow's mid-point offers.
    # BOTH READINGS OF THE SAME MEASURED POINT, because the paper quotes the ratio and
    # the panel plots the count: 32 placed of 75, i.e. 57% arriving free, i.e. 2.3x
    # fewer placements. One arithmetic, three sentences a reader might want.
    # RIGHT-ANCHORED AT C = 8, not left-anchored at the arrow: "at C = 5: 32 of 75 by
    # hand" set from x = 4.85 ran off the artwork and matplotlib dropped the overhang
    # silently (lint: TRUNCATED). Anchored to the right edge it cannot overrun, and it
    # still reads as the arrow's label -- it is the only text in the empty band under
    # the τ = 10 px curve, and it names its own C.
    # THE RATIO LABEL IS GONE from the artwork (Eric, 2026-08-18: "no need for 'at
    # C = 5: 32 of 75 by hand 57% free and 2.3x fewer'"). All three readings are in
    # the caption. The arrow stays: it is a mark, not text, and it is what shows the
    # saving at the measured rig.
    del free

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
    # THE AXIS NAMES ONE QUANTITY AGAIN. "labels per animal per frame" had to stay
    # vague while the salmon line counted labels needed and the teal ones counted
    # labels free; all three now count the placements a human makes, so the axis says
    # exactly that.
    ax.set_ylabel("manual placements\nper animal per frame")
    ax.set_xlim(2, CMAX)
    # 1.16, not 1.10: the C x N end-label rides above the line's own top (y = 120), and
    # at 1.10 it sat 1 pt off the frame.
    ax.set_ylim(0, CMAX * NODES * 1.16)
    save(fig, 2, "b", "placements_vs_rig")


if __name__ == "__main__":
    main()
