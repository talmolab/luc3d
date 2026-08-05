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
negative cells are NOT hidden. Pooled over all 74 sessions the difference is +0.075
[+0.049, +0.102], 48/74, sign test P = 0.014.

Source: figs/out/fig3_trackers.json `slap2m.paired_vs_sleap`.

    python3 figs/panels/fig7_02_by_animals.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, INK, PERIWINKLE, TEAL, deposit, panel, save,  # noqa: E402
                       use)


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

    fig, ax = panel("half", "std")
    x = np.arange(len(df))
    ax.axhline(0, color=INK, lw=0.8, zorder=1)
    for i, r in df.iterrows():
        color = TEAL if r["mean"] > 0 else PERIWINKLE
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
    # both numbers a separate "n = 32" line was printing. The line it saves is what
    # lets the two-line footnote below fit without squeezing the y label off the
    # page -- the panel is saved at exactly 88 x 52 mm.
    ax.set_xticklabels([f"{int(r.animals)}\n{int(r.wins)}/{int(r.n_sessions)}"
                        for _, r in df.iterrows()])
    ax.set_xlabel("animals · wins / sessions", labelpad=2)
    ax.set_ylabel("Δ IDF1, LUC3D − SLEAP")
    ax.set_xlim(-0.6, len(df) - 0.2)
    lim = max(df.ci95_hi.max(), -df.ci95_lo.min()) * 1.9
    ax.set_ylim(-lim, lim)
    ax.text(0.98, 0.96, "LUC3D ahead", transform=ax.transAxes, ha="right",
            va="top", color=TEAL, fontsize=6.5, fontweight="bold")
    ax.text(0.98, 0.04, "SLEAP ahead", transform=ax.transAxes, ha="right",
            va="bottom", color=PERIWINKLE, fontsize=6.5, fontweight="bold")

    a = pv["all"]
    # TWO lines. On one line this note is wider than the 88 mm panel, and since the
    # panel is saved at exactly that width the final digit of P was cut off the page
    # (0.5 pt over the edge, which is under the text linter's clipping tolerance --
    # so it has to be kept short here rather than caught there).
    footnote(ax, f"all {a['n_sessions']} sessions: {a['mean']:+.3f} "
            f"[{a['ci95_lo']:+.3f}, {a['ci95_hi']:+.3f}]\n"
            f"{a['wins']}/{a['n_sessions']} wins, sign test P = {a['sign_p']:.3f}")
    save(fig, 7, "d", "by_animals")


if __name__ == "__main__":
    main()
