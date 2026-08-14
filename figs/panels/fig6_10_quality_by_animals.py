#!/usr/bin/env python3
"""
Fig 6s4 (SUPPLEMENTARY) -- per-view keypoint miss rate against difficulty, one line
per animal-count stratum, on the ORDERED `level()` ramp.

THE SAME CELLS AS PANEL 6d (`fig6_07_animal_count.py`), REDRAWN ON THE HOUSE RAMP.
6d predates `level()` and colours its four counts on a local salmon ramp; this
supplement is the same measurement with the set-wide convention for ordered strata
(`level(i, n)` -- see the rule above ENTITY in src/style.py), so it can sit beside
the other by-difficulty / by-animal supplementaries without minting hues. The cell
statistics are identical to 6d's deposit up to the shared build.

WHAT IT SHOWS (same reading as 6d, stated so this file stands alone): difficulty
survives the animal-count control -- within 1 animal the miss rate rises 5.3 -> 16.7 %
over ratings 1-5, within 2 animals 10.9 -> 57.8 % over 2-7 -- and at matched
difficulty more animals is worse (rating 4: 11.9 / 19.0 / 39.5 % for 1 / 2 / 4
animals). Neither variable explains the rise alone.

THE RULES 6d LEARNT THE HARD WAY ARE KEPT: a count needs THREE occupied difficulty
cells before its markers are joined by a line (3 animals occupies ratings 3 and 7
only -- a segment across four empty ratings is the most confident-looking mark on
the panel and rests on four sessions); a cell resting on ONE session is drawn hollow
(1 animal at difficulty 6, 66.1 %, n = 1; 3 animals at difficulty 7, n = 1); error
bars are +-1 s.d. between sessions where n > 1.

MISS RATE IS PER-VIEW BY CONSTRUCTION: `fig6_detections.py` compares every
ground-truth keypoint IN EVERY CAMERA VIEW against the shared detection pool, so a
keypoint missed in one view and found in another counts once missed, once found.

Source: figs/out/fig6_detections.json `sessions` (74 sessions; the `by_difficulty` /
`by_animals` aggregates marginalise the confound this panel exists to split).
NOT figs/out/fig6.json, which holds the corpus inventory (rigs, skeleton, per-session
frame counts) and no detection-quality measurement at all.

    python3 figs/panels/fig6_10_quality_by_animals.py
"""
import sys
from pathlib import Path

import matplotlib.transforms as mtransforms
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import deposit, footnote, level, panel, save, use  # noqa: E402

MARKS = {1: "o", 2: "s", 3: "^", 4: "D"}

#: Key line pitch in POINTS, pinned (not axes fractions) so the key's leading does
#: not depend on the panel height -- the exact failure fig6_07 documents.
KEY_DY_PT = 6.4


def build(sessions):
    """Per (animals, difficulty) cell: n, mean and s.d. of the per-session miss rate.

    Session-level mean, not a keypoint-weighted pool -- the claim is about sessions
    and the spread on the artwork must be between-session (same convention as 6d).
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
    deposit(df, 6, "fig6s4_quality_by_animals.csv")

    counts = sorted(df.animals.unique())
    colour = {a: level(i, len(counts)) for i, a in enumerate(counts)}
    totals = {a: int(df[df.animals == a].n_sessions.sum()) for a in counts}

    fig, ax = panel("half", "std")
    for a in counts:
        g = df[df.animals == a].sort_values("difficulty")
        c = colour[a]
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
    ax.set_ylabel("keypoints missing\nper view (%)")
    ax.set_ylim(0, float((df.miss_mean_pct + df.miss_sd_pct).max()) * 1.12)

    # Key in the genuinely empty upper-left corner, with each stratum's own MARKER
    # GLYPH drawn beside its name: two of the four counts appear as bare markers with
    # no line, so shape is the only thing that identifies them. Stacked in points --
    # see KEY_DY_PT.
    kt = mtransforms.offset_copy(ax.transAxes, fig=fig, y=0, units="points")
    for i, a in enumerate(counts):
        t = mtransforms.offset_copy(kt, fig=fig, y=-i * KEY_DY_PT, units="points")
        ax.plot([0.035], [0.965], MARKS.get(a, "o"), transform=t, ms=3.6,
                color=colour[a], clip_on=False, zorder=6)
        ax.text(0.075, 0.965, f"{a} animal{'s' if a > 1 else ''}  n = {totals[a]}",
                transform=t, ha="left", va="center", color=colour[a],
                fontsize=6.0, fontweight="bold")

    footnote(ax,
             "hollow marker: n = 1 session · ±1 s.d. between sessions · a count is "
             "joined by a line only where it occupies ≥ 3 difficulty cells\n"
             "same cells as Fig 6d, redrawn on the ordered level() ramp; "
             f"n = {', '.join(str(totals[a]) for a in counts)} sessions "
             f"for {', '.join(str(a) for a in counts)} animals")
    save(fig, 6, "s4", "quality_by_animals")


if __name__ == "__main__":
    main()
