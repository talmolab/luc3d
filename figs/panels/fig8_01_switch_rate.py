#!/usr/bin/env python3
"""
Fig 8a -- ID-switch RATE against every remaining tracker threshold, one at a time.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript. It
    is not in FIGURE-LEGENDS.md, METHODS.md, RESULTS.md or CAPTIONS.md, and
    nothing in Figures 1-7 refers to it. It exists to answer one internal
    question -- "Fig 3e swept two tracker parameters and held the rest at their
    defaults; do any of the others matter?" -- and it should not be cited as a
    result until that question has been decided.

WHAT THIS PANEL CLAIMS. On these 8 BMimica sessions, at every value sampled, with
all other thresholds at their shipped default: the within-view ID-switch rate as
one threshold is varied. Ten one-dimensional sweeps, not a grid.

WHAT IT MUST NOT BE READ AS CLAIMING.

* NOT a joint optimum. Every sweep is 1-D. A parameter that is flat on its own can
  still matter in combination with another; nothing on this artwork searches that
  space. One 2-D question WAS settled, off-panel, because it decides how to read the
  two winners: distanceThreshold and corr3dWeight are the two knobs on the SAME term
  of the cost, `w_k * corr3d * (1 - dist/distThresh)`, and they improve the same
  sessions. `fig8_param_sweeps.py --interaction` measured the combinations and they
  partially stack -- 25 x 36 gives 3.50 per 100,000 and IDF1 0.818 against 3.64/0.795
  and 3.78/0.766 for the two alone. It lives in the deposit's `interaction_check`
  key and is deliberately NOT plotted here: this figure is ten 1-D sweeps and a 2-D
  cell has no honest place on one of them.
* NOT generalisation. One rig, one detector, two animals, five cameras, one corpus.
  A threshold in normalised image units (velocityThreshold) or world mm
  (distanceThreshold) is tied to this geometry.
* NOT "the flat lines are within noise". SEVEN of these ten sweeps produced
  byte-identical tracker output at every value, which is a stronger statement than
  noise and, for one of them, a quite different one -- see below.

WHAT IT FOUND. Only THREE of the ten thresholds changed a single identity
assignment on this corpus, and the shipped default is at the best sampled value for
only one of them:

    distanceThreshold   50 (shipped) -> 4.50 per 100,000.  25 -> 3.64, the minimum.
                        Fewer switches in 4 of 8 sessions and MORE IN NONE, and
                        cross-view IDF1 0.735 -> 0.795, more than twice the noise
                        band 8b draws. 100 -> 5.11 and 200 -> 7.69, so the default
                        sits on the wrong side of a real minimum.
    corr3dWeight        Fig 3e's tail does NOT keep falling: 12 -> 3.78, 18 -> 3.91,
                        36 -> 3.78. Flat from r = 12, which is what the 18 and 36
                        cells were added to test.
    filterMinVisibleNodes  0, 4 and 8 are byte-identical; 12 is WORSE (5.08, IDF1
                        0.685). The sleap-3d reference's 8-of-15 setting does
                        nothing on this detector's output.

THREE KINDS OF FLAT, WHICH THE LINE ALONE CANNOT DISTINGUISH. This is why every
flat sub-plot is tagged rather than left to speak for itself.

1. NEVER READ (the whole grey bottom row). `runCrossViewTracker` -- the function
   `trackAll()` calls and the function the bench driver drives -- reads exactly seven
   thresholds, via
   `crossViewHyperparams()` (corr2dWeight, corr3dWeight, velocityThreshold,
   distanceThreshold, timePenalty) and `buildTrackerDetections()`
   (filterMinVisibleNodes, filterMinInstanceScore). The five in the bottom row --
   track3dWeight, prevIdentityBonus, minMatchScore, reprojSigma, epipolarDecay --
   are read ONLY inside `matchFrameInstances` and its helpers, i.e. the legacy
   bench-only matcher, whose only call sites in the whole repo are
   `scripts/bench/bench_driver.mjs`, `scripts/bench/speed_test.mjs` and
   `tests/test-tracker-luc3d.mjs`. No app path calls it. `track3dWeight` is the one
   that matters practically: `ui/settings.js` advertises it as the temporal
   identity-linking weight that "suppresses sustained ID swaps" and names 6 as the
   benchmark champion against a shipped 1 -- and on the shipped path it does
   nothing at all, at any value.

2. READ, BUT NEVER DECISIVE (velocityThreshold, salmon and flat). It is a live
   hyperparameter of the cost function and 2 through 40 still produced identical
   output. Consistent with the README's note on the cost model: velocityThreshold is
   in NORMALISED image units, so the 2D term saturates and the 3D term is the knob
   that decides matches. This one is a genuine measured null on this corpus.

3. NOT EXERCISABLE AT ALL (filterMinInstanceScore, tagged separately). See
   FLAT_NOTE: the filter gates on `inst.score != null` and this detection pool
   carries no scores, so no threshold can fire. That sweep is uninformative, not
   negative, and must not be reported as "instance-score filtering does not help".

ALL OF THAT IS MEASURED, NOT JUST ARGUED FROM THE SOURCE, which is why the inert
cells were run at all rather than reasoned away: the deposit carries, per cell,
whether the SHA-256 of the tracker's own output (identities + every per-camera
per-frame assignment; the echoed params and the wall-clock fields excluded) equals
the default cell's on all 8 full sessions. For all seven flat sweeps it does.
Byte-identical output over 7,205,370 camera-frames is not "no detectable
difference" -- it is no difference.

RATE, NOT COUNT, AND THE DENOMINATOR IS READ RATHER THAN ASSUMED. `switches` is a
SUM of per-camera within-view switches over 5 cameras x 8 sessions, uninterpretable
without its exposure. Per 100,000 camera-frames off `total_camera_frames` =
7,205,370, the same key and the same measured denominator Fig 3e uses -- so a value
here is directly comparable to a value there. The panel exits rather than draw a
rate against a guessed exposure.

A CELL WITH ZERO SWITCHES IS PINNED AT THE ONE-SWITCH FLOOR, as in Fig 3e: log(0)
is undefined and the smallest event this measurement can resolve is one switch
(0.0139 per 100,000). The raw sums are in the deposited CSV.

X IS LINEAR AND IN REAL UNITS, not a category index. Fig 3e's own notes record why
that matters: on an index the distance between two sampled values says nothing
about the parameter, so "the knee is here" becomes a statement about the sampling
grid. Only a few values per sub-plot are tick-labelled -- 33 mm of axis will not
hold five labels at 8 pt -- but every sampled value carries a marker and positions
are proportional.

Source: figs/out/fig8_param_sweeps.json `cells`, written by figs/fig8_param_sweeps.py.

    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig8_param_sweeps.py
    python3 figs/panels/fig8_01_switch_rate.py
"""
import sys
from pathlib import Path

import pandas as pd
from matplotlib.ticker import FuncFormatter, LogLocator, NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, MUTED, SALMON, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, use)

#: Rate basis, matching Fig 3e so the two panels' numbers are the same quantity.
PER = 100_000

#: Sub-plot order: TOP ROW the five thresholds `runCrossViewTracker` actually reads,
#: BOTTOM ROW the five it never reads. The split is the panel's argument, so it is
#: the layout rather than an annotation. Verified against the deposit's own
#: `reaches_shipped_tracker` flag in `build()` -- if the tracker ever starts reading
#: one of the bottom five, this ordering becomes wrong and the panel says so.
LIVE_ROW = ["velocityThreshold", "distanceThreshold", "filterMinVisibleNodes",
            "filterMinInstanceScore", "corr3dWeight"]
INERT_ROW = ["track3dWeight", "prevIdentityBonus", "minMatchScore",
             "reprojSigma", "epipolarDecay"]

#: Why a sub-plot is flat, when "identical output" alone would mislead. A flat curve
#: has three quite different causes here and the reader cannot tell them apart from
#: the line: the parameter is never read (the grey row); it is read but never changes
#: an assignment (velocityThreshold); or the corpus cannot exercise it at all. The
#: last is the dangerous one, because it looks exactly like a null result and is not
#: one -- `filterMinInstanceScore` gates on `inst.score != null`, and the shared
#: BMimica detection pool (`{cam}_predictions.h5`) contains a `tracks` dataset and
#: NOTHING else, so no instance carries a score and the filter cannot fire at any
#: threshold. That sweep is uninformative, not negative.
FLAT_NOTE = {
    "filterMinInstanceScore": "no scores in pool:\nuntestable here",
}

#: corr3dWeight values already measured by Fig 3e (corr2d = 1), pulled in so the tail
#: is not read off three points. Fig 3e swept 0-12 and this figure adds 18 and 36; on
#: 6/18/36 alone the curve falls monotonically and looks like it is still improving,
#: which is the opposite of what the r = 8 and r = 12 cells show. Same 8 sessions,
#: same detections, same scorer, same denominator -- it is one measurement, split
#: across two deposits only because it was run in two sittings.
CORR3D_FROM_FIG3E = (8, 12)

#: Which values get a tick LABEL, per parameter. Every sampled value is drawn; these
#: are the ones that fit at 8 pt across a ~33 mm sub-plot without colliding -- the
#: ends of the sweep plus the shipped default, which is what the sub-plot is read for.
TICKS = {
    "velocityThreshold": [2, 10, 40],
    "distanceThreshold": [10, 50, 200],
    "filterMinVisibleNodes": [0, 4, 12],
    "filterMinInstanceScore": [0, 0.5, 0.85],
    "corr3dWeight": [6, 12, 36],
    "track3dWeight": [0, 1, 12],
    "prevIdentityBonus": [0, 0.3, 1.0],
    "minMatchScore": [0, 0.05, 0.3],
    "reprojSigma": [5, 20, 40],
    "epipolarDecay": [2, 10, 20],
}


def build() -> pd.DataFrame:
    d = load("fig8_param_sweeps.json")
    tcf = d.get("total_camera_frames")
    if not tcf:
        sys.exit("fig8a: fig8_param_sweeps.json has no total_camera_frames -- the "
                 "rate has no measured denominator and the panel will not guess one.")
    df = pd.DataFrame([c for c in d["cells"] if c.get("switches") is not None])
    if df.empty:
        sys.exit("fig8a: no scored cells in fig8_param_sweeps.json")

    # THE LIVE/INERT SPLIT IS CHECKED, NOT ASSUMED. It is drawn as the row layout,
    # so a change in which thresholds runCrossViewTracker reads would silently put a
    # live parameter in the grey row.
    flag = df.groupby("param").reaches_shipped_tracker.first()
    for p in LIVE_ROW:
        if not bool(flag.get(p, False)):
            sys.exit(f"fig8a: {p} is in the top row but the deposit says the shipped "
                     "tracker does not read it -- re-read pose/tracker.js and fix the "
                     "row split before drawing.")
    for p in INERT_ROW:
        if bool(flag.get(p, False)):
            sys.exit(f"fig8a: {p} is in the grey 'never read' row but the deposit says "
                     "the shipped tracker DOES read it -- the panel's argument has "
                     "changed; fix the row split.")

    # Fig 3e's own corr3d = 8 and 12 cells, so the tail is judged on five points
    # rather than three. See CORR3D_FROM_FIG3E.
    f3e = load("fig3_sweep.json")
    if f3e.get("total_camera_frames") != tcf:
        sys.exit("fig8a: fig3_sweep.json and fig8_param_sweeps.json disagree on "
                 "total_camera_frames -- they are not the same exposure and their "
                 "corr3d cells must not be drawn on one axis.")
    extra = [{"param": "corr3dWeight", "value": c["corr3d"], "is_default": False,
              "reaches_shipped_tracker": True, "identical_to_default": False,
              "switches": c["switches"], "idf1_cross": c["idf1_cross"],
              "idf1_within": c["idf1_within"], "n_sessions": c["n_sessions"],
              "from_fig3e": True}
             for c in f3e["cells"]
             if c.get("corr2d") == 1 and c.get("corr3d") in CORR3D_FROM_FIG3E
             and c.get("switches") is not None]
    df["from_fig3e"] = False
    df = pd.concat([df, pd.DataFrame(extra)], ignore_index=True)

    df["camera_frames"] = tcf
    # Pinned at the one-switch floor for the log axis, exactly as Fig 3e does it.
    df["switches_per_100k_camera_frames"] = (
        df.switches.clip(lower=1).astype(float) / tcf * PER)
    df["switches_per_100k_raw"] = df.switches.astype(float) / tcf * PER
    order = {p: i for i, p in enumerate(LIVE_ROW + INERT_ROW)}
    df["_o"] = df.param.map(order)
    return (df.sort_values(["_o", "value"])
              .drop(columns="_o")
              .reset_index(drop=True))


def main():
    use()
    df = build()
    deposit(df[["param", "value", "is_default", "reaches_shipped_tracker",
                "identical_to_default", "from_fig3e", "switches", "camera_frames",
                "switches_per_100k_camera_frames", "idf1_cross", "idf1_within",
                "n_sessions"]], 8, "fig8_param_sweeps.csv")

    # TWO ROWS OF FIVE, sharing one y axis. Small multiples are only comparable if
    # they share a scale, and sharing it also buys back four sets of tick labels
    # worth of width -- at 33 mm per sub-plot that is the difference between
    # readable and not.
    fig, axes = grid(2, 5, span="full", row=80.0, sharey=True)
    # Reserve the key's band ABOVE the axes, using `panel(key=...)`'s own formula for
    # a 2-entry key. A hand-picked smaller rect put the second key line straight
    # through three top-row sub-plot titles -- caught by lint_text.py, invisible in
    # the source.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 2 + 0.02)))

    lo = df.switches_per_100k_camera_frames.min()
    hi = df.switches_per_100k_camera_frames.max()

    for i, param in enumerate(LIVE_ROW + INERT_ROW):
        ax = axes[i // 5][i % 5]
        g = df[df.param == param]
        live = bool(g.reaches_shipped_tracker.iloc[0])
        color = SALMON if live else GREY
        x = g.value.to_numpy(dtype=float)
        y = g.switches_per_100k_camera_frames.to_numpy(dtype=float)
        ax.plot(x, y, color=color, lw=2.0, zorder=3)
        ax.plot(x, y, "o", color=color, ms=3.2, mec="white", mew=0.7, zorder=4)

        # The shipped default, marked on every sub-plot -- the question this figure
        # is asked to answer is whether it should move.
        dv = float(g[g.is_default].value.iloc[0])
        ax.axvline(dv, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)

        ax.set_yscale("log")
        ax.set_ylim(lo * 10 ** -0.25, hi * 10 ** 0.25)
        # PLAIN DIGITS ON THE DECADES, not matplotlib's 10^n. Fig 3e made the same
        # change for readability; here it is also a hard requirement, because a
        # mathtext exponent renders at 0.7x its span's size and 6.5 pt tick labels
        # put the superscript at 4.55 pt -- under Nature's 5 pt floor, which
        # lint_text.py fails on.
        # A 1-2-3-5 ladder rather than bare decades: the measured range is only 3.6 to
        # 7.7 per 100,000, so decades alone put TWO labels on the axis (3 and 10) and
        # the reader has nothing to place the points against.
        ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1, 2, 3, 5)))
        ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
        ax.yaxis.set_minor_locator(NullLocator())
        ax.set_title(param, fontsize=6.5, color=color if live else MUTED, pad=2.5)
        ax.set_xticks(TICKS[param])
        ax.set_xticklabels([f"{v:g}" for v in TICKS[param]], fontsize=6.5)
        ax.tick_params(axis="y", labelsize=6.5)
        if i % 5 == 0:
            ax.set_ylabel("ID switches per\n100,000 camera-frames", fontsize=7)

        # EVERY FLAT SUB-PLOT IS TAGGED, not just the grey row -- which is a change
        # the data forced. Two of the five thresholds the tracker DOES read
        # (velocityThreshold, filterMinInstanceScore) also produced byte-identical
        # output at every value, and an untagged flat salmon line would have read as
        # "measured, no effect within noise" when the truth is stronger and, for one
        # of them, quite different (see FLAT_NOTE).
        if bool(g[~g.is_default].identical_to_default.all()):
            ax.text(0.5, 0.06, FLAT_NOTE.get(param, "identical output"),
                    transform=ax.transAxes, ha="center", va="bottom",
                    fontsize=6.0, color=MUTED, style="italic", linespacing=1.25)

    text_legend(fig.axes[0], [
        ("top row: read by the shipped tracker", SALMON),
        ("bottom row: legacy matcher only", MUTED),
    ], "above")

    footnote(fig.axes[0],
             f"rate basis: {int(df.camera_frames.iloc[0]):,} camera-frames "
             "(8 BMimica sessions x 5 cameras, full length), the same denominator "
             "as Fig 3e\n"
             "each sweep varies ONE threshold and holds every other at its shipped "
             "default; dotted line = shipped default\n"
             "zero-switch cells are pinned at the one-switch floor "
             f"({1 / df.camera_frames.iloc[0] * PER:.4f} per 100,000) so they can sit "
             "on a log axis")
    save(fig, 8, "a", "switch_rate")


if __name__ == "__main__":
    main()
