#!/usr/bin/env python3
"""
Fig 5d -- what identity proofreading is a task ON: 6 per-camera timelines (SLEAP)
against one cross-view identity (LUC3D), as identity breaks per session.

REPLACES the 10%-budget per-session scatter (review 2026-08: "no idea what it
means and the data looks suss" -- it was a consistency check on panel c's mean
drawn against a comparator two points from the null, and it read as a result).
The new panel makes the argument review asked for: compare proofreading SLEAP's
per-camera tracks with proofreading LUC3D's re-identified cross-view instances.

WHAT IS PLOTTED. For every multi-animal session (42 of the 74; identity
proofreading is only a task when the session holds two or more animals to
confuse, and 32 one-animal sessions would pad both sides with structural zeros
for SLEAP): identity breaks a proofreader must repair, where a break is a
motmetrics ID switch or fragmentation against the proofread GT on the shared
detection pool.

  * SLEAP column -- one dot per session: breaks summed over its 6 cameras. That
    sum IS its repair count, because each camera is an independent timeline
    repaired on its own.
  * LUC3D column -- one vertical segment per session: the BOUNDS on distinct
    global break events, [worst single camera, sum over cameras]. LUC3D's
    identity is global, so one underlying break registers in every camera that
    sees both animals: the per-camera sum multiply-counts it (upper bound), the
    worst camera sees at least every event visible anywhere... it sees at least
    as many as any camera, which is a lower bound on the distinct total. Nothing
    between the bounds is claimed -- the deposit's caveats say exactly this.

THE COUNT IS NOT THE ARGUMENT, AND THE PANEL MUST NOT PRETEND IT IS. LUC3D's raw
break mass is LARGER (fragmentation-heavy: 12,479 of its 16,189 corpus breaks are
fragmentations -- the honest negative Fig 7g already leads with). What separates
the two workflows is what a repair BUYS: a SLEAP repair fixes one camera's
timeline, and after all 5,445 of them the six timelines are still not linked to
each other -- cross-view correspondence does not exist in its output (Fig 7a:
cross-view IDF1 0.062 against a 1/C ceiling of 0.20), so the stitching that
remains is exactly the association problem of Fig 3. A LUC3D repair edits the one
cross-view identity, so it lands in all six views at once, and when the repairs
are done the 3D is already attached. The title carries that; the dots carry the
honest counts.

Source: figs/out/fig5_proofread.json (figs/fig5_proofread.py, reading the same
per-camera-session motmetrics table as fig3_trackers.py).

    python3 figs/panels/fig5_04_proofread.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (MUTED, deposit, entity, footnote, panel,  # noqa: E402
                       save, text_legend, use)

SLEAP_C, LUC_C = entity("sleap"), entity("luc3d")


def build() -> pd.DataFrame:
    q = load("fig5_proofread.json")
    rows = []
    for s in q["sessions"]:
        if s["animals"] < 2:
            continue
        rows.append({"session": s["session"], "animals": s["animals"],
                     "frames": s["frames"],
                     "sleap_breaks": s["sleap"]["breaks_sum"],
                     "luc3d_lo": s["luc3d"]["breaks_max_cam"],
                     "luc3d_hi": s["luc3d"]["breaks_sum"]})
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 5, "fig5d_proofread.csv")

    fig, ax = panel("half", "std", key=2)
    xs, xl = 0.0, 1.4
    # Deterministic jitter, DECORRELATED from the value: a rank-based jitter drew
    # both clouds as rising staircases that read as a trend across the column. The
    # golden-ratio sequence over session order spreads points evenly in x while
    # carrying no information, and depends on no RNG draw.
    n = len(df)
    j_s = ((np.arange(n) * 0.6180339887) % 1.0 - 0.5) * 0.55
    j_l = j_s
    ax.plot(xs + j_s, df.sleap_breaks, "o", color=SLEAP_C, ms=3, alpha=0.8, zorder=3)
    for xi, lo, hi in zip(xl + j_l, df.luc3d_lo, df.luc3d_hi):
        ax.plot([xi, xi], [max(lo, 0.8), hi], color=LUC_C, lw=1.0, alpha=0.55,
                solid_capstyle="round", zorder=2)

    # Median rules: the session medians of what each column actually shows --
    # SLEAP's exact count, and each of LUC3D's two bounds.
    for x0, vals, color in ((xs, df.sleap_breaks, SLEAP_C),
                            (xl, df.luc3d_lo, LUC_C), (xl, df.luc3d_hi, LUC_C)):
        ax.plot([x0 - 0.36, x0 + 0.36], [median(vals)] * 2, color=color, lw=2.0,
                zorder=4, solid_capstyle="butt")

    # Log axis: sessions span two orders of magnitude and a linear axis parks
    # two thirds of them in the bottom decile. Zeros are clamped to the axis
    # floor (0.8) by the max() above; SLEAP dots at 0 are drawn at the floor
    # and the footnote's "breaks" definition makes the floor's meaning plain.
    ax.set_yscale("log")
    ax.set_ylim(0.8, max(df.luc3d_hi.max(), df.sleap_breaks.max()) * 1.4)
    ax.set_yticks([1, 10, 100, 1000])
    ax.set_yticklabels(["1", "10", "100", "1,000"])
    ax.plot(xs + j_s[df.sleap_breaks == 0], np.full((df.sleap_breaks == 0).sum(), 0.8),
            "o", color=SLEAP_C, ms=3, alpha=0.8, zorder=3)
    ax.set_xticks([xs, xl])
    ax.set_xticklabels(["SLEAP\n6 per-camera timelines\n(exact count)",
                        "LUC3D\none cross-view identity\n(bounds on distinct events)"])
    ax.get_xticklabels()[0].set_color(SLEAP_C)
    ax.get_xticklabels()[1].set_color(LUC_C)
    ax.set_xlim(-0.75, xl + 0.75)
    ax.set_ylabel("identity breaks per session")

    # The claim, one line per side in that side's colour -- a single-colour title
    # with "here ... here" needed the reader to guess which column each clause
    # pointed at.
    text_legend(ax, [("a SLEAP repair fixes one of six unlinked timelines", SLEAP_C),
                     ("a LUC3D repair fixes every view at once", LUC_C)], "above")
    footnote(ax, "break = ID switch or fragmentation vs GT\n"
                 f"n = {len(df)} sessions with ≥ 2 animals\n"
                 "LUC3D's breaks are mostly fragmentations\n"
                 "(Fig 7g) — the count is not the argument")
    save(fig, 5, "d", "proofread")


if __name__ == "__main__":
    main()
