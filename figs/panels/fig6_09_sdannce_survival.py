#!/usr/bin/env python3
"""
Fig 6g -- cross-view IDF1 on the social-DANNCE rat datasets, as a survival curve.

The tracker gets only the deposit's 3D poses reprojected into the six views,
with instance order shuffled in every frame and every view, so identity has to
be rebuilt from geometry. One step per session, % of sessions at or above each
IDF1, one curve per dataset. Same form as panel b so the two read alike.

At sigma = 0 on the full rig, 36 of 41 sessions have no identity switch. The
five that do each hold one swap event at a near-coincident approach of the
source 3D tracks (see panel i and `results/agg/swapdiag/`).

Source: figs/fig10-bench/results/agg/summary.csv, cell C1_sigma0.

    python3 figs/panels/fig6_09_sdannce_survival.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (DATASET_COLORS, INK, SPAN, deposit, footnote,  # noqa: E402
                       panel, save, use)
from fig6_08_sdannce_common import (DATASETS, FULL_RIG, PERFECT,  # noqa: E402
                                    cell)

#: matches panel f, which shares the row
ROW_H = 55.0
XMIN = 0.6
#: mm kept clear right of the axes, for the 1.0 tick label and end markers
RIGHT_PAD = 4.0
FIGS_DIR = Path(__file__).resolve().parent.parent


def main():
    use()
    rows = cell(FULL_RIG)
    fig, ax = panel("third", ROW_H)
    # SAME AXES AS PANEL f's SUB-PLOTS (Eric, 2026-10-03). f writes its axes
    # geometry when it saves; g copies the width, height and baseline, and is
    # right-aligned in its slot so the y label has room on the left.
    import json
    geo = json.loads((FIGS_DIR / "figures" / "fig6" / "fig6f_axes.json").read_text())
    _x, y0, aw, ah = geo["axes_mm"][0]
    if abs(geo["fig_mm"][1] - ROW_H) > 0.01:
        raise SystemExit("fig6g ROW_H must equal panel f's height "
                         f"({geo['fig_mm'][1]} mm); re-run fig6_07 first")
    W = SPAN["third"]
    fig.set_layout_engine("none")
    x0 = W - aw - RIGHT_PAD
    ax.set_position([x0 / W, y0 / ROW_H, aw / W, ah / ROW_H])
    out = []
    series = [(d, [r["idf1"] for r in rows if r["dataset"] == d],
               DATASET_COLORS[d], 1.6) for d in DATASETS]
    series.append(("all", [r["idf1"] for r in rows], INK, 1.4))
    for name, vals, color, lw in series:
        v = np.asarray(vals)
        # % of sessions AT OR ABOVE each distinct score. Evaluated at the unique
        # values rather than one step per sorted session, so the curve ends at
        # IDF1 = 1.0 on the share of perfect sessions instead of falling to 0.
        v = np.sort(v)
        uniq = np.unique(v)
        surv = np.array([100.0 * (v >= t).sum() / len(v) for t in uniq])
        x = np.concatenate([[XMIN], uniq])
        y = np.concatenate([[100.0], surv])
        # "pre": % at or above a threshold t in (u[i-1], u[i]] is the share at
        # or above u[i], so each level belongs to the interval ENDING at its value
        ax.step(x, y, where="pre", color=color, lw=lw,
                ls=(0, (2.5, 1.5)) if name == "all" else "-",
                zorder=4 if name == "all" else 3)
        # the level at IDF1 = 1.0 is the share of perfect sessions, the number
        # the panel is about, so it gets a marker on the right edge
        ax.plot([1.0], [surv[-1]], "o", color=color, ms=4, mec="white", mew=0.6,
                clip_on=False, zorder=5)
        out += [{"dataset": name, "idf1": float(a), "survival_pct": float(b)}
                for a, b in zip(uniq, surv)]
    deposit(pd.DataFrame(out), 6, "fig6g_sdannce_survival.csv")

    ax.set_xlim(XMIN, 1.0)
    # 0-100, the same as panel f's survival curve beside it (Eric, 2026-10-03).
    # A 50-100 axis doubled every drop and made the curves look choppy.
    ax.set_ylim(0, 102)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("cross-view IDF1")
    ax.set_ylabel("% of sessions\nat or above")
    # counts are sessions with ZERO identity switches, the number the text
    # uses. IDF1 >= 0.9999 would also count SCN2A M3_M2, whose one swap
    # reverted after a frame (IDF1 0.999991).
    switches = {d: [r["switches"] for r in rows if r["dataset"] == d]
                for d in DATASETS}
    switches["all"] = [r["switches"] for r in rows]
    for i, (name, vals, color, _) in enumerate(series):
        sw = switches[name]
        ax.text(0.04, 0.36 - i * 0.09,
                f"{name}  {sum(z == 0 for z in sw)}/{len(sw)}",
                transform=ax.transAxes, color=color, fontsize=6.5,
                fontweight="bold", ha="left")
    perfect = sum(r["idf1"] >= PERFECT for r in rows)
    zero = sum(r["switches"] == 0 for r in rows)
    footnote(ax, f"{perfect}/41 sessions at IDF1 >= {PERFECT}; "
                 f"{zero}/41 with zero switches; counts are zero-switch sessions")
    save(fig, 6, "g", "sdannce_survival")


if __name__ == "__main__":
    main()
