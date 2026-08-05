#!/usr/bin/env python3
"""
Fig 2b -- manual placements per animal per frame, against rig size.

What the reprojection-aided protocol actually changes: a labeller places two anchor
views by hand and then only CORRECTS the reprojections that land outside tolerance.
Traditional labelling is C x N placements; the protocol is 2 x N plus the measured
correction rate on the remaining C - 2 views.

The correction rate p is MEASURED, not assumed: it is 1 - (fraction of held-out
reprojections landing within tau px of that view's own detection), taken from the
data-anchored curve rather than from the comparison against the reference 3D, which
would flatter a two-anchor solve.

The shaded band marks C <= 5, the rig sizes p was measured on. Beyond that the two
curves are a MODEL, and the panel says so -- an earlier draft drew markers out to
C = 8 and read as eight measured rig sizes when only C <= 5 exists in the data.
The ratio is quoted at the measured rig size and nowhere else.

N = 15 is a PER-ANIMAL skeleton, so the ordinate is per animal per frame.

Source: figs/out/fig2.json.

    python3 figs/panels/fig2_02_placements_vs_rig.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (GREY, INK, SALMON, TEAL, annotate_series, deposit,  # noqa: E402
                       panel, save, use)

NODES = 15          # per-animal skeleton
CMAX = 8            # model out to an 8-camera rig
TAU_MAIN = 10.0     # px, the headline tolerance
TAU_STRICT = 5.0


def build():
    ps = load("fig2.json")["per_session"]
    ncam = ps[0]["cameras"]
    acc = {t: median([s["held_out_vs_observation"][f"acc{int(t)}"] for s in ps])
           for t in (TAU_STRICT, TAU_MAIN)}
    p = {t: 1 - a for t, a in acc.items()}

    rows = []
    for c in range(2, CMAX + 1):
        row = {"cameras": c, "traditional": c * NODES, "measured": c <= ncam}
        for t in (TAU_STRICT, TAU_MAIN):
            row[f"aided_tau{int(t)}"] = 2 * NODES + (c - 2) * NODES * p[t]
        rows.append(row)
    return pd.DataFrame(rows), ncam, p


def main():
    use()
    df, ncam, p = build()
    deposit(df, 2, "fig2b_placements_vs_rig.csv")

    fig, ax = panel("third", "std")
    # The measured band, drawn first so the curves sit on top of it.
    ax.axvspan(2, ncam, color=GREY, alpha=0.10, lw=0)
    ax.plot(df.cameras, df.traditional, color=SALMON, lw=2.0)
    ax.plot(df.cameras, df[f"aided_tau{int(TAU_MAIN)}"], color=TEAL, lw=2.0)
    ax.plot(df.cameras, df[f"aided_tau{int(TAU_STRICT)}"], color=TEAL, lw=1.2,
            ls=(0, (2.5, 1.5)))

    m = df[df.measured]
    ax.plot(m.cameras, m.traditional, "o", color=SALMON, ms=5, mec="white", mew=1.0)
    ax.plot(m.cameras, m[f"aided_tau{int(TAU_MAIN)}"], "o", color=TEAL, ms=5,
            mec="white", mew=1.0)

    annotate_series(ax, CMAX, CMAX * NODES - 4, "traditional", SALMON, ha="right",
                    va="top")
    annotate_series(ax, CMAX, 2 * NODES + 10, "reprojection-aided", TEAL,
                    ha="right", va="bottom")
    ax.text(CMAX, df[f"aided_tau{int(TAU_STRICT)}"].iloc[-1] + 2,
            f"τ = {TAU_STRICT:.0f} px", color=TEAL, ha="right", va="bottom",
            fontsize=7)
    ax.text(CMAX, df[f"aided_tau{int(TAU_MAIN)}"].iloc[-1] - 3,
            f"τ = {TAU_MAIN:.0f} px", color=TEAL, ha="right", va="top", fontsize=7)
    ax.text((2 + ncam) / 2, CMAX * NODES * 1.02, f"p measured, C ≤ {ncam}",
            color=GREY, ha="center", va="top", fontsize=7)

    # The ratio, at the measured rig size only.
    aided = df.loc[df.cameras == ncam, f"aided_tau{int(TAU_MAIN)}"].iloc[0]
    trad = ncam * NODES
    ax.annotate("", (ncam - 0.35, trad), (ncam - 0.35, aided),
                arrowprops=dict(arrowstyle="<->", lw=0.8, color=INK))
    ax.text(ncam - 0.5, (trad + aided) / 2, f"{trad / aided:.1f}×", ha="right",
            va="center", fontweight="bold", color=INK)

    ax.set_xticks([2, 4, 6, 8])
    ax.set_xlabel("cameras in the rig, C")
    ax.set_ylabel("manual placements\nper animal per frame")
    ax.set_xlim(2, CMAX)
    ax.set_ylim(0, CMAX * NODES * 1.10)
    save(fig, 2, "b", "placements_vs_rig")


if __name__ == "__main__":
    main()
