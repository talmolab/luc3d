#!/usr/bin/env python3
"""
Fig 6d -- the animal-count control for panel c: the SAME trend, WITHIN each count.

THE CONTROL PANEL c NEEDS. Difficulty and animal count are confounded in this corpus
(difficulty 1 is twelve single-animal sessions; difficulty 7 is twelve two-animal
ones), so c's rise could be "more animals" rather than "harder session". The control
is therefore to re-run c's miss rate against difficulty INSIDE each animal count. All
four counts are drawn and all 74 sessions enter: 1 animal n = 32, 2 animals n = 35,
3 animals n = 4, 4 animals n = 3.

WHAT IT SHOWS, stated as the data actually reads: difficulty survives the control --
within 1 animal the miss rate goes 5.3 -> 16.8 % over ratings 1-5, and within 2
animals 10.7 -> 58.1 % over ratings 2-7 -- and at MATCHED difficulty more animals is
worse (at rating 4: 12.4 % / 19.0 % / 39.6 % for 1 / 2 / 4 animals). So panel c is
not purely an animal-count effect, and it is not purely a difficulty effect either;
neither reading is available and the panel says so.

WHY THIS REPLACED A MISS-RATE-VS-ANIMAL-COUNT PLOT, which is the more instructive
half of this file's history. That version was wrong in three separate ways:

  1. **Its docstring contradicted its own data.** It claimed "the miss rate rises
     with animal count too" and plotted 22.0 -> 24.8 -> 17.0 %: non-monotone, with
     the 4-animal cell the LOWEST of the three. Nothing on the panel supported
     "rises".
  2. **It silently dropped 43 % of the corpus.** It read
     `out/fig6_difficulty.json by_animals`, which has cells for 2, 3 and 4 only, so
     the 32 single-animal sessions were absent, with no note anywhere.
  3. **It read the wrong deposit.** See below.

WHICH DEPOSIT, AND WHY -- `fig6_detections.json`, not `fig6_difficulty.json`.
Both files deposit a `by_animals` table and they disagree on the 2-animal miss rate
by half (21.95 % vs 33.19 %). That is NOT two computations of one quantity
disagreeing; they are different measurements over different populations, and only one
of them belongs on this figure:

  fig6_difficulty.json   42 sessions, `_multi_master.tsv`, stride 100, and NO
                         detection pool -- it compares the PROOFREAD labels against
                         the reprojected proofread 3D, i.e. it measures the
                         reconstruction's own 2D-to-3D residual and per-camera label
                         coverage. Legacy called it a "circular comparison" and kept
                         it strictly as a fallback (`legacy/fig6.py:35-42`).
  fig6_detections.json   74 sessions, `detections_only_master_sheet.tsv`, stride 120,
                         detection pool `outputs/keeptrack_h5s` -- the benchmark's
                         shared identity-stripped RAW detections. This is the
                         measurement panels c and f already plot.

The choice is forced twice over: a control for panel c must be the same measurement
as panel c stratified differently, or it controls nothing; and it is the only one of
the two that covers the whole 74-session corpus. The disagreement itself is a real
finding worth a line in the caption -- the raw detector misses ~50 % more keypoints on
two-animal sessions than the proofread-vs-reprojection residual suggests, which is
what you would expect if the residual path cannot see a detection that never fired.

AND THE MARGINAL RELATION IS NON-MONOTONE -- printed under the axis rather than
buried. Pooled by count alone, `fig6_detections.json by_animals` gives 12.4 / 33.2 /
45.0 / 39.6 % for 1 / 2 / 3 / 4 animals. It rises steeply to three animals and then
comes DOWN at four. Do not describe that as "rises with animal count": the 4-animal
cell is three sessions, all at difficulty 4, so its marginal is a difficulty average
as much as an animal-count one -- which is exactly the confound this panel exists to
expose, visible in the marginal number itself.

Cells resting on a single session are drawn HOLLOW so they cannot be read as
measurements (1 animal at difficulty 6, n = 1, 66.9 %; 3 animals at difficulty 7,
n = 1). The previous version printed that same key while no cell in it was hollow.
Error bars are +-1 s.d. between sessions wherever n > 1. A count with fewer than THREE
occupied difficulty cells gets bare markers and no connecting line: 3 animals occupies
only ratings 3 and 7, and joining those two drew the most confident-looking mark on
the panel across four ratings that contain no data.

Colour is an ORDINAL RAMP on panel c's own miss-rate salmon, not four categorical
hues: animal count is ordered, and this figure already spends teal, salmon and
periwinkle on c's three quantities -- a fourth categorical set on the facing panel
would collide with those meanings (review finding C3).

Source: figs/out/fig6_detections.json `sessions` (per-session) and `by_animals`.

    python3 figs/panels/fig6_07_animal_count.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import deposit, footnote, panel, save, use  # noqa: E402

#: animal count -> colour. Light-to-dark on SALMON (= panel c's miss-rate hue); every
#: step is at least as dark as SALMON itself, so none is less legible than type the
#: rest of the set already sets in that colour.
RAMP = {1: "#FC8D62", 2: "#E0653C", 3: "#B24420", 4: "#7A2A0E"}
MARKS = {1: "o", 2: "s", 3: "^", 4: "D"}


def build(sessions):
    """Per (animals, difficulty) cell: n, mean and s.d. of the per-session miss rate.

    Session-level mean, not a keypoint-weighted pool: the claim is about sessions,
    the spread that goes on the artwork has to be between-session, and legacy
    computed it the same way (`legacy/fig6.py:302-311`).
    """
    rows = []
    for a in sorted({s["animals"] for s in sessions if s.get("animals")}):
        for d in sorted({s["difficulty"] for s in sessions
                         if s.get("difficulty") is not None}):
            v = [s["miss_rate"] * 100.0 for s in sessions
                 if s.get("animals") == a and s.get("difficulty") == d
                 and s.get("miss_rate") is not None]
            if v:
                rows.append({"animals": a, "difficulty": d, "n_sessions": len(v),
                             "miss_mean_pct": float(np.mean(v)),
                             "miss_sd_pct": float(np.std(v)) if len(v) > 1 else 0.0})
    return pd.DataFrame(rows)


def main():
    use()
    det = load("fig6_detections.json")
    df = build(det["sessions"])
    deposit(df, 6, "fig6d_animal_count.csv")

    ba = det["by_animals"]
    counts = sorted(df.animals.unique())
    totals = {a: int(ba[str(a)]["n_sessions"]) for a in counts if str(a) in ba}

    fig, ax = panel("half", 38.0)
    for a in counts:
        g = df[df.animals == a].sort_values("difficulty")
        c = RAMP.get(a, "#7A2A0E")
        # A LINE NEEDS THREE CELLS, not two. With `len(g) > 1` the 3-animal count
        # (occupied at difficulty 3 and 7 only) drew one straight segment across four
        # empty ratings -- the most confident-looking mark on the panel, supported by
        # four sessions and interpolating a range that contains no data at all.
        if len(g) >= 3:
            ax.plot(g.difficulty, g.miss_mean_pct, color=c, lw=1.6, zorder=3)
        multi = g[g.n_sessions > 1]
        if len(multi):
            ax.errorbar(multi.difficulty, multi.miss_mean_pct,
                        yerr=multi.miss_sd_pct, fmt="none", ecolor=c,
                        elinewidth=0.7, capsize=1.4, capthick=0.7, zorder=4)
        for _, r in g.iterrows():
            solo = r.n_sessions <= 1
            ax.plot([r.difficulty], [r.miss_mean_pct], MARKS.get(a, "o"), ms=4.2,
                    mfc="white" if solo else c, mec=c, mew=1.1, zorder=5)

    ax.set_xticks(sorted(df.difficulty.unique()))
    ax.set_xlabel("difficulty rating")
    # Two lines: a one-line rotated label is ~30 mm of type against a ~22 mm axis at
    # this row height, so it overflows the axes and the page clips its "(%)".
    ax.set_ylabel("keypoints\nmissing (%)")
    ax.set_ylim(0, float((df.miss_mean_pct + df.miss_sd_pct).max()) * 1.10)

    # Key INSIDE the axes, upper left: the data runs low-left to high-right, so that
    # corner is the one genuinely empty region, and `panel(key=4)` would otherwise
    # spend ~9 mm of a 39 mm panel on a reserved band.
    #
    # WITH ITS OWN MARKER GLYPH, drawn rather than typed. `text_legend` names series
    # by colour alone, which is fine for two hues and not fine for four steps of one
    # ordinal ramp -- and two of these four counts appear as bare markers with no
    # line, so shape is the only thing that identifies them.
    for i, a in enumerate(counts):
        yk = 0.965 - i * 0.098
        ax.plot([0.035], [yk], MARKS.get(a, "o"), transform=ax.transAxes, ms=3.6,
                color=RAMP.get(a, "#7A2A0E"), clip_on=False, zorder=6)
        ax.text(0.075, yk, f"{a} animal{'s' if a > 1 else ''}  n = "
                           f"{totals.get(a, 0)}", transform=ax.transAxes,
                ha="left", va="center", color=RAMP.get(a, "#7A2A0E"),
                fontsize=6.0, fontweight="bold")
    marg = ", ".join(f"{ba[str(a)]['miss_rate'] * 100:.1f}" for a in counts
                     if str(a) in ba)
    footnote(ax,
             "hollow marker: n = 1 session · ±1 s.d. between sessions\n"
             f"pooled by count alone: {marg} % — NON-monotone", size=5.4)
    save(fig, 6, "d", "animal_count")


if __name__ == "__main__":
    main()
