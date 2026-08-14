#!/usr/bin/env python3
"""
Fig 9c -- every metric, by DIFFICULTY RATING and by ANIMAL COUNT, multi-animal SLAP-2M only.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHY STRATIFY AT ALL. 9a and 9b give the corpus-level answer, and it is split: the improved
configuration removes 30% of ID switches (2,826 -> 1,991) while cross-view IDF1 is flat
(0.8396 -> 0.8388) and mislabelled mass gets slightly WORSE (849,849 -> 861,224 misgrouped
detections, +1.3%). A corpus mean cannot say whether that is uniform or whether the method
helps in one regime and hurts in another, and those have opposite implications for shipping
it. So every metric is broken out twice -- by the master sheet's own difficulty rating (1-7)
and by the number of animals -- with the two configurations side by side in each stratum.

WHAT THE STRATA SAY, on the CORRECTED metric (2026-08-13; every misgrouped number this panel
drew before that date is retracted, including its by-difficulty and by-animal breakdowns,
which came from comparing tracker ids against GT track indices with no permutation).

  THE LEVEL IS NOW INTERNALLY CONSISTENT, which is itself the strongest evidence the fix
  worked: mislabelled mass rises monotonically with difficulty -- 0.0% of labelled
  detections at rating 2, 3.1% at 3, 10.0% at 4, 14.0% at 5, 23.8% at 6, 25.2% at 7 -- and
  with animal count (10.4% at two animals, 17.7% at four). The broken metric reported ~55%
  in every stratum, which is what a random permutation gives and carries no signal at all.

  AND IT IS POOL-DEPENDENT, WHICH ALSO REVERSES A RETRACTED CLAIM. On the other SLAP-2M
  detection pool (`predictions_h5s`, what Fig 7's b-g panels use;
  figs/out/fig9_slap2m_predictions.json) the same two configurations over the same 42
  sessions give misgrouped 303,987 -> 125,142 (-59%, 5.95% -> 2.45% of that pool's 5,110,008
  labelled detections) and cross-view IDF1 0.7040 -> 0.7212. The pre-correction report said
  this arm made mislabelled mass WORSE; on that pool the corrected metric says it makes it
  dramatically better, and the earlier direction was an artefact of the broken metric rather
  than a finding that has now changed. Nothing here generalises past `keeptrack_h5s`, the
  two pools' levels are not comparable, and there is no single corpus-level direction to
  report: the arm cuts switches on both pools and cuts MASS only on the predictions pool.

  corr3dWeight 12 DOES NOT TRANSFER FROM BMimica, and that is worth stating as a negative
  result rather than leaving out. On BMimica corr12 beat corr6 (371 vs 413 switches). On the
  other SLAP-2M pool it is neutral: 1,314 vs 1,312 switches, cross-view IDF1 0.7205 vs
  0.7212, misgrouped 122,191 vs 125,142 -- all within noise. It is not drawn on Figure 9
  (the keeptrack deposit has no corr12 cell as of this render); if a third series is ever
  added here, it must be labelled as corpus-specific and not as a general improvement.

  THE IMPROVED ARM'S EFFECT IS NOT UNIFORM, AND ITS SIGN FLIPS BETWEEN STRATA. Switches
  fall almost everywhere, hardest where they are worst (rating 7: 1,705 -> 1,032, -39%;
  rating 6: 366 -> 204, -44%). Mislabelled mass does not follow: it falls at rating 4
  (233,764 -> 210,161) and 6 (188,729 -> 111,324) and RISES at 3 (24,050 -> 47,929, +99%),
  5 (46,866 -> 81,962, +75%) and 7 (356,415 -> 409,824, +15%). By animal count the harm is
  concentrated in the three-animal sessions (104,429 -> 137,725, +32%, on n = 4). So the
  switch reduction redistributes the damage rather than removing it, and the hardest
  stratum -- 13 of the 42 sessions, rating 7 -- ends up with MORE mislabelled mass and
  fewer switches. That is the reason a switch count alone cannot decide whether to ship
  this arm.

ONE-ANIMAL SESSIONS ARE EXCLUDED FROM FIGURE 9 ENTIRELY, and the reason is measured: across
the 32 of them, BOTH configurations produce exactly 0 ID switches and 0 misgrouped
detections. There is nothing to associate across views when there is one animal, so there is
no cross-view tracking problem to get right or wrong. Including them changed only the
denominator -- inflating it by 66% (11,726,640 camera-frames over 74 sessions against
4,044,666 over the 42 multi-animal ones) and making every pooled rate look better than it is.

THE STRATA ARE RECOMPUTED, NOT READ. The deposit's own `by_difficulty` / `by_animals`
aggregates include the single-animal sessions, so they cannot be reused here: a difficulty
stratum that is half one-animal sessions would carry their camera-frames in its denominator
and none of their (zero) switches, roughly halving its apparent rate. `fig9_common.strata`
rebuilds each stratum from `per_session` filtered to `animals > 1` and sums that stratum's own
sessions out of `camera_frames_by_session`. The rebuild is checked against the deposit's
`multi_animal_only` aggregate at render time and the panel REFUSES to draw if they disagree.

READING IT. Rates (switches, misgrouped detections) are per 100,000 camera-frames of that
stratum, so strata are comparable to each other despite very different lengths.
IDF1/precision/recall are means over that stratum's sessions. `n` under each tick is how many
sessions the bar rests on, and it is very uneven: difficulty rating 1 has NO multi-animal
sessions at all (so that tick is absent, not zero), ratings 3, 5 and 6 rest on three sessions
each, and by animal count the three- and four-animal strata are n = 4 and n = 3. A bar
standing on three sessions is not the same evidence as one standing on thirteen, which is why
the count is under every tick rather than in a caption.

Source: figs/out/fig9_slap2m.json (figs/fig9_slap2m.py).

    python3 figs/panels/fig9_03_strata.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.ticker import FuncFormatter, MaxNLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (GREY, INK, MUTED, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, use)

from fig9_common import (COLOUR, IMPROVED, SHIPPED, SHORT,  # noqa: E402
                         corpus_shape, load9, misgrouped_lines, strata)

PANEL = "fig9c"

#: Vertical step of the key lines, in figure fractions. 6 pt type on a 96 mm panel needs
#: ~2.1 mm of leading; 0.040 x 96 = 3.8 mm, which keeps the lines apart without eating the
#: plots. The reserved band is this times the number of lines ACTUALLY built.
KEY_DY = 0.040

#: (deposit key, axis label, is a rate). Order is the drawing order across the row.
METRICS = [
    ("idf1_cross", "cross-view IDF1", False),
    ("idp_cross", "identity precision", False),
    ("idr_cross", "identity recall", False),
    ("switches_per_100k", "ID switches / 100k", True),
    # DETECTIONS, and the label says so. "misgrouped / 100k" over a camera-frame
    # denominator invited exactly the reading that broke this metric's first version: these
    # are DETECTIONS (one animal, one camera, one frame) and there are ~1.8 labelled ones
    # per camera-frame, so this axis legitimately runs past 100,000 per 100,000.
    ("misgrouped_per_100k", "misgrouped detections / 100k", True),
]
STRATA = [("difficulty", "difficulty rating"), ("animals", "animals in the session")]


def main():
    use()
    d, cells = load9(PANEL)

    rows = []
    st = {}
    for key, _lab in STRATA:
        st[key] = strata(cells, key)
        # The rebuild MUST reproduce the deposit's own multi-animal aggregate. If it does
        # not, the stratification is wrong and every bar on this panel is wrong with it.
        for cfg in (SHIPPED, IMPROVED):
            ref = cells[cfg]["multi_animal_only"]
            got_sw = sum(v["switches"] for v in st[key][cfg].values())
            got_mis = sum(v["misgrouped"] for v in st[key][cfg].values())
            if got_sw != ref["switches"] or got_mis != ref["misgrouped"]:
                sys.exit(f"{PANEL}: recomputed {key} strata sum to {got_sw} switches / "
                         f"{got_mis} misgrouped but the deposit's multi_animal_only says "
                         f"{ref['switches']} / {ref['misgrouped']} for {cfg!r}. The "
                         f"stratification is wrong; refusing to draw.")
        for cfg in (SHIPPED, IMPROVED):
            for k, v in st[key][cfg].items():
                rows.append(dict(stratum_kind=key, stratum=k, config=cfg, **v))
    deposit(pd.DataFrame(rows), 9, "fig9c_strata.csv")

    # 7 difficulty levels against 4 animal counts, so the difficulty column needs more
    # width or its ticks collide -- the same fix the previous version of this panel needed.
    fig, axes = grid(2, len(METRICS), span="full", row=96.0,
                     gridspec_kw={"height_ratios": [1, 1]})

    for ri, (key, xlabel) in enumerate(STRATA):
        levels = sorted(set(st[key][SHIPPED]) | set(st[key][IMPROVED]))
        for ci, (metric, ylabel, is_rate) in enumerate(METRICS):
            ax = axes[ri][ci]
            x = np.arange(len(levels))
            seen = []
            for oi, cfg in enumerate((SHIPPED, IMPROVED)):
                vals = [st[key][cfg].get(L, {}).get(metric, np.nan) for L in levels]
                seen += [v for v in vals if np.isfinite(v)]
                ax.bar(x + (oi - 0.5) * 0.38, vals, width=0.36, color=COLOUR[cfg],
                       lw=0, zorder=3, alpha=1.0 if cfg == IMPROVED else 0.55)
            ax.set_xticks(x)
            ns = [st[key][SHIPPED].get(L, {}).get("n_sessions", 0) for L in levels]
            ax.set_xticklabels([f"{L}\n{n}" for L, n in zip(levels, ns)], fontsize=5.4,
                               linespacing=1.15)
            ax.tick_params(axis="y", labelsize=5.8)
            if ri == 1:
                ax.set_xlabel(xlabel + "\nn sessions", fontsize=6.2)
            else:
                ax.set_xlabel(xlabel + "\nn sessions", fontsize=6.2)
            if ci == 0:
                ax.set_ylabel(("by difficulty" if ri == 0 else "by animal count"),
                              fontsize=6.8)
            ax.set_title(ylabel, fontsize=6.2, pad=2.0, color=INK)
            if not is_rate:
                ax.set_ylim(0, 1.05)
            elif max(seen or [0]) > 10_000:
                # Six-digit tick labels ("150000") at 5.8 pt on a 30 mm axes crowd the
                # column and push the y label off it; the misgrouped axis is the only one
                # that gets there. Same "50k" formatter 9b uses, for the same reason.
                ax.yaxis.set_major_formatter(
                    FuncFormatter(lambda v, _p: f"{v / 1000:g}k" if v else "0"))
                ax.yaxis.set_major_locator(MaxNLocator(4))

    ma = {c: cells[c]["multi_animal_only"] for c in (SHIPPED, IMPROVED)}
    vf, cf, det_lab = corpus_shape(d, cells[SHIPPED])
    # SIZE AND LINE LENGTH ARE MEASURED, not defaulted. text_legend's bare "above" starts at
    # x = 0.14 of the figure at the rcParams size, which leaves ~105 characters before a
    # 180 mm panel runs out -- and the definition of `misgrouped` does not fit in that. At
    # 6 pt from x = 0.022 the budget is ~135 characters, which it does.
    entries = [
        (f"{SHORT[SHIPPED]} (pale)", COLOUR[SHIPPED]),
        (f"{SHORT[IMPROVED]} (solid)", COLOUR[IMPROVED]),
        (f"42 multi-animal SLAP-2M sessions: {vf:,} video frames × 6 cameras = {cf:,} "
         f"camera-frames, holding {det_lab:,} labelled detections. The 32 one-animal "
         f"sessions are", MUTED),
        ("EXCLUDED: 0 switches and 0 misgrouped detections under both configurations, so "
         "pooling them changed only the denominator", MUTED),
        # 100, not the ~135 the width allows: at 132 the definition wrapped to two long
        # lines and left "internally" alone on a third, which reads as a dropped line.
    ] + misgrouped_lines(100, MUTED)
    text_legend(axes[0][0], entries, "above", size=6.0, dy=KEY_DY, xy=(0.022, 0.985),
                transform=fig.transFigure)
    # Reserve the band from the key that was BUILT, not from a hardcoded count: the
    # misgrouped definition is wrapped, so its line count follows the text.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (KEY_DY * len(entries) + 0.02)))

    footnote(axes[0][0],
             f"corpus totals: switches {ma[SHIPPED]['switches']:,} -> "
             f"{ma[IMPROVED]['switches']:,} "
             f"({ma[SHIPPED]['switches_per_100k']:.1f} -> "
             f"{ma[IMPROVED]['switches_per_100k']:.1f} per 100k); misgrouped DETECTIONS "
             f"{ma[SHIPPED]['misgrouped']:,} -> {ma[IMPROVED]['misgrouped']:,} "
             f"({100 * ma[SHIPPED]['misgrouped'] / ma[SHIPPED]['det_labelled']:.2f}% -> "
             f"{100 * ma[IMPROVED]['misgrouped'] / ma[IMPROVED]['det_labelled']:.2f}% of "
             f"labelled detections); cross-view IDF1 {ma[SHIPPED]['idf1_cross']:.4f} -> "
             f"{ma[IMPROVED]['idf1_cross']:.4f}\n"
             f"misgrouped is counted through the OPTIMAL tracker-id -> GT-index permutation "
             f"per (session, camera), as IDF1 does internally; every misgrouped number "
             f"drawn before 2026-08-13 compared the two id systems directly and is "
             f"retracted\n"
             "strata are RECOMPUTED over multi-animal sessions only and checked against "
             "that total at render time -- the deposit's own by_difficulty/by_animals "
             "include the one-animal sessions and cannot be reused here\n"
             "rates are per 100,000 camera-frames OF THAT STRATUM, so strata of very "
             "different length are comparable; IDF1/precision/recall are stratum means\n"
             f"denominator {ma[SHIPPED]['camera_frames']:,} camera-frames over 42 "
             "sessions x 6 cameras, full length, one shared detection pool")
    save(fig, 9, "c", "strata")


if __name__ == "__main__":
    main()
