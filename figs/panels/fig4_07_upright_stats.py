#!/usr/bin/env python3
"""
Fig 5e -- he is pursuing her: his own BODY AXIS is oriented at her while moving;
hers is not oriented at him.

PURSUIT BY FACING, NOT BY TRAVEL DIRECTION (revised 2026-08-21, fifth version of
this panel -- two changes from the previous one, both requested after that version
was not convincing). First, `pursuit_rel_t0`/`pursuit_rel_t1` (figs/fig4_upright.py)
now decompose each animal's own BODY-AXIS ORIENTATION (Nose -> TTI, not the velocity
vector -- an animal can travel toward its partner while turned sideways, or face it
while stationary, and these are different questions) onto the line connecting the
two animals, then scale by that animal's own (unsigned) speed so facing without
moving scores near zero rather than a large number: for track a, `away_a` is the
unit vector from the OTHER animal to a, `facing_a` is a's own Nose->TTI axis, and
`pursuit_a = dot(facing_a, away_a) * speed_a`, divided by a's own baseline speed.
Second, the window widened from the last 0.5 s before onset to the last 1.5 s: the
peri time course showed the male/female gap is not a last-instant effect, it is
present (if anything slightly larger) a full 1-1.5 s out from onset -- a sustained
orientation difference over the whole approach, not a flourish right before contact.

THE FINDING, and it is now a much larger effect than the travel-direction version.
Male: median -0.71 (99% of displays negative -- his body axis points at her, and he
is moving, on almost every display), IQR -1.75 to -0.31. Female: median -0.06 (62%
negative -- close to an even split), IQR -0.21 to +0.13 -- close to neutral, not
oriented at him one way or the other. Paired across all 538 displays with both
resolved, his score is more negative than hers (Wilcoxon signed-rank
P = 3.3e-73 -- against P = 9.3e-7 for the retired travel-direction version at the
narrower window, a difference of 66 orders of magnitude from asking the more precise
question).

WHAT THIS DOES AND DOES NOT SHOW. It shows he is oriented at her, moving, for over
a second before a display she leads -- consistent with the raw speed numbers (his
own retired box plot: median 0.75x baseline vs her 0.34x) being partly explained by
him closing a real gap while facing her, not moving for some unrelated reason. It
does NOT show she is oriented AWAY from him (her median is only slightly negative);
the asymmetry is that HE is doing the orienting-and-approaching, not that she is
doing the opposite.

WHY EACH ANIMAL IS NORMALISED TO ITS OWN BASELINE SPEED, same reasoning as every
other individual-speed measure in this figure: comparable across animals of
different overall activity levels.

Source: figs/out/fig5_upright.json `events[].{pursuit_rel_t0,pursuit_rel_t1}`
        (figs/fig4_upright.py).

    python3 figs/panels/fig5_07_upright_stats.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CM, CFEM = "#4393C3", "#D6604D"      # male, female -- matches 5b/5d/5f/5g


def whisker_extent(v):
    """matplotlib's own boxplot whisker rule (Q3 + 1.5*IQR, capped at the furthest
    point actually inside it, and the low-side mirror) -- NOT percentile(5/95),
    which does not match what the drawn whisker caps actually reach and left the
    significance bracket cutting through the male cap in an earlier version."""
    q1, q3 = np.percentile(v, [25, 75])
    iqr = q3 - q1
    hi = v[v <= q3 + 1.5 * iqr].max()
    lo = v[v >= q1 - 1.5 * iqr].min()
    return lo, hi


def main():
    use()
    d = load("fig5_upright.json")
    ev = pd.DataFrame(d["events"])
    deposit(ev[["dur_s", "peak_hi", "peak_lo", "height_match", "min_nose_gap",
                "base_gap", "ratio", "speed_rel", "speed_rel_t0", "speed_rel_t1",
                "pursuit_rel_t0", "pursuit_rel_t1"]],
            4, "fig4e_upright_stats.csv")

    m = ev["pursuit_rel_t0"].to_numpy(float)
    f = ev["pursuit_rel_t1"].to_numpy(float)
    both = np.isfinite(m) & np.isfinite(f)
    m, f = m[both], f[both]
    w = stats.wilcoxon(m - f)
    print(f"  male median {np.median(m):.3f}  female median {np.median(f):.3f}  "
          f"paired Wilcoxon n={both.sum()} P={w.pvalue:.3g}")

    # THIRD/STD, matching 5f's box-and-whisker footprint exactly.
    fig, ax = panel("third", "std")
    for x, data, col in ((0, m, CM), (1, f, CFEM)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))
    ax.axhline(0.0, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)

    lo_m, hi_m = whisker_extent(m)
    lo_f, hi_f = whisker_extent(f)
    lo, hi = min(lo_m, lo_f), max(hi_m, hi_f)
    pad = 0.12 * (hi - lo)

    # SIGNIFICANCE BRACKET, same idiom as 5f.
    y = hi + 0.5 * pad
    ax.plot([0, 0, 1, 1], [y - 0.05, y, y, y - 0.05], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    stars = "***" if w.pvalue < 1e-3 else ("**" if w.pvalue < 1e-2 else "*")
    ax.text(0.5, y + 0.03, stars, ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["male", "female"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(lo - pad, y + 3 * pad)
    ax.set_ylabel("facing-pursuit\n(− = approaching)")
    save(fig, 4, "e", "upright_stats")


if __name__ == "__main__":
    main()
