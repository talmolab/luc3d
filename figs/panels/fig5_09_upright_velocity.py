#!/usr/bin/env python3
"""
Fig 4d -- individual speed before the display: male still traveling, female
already still.

BOX-AND-WHISKER, MALE VS FEMALE, over ONE VALUE PER SESSION (revised 2026-09-20).
The previous version drew the boxes over all 538 displays and ran the paired Wilcoxon
over displays, which treats repeated displays of the same two animals as independent
and reported P = 6.5e-22 from nine mice. The displays are nested in 37 sessions of 9
mice in 18 pairings, and one female contributes 305 of them. The unit of replication
is now the session, as it already is in panel F and as the Statistics section states:
each animal's median pre-onset speed over that session's displays is one observation,
the boxes are drawn over those 37 values, and the paired Wilcoxon runs across sessions. The pair-level and animal-level versions are
computed alongside and deposited (figs/fig5_replication.py).

THE MEASURE is unchanged: plain body lengths per second in the 0.5 s before onset
(`speed_bl_s_t0`/`speed_bl_s_t1`, figs/fig5_upright.py), not each animal's own
baseline, so the panel answers "who is moving faster" directly.

THE FINDING. Session medians: male 0.36 body lengths/s, female 0.20. The male is
faster in 28 of 37 sessions (paired Wilcoxon P = 4.6e-4), in 13 of 14 pairs with five
or more displays (P = 2.4e-4), and every one of the four males is faster than four of
the five females (unpaired across animals P = 0.19, four against five).

Source: figs/out/fig5_upright.json `events[].{speed_bl_s_t0,speed_bl_s_t1}` and
        `per_session[].per_track[].animal` (figs/fig5_upright.py).

    python3 figs/panels/fig5_09_upright_velocity.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig5_replication import (attach_identity, by_unit, report, stars,  # noqa: E402
                              summary_rows, tests)
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CM, CFEM = "#4393C3", "#D6604D"      # male, female -- matches 4b/4e/4f/4g
COL_M, COL_F = "speed_bl_s_t0", "speed_bl_s_t1"


def whisker_extent(v):
    """matplotlib's own boxplot whisker rule (Q3 + 1.5*IQR, capped at the furthest
    point actually inside it, and the low-side mirror) -- so a significance
    bracket can sit just above the real drawn whisker, not an approximation of it."""
    q1, q3 = np.percentile(v, [25, 75])
    iqr = q3 - q1
    hi = v[v <= q3 + 1.5 * iqr].max()
    lo = v[v >= q1 - 1.5 * iqr].min()
    return lo, hi


def main():
    use()
    d = load("fig5_upright.json")
    ev = attach_identity(pd.DataFrame(d["events"]), d["per_session"])
    # The display-level values stay deposited for the distribution; the test no
    # longer runs on them.
    deposit(ev[["session", "male_id", "female_id", COL_M, COL_F,
                "speed_rel_t0", "speed_rel_t1"]], 5, "fig5d_upright_velocity.csv")

    t = tests(ev, COL_M, COL_F, male_direction="greater")
    report("4d speed", t)
    ses = by_unit(ev, COL_M, COL_F, "session")
    deposit(pd.concat([ses, summary_rows(t)], ignore_index=True), 5,
            "fig5d_speed_by_session.csv")
    m, f = ses.male_median.to_numpy(), ses.female_median.to_numpy()
    p = t["session"]["wilcoxon_p"]

    # THIRD/STD, matching 4e/4f's box-and-whisker footprint exactly.
    fig, ax = panel("third", "std")
    for x, data, col in ((0, m, CM), (1, f, CFEM)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))

    lo_m, hi_m = whisker_extent(m)
    lo_f, hi_f = whisker_extent(f)
    lo, hi = min(lo_m, lo_f, 0.0), max(hi_m, hi_f)
    pad = 0.12 * (hi - lo)

    # SIGNIFICANCE BRACKET, same idiom as 4e/4f, from the session-level test.
    y = hi + 0.5 * pad
    ax.plot([0, 0, 1, 1], [y - 0.1 * pad, y, y, y - 0.1 * pad], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    ax.text(0.5, y + 0.06 * pad, stars(p), ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["male", "female"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(lo - pad, y + 3 * pad)
    ax.set_ylabel("speed, 0.5 s before onset\n(body lengths / s, session medians)")
    save(fig, 5, "d", "upright_velocity")


if __name__ == "__main__":
    main()
