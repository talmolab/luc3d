#!/usr/bin/env python3
"""
Fig 7f -- the measured LUC3D DISADVANTAGE: it fragments more tracks than SLEAP.

    ############################################################################
    FIXED 2026-08-13, ON ERIC'S INSTRUCTION: THIS PANEL NOW PLOTS THE SHIPPED
    TRACKER, AND ITS HEADLINE NUMBER IS THE ONE THE SUBSTITUTION MOVED FURTHEST --
    in LUC3D's favour, which is why it gets the most scrutiny of the five.

    Until then the LUC3D column was the pre-#131 PER-FRAME matcher
    (`matchFrameInstances`, run 2026-05-15) out of `fig3_trackers.json`;
    `pose/cross-view-tracker.js` was merged 2026-07-06. Fragmentations per
    camera-session, LUC3D minus SLEAP, paired over the same 74 sessions:

        pre-#131 (what this panel printed)   +24.0  CI [+18.3, +30.0]  median +14.1
        SHIPPED (what it prints now)          +6.2  CI [ +3.0, +10.4]  median  +1.3

    So "+24.0" is a property of a retired tracker -- the shipped one fragments
    about a quarter as much more. THE SIGN DOES NOT CHANGE AND THE PANEL IS NOT
    WITHDRAWN: SLEAP still fragments fewer in 72 of 74 sessions on BOTH arms, the
    CI still excludes zero, and this is still the one clean corpus-wide result that
    goes against LUC3D. Only the magnitude moved, and the median moving +14.1 ->
    +1.3 is the more informative half of that -- on the shipped tracker the TYPICAL
    session is nearly level and the mean is carried by a tail.

    WHAT IS NOW STALE IS THE DEPOSIT'S CAVEAT TEXT, which still reads "+24.0
    fragmentations per camera per session, 95% CI [+18.3, +30.0]. Stated, not
    hidden." That string lives in `fig3_trackers.json`, which is NOT rewritten
    here, so it describes the retired arm and must not be quoted for the panel as
    it now stands. `--as-shipped` re-renders the retired arm under a `_pre131`
    slug. Account: `figs/out/ITEM3-SLAP2M-GATE.md`.
    ############################################################################

THIS PANEL EXISTS BECAUSE THE DEPOSIT SAYS IT MUST. `out/fig3_trackers.json caveats`:

    "LUC3D fragments MORE than SLEAP (+24.0 fragmentations per camera per session,
     95% CI [+18.3, +30.0]). Stated, not hidden."

(That caveat's NUMBERS are the retired arm's -- see the notice above -- but its
instruction is what put this panel in the figure, and it applies unchanged to the
shipped arm's +6.2 [+3.0, +10.4].)

`slap2m.fragmentations_paired` was deposited and appeared on NO panel in the figure --
a figure that otherwise prints every one of its method's losses (7d's negative 3- and
4-animal cells, 7e's essentially tied switch count, 7f's detection ceiling) was
silently dropping the one clean, corpus-wide result that goes against LUC3D. So it
gets its own panel, in SLEAP's colour, next to the other error panels.

WHAT A FRAGMENTATION IS AND WHY IT IS NOT AN ID SWITCH. motmetrics counts a
fragmentation each time a ground-truth track that was being tracked becomes untracked
and is later picked up again -- the identity is not reassigned to the wrong animal
(that is an ID switch, Fig 7e, where LUC3D is now AHEAD at 3,094 vs 3,608), the
track simply breaks and resumes. For a proofreading tool that is a real cost: a broken
track is a gap the human has to bridge. LUC3D's 3D-consistency term is conservative
about accepting a detection into an existing identity, which is what buys it the
cross-view result in 7a and what costs it here.

THE EFFECT IS ONE-SIDED BUT NO LONGER LARGE. +6.2 fragmentations per camera per
session, 95% CI [+3.0, +10.4] (bootstrap over the 74 sessions), median +1.3, and SLEAP
fragments less in 72 of the 74 sessions. Both the mean and the median are drawn because
the distribution is skewed, and on the shipped tracker that skew is the finding: the
mean is 4.7x the median (it was 1.7x on the retired arm), so the corpus mean is carried
by a tail of sessions and the typical session is nearly level. Quoting the mean alone
would overstate what a user should expect.

COLOUR MEANS SOMETHING DIFFERENT ON THE VARIANT, deliberately. On the manuscript panel
one datum is drawn and the colour says WHO WINS (SLEAP). The variant draws three arms of
the same paired difference, so colour has to separate the ARMS or they are
indistinguishable: MUTED for the retired pre-#131 arm, `entity("luc3d")` teal for the
shipped tracker, teal-hollow-and-dashed for the EXPERIMENTAL fresh anchor. Who wins is
carried by the zero rule and by the "SLEAP fewer in N of 74" line, still in SLEAP's own
colour, so nothing about the direction of the result is lost.

Source: figs/out/fig7_variant_best.json `slap2m.fragmentations_paired` (`slap2m` = the
SHIPPED tracker); with `--variant`, also `slap2m_fresh_anchor` and
`slap2m_pre131_reference`; with `--as-shipped`, figs/out/fig3_trackers.json `slap2m`
(pre-#131) and its `caveats`.

    python3 figs/panels/fig7_08_fragmentations.py               # the manuscript panel
    python3 figs/panels/fig7_08_fragmentations.py --variant     # all three arms
    python3 figs/panels/fig7_08_fragmentations.py --as-shipped  # retired, _pre131 slug
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (MUTED, footnote, INK, entity, deposit, panel,  # noqa: E402
                       save, text_legend, use)
from fig7_variant_common import (FRESH_LS, arms, flags,  # noqa: E402
                                 pool_note, slug)

#: SLEAP's set-wide hue, via `entity()` rather than a local PERIWINKLE: this panel is
#: read against 7d's "SLEAP ahead" half and 7e's SLEAP bar, so it must be the SAME
#: periwinkle (review finding C3). Colour unchanged.
SLEAP = entity("sleap")
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 49.4 of 52.1 mm, and the assembled page came to
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



def main(variant=False, corrected=True, fresh_arm=False):
    use()
    sl, fresh, ref, _tab = arms(variant, corrected, fresh_arm)
    fp = sl["fragmentations_paired"]
    n = fp["n_sessions"]
    luc_better = fp["wins"]          # sessions where LUC3D fragments LESS

    # (label, block, colour, hollow) -- the manuscript panel is the first row alone.
    rows = [("LUC3D (previous default)" if variant else "LUC3D − SLEAP", fp,
             entity("luc3d") if variant else SLEAP, False)]
    if variant:
        rows.insert(0, ("pre-#131", ref["fragmentations_paired"], MUTED, False))
        rows.append(("fresh anchor (shipped)", fresh["fragmentations_paired"],
                     entity("luc3d"), True))

    if not variant:
        deposit(pd.DataFrame([{"statistic": "mean", "value": fp["mean"],
                               "ci95_lo": fp["ci95_lo"], "ci95_hi": fp["ci95_hi"]},
                              {"statistic": "median", "value": fp["median"],
                               "ci95_lo": None, "ci95_hi": None}]),
                7, f"{slug('fig7f_fragmentations', variant, corrected, fresh_arm)}.csv")
    else:
        # The variant's table carries all three arms and both statistics. The default
        # deposit above is left column-for-column as committed: it is a manuscript
        # artefact and there is no reason for this work to edit it.
        deposit(pd.DataFrame(
            [{"arm": lab, "statistic": st,
              "value": blk["mean" if st == "mean" else "median"],
              "ci95_lo": blk["ci95_lo"] if st == "mean" else None,
              "ci95_hi": blk["ci95_hi"] if st == "mean" else None,
              "n_sessions": blk["n_sessions"],
              "sessions_luc3d_fragments_fewer": blk["wins"]}
             for lab, blk, _c, _h in rows for st in ("mean", "median")]),
            7, "fig7f_fragmentations_variant.csv")

    # 38 mm: the narrowest slot on the column grid that fits the label. One paired
    # difference is one datum -- a wide panel would be white space.
    #
    # THE VARIANT NAMES ITS ARMS IN THE KEY, NOT ON THE X AXIS. Three tick labels
    # ("pre-#131", "shipped", "fresh anchor") set ~30 mm at 6.5 pt inside a 38 mm panel
    # whose y axis already takes ~8 mm, so they would touch. The key band is free and
    # `panel(key=n)` reserves it, so the three arms are named there at 6 pt (the key's
    # default 8 pt would run off a 38 mm panel -- 25 characters is its whole width).
    fig, ax = panel(38.0, ROW_H, key=len(rows) if variant else 0)
    ax.axhline(0, color=INK, lw=0.8, zorder=1)
    xs = [0.0] if not variant else [-0.38, 0.0, 0.38]
    for (lab, blk, color, hollow), xv in zip(rows, xs):
        # SLEAP's hue, matching 7d's "SLEAP ahead" half: colour carries who wins, and
        # SLEAP wins this one. (On the variant colour separates the ARMS instead -- see
        # the docstring -- and the direction is carried by the zero rule and the
        # "SLEAP fewer in N of 74" line.)
        ax.plot([xv, xv], [blk["ci95_lo"], blk["ci95_hi"]], color=color, lw=1.2,
                zorder=3, ls=FRESH_LS if hollow else "-")
        if hollow:
            ax.plot([xv], [blk["mean"]], "o", color=color, ms=6, mfc="white",
                    mec=color, mew=1.0, zorder=4)
        else:
            ax.plot([xv], [blk["mean"]], "o", color=color, ms=6, mec="white", mew=1.0,
                    zorder=4)
        ax.plot([xv - 0.16, xv + 0.16], [blk["median"]] * 2, color=color, lw=1.2,
                zorder=3)

    top = max(blk["ci95_hi"] for _l, blk, _c, _h in rows) * 1.62
    ax.set_xlim(-0.7, 0.7)
    ax.set_ylim(-top * 0.17, top)
    ax.set_xticks([0])
    ax.set_xticklabels(["LUC3D − SLEAP"])
    ax.tick_params(axis="x", length=0)
    ax.set_ylabel("Δ fragmentations")
    # PINNED, AND THE PIN FOLLOWS THE DATA. Left to itself matplotlib dropped to
    # 0/20/40 when the panel got shorter, which halved the resolution a reader has for
    # placing the mean and the median against the axis -- a tick change caused by the
    # page, not the data. The old pin was 0/10/20/30/40 for the retired arm's +24.0
    # mean and [+18.3, +30.0] CI; the shipped arm's axis tops out near +17, where
    # 20/30/40 are off-axis and 0/10 alone is two ticks for the whole panel. A pin has
    # to be re-chosen when the data it was chosen for is replaced -- otherwise "pinned"
    # silently becomes "coarser than the default". `--as-shipped` gets its own pin for
    # the same reason.
    ax.set_yticks([0, 10, 20, 30, 40] if not corrected or variant
                  else [0, 5, 10, 15])
    if variant:
        # Values in the key, at 6 pt: three arms x (mean, CI) will not fit inside a
        # 38 mm plot, and the numbers are the whole point of the comparison.
        text_legend(ax, [(f"{lab} {blk['mean']:+.1f} "
                          f"[{blk['ci95_lo']:+.1f},{blk['ci95_hi']:+.1f}]", c)
                         for lab, blk, c, _h in rows],
                    "above", size=6, dy=0.052 * 52.0 / ROW_H,
                    xy=(0.10, 0.985), transform=fig.transFigure)
        # The direction of the result, still in SLEAP's colour, and the fact that it
        # does NOT change across the three arms -- which is why the panel survives the
        # substitution instead of being withdrawn.
        ax.text(-0.66, top * 0.99, "LUC3D fragments more\non every arm", color=SLEAP,
                fontsize=6, fontweight="bold", va="top", linespacing=1.35)
        # ONE COUNT PER ARM, NAMED ONCE. Repeating each arm's label here ("pre-#131
        # 72/74 · LUC3D (shipped) 72/74 · fresh anchor 70/74") is ~58 characters on a
        # 38 mm panel and the overhang is dropped silently (lint: CLIPPED). The arms are
        # already named, in order, in the key directly above, so the counts can be given
        # in that order. 23 characters, which is what the default render's "SLEAP fewer
        # in 72 of 74" measures and fits at this anchor -- "SLEAP fewer in 72, 72, 70 of
        # 74" (31) does NOT, and its overhang is dropped silently.
        ax.text(-0.66, -top * 0.15,
                "SLEAP fewer "
                + "·".join(f"{blk['n_sessions'] - blk['wins']}"
                           for _l, blk, _c, _h in rows)
                + f"/{n}",
                color=INK, fontsize=5.6, va="bottom")
    else:
        # The numbers go in a LEFT-ALIGNED block in the empty band above the interval,
        # not beside their own marks: this panel is 38 mm wide, and a "median +14.1" set
        # to the right of the median rule ran off the page (the renderer drops the
        # overhang silently, so it has to be placed rather than caught).
        ax.text(-0.66, top * 0.99, "LUC3D fragments more", color=SLEAP, fontsize=6,
                fontweight="bold", va="top")
        ax.text(-0.66, top * 0.86,
                f"{fp['mean']:+.1f} [{fp['ci95_lo']:+.1f}, {fp['ci95_hi']:+.1f}]\n"
                f"median {fp['median']:+.1f}",
                color=SLEAP, fontsize=6, va="top", linespacing=1.35)
        # INK, not GREY: this line IS the panel's finding, and GREY (#B3B3B3) is a
        # series colour at 2.1:1 on white -- too light to carry a result.
        ax.text(-0.66, -top * 0.15, f"SLEAP fewer in {n - luc_better} of {n}",
                color=INK, fontsize=6, va="bottom")
    note = f"per camera-session\nn = {n} sessions\nmean ± 95% CI"
    if variant:
        fr = ref["fragmentations_paired"]
        ff = fresh["fragmentations_paired"]
        note += (f"\nLUC3D here is the SHIPPED tracker: the paired gap is "
                 f"{fp['mean']:+.1f} [{fp['ci95_lo']:+.1f}, {fp['ci95_hi']:+.1f}], "
                 f"median {fp['median']:+.1f}, against the {fr['mean']:+.1f} "
                 f"[{fr['ci95_lo']:+.1f}, {fr['ci95_hi']:+.1f}] this panel printed until "
                 f"2026-08-13 for the pre-#131 tracker -- so '+24.0' is a "
                 f"property of a tracker the app no longer contains"
                 f"\nthe fresh anchor (shipped since 2026-08-17) is {ff['mean']:+.1f} "
                 f"[{ff['ci95_lo']:+.1f}, {ff['ci95_hi']:+.1f}]. THE SIGN IS UNCHANGED ON "
                 f"ALL THREE ARMS -- SLEAP fragments fewer in "
                 f"{fr['n_sessions'] - fr['wins']}, {fp['n_sessions'] - fp['wins']} and "
                 f"{ff['n_sessions'] - ff['wins']} of {n} sessions -- so the finding "
                 f"stands and only its magnitude moves"
                 f"\n{pool_note()}")
    footnote(ax, note)
    save(fig, 7, "f", slug("fragmentations", variant, corrected, fresh_arm))


if __name__ == "__main__":
    main(*flags(sys.argv))
