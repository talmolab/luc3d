#!/usr/bin/env python3
"""
Fig 6e -- cross-view identity performance (IDF1) across the corpus's own 1-7
difficulty rating: one dot per session, a box-and-whisker per stratum.

REPLACES the per-camera detection-quality bar chart (Eric, 2026-08-16). The old
panel's numbers are not lost: its plot-ready table remains deposited at
`data/fig5/fig6e_percam_quality.csv`, and its script is superseded by this file
(same panels/fig6_11_* slot, new slug).

WHAT THE PANEL CLAIMS. Identity performance HOLDS across most of the difficulty
range and degrades only in the hardest strata: the shipped tracker's per-stratum
median cross-view IDF1 stays at or above ~0.92 through difficulty 5 (0.989 at 2,
0.923 at 3, 0.969 at 4, 0.925 at 5), then falls to 0.829 at 6 and 0.649 at 7 --
and the difficulty-7 stratum spans 0.41-0.90 across its 13 sessions, so the
hardest rating is also the most heterogeneous. Read with 6g directly below: the
detector's miss rate rises ~11x over the same rating, so what degrades identity
at high difficulty is dominated by detections not being there to associate.

COHORT: the 42 MULTI-ANIMAL SLAP-2M sessions, exactly Fig 9a's cohort and for
exactly its reason -- 32 of the 74 sessions hold ONE animal, where there is
nothing to associate across views and every tracker scores near-perfectly
(Fig 7d), so pooling them would dilute the panel with 32 near-1.0 dots that
measure nothing. Difficulty 1 is single-animal ONLY (6h's table says so), so
that stratum is structurally empty here and the axis says n = 0 rather than
hiding the tick.

THE JOIN. IDF1 comes from `out/fig9_slap2m.json` -- the `cross_idf1` field of
the SHIPPED config's `per_session` records, the same field Fig 9a draws its
shipped survival curve from. Difficulty comes from fig6's own deposit,
`out/fig6_detections.json` `sessions[].difficulty` (the master sheet's 1-7
rating, what 6g/6h stratify by), joined on the session id string. The join is
GUARDED, not assumed: the build fails loudly if any fig9 session is missing
from fig6's table, and cross-checks the `difficulty` field fig9's records also
carry against fig6's -- the two deposits read the same master sheet through
different scripts, and a silent disagreement would mean one of them is stale.
At build time: 74/74 sessions join, 0 mismatches, 42 multi-animal drawn.

BOX-AND-WHISKER + DOTS, not a pooled line: the strata are n = 3 to 13 sessions of
similar length, so a detection-weighted pool would let one long session carry a
stratum while looking like a summary of it. The per-stratum summary was a bare
median tick until 2026-08-18 (Eric: "can we make fig 6e a box and whisker also"),
which said where the middle sat but nothing about the spread around it -- and
spread is half of what this panel claims, since difficulty 7 is both the lowest
and by far the widest stratum. The box is 10e's house form exactly: median line +
IQR box, whiskers to 1.5x IQR, `showfliers=False` because EVERY session is drawn
as a faint dot beside its box anyway -- so a dot means one session here, the same
as in 6c/6d, rather than the boxplot default's "outlier only", which would read as
a third encoding. 6g's n is still printed per stratum. TEAL because the series is
LUC3D's own performance (the set-wide entity rule).

A BOX NEEDS A BOX'S WORTH OF SESSIONS. Ratings 3, 5 and 6 hold n = 3, where the
quartiles ARE the three observations and the whiskers have nothing left to reach;
the box is drawn anyway because suppressing it for the small strata would make the
form itself encode n, which the printed n already does -- but the median line goes
back to TEAL wherever the IQR is too thin to carry a white one (10e's rule), so a
degenerate stratum looks degenerate rather than looking like a summary.

Source: figs/out/fig9_slap2m.json (sync_stale20_dist25 cell = the fresh
        anchor, per_session[].cross_idf1),
        figs/out/fig6_detections.json (sessions[].difficulty).

    figs/.venv/bin/python figs/panels/fig6_11_idf1_by_difficulty.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import MUTED, TEAL, deposit, footnote, panel, save, use  # noqa: E402

#: The IDF1 source cell. FRESH ANCHOR (2026-08-26, Eric: "rerun with the new
#: defaults ... stale 20 and distanceThresh 25"). The deposit's `shipped` cell is
#: the NO-EVICTION tracker -- the configuration this paper retired -- and drawing
#: it here put the manuscript's dataset figure on one tracker while Fig 3 and
#: Fig 6A were on another. `sync_stale20_dist25` is {sync, stale 20} +
#: distanceThreshold 25, the fresh anchor every other placed panel now carries.
#: The old cell is still in the deposit; nothing was re-measured for this change.
SHIPPED = "sync_stale20_dist25"

#: The full rating scale, drawn even where a stratum is empty -- 6c/6g/6h all run 1-7,
#: and this panel sits in the same figure, so its axis must mean the same thing.
DIFFICULTIES = list(range(1, 8))


def build():
    """Per-session (session, difficulty, animals, cross_idf1) for the 42 multi-animal
    sessions, with the join guarded rather than assumed."""
    f9 = load("fig9_slap2m.json")
    cells = {c["config"]: c for c in f9["cells"]}
    if SHIPPED not in cells:
        sys.exit(f"fig6e: out/fig9_slap2m.json has no {SHIPPED!r} cell "
                 f"(present: {sorted(cells)})")
    ps = cells[SHIPPED]["per_session"]

    diff = {q["session"]: q["difficulty"]
            for q in load("fig6_detections.json")["sessions"]}

    missing = [q["session"] for q in ps if q["session"] not in diff]
    if missing:
        sys.exit(f"fig6e: {len(missing)} fig9 session(s) not in "
                 f"out/fig6_detections.json sessions -- {missing}; refusing to "
                 f"draw a silently partial join.")
    # fig9's per-session records carry their own `difficulty` (read from the same
    # master sheet by a different script). If the two deposits disagree, one is
    # stale, and drawing either would put an unattributable number on the artwork.
    clash = [(q["session"], q["difficulty"], diff[q["session"]])
             for q in ps if int(q["difficulty"]) != int(diff[q["session"]])]
    if clash:
        sys.exit(f"fig6e: difficulty disagrees between fig9_slap2m.json and "
                 f"fig6_detections.json for {clash}; reconcile the deposits "
                 f"before drawing.")
    print(f"  join: {len(ps)}/{len(ps)} fig9 sessions found in fig6_detections, "
          f"0 difficulty mismatches")

    df = pd.DataFrame([{"session": q["session"],
                        "difficulty": int(diff[q["session"]]),
                        "animals": int(q["animals"]),
                        "cross_idf1": float(q["cross_idf1"])}
                       for q in ps if q["animals"] > 1])
    print(f"  cohort: {len(df)} multi-animal sessions "
          f"({len(ps) - len(df)} single-animal excluded)")
    return df


def main():
    use()
    df = build()
    deposit(df.sort_values(["difficulty", "session"]), 5,
            "fig5b_idf1_by_difficulty.csv")

    fig, ax = panel("half", "std")
    rng = np.random.default_rng(0)
    for d in DIFFICULTIES:
        v = df[df.difficulty == d].cross_idf1.to_numpy()
        if len(v):
            # 10e's box, and 10e's white-median rule with it: a white line reads
            # cleanly on a filled box but ERASES a box thinner than it, and three
            # of these seven strata are near-degenerate (n = 3, or an IQR of
            # 0.01 at rating 2), so the median falls back to TEAL there.
            q1, q3 = np.percentile(v, [25, 75])
            med_color = "white" if q3 - q1 > 0.04 else TEAL
            # `manage_ticks=False`: boxplot otherwise installs its OWN fixed
            # locator AND formatter per call, and the `set_xticks(DIFFICULTIES)`
            # below then re-uses that stale label list positionally -- which drew
            # the 1-7 axis one stratum out of register (the n=10 rating-2 box
            # labelled "3"). The panel sets its own ticks; the boxes must not.
            ax.boxplot([v], positions=[d], widths=0.46, patch_artist=True,
                       showfliers=False, zorder=2, manage_ticks=False,
                       medianprops=dict(color=med_color, linewidth=2.0),
                       boxprops=dict(facecolor=TEAL, edgecolor=TEAL,
                                     linewidth=0.8, alpha=0.55),
                       whiskerprops=dict(color=TEAL, linewidth=0.8),
                       capprops=dict(color=TEAL, linewidth=0.8))
            # Dots ON TOP of the box, and jittered inside it: one session is one
            # dot everywhere in this figure, so the box summarises marks the
            # reader can still count rather than replacing them.
            ax.scatter(np.full(len(v), d) + rng.uniform(-0.14, 0.14, len(v)), v,
                       s=8, color=TEAL, alpha=0.55, linewidths=0, zorder=4)
        # n under every stratum, 6g's requirement -- including the structurally
        # empty difficulty-1 cell, which would otherwise read as an axis mistake.
        ax.text(d, 0.03, f"n={len(v)}", ha="center", va="bottom",
                color=MUTED, fontsize=6.0)
    ax.text(1, 0.115, "single-\nanimal\nonly", ha="center", va="bottom",
            color=MUTED, fontsize=5.6)

    ax.set_xticks(DIFFICULTIES)
    ax.set_xlabel("difficulty rating")
    ax.set_ylabel("cross-view IDF1")
    ax.set_xlim(0.4, 7.6)
    ax.set_ylim(0, 1.02)
    ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])

    med = df.groupby("difficulty").cross_idf1.median()
    footnote(ax,
             # "previous default", not "shipped": the fresh-anchor operating
             # point was promoted to shipped 2026-08-17, and the fig9 cell this
             # panel reads is the arm that shipped BEFORE it. The deposit key
             # The deposit cell key is fig9_slap2m.json's own spelling and stays;
             # only the prose name moves.
             "one dot per session, box = stratum IQR with median, whiskers "
             "1.5x IQR (fliers not drawn -- every session is a dot); fresh-anchor "
             "LUC3D configuration (sync, stale 20, distThresh 25), cross-view "
             "IDF1\n"
             f"42 multi-animal SLAP-2M sessions (Fig 9a's cohort; the 32 "
             f"single-animal sessions have nothing to associate across views and "
             f"are excluded); difficulty 1 is single-animal only, so n=0\n"
             "medians: "
             + " · ".join(f"d{d} {m:.3f}" for d, m in med.items()))
    # e -> b in the 2026-08-19 re-letter (the difficulty grid leads the figure)
    save(fig, 5, "b", "idf1_by_difficulty")


if __name__ == "__main__":
    main()
