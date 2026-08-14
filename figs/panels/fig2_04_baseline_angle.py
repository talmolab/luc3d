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

THE 8-OF-10 IS DESCRIPTIVE AND THE ARTWORK NOW SAYS SO. `k` is median(err*sin theta)
over these same ten pairs, so the +/-25% band is fitted AND scored on one set of
points: roughly half of them sit near the curve by construction, and +/-25% is a wide
target against a 2.7-12.6 mm range. Set in TEAL under a `k =` line it read as a test
the law had passed. There is no test available here -- there are ten pairs and all ten
went into `k`, so this design has no held-out pair to score against, and inventing one
by refitting on eight would be worse than saying nothing. So the count is now led by
"in-sample band:" and set in MUTED, one step back from `k` itself, and what the panel
puts forward instead is the two MISSES: they are named on the data, in the reader's
line of sight, because "which two pairs disagree with the law, and why" is the
informative content and "8 of 10 agree" is not.

The two EXTREMES carry their value (12.6, 2.7) because the panel's second finding is
a RANGE -- 4.7x, free at annotation time -- and a range cannot be read off a scatter
to one decimal. The curve carries its own name, `k / sin theta`, so the dashed line
and its band are attributable without the caption.

THIS IS NOT AN ARGUMENT FOR A WIDER RIG. No camera was ever moved; all ten points
come from one fixed 5-camera geometry, the pairs share cameras and one calibration,
and the observed range is only 13-31 deg. The extrapolation belongs in the
Discussion, not on the artwork.

TEN POINTS ARE NOT TEN OBSERVATIONS -- every pair carries the same n = 1,277,424
keypoints, the same five cameras and one calibration, solved ten ways, so the
effective n is well under ten. That disclosure lives in the FIGURE FOOTER
(`assemble.py FOOTERS[2]`: "12,774,240 two-anchor solves in d", against the same
footer's "1,277,424 keypoints" -- the 10x reuse is the quotient), which is exactly
where the legacy figure carried it. It is deliberately NOT repeated here: a caveat
printed twice on one page reads as two different caveats.

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

    ax.axhline(floor, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)))
    # DECLUTTERED 2026-08-13 (review: "get rid of a lot of the writing on there").
    # The panel's finding is that a WIDER anchor pair gives a lower error, and it was
    # being read through five separate blocks of prose. What stays is what a mark
    # cannot say for itself: the floor's value, the law's name, the two pairs the law
    # misses, and the two extremes. What went: the "comparison floor" gloss (it is the
    # dotted line at the bottom and the legend defines it), and the in-sample-band
    # count, which was three lines explaining that a band fitted on ten points
    # contains eight of them -- a statement about the fit, not about the geometry, and
    # it belongs in the legend where it now lives.
    # LEFT END, not right. Shortening this label (see above) narrowed its box, which
    # moved it into the stretch where the k/sin-theta band has come down to meet the
    # floor -- lint: ON DATA, 9% inked, and 32% when nudged upward. At the LEFT end
    # the law is at its steepest (k/sin 10 deg ~ 8.8 mm), so the strip just above the
    # floor is empty for the whole first third of the axis.
    # GREY, not periwinkle: this rule is a BOUND, and periwinkle is SLEAP's reserved
    # hue set-wide -- a Fig 7 reader returning here read a SLEAP series into a panel
    # SLEAP is not in (review 2026-08-14).
    ax.text(th[0], floor + 0.25, f"all 5 views {floor:.1f}",
            color=MUTED, fontsize=7, ha="left", va="bottom")

    # The curve is named ON the curve, in its own colour, just above the band's upper
    # edge in the one stretch (theta ~ 25-33 deg) where neither a point nor the corner
    # block is. Without it the dashed line and its band are unattributed on the
    # artwork and a reader has to reach the caption to find out what is being fitted.
    ax.text(25.4, k / math.sin(math.radians(25.4)) * (1 + BAND) + 0.35, "k / sin θ",
            color=TEAL, fontsize=7, ha="left", va="bottom")

    ax.plot(df.baseline_deg, df.err3d_mm, "o", color=TEAL, ms=6, mec="white",
            mew=1.0, zorder=4)
    # Name only the two the robust law misses -- they are the informative ones.
    # `cam 1+2`, not the raw key `1-2`: these are camera PAIRS, and a hyphen between
    # two numbers reads as a range or a minus sign. The CSV keeps the raw key.
    for _, r in df[~df.within_band].iterrows():
        ax.annotate(f"cam {r.pair.replace('-', '+')}",
                    (r.baseline_deg, r.err3d_mm), fontsize=7, color=MUTED,
                    textcoords="offset points", xytext=(6, 2))

    # The two EXTREMES carry their value, because the panel's second finding is a
    # RANGE -- 12.6 mm down to 2.7 mm, 4.7x, free at annotation time -- and a range
    # cannot be read off a scatter to one decimal. Legacy printed exactly these two
    # numbers and they were lost in the restyle. Placed on the sides of each marker
    # that are empty: below the worst pair, which already carries its name above, and
    # up and to the RIGHT of the best. Neither centred-above nor right-of works for
    # the best pair: centred above, the 30.3 deg pair is close enough that the label
    # read as belonging to THAT marker, and level with it the label ran into the
    # comparison-floor line's own label. Up-and-right clears both, and the 6 pt rise
    # is the smallest that also clears the band FILL -- at 3 pt `lint_text.py`'s
    # on-data check reports the label 25% inked.
    worst, best = df.iloc[0], df.iloc[-1]
    for r, xy, ha, va in ((worst, (0, -7), "center", "top"),
                          (best, (5, 6), "left", "bottom")):
        ax.annotate(f"{r.err3d_mm:.1f}", (r.baseline_deg, r.err3d_mm), fontsize=7,
                    color=MUTED, ha=ha, va=va, textcoords="offset points",
                    xytext=xy)

    # `k` STAYS, the band count GOES. k is the one number that makes the dashed curve
    # reproducible from the panel alone. The 8/10 was a statement about a band fitted
    # and scored on the same ten pairs -- descriptive, not a test, and it needed two
    # lines of hedging to say so honestly. Both the count and the hedge are now in the
    # legend, which is where a claim that needs a paragraph belongs.
    ax.text(0.97, 0.97, f"k = {k:.2f} mm", transform=ax.transAxes, ha="right",
            va="top", color=TEAL, fontsize=7)

    ax.set_xlabel("anchor-pair angle at the animal (°)")
    ax.set_ylabel("3D error vs proofread (mm)")
    ax.set_ylim(0, df.err3d_mm.max() * 1.15)
    save(fig, 2, "d", "baseline_angle")


if __name__ == "__main__":
    main()
