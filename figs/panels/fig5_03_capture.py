#!/usr/bin/env python3
"""
Fig 5c -- how much real correction a bounded review budget finds.

THE X AXIS IS REVIEW BUDGET, not difficulty. An earlier version of this panel
plotted capture against session difficulty, which answers a different (and much less
useful) question: the reader wants to know what they get for reviewing 10% of
keypoints, and that is what the deposited curves measure.

THE CIRCULARITY THIS PANEL AVOIDS, stated up front because it is the whole design.
Ranking keypoints by reprojection error and then reporting captured REPROJECTION
error would be circular -- ranking and payload would be the same quantity. So the
payload is the REAL correction distance (how far the raw detection sits from the
proofread answer, which requires the answer), while the ranking uses only the
cross-view residual (which does not).

Four orderings:
  * cross-view residual -- what LUC3D can compute at review time, no answer key;
  * detector confidence -- the obvious alternative, also available at review time;
  * oracle             -- ranks by the answer itself, so it is the CEILING, not a
                          method anyone could run;
  * random             -- the diagonal: reviewing x% at random finds x%.

At a 10% budget the residual finds ~27% of the correction against the oracle's ~32%
and confidence's ~12%, i.e. most of the achievable gain from a signal that needs no
ground truth.

ALL FOUR VALUES AT THE 10% RULE ARE PRINTED, random included. Random's 10 is what makes
the comparison land: reviewing 10% at random finds 10%, so detector confidence's 12 is
barely better than not ranking at all, while the residual's 27 is 2.7x random and 85%
of the oracle's 32. With the 10 left off the page the reader has to derive the baseline
from the diagonal before the confidence curve's weakness is visible -- and the legacy
panel printed it.

MIND THE KEY NAME. `fig6_detections.json` is read by BOTH Fig 5 and Fig 6, so its
schema is additive-only; a mismatch in exactly this file (`capture_oracle` vs
`capture_by_oracle`) silently dropped this panel's oracle series once already.

Source: figs/out/fig6_detections.json `sessions[].capture_by_*`.

    python3 figs/panels/fig5_03_capture.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, footnote, GREY, INK, PERIWINKLE, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, text_legend, use)

SERIES = [("capture_by_reproj", "cross-view residual", TEAL),
          ("capture_by_lowconf", "detector confidence", PERIWINKLE),
          ("capture_by_oracle", "oracle (ceiling)", SALMON)]
MARK = "0.1"

#: Where each series' value-at-MARK label goes, as (dx, dy) in points plus the
#: vertical anchor. Hand-set per series and NOT symmetric on purpose: the three
#: curves pass within ~5 percentage points of each other at the 10% budget, so a
#: single offset rule puts at least one label on a neighbouring curve. Residual
#: labels DOWN into the gap above the confidence curve; the other two label UP.
LABEL_OFF = {"capture_by_reproj": (5, -4, "top"),
             "capture_by_lowconf": (5, 5, "bottom"),
             "capture_by_oracle": (5, 6, "bottom")}


def main():
    use()
    sess = load("fig6_detections.json")["sessions"]
    have = [s for s in sess if all(k in s for k, _, _ in SERIES)]
    if not have:
        sys.exit("fig6_detections.json has no capture_by_* curves — the schema moved.")

    budgets = sorted(have[0][SERIES[0][0]], key=float)
    rows = []
    for key, label, _ in SERIES:
        for b in budgets:
            vals = [s[key][b] for s in have if b in s[key]]
            rows.append({"ranking": label, "budget_pct": float(b) * 100,
                         "captured_pct": float(np.mean(vals)) * 100,
                         "n_sessions": len(vals)})
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5c_capture.csv")

    fig, ax = panel("half", "std", key=3)
    xs = [float(b) * 100 for b in budgets]
    ax.plot([0, max(xs)], [0, max(xs)], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)),
            zorder=1)
    # BELOW the diagonal and unrotated. Set along the line it names it printed on
    # top of it, and a rotated span's bounding box is far taller than the glyphs,
    # so nudging it while keeping the rotation does not clear the stroke. Nothing
    # else is ever drawn under the diagonal here -- every ranking beats random.
    ax.text(max(xs) * 0.995, max(xs) * 0.60, "random", color=MUTED, fontsize=6.5,
            ha="right", va="top")

    for key, label, color in SERIES:
        g = df[df.ranking == label].sort_values("budget_pct")
        ax.plot(g.budget_pct, g.captured_pct, color=color, lw=2.0,
                ls=(0, (2.5, 1.5)) if "oracle" in label else "-", zorder=3)
        ax.plot(g.budget_pct, g.captured_pct, "o", color=color, ms=4, mec="white",
                mew=0.8, zorder=4)
        v = g.loc[g.budget_pct == float(MARK) * 100, "captured_pct"].iloc[0]
        dx, dy, va = LABEL_OFF[key]
        ax.annotate(f"{v:.0f}", (float(MARK) * 100, v), textcoords="offset points",
                    xytext=(dx, dy), color=color, fontsize=6.5, fontweight="bold",
                    ha="left", va=va)

    # THE RANDOM BASELINE'S VALUE, in the same style as the three series'. Random has
    # no deposited curve -- it IS the diagonal, y = x -- so the number comes from the
    # budget itself rather than from `df`. Placed BELOW-right of (10, 10): the diagonal
    # rises to the right, so a label anchored va="top" 5 pt under the point clears both
    # the dashed rule and the confidence curve above it, and the four values then read
    # top-to-bottom 32 / 27 / 12 / 10 in curve order.
    ax.annotate(f"{float(MARK) * 100:.0f}",
                (float(MARK) * 100, float(MARK) * 100), textcoords="offset points",
                xytext=(5, -5), color=MUTED, fontsize=6.5, fontweight="bold",
                ha="left", va="top")
    ax.axvline(float(MARK) * 100, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.annotate("10% budget", (float(MARK) * 100, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=MUTED, fontsize=6.5,
                ha="center", va="bottom")
    text_legend(ax, [(lab, c) for _, lab, c in SERIES], "above")
    ax.set_xlabel("keypoints reviewed, worst first (%)")
    ax.set_ylabel("correction found (%)")
    ax.set_xlim(0, max(xs))
    ax.set_ylim(0, None)
    footnote(ax, f"mean over {len(have)} SLAP-2M sessions")
    save(fig, 5, "c", "capture")


if __name__ == "__main__":
    main()
