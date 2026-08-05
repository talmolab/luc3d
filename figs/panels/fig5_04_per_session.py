#!/usr/bin/env python3
"""
Fig 5d -- the same comparison per session, at a 10% review budget.

Panel c's curves are means over sessions. This is the check that the mean is not
hiding a corpus in which the residual only wins on average: one point per session,
correction found by ranking on the cross-view residual against correction found by
ranking on detector confidence.

EVERY POINT ABOVE THE DIAGONAL IS A SESSION WHERE THE RESIDUAL WINS. The panel
prints how many, so "the residual is the better signal" is a count and not an
impression.

Source: figs/out/fig6_detections.json `sessions[].capture_by_{reproj,lowconf}`.

    python3 figs/panels/fig5_04_per_session.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, INK, SALMON, deposit, panel, save, use  # noqa: E402

BUDGET = "0.1"


def main():
    use()
    sess = load("fig6_detections.json")["sessions"]
    rows = [{"session": s["session"],
             "by_residual_pct": s["capture_by_reproj"][BUDGET] * 100,
             "by_confidence_pct": s["capture_by_lowconf"][BUDGET] * 100}
            for s in sess
            if BUDGET in s.get("capture_by_reproj", {})
            and BUDGET in s.get("capture_by_lowconf", {})]
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5d_per_session.csv")

    wins = int((df.by_residual_pct > df.by_confidence_pct).sum())
    hi = max(df.by_residual_pct.max(), df.by_confidence_pct.max()) * 1.12

    fig, ax = panel("half", "std")
    ax.plot([0, hi], [0, hi], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)
    ax.text(hi * 0.66, hi * 0.58, "equal", color=GREY, fontsize=6.5, rotation=38)
    ax.plot(df.by_confidence_pct, df.by_residual_pct, "o", color=SALMON, ms=3.5,
            alpha=0.85, zorder=3)

    ax.set_xlabel("found by confidence (%)")
    ax.set_ylabel("found by residual (%)")
    ax.set_xlim(0, hi)
    ax.set_ylim(0, hi)
    # LOWER RIGHT, which is the one corner that cannot collide: the residual wins
    # in every session, so there is no point below the diagonal. In the upper left
    # the block sat on the highest-scoring session's marker.
    ax.text(0.98, 0.04, f"n = {len(df)}\nresidual wins in {wins}/{len(df)}",
            transform=ax.transAxes, ha="right", va="bottom", color=INK,
            fontsize=6.5, fontweight="bold")
    save(fig, 5, "d", "per_session")


if __name__ == "__main__":
    main()
