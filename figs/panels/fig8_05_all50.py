#!/usr/bin/env python3
"""
Fig 8e -- the two candidate tracker changes over ALL 50 proofread BMimica sessions.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHY THIS PANEL EXISTS, AND WHY IT IS THE ONE THAT DECIDES. 8a-8d are measured on the 8
sessions Fig 3e used. That is what makes their rates comparable to Fig 3e's, and it is
also their whole weakness: this repo's own record (see figs/README.md, Fig 4) is that
running over all 50 sessions REVERSED a conclusion drawn from a subset. 8d's best
configurations reach cross-view IDF1 0.858-0.875 against a shipped 0.735 on those eight.
This panel asks whether that survives the other 42.

WHAT IS PLOTTED, AND WHY NOT A BAR OF MEANS. A mean over 50 sessions can be carried by a
handful of them, which is exactly how 8d's eight-session number flatters `stale: 1`. So:

  LEFT   every session's cross-view IDF1, sorted by the shipped tracker's value. The
         whole distribution, so a reader can see WHERE a method acts -- whether it lifts
         the bad tail, the middle, or nothing.
  RIGHT  the PAIRED per-session difference against shipped, sorted. Same sessions, same
         detections, same scorer, so the pairing is exact and the only thing that varies
         is the tracker. Sessions above the zero rule improved; sessions below it were
         damaged, and the count of those is the number that decides shippability -- two
         of 8d's eight sessions were already at their oracle ceiling and a method that
         gains on the mean by damaging such sessions is not a candidate.

THE HARNESS IS CROSS-CHECKED, NOT ASSUMED. `figs/out/fig3_trackers.json` already carries
an independent 50-session BMimica measurement of the shipped tracker through a different
pipeline (LUC3D cross-view IDF1 0.7493). The footnote prints this pass's shipped value
beside it; if they disagree, the panel says so on its face rather than leaving a reader to
discover it.

Source: figs/out/fig8_methods_50.json, written by
`$PY figs/fig8_methods.py --all-sessions`. `figs/fig8_report50.py` prints the medians,
quartiles and paired Wilcoxon tests that go with it.

    python3 figs/panels/fig8_05_all50.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, PERIWINKLE, SALMON, TEAL,  # noqa: E402
                       deposit, footnote, grid, save, text_legend, use)

#: (config, short label, colour). `shipped` is the reference for the right panel.
SERIES = [
    ("shipped", "shipped", INK),
    ("dist25_corr36", "best thresholds", PERIWINKLE),
    ("sync_stale1_dist25", "M1 + stale 1 + dt25", SALMON),
    ("sync_stale10_dist25", "M1 + stale 10 + dt25", TEAL),
]


def build():
    d = load("fig8_methods_50.json")
    cells = {c["config"]: c for c in d["cells"] if c.get("idf1_cross") is not None}
    missing = [c for c, _l, _k in SERIES if c not in cells]
    if missing:
        sys.exit(f"fig8e: fig8_methods_50.json lacks {missing} -- run "
                 f"`$PY figs/fig8_methods.py --all-sessions --configs "
                 f"{','.join(c for c, _l, _k in SERIES)}`")
    per = {c: {q["session"]: q for q in cells[c]["per_session"]} for c in cells}
    sessions = sorted(set.intersection(*(set(per[c]) for c, _l, _k in SERIES)))
    rows = []
    for s in sessions:
        row = {"session": s}
        for c, _l, _k in SERIES:
            row[f"{c}__idf1"] = per[c][s]["cross_idf1"]
            row[f"{c}__switches"] = per[c][s]["within_switches"]
        rows.append(row)
    df = pd.DataFrame(rows).sort_values("shipped__idf1").reset_index(drop=True)
    return df, cells, d


def main():
    use()
    df, cells, d = build()
    deposit(df, 8, "fig8e_all50.csv")

    n = len(df)
    fig, axes = grid(1, 2, span="full", row="tall")
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 4 + 0.02)))
    axL, axR = axes[0], axes[1]
    x = np.arange(n)

    # --- left: the whole distribution, sorted by the shipped tracker -------------
    for cfg, _label, colour in SERIES:
        y = df[f"{cfg}__idf1"].to_numpy()
        lw = 1.4 if cfg == "shipped" else 1.0
        axL.plot(x, y, color=colour, lw=lw, zorder=3 if cfg == "shipped" else 4,
                 alpha=1.0 if cfg == "shipped" else 0.9)
    # The shipped curve is monotone BY CONSTRUCTION -- it is the sort key. Saying so
    # stops it being read as a finding about the shipped tracker.
    axL.set_xlabel(f"session, sorted by the shipped tracker (n = {n}; its curve is "
                   "monotone by construction)", fontsize=7)
    axL.set_ylabel("cross-view IDF1", fontsize=7)
    axL.tick_params(labelsize=6.5)
    axL.set_ylim(0.0, 1.02)

    # --- right: paired per-session differences, sorted ---------------------------
    axR.axhline(0, color=INK, lw=0.9, zorder=2)
    counts = {}
    for cfg, label, colour in SERIES:
        if cfg == "shipped":
            continue
        dv = np.sort((df[f"{cfg}__idf1"] - df["shipped__idf1"]).to_numpy())
        counts[cfg] = (int((dv > 1e-4).sum()), int((dv < -1e-4).sum()), float(dv.min()),
                       float(np.median(dv)))
        axR.plot(np.arange(n), dv, color=colour, lw=1.2, zorder=4)
        axR.fill_between(np.arange(n), 0, dv, color=colour, alpha=0.12, lw=0, zorder=3)
    axR.set_xlabel("session, sorted by that method's own difference", fontsize=7)
    axR.set_ylabel("cross-view IDF1 change vs shipped", fontsize=7)
    axR.tick_params(labelsize=6.5)

    entries = [("shipped tracker — the sort key, so monotone by construction", INK)]
    for cfg, label, colour in SERIES:
        if cfg == "shipped":
            continue
        b, w, worst, med = counts[cfg]
        entries.append((f"{label}: {b} better / {w} worse, median {med:+.3f}, "
                        f"worst {worst:+.3f}", colour))
    text_legend(axL, entries, "above")

    ref = None
    try:
        t = load("fig3_trackers.json")["bmimica_50_sessions"]["LUC3D"]["cross"]["mean"]
        ref = float(t)
    except Exception:  # noqa: BLE001
        pass
    ship = float(cells["shipped"]["idf1_cross"])
    cf = d["total_camera_frames"]
    note = (f"shipped tracker here {ship:.4f}"
            + (f"; independent 50-session measurement in fig3_trackers.json "
               f"{ref:.4f} (difference {abs(ship - ref):.4f}) -- harness cross-check\n"
               if ref is not None else " -- no independent value to cross-check against\n"))
    for cfg, label, _c in SERIES:
        if cfg == "shipped":
            continue
        note += (f"{label}: {cells[cfg]['switches']:,} within-view switches "
                 f"({cells[cfg]['switches'] * 1e5 / cf:.3f} per 100,000) against "
                 f"shipped's {cells['shipped']['switches']:,} "
                 f"({cells['shipped']['switches'] * 1e5 / cf:.3f})\n")
    note += (f"all {len(d['sessions'])} proofread BMimica sessions x 5 cameras, full "
             f"length, {cf:,} camera-frames, one shared detection pool; sessions are "
             "PAIRED across configurations")
    footnote(axL, note)
    save(fig, 8, "e", "all50")


if __name__ == "__main__":
    main()
