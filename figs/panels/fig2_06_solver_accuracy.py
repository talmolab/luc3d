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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import INK, SALMON, TEAL, grid, save, use  # noqa: E402
import panels.fig4_02_accuracy_vs_cameras as fig4b  # noqa: E402
import panels.fig4_03_worst_camera as fig4c  # noqa: E402

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


def draw_worst_camera(ax, df, ci, d, tcrit):
    x = [0, 1]
    color = TEAL   # same series as the top axis' "refined" -- see docstring.
    mean_b, mean_a = float(df.all_views_px.mean()), float(df.worst_dropped_px.mean())
    ax.plot(x, [mean_b, mean_a], color=color, lw=1.8, zorder=4)
    ax.errorbar(x, [mean_b, mean_a],
                yerr=[[mean_b - ci["all_views_px"][0], mean_a - ci["worst_dropped_px"][0]],
                      [ci["all_views_px"][1] - mean_b, ci["worst_dropped_px"][1] - mean_a]],
                fmt="none", ecolor=INK, elinewidth=0.9, capsize=2.4, capthick=0.9, zorder=4)
    ax.plot(x, [mean_b, mean_a], "o", color=color, ms=5, mec="white", mew=0.9, zorder=5)
    ax.set_xticks(x)
    ax.set_xticklabels(["all views", "worst dropped"], fontsize=6.5)
    ax.set_xlim(-0.35, 1.35)
    ax.set_ylabel("kept-view (px)", fontsize=7)
    ax.set_ylim(1.0, ci["all_views_px"][1] * 1.12)
    ax.text(0.5, 0.02, f"paired {d.mean():+.3f} px, lower in "
                      f"{int((d < 0).sum())}/{len(df)} sessions",
           transform=ax.transAxes, ha="center", va="bottom", fontsize=6, color=INK)


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
    ci = {c: (float(df_c[c].mean() - tcrit * df_c[c].sem()),
             float(df_c[c].mean() + tcrit * df_c[c].sem()))
         for c in ("all_views_px", "worst_dropped_px")}
    d = df_c.worst_dropped_px - df_c.all_views_px

    fig, (ax_top, ax_bot) = grid(2, 1, span="third", row="std")
    fig.get_layout_engine().set(rect=(0, 0, 1, 0.86), hspace=0.12)
    draw_accuracy(ax_top, df_b)
    draw_worst_camera(ax_bot, df_c, ci, d, tcrit)
    save(fig, 2, "e", "solver_accuracy")


if __name__ == "__main__":
    main()
