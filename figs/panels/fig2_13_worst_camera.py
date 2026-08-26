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

WHAT IS DRAWN. The teal pair is the across-session mean with its 95% CI. The 50
grey per-session lines that used to carry the spread were REMOVED on instruction
(Eric, 2026-08-19: "remove all the annoying gray lines from 4c"); the per-session
evidence now rides entirely on the paired annotation ("lower in 50 of 50
sessions"), and the per-session rows still deposit unchanged in the CSV.

ERROR BARS ON THE TWO MEANS: t-based 95% CI (Eric, 2026-08-18: "we also need error
bars for 4b and 4c"). n = 50 sessions, so the interval is mean +- t(49, 0.975) x SEM
-- 2.056 [1.984, 2.129] px with all views, 1.711 [1.651, 1.772] with the worst view
dropped. Deliberately the CI of the mean and NOT the +-1 s.d. spread. (When the grey
lines still carried the spread, a s.d. bar would have been a second encoding of marks
already on the panel; with the lines gone the bars stay the CI, because the claim the
panel quotes is about the MEANS and the paired change, not the between-session s.d.)

THE PAIRED RESULT IS THE STRONGER ONE AND IT IS NOT WHAT THE BARS SHOW. Each session
is measured twice, so the test is the per-session change: -0.345 px, sd 0.047, 95% CI
[-0.359, -0.332], and it improves in 50 of 50 sessions -- an interval seven times
tighter than either mean's, because the between-session variation (sd 0.25 px) cancels
in the difference. It is deposited in the CSV's PAIRED row and quoted in the legend;
the grey lines are its picture.

Source: figs/out/fig4_robust_sessions.json (refuses to draw if its gate failed).

    python3 figs/panels/fig4_03_worst_camera.py
"""


import sys
from pathlib import Path

import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, INK, TEAL, deposit, footnote, panel, save, text_legend,  # noqa: E402
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
    # t-BASED, NOT 1.96: n = 50, so t(49, 0.975) = 2.0096 and the normal quantile
    # would run the interval 2.4% short. `d` is the PAIRED change, whose CI is the
    # one the finding rests on.
    tcrit = float(stats.t.ppf(0.975, len(df) - 1))
    ci = {c: (float(df[c].mean() - tcrit * df[c].sem()),
              float(df[c].mean() + tcrit * df[c].sem()))
          for c in ("all_views_px", "worst_dropped_px")}
    d = df.worst_dropped_px - df.all_views_px
    deposit(pd.concat([df, pd.DataFrame([
        {"session": "MEAN", "n": int(df.n.sum()),
         "all_views_px": mean_b, "worst_dropped_px": mean_a},
        {"session": "CI95_LO", "n": len(df),
         "all_views_px": ci["all_views_px"][0],
         "worst_dropped_px": ci["worst_dropped_px"][0]},
        {"session": "CI95_HI", "n": len(df),
         "all_views_px": ci["all_views_px"][1],
         "worst_dropped_px": ci["worst_dropped_px"][1]},
        # The paired change, in the only column that can hold it: `worst_dropped_px`
        # is the delta on this row and `all_views_px` its sd, labelled by `session`
        # rather than by adding two columns 50 rows would leave empty.
        {"session": "PAIRED_DELTA_mean__sd_in_all_views_col", "n": int((d < 0).sum()),
         "all_views_px": float(d.std(ddof=1)), "worst_dropped_px": float(d.mean())},
        {"session": "PAIRED_DELTA_CI95", "n": len(df),
         "all_views_px": float(d.mean() - tcrit * d.sem()),
         "worst_dropped_px": float(d.mean() + tcrit * d.sem())},
    ])], ignore_index=True), 2, "fig2e_worst_camera.csv")
    print(f"  mean {mean_b:.4f} [{ci['all_views_px'][0]:.4f}, "
          f"{ci['all_views_px'][1]:.4f}] -> {mean_a:.4f} "
          f"[{ci['worst_dropped_px'][0]:.4f}, {ci['worst_dropped_px'][1]:.4f}]; "
          f"paired {d.mean():+.4f} [{d.mean() - tcrit * d.sem():+.4f}, "
          f"{d.mean() + tcrit * d.sem():+.4f}], better in {int((d < 0).sum())}/{len(d)}")

    fig, ax = panel("third", "std", key=2)
    x = [0, 1]
    ax.plot(x, [mean_b, mean_a], color=TEAL, lw=2.2, zorder=4)
    # BARS IN INK, NOT TEAL. On a teal line and under a teal marker a teal bar reads
    # as part of the stroke; INK is the panel's neutral and makes the interval a
    # separate object. Drawn BELOW the markers so the white ring still closes.
    ax.errorbar(x, [mean_b, mean_a],
                yerr=[[mean_b - ci["all_views_px"][0],
                       mean_a - ci["worst_dropped_px"][0]],
                      [ci["all_views_px"][1] - mean_b,
                       ci["worst_dropped_px"][1] - mean_a]],
                fmt="none", ecolor=INK, elinewidth=1.0, capsize=3.0, capthick=1.0,
                zorder=4)
    ax.plot(x, [mean_b, mean_a], "o", color=TEAL, ms=6, mec="white", mew=1.0,
            zorder=5)

    text_legend(ax, [(f"mean of {len(df)} sessions, 95% CI", TEAL)], "above")
    ax.set_xticks(x)
    ax.set_xticklabels(["all views\nin the solve", "worst view\ndropped"])
    ax.set_xlim(-0.35, 1.35)
    ax.set_ylabel("reprojection error in\nthe kept views (px)")
    # NOT ZERO-BASED ANY MORE, for 4b's stated reason plus one of its own. A
    # reprojection floor set by detector noise makes zero unreachable, and on a
    # 0-2.6 px axis the mean's 95% CI -- 0.14 px wide, because 50 sessions pin a mean
    # hard -- was 5% of the axis height and read as a rendering artefact around the
    # marker rather than as an interval. The floor is 1.0 so the gap to zero stays
    # visible as a gap; the effect is not rescaled to fill the panel. The top used
    # to clear the highest per-session line (2.45); with the lines gone it clears
    # the mean's CI whisker instead, or the upper half of the axes held no ink.
    ax.set_ylim(1.0, ci["all_views_px"][1] * 1.10)
    # THE PAIRED NUMBER ON THE ARTWORK, in the band under the line field. It is the
    # result the bars cannot show -- each session measured twice, so the between-
    # session variation cancels -- and it is 7x tighter than either mean's CI.
    # y = 1.01 and 33 characters: the clear band is 1.0 to the lowest session line at
    # 1.27, which holds two 6.5 pt lines and nothing longer than ~35 mm on a 44 mm
    # axes. "paired change ..." overran into the line field on both counts.
    ax.text(0.5, 1.01, f"paired {d.mean():+.3f} px "
                       f"[{d.mean() - tcrit * d.sem():+.3f}, "
                       f"{d.mean() + tcrit * d.sem():+.3f}]\n"
                       f"lower in {int((d < 0).sum())} of {len(df)} sessions",
            ha="center", va="bottom", fontsize=6.5, color=INK, linespacing=1.35)
    save(fig, 2, "e", "worst_camera")


if __name__ == "__main__":
    main()
