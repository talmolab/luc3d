#!/usr/bin/env python3
"""
Fig 2c -- 3D error against the number of cameras in the solve, ALL FIVE included.

REBUILT TWICE ON REVIEW. First (2026-08-14) from a CDF to a by-cameras box plot of
HELD-OUT reprojection error -- which only exists for k <= 4, because one camera must
stay out of the solve to judge it. Eric: "what do you mean 1 held out as judge? just
give me the error by number of cameras and include all cameras." So the panel now
plots the quantity that exists for the WHOLE rig: the 3D distance between the k-view
solve and the proofread reference, k = 2..5. Medians 4.74 / 2.89 / 1.91 / 1.19 mm --
the same story (big gains early, diminishing later), now in a physical unit (the
px->physical request of review item X.2), ending at the all-view solve instead of an
explanation of why it cannot be drawn.

WHAT THE NUMBER IS AND IS NOT. It is measured against the corpus's proofread 3D,
which carries its own error (median reprojection 2.40 px) -- so these are COMPARISON
values, not absolute 3D accuracy; the spacing is real, the absolute level includes
the reference's own noise. Same caveat Fig 2d carries for the same reference
(figs/README.md, "the Fig 2c '3D error' floor"). Box = across-session median of
per-session p25/p50/p75; dots = each session's own median of the SAME field
(per_session[].by_k -- the field is verified against the box source at build time).

The held-out px version renders under `--heldout` (k <= 4, slug
`reprojection_heldout`) -- it remains the out-of-sample form Fig 4b builds on. The
retired CDF renders under `--cdf`.

Source: figs/out/fig4_by_views.json `err3d_mm_across_sessions`, `per_session[].by_k`.

    python3 figs/panels/fig2_03_reprojection_accuracy.py            # mm, k = 2..5
    python3 figs/panels/fig2_03_reprojection_accuracy.py --heldout  # px, k = 2..4
    python3 figs/panels/fig2_03_reprojection_accuracy.py --cdf      # the retired CDF
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (INK, SALMON, TEAL, deposit, panel, save,  # noqa: E402
                       text_legend, use)

TAU_MAIN = 10.0
QUANTILES = [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p90", 90),
             ("p95", 95), ("p99", 99)]
TOLERANCES = [2.0, 5.0, 10.0, 20.0, 40.0]


def _curve(ps, key) -> pd.DataFrame:
    """One CDF, assembled from the deposited percentiles AND accuracy-at-tolerance.

    The measurement pass summarised 38 M held-out views; only these order statistics
    survive into the JSON, so the curve is the union of the two families of points
    rather than an ECDF over raw samples.
    """
    agg = {}
    for q, _ in QUANTILES:
        agg[q] = median([s[key][q] for s in ps if s[key].get(q) is not None])
    for t in TOLERANCES:
        k = f"acc{int(t)}"
        vals = [s[key][k] for s in ps if s[key].get(k) is not None]
        if vals:
            agg[k] = median(vals)

    pts = [(0.0, 0.0)]
    pts += [(agg[q], v) for q, v in QUANTILES if q in agg]
    pts += [(t, agg[f"acc{int(t)}"] * 100) for t in TOLERANCES
            if f"acc{int(t)}" in agg]
    pts = sorted(set(pts))
    return pd.DataFrame(pts, columns=["error_px", "cumulative_pct"]), agg


def main_cdf():
    use()
    ps = load("fig2.json")["per_session"]
    obs, obs_agg = _curve(ps, "held_out_vs_observation")
    ref, _ = _curve(ps, "held_out")
    obs["reference"] = "held-out view's own detection"
    ref["reference"] = "fully-informed reference 3D"
    deposit(pd.concat([obs, ref]), 2, "fig2c_reprojection_accuracy.csv")

    # THREE key slots for TWO entries. `text_legend`'s "above" stack is spaced at
    # 0.052 of the figure height = 7.7 pt, which is less than the 8.9 pt an 8 pt
    # glyph box actually occupies: at key=2 the two lines' boxes overlapped each
    # other by ~1 pt and the first one's ascenders came within 0.8 pt of the page
    # edge. The extra slot buys the room to space them properly below.
    fig, ax = panel("third", "std", key=3)
    ax.plot(obs.error_px, obs.cumulative_pct, color=TEAL, lw=2.0, zorder=3)
    ax.plot(ref.error_px, ref.cumulative_pct, color=TEAL, lw=1.2,
            ls=(0, (2.5, 1.5)), zorder=3)
    ax.axvline(TAU_MAIN, color=SALMON, lw=0.8, ls=(0, (2.5, 1.5)), zorder=1)
    # LEFT of the rule: the right-hand side now carries the four-line number stack,
    # and the bottom entry of that stack sat on this label.
    ax.text(TAU_MAIN - 0.6, 8, f"τ = {TAU_MAIN:.0f} px", color=SALMON, fontsize=7,
            ha="right", va="bottom")

    ax.text(11.5, 52, f"median {obs_agg['p50']:.2f} px", color=TEAL, fontsize=7)
    # One decimal, matching the caption. `:.0f` printed 59.898% as "60%", so the
    # artwork and the caption disagreed on the same quantity -- and 60 reads as a
    # round number someone chose rather than a measurement.
    ax.text(11.5, 40, f"{obs_agg['acc5'] * 100:.1f}% ≤ 5 px", color=INK, fontsize=7)
    # The 10 px value is not optional: tau = 10 px is the ONE tolerance this panel
    # draws a rule for, so leaving it unquantified made the axis mark the tolerance
    # the artwork then refused to answer. Salmon, matching the rule it reads off.
    ax.text(11.5, 28, f"{obs_agg['acc10'] * 100:.1f}% ≤ {TAU_MAIN:.0f} px",
            color=SALMON, fontsize=7)
    ax.text(11.5, 16, f"{obs_agg['acc20'] * 100:.2f}% ≤ 20 px", color=INK,
            fontsize=7)

    # Both curves are TEAL and differ only by dash, so the key must say so. Colouring
    # the second entry grey implied a grey curve that does not exist.
    text_legend(ax, [("— vs the view's own detection", TEAL),
                     ("-- vs the reference 3D", TEAL)], "above",
                xy=(0.14, 0.972), dy=0.064, transform=fig.transFigure)
    ax.set_xlim(0, 25.4)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("error in an unlabelled view (px)")
    ax.set_ylabel("cumulative % of keypoints")
    save(fig, 2, "c", "reprojection_cdf")


def main(heldout=False):
    use()
    j = load("fig4_by_views.json")
    agg = j["err3d_mm_across_sessions" if not heldout else "heldout_px_across_sessions"]
    per_field = "by_k" if not heldout else "heldout_px_by_k"
    per = j["per_session"]
    ks = sorted(agg, key=int)

    rows = []
    fig, ax = panel("third", "std")
    import numpy as np
    for i, k in enumerate(ks):
        g = agg[k]["dlt"]
        # Dots read the SAME field family as the boxes -- per_field pairs with agg
        # above, asserted by name rather than trusted, after the mm/px mix-up this
        # panel has already had once.
        vals = np.array([s_[per_field][k]["dlt"]["p50"] for s_ in per
                         if k in s_.get(per_field, {})])
        jit = ((np.arange(len(vals)) * 0.6180339887) % 1.0 - 0.5) * 0.30
        ax.plot(i + jit, vals, "o", color=TEAL, ms=2.2, alpha=0.40, mec="none",
                zorder=2)
        ax.bxp([{"med": g["p50"], "q1": g["p25"], "q3": g["p75"],
                 "whislo": g["p25"], "whishi": g["p75"], "fliers": []}],
               positions=[i], widths=0.42, showfliers=False, manage_ticks=False,
               patch_artist=True,
               boxprops=dict(edgecolor=INK, lw=0.9, facecolor="none"),
               medianprops=dict(color=TEAL, lw=1.6),
               whiskerprops=dict(color=INK, lw=0), capprops=dict(color=INK, lw=0))
        rows.append({"cameras_in_solve": int(k), "p25": g["p25"], "p50": g["p50"],
                     "p75": g["p75"], "n_keypoint_solves": g["n_values"],
                     "n_sessions": g["n_sessions"]})
    deposit(pd.DataFrame(rows), 2,
            "fig2c_error_by_cameras.csv" if not heldout
            else "fig2c_heldout_by_cameras.csv")

    ax.set_xticks(range(len(ks)))
    ax.set_xticklabels(ks)
    if heldout:
        ax.set_xlabel("cameras in the solve, of 5\n(1 held out as judge)")
        ax.set_ylabel("held-out reprojection\nerror (px)")
        ax.set_ylim(0, 8)
    else:
        ax.set_xlabel("cameras in the solve")
        ax.set_ylabel("3D error vs proofread\n(mm)")
        ax.set_ylim(0, 10)
    ax.set_xlim(-0.55, len(ks) - 0.45)
    save(fig, 2, "c", "reprojection_accuracy" if not heldout
         else "reprojection_heldout")


if __name__ == "__main__":
    if "--cdf" in sys.argv:
        main_cdf()
    else:
        main(heldout="--heldout" in sys.argv)
