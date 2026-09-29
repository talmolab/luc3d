#!/usr/bin/env python3
"""
Fig 4e -- he is pursuing her: his own BODY AXIS is oriented at her while moving;
hers is not oriented at him.

PURSUIT BY FACING, NOT BY TRAVEL DIRECTION (2026-08-21). `pursuit_rel_t0`/
`pursuit_rel_t1` (figs/fig4_upright.py) decompose each animal's own body-axis
orientation (Nose -> TTI) onto the line connecting the two animals, then scale by
that animal's own speed relative to its session baseline, so facing without moving
scores near zero. Negative is oriented toward the partner and closing. The window is
the 1.5 s before onset.

ONE VALUE PER SESSION (revised 2026-09-20). The previous version drew the boxes over
all 538 displays and ran the paired Wilcoxon over displays, which treats repeated
displays of the same two animals as independent and reported P = 3.3e-73 from nine
mice. The unit of replication is now the session, as in panel F and as the Statistics
section states: each animal's median pursuit score over that session's displays is one
observation, the boxes are drawn over those 37 values, and the paired Wilcoxon runs across
sessions. Pair-level and animal-level
versions are computed alongside and deposited (figs/fig4_replication.py).

THE FINDING. Session medians: male -0.89, female -0.07. The male's score is more
negative in 37 of 37 sessions (paired Wilcoxon P = 1.5e-11), in 14 of 14 pairs with
five or more displays (P = 1.2e-4), and every one of the four males is more negative
than every one of the five females (unpaired across animals P = 0.016). It shows he is
oriented at her and moving for over a second before a display she leads. It does NOT
show she is oriented away from him: her median is close to zero, so the asymmetry is
that he is doing the orienting and approaching.

Source: figs/out/fig5_upright.json `events[].{pursuit_rel_t0,pursuit_rel_t1}` and
        `per_session[].per_track[].animal` (figs/fig4_upright.py).

    python3 figs/panels/fig4_07_upright_stats.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig4_replication import (attach_identity, by_unit, report, stars,  # noqa: E402
                              summary_rows, tests)
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CM, CFEM = "#4393C3", "#D6604D"      # male, female -- matches 4b/4d/4f/4g
COL_M, COL_F = "pursuit_rel_t0", "pursuit_rel_t1"


def whisker_extent(v):
    """matplotlib's own boxplot whisker rule (Q3 + 1.5*IQR, capped at the furthest
    point actually inside it, and the low-side mirror), so the significance bracket
    sits just above the drawn whisker."""
    q1, q3 = np.percentile(v, [25, 75])
    iqr = q3 - q1
    hi = v[v <= q3 + 1.5 * iqr].max()
    lo = v[v >= q1 - 1.5 * iqr].min()
    return lo, hi


def main():
    use()
    d = load("fig5_upright.json")
    ev = attach_identity(pd.DataFrame(d["events"]), d["per_session"])
    deposit(ev[["session", "male_id", "female_id", "dur_s", "peak_hi", "peak_lo",
                "height_match", "min_nose_gap", "base_gap", "ratio", "speed_rel",
                "speed_rel_t0", "speed_rel_t1", COL_M, COL_F]],
            4, "fig4e_upright_stats.csv")

    t = tests(ev, COL_M, COL_F, male_direction="less")
    report("4e pursuit", t)
    ses = by_unit(ev, COL_M, COL_F, "session")
    deposit(pd.concat([ses, summary_rows(t)], ignore_index=True), 4,
            "fig4e_pursuit_by_session.csv")
    m, f = ses.male_median.to_numpy(), ses.female_median.to_numpy()
    p = t["session"]["wilcoxon_p"]

    # THIRD/STD, matching 4d/4f's box-and-whisker footprint exactly.
    fig, ax = panel("third", "std")
    for x, data, col in ((0, m, CM), (1, f, CFEM)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))
    ax.axhline(0.0, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)

    lo_m, hi_m = whisker_extent(m)
    lo_f, hi_f = whisker_extent(f)
    lo, hi = min(lo_m, lo_f), max(hi_m, hi_f)
    pad = 0.12 * (hi - lo)

    # SIGNIFICANCE BRACKET, same idiom as 4d/4f, from the session-level test.
    y = hi + 0.5 * pad
    ax.plot([0, 0, 1, 1], [y - 0.1 * pad, y, y, y - 0.1 * pad], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    ax.text(0.5, y + 0.06 * pad, stars(p), ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["male", "female"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(lo - pad, y + 3 * pad)
    ax.set_ylabel("facing-pursuit, session medians\n(− = approaching)")
    save(fig, 4, "e", "upright_stats")


if __name__ == "__main__":
    main()
