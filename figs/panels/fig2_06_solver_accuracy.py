#!/usr/bin/env python3
"""
Fig 2e -- Fig 4b (accuracy vs cameras used) and Fig 4c (dropping the worst
camera) combined into ONE panel, two stacked axes sharing one third-span/std-row
box -- the same convention Fig 3e (`fig3_05_sweep.py`) uses for its own two
stacked bands (`grid(2, 1, span="third", row="std")`).

MOVED HERE FROM A DRAFT COMBINED FIG13 (Eric, 2026-08-20: "actually i mean to
add 13 g i and j to fig 2 as the third column in that fig. so remove 13 g i and
j from fig 13 and append it to fig 2"). This is the same panel that was briefly
`fig13_02_accuracy_worst_camera.py` (13g); that file is deleted, LAYOUTS[13]'s
row 3 is gone, and this is the new home. Fig 2's row 2 (b, c, d) becomes row 3
(e, f, g) -- see LAYOUTS[2] in assemble.py; b/c/d and the whole rest of the
figure are untouched.

COLOUR REVERTS TO SALMON/TEAL, Fig 4b/4c's OWN choice (DLT = SALMON, refined =
TEAL). The AMBER/SKY override this panel carried as 13g existed ONLY because
Fig 13 also carried a/d/e/f keyed to salmon/teal for exhaustive vs greedy
grouping -- a clash that does not exist here: Fig 2 has no exhaustive/greedy
content, and TEAL already means "this work" throughout Fig 2 itself (2c's own
median line, 2e's/`fig2_05_cams_identity.py`'s IDF1 curve) -- exactly the house
ENTITY rule (`src/style.py`: "TEAL -- this work, whatever it is called in that
figure"). Keeping the fig13-only AMBER/SKY substitution here would have been the
same mistake in reverse.

REUSES FIG 4b/4c's OWN `build()` (imported as modules, not touched -- importing
only runs their top-level definitions; `main()` is guarded and never called, so
Fig 4's own panels/CSVs are untouched) but redraws both, simplified for half the
vertical room:
  - top (accuracy vs cameras): curves + CI bars + markers, no end-point ratio
    callouts and no footnote -- neither fits in ~24 mm of axis height, and the
    crossing they explain is still visible in the two curves themselves.
  - bottom (dropping the worst camera): mean pair + CI bars + the ONE line that
    carries the actual finding ("paired ... px, lower in 50/50 sessions").

    python3 figs/panels/fig2_06_solver_accuracy.py
"""
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import INK, SALMON, TEAL, grid, save, use  # noqa: E402
import panels.fig2_12_accuracy_vs_cameras as fig4b  # noqa: E402
import panels.fig2_13_worst_camera as fig4c  # noqa: E402

#: Fig 4b/4c's own colours -- see docstring.
COLOR = {"dlt": SALMON, "ba": TEAL}


def draw_accuracy(ax, df):
    for key, _, _ in fig4b.SOLVERS:
        color = COLOR[key]
        ax.plot(df.cameras, df[f"{key}_p50"], color=color, lw=1.8, zorder=3)
        ax.errorbar(df.cameras, df[f"{key}_p50"],
                    yerr=[df[f"{key}_p50"] - df[f"{key}_ci_lo"],
                         df[f"{key}_ci_hi"] - df[f"{key}_p50"]],
                    fmt="none", ecolor=color, elinewidth=0.9, capsize=2.0,
                    capthick=0.9, zorder=3)
        ax.plot(df.cameras, df[f"{key}_p50"], "o", color=color, ms=4, mec="white",
                mew=0.9, zorder=4)
    ks = list(df.cameras)
    ax.set_xlim(ks[0] - 0.6, ks[-1] + 0.6)
    lo_y = min(df[f"{k}_ci_lo"].min() for k, *_ in fig4b.SOLVERS)
    hi_y = max(df[f"{k}_ci_hi"].max() for k, *_ in fig4b.SOLVERS)
    ax.set_ylim(max(0.0, lo_y - 0.35), hi_y * 1.10)
    ax.set_xticks(ks)
    ax.set_xlabel("cameras in the solve", fontsize=7)
    ax.set_ylabel("held-out (px)", fontsize=7)
    for key, name, y in (("ba", "refined", 1.22), ("dlt", "DLT", 1.02)):
        ax.text(0.02, y, name, transform=ax.transAxes, clip_on=False,
               color=COLOR[key], fontweight="bold", fontsize=6.5, ha="left", va="top")


def draw_worst_camera(ax, df, tcrit):
    """Both solvers (2026-09-29, Eric: "lets use both solvers for 2e"). Each solver's
    all-view solve vs the same solver with its own worst-fitting view dropped, scored on
    the kept views (`figs/fig2_solvers_robust_sessions.mjs`: DLT columns unchanged,
    `refined_*` columns added). Mean over sessions with a t-based 95% CI, as before.
    Colours as the top axis: SALMON = DLT, TEAL = refined."""
    x = np.array([0, 1])
    series = [("DLT", SALMON, "all_views_px", "worst_dropped_px", -0.06),
              ("refined", TEAL, "refined_all_views_px", "refined_worst_dropped_px", 0.06)]
    lo_all, hi_all, notes = [], [], []
    for name, color, cb, ca, dx in series:
        if cb not in df or df[cb].isna().all():
            sys.exit(f"fig2e: no {name} series in fig4_robust_sessions.json -- re-run "
                     "figs/fig2_solvers_robust_sessions.mjs")
        m = np.array([df[cb].mean(), df[ca].mean()])
        h = np.array([tcrit * df[cb].sem(), tcrit * df[ca].sem()])
        ax.errorbar(x + dx, m, yerr=h, fmt="none", ecolor=color, elinewidth=0.9,
                    capsize=2.4, capthick=0.9, zorder=4)
        ax.plot(x + dx, m, color=color, lw=1.8, zorder=4)
        ax.plot(x + dx, m, "o", color=color, ms=5, mec="white", mew=0.9, zorder=5)
        lo_all.append((m - h).min()); hi_all.append((m + h).max())
        d = df[ca] - df[cb]
        notes.append((name, color, float(d.mean()), int((d < 0).sum()), len(df)))
    ax.set_xticks(x)
    ax.set_xticklabels(["all views", "worst dropped"], fontsize=6.5)
    ax.set_xlim(-0.35, 1.35)
    ax.set_ylabel("kept-view (px)", fontsize=7)
    lo, hi = min(lo_all), max(hi_all)
    ax.set_ylim(lo - 1.6 * (hi - lo), hi + 0.15 * (hi - lo))
    for k, (name, color, dm, nl, n) in enumerate(notes):
        ax.text(0.5, 0.03 + 0.17 * (len(notes) - 1 - k), f"{name} {dm:+.3f} px, lower in {nl}/{n}",
                transform=ax.transAxes, ha="center", va="bottom", fontsize=6, color=color)


def main():
    use()
    df_b = fig4b.build()

    j = fig4c.load("fig4_robust_sessions.json")
    if not j["gate"]["passed"]:
        sys.exit("fig2e: fig4_robust_sessions.json failed its gate -- see fig4_03_worst_camera.py")
    ps = [r for r in j["per_session"] if r["n"]]
    df_c = fig4c.pd.DataFrame(ps)
    from scipy import stats
    tcrit = float(stats.t.ppf(0.975, len(df_c) - 1))

    fig, (ax_top, ax_bot) = grid(2, 1, span="third", row="std")
    fig.get_layout_engine().set(rect=(0, 0, 1, 0.86), hspace=0.12)
    draw_accuracy(ax_top, df_b)
    draw_worst_camera(ax_bot, df_c, tcrit)
    save(fig, 2, "e", "solver_accuracy")


if __name__ == "__main__":
    main()
