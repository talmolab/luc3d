#!/usr/bin/env python3
"""
Fig 3g -- the corr2d x corr3d sweep re-run on ALL 50 BMimica sessions with the FRESH-ANCHOR
tracker, and the interaction Fig 8 could not see.

    EXPLORATORY, and since 2026-08-14 SUPERSEDED BY 3e ITSELF: on instruction, the
    manuscript's 3e (`fig3_05_sweep.py`) now draws the full 12-ratio corr2d = 1 row at 50
    sessions for BOTH arms (shipped + fresh anchor), of which this panel's 4 cells are a
    subset. This panel is retained as the record of the finding that motivated that
    re-run; the retired 8-session 3e is `fig3_05_sweep.py --legacy8`.

WHY RE-RUN A SWEEP THAT ALREADY EXISTS. Fig 3e swept `corr3dWeight` on the SHIPPED tracker
over 8 sessions and found a plateau: past r = 1 the switch rate barely moves, and Fig 8
extended the tail to r = 18 and 36 and confirmed it flat. Both conclusions were drawn with
the tracker's 3D anchor in its shipped state -- fused from per-camera detections that are
never expired, with a measured mean age of 3-50 frames and maxima up to 8,652
(`figs/fig8_diag_anchor_age.py`). If the anchor a cost term is scored against is a blend of
where the animal is and where it used to be, the sensitivity of that cost term to its own
weight is not being measured cleanly. So the sweep is repeated with the anchor fixed.

WHAT IT FOUND, AND IT CONTRADICTS THE PLATEAU. On 50 sessions with `sync` + `stale: 20` +
`distanceThreshold 25`:

    corr3d = 0     284,609 switches   cross-view IDF1 0.5985
    corr3d = 1         583            0.8374
    corr3d = 4         443            0.8579
    corr3d = 12        371            0.8614

corr3d = 12 reaches 371 switches where the shipped default r = 6 gives 413 on the same 50
sessions -- so the tail is NOT flat once the anchor is fresh, and Fig 8's "nothing past
r = 12" was a property of the stale anchor rather than of the cost function. The 3D term is
also revealed as load-bearing rather than marginal: at r = 0 the tracker produces 284,609
switches, three orders of magnitude worse, because with no 3D term nothing links views.

Read together with Fig 8: the two knobs are not independent of the anchor. A parameter sweep
run against a corrupted state can report a plateau that is really the state's insensitivity,
not the parameter's.

CAVEAT ON THE GRID. This is `corr2d = 1` only, at corr3d 0/1/4/12 -- four cells, chosen
because the full 8x3 grid at 50 sessions is 1,200 tracker runs plus 1,200 motmetrics
scorings (~8 h). So this shows a slice, not a surface, and it cannot say whether the corr2d
axis interacts with the anchor too. The deposited CSV carries every cell measured.

Source: figs/out/fig3_sweep50__distanceThreshold25-stale20-sync_e508a7ab.json, written by
`figs/fig3_sweep50.py --grid-corr3d 0,1,4,12 --grid-corr2d 1 --method '{"sync":true,
"stale":20}' --thresholds '{"distanceThreshold":25}'`.

    python3 figs/panels/fig3_07_sweep50_freshanchor.py
"""
import glob
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.ticker import FuncFormatter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, SALMON, TEAL, deposit, footnote,  # noqa: E402
                       grid, save, text_legend, use)

#: The shipped-default cell measured on the SAME 50 sessions with the same fresh anchor,
#: from figs/out/fig8_methods_50.json -- so "r = 6" on this panel is a measurement, not a
#: number carried over from a different pass.
SHIPPED_R = 6.0
SHIPPED_CELL = "sync_stale20_dist25"


def build():
    hits = sorted(glob.glob(str(Path("figs/out")
                                / "fig3_sweep50__distanceThreshold25-stale20-sync_*.json")))
    hits = [h for h in hits if "__f" not in Path(h).name]      # exclude smoke-test tags
    if not hits:
        sys.exit("fig3g: no fresh-anchor sweep deposit. Run:\n"
                 "  FIG3_SWEEP50_WORKERS=40 $PY figs/fig3_sweep50.py "
                 "--grid-corr3d 0,1,4,12 --grid-corr2d 1 "
                 "--method '{\"sync\":true,\"stale\":20}' "
                 "--thresholds '{\"distanceThreshold\":25}'")
    d = load(Path(hits[-1]).name)
    cf = d["total_camera_frames"]
    rows = [{"corr2d": c["corr2d"], "corr3d": c["corr3d"], "switches": c["switches"],
             "switches_per_100k": c["switches"] * 1e5 / cf,
             "idf1_cross": c["idf1_cross"], "idf1_within": c["idf1_within"],
             "n_sessions": c["n_sessions"]}
            for c in d["cells"] if c.get("idf1_cross") is not None]
    if not rows:
        sys.exit("fig3g: the sweep deposit has no scored cells")
    df = pd.DataFrame(rows).sort_values(["corr2d", "corr3d"]).reset_index(drop=True)

    # The r = 6 reference must come from the same 50 sessions and the same tracker.
    ref = None
    try:
        m = load("fig8_methods_50.json")
        cell = next(c for c in m["cells"] if c["config"] == SHIPPED_CELL)
        assert m["total_camera_frames"] == cf, "denominators differ; not comparable"
        ref = {"corr3d": SHIPPED_R, "switches": cell["switches"],
               "switches_per_100k": cell["switches"] * 1e5 / cf,
               "idf1_cross": cell["idf1_cross"]}
    except Exception as e:  # noqa: BLE001
        print(f"  [note] no r = 6 reference ({e}); the panel will omit it")
    return df, cf, d, ref


def main():
    use()
    df, cf, d, ref = build()
    deposit(df, 3, "fig3g_sweep50_freshanchor.csv")

    fig, axes = grid(1, 2, span="full", row="std")
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 3 + 0.02)))
    axS, axI = axes
    g = df[df.corr2d == 1].sort_values("corr3d")

    # LOG switch axis: r = 0 is 284,609 switches against r = 12's 371, three orders of
    # magnitude. On a linear axis every informative point would collapse onto the baseline.
    axS.set_yscale("log")
    # PLAIN DECIMAL TICK LABELS, not matplotlib's default `$10^{n}$`. The default sets the
    # exponent as a mathtext superscript at 0.7x the tick size, so at this panel's
    # `labelsize=6.5` the "0", "1" and "2" of 10^0/10^1/10^2 came out at 4.55 pt -- under
    # Nature's 5 pt floor, and `lint_text.py` (correctly) failed them. The three labelled
    # decades here are 1, 10 and 100, which read better as digits than as powers anyway.
    axS.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:g}"))
    axS.plot(g.corr3d, g.switches_per_100k, color=TEAL, lw=1.5, zorder=3)
    axS.plot(g.corr3d, g.switches_per_100k, "o", color=TEAL, ms=5, mec="white", mew=0.8,
             zorder=4)
    # PER-POINT OFFSETS, because a single offset cannot clear a curve that falls three
    # decades between the first two points. Centred-above works everywhere except r = 1,
    # where the steep segment arriving from r = 0 runs straight through the box a centred
    # label would occupy (measured: 18% of it inked). At r = 1 the label goes to the
    # right, over the flat tail, which is the empty quadrant at that point.
    for _i, r in g.iterrows():
        right = r.corr3d == 1
        axS.annotate(f"{int(r.switches):,}", (r.corr3d, r.switches_per_100k),
                     textcoords="offset points", xytext=((9, 2) if right else (0, 7)),
                     ha="left" if right else "center", va="bottom",
                     fontsize=5.8, color=MUTED)
    if ref:
        axS.plot(ref["corr3d"], ref["switches_per_100k"], "D", color=SALMON, ms=5.5,
                 mec="white", mew=0.8, zorder=5)
        # ABOVE the marker, not below it. Below, the two lines fell through the axis spine
        # and into the tick labels -- `lint_text.py` reported the first line 17% inked and
        # the "413" sat outside the axes entirely. The flat tail leaves nearly a full
        # decade of empty plot between the curve and the 10 tick, which two 5.8 pt lines
        # (about half a decade here) fit inside.
        axS.annotate(f"shipped r = 6\n{ref['switches']:,}",
                     (ref["corr3d"], ref["switches_per_100k"]),
                     textcoords="offset points", xytext=(4, 8), ha="left", va="bottom",
                     fontsize=5.8, color=SALMON, linespacing=1.2)
    axS.set_xlabel("corr3dWeight  (corr2dWeight = 1)", fontsize=7)
    axS.set_ylabel("ID switches per 100,000\ncamera-frames", fontsize=7)
    axS.tick_params(labelsize=6.5)

    axI.plot(g.corr3d, g.idf1_cross, color=TEAL, lw=1.5, zorder=3)
    axI.plot(g.corr3d, g.idf1_cross, "o", color=TEAL, ms=5, mec="white", mew=0.8, zorder=4)
    if ref:
        axI.plot(ref["corr3d"], ref["idf1_cross"], "D", color=SALMON, ms=5.5, mec="white",
                 mew=0.8, zorder=5)
        axI.annotate(f"shipped r = 6\n{ref['idf1_cross']:.4f}",
                     (ref["corr3d"], ref["idf1_cross"]), textcoords="offset points",
                     xytext=(6, -2), ha="left", va="top", fontsize=5.8, color=SALMON,
                     linespacing=1.2)
    axI.set_xlabel("corr3dWeight  (corr2dWeight = 1)", fontsize=7)
    axI.set_ylabel("cross-view IDF1", fontsize=7)
    axI.tick_params(labelsize=6.5)
    axI.set_ylim(0.55, 0.90)

    best = g.loc[g.switches.idxmin()]
    text_legend(axS, [
        ("fresh-anchor tracker: M1 + stale 20 + distThresh 25", TEAL),
        ("the shipped corr3dWeight = 6, same 50 sessions, same tracker", SALMON),
        ("EXPERIMENTAL: not in pose/cross-view-tracker.js", MUTED),
    ], "above")

    note = (f"corr3d = {best.corr3d:g} reaches {int(best.switches):,} switches"
            + (f" against r = 6's {ref['switches']:,} on the same sessions — so the tail is "
               f"NOT flat once the anchor is fresh\n" if ref else "\n")
            + "Fig 3e (8 sessions, shipped tracker) and Fig 8 both found nothing past "
              "r = 12; that plateau was a property of the STALE anchor, not of the cost "
              "function\n"
              "at corr3d = 0 the tracker produces "
            + f"{int(g.iloc[0].switches):,} switches — with no 3D term nothing links the "
              "views, so the term is load-bearing rather than marginal\n"
            + f"corr2d = 1 slice only, 4 cells: the full 8x3 grid at 50 sessions is 1,200 "
              f"tracker + 1,200 scoring runs (~8 h). {len(d['sessions'])} sessions, "
              f"{cf:,} camera-frames")
    footnote(axS, note)
    save(fig, 3, "g", "sweep50_freshanchor")


if __name__ == "__main__":
    main()
