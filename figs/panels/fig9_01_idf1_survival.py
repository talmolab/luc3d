#!/usr/bin/env python3
"""
Fig 9a -- cross-view identity precision, recall and IDF1 on the 42 MULTI-ANIMAL SLAP-2M
sessions: the shipped tracker against the Fig 8 winner, as survival curves.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHAT THE TWO CONFIGURATIONS ARE, spelled out because "stale 20" means nothing alone:

  shipped                        pose/cross-view-tracker.js exactly as it ships.
  M1 + stale 20 + distThresh 25  three changes, stacked, and EXPERIMENTAL -- the code
        lives in `figs/fig8-bench/xv_experimental.js` and is NOT in the shipped app:
        M1 (`sync`)     score all six views against ONE frame-start 3D snapshot and
                        re-triangulate once at frame end, instead of running a Hungarian
                        per camera and re-triangulating on every match (which lets
                        camera 1's decision move the state camera 2 is judged against).
        stale 20        evict a target's per-camera detection once it is older than 20
                        frames, before re-triangulating. The shipped tracker NEVER
                        expires one: `Target.detsByCam` holds one detection per camera
                        indefinitely and `_retriangulate()` fuses all of them, so the 3D
                        pose every association is scored against blends the current pose
                        with wherever each other camera last saw the animal.
        distThresh 25   `distanceThreshold` 50 -> 25, a pure threshold change.
  Detections, cameras, sessions and scorer are identical across the two and sessions are
  PAIRED, so the only thing that varies between the curves is the tracker.

WHY SURVIVAL CURVES AND NOT MEANS. Fig 8d's argument applies unchanged: a mean over n
sessions can be carried by a handful of them, and this repo has been burned by that
before (figs/README.md on Fig 4). A survival curve -- the percentage of sessions scoring
at or above each threshold -- makes the comparison a vertical distance at whatever
threshold the reader picks, and shows WHERE a method acts (the bad tail, the middle, or
nowhere). Each curve is a true ECDF over every session's own value, not an interpolation
through chosen thresholds.

ONLY THE MULTI-ANIMAL COHORT IS DRAWN (2026-08-13, on instruction) -- ONE curve per
configuration, not two. 32 of the 74 SLAP-2M sessions hold ONE animal. There is nothing to
associate across views in a single-animal session and every tracker scores near-perfectly
there (Fig 7d says so explicitly); they contribute exactly 0 ID switches and 0 misgrouped
detections, so pooling them changed only the denominator -- a 43% dilution. The pooled
all-74 curve and the pooled means are therefore NOT drawn: an earlier version kept the
words "dotted = all 74" and a "42 multi / all 74" mean pair on the artwork after the pooled
cohort had been dropped, so it printed the multi-animal mean twice and labelled one of them
"all 74".

THE CEILING IS DRAWN, AND IT IS NOT A BOUND ON THESE CURVES -- which is exactly why it
has to be drawn with its provenance rather than as a bare rule. The deposit's own caveat
says SLAP-2M's detector misses 35.4% of ground truth against Mouse-Dyad-10M's 8.7%, capping any
identity-only method at IDF1 0.7704 here against 0.9527 there, so a gain smaller than
Mouse-Dyad-10M's 0.749 -> 0.861 is EXPECTED and is not evidence the method failed. But that
0.7704 was computed WITHIN-view on the `PAF_3d_kalman` detections, whose published
within-view IDF1 is 0.7360 -- the number Fig 7c plots -- and THIS pass runs on the
`keeptrack_h5s` pool through the Fig 8 driver, where the same 74 sessions score within-view
0.899. Every curve on this panel therefore clears the rule, because a ceiling is a
property of a DETECTION POOL (its FN and FP) and the pool is not the same one. The panel
prints both numbers side by side and says so on its face; leaving the rule undrawn would
hide the 35.4% argument, and drawing it unlabelled would read as this arm beating a bound
it was never measured against. Fig 7c's own docstring is about precisely this failure --
two different quantities both called SLAP-2M IDF1.

WHAT THIS PANEL DOES NOT SHOW, spelled out because "IDF1 barely moved" is not the same
statement as "nothing changed". Between the two configurations the distributions here are
almost identical (mean 0.8396 -> 0.8388, median 0.9237 -> 0.9197 cross-view IDF1), while 9b
shows ID switches falling 30% (2,826 -> 1,991) and mislabelled mass rising 1.3% (849,849 ->
861,224 misgrouped DETECTIONS, 11.52% -> 11.68% of labelled detections, on the corrected
optimal-permutation metric). Flat IDF1 with fewer switches and slightly more mislabelled
mass is a real, and unfavourable, change; read this panel with 9b, not instead of it.

WHY IDP AND IDR TOO. IDF1 is their harmonic mean, so IDF1 alone cannot say WHICH failure
a tracker has -- identities attached to detections that are not that animal (precision)
or the right identity missing where it belongs (recall) -- and the two have different
fixes. On a corpus missing a third of its ground truth, recall is capped by coverage and
precision is where an identity method can actually show; separating them is the only way
to see that. Drawn in the same idiom so all three read identically.

Source: figs/out/fig9_slap2m.json, written by
`/root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig9_slap2m.py`.
Identity precision/recall are motmetrics `idp`/`idr` via figs/fig3_score.py.

    figs/.venv/bin/python figs/panels/fig9_01_idf1_survival.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fig9_common import (BMIMICA_CEILING, CEILING, COHORTS, IMPROVED,  # noqa: E402
                        MISS_RATE, SERIES, SHIPPED, load9)
from src.data_loader import load  # noqa: E402
from src.style import (GREY, MUTED, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, use)

#: Sub-panels: (per-session key, aggregate key for its mean, axis label, ceiling here).
#: The ceiling is an IDF1 ceiling, so it is drawn on the IDF1 axis only.
METRICS = [("cross_idp", "idp_cross", "identity precision (cross-view)", False),
           ("cross_idr", "idr_cross", "identity recall (cross-view)", False),
           ("cross_idf1", "idf1_cross", "cross-view IDF1", True)]

#: Panel height in mm, declared. Figure 9's three rows would have to sum under 175 mm to
#: keep the assembled page inside assemble.py's 200 mm SOFT ceiling (25 mm goes to margins,
#: letter leads and row gaps). They do not: 58 + 64 + 96 = 218 puts the page at 243 mm,
#: because 9c became a 2x5 block of five metrics by two stratifications and cannot carry
#: ten sub-plots plus its key in 52 mm. Fig 9 is exploratory and unplaced, so assemble.py
#: warns and the overrun is accepted there rather than paid for by cramming 9c -- but do
#: not GROW a Fig 9 panel without shrinking another.
ROW_H = 58.0

#: Fig 7c's SLAP-2M within-view measurement, for the cross-check drawn on this panel: the
#: same 74 sessions through a different driver and a different detection pool. Optional --
#: if the file is absent the panel says the cross-check could not be made, rather than
#: silently dropping it.
REF_DEPOSIT = "fig3_trackers.json"


def build(cells):
    """One row per (config, cohort), carrying the per-session vectors it draws."""
    rows = []
    for cfg, label, colour in SERIES:
        ps = cells[cfg]["per_session"]
        for key, cohort_label, ls, lw in COHORTS:
            sub = [q for q in ps if q["animals"] > 1] \
                if key == "multi_animal_only" else list(ps)
            agg = cells[cfg][key]
            row = {"config": cfg, "label": label, "cohort": key,
                   "cohort_label": cohort_label, "n_sessions": len(sub)}
            # The deposit's own aggregate is the authority for the means -- recomputing
            # them here would make two numbers for one quantity.
            for k in ("idf1_cross", "idf1_cross_median", "idf1_within", "idp_cross",
                      "idr_cross"):
                row[k] = agg[k]
            if agg["n_sessions"] != len(sub):
                sys.exit(f"fig9a: cohort {key} of {cfg} says n={agg['n_sessions']} but "
                         f"{len(sub)} per-session records match it -- the deposit is "
                         f"inconsistent; do not draw it")
            for mkey, _ak, _lab, _c in METRICS:
                row["_" + mkey] = [q[mkey] for q in sub]
            row["_ls"], row["_lw"], row["_colour"] = ls, lw, colour
            rows.append(row)
    return pd.DataFrame(rows)


def survival(values):
    """% of sessions at or above each threshold -- a true ECDF, Fig 7c's idiom."""
    v = np.sort(np.asarray(values, dtype=float))
    n = len(v)
    xs = np.repeat(v, 2)
    ys = np.empty(2 * n)
    ys[0::2] = 100.0 * (n - np.arange(n)) / n
    ys[1::2] = 100.0 * (n - np.arange(n) - 1) / n
    return xs, ys


def main():
    use()
    d, cells = load9("fig9a", need_pr=True)
    df = build(cells)
    deposit(df[[c for c in df.columns if not c.startswith("_")]], 9,
            "fig9a_idf1_survival.csv")

    # The Fig 7c cross-check: the same 74 sessions, a different driver and a different
    # detection pool. It is what licenses the statement that the drawn ceiling does not
    # bound these curves, so it is loaded here and printed on the artwork.
    try:
        ref_within = float(load(REF_DEPOSIT)["slap2m"]["within_view"]["luc3d"]["mean"])
    except Exception:  # noqa: BLE001
        ref_within = None

    fig, axes = grid(1, 3, span="full", row=ROW_H)
    # EIGHT key lines above the plots, in the band the layout engine gives back. Inside the
    # axes they would land on the curves they name -- see panel(key=...) in style.py.
    # KEEP THIS IN STEP with the entry list below: the count is the height reserved, and a
    # stale count silently overlays the top plots with the last key line.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 8 + 0.02)))

    def value(cfg, cohort, key):
        return df[(df.config == cfg) & (df.cohort == cohort)][key].iloc[0]

    for ax, (mkey, akey, xlabel, ceiling_here) in zip(axes, METRICS):
        if ceiling_here:
            # THE CEILING, drawn before the curves so it reads as ground, not as data --
            # and labelled "other pool" ON the rule, because every curve here clears it.
            # An unqualified "ceiling" that the data exceeds would read as this arm
            # beating a bound, when in fact it was measured against a different detection
            # pool; the key gives the two within-view numbers that show that.
            ax.axvline(CEILING, color=GREY, lw=0.9, ls=(0, (2.4, 1.6)), zorder=1)
            # Horizontal and LEFT of the rule at y = 30, which took three attempts and is
            # measured rather than nudged. Set along the rule it crosses the curves at the
            # height they actually pass through (the failure fig7c documents). At the TOP
            # it landed on them too -- these distributions sit at 95-100% out to x = 0.75,
            # which is where the label ends. At the very bottom it collided with the mean
            # block in the opposite corner. At y = 38 it occupies x = 0.42-0.75 where
            # every curve is still above 60%, and it sits a clear line above the mean
            # block, whose top is at y = 26 -- at 30 the two read as one line even though
            # they do not overlap.
            # y = 52, up from 38, for the same reason the mean block moved to point
            # offsets: the axes lost 14 mm of height when the key grew, the mean block now
            # reaches ~47% of it, and at 38 this label landed on top of that block
            # (lint_text.py, 38% overlap). The window is narrow and measured -- above the
            # block at ~47% and below the curves, which at x = 0.42-0.75 are all still
            # above 62% -- so this label sits between them, at the one height available.
            ax.text(CEILING - 0.02, 52, f"{CEILING} (other pool — see key)", color=MUTED,
                    fontsize=6.0, ha="right", va="bottom")
        for _i, r in df.iterrows():
            xs, ys = survival(r["_" + mkey])
            ax.plot(xs, ys, color=r._colour, lw=r._lw, ls=r._ls,
                    zorder=4 if r.cohort == "multi_animal_only" else 3)
        ax.axhline(50, color=GREY, lw=0.7, ls=(0, (1.5, 1.5)), zorder=1)
        ax.set_xlabel(xlabel, fontsize=7)
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 100)
        ax.set_yticks([0, 25, 50, 75, 100])
        ax.tick_params(labelsize=6.5)
        # The means, in the corner every survival curve leaves empty (they start near
        # 100% at the left and fall rightwards). Printed because a distribution with no
        # summary cannot be quoted.
        #
        # ONE number per configuration, over the 42 multi-animal sessions -- the only
        # cohort this panel draws. It used to print "0.840 / 0.840" under the header
        # "mean: 42 multi / all 74", both halves being the SAME multi-animal mean, left
        # over from when the pooled cohort was drawn too.
        #
        # NARROW, not wide, and measured rather than guessed: the first version set
        # "mean, 42 multi-animal sessions" as a header and "0.576  ·  all 74: 0.755"
        # under it, which is 0.68 of this axes' width at 6 pt -- and at x = 0.68 the
        # shipped curve has fallen to ~30%, i.e. straight through the block (lint_text.py
        # ON DATA). At one value and a short header the block is ~0.3 wide, where the
        # lowest curve is still above 65%.
        # OFFSET IN POINTS, not in axes fractions, and that is the whole fix: the block used
        # 0.085 of the axes between lines, which was 2.5 mm while the axes were 36 mm tall
        # and 1.9 mm -- less than the type is high -- once the key grew a line and the axes
        # came down to 22 mm. Three lines collided and lint_text.py caught it. Points are
        # invariant to the axes' height, so this block cannot fall in on itself again.
        for j, (cfg, _lab, colour) in enumerate(SERIES):
            ax.annotate(f"{value(cfg, 'multi_animal_only', akey):.3f}",
                        xy=(0.03, 0.02), xycoords="axes fraction",
                        textcoords="offset points", xytext=(0, 8.5 * (len(SERIES) - 1 - j)),
                        ha="left", va="bottom", color=colour, fontsize=6.0,
                        fontweight="bold")
        ax.annotate("mean, 42 sessions", xy=(0.03, 0.02), xycoords="axes fraction",
                    textcoords="offset points", xytext=(0, 8.5 * len(SERIES) + 1.5),
                    ha="left", va="bottom", color=MUTED, fontsize=6.0, fontweight="bold")

    axes[0].set_ylabel("% of sessions at or above", fontsize=7)

    # The key starts at x = 0.022 of the figure, not text_legend's default 0.14: these
    # lines are ~150 characters and at 6 pt that is ~150 mm of type, which a 25 mm indent
    # would push off a 180 mm panel. Measured: at 0.022 a 155-character line ends at
    # ~176 of 180 mm, so 155 is the hard limit -- one line of 170 was cut mid-word
    # ("35.4% of GT has n") in the first render, which is why the ceiling sentence is on
    # a line of its own rather than appended to the cohort sentence.
    # LIKE FOR LIKE, which this cross-check was not. Fig 7c's 0.736 is over ALL 74 sessions,
    # so the number it has to be set beside is this pool's ALL-74 within-view IDF1 (0.899),
    # not the 42-session figure the rest of the panel uses -- printing "these same 74
    # sessions ... against 0.839" compared 74 sessions with 42 and understated the gap
    # between the pools, which is the whole point of the sentence.
    here_within = value(SHIPPED, "multi_animal_only", "idf1_within")
    all74_within = float(cells[SHIPPED]["all_sessions"]["idf1_within"])
    cross_check_ref = (f"within-view {ref_within:.3f} ({REF_DEPOSIT}, Fig 7c)"
                       if ref_within is not None
                       else f"an unknown within-view IDF1 — {REF_DEPOSIT} is absent, so "
                            f"the two pools could not be cross-checked")
    cross_check = (f"within-view {all74_within:.3f} on this pool over all 74 sessions "
                   f"({here_within:.3f} over the 42 drawn here) vs {ref_within:.3f} in "
                   f"{REF_DEPOSIT} (Fig 7c) over the same 74" if ref_within is not None
                   else f"within-view {all74_within:.3f} on this pool; {REF_DEPOSIT} "
                        f"absent, so the pools could not be cross-checked here")
    text_legend(axes[0], [
        (SERIES[0][1], SERIES[0][2]),
        (SERIES[1][1], SERIES[1][2]),
        ("the 42 MULTI-ANIMAL sessions only. The other 32 hold ONE animal, where any "
         "tracker scores near-perfectly and both configurations make 0 switches and 0",
         MUTED),
        ("misgrouped detections, so they are EXCLUDED: pooling them changed only the "
         "denominator, a 43% dilution", MUTED),
        (f"grey rule {CEILING}: the deposit's identity-only ceiling for SLAP-2M, whose "
         f"detector misses {MISS_RATE} of GT (Mouse-Dyad-10M 8.7%, ceiling {BMIMICA_CEILING}) — "
         f"a smaller gain", GREY),
        ("here than Mouse-Dyad-10M's 0.749 -> 0.861 is EXPECTED. It is NOT a bound on these "
         "curves: that ceiling was measured WITHIN-view on the PAF_3d_kalman pool,", GREY),
        (f"where these same 74 sessions score {cross_check_ref}, against "
         f"{all74_within:.3f} on the keeptrack_h5s pool this pass runs on", GREY),
        (f"({here_within:.3f} over the 42 multi-animal sessions drawn here) — a ceiling is a "
         f"property of a DETECTION POOL, and this is not that pool", GREY),
    ], "above", size=6.0, dy=0.052, xy=(0.022, 0.985), transform=fig.transFigure)

    footnote(axes[0],
             f"42 multi-animal sessions: cross-view IDF1 mean "
             f"{value(SHIPPED, 'multi_animal_only', 'idf1_cross'):.4f} -> "
             f"{value(IMPROVED, 'multi_animal_only', 'idf1_cross'):.4f}, median "
             f"{value(SHIPPED, 'multi_animal_only', 'idf1_cross_median'):.4f} -> "
             f"{value(IMPROVED, 'multi_animal_only', 'idf1_cross_median'):.4f}\n"
             f"the 32 one-animal sessions are EXCLUDED (0 switches, 0 misgrouped "
             f"detections under both configurations), so there is no pooled all-74 "
             f"number on this panel\n"
             f"ceiling {CEILING} because SLAP-2M's detector misses {MISS_RATE} of GT "
             f"(Mouse-Dyad-10M 8.7%, ceiling {BMIMICA_CEILING}); Mouse-Dyad-10M reference for this "
             f"arm: cross-view IDF1 0.749 -> 0.861\n"
             f"POOL CROSS-CHECK: {cross_check} -- the drawn ceiling was computed on the "
             f"other pool and does not bound these curves\n"
             f"6 cameras, full length, {d['total_camera_frames']:,} camera-frames, one "
             f"shared detection pool; sessions PAIRED across configurations")
    save(fig, 9, "a", "idf1_survival")


if __name__ == "__main__":
    main()
