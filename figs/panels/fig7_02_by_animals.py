#!/usr/bin/env python3
"""
Fig 7d -- per-session paired difference in IDF1, LUC3D minus SLEAP, by animal count.

PAIRED, WITH REAL CONFIDENCE INTERVALS. An earlier version of this panel plotted the
two trackers' raw pooled IDF1 side by side and its docstring claimed no spread was
available. That was wrong: `paired_vs_sleap` deposits per-session differences with
95% CIs, win/loss counts and a sign test. The paired form is also the right one --
these are the SAME sessions scored by both trackers, so the difference is measured
within session and the between-session variation cancels.

WHAT IT SHOWS, INCLUDING WHERE LUC3D LOSES. LUC3D is ahead at 1 animal (+0.141,
25/32 wins) and 2 animals (+0.035, 23/35), and BEHIND at 3 (-0.030, 0/4) and 4
(-0.028, 0/3). Those last two cells rest on 4 and 3 sessions; the panel prints the
win count over n ("0/4") under every tick so the reader can weigh them, and the
negative cells are NOT hidden.

THE POOLED +0.075 IS NOT A MULTI-ANIMAL RESULT, and the panel now says so on the
artwork rather than leaving the reader to notice. 32 of the 74 sessions -- 43% of the
corpus -- contain ONE animal, and with one animal there is nothing to associate
across views: whatever produces +0.141 there is detection gating and gap handling,
not cross-view association. That cell is also the largest effect in the figure, so it
carries the pooled statistic. Split at the mechanism boundary:

    1 animal   n = 32   +0.141   25/32   sign P = 0.002
    >= 2       n = 42   +0.024   23/42   sign P = 0.644
    all 74     n = 74   +0.075   48/74   sign P = 0.014

So in the stratum where cross-view association can actually operate the paired
advantage is +0.024 and does not clear a sign test, and the two cells where the
mechanism should help MOST (3 and 4 animals) are negative. An earlier docstring
discounted those two for small n while quoting the 1-animal cell without comment;
that asymmetry is what this split removes.

The >= 2 figure is recomputed here from the deposited per-session differences of the
2-, 3- and 4-animal cells (the deposit has no combined cell). It is the n-weighted
mean of the three cell means -- (35*0.034964 + 4*-0.030234 + 3*-0.027937)/42 =
0.024262 -- so it can be checked by hand against the file. No bootstrap interval is
printed for it: `boot_ci` resamples in the order it is given and the deposit stores
each cell SORTED, so a CI recomputed here would not be the CI the generator would
have produced. The exact sign test does not have that problem, which is why it is the
statistic shown.

Source: figs/out/fig3_trackers.json `slap2m.paired_vs_sleap`.

    python3 figs/panels/fig7_02_by_animals.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, INK, entity, deposit, panel, save,  # noqa: E402
                       use)

#: The two entities this panel contrasts. `entity()` rather than a local TEAL /
#: PERIWINKLE: the sign of the difference is encoded in the two trackers' own set-wide
#: hues, so teal here MUST be the same teal as 7a's LUC3D and 7e's LUC3D bar, and
#: periwinkle the same SLEAP (review finding C3). Colours unchanged.
LUC3D, SLEAP = entity("luc3d"), entity("sleap")
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



def sign_p(pos, n):
    """Exact two-sided sign test -- the same function `fig3_trackers.py` uses."""
    if n == 0:
        return 1.0
    k = min(pos, n - pos)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def main():
    use()
    pv = load("fig3_trackers.json")["slap2m"]["paired_vs_sleap"]
    counts = sorted(int(k) for k in pv if k != "all")

    rows = [{"animals": a, "mean": pv[str(a)]["mean"],
             "ci95_lo": pv[str(a)]["ci95_lo"], "ci95_hi": pv[str(a)]["ci95_hi"],
             "n_sessions": pv[str(a)]["n_sessions"], "wins": pv[str(a)]["wins"]}
            for a in counts]
    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7d_by_animals.csv")

    # The multi-animal stratum: every session with 2 or more animals, which is where
    # cross-view association has anything to do.
    multi = [v for a in counts if a >= 2 for v in pv[str(a)]["per_session"]]
    m_mean = sum(multi) / len(multi)
    m_wins = sum(1 for v in multi if v > 0)
    m_p = sign_p(m_wins, len(multi))

    fig, ax = panel("half", ROW_H)
    x = np.arange(len(df))
    ax.axhline(0, color=INK, lw=0.8, zorder=1)
    for i, r in df.iterrows():
        color = LUC3D if r["mean"] > 0 else SLEAP
        ax.plot([i, i], [r.ci95_lo, r.ci95_hi], color=color, lw=1.2, zorder=3)
        ax.plot([i], [r["mean"]], "o", color=color, ms=6, mec="white", mew=1.0,
                zorder=4)
        # Label AWAY from zero -- above a positive mean, below a negative one. The
        # 3- and 4-animal means are -0.030 and -0.028, about a millimetre off the
        # zero rule at this scale, so a vertically centred label had the rule
        # running through it.
        up = r["mean"] > 0
        ax.annotate(f"{r['mean']:+.3f}", (i, r["mean"]), textcoords="offset points",
                    xytext=(9, 4 if up else -4), color=color, fontsize=6.5,
                    va="bottom" if up else "top")

    ax.set_xticks(x)
    # TWO lines, not three: n is the denominator of the win count, so "25/32" prints
    # both numbers a separate "n = 32" line was printing.
    ax.set_xticklabels([f"{int(r.animals)}\n{int(r.wins)}/{int(r.n_sessions)}"
                        for _, r in df.iterrows()])
    ax.set_xlabel("animals · wins / sessions", labelpad=2)
    # TWO LINES. Rotated, this label sets ~30 mm of type against a ~19 mm axis at
    # this row height, and a rotated label cannot be shrunk by constrained_layout --
    # it is centred on the axes and simply overhangs, so at anything under 52 mm the
    # page cut its ends off (`lint_text.py` CLIPPED). Wrapped it costs width, of
    # which an 88 mm panel has plenty.
    ax.set_ylabel("Δ IDF1\nLUC3D − SLEAP")
    ax.set_xlim(-0.6, len(df) - 0.2)
    lim = max(df.ci95_hi.max(), -df.ci95_lo.min()) * 1.9
    ax.set_ylim(-lim, lim)
    ax.text(0.98, 0.96, "LUC3D ahead", transform=ax.transAxes, ha="right",
            va="top", color=LUC3D, fontsize=6.5, fontweight="bold")
    ax.text(0.98, 0.04, "SLEAP ahead", transform=ax.transAxes, ha="right",
            va="bottom", color=SLEAP, fontsize=6.5, fontweight="bold")

    # TWO BRACKETS AND TWO NOTES, in the empty band below the data: one over the
    # 1-animal cell saying why its +0.141 cannot be a cross-view result, one over the
    # 2/3/4 cells carrying their pooled statistic. Both notes live BELOW the data
    # rather than beside it -- placed at the top of the axes the 1-animal note landed
    # on that cell's own "+0.141" label (23% overlap). `by` is well below the
    # 3-animal CI's -0.079, so neither rule crosses a mark. `by` is a fraction of
    # `lim`, i.e. pinned in DATA units, so shortening the panel moves the bracket and
    # the '-0.030' label it sits under by the same amount; at 47 mm they met (5% of
    # the label's box inked) and 48 mm is the measured floor where they do not.
    by = -lim * 0.37
    ty = by - lim * 0.07
    for lo, hi in ((-0.28, 0.28), (0.72, 3.28)):
        ax.plot([lo, hi], [by, by], color=GREY, lw=0.8, zorder=1)
        for xe in (lo, hi):
            ax.plot([xe, xe], [by, by + lim * 0.05], color=GREY, lw=0.8, zorder=1)
    # INK for the notes, GREY for the brackets: the notes carry results and GREY
    # (#B3B3B3) is a series colour at 2.1:1 on white.
    ax.text(-0.55, ty, "1 animal: nothing to\nassociate across views",
            color=INK, fontsize=6, ha="left", va="top", linespacing=1.35)
    ax.text(1.15, ty,
            f"≥ 2 animals pooled: {m_mean:+.3f}\n"
            f"(n = {len(multi)}, {m_wins}/{len(multi)}, P = {m_p:.2f})",
            color=INK, fontsize=6, ha="left", va="top", linespacing=1.35)

    a = pv["all"]
    # TWO lines. On one line this note is wider than the 88 mm panel, and since the
    # panel is saved at exactly that width the final digit of P was cut off the page.
    footnote(ax, f"all {a['n_sessions']} sessions: {a['mean']:+.3f} "
             f"[{a['ci95_lo']:+.3f}, {a['ci95_hi']:+.3f}], "
             f"{a['wins']}/{a['n_sessions']}, P = {a['sign_p']:.3f}\n"
             "carried by the 1-animal stratum, NOT a multi-animal result")
    save(fig, 7, "d", "by_animals")


if __name__ == "__main__":
    main()
