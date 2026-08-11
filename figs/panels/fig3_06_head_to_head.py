#!/usr/bin/env python3
"""
Fig 3f -- greedy vs exhaustive, run for real, on identical detections: time per frame.

DO NOT PLOT IDF1 HERE. An earlier version of this panel drew greedy 0.982 against
exhaustive 0.714 and read as "the greedy method beats the published exhaustive one".
That gap is an ARTEFACT of our own harness, and `fig3_headtohead.json` says so in
its first caveat: exhaustive is a PURE PER-FRAME procedure with no cross-frame
identity mechanism at all, so to make IDF1 and switch counts computable
`fig3_exhaustive.mjs` threads identity between frames by nearest-3D-centroid
Hungarian matching. That threading is scaffolding we added, not part of Maree et
al.'s method, and the IDF1 gap measures the scaffolding. The file names the clean
comparison explicitly: **agreement_rate** -- does exhaustive choose the same
partition of detections as greedy, using only the paper's actual per-frame method.

So the panel reports the two things that ARE properties of the methods:

  * **Agreement**, in the title. On the 137,266 frames where exhaustive could be run
    at all, the two choose the same grouping 99.999% of the time. The greedy solve is
    not an approximation that degrades quality here; it reaches the same answer.
  * **Tractability**, on the axis. Measured seconds per frame for BOTH methods across
    the four configurations, on a log time axis from 1 ms to 1 day, with the ratio at
    the largest configuration called out.

BOTH SERIES, WHICH IS THE WHOLE POINT. The restyle had dropped LUC3D from this
panel, leaving the exhaustive bars alone -- a comparison panel with one method on it.
The measured LUC3D times come from `fig3_runtime.json measured`, matched to each
configuration by (animals, cameras) AND CORPUS, not averaged: the (2, 5) cell was
measured twice on two corpora (both rows are in the runtime deposit; the panel that
used to plot them all is retired -- quality vs GT replaced it as d), and the
exhaustive 2x5 run is BMimica, so the BMimica LUC3D measurement is the one that
belongs beside it. `luc3d_for()` refuses rather than averages if that leaves the
match ambiguous.

THE 4x6 POINT IS NOT MEASURED AND IS DRAWN AS NOT MEASURED. 4 animals x 6 cameras is
(4!)^6 = 191,102,976 hypotheses per frame, above the harness's 10^6 cap (which is a
CAP, not a count -- easy to confuse), so ZERO frames were computed. An earlier version
drew it as a bar at `measured.max() * 3.0` = 8,098 ms, a number that appears nowhere
in the data. It is now an OPEN marker (this figure's convention for "not measured")
with a range bar, and the footnote states the arithmetic.

AND THE MARKER IS THE LOWER BOUND, NOT THE HEADLINE. It used to sit at
hypotheses x rate = 1.9e8 x 347 us = 66,343 s = 18.4 h, which on an axis whose top
tick is "1 day" reads as "a day per frame". That number is defensible only if you
price the published (A!)^C enumeration exactly as published -- and (A!)^C
OVER-COUNTS. Applying the same permutation to EVERY camera relabels the groups but
yields an identical partition at an identical cost, so each distinct hypothesis is
evaluated A! times over (confirmed against the enumerator: `fig3_exhaustive.mjs`
runs a flat mixed-radix counter over all C views with no anchor view). Fixing one
camera's labels leaves (A!)^(C-1) = 24^5 = 7,962,624 DISTINCT hypotheses, 24x fewer.
So the panel now plots the floor -- the symmetry-reduced count at the CHEAPEST
measured rate, 8.0e6 x 244 us = 1,943 s = 0.5 h/frame -- and runs the bar UP to the
as-published ceiling, 1.9e8 x 347 us = 18 h. The claim on the artwork is therefore
one no reader can argue down, and it is still 10^6x LUC3D. Note the floor is
generous twice over: 244 us was measured at A=2, and per-hypothesis cost grows with
A (each hypothesis triangulates A groups) -- the three measured cells cost a
near-constant 116-127 us per animal-triangulation, so A=4 should be ~2x that rate.

The video-time line is the same claim in units a reader can check: at 50 fps one
second of footage is 50 frames, so even the floor costs >= 1 day per second of video.

READ THE FRAME COUNTS -- the title does. A frame only enters the exhaustive
computation if every included camera has EXACTLY `animals` non-null detections, so
that "A! per view" is well posed; occlusions, misses and extra false positives are
skipped and counted (`frames_considered` 198,292 vs `frames_clean` 137,266), not
silently dropped. Exhaustive therefore never faced the frames that are hardest for
association, which makes the agreement number, if anything, generous to it -- so
both counts are on the artwork, not only the one that flatters the result.

AND SO IS THE SAMPLE'S COMPOSITION, which is the part a ratio hides. "The same
grouping on 99.999%" is a statement about a specific 137,266 frames, and those
frames are not a cross-section of the problem:

  * 61,026 of the 198,292 (30.8%) were SKIPPED, and not at random -- a frame is
    skipped exactly when some camera does not hold `animals` non-null detections,
    i.e. when an animal is occluded, missed or doubled. Those are precisely the
    frames association finds hard, and exhaustive never saw one of them.
  * 122,830 of the 137,266 that remain (89.5%) are the SAME configuration:
    2 animals x 5 cameras, 32 hypotheses per frame -- the easiest cell in the
    figure. Only 161 frames (0.12%) have 3 animals, and none have 4.

So the honest reading is "on clean, almost-entirely-two-animal frames the greedy
solve reaches the same answer", and the panel now says that rather than leaving it
to this docstring: `COMPOSITION` is drawn inside the axes, in the empty upper-left
quadrant, so it costs no layout height and cannot be separated from the headline it
qualifies. It is derived from the per-config counts in the deposit (not typed in),
so it cannot drift from the data the title is computed from.

Source: figs/out/fig3_headtohead.json, figs/out/fig3_runtime.json `measured`.

    python3 figs/panels/fig3_06_head_to_head.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.ticker import NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, SALMON, TEAL, annotate_series, deposit,  # noqa: E402
                       footnote, panel, save, use)

#: Which corpus each runtime-bench session belongs to. `fig3_runtime.json` says
#: dataset "both" and names the two detection pools but does not tag the rows, so
#: the split is recorded here and CHECKED against the file's own session list -- a
#: new bench session must be classified deliberately rather than defaulted.
#: SLAP-2M's acquisition rate, used only to express the extrapolated per-frame cost
#: as video time. The 4x6 configuration is a SLAP-2M rig.
FPS = 50.0

CORPUS = {
    "10072022131531": "SLAP-2M",
    "10072022142111": "SLAP-2M",
    "10072022145420": "SLAP-2M",
    "20250827_141755": "BMimica",
}

#: Human-readable time ticks, in seconds. Explicit, so the axis reads in units a
#: reader has intuitions about instead of 10^n of milliseconds -- and so a 57 mm
#: panel carries no 5.6 pt mathtext exponents.
#:
#: EVERY GAP IS AT LEAST 2 DECADES. This axis spans 9.5 decades in ~25 mm of plot
#: height, i.e. ~7.6 pt per decade, and an 8 pt label is ~9 pt tall. The previous
#: set claimed a 1.4-decade floor was enough, but "1 h" sits 1.38 decades under
#: "1 day" and lint measured the two labels 23% overlapped. "1 h" is the one to
#: drop, not "1 day": the extrapolated bar's upper cap sits just below 1 day, so
#: the axis has to reach it. "1 day" is a SCALE REFERENCE, not the claim -- the
#: open marker (the claim) is ~1.6 decades below it, at 0.5 h, and the footnote
#: carries the arithmetic for both ends.
TICKS = [(1e-3, "1 ms"), (1e-1, "0.1 s"), (1e1, "10 s"), (86400.0, "1 day")]

_SUPS = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def _sup(n) -> str:
    return str(n).translate(_SUPS)


def luc3d_for(measured, animals, cameras, dataset):
    """LUC3D's measured seconds/frame for one configuration. Never an average.

    Matches on (animals, cameras) and then on corpus, because the (2, 5) cell was
    measured on both corpora and the exhaustive run at that cell is BMimica. If the
    match is still ambiguous, or missing, this exits: a silent mean of two sessions
    would put a number on the artwork that was never measured.
    """
    hits = [m for m in measured if m.get("status") == "ok"
            and m["animals"] == animals and m["cameras"] == cameras]
    if len(hits) > 1:
        hits = [m for m in hits if CORPUS[m["session"]] == dataset] or hits
    if len(hits) != 1:
        sys.exit(f"fig3f: {len(hits)} LUC3D measurements for {animals}a x "
                 f"{cameras}c on {dataset} -- expected exactly 1. Resolve the "
                 "duplicate explicitly; do not average.")
    return hits[0]["seconds_per_frame"], hits[0]["session"]


def build():
    h = load("fig3_headtohead.json")
    r = load("fig3_runtime.json")
    unknown = set(r["sessions"]) - set(CORPUS)
    if unknown:
        sys.exit(f"fig3f: unclassified bench session(s) {sorted(unknown)} in "
                 "fig3_runtime.json -- add them to CORPUS with their corpus.")

    rows = []
    for c in h["configs"]:
        spf, sess = luc3d_for(r["measured"], c["animals"], c["cameras"],
                              c.get("dataset"))
        rows.append({
            "label": f"{c['animals']}×{c['cameras']}",
            "animals": c["animals"], "cameras": c["cameras"],
            "hypotheses": c["hypotheses"],
            "exhaustive_s": c.get("seconds_per_frame_exhaustive"),
            "luc3d_s": spf,
            "luc3d_session": sess,
            "frames_considered": c.get("frames_considered", 0),
            "frames_computed": c.get("frames_computed", 0),
            "dataset": c.get("dataset"),
        })
    df = pd.DataFrame(rows).sort_values("hypotheses").reset_index(drop=True)

    # The deposit's `hypotheses` is the published (A!)^C. That count is A!-fold
    # redundant -- permuting every camera's assignment by the same sigma relabels
    # the groups and leaves the partition and its cost identical -- so the number of
    # DISTINCT hypotheses is (A!)^(C-1). Both are carried: (A!)^C is what the
    # published procedure (and our reimplementation) actually enumerates, (A!)^(C-1)
    # is the floor any implementation could reach without changing the algorithm.
    df["hypotheses_distinct"] = [c // math.factorial(a)
                                 for c, a in zip(df.hypotheses, df.animals)]

    # Per-hypothesis cost, from the measured configurations only. `rate` is the
    # LARGEST measured configuration's -- the closest to the extrapolated regime --
    # not the first row of an ascending list (an earlier version took next() over the
    # sorted list and silently used the SMALLEST, 254 us, while quoting 347 us).
    meas = df[df.exhaustive_s.notna()]
    rates = meas.exhaustive_s / meas.hypotheses
    rate = float(rates.loc[meas.hypotheses.idxmax()])
    rate_lo = float(rates.min())
    df["extrapolated"] = df.exhaustive_s.isna()
    # Ceiling: as published, at the rate measured closest to this regime.
    df["exhaustive_hi_s"] = df.exhaustive_s.fillna(df.hypotheses * rate)
    # Floor, AND THE VALUE PLOTTED: symmetry-reduced count at the cheapest measured
    # rate. Everything the panel asserts is asserted about this number.
    df["exhaustive_lo_s"] = df.exhaustive_s.fillna(df.hypotheses_distinct * rate_lo)
    df["exhaustive_plot_s"] = df.exhaustive_lo_s
    return df, {"h": h, "rate": rate, "rate_lo": rate_lo}


def main():
    use()
    df, meta = build()
    h = meta["h"]
    deposit(df, 3, "fig3f_head_to_head.csv")

    fig, ax = panel("third", "std")
    x = np.arange(len(df))
    ok = ~df.extrapolated.values

    ax.plot(x, df.exhaustive_plot_s, color=SALMON, lw=2.0, zorder=3)
    ax.plot(x[ok], df.exhaustive_plot_s[ok], "o", color=SALMON, ms=5, mec="white",
            mew=1.0, zorder=4)
    # The extrapolated point. The OPEN marker (this figure's convention for "not
    # measured") sits at the FLOOR, and the bar runs UP from it to the as-published
    # ceiling, capped by a short tick so the direction is unambiguous: the panel
    # claims "at least this", not "about this".
    for xi in x[~ok]:
        ax.plot([xi, xi], [df.exhaustive_lo_s[xi], df.exhaustive_hi_s[xi]],
                color=SALMON, lw=1.2, zorder=3)
        ax.plot([xi - 0.07, xi + 0.07],
                [df.exhaustive_hi_s[xi]] * 2, color=SALMON, lw=1.2, zorder=3)
        ax.plot([xi], [df.exhaustive_lo_s[xi]], "o", mfc="white", mec=SALMON,
                mew=1.4, ms=6, zorder=5)
    ax.plot(x, df.luc3d_s, color=TEAL, lw=2.0, zorder=3)
    ax.plot(x, df.luc3d_s, "o", color=TEAL, ms=5, mec="white", mew=1.0, zorder=4)

    ax.set_yscale("log")
    ax.set_ylim(1e-4, 3e5)
    ax.set_yticks([v for v, _ in TICKS])
    ax.set_yticklabels([lab for _, lab in TICKS])
    # No minor ticks: on a 9-decade log axis in ~34 mm they are a grey haze, and
    # their labels would be 5.6 pt.
    ax.yaxis.set_minor_locator(NullLocator())
    ax.set_xlim(-0.35, len(df) - 0.55)
    ax.set_xticks(x)
    ax.set_xticklabels(df.label)
    ax.set_ylabel("time per frame")
    ax.set_xlabel("animals × cameras")

    # Series named on the artwork rather than in a key band, which the 3-line title
    # needs the space for. NOT beside their own lines, though: at ~7.6 pt per decade
    # a 7 pt label is 1.2 decades tall, and the two series are only 0.9 decades apart
    # at the left of the axis -- both labels landed ON the strokes and lint_text's
    # ink-under-text check said so (6% and 14% of the box inked). Each therefore goes
    # in the large empty quadrant on its own side of the crossing: the exhaustive
    # label above its flat left end, where its own curve does not reach for another
    # half-config, and LUC3D above its flat right end, under the exhaustive curve
    # that has by then climbed five decades away.
    # 0.10, not 0.35: at 0.35 s the label's box clipped the composition block's
    # third line (lint: 33% overlap). A decade lower it still clears its own curve
    # (0.008-0.016 s at the left) by ~0.9 decades.
    annotate_series(ax, 0.06, 0.10, "exhaustive", SALMON, size=7, va="bottom")
    annotate_series(ax, len(df) - 0.6, 0.02, "LUC3D", TEAL, size=7, va="bottom",
                    ha="right")

    # WHAT THE 137,266 FRAMES ACTUALLY ARE. The agreement rate in the title is a
    # ratio, and a ratio hides its denominator's composition: 30.8% of the frames
    # offered were skipped BECAUSE a camera was short of `animals` detections (the
    # occluded ones -- the hard case for association), and 89.5% of what survived is
    # one configuration, the cheapest in the figure. Without this the headline reads
    # as a general result about greedy vs exhaustive.
    #
    # In the axes, not in the title or the footnote, for two reasons: the title is
    # already at its 3-line width limit and a 4th footnote line would eat the plot
    # (this y axis spans 9.5 decades in 25 mm, so ~2.6 mm of height costs a tick), and
    # the upper-left quadrant is genuinely empty -- the exhaustive curve does not
    # reach 10^3 s until x = 2.7 and the "10^n x" callout sits a decade below the
    # block. Placed in axes fractions so it tracks the axes if the panel is resized.
    skipped = int(df.frames_considered.sum() - df.frames_computed.sum())
    big = df.loc[df.frames_computed.idxmax()]
    share = big.frames_computed / df.frames_computed.sum()
    n3 = int(df.loc[df.animals == 3, "frames_computed"].sum())
    ax.text(0.012, 0.995,
            f"{skipped:,} skipped as occluded\n"
            f"{share:.0%} of the rest is {big.label}\n"
            f"{n3:,} frames test 3 animals",
            transform=ax.transAxes, ha="left", va="top", color=MUTED,
            fontsize=6.5, linespacing=1.3)

    # The gap at the biggest configuration, which is the sentence the panel exists
    # to support. NOT at the geometric midpoint: that lands at ~13 s, exactly where
    # the composition block's third line ends and the exhaustive curve passes (lint:
    # 38% overlap with the text, 5% inked). Weighted toward the LUC3D side (~1 s at
    # x = 2.9) it sits in the empty wedge between the two curves.
    # Against the PLOTTED (floor) exhaustive value, not the ceiling -- the callout
    # has to describe the marker the reader can see, and understating the gap is the
    # right way to be wrong here. 10^7x at the ceiling becomes 10^6x at the floor.
    hi, lo = df.exhaustive_plot_s.iloc[-1], df.luc3d_s.iloc[-1]
    # Flush with the right edge, under the open marker it describes: every
    # mid-panel position tried lands on either the composition block's third
    # line or the LUC3D label (lint 20-38% overlaps); the right margin under
    # the 4x6 marker is the one place both curves and all text stay clear.
    ax.text(len(df) - 0.55, hi ** 0.45 * lo ** 0.55,
            f"10{_sup(int(round(np.log10(hi / lo))))}×", color=SALMON,
            fontweight="bold", fontsize=7, ha="right", va="center")

    # THREE SHORT LINES, AND THEY HAVE TO BE SHORT. `loc="left"` anchors the title to
    # the AXES, not the page, and the "1 day"/"1 min" tick labels plus the y label eat
    # ~16 of the panel's 57.3 mm -- so a title line has ~41 mm, i.e. ~27 characters at
    # 7 pt bold. Set as two longer lines it ran off the right edge and PyMuPDF
    # silently dropped the off-page glyphs (the same failure that cost the previous
    # version "of 137,266 frames"). Both frame counts stay: 137,266 is what agreement
    # was computed on, 198,292 is what exhaustive was offered, and the difference is
    # the occluded frames it could not take.
    ax.set_title(f"same grouping on {h['agreement_rate']:.3%}\n"
                 f"of the {df.frames_computed.sum():,} of "
                 f"{df.frames_considered.sum():,}\nframes exhaustive could run",
                 color=TEAL, fontsize=7, fontweight="bold", loc="left")
    # Same width limit, and tighter: footnote() folds the note into the x label, which
    # is CENTRED on the axes, so a line may only be ~2x the smaller side margin --
    # ~44 mm here. The provenance of the two rates is in the docstring and caption.
    # BOTH ENDS OF THE BAR GET THEIR ARITHMETIC, because they use different
    # hypothesis counts and a reader who only sees one would think the other was a
    # rate difference. Line 2 is the floor (= the marker), line 3 the ceiling.
    #
    # The per-frame figure is correct but not graspable, so give it a unit a reader
    # can check against their own experience: at SLAP-2M's 50 fps, ONE SECOND of
    # video is 50 frames. Computed from the FLOOR and stated as ">=", so it is the
    # weakest form of the claim -- the ceiling would read "38 days" and the point
    # does not need it.
    days_per_s_video = df.exhaustive_lo_s.iloc[-1] * FPS / 86400.0
    lo_h = df.exhaustive_lo_s.iloc[-1] / 3600.0
    hi_h = df.exhaustive_hi_s.iloc[-1] / 3600.0
    footnote(ax, "○ not run; lower bound:\n"
                 f"{df.hypotheses_distinct.iloc[-1] / 1e6:.1f}×10⁶ hyps × "
                 f"{meta['rate_lo'] * 1e6:.0f} µs = {lo_h:.1f} h\n"
                 f"bar → {df.hypotheses.iloc[-1] / 1e8:.1f}×10⁸ × "
                 f"{meta['rate'] * 1e6:.0f} µs = {hi_h:.0f} h\n"
                 f"1 s of {FPS:g} fps video ≥ {days_per_s_video:.0f} day")
    save(fig, 3, "f", "head_to_head")


if __name__ == "__main__":
    main()
