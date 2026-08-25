#!/usr/bin/env python3
"""
Fig 8d -- the no-eviction control against the candidate parameter sets, on ALL 50 Mouse-Dyad-10M
sessions: an identity precision-recall plane (one operating point per parameter set),
the cross-view IDF1 survival curve, and ID switches per 100,000 camera-frames.

    THIS PANEL SHIPS AS THE SWEEP ROW OF FIGURE 11 (fig11_sync.py copies it in at
    full scale; LAYOUTS[8] itself is no longer assembled). It is described in
    FIGURE-LEGENDS.md's Fig. 7 entry -- keep that text in step with this panel.

WHAT EACH PARAMETER SET IS, spelled out because "stale 10" means nothing on its own:

  no eviction                `pose/cross-view-tracker.js` with no staleness eviction --
                             the control this panel's candidates are measured against.
                             LABELLED "no eviction", NOT "shipped" (Eric, 2026-08-20).
                             The deposit's config KEY is still `shipped` and must not be
                             renamed (it is what `fig8_methods.py --all-sessions` wrote),
                             but the word cannot appear on the artwork: the configuration
                             the paper now ships IS the fresh anchor -- corr3d r = 6 with
                             stale 20, this panel's 413-switch / 0.8613 arm (METHODS.md
                             "fresh anchor (shipped)", CAPTIONS.md on Fig 3d) -- so
                             labelling the no-eviction control "shipped" named the one
                             arm that is NOT shipped, and contradicted Methods on the
                             same page. It is also the axis the candidates vary along:
                             "no eviction" reads as the N -> infinity end of stale N,
                             which "shipped" did not.
  M1 + stale N + distThresh 25   three changes, stacked:
        M1 (`sync`)          score all five views against ONE frame-start 3D snapshot and
                             re-triangulate once at frame end, instead of running a
                             Hungarian per camera and re-triangulating on every match
                             (which lets camera 1's decision move the state camera 2 is
                             then judged against).
        stale N              evict a target's per-camera detection once it is older than
                             N frames, before re-triangulating. The control NEVER
                             expires one: `Target.detsByCam` holds one detection per
                             camera indefinitely and `_retriangulate()` fuses all of them,
                             so the 3D pose every association is scored against blends the
                             current pose with wherever each other camera last saw the
                             animal. Measured age: mean 3.0-49.8 frames by session, maxima
                             844-8,652 frames (figs/fig8_diag_anchor_age.py).
        distThresh 25        `distanceThreshold` 50 -> 25, a pure threshold change.
  Only N varies between the candidate rows. Everything else -- detections, cameras,
  sessions, scorer -- is identical across every point on this panel.

THE PRECISION/RECALL PRESENTATION HAS MOVED TWICE, and both moves are worth keeping in
view. Version 1 drew one summary point per parameter set and was replaced by survival
curves (a single summary hides where the trackers separate, and at n = 50 a mean can be
carried by a handful of sessions -- see figs/README.md on Fig 4). Version 2 drew identity
precision and identity recall as two separate survival sub-panels; Eric, 2026-08-25:
"ideally we could combine identity precision and identity recall into one precision
recall curve ... it has to be ID precision and ID recall not the IOU". A THRESHOLD-swept
PR curve still cannot be drawn -- an operating curve needs a score to threshold, this
detection pool has none (the fact that made filterMinInstanceScore inert in Fig 8b), and
the one sweepable axis, IoU, is degenerate (recall moves 0.016 over IoU 0.05-0.90;
figs/fig8_pr_curve.py measured it). Version 3, THE ONE THAT SHIPS: a PR PLANE, one
median +- IQR crosshair per parameter set. Version 4 -- quantile PR curves, each arm's
trace pairing the q-th quantile of recall with the q-th quantile of precision, built
the same day on "cant we make it look similar to the graph next to it" -- was REVERTED
within hours (Eric: "nevermind i like the other precision recall curve better, this
one is very confusing"), and deservedly: in PR space every arm rides ONE shared
session-difficulty path, so the five curves superimposed and the arms differed only in
how far along the path their sessions sat -- a subtle read where the crosshairs are a
direct one. Do not rebuild version 4 without new instruction; the iso-IDF1 contours
version 3 originally carried stay REMOVED ("we dont need the idf1 gradient thing"), as
do the lollipop's raw counts. A per-session scatter (50 x 5 points) was tried on the
way to version 2 and was unreadable.

  1  IDENTITY PRECISION-RECALL PLANE, one median +- IQR operating point per
     parameter set. Low precision means identities attached to detections that are
     not that animal; low recall means the right identity missing where it belongs.
     IDF1 is their harmonic mean, so IDF1 alone cannot say WHICH failure a tracker
     has -- that is what the PR axes separate.
  2  CROSS-VIEW IDF1, survival, Fig 7c's idiom: % of the 50 sessions at or above each
     threshold; the vertical distance between two curves at any threshold the reader
     picks IS the comparison. The headline metric keeps its full distribution.
  3  WITHIN-VIEW ID SWITCHES PER 100,000 CAMERA-FRAMES.

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
#:
#: SHORT LABELS SINCE 2026-08-19 (Eric). They used to name every ingredient, on the
#: reasoning that "stale 10" means nothing on its own. It does not, but four
#: repetitions of "M1 + ... + distThresh 25" spent most of the key restating the two
#: constants every candidate shares, and the same strings had to serve as tick labels
#: on the switch sub-panel where there is no room for them. M1 and distThresh 25 are
#: common to all four candidates, so they belong in the caption; what varies between
#: them, and the only thing the reader has to tell apart, is the staleness horizon.
SERIES = [
    ("shipped", "no eviction", INK),
    ("sync_stale1_dist25", "stale 1", SALMON),
    ("sync_stale10_dist25", "stale 10", TEAL),
    ("sync_stale20_dist25", "stale 20", PERIWINKLE),
    ("sync_stale30_dist25", "stale 30", GREY),
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
    # The PR plane's marks, deposited so the artwork is reproducible from the CSV:
    # across-session median and quartiles per axis, alongside the means build() keeps.
    for key, col in [("_per_session_idp", "idp"), ("_per_session_idr", "idr")]:
        vals = [np.asarray(v, float) for v in df[key]]
        df[f"{col}_median"] = [float(np.median(v)) for v in vals]
        df[f"{col}_q1"] = [float(np.percentile(v, 25)) for v in vals]
        df[f"{col}_q3"] = [float(np.percentile(v, 75)) for v in vals]
    deposit(df.drop(columns=[c for c in df.columns if c.startswith("_")]),
            8, "fig8d_pr_switches.csv")

    fig, axes = grid(1, 3, span="full", row=58.0)
    # The key is a single HORIZONTAL line along the BOTTOM since 2026-08-25 (Eric:
    # "the legend for no eviction stale 1, 10 etc is taking up too much white
    # space, that is prime real estate ... maybe we can put it horizontally at the
    # bottom"). The old vertical stack reserved 28% of the panel's height above
    # the sub-plots and used a fifth of the row's width; one bottom line costs 9%.
    # `rect` is (left, bottom, WIDTH, HEIGHT), NOT (left, bottom, right, top) --
    # the same trap fig1_03_reconstruction.py documents. Written as "top = 0.93"
    # this put the axes band's top at 0.09 + 0.93 = 1.02, off the page, and the
    # survival panel's 100% tick label printed half above the figure edge
    # (lint_text: CLIPPED '100'). Bottom 0.09 is the key strip; height 0.84
    # leaves a real top margin for tick labels and markers ON the axis limit.
    fig.get_layout_engine().set(rect=(0, 0.09, 1, 0.84))
    axP, axF, axS = axes

    # ---- 1: the identity precision-recall plane ---------------------------------
    # One MEDIAN +- IQR operating point per parameter set (see the docstring's
    # version history: the quantile-curve form built on the same day was REVERTED
    # on instruction -- Eric: "nevermind i like the other precision recall curve
    # better, this one is very confusing" -- because every arm rides one shared
    # session-difficulty path in PR space, so the curves overlapped and only their
    # endpoints and medians differed. The two instructions that arrived WITH the
    # curve request still stand and are kept: no iso-IDF1 contours, and no raw
    # switch counts on the lollipop labels.)
    x0 = min(df.idr_q1.min(), df.idr_median.min()) - 0.03
    x1 = max(df.idr_q3.max(), df.idr_median.max()) + 0.03
    y0 = min(df.idp_q1.min(), df.idp_median.min()) - 0.03
    # the candidates' median precision IS 1.0 (the distribution is skewed -- half
    # the sessions are perfect), so the top limit leaves a hair of air or the
    # markers sit clipped ON the axis line
    y1 = min(1.012, max(df.idp_q3.max(), df.idp_median.max()) + 0.03)
    for _i, r in df.iterrows():
        axP.errorbar(r.idr_median, r.idp_median,
                     xerr=[[r.idr_median - r.idr_q1], [r.idr_q3 - r.idr_median]],
                     yerr=[[r.idp_median - r.idp_q1], [r.idp_q3 - r.idp_median]],
                     fmt="o", color=r._colour, ms=4.6, mec="white", mew=0.7,
                     elinewidth=0.9, capsize=1.6, capthick=0.9,
                     zorder=5 if r.config == "shipped" else 4)
    axP.set_xlabel("identity recall (cross-view)", fontsize=7)
    axP.set_ylabel("identity precision (cross-view)", fontsize=7)
    axP.set_xlim(x0, x1)
    axP.set_ylim(y0, y1)
    axP.tick_params(labelsize=6.5)

    def survival(ax, key, xlabel, ylabel=None):
        """% of the 50 sessions at or above each threshold -- Fig 7c's idiom exactly.

        Since 2026-08-25 only cross-view IDF1 is drawn this way: identity precision
        and recall moved into the PR plane (sub-panel 1; the module docstring carries
        the full history, including why the plane holds operating POINTS and not a
        swept curve, and why the per-session scatter version was abandoned).

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
        # 101.5, not 100: at 100 the top tick label's cap height lands exactly on
        # the figure edge and lint_text reports it CLIPPED
        ax.set_ylim(0, 101.5)
        ax.set_yticks([0, 25, 50, 75, 100])
        ax.tick_params(labelsize=6.5)

    # "the sessions", not "the 50 sessions": the n belongs in the caption,
    # and the panel title already carries it (Eric, 2026-08-19).
    survival(axF, "_per_session_idf1", "cross-view IDF1",
             "% of the sessions at or above")

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
        # Percentage only since 2026-08-25 (Eric: "we dont need the counts like
        # (2,071) ... the percentages should be enough"). The raw totals stay in
        # the deposit CSV and in FIGURE-LEGENDS' Fig. 7 F entry, which is where a
        # "92 per 100,000" misreading gets corrected now.
        axS.annotate(f"  {r.switches_pct:.5f}%",
                     (r.switches_pct, y), textcoords="offset points", xytext=(6, 0),
                     ha="left", va="center", fontsize=5.8, color=r._colour)
    # The parameter sets NAME THEMSELVES on this axis now, rather than carrying an
    # index the reader has to carry back to the key. That is only possible because
    # the labels are short (see SERIES); it was numbers 1 to 5 while they were not.
    axS.set_yticks(ypos)
    axS.set_yticklabels(list(df.label), fontsize=6.5)
    axS.set_ylim(-0.7, len(df) - 0.3)
    # WRAPPED AND SHORTENED. The one-line-plus-parenthetical form overflowed this
    # sub-panel's width and lint_text.py reported it as silently dropped; the
    # sub-panel is a quarter of the row, so the label has to fit ~40 mm. What the
    # parenthetical number is now lives in the caption.
    axS.set_xlabel("% of camera-frames\nwith an ID switch", fontsize=7)
    axS.set_xlim(lo, df.switches_pct.max() * 9.0)
    axS.tick_params(axis="x", labelsize=6.5)
    from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter
    axS.xaxis.set_major_locator(LogLocator(base=10.0, subs=(1.0, 3.0), numticks=12))
    axS.xaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}%"))
    axS.xaxis.set_minor_formatter(NullFormatter())

    # No leading index: the switch sub-panel now labels its own rows, so nothing
    # needs to be looked up by number. Laid out width-aware (draw, measure,
    # advance) rather than at guessed anchors, so a renamed parameter set cannot
    # silently overlap its neighbour.
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    kx, fw = 0.005, fig.bbox.width
    for _ix, r in df.iterrows():
        t = fig.text(kx, 0.012, r.label, color=r._colour, fontsize=7,
                     fontweight="bold", ha="left", va="bottom")
        kx += t.get_window_extent(renderer).width / fw + 0.022

    ship = df[df.config == "shipped"]
    best = df.loc[df.switches_pct.idxmin()]
    note = ""
    if len(ship):
        sh = ship.iloc[0]
        note += (f"{best.label}: an ID switch on {best.switches_pct:.5f}% of "
                 f"camera-frames against {sh.label} at {sh.switches_pct:.5f}% "
                 f"({100 * (1 - best.switches_pct / sh.switches_pct):.0f}% lower); "
                 f"median cross-view IDF1 {sh.idf1_cross_median:.4f} -> "
                 f"{best.idf1_cross_median:.4f}\n")
    # The two .replace() calls that used to trim "M1 + " and " + distThresh 25" off
    # each label are gone with the long labels they existed for (see SERIES).
    note += ("RAW switch totals over all 50 sessions (the percentage's numerator; "
             f"denominator {cf:,} camera-frames): "
             + ", ".join(f"{r.label} {int(r.switches):,}" for _i, r in df.iterrows())
             + "\n")
    note += ("PR plane: one point per parameter set at the across-session MEDIAN, whiskers "
             "the IQR. Operating points, not a swept curve: a curve needs a score to "
             "sweep, this pool has none, and the IoU sweep is degenerate (recall moves "
             "0.016 over IoU 0.05-0.90). IDF1 sub-panel: survival in Fig 7c's idiom -- "
             "the vertical distance between two curves at any threshold IS the comparison\n"
             # distThresh 25 lives HERE now rather than in every legend entry: it is
             # common to all four candidates, so repeating it four times in the key
             # spent the key on a constant (Eric, 2026-08-19).
             "every candidate is M1 + distThresh 25 + the stale window named in the key; "
             "M1 = score all views against one frame-start 3D snapshot, stale N = evict a "
             "per-camera detection older than N frames before re-triangulating, "
             "distThresh 25 = the 3D term's distance threshold, default 50\n"
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
