#!/usr/bin/env python3
"""
Fig 2d -- WHY a two-anchor solve costs anything, and which two views to pick.

The pooled two-anchor error (4.75 mm) averages over all ten camera pairs, but a
labeller CHOOSES a pair. Per pair the error tracks the baseline angle the two
cameras subtend AT THE ANIMAL: the widest pair reaches 2.69 mm, the narrowest
12.59 mm -- a 4.7x difference that is free at annotation time.

THE RANK STATEMENT IS THE STRONG ONE and is what the caption leads with: the widest
pair is the most accurate in 50/50 sessions and the narrowest the least accurate in
50/50 (Spearman -0.88; Pearson r = -0.657).

The dashed curve is the depth-uncertainty law err = k/sin(theta), with k estimated
ROBUSTLY as median(err*sin(theta)) = 1.52 mm. Do not quote k = 1.87 mm with the
8-of-10 count: 1.87 is the plain least-squares fit and it puts only 5 of 10 pairs
inside +/-25%, because least squares is dragged upward by the two outliers it is
supposed to be diagnosing. The robust fit misses exactly the two genuine exceptions
(both pair camera 2, the farthest camera), which is the point of the panel.

THIS IS NOT AN ARGUMENT FOR A WIDER RIG. No camera was ever moved; all ten points
come from one fixed 5-camera geometry, the pairs share cameras and one calibration,
and the observed range is only 13-31 deg. The extrapolation belongs in the
Discussion, not on the artwork.

Source: figs/out/fig2.json `per_session[].err3d_mm_by_pair`.

    python3 figs/panels/fig2_04_baseline_angle.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (MUTED, GREY, PERIWINKLE, TEAL, deposit, panel, save, use)  # noqa: E402

BAND = 0.25


def build():
    ps = load("fig2.json")["per_session"]
    rows = {}
    for s in ps:
        for k, v in (s.get("err3d_mm_by_pair") or {}).items():
            r = rows.setdefault(k, {"baseline": [], "p50": [], "n": 0})
            r["baseline"].append(v["baseline_deg"])
            r["p50"].append(v["p50"])
            r["n"] += v.get("n", 0)
    # Both coordinates are medians ACROSS SESSIONS: the baseline angle moves a little
    # between sessions because the vertex is that session's own mean 3D point, so
    # taking one session's angle would report one session's geometry against a
    # fifty-session median error.
    df = pd.DataFrame([
        {"pair": k, "baseline_deg": median(r["baseline"]),
         "err3d_mm": median(r["p50"]), "n": r["n"]}
        for k, r in rows.items()
    ]).sort_values("baseline_deg").reset_index(drop=True)

    floor = median([s["err3d_mm_by_anchor_count"]["5"]["p50"] for s in ps])
    k = median([e * math.sin(math.radians(b))
                for b, e in zip(df.baseline_deg, df.err3d_mm)])
    df["law_mm"] = k / np.sin(np.radians(df.baseline_deg))
    df["within_band"] = (df.err3d_mm - df.law_mm).abs() / df.law_mm <= BAND
    return df, floor, k


def main():
    use()
    df, floor, k = build()
    deposit(df, 2, "fig2d_baseline_angle.csv")

    fig, ax = panel("third", "std")
    th = np.linspace(df.baseline_deg.min() - 2, df.baseline_deg.max() + 2, 200)
    law = k / np.sin(np.radians(th))
    ax.fill_between(th, law * (1 - BAND), law * (1 + BAND), color=TEAL, alpha=0.16,
                    lw=0)
    ax.plot(th, law, color=TEAL, lw=1.2, ls=(0, (2.5, 1.5)))

    ax.axhline(floor, color=PERIWINKLE, lw=0.8, ls=(0, (1.5, 1.5)))
    ax.text(th[-1], floor + 0.25, f"all 5 views {floor:.1f} — comparison floor",
            color=PERIWINKLE, fontsize=7, ha="right", va="bottom")

    ax.plot(df.baseline_deg, df.err3d_mm, "o", color=TEAL, ms=6, mec="white",
            mew=1.0, zorder=4)
    # Name only the two the robust law misses -- they are the informative ones.
    # `cam 1+2`, not the raw key `1-2`: these are camera PAIRS, and a hyphen between
    # two numbers reads as a range or a minus sign. The CSV keeps the raw key.
    for _, r in df[~df.within_band].iterrows():
        ax.annotate(f"cam {r.pair.replace('-', '+')}",
                    (r.baseline_deg, r.err3d_mm), fontsize=7, color=MUTED,
                    textcoords="offset points", xytext=(6, 2))

    ax.text(0.97, 0.95, f"k = {k:.2f} mm\n{int(df.within_band.sum())}/{len(df)} "
            f"within ±{BAND:.0%}", transform=ax.transAxes, ha="right", va="top",
            color=TEAL, fontsize=7)

    ax.set_xlabel("anchor-pair baseline angle (°)")
    ax.set_ylabel("3D error vs proofread (mm)")
    ax.set_ylim(0, df.err3d_mm.max() * 1.15)
    save(fig, 2, "d", "baseline_angle")


if __name__ == "__main__":
    main()
