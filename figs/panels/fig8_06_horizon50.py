#!/usr/bin/env python3
"""
Fig 8d (REDONE) -- the staleness HORIZON on all 50 BMimica sessions: shipped vs stale 1 / 10 / 20 / 30.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHAT THIS PANEL IS FOR. 8d compared ~24 method families on 8 sessions and 8e checked the
two best on all 50. This is the narrowed question that is actually left: the one method
that worked is evicting stale per-camera detections before re-triangulating, and the only
free parameter is HOW OLD is too old. Everything else is held fixed -- `sync` on,
`distanceThreshold` 25, same detections, same scorer, all 50 proofread BMimica sessions at
full length.

WHY THE PARAMETER EXISTS AT ALL. `Target.detsByCam` in pose/cross-view-tracker.js keeps one
detection per camera and NEVER expires it, and `_retriangulate()` fuses all of them -- so
the 3D pose every association is scored against blends the current pose with wherever each
other camera last saw the animal. Measured (figs/fig8_diag_anchor_age.py): mean detection
age 3.0-49.8 frames by session, maxima 844-8,652 frames, i.e. minutes. Faithful to the
sleap-3d reference, which has no track aging. `stale: N` drops anything older than N frames.

HOW TO READ IT. Two things vary along the x axis and both are plotted, because a horizon
that cuts switches while costing IDF1 is not the same win as one that improves both:

  LEFT   within-view ID switches per 100,000 camera-frames (log axis -- the shipped
         tracker and the best horizon differ by a factor of several)
  RIGHT  cross-view IDF1, MEAN and MEDIAN together. On 50 sessions these separate, and the
         separation is the point: a mean can be carried by a handful of sessions, and this
         repo has been burned by exactly that (see figs/README.md on Fig 4). Where the
         median moves more than the mean, the method is lifting the bulk rather than a few
         outliers.

The shipped tracker is drawn as a horizontal rule on both, not as a point at some x, because
it has no horizon -- that is the whole difference.

Source: figs/out/fig8_methods_50.json, written by
`$PY figs/fig8_methods.py --all-sessions --configs shipped,sync_stale1_dist25,...`.

    python3 figs/panels/fig8_06_horizon50.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from matplotlib.ticker import FuncFormatter, NullFormatter  # noqa: E402

from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, SALMON, TEAL, deposit, footnote,  # noqa: E402
                       grid, save, text_legend, use)

#: horizon in frames -> config name. `shipped` has no horizon and is a rule, not a point.
HORIZON = [(1, "sync_stale1_dist25"), (10, "sync_stale10_dist25"),
           (20, "sync_stale20_dist25"), (30, "sync_stale30_dist25")]


def build():
    d = load("fig8_methods_50.json")
    cells = {c["config"]: c for c in d["cells"] if c.get("idf1_cross") is not None}
    if "shipped" not in cells:
        sys.exit("fig8d: no `shipped` control in fig8_methods_50.json")
    have = [(n, c) for n, c in HORIZON if c in cells]
    if not have:
        sys.exit("fig8d: none of the stale-horizon cells are in fig8_methods_50.json yet "
                 "-- run `$PY figs/fig8_methods.py --all-sessions --configs "
                 + ",".join(c for _n, c in HORIZON) + "`")
    missing = [c for _n, c in HORIZON if c not in cells]
    cf = d["total_camera_frames"]

    rows = []
    for name, cfg in [("shipped", "shipped")] + [(str(n), c) for n, c in have]:
        c = cells[cfg]
        v = np.array([q["cross_idf1"] for q in c["per_session"]])
        rows.append({
            "horizon": name, "config": cfg,
            "switches": c["switches"],
            "switches_per_100k": c["switches"] * 1e5 / cf,
            "idf1_mean": float(v.mean()), "idf1_median": float(np.median(v)),
            "n_sessions": len(v),
        })
    return pd.DataFrame(rows), cf, d, missing


def main():
    use()
    df, cf, d, missing = build()
    deposit(df, 8, "fig8d_horizon50.csv")

    ship = df[df.horizon == "shipped"].iloc[0]
    hz = df[df.horizon != "shipped"].copy()
    hz["x"] = hz.horizon.astype(int)
    hz = hz.sort_values("x")

    fig, axes = grid(1, 2, span="full", row="std")
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 3 + 0.02)))
    axL, axR = axes[0], axes[1]

    # --- left: switch rate, log --------------------------------------------------
    axL.set_yscale("log")
    axL.axhline(ship.switches_per_100k, color=INK, lw=1.1, ls=(0, (1.5, 1.5)), zorder=2)
    axL.plot(hz.x, hz.switches_per_100k, color=TEAL, lw=1.4, zorder=3)
    axL.plot(hz.x, hz.switches_per_100k, "o", color=TEAL, ms=4.5, mec="white", mew=0.8,
             zorder=4)
    # Plain numbers on the log axis. matplotlib's default renders these as
    # "4 x 10^0", which is three glyphs of overhead to say "4" and at 6.5 pt reads as
    # noise; the range here is barely one decade so a scientific mantissa buys nothing.
    for which in ("major", "minor"):
        axL.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
        axL.yaxis.set_minor_formatter(NullFormatter())
    axL.set_xlabel("staleness horizon (frames); shipped has none", fontsize=7)
    axL.set_ylabel("within-view ID switches\nper 100,000 camera-frames", fontsize=7)
    axL.tick_params(labelsize=6.5)
    lo, hi = float(hz.switches_per_100k.min()), float(ship.switches_per_100k)
    axL.set_ylim(lo * 0.80, hi * 1.30)
    for _i, r in hz.iterrows():
        # ABOVE the marker. Below it, the lowest point's label landed on the x-axis
        # spine and its tick labels -- the whole reason the count is annotated is that
        # the log axis makes the absolute value hard to read off, so an unreadable
        # annotation defeats the purpose.
        axL.annotate(f"{int(r.switches):,}", (r.x, r.switches_per_100k),
                     textcoords="offset points", xytext=(0, 7), ha="center",
                     fontsize=5.6, color=MUTED)
    axL.annotate(f"shipped {int(ship.switches):,}",
                 (hz.x.max(), ship.switches_per_100k), textcoords="offset points",
                 xytext=(0, 4), ha="right", fontsize=5.6, color=INK)

    # --- right: IDF1, mean AND median -------------------------------------------
    axR.axhline(ship.idf1_mean, color=INK, lw=1.1, ls=(0, (1.5, 1.5)), zorder=2)
    axR.axhline(ship.idf1_median, color=INK, lw=1.1, ls=(0, (4, 2)), zorder=2, alpha=0.6)
    axR.plot(hz.x, hz.idf1_mean, color=TEAL, lw=1.4, zorder=3)
    axR.plot(hz.x, hz.idf1_mean, "o", color=TEAL, ms=4.5, mec="white", mew=0.8, zorder=4)
    axR.plot(hz.x, hz.idf1_median, color=SALMON, lw=1.4, ls=(0, (4, 2)), zorder=3)
    axR.plot(hz.x, hz.idf1_median, "s", color=SALMON, ms=4.0, mec="white", mew=0.8,
             zorder=4)
    axR.set_xlabel("staleness horizon (frames)", fontsize=7)
    axR.set_ylabel("cross-view IDF1", fontsize=7)
    axR.tick_params(labelsize=6.5)

    text_legend(axL, [
        ("shipped tracker — no expiry at all (dotted rules)", INK),
        ("stale-N: switch rate (left) and IDF1 mean (right)", TEAL),
        ("stale-N: IDF1 MEDIAN — moves further than the mean", SALMON),
    ], "above")

    best_sw = hz.loc[hz.switches_per_100k.idxmin()]
    best_id = hz.loc[hz.idf1_median.idxmax()]
    note = (f"fewest switches at horizon {int(best_sw.x)}: {int(best_sw.switches):,} "
            f"against shipped's {int(ship.switches):,} "
            f"({100 * (1 - best_sw.switches / ship.switches):.0f}% fewer)\n"
            f"highest median IDF1 at horizon {int(best_id.x)}: {best_id.idf1_median:.4f} "
            f"against shipped's {ship.idf1_median:.4f} "
            f"(+{best_id.idf1_median - ship.idf1_median:.3f}); mean "
            f"{best_id.idf1_mean:.4f} against {ship.idf1_mean:.4f}\n"
            "every point holds `sync` on and distanceThreshold 25; only the horizon "
            "varies\n"
            f"all {len(d['sessions'])} proofread BMimica sessions x 5 cameras, full "
            f"length, {cf:,} camera-frames, one shared detection pool")
    if missing:
        note += ("\nNOT YET MEASURED at 50 sessions and so absent from the curve: "
                 + ", ".join(missing))
    footnote(axL, note)
    save(fig, 8, "d", "horizon50")


if __name__ == "__main__":
    main()
