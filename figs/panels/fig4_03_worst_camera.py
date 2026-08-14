#!/usr/bin/env python3
"""
Fig 4c -- per-session reprojection error: all views in the solve vs the worst view
dropped.

THIRD FORM IN ONE NIGHT, each on instruction, this one final (Eric, 2026-08-15):
"just do the reprojection error per session scatter for all views and worst view
dropped for all sessions, then take the average -- I don't like the disagreement
strata, that just seems weird." The strata existed because fig4.json pooled the
before/after quantities by worst-view disagreement and never recorded sessions; the
per-session form needed a re-measurement with session capture
(figs/fig4_robust_sessions.mjs -- the robust arm alone, two DLT solves per keypoint,
same export, same solve and error calls, GATED to reproduce fig4.json's pooled
strata means to 1e-9).

WHAT IS DRAWN. One grey line per session connecting its two means (all views ->
worst dropped), 50 of them; the teal pair is the across-session mean. Every session
improves -- the line field all slopes down -- which is the finding, and no stratum
axis is needed to say it.

Source: figs/out/fig4_robust_sessions.json (refuses to draw if its gate failed).

    python3 figs/panels/fig4_03_worst_camera.py
"""


import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, INK, TEAL, deposit, footnote, panel, save, text_legend,  # noqa: E402
                       use)

STRATA = [("clean", "< 3"), ("mid", "3–10"), ("outlier", "≥ 10")]

#: Widest box, and the floor below which a box stops being visible at all. The
#: 1.6% stratum comes out at ~0.15 of the widest -- thin, which is the point.
#: One width for all three boxes; see the docstring. W_MIN is retained
#: because `build()` and the deposit are unchanged and a future variable-width
#: render would want the same floor.
W_BOX = 0.42
W_MAX, W_MIN = 0.54, 0.09


def build() -> pd.DataFrame:
    rb = load("fig4.json")["robust"]
    total = sum(rb[k]["n"] for k, _ in STRATA if k in rb)
    rows = []
    for key, label in STRATA:
        if key not in rb:
            continue
        m = rb[key]["moved_mm"]
        rows.append({
            "stratum": key, "label": label, "n": rb[key]["n"],
            "share": rb[key]["n"] / total,
            "improved_frac": rb[key]["improved_frac"],
            "p5": m["p5"], "p25": m["p25"], "p50": m["p50"],
            "p75": m["p75"], "p95": m["p95"],
        })
    return pd.DataFrame(rows)


def main():
    use()
    j = load("fig4_robust_sessions.json")
    if not j["gate"]["passed"]:
        sys.exit("fig4c: fig4_robust_sessions.json failed its gate against "
                 "fig4.json's pooled strata -- the per-session numbers are not the "
                 "published quantity's. Re-run figs/fig4_robust_sessions.mjs and "
                 "investigate before drawing.")
    ps = [r for r in j["per_session"] if r["n"]]
    df = pd.DataFrame(ps)
    mean_b = float(df.all_views_px.mean())
    mean_a = float(df.worst_dropped_px.mean())
    deposit(pd.concat([df, pd.DataFrame([{"session": "MEAN", "n": int(df.n.sum()),
                                          "all_views_px": mean_b,
                                          "worst_dropped_px": mean_a}])],
                      ignore_index=True), 4, "fig4c_worst_camera.csv")

    fig, ax = panel("third", "std", key=2)
    x = [0, 1]
    for _, row in df.iterrows():
        ax.plot(x, [row.all_views_px, row.worst_dropped_px], color=GREY, lw=0.7,
                alpha=0.8, zorder=2)
    ax.plot(x, [mean_b, mean_a], color=TEAL, lw=2.2, zorder=4)
    ax.plot(x, [mean_b, mean_a], "o", color=TEAL, ms=6, mec="white", mew=1.0,
            zorder=5)

    text_legend(ax, [(f"mean of {len(df)} sessions", TEAL),
                     ("one line per session", GREY)], "above")
    ax.set_xticks(x)
    ax.set_xticklabels(["all views\nin the solve", "worst view\ndropped"])
    ax.set_xlim(-0.35, 1.35)
    ax.set_ylabel("reprojection error in\nthe kept views (px)")
    ax.set_ylim(0, float(df.all_views_px.max()) * 1.1)
    save(fig, 4, "c", "worst_camera")


if __name__ == "__main__":
    main()
