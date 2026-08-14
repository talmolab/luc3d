#!/usr/bin/env python3
"""
Fig 7b -- bedding invariance: does the tracker survive a change of background?

    ############################################################################
    THE MANUSCRIPT PANEL `fig7b_bedding.pdf` PLOTS A RETIRED TRACKER. Corrected
    CUT FROM THE FIGURE 2026-08-13 (review): the panel claims invariance to bedding
    colour, but the detector's training set is overwhelmingly BLACK background, so
    the white-bedding arm is confounded with out-of-distribution DETECTION and the
    invariance claim cannot be defended. The script and its CSV stay -- un-plotted,
    not deleted, as Fig 8's dropped panels are -- and it now saves under the
    supplementary letter `s2` so it cannot be mistaken for the figure's panel b
    (which is the survival curve since the re-lettering). It is also the last panel
    that still plots the retired pre-#131 tracker; nothing in the figure does now.

    ONLY in the `--variant` render; fixing this panel itself would mean REGENERATING
    `figs/out/fig3_trackers.json`, a manuscript deposit and Eric's decision.

    Its LUC3D column comes from `matchFrameInstances`, the pre-#131 PER-FRAME
    matcher (run 2026-05-15); `pose/cross-view-tracker.js` was merged 2026-07-06.
    Re-scored, same pool, same 44 black / 30 white sessions:

        pre-#131 (this panel)   0.7407 -> 0.7291   loses 0.0116
        SHIPPED                 0.7582 -> 0.7430   loses 0.0151

    The panel's ARGUMENT survives intact -- LUC3D still loses far less to the
    background than SLEAP (0.079) or ByteTrack (0.148), and those two columns do
    not move at all -- but its stated 0.012 is a retired tracker's number, and the
    shipped tracker is very slightly WORSE on this axis, not better. Both are drawn.

    ONE MORE THING THIS EXPOSED: the grey "detector recall" control is taken from
    the LUC3D rows of the CSV, and motmetrics' `recall` counts MATCHED predictions
    -- so it is not purely a detector property and it moves with the arm (black ->
    white 0.7300 -> 0.7262 on the retired arm, 0.7262 -> 0.7277 on the shipped one,
    i.e. the sign of a 0.004 difference flips). It still rules out a large detection
    confound, which is all the panel claims of it; it is not a tracker-independent
    constant and the variant's key says so.
    ############################################################################

White mice on white bedding is the hard case; black bedding is the easy one. The
SAME identity-stripped detections feed every tracker, and detector recall barely
moves between the two conditions (delta 0.004), so any drop is the TRACKER's, not
the detector's. That control is drawn as the fourth, grey pair.

LUC3D loses 0.012, SLEAP 0.079, ByteTrack 0.148. The reason is geometric: LUC3D's
association is dominated by the 3D term (Fig 3d), which does not care what the
bedding looks like, while a per-camera appearance/motion tracker degrades with
contrast.

THIS IS A BETWEEN-SESSION COMPARISON AND IS NOW DRAWN AS ONE. An earlier version was
a slopegraph: one line per tracker joining its black-bedding score to its
white-bedding score. That shape means a repeated measure -- the same units under two
conditions -- and these are not. `by_bedding` is n = 44 BLACK sessions and n = 30
WHITE ones: 74 different recordings split into two groups, never the same session
under two beddings. The line implied a pairing that does not exist, so the panel is
now grouped bars (solid = black, open = white), an idiom that cannot be read as
paired.

THE OTHER CONFOUND IS PRINTED TOO, because ruling out the detector does not rule out
everything else. `paired_vs_sleap[*].bedding` deposits the animal-count composition of
each group: the black group is 21/44 single-animal, the white group 11/30, and the two
groups also differ in difficulty. The recall control (delta 0.004) rules out a
DETECTION confound only. There are no intervals because the deposit carries one pooled
IDF1 per condition, not per-session values.

Source: figs/out/fig3_trackers.json `slap2m.by_bedding`, `slap2m.paired_vs_sleap`; with
`--variant`, figs/out/fig7_variant_best.json (`slap2m` = shipped tracker,
`slap2m_fresh_anchor` = the experimental arm, `slap2m_pre131_reference` = what the
manuscript panel plots).

    python3 figs/panels/fig7_06_bedding.py            # the manuscript panel
    python3 figs/panels/fig7_06_bedding.py --variant  # shipped + fresh anchor
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (footnote, GREY, MUTED, entity, deposit, panel,  # noqa: E402
                       save, text_legend, use)
from fig7_variant_common import (FRESH_LABEL, FRESH_NOTE, arms,  # noqa: E402
                                 pool_note, slug)

#: Hues from `entity()` -- one hue per tracker set-wide, resolved in one place rather
#: than re-picked in each of the seven panels (review finding C3). Unchanged colours.
#: The detector-recall control below stays GREY on purpose: it is not a tracker, and
#: GREY is this set's colour for a reference level rather than a method.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]
CONDS = ["black", "white"]
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0

BAR_W = 0.34


def main(variant=False):
    use()
    sl, fresh, ref, _tab = arms(variant)
    bb = sl["by_bedding"]
    pv = sl["paired_vs_sleap"]

    # Groups: the three trackers, then the shared detector as the control. The
    # control is a rate on the same 0-1 axis, which is why the legacy panel drew it
    # here rather than in a panel of its own.
    #
    # THE VARIANT INSERTS THE EXPERIMENTAL ARM as a fourth pair, in the SAME
    # `entity("luc3d")` teal as the shipped tracker but HATCHED -- LUC3D's hue is
    # reserved and experimental status is carried by pattern and words, not colour
    # (see fig7_variant_common). (label, colour, [black, white], hatch)
    groups = [(lab, color, [bb[c][k]["idf1"] for c in CONDS], None)
              for k, lab, color in TRACKERS]
    if variant:
        groups[0] = ("LUC3D\n(shipped)", entity("luc3d"), groups[0][2], None)
        groups.insert(1, ("LUC3D\n+fresh", entity("luc3d"),
                          [fresh["by_bedding"][c]["luc3d"]["idf1"] for c in CONDS],
                          "////"))
    groups.append(("detector\nrecall", GREY,
                   [bb[c]["detector_recall"] for c in CONDS], None))

    rows = []
    fig, ax = panel("half", ROW_H, key=3 if variant else 0)
    x = np.arange(len(groups))
    for i, (lab, color, ys, hatch) in enumerate(groups):
        # Solid = black bedding, open = white bedding. The fills are a mnemonic for
        # the condition, and no bar touches another group's, so nothing here can be
        # mistaken for a within-session change.
        if hatch:
            ax.bar(i - BAR_W / 2, ys[0], width=BAR_W, color=color, zorder=2,
                   hatch=hatch, edgecolor="white", linewidth=0.0)
            ax.bar(i + BAR_W / 2, ys[1], width=BAR_W, facecolor="white",
                   edgecolor=color, lw=0.9, zorder=2, hatch=hatch)
        else:
            ax.bar(i - BAR_W / 2, ys[0], width=BAR_W, color=color, zorder=2)
            ax.bar(i + BAR_W / 2, ys[1], width=BAR_W, facecolor="white",
                   edgecolor=color, lw=0.9, zorder=2)
        ax.text(i, max(ys) + 0.035, f"Δ{ys[0] - ys[1]:.3f}", ha="center",
                va="bottom", color=color, fontsize=6.5, fontweight="bold")
        rows += [{"series": lab.replace("\n", " "), "bedding": c, "value": y,
                  "n_sessions": bb[c]["n_sessions"]} for c, y in zip(CONDS, ys)]

    if variant:
        # THE RETIRED ARM AS TWO GREY RULES on the bars it supersedes -- the height
        # this panel publishes -- rather than a fifth pair of bars. It is not a method
        # on offer, so it gets the set's reference grey, not a series colour.
        rb = [ref["by_bedding"][c]["luc3d"]["idf1"] for c in CONDS]
        for dx, yv in zip((-BAR_W / 2, BAR_W / 2), rb):
            ax.plot([dx - BAR_W * 0.6, dx + BAR_W * 0.6], [yv] * 2, color=MUTED,
                    lw=1.1, zorder=6, solid_capstyle="butt")
        rows += [{"series": "LUC3D pre-#131 (manuscript panel)", "bedding": c,
                  "value": y, "n_sessions": bb[c]["n_sessions"]}
                 for c, y in zip(CONDS, rb)]
        text_legend(ax, [
            (f"LUC3D shipped Δ{groups[0][2][0] - groups[0][2][1]:.3f} · "
             f"fresh Δ{groups[1][2][0] - groups[1][2][1]:.3f} (hatched, "
             f"EXPERIMENTAL)", entity("luc3d")),
            (f"grey rules: LUC3D pre-#131, what Fig 7b prints "
             f"(Δ{rb[0] - rb[1]:.3f})", MUTED),
            ("grey bars: recall of MATCHED predictions, so it moves with the arm",
             GREY)],
            "above", size=6, dy=0.052 * 52.0 / ROW_H, xy=(0.10, 0.985),
            transform=fig.transFigure)

    deposit(pd.DataFrame(rows), 7, f"{slug('fig7b_bedding', variant)}.csv")
    ax.set_xticks(x)
    ax.set_xticklabels([lab for lab, _, _, _ in groups])
    ax.tick_params(axis="x", length=0)
    ax.set_xlim(-0.62, len(groups) - 0.38)
    ax.set_ylabel("IDF1  /  recall")
    ax.set_ylim(0, 0.95)
    # PINNED, and pinned to 7a's ticks. This is the same quantity on the same 0-0.95
    # range as 7a, so the two panels of the row must be readable against each other --
    # and left to itself matplotlib re-chose 0.00/0.25/0.50/0.75 the moment the panel
    # got shorter, which silently changed both the gridding and the number of
    # significant figures on a panel whose data had not moved.
    ax.set_yticks([0, 0.2, 0.4, 0.6, 0.8])

    # The animal-count composition of the two groups, from the deposited per-animal
    # bedding counts -- the confound a reader has to be told about.
    one = pv["1"]["bedding"]
    nb, nw = bb["black"]["n_sessions"], bb["white"]["n_sessions"]
    # FOUR SHORT LINES. The x label is centred on the axes, so a line wider than the
    # axis extent hangs off the page and the renderer silently drops the overhang --
    # at 7.5 pt (what `footnote` sets) the two-clause versions of lines 2 and 3
    # measured 77 and 79 mm on an 88 mm panel and lost their opening words. Nothing
    # here is dropped: every line is under 74 mm.
    footnote(ax,
             f"solid = black bedding (n = {nb}) · open = white bedding (n = {nw})\n"
             "BETWEEN-SESSION: different sessions, not paired\n"
             f"animal mix differs too (1 animal {one['black']}/{nb} vs "
             f"{one['white']}/{nw})\n"
             "no per-session values deposited, so no intervals"
             + ("" if not variant else
                f"\nLUC3D here is the SHIPPED tracker: black -> white "
                f"{bb['black']['luc3d']['idf1']:.4f} -> "
                f"{bb['white']['luc3d']['idf1']:.4f} (loses "
                f"{bb['black']['luc3d']['idf1'] - bb['white']['luc3d']['idf1']:.4f}), "
                f"against the {ref['by_bedding']['black']['luc3d']['idf1']:.4f} -> "
                f"{ref['by_bedding']['white']['luc3d']['idf1']:.4f} (loses "
                f"{ref['by_bedding']['black']['luc3d']['idf1'] - ref['by_bedding']['white']['luc3d']['idf1']:.4f}) "
                f"the manuscript panel prints for the pre-#131 tracker retired "
                f"2026-07-06 -- so the shipped tracker is marginally WORSE on this axis, "
                f"and the panel's argument rests on the comparison with SLEAP "
                f"({bb['black']['sleap']['idf1'] - bb['white']['sleap']['idf1']:.4f}) and "
                f"ByteTrack "
                f"({bb['black']['bytetrack']['idf1'] - bb['white']['bytetrack']['idf1']:.4f}), "
                f"neither of which moves"
                f"\nthe EXPERIMENTAL fresh anchor loses "
                f"{fresh['by_bedding']['black']['luc3d']['idf1'] - fresh['by_bedding']['white']['luc3d']['idf1']:.4f}"
                f"\nthe grey control is motmetrics `recall` from the LUC3D rows, i.e. "
                f"MATCHED predictions, so it is not tracker-independent: "
                f"{ref['by_bedding']['black']['detector_recall']:.4f} -> "
                f"{ref['by_bedding']['white']['detector_recall']:.4f} on the retired arm, "
                f"{bb['black']['detector_recall']:.4f} -> "
                f"{bb['white']['detector_recall']:.4f} on the shipped one"
                f"\n{pool_note()}"))
    save(fig, 7, "s2", slug("bedding", variant))


if __name__ == "__main__":
    main(variant="--variant" in sys.argv)
