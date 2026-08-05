#!/usr/bin/env python3
"""
Fig 4d -- reprojection error in a camera the solve never saw, by camera count.

The reference-free version of panel b, and the only place the two solvers are
compared on a quantity neither of them optimised. Needs no proofread 3D: the
prediction is scored against the raw detection in a held-out camera.

WHY THE DIFFERENCE STRIP. On a 0-based axis the two solvers' medians differ by
< 0.15 px out of ~3-4 and are visually identical, yet the finding is that the SIGN
of their difference flips: at two cameras the refinement is worse, at three and four
it is better. Levels alone cannot show that, so the strip below plots the signed
difference and each bar takes the winning solver's colour.

Do NOT restore a "the refinement does not generalise" headline from this panel. On
one session the refinement was worse out of sample; on all 50 it is slightly better
(3.05 vs 2.97 px pooled, lower in 34/50 sessions, better on 53.1% of 21,268,180
held-out views). The defensible statement is detectable but negligible.

Source: figs/out/fig4.json `heldout_by_views.by_k`.

    python3 figs/panels/fig4_04_heldout_by_views.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (grid, GREY, PERIWINKLE, TEAL, deposit, footnote,  # noqa: E402
                       save, text_legend, use)

DLT_C, REF_C = PERIWINKLE, TEAL


def build() -> pd.DataFrame:
    hv = load("fig4.json")["heldout_by_views"]["by_k"]
    rows = []
    for k in sorted(int(k) for k in hv):
        d, b = hv[str(k)]["dlt"], hv[str(k)]["ba"]
        rows.append({
            "cameras": k, "dlt_p50": d["p50"], "refined_p50": b["p50"],
            "delta_p50": b["p50"] - d["p50"], "n": d["n"],
        })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4d_heldout_by_views.csv")

    # Shared x, 2.7:1 heights -- the strip is a readout of the panel above it, not a
    # second panel, so it gets no x label of its own and no top spine.
    #
    # IT WAS 2.1:1 AND THAT WAS TOO MUCH ROOM for what it says. The differences are
    # 0.06-0.14 px on a 3-4 px level and the bars fill a +-0.1 px axis, so the strip
    # was giving maximum visual prominence to an effect this figure's own text calls
    # negligible. The strip has to stay -- the SIGN FLIP is the finding and a 0-based
    # level axis cannot show it -- but it is sized as the footnote it is.
    fig, (ax, strip) = grid(
        2, 1, span="third", row="std", sharex=True, despine=False,
        gridspec_kw={"height_ratios": [2.7, 1.0]},
    )
    sns.despine(ax=ax, top=True, right=True)
    sns.despine(ax=strip, top=True, right=True)

    for col, color in (("dlt_p50", DLT_C), ("refined_p50", REF_C)):
        ax.plot(df.cameras, df[col], color=color, lw=2.0, zorder=3)
        ax.plot(df.cameras, df[col], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)
    ax.set_ylabel("error (px)")
    ax.set_ylim(0, None)
    text_legend(ax, [("DLT", DLT_C), ("refined", REF_C)], "above right", dy=0.16)

    strip.axhline(0, color=GREY, lw=0.8, ls=(0, (3, 2)), zorder=1)
    for _, r in df.iterrows():
        # Each bar takes the WINNER's colour, so the sign flip reads without a key.
        strip.bar(r.cameras, r.delta_p50, width=0.34, zorder=2,
                  color=REF_C if r.delta_p50 < 0 else DLT_C)
    lim = df.delta_p50.abs().max() * 1.9
    strip.set_ylim(-lim, lim)
    strip.set_yticks([-0.1, 0.1])
    strip.set_ylabel("Δ (px)")
    strip.set_xticks(df.cameras)
    strip.set_xlabel("cameras the solver was given")
    # WHAT THE STRIP IS NOT: an interval. Every bar pools all 1,417,879 keypoints of
    # all 50 sessions into one number, and those sessions are correlated -- three
    # calibrations, one rig -- so the bar has no error bar and could not honestly be
    # given one from this deposit, which stores only by-k pooled percentiles. Say the
    # sample size, say the magnitude relative to the level, and point at the panel
    # that does treat the session as the unit. Panel e's held-out group is the same
    # comparison with one dot per session, and it is the one to read for spread.
    # Lines wrap at ~32 characters: a 37-character first line ran off the page, and
    # the linter's `truncated()` check catches that, so keep them short.
    footnote(strip, "Δ = refined − DLT, pooled\n"
                    "over n=1,417,879 keypoints\n"
                    "session-level spread: panel e")

    save(fig, 4, "d", "heldout_by_views")


if __name__ == "__main__":
    main()
