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
(figs/README.md, "the Fig 2c '3D error' floor").

THE BOX IS THE SESSIONS, WHICH IS NOT WHAT IT USED TO BE, and the change is the
point rather than a side effect (Eric, 2026-08-18: "2c should be a box and
whisker"). Until now the panel drew `ax.bxp` with `whislo = q1` and `whishi = q3`
and the whisker/cap strokes at `lw=0` -- a box with its whiskers deliberately
suppressed, because the only spread the deposit carries for the hinges is
`err3d_mm_across_sessions`, whose p25/p75 are the ACROSS-SESSION MEDIAN OF EACH
SESSION'S OWN p25/p75 over keypoints (`fig4_by_views.mjs:105-110`). That is a
typical session's KEYPOINT spread, so at k = 2 the box spanned 2.57-8.68 mm while
the 50 dots beside it -- session medians -- spanned only 3.65-6.95 mm. A box drawn
around a dot cloud is read as that cloud's summary, and it was not one: the hinges
and the dots were different distributions, and no whisker could be added to the old
box without a per-session p5/p95 the deposit does not have (per-session `by_k`
carries n/mean/p25/p50/p75 and nothing else -- extending it means re-running the
170 M-keypoint pass).

So the box is now the DISTRIBUTION OF THE 50 SESSION MEDIANS: median, IQR, whiskers
to 1.5x IQR, `showfliers=False` because every session is already a dot (10e's rule).
Box and dots are one population, the whiskers mean what whiskers mean, and the
session is the unit of replication the rest of the set uses. What leaves the artwork
is the typical within-session keypoint spread; it stays in the deposited CSV, in the
`agg_*` columns, beside the session-level statistics the box now draws. The drawn
median is asserted equal to the deposit's own p50 at build time -- both are the
median of the same 50 per-session medians, so a mismatch would mean the dots are not
the population the deposit summarises.

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
import numpy as np  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
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
    for i, k in enumerate(ks):
        g = agg[k]["dlt"]
        # Dots read the SAME field family as the boxes -- per_field pairs with agg
        # above, asserted by name rather than trusted, after the mm/px mix-up this
        # panel has already had once.
        vals = np.array([s_[per_field][k]["dlt"]["p50"] for s_ in per
                         if k in s_.get(per_field, {})])
        # THE SAME 50 NUMBERS DRAW THE BOX AND THE DOTS -- see the docstring. The
        # deposit's p50 is the median of these very values, computed on the other
        # side of the pipeline (JS `med`), so equality is a real cross-check on the
        # join and not a tautology; a drift means the dots are a different field.
        if abs(np.median(vals) - g["p50"]) > 1e-9 * max(1.0, abs(g["p50"])):
            sys.exit(f"fig2c: k={k} box median {np.median(vals):.9f} != deposit p50 "
                     f"{g['p50']:.9f} -- the dots and the aggregate are not the "
                     f"same population; do not draw a box around them")
        q1, q3 = np.percentile(vals, [25, 75])
        ax.boxplot([vals], positions=[i], widths=0.42, whis=1.5, showfliers=False,
                   manage_ticks=False, patch_artist=True, zorder=2,
                   # Fill as RGBA, not `alpha=`: the patch-level alpha fades the
                   # edge with it, and the box's edge is what gives it its shape
                   # against a 2.2 pt dot cloud.
                   boxprops=dict(edgecolor=INK, lw=0.9,
                                 facecolor=to_rgba(TEAL, 0.18)),
                   medianprops=dict(color=TEAL, lw=1.6),
                   whiskerprops=dict(color=INK, lw=0.9),
                   capprops=dict(color=INK, lw=0.9))
        jit = ((np.arange(len(vals)) * 0.6180339887) % 1.0 - 0.5) * 0.30
        ax.plot(i + jit, vals, "o", color=TEAL, ms=2.2, alpha=0.40, mec="none",
                zorder=3)
        lo = vals[vals >= q1 - 1.5 * (q3 - q1)].min()
        hi = vals[vals <= q3 + 1.5 * (q3 - q1)].max()
        # BOTH FAMILIES DEPOSITED. `sess_*` is what the box draws (the session
        # medians); `agg_*` is the across-session median of each session's own
        # keypoint quartiles, which the box used to draw and the caption's
        # within-session spread still comes from. Dropping it here would delete the
        # only record of that spread.
        rows.append({"cameras_in_solve": int(k),
                     "sess_p25": float(q1), "sess_p50": float(np.median(vals)),
                     "sess_p75": float(q3), "sess_whisker_lo": float(lo),
                     "sess_whisker_hi": float(hi), "sess_min": float(vals.min()),
                     "sess_max": float(vals.max()), "n_sessions_drawn": len(vals),
                     "agg_p25": g["p25"], "agg_p50": g["p50"], "agg_p75": g["p75"],
                     "n_keypoint_solves": g["n_values"],
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
        # 8, not 10. The 10 was headroom for the OLD box, whose k = 2 upper hinge was
        # a typical session's keypoint p75 at 8.68 mm; the session-level box and its
        # whiskers top out at 5.47 with one dot at 6.95, so 10 left a third of the
        # axis empty and shrank every difference the panel is about.
        ax.set_ylim(0, 8)
    ax.set_xlim(-0.55, len(ks) - 0.45)
    save(fig, 2, "c", "reprojection_accuracy" if not heldout
         else "reprojection_heldout")


if __name__ == "__main__":
    if "--cdf" in sys.argv:
        main_cdf()
    else:
        main(heldout="--heldout" in sys.argv)
