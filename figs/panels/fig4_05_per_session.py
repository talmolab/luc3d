#!/usr/bin/env python3
"""
Fig 4e -- reprojection error per session, both solvers, paired.

One dot per session per solver, joined, so the comparison is visibly PAIRED: these
are 50 correlated recordings, not 50 independent draws, which is exactly why a bar
chart of two pooled medians would overstate the result.

THE LEFT GROUP IS ENFORCED, NOT OBSERVED, and is labelled so on the artwork. The
refinement's phase 2 minimises the reported error itself and a backtracking guard
vetoes any step that raises it, so "refined lower in 50/50" on the cameras the
solver used cannot come out any other way. It is shown only to size the in-sample
effect beside the held-out group, which either solver can lose -- and does: refined
is lower in 34/50 there.

The rules are the median OF THE SESSION DOTS, not the median pooled over all 4.2 M
keypoints. A rule drawn through a dot cloud must be that cloud's median, and the
session is the independent unit.

Source: figs/out/fig4.json `per_session[].{reproj_p50,heldout_p50}`.

    python3 figs/panels/fig4_05_per_session.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (GREY, PERIWINKLE, TEAL, deposit, panel, save,  # noqa: E402
                       text_legend, use)

DLT_C, REF_C = PERIWINKLE, TEAL
GROUPS = [("reproj_p50", "cameras it used", "(enforced)"),
          ("heldout_p50", "a camera it never saw", None)]


def build() -> pd.DataFrame:
    rows = []
    for s in load("fig4.json")["per_session"]:
        for key, label, _ in GROUPS:
            v = s.get(key) or {}
            if v.get("dlt") is None or v.get("ba") is None:
                continue
            rows.append({"session": s["session"], "group": key, "label": label,
                         "dlt": v["dlt"], "refined": v["ba"]})
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4e_per_session.csv")

    fig, ax = panel("half", "std")
    centres = {}
    for gi, (key, label, note) in enumerate(GROUPS):
        g = df[df.group == key]
        xd, xb = gi * 1.4 - 0.22, gi * 1.4 + 0.22
        centres[key] = (gi * 1.4, label, note, g)
        for _, r in g.iterrows():
            ax.plot([xd, xb], [r.dlt, r.refined], color="#DDDDDD", lw=0.5, zorder=1)
        ax.plot(np.full(len(g), xd), g.dlt, "o", color=DLT_C, ms=3, zorder=2)
        ax.plot(np.full(len(g), xb), g.refined, "o", color=REF_C, ms=3, zorder=2)
        for x, vals, color in ((xd, g.dlt, DLT_C), (xb, g.refined, REF_C)):
            ax.plot([x - 0.17, x + 0.17], [median(vals)] * 2, color=color, lw=2.2,
                    zorder=3, solid_capstyle="butt")

    lo, hi = df[["dlt", "refined"]].min().min(), df[["dlt", "refined"]].max().max()
    ax.set_ylim(lo - 0.2, hi + 0.45)
    ax.set_xlim(-0.75, 1.4 + 0.75)
    ax.set_ylabel("reprojection error, median (px)")

    # The win count belongs to its group, so it goes INTO the tick label on a second
    # line. As a free-floating text it landed on the tick labels themselves.
    ticks, labels = [], []
    for centre, label, note, g in centres.values():
        md, mb = median(g.dlt), median(g.refined)
        # The two medians go above the cloud, not beside their own rules: the dots
        # span the full data range at each x and would overprint a label at the rule.
        ax.text(centre, hi + 0.30, f"{md:.2f} → {mb:.2f}", ha="center", va="top",
                fontweight="bold", color=GREY)
        wins = int((g.refined < g.dlt).sum())
        ticks.append(centre)
        labels.append(f"{label}\nrefined lower in {wins}/{len(g)}"
                      + (f"\n{note}" if note else ""))
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels)

    text_legend(ax, [("DLT", DLT_C), ("refined", REF_C)], "above right")
    save(fig, 4, "e", "per_session")


if __name__ == "__main__":
    main()
