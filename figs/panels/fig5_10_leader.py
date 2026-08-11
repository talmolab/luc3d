#!/usr/bin/env python3
"""
Fig 5f -- each session has a leader, and the leader starts 80% of the displays.

THE CLAIM. Within a session one animal starts most of the displays. Pooled over all
539 displays in 37 sessions, the session's leader starts **432 of them, 80.1%**. That
number is stable against every reasonable inclusion rule -- 79.8% over sessions with
at least 3 displays, 79.6% at 5, 79.8% at 8, 79.0% at 10 -- so it is not an artefact
of which sessions are counted.

WHY THE NULL CURVE IS NOT OPTIONAL, and why the previous version of this panel was
misleading without it. "The leader's share" is max(share_0, share_1), which CANNOT
fall below 0.5 however the two animals behave: a session that splits its displays
evenly still scores 0.5, and a session with three displays scores 0.67 or 1.00 with
nothing else on offer. The old inset plotted that statistic against a line at 0.5,
i.e. against its own floor, and pooled the small sessions into a median of 0.889 that
was mostly arithmetic. The grey curve here is what a FAIR COIN gives at each session
size -- the 95th percentile of max-share under Binomial(n, 0.5), 20,000 draws per n --
so a dot only counts as evidence if it clears the curve at its own n. 16 of the 24
sessions with at least five displays do. The median leader share among those sessions
is 0.83 against a null median of 0.57 at the same session sizes.

EVERY SESSION IS DRAWN, including the ones too small to carry evidence, because
dropping them would hide exactly the artefact the curve exists to expose: the six
one-display sessions sit at 1.00, and so does the null.

Source: figs/out/fig5_upright.json `per_session[].{n_events,per_track[].n_lead}`
        (figs/fig5_upright.py).

    python3 figs/panels/fig5_10_leader.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, use  # noqa: E402

CI = "#8DA0CB"      # the leader's share
CN = "#B3B3B3"      # the fair-coin null
MIN_DISPLAYS = 5    # below this a session cannot clear the null at any share
NDRAW = 20000


def null_curve(ns, q=0.95, seed=0):
    """qth percentile of max(k, n-k)/n under a fair coin, per n."""
    rng = np.random.default_rng(seed)
    return np.array([np.quantile(np.maximum(x := rng.binomial(n, 0.5, NDRAW),
                                            n - x) / n, q) for n in ns])


def main():
    use()
    d = load("fig5_upright.json")

    rows = []
    for r in d["per_session"]:
        n = r["n_events"]
        led = max(t["n_lead"] for t in r["per_track"])
        rows.append({"session": r["session"], "displays": n,
                     "started_by_leader": led, "leader_share": led / n})
    df = pd.DataFrame(rows).sort_values("displays")
    deposit(df, 5, "fig5f_leader_by_session.csv")

    pooled = df["started_by_leader"].sum() / df["displays"].sum()
    big = df[df["displays"] >= MIN_DISPLAYS]
    ns = np.arange(1, int(df["displays"].max()) + 1)
    curve = null_curve(ns)
    above = int((big["leader_share"].to_numpy()
                 > curve[big["displays"].to_numpy() - 1]).sum())

    fig, ax = panel("half", "short")
    # The null first and in grey: it is the reference the dots are read against, not
    # a series. Shading BELOW it says "anything in here is what a coin would do".
    ax.fill_between(ns, 0.5, curve, color=CN, alpha=0.30, lw=0, zorder=1)
    ax.step(ns, curve, where="mid", color=CN, lw=1.0, zorder=2)
    ax.axhline(0.5, color=INK, lw=0.8, ls="--", alpha=0.7, zorder=2)

    ax.scatter(df["displays"], df["leader_share"], s=13, color=CI, alpha=0.80,
               lw=0, zorder=4)
    ax.axhline(pooled, color=CI, lw=1.2, zorder=3)

    ax.set_xscale("log")
    ax.set_xlim(0.85, 80)
    ax.set_xticks([1, 3, 10, 30])
    ax.set_xticklabels(["1", "3", "10", "30"])
    # HEADROOM ABOVE 1.0 FOR BOTH CALLOUTS. There is no clear space inside the data
    # area: the grey band fills the left, the dots the right, and the 0.5 rule and
    # its tick label the bottom -- the first placement put both blocks across the
    # rule. The raised limit reserves a band that no mark can enter, which is the
    # same fix 5c and 5e use.
    ax.set_ylim(0.44, 1.17)
    ax.set_yticks([0.5, 0.75, 1.0])
    ax.set_xlabel("displays in session")
    ax.set_ylabel("started by the leader")

    ax.text(0.015, 0.99, f"leader starts {100 * pooled:.0f}% of all displays",
            transform=ax.transAxes, ha="left", va="top", fontsize=6.5,
            fontweight="bold", color=CI)
    ax.text(0.015, 0.87,
            f"{above}/{len(big)} sessions (≥{MIN_DISPLAYS} displays) beat chance "
            f"(grey)",
            transform=ax.transAxes, ha="left", va="top", fontsize=6, color=MUTED)
    save(fig, 5, "f", "leader")


if __name__ == "__main__":
    main()
