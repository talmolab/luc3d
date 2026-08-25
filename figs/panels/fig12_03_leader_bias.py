#!/usr/bin/env python3
"""
Fig 12c -- novel pairs have a leader in every session; familiar pairs have none.

Fig 5f reported that each Mouse-Dyad-10M session has a consistent initiator: of the
displays whose initiator is resolvable, one of the two animals starts most of them,
median 0.86. Re-measured, the same statistic reads 0.60 on SLAP-2M and 0.58 on the
s-DANNCE SCN2A rats, and the naive reading of "0.86 vs 0.60 vs 0.58" is "a weaker
leader". THAT READING IS WRONG, and this panel exists to prevent it.

THE STATISTIC HAS A FLOOR, so 0.5 is not its null. `initiator_bias` is
max(k, n-k) / n over a session's n resolvable displays -- it cannot fall below 0.5 by
construction, and a FAIR COIN produces well above 0.5 at these n. For a session with
16 displays a coin flip gives 0.60 on average; with 22 it gives 0.58. SLAP-2M's median
of 22 displays per session therefore *predicts* a bias of 0.584 with no leader
whatsoever, which is essentially the 0.600 observed.

So each session is compared against ITS OWN coin-flip expectation, computed exactly
from its own display count (E[max(k, n-k)/n] under k ~ Binomial(n, 1/2)), and the panel
plots the EXCESS. Zero means "indistinguishable from two animals rearing first at
random". The two corpora separate completely:

  * Mouse-Dyad-10M: median excess +0.245, and every one of the 20 gated sessions is
    above its own null. Unanimity across sessions is the claim, not the median.
  * SLAP-2M: median excess +0.007, with 13 of 23 sessions above null -- what a fair
    coin gives (13/23 is p = 0.66 on a two-sided binomial test). There is no leader to
    find, rather than a smaller one.
  * s-DANNCE SCN2A: median excess +0.020, 16 of 29 sessions above null (p = 0.71). Also a
    coin flip, and on the LARGEST sample of the three arms (1,042 displays), so this is
    the best-powered of the two negatives. The rats do co-rear above chance (panel a);
    what they do not do is have one animal reliably go up first.

ONLY SESSIONS THAT CAN ESTIMATE A BIAS VOTE: at least MIN_EVENTS_FOR_BIAS = 8
resolvable displays (`fig12_social.py`). Below that the floor dominates -- two displays
score 0.5 or 1.0 and nothing between -- and an ungated version of this panel reports a
high bias for whichever corpus has the emptiest sessions, which is the opposite of the
truth.

Source: figs/out/fig12_social.json (figs/fig12_social.py --corpus slap-2m
        --corpus mouse-dyad-10m).

    python3 figs/panels/fig12_03_leader_bias.py
"""
import sys
from math import comb
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (CORPUS_COLORS, INK, MUTED, corpus, deposit,  # noqa: E402
                       footnote, panel, save, use)

#: (data key, printed familiarity, colour). Hues come from `style.CORPUS_COLORS` so the
#: three Fig 12 panels agree and SCN2A keeps the amber it wears on Figs 10-11.
ARMS = [("mouse-dyad-10m", "novel mice", CORPUS_COLORS["mouse-dyad-10m"]),
        ("slap-2m", "familiar mice", CORPUS_COLORS["slap-2m"]),
        ("scn2a", "rats, mixed genotype", CORPUS_COLORS["scn2a"])]

#: Tick labels: short, because three of them share a narrow axis.
TICKS = ["novel\nmice", "familiar\nmice", "rats"]


def coin_bias(n):
    """E[max(k, n-k) / n] for k ~ Binomial(n, 1/2): the bias a FAIR COIN produces.

    Exact rather than simulated -- n is small (8 to a few hundred) so the sum is cheap,
    and a sampled null would put noise on the very baseline the panel measures against.
    """
    return sum(comb(n, k) * 0.5 ** n * max(k, n - k) / n for k in range(n + 1))


def main():
    use()
    D = load("fig12_social.json")["leader"]

    rows, series = [], []
    for ckey, fam, col in ARMS:
        L = D[ckey]
        gate = L["min_events_for_bias"]
        ps = [r for r in L["per_session"]
              if r["n_initiator_known"] >= gate and r["initiator_bias"] is not None]
        obs = np.array([r["initiator_bias"] for r in ps], float)
        exp = np.array([coin_bias(r["n_initiator_known"]) for r in ps], float)
        series.append((ckey, fam, col, obs - exp))
        for r, o, e in zip(ps, obs, exp):
            rows.append({"corpus": corpus(ckey), "familiarity": fam,
                         "session": r["session"], "n_displays": r["n_initiator_known"],
                         "initiator_bias": o, "coin_flip_null": e, "excess": o - e})
    deposit(pd.DataFrame(rows), 12, "fig12c_leader_bias.csv")

    # HALF, not third: assemble centres a lone panel in its row but sets the panel
    # letter at the row's left margin, so a third-width panel's centred title runs back
    # under the letter ("Ac..." in the 2026-08-20 proof). Half clears it.
    fig, ax = panel("half", "short")
    rng = np.random.default_rng(0)          # jitter only; seeded so the panel is stable
    for i, (ckey, fam, col, ex) in enumerate(series):
        ax.boxplot([ex], positions=[i], widths=0.5, showfliers=False,
                   medianprops=dict(color=INK, lw=1.3),
                   boxprops=dict(color=MUTED, lw=0.8),
                   whiskerprops=dict(color=MUTED, lw=0.8),
                   capprops=dict(color=MUTED, lw=0.8), zorder=2)
        ax.scatter(i + rng.uniform(-0.14, 0.14, ex.size), ex, s=7, color=col,
                   alpha=0.85, lw=0, zorder=3)
    # ZERO, not 0.5, is "no leader" -- see the module docstring.
    ax.axhline(0.0, color=INK, lw=0.8, ls="--", alpha=0.7, zorder=1)

    ax.set_xticks(range(len(series)))
    ax.set_xticklabels(TICKS, fontsize=6, linespacing=1.15)
    ax.set_ylabel("initiator bias above\ncoin-flip null")
    ax.set_xlim(-0.55, len(series) - 0.45)
    # Headroom for the count labels: without it they land on the topmost dots, which in
    # the novel arm reach the axis limit.
    lo, hi = ax.get_ylim()
    ax.set_ylim(lo, hi + 0.13 * (hi - lo))
    for i, (ckey, fam, col, ex) in enumerate(series):
        ax.text(i, ax.get_ylim()[1], f"{int((ex > 0).sum())}/{ex.size}", ha="center",
                va="top", fontsize=6, color=INK)

    footnote(ax, " · ".join(
        f"{corpus(k)}: median excess {np.median(ex):+.3f}, "
        f"{int((ex > 0).sum())} of {ex.size} sessions above their own null"
        for k, _, _, ex in series)
        + ". One dot per session with at least "
        f"{D['slap-2m']['min_events_for_bias']} resolvable displays; box is median and "
        "IQR, whiskers 1.5x IQR. Zero = indistinguishable from a fair coin.")
    save(fig, 12, "c", "leader_bias")


if __name__ == "__main__":
    main()
