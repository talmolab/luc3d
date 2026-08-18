#!/usr/bin/env python3
"""
Fig 8b -- cross-view IDF1 for the same ten one-dimensional threshold sweeps as 8a.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHAT THIS PANEL CLAIMS. Very little, deliberately, and the shaded band is the
reason. It shows cross-view IDF1 -- IDF1 under one global identity per animal,
pooled over all five cameras -- for each sampled value of each threshold, against a
band that is this grid's OWN reproducibility.

WHAT IT MUST NOT BE READ AS CLAIMING: that any parameter value here is better than
another on IDF1. Almost nothing moves further than the band, and the panel is drawn
so that is the first thing visible rather than something a careful reader recovers.

THE BAND IS MEASURED, NOT ASSERTED, AND IT IS THE POINT OF THE PANEL. Fig 3e's
sweep contains its own null: over r = 1, 2, 4, 6, 8, 12 the ID-switch rate is on its
plateau -- it falls by less than a switch per 100,000 camera-frames across that whole
range -- while cross-view IDF1 wanders NON-MONOTONICALLY from 0.707 to 0.762. Those
six cells are as close to a replicate as this grid offers: the tracker is doing
essentially the same job in all six, and IDF1 still spreads by ~0.055. `noise_band()`
computes that spread from `fig3_sweep.json` at draw time rather than hard-coding a
number, so if the sweep is ever re-run the band moves with it.

So a half-width of ~0.027 either side of the default is drawn on every sub-plot, and
any point inside it is not distinguishable from the shipped default by this
measurement. That is the whole reason IDF1 gets its own panel instead of a second
axis on 8a: on a twin axis at 33 mm the IDF1 series reads as a second result of the
same standing as the switch rate, and it is not -- the switch rate resolves a factor
of 150 (Fig 3e) and IDF1 here resolves almost nothing.

WHY IDF1 IS SO MUCH BLUNTER HERE. IDF1 is dominated by DETECTION -- whether a
bounding box was there to match at all -- and every cell of this sweep runs on the
IDENTICAL shared detection pool. What varies is only which identity got attached,
which is what the switch rate measures directly and what IDF1 measures only through
a global identity assignment that a handful of switches barely perturbs. Read 8a for
the effect and 8b for the reassurance that nothing catastrophic happened to
association quality while 8a's rate moved.

THE ONE THING THAT DOES CLEAR THE BAND is distanceThreshold = 25: cross-view IDF1
0.795 against the shipped 50's 0.735, i.e. +0.060, more than twice the band's
half-width, and in the same direction as its switch rate (3.64 against 4.50, the
minimum of that sweep). It is higher in 4 of the 8 sessions and unchanged in the
rest. corr3dWeight 18 and 36 also sit just above the band (0.756, 0.765) but their
per-session picture is mixed -- two sessions gain 0.12-0.25 while two lose 0.04-0.06
-- so they are inside this panel's resolving power, not outside it. Everything else
is in the band or byte-identical.

THE ROW SPLIT IS 8a's. Top row: the five thresholds `runCrossViewTracker` actually
reads. Bottom row: the five read only by `matchFrameInstances`, the legacy
bench-only matcher no app path calls -- whose curves are flat because the tracker's
output was byte-identical to the default's on all 8 full sessions, not because the
effect was small. Two of the TOP row are flat for their own reasons, and are tagged
accordingly. See 8a's docstring for the full three-way argument and the digest check.

Source: figs/out/fig8_param_sweeps.json `cells` (+ figs/out/fig3_sweep.json for the
band). Written by figs/fig8_param_sweeps.py.

    python3 figs/panels/fig8_02_idf1.py
"""
import sys
from pathlib import Path

import pandas as pd
from matplotlib.ticker import MaxNLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, MUTED, TEAL, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, use)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fig8_01_switch_rate import (CORR3D_FROM_FIG3E, FLAT_NOTE, INERT_ROW,  # noqa: E402
                                 LIVE_ROW, TICKS)

METRIC = "idf1_cross"

#: The Fig 3e cells that form the null: corr2d = 1 and corr3d on the switch-rate
#: plateau. Across these six the rate changes by < 1 per 100,000 camera-frames while
#: IDF1 wanders, so their spread is this grid's reproducibility rather than a signal.
PLATEAU_R = (1, 2, 4, 6, 8, 12)


def noise_band() -> float:
    """Half-width of the "cannot be told apart" band, measured off Fig 3e's plateau.

    Returns half the full IDF1 spread over PLATEAU_R, so +/- the returned value spans
    exactly the range six near-replicate cells produced. Hard-coding 0.05 would have
    been the same number today and a lie after the next re-run.
    """
    sweep = load("fig3_sweep.json")
    vals = [c[METRIC] for c in sweep["cells"]
            if c.get(METRIC) is not None and c.get("corr2d") == 1
            and c.get("corr3d") in PLATEAU_R]
    if len(vals) < 3:
        sys.exit("fig8b: fewer than 3 plateau cells in fig3_sweep.json -- the noise "
                 "band has no measured basis and the panel will not invent one.")
    return (max(vals) - min(vals)) / 2.0


def build() -> pd.DataFrame:
    d = load("fig8_param_sweeps.json")
    df = pd.DataFrame([c for c in d["cells"] if c.get(METRIC) is not None])
    if df.empty:
        sys.exit("fig8b: no scored cells in fig8_param_sweeps.json")
    # Fig 3e's corr3d = 8 and 12 cells, for the same reason 8a pulls them in: on
    # 6/18/36 alone the corr3d tail is read off three points. Same measurement.
    f3e = load("fig3_sweep.json")
    extra = [{"param": "corr3dWeight", "value": c["corr3d"], "is_default": False,
              "reaches_shipped_tracker": True, "identical_to_default": False,
              "idf1_cross": c["idf1_cross"], "idf1_within": c["idf1_within"],
              "switches": c["switches"], "n_sessions": c["n_sessions"],
              "from_fig3e": True}
             for c in f3e["cells"]
             if c.get("corr2d") == 1 and c.get("corr3d") in CORR3D_FROM_FIG3E
             and c.get(METRIC) is not None]
    df["from_fig3e"] = False
    df = pd.concat([df, pd.DataFrame(extra)], ignore_index=True)
    order = {p: i for i, p in enumerate(LIVE_ROW + INERT_ROW)}
    df["_o"] = df.param.map(order)
    return df.sort_values(["_o", "value"]).drop(columns="_o").reset_index(drop=True)


def main():
    use()
    df = build()
    half = noise_band()
    df["noise_half_width"] = half
    deposit(df[["param", "value", "is_default", "reaches_shipped_tracker",
                "identical_to_default", "from_fig3e", "idf1_cross", "idf1_within",
                "noise_half_width", "n_sessions"]], 8, "fig8b_idf1.csv")

    fig, axes = grid(2, 5, span="full", row=80.0, sharey=True)
    # `panel(key=...)`'s own reservation formula for a 2-entry key -- see 8a.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 2 + 0.02)))

    default_idf1 = float(df[(df.param == "corr3dWeight") & df.is_default][METRIC].iloc[0])
    lo = min(df[METRIC].min(), default_idf1 - half)
    hi = max(df[METRIC].max(), default_idf1 + half)
    pad = 0.12 * (hi - lo)

    for i, param in enumerate(LIVE_ROW + INERT_ROW):
        ax = axes[i // 5][i % 5]
        g = df[df.param == param]
        live = bool(g.reaches_shipped_tracker.iloc[0])
        color = TEAL if live else GREY
        x = g.value.to_numpy(dtype=float)
        y = g[METRIC].to_numpy(dtype=float)

        # THE BAND FIRST, UNDER THE DATA. Drawn before the series so a point inside
        # it is read as inside it, not as a mark on top of a decoration.
        ax.axhspan(default_idf1 - half, default_idf1 + half, color=GREY, alpha=0.28,
                   lw=0, zorder=0)
        ax.plot(x, y, color=color, lw=2.0, zorder=3)
        ax.plot(x, y, "o", color=color, ms=3.2, mec="white", mew=0.7, zorder=4)

        dv = float(g[g.is_default].value.iloc[0])
        ax.axvline(dv, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)

        ax.set_ylim(lo - pad, hi + pad)
        ax.set_title(param, fontsize=6.5, color=color if live else MUTED, pad=2.5)
        ax.set_xticks(TICKS[param])
        ax.set_xticklabels([f"{v:g}" for v in TICKS[param]], fontsize=6.5)
        ax.tick_params(axis="y", labelsize=6.5)
        ax.yaxis.set_major_locator(MaxNLocator(4))
        if i % 5 == 0:
            ax.set_ylabel("cross-view IDF1", fontsize=7)

        # Tagged for the same reason as 8a's, and on the same rule: a flat line
        # inside the band reads as "measured, indistinguishable" and the truth is
        # stronger -- byte-identical output. Applied to any flat sub-plot, not just
        # the grey row, because two of the five live thresholds are flat too.
        if bool(g[~g.is_default].identical_to_default.all()):
            ax.text(0.5, 0.06, FLAT_NOTE.get(param, "identical output"),
                    transform=ax.transAxes, ha="center", va="bottom",
                    fontsize=6.0, color=MUTED, style="italic", linespacing=1.25)

    text_legend(fig.axes[0], [
        ("cross-view IDF1", TEAL),
        (f"grey band +/- {half:.3f}: this grid's own spread", MUTED),
    ], "above")

    footnote(fig.axes[0],
             f"band half-width {half:.4f}, measured from fig3_sweep.json over "
             f"corr2d = 1, corr3d in {PLATEAU_R} -- six cells on the switch-rate "
             "plateau\n"
             "a point inside the band is not distinguishable from the shipped "
             "default by this measurement\n"
             "8 Mouse-Dyad-10M sessions x 5 cameras, full length, one shared detection pool")
    save(fig, 8, "b", "idf1")


if __name__ == "__main__":
    main()
