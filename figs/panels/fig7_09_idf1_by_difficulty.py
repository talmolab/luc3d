#!/usr/bin/env python3
"""
Fig 7s3 (SUPPLEMENTARY) -- within-view IDF1 of the three trackers, by SLAP-2M
difficulty stratum.

THE DIFFICULTY COMPANION TO 7c'S ANIMAL-COUNT SPLIT. Fig 7a gives the corpus means
(LUC3D 0.7520, SLEAP 0.6614, ByteTrack 0.5274 over 74 sessions) and 7c splits the
paired LUC3D-SLEAP difference by animal count; this panel splits the three trackers'
absolute levels by the corpus's own 1-7 difficulty rating, which is where the PI's
"by difficulty" question actually lives.

WHAT IT SHOWS. All three trackers fall with difficulty, and the ORDER is stable in
six of seven strata: LUC3D >= SLEAP >= ByteTrack everywhere except difficulty 1,
where ByteTrack (0.9226) edges past... nothing -- it stays third, but within 0.005 of
SLEAP (0.9272), because with one animal (difficulty 1 is single-animal only, see Fig
6f) within-view tracking is detection coverage, not identity. The LUC3D-SLEAP gap is
NOT constant: it opens widest in the mid strata (0.159 at rating 3, 0.195 at 5) and
narrows at both ends (0.049 at 1, 0.040 at 6, 0.044 at 7) -- easy sessions leave no
room and the hardest sessions drown both trackers in detector misses (Fig 6c: the
miss rate, not the error, is what difficulty costs).

WHY THE SOURCE CSV AND NOT THE DEPOSIT'S OWN ARRAYS. `fig7_variant_best.json
slap2m.within_view.<tracker>.per_session` stores each tracker's 74 session values
SORTED (fig3_trackers.py:197), so they cannot be joined to anything -- the session
axis is gone. This panel therefore reads the deposit's own declared `slap2m.source`
CSV (one row per session x camera x tracker, carrying the master sheet's difficulty
rating on every row) and REFUSES TO DRAW unless its recomputed corpus means
reproduce the deposit's `within_view` means to 1e-9, so it cannot silently drift
from the figure it supplements. The difficulty ratings were also checked against
`fig6_detections.json` at build time: all 74 sessions agree.

AGGREGATION, stated because two conventions coexist in the deposit: session-level
IDF1 is the MEAN over that session's camera-sessions (the `within_view` convention,
fig3_trackers.py `sess_mean`), and a stratum is the mean over its sessions -- NOT the
camera-session-weighted pool that `by_animals` uses. n per stratum is printed under
the ticks; the strata are unbalanced (n = 4 at difficulty 6 against 13 at 2, 4, 7).

Source: figs/out/tmp/fig7bg_rescore/_eval_baseline__shipped.csv (= the deposit's
`slap2m.source`; LUC3D is the SHIPPED tracker, SLEAP is the corrected series),
cross-checked against figs/out/fig7_variant_best.json `slap2m.within_view`.

    python3 figs/panels/fig7_09_idf1_by_difficulty.py
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, MUTED, deposit, entity, footnote, panel,  # noqa: E402
                       save, text_legend, use)

FIGS = Path(__file__).resolve().parent.parent
#: The deposit's own declared `slap2m.source` (checked below against the deposit's
#: absolute path, so a re-run that moves the CSV fails loudly here).
SOURCE = FIGS / "out" / "tmp" / "fig7bg_rescore" / "_eval_baseline__shipped.csv"

TRACKERS = ["luc3d", "sleap", "bytetrack"]
LABEL = {"luc3d": "LUC3D", "sleap": "SLEAP", "bytetrack": "ByteTrack"}


def build():
    """Per (tracker, difficulty): n sessions, mean and s.d. of session-level IDF1."""
    if not SOURCE.exists():
        sys.exit(f"missing {SOURCE}\n  fig7_slap2m_rescore.py has not been run here.")
    per = defaultdict(lambda: defaultdict(list))   # tracker -> session -> cam idf1s
    diff = {}
    with SOURCE.open() as f:
        for r in csv.DictReader(f):
            per[r["tracker"]][r["session"]].append(float(r["idf1"]))
            diff[r["session"]] = int(r["difficulty"])

    best = load("fig7_variant_best.json")["slap2m"]
    if Path(best["source"]) != SOURCE:
        sys.exit(f"fig7_variant_best.json slap2m.source is {best['source']}, "
                 f"not {SOURCE}; refusing to draw from a CSV the deposit no "
                 f"longer points at.")
    sess_idf1 = {t: {s: mean(v) for s, v in per[t].items()} for t in TRACKERS}
    # The gate: the recomputation MUST reproduce the deposit's corpus means, or the
    # strata below are strata of something other than Fig 7a's metric.
    for t in TRACKERS:
        got = mean(sess_idf1[t].values())
        ref = best["within_view"][t]["mean"]
        if abs(got - ref) > 1e-9:
            sys.exit(f"recomputed corpus within-view IDF1 for {t} is {got:.9f} but "
                     f"the deposit says {ref:.9f}; refusing to draw.")

    rows = []
    for t in TRACKERS:
        byd = defaultdict(list)
        for s, v in sess_idf1[t].items():
            byd[diff[s]].append(v)
        for d in sorted(byd):
            v = byd[d]
            # QUARTILES, NOT +/- s.d. (review round 3): a symmetric s.d. whisker on
            # a [0, 1] metric asserted IDF1 up to 1.14 on the artwork. p25/p75 stay
            # inside the metric's range by construction and are the deposit
            # convention everywhere else in the set. The s.d. is kept as a CSV
            # column; it is just not drawn as a bar.
            rows.append({"tracker": t, "difficulty": d, "n_sessions": len(v),
                         "idf1_mean": float(np.mean(v)),
                         "idf1_median": float(np.median(v)),
                         "idf1_p25": float(np.percentile(v, 25)),
                         "idf1_p75": float(np.percentile(v, 75)),
                         "idf1_sd": float(np.std(v)) if len(v) > 1 else 0.0})
    return pd.DataFrame(rows), {t: best["within_view"][t]["mean"] for t in TRACKERS}


def main():
    use()
    df, corpus = build()
    deposit(df, 7, "fig7s3_idf1_by_difficulty.csv")

    fig, ax = panel("half", "std", key=3)

    # Trackers dodge within the tick: at ratings 3 and 6 two means sit within 0.03
    # of each other, and three coincident error bars overprint into one unreadable
    # glyph.
    dodge = {"luc3d": -0.16, "sleap": 0.0, "bytetrack": 0.16}
    for t in TRACKERS:
        g = df[df.tracker == t].sort_values("difficulty")
        c = entity(t)
        xs = g.difficulty + dodge[t]
        # ANCHORED ON THE MEDIAN, not the mean: at strata where the mean falls
        # outside [p25, p75] (skewed cells with n = 4) a mean-anchored quartile bar
        # has a negative arm. Median-in-IQR holds by definition.
        anchor = g.idf1_median
        yerr = np.vstack([anchor - g.idf1_p25, g.idf1_p75 - anchor])
        ax.errorbar(xs, anchor, yerr=yerr, fmt="none",
                    ecolor=c, elinewidth=0.7, capsize=1.4, capthick=0.7, zorder=3)
        # The line and markers follow the MEDIAN too, so the mark and its interval
        # are one statistic; the mean stays in the CSV.
        ax.plot(xs, anchor, color=c, lw=1.8, zorder=4)
        ax.plot(xs, anchor, "o", color=c, ms=4.0, mec="white",
                mew=0.8, zorder=5)

    ticks = sorted(df.difficulty.unique())
    ns = {d: int(df[df.difficulty == d].n_sessions.iloc[0]) for d in ticks}
    # n IS DATA, NOT CAPTION TEXT: the strata run n = 4 to 13, so a mean at
    # difficulty 6 rests on a third of the evidence of its neighbours, and the count
    # goes under every tick rather than into the legend file.
    ax.set_xticks(ticks)
    ax.set_xticklabels([f"{d}\n{ns[d]}" for d in ticks], linespacing=1.2)
    ax.set_xlabel("difficulty rating\nn sessions", labelpad=2)
    ax.set_ylabel("within-view IDF1")
    # Quartile whiskers cannot leave [0, 1], so the metric's own range is the axis.
    ax.set_ylim(0, 1.0)
    # MUTED for the label, GREY for the rule: GREY (#B3B3B3) is 2.1:1 on white,
    # below the floor this set holds text to (see the MUTED note in src/style.py).
    # the ceiling rule and its label went with the s.d. whiskers (round 3)

    text_legend(ax, [(LABEL[t], entity(t)) for t in TRACKERS], "above")
    footnote(ax,
             "session-level IDF1 = mean over that session's camera-sessions; a "
             "stratum is the mean ± 1 s.d. over its sessions\n"
             "corpus means (all 74 sessions): "
             + ", ".join(f"{LABEL[t]} {corpus[t]:.4f}" for t in TRACKERS)
             + " — reproduced from the source CSV to 1e-9 before drawing\n"
             "difficulty 1 is single-animal only (Fig 6f), so its within-view IDF1 "
             "is detection coverage, not identity")
    save(fig, 7, "s3", "idf1_by_difficulty")


if __name__ == "__main__":
    main()
