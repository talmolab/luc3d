#!/usr/bin/env python3
"""
Fig 5d -- individual speed before the display: male still travelling, female
already still.

BOX-AND-WHISKER, MALE VS FEMALE, NOT A TIME COURSE (revised 2026-08-21, third
version of this panel -- restored to male/female speed after two other panels
occupied this slot in between; see fig5_13_angle_rose.py and this file's own
earlier history). Draws the comparison the same way Fig 5e/5f draw theirs -- two
boxes, one number each -- for a single, focused "who is faster right before onset"
question rather than a continuous curve. The window is the same 0.5 s immediately
before onset `speed_bl_s_t0`/`speed_bl_s_t1` (figs/fig5_upright.py) define.

OVERALL SPEED, NOT EACH ANIMAL'S OWN BASELINE (revised again, same day): this used
to divide by each animal's own median speed (`speed_rel_t0`/`speed_rel_t1`, still
computed and deposited), so a slow animal that sped up a little could outscore a
fast animal that barely changed pace. Plain body-lengths/second answers a plainer
question -- who is moving faster, full stop -- at the cost of not correcting for
the two animals' different typical paces (see Fig 5b/5g for the own-baseline
version of individual differences).

THE FINDING. Male: median 0.38 body lengths/s. Female: median 0.23 -- already
near-still. Paired across all 538 displays with both resolved, his speed exceeds
hers (Wilcoxon signed-rank P = 6.5e-22).

Source: figs/out/fig5_upright.json `events[].{speed_bl_s_t0,speed_bl_s_t1}`
        (figs/fig5_upright.py).

    python3 figs/panels/fig5_09_upright_velocity.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CM, CFEM = "#4393C3", "#D6604D"      # male, female -- matches 5b/5e/5f/5g


def whisker_extent(v):
    """matplotlib's own boxplot whisker rule (Q3 + 1.5*IQR, capped at the furthest
    point actually inside it, and the low-side mirror) -- so a significance
    bracket can sit just above the real drawn whisker, not an approximation of it."""
    q1, q3 = np.percentile(v, [25, 75])
    iqr = q3 - q1
    hi = v[v <= q3 + 1.5 * iqr].max()
    lo = v[v >= q1 - 1.5 * iqr].min()
    return lo, hi


def main():
    use()
    d = load("fig5_upright.json")
    ev = pd.DataFrame(d["events"])
    deposit(ev[["speed_bl_s_t0", "speed_bl_s_t1", "speed_rel_t0", "speed_rel_t1"]],
            5, "fig5d_upright_velocity.csv")

    m = ev["speed_bl_s_t0"].to_numpy(float)
    f = ev["speed_bl_s_t1"].to_numpy(float)
    both = np.isfinite(m) & np.isfinite(f)
    m, f = m[both], f[both]
    w = stats.wilcoxon(m - f)
    print(f"  male median {np.median(m):.3f}  female median {np.median(f):.3f}  "
          f"paired Wilcoxon n={both.sum()} P={w.pvalue:.3g}")

    # THIRD/STD, matching 5e/5f's box-and-whisker footprint exactly.
    fig, ax = panel("third", "std")
    for x, data, col in ((0, m, CM), (1, f, CFEM)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))

    lo_m, hi_m = whisker_extent(m)
    lo_f, hi_f = whisker_extent(f)
    lo, hi = min(lo_m, lo_f, 0.0), max(hi_m, hi_f)
    pad = 0.12 * (hi - lo)

    # SIGNIFICANCE BRACKET, same idiom as 5e/5f.
    y = hi + 0.5 * pad
    ax.plot([0, 0, 1, 1], [y - 0.1, y, y, y - 0.1], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    stars = "***" if w.pvalue < 1e-3 else ("**" if w.pvalue < 1e-2 else "*")
    ax.text(0.5, y + 0.06, stars, ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["male", "female"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(lo - pad, y + 3 * pad)
    ax.set_ylabel("speed, 0.5 s before onset\n(body lengths / s)")
    save(fig, 5, "d", "upright_velocity")


if __name__ == "__main__":
    main()
