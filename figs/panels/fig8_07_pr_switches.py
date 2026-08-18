#!/usr/bin/env python3
"""
Fig 8d -- the shipped tracker against the candidate parameter sets, on ALL 50 Mouse-Dyad-10M
sessions: survival curves for identity precision, identity recall and cross-view IDF1,
plus ID switches per 100,000 camera-frames.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHAT EACH PARAMETER SET IS, spelled out because "stale 10" means nothing on its own:

  shipped                    pose/cross-view-tracker.js exactly as it ships.
  M1 + stale N + distThresh 25   three changes, stacked:
        M1 (`sync`)          score all five views against ONE frame-start 3D snapshot and
                             re-triangulate once at frame end, instead of running a
                             Hungarian per camera and re-triangulating on every match
                             (which lets camera 1's decision move the state camera 2 is
                             then judged against).
        stale N              evict a target's per-camera detection once it is older than
                             N frames, before re-triangulating. The shipped tracker NEVER
                             expires one: `Target.detsByCam` holds one detection per
                             camera indefinitely and `_retriangulate()` fuses all of them,
                             so the 3D pose every association is scored against blends the
                             current pose with wherever each other camera last saw the
                             animal. Measured age: mean 3.0-49.8 frames by session, maxima
                             844-8,652 frames (figs/fig8_diag_anchor_age.py).
        distThresh 25        `distanceThreshold` 50 -> 25, a pure threshold change.
  Only N varies between the candidate rows. Everything else -- detections, cameras,
  sessions, scorer -- is identical across every point on this panel.

WHY SURVIVAL CURVES AND NOT SUMMARY POINTS. The first version of this panel drew one
point per parameter set for precision and recall. That is a bad plot for the same reason
Fig 7c gives in its own docstring: a single summary hides where the trackers actually
separate, and at n = 50 a mean can be carried by a handful of sessions -- which this repo
has been burned by before (see figs/README.md on Fig 4). So the first three sub-panels are
SURVIVAL CURVES in Fig 7c's idiom: the percentage of the 50 sessions scoring at or above
each threshold on the x axis. A vertical distance between two curves at any threshold the
reader picks IS the comparison, and the y axis is a full 0-100%.

  1  IDENTITY PRECISION, survival. Low precision means identities are attached to
     detections that are not that animal.
  2  IDENTITY RECALL, survival. Low recall means the right identity is missing where it
     should be. IDF1 is the harmonic mean of these two, so IDF1 alone cannot say WHICH
     failure a tracker has, and the two have different fixes -- that is the whole reason
     both are drawn.
  3  CROSS-VIEW IDF1, survival. The headline metric, on the same footing as 1 and 2.
  4  WITHIN-VIEW ID SWITCHES PER 100,000 CAMERA-FRAMES.

     ON THIS AXIS: THE NUMBER PLOTTED IS A RATE, and it is annotated as a rate. An earlier
     version plotted the rate but annotated each point with the RAW TOTAL switch count over
     all 50 sessions, so a point sat at 0.92 on the axis and was labelled "413" -- two
     different quantities on one mark. Both are legitimate and both are now shown, labelled
     as what they are ("0.92 per 100k" beside the point, raw totals in the footnote and the
     deposited CSV). The denominator is measured, not assumed: the sum over every camera of
     every session of min(gt_frames, det_frames), i.e. exactly the frames the scorer scores
     -- 45,021,960 camera-frames.

Source: figs/out/fig8_methods_50.json, written by
`$PY figs/fig8_methods.py --all-sessions --configs shipped,sync_stale1_dist25,...`.
Identity precision/recall come from motmetrics `idp`/`idr` via figs/fig3_score.py.

    python3 figs/panels/fig8_07_pr_switches.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, PERIWINKLE, SALMON, TEAL,  # noqa: E402
                       deposit, footnote, grid, save, text_legend, use)

#: (config, label drawn on the panel, colour). Order is the drawing order.
#: The label names every ingredient -- see the docstring for why.
SERIES = [
    ("shipped", "shipped", INK),
    ("sync_stale1_dist25", "M1 + stale 1 + distThresh 25", SALMON),
    ("sync_stale10_dist25", "M1 + stale 10 + distThresh 25", TEAL),
    ("sync_stale20_dist25", "M1 + stale 20 + distThresh 25", PERIWINKLE),
    ("sync_stale30_dist25", "M1 + stale 30 + distThresh 25", GREY),
]


def build(deposit_name="fig8_methods_50.json"):
    d = load(deposit_name)
    cells = {c["config"]: c for c in d["cells"] if c.get("idf1_cross") is not None}
    have = [(c, lab, col) for c, lab, col in SERIES if c in cells]
    if not have:
        sys.exit("fig8d: fig8_methods_50.json has none of the expected configs")
    # A cell scored before figs/fig3_score.py gained idp/idr carries neither, and the
    # left sub-panel is meaningless without them. Say so instead of drawing a blank axis.
    no_pr = [c for c, _l, _k in have
             if cells[c]["per_session"] and cells[c]["per_session"][0].get("cross_idp")
             is None]
    if no_pr:
        sys.exit("fig8d: these cells were scored before identity precision/recall were "
                 f"added and must be RE-SCORED: {no_pr}\n  $PY figs/fig8_methods.py "
                 "--all-sessions --configs " + ",".join(c for c, _l, _k in have))
    missing = [c for c, _l, _k in SERIES if c not in cells]
    cf = d["total_camera_frames"]

    rows = []
    for cfg, lab, col in have:
        c = cells[cfg]
        ps = c["per_session"]
        rows.append({
            "config": cfg, "label": lab,
            "idp_cross": float(np.mean([q["cross_idp"] for q in ps])),
            "idr_cross": float(np.mean([q["cross_idr"] for q in ps])),
            "idf1_cross_mean": float(np.mean([q["cross_idf1"] for q in ps])),
            "idf1_cross_median": float(np.median([q["cross_idf1"] for q in ps])),
            "switches": c["switches"],
            "switches_per_100k": c["switches"] * 1e5 / cf,
            # As a PERCENTAGE of camera-frames, which is what the axis now shows: a
            # switch is an event on one camera-frame, so switches/camera-frames * 100 is
            # the percentage of camera-frames carrying one. Numerically it is the
            # per-100,000 rate divided by 1,000 -- same measurement, different unit.
            "switches_pct": c["switches"] * 100.0 / cf,
            "n_sessions": len(ps),
            "_per_session_idf1": [q["cross_idf1"] for q in ps],
            "_per_session_idp": [q["cross_idp"] for q in ps],
            "_per_session_idr": [q["cross_idr"] for q in ps],
            "_colour": col,
        })
    return pd.DataFrame(rows), cf, d, missing


def main(deposit_name="fig8_methods_50.json"):
    """`deposit_name` exists so the plotting path can be exercised against a synthetic
    deposit without touching the real one -- which the measurement pass is still writing.
    A render that crashes unattended wastes the whole wait, and the guard-rail test only
    proves the guard, not the drawing code."""
    use()
    df, cf, d, missing = build(deposit_name)
    deposit(df.drop(columns=[c for c in df.columns if c.startswith("_")]),
            8, "fig8d_pr_switches.csv")

    fig, axes = grid(1, 4, span="full", row=62.0)
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * len(df) + 0.02)))
    axP, axR, axF, axS = axes

    def survival(ax, key, xlabel, ylabel=None):
        """% of the 50 sessions at or above each threshold -- Fig 7c's idiom exactly.

        WHY THIS AND NOT A PR PLANE. An earlier version put identity precision against
        identity recall as a scatter, one point per session. It was unreadable, and the
        reason is worth stating: a PR *curve* is traced by sweeping an operating threshold,
        which is what SLEAP's model-evaluation notebook does (detection confidence against
        OKS). This is not a detector evaluation -- the detection pool is FIXED and shared
        by every parameter set, has no per-instance confidence to threshold (the same fact
        that made filterMinInstanceScore inert in Fig 8b), and the only sweepable axis,
        IoU, is degenerate here: recall moves 0.016 over IoU 0.05-0.90
        (figs/fig8_pr_curve.py measured it). With no operating axis, IDP and IDR are
        per-session summary statistics, and the honest way to show a summary statistic
        over 50 sessions is its distribution. Drawn the same way as IDF1 so all three read
        identically and can be compared by eye.

        A true ECDF over every session's own value, not an interpolation through chosen
        thresholds.
        """
        for _i, r in df.iterrows():
            v = np.sort(np.asarray(r[key], dtype=float))
            n = len(v)
            xs = np.repeat(v, 2)
            ys = np.empty(2 * n)
            ys[0::2] = 100.0 * (n - np.arange(n)) / n
            ys[1::2] = 100.0 * (n - np.arange(n) - 1) / n
            ax.plot(xs, ys, color=r._colour, lw=1.9 if r.config == "shipped" else 1.2,
                    zorder=4 if r.config == "shipped" else 3)
        ax.axhline(50, color=GREY, lw=0.7, ls=(0, (1.5, 1.5)), zorder=1)
        ax.set_xlabel(xlabel, fontsize=7)
        if ylabel:
            ax.set_ylabel(ylabel, fontsize=7)
        ax.set_xlim(0.3, 1.0)
        ax.set_ylim(0, 100)
        ax.set_yticks([0, 25, 50, 75, 100])
        ax.tick_params(labelsize=6.5)

    survival(axP, "_per_session_idp", "identity precision (cross-view)",
             "% of the 50 sessions at or above")
    survival(axR, "_per_session_idr", "identity recall (cross-view)")
    survival(axF, "_per_session_idf1", "cross-view IDF1")

    # ---- switches: HORIZONTAL, so each label has room -------------------------------
    # Vertical was tried twice and both label placements collided -- above the marker the
    # top one sat on the axis, and two-line labels at adjacent x positions overlapped each
    # other (lint_text.py caught both). Rotating the sub-panel puts the parameter sets on
    # the y axis and gives every label the full width to its right.
    axS.set_xscale("log")
    ypos = np.arange(len(df))[::-1]          # set 1 at the top, matching the key order
    lo = df.switches_pct.min() * 0.6
    for y, (_ix, r) in zip(ypos, df.iterrows()):
        axS.plot([lo, r.switches_pct], [y, y], color=r._colour, lw=1.0, alpha=0.5, zorder=2)
        axS.plot(r.switches_pct, y, "o", color=r._colour, ms=6.0, mec="white", mew=0.9,
                 zorder=4)
        # BOTH units on the label. A bare 0.00092% invites being read as "92 per 100,000";
        # it is 0.92 per 100,000, i.e. 413 switches over the whole corpus, and that
        # misreading actually happened.
        axS.annotate(f"  {r.switches_pct:.5f}%  ({int(r.switches):,})",
                     (r.switches_pct, y), textcoords="offset points", xytext=(6, 0),
                     ha="left", va="center", fontsize=5.8, color=r._colour)
    axS.set_yticks(ypos)
    axS.set_yticklabels([str(i + 1) for i in range(len(df))], fontsize=6.5)
    axS.set_ylim(-0.7, len(df) - 0.3)
    axS.set_ylabel("parameter set (see key)", fontsize=7)
    axS.set_xlabel("% of all camera-frames with an ID switch\n(raw switch total in "
                   "parentheses)", fontsize=7)
    axS.set_xlim(lo, df.switches_pct.max() * 9.0)
    axS.tick_params(axis="x", labelsize=6.5)
    from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter
    axS.xaxis.set_major_locator(LogLocator(base=10.0, subs=(1.0, 3.0), numticks=12))
    axS.xaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}%"))
    axS.xaxis.set_minor_formatter(NullFormatter())

    text_legend(axP, [(f"{i + 1}. {r.label}", r._colour)
                      for i, (_ix, r) in enumerate(df.iterrows())], "above")

    ship = df[df.config == "shipped"]
    best = df.loc[df.switches_pct.idxmin()]
    note = ""
    if len(ship):
        sh = ship.iloc[0]
        note += (f"{best.label}: an ID switch on {best.switches_pct:.5f}% of "
                 f"camera-frames against shipped's {sh.switches_pct:.5f}% "
                 f"({100 * (1 - best.switches_pct / sh.switches_pct):.0f}% lower); "
                 f"median cross-view IDF1 {sh.idf1_cross_median:.4f} -> "
                 f"{best.idf1_cross_median:.4f}\n")
    note += ("RAW switch totals over all 50 sessions (the percentage's numerator; "
             f"denominator {cf:,} camera-frames): "
             + ", ".join(f"{r.label.replace('M1 + ', '').replace(' + distThresh 25', '')} "
                         f"{int(r.switches):,}" for _i, r in df.iterrows()) + "\n")
    note += ("the first three are survival curves in Fig 7c's idiom -- the vertical "
             "distance between two curves at any threshold IS the comparison. No PR curve "
             "is drawn: an operating curve needs a score to sweep, this pool has none, and "
             "the IoU sweep is degenerate (recall moves 0.016 over IoU 0.05-0.90)\n"
             "M1 = score all views against one frame-start 3D snapshot; stale N = evict a "
             "per-camera detection older than N frames before re-triangulating\n"
             f"all {len(d['sessions'])} proofread Mouse-Dyad-10M sessions x 5 cameras, full "
             f"length, {cf:,} camera-frames; sessions PAIRED across parameter sets")
    if missing:
        note += "\nnot yet measured at 50 sessions: " + ", ".join(missing)
    footnote(axP, note)
    save(fig, 8, "d", "pr_switches")


if __name__ == "__main__":
    _dep = "fig8_methods_50.json"
    if "--deposit" in sys.argv:
        _dep = sys.argv[sys.argv.index("--deposit") + 1]
    main(_dep)
