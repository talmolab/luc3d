#!/usr/bin/env python3
"""
Fig 12b -- both further corpora co-rear MORE than the novel pairs, and coordinate less.

This is the finding, and it is a dissociation rather than a null. Panel a shows the
proximity-gated coupling is absent in SLAP-2M and not proximity-gated in the SCN2A rats;
the obvious worry is that the behaviour itself is absent or undetected there. It is not --
both have MORE of it than the novel pairs (1.90 and 1.11 displays/min against 0.15), and
the rats supply the largest display count of the three arms. What is missing is the
coordination, and the panel puts the two on the same artwork so neither can be read
without the other. Four measures, each a median over the unit of analysis Fig 5 uses:

  * RATE of mutual-upright displays per minute. Over EVERY session the detector could
    see, with empty sessions entered as zeros -- 19 of 56 Mouse-Dyad-10M sessions
    contain no display at all against 1 of 35 in SLAP-2M, so conditioning the rate on
    the behaviour having occurred would flatter Mouse-Dyad-10M by a factor of ~2.7.
  * INITIATOR LAG: how long the first animal is already up before the second joins.
  * MIN NOSE GAP during the display, in body lengths.
  * NEAR ENRICHMENT under the ARENA-CONTROLLED tertile split (`near_q`), not the fixed
    2 body-length cut. This is the honest version of panel a: SLAP-2M's arena is 3.2
    body lengths across and Mouse-Dyad-10M's 6.9, so a fixed cut means different things
    in the two. Self-normalising tertiles ("closer than this pair usually is") narrow
    the gap to 1.75x vs 1.37x. The direction survives the control; the magnitude does
    not, and the bars are drawn to the same scale as everything else so that is visible
    rather than buried in a caption.

WHY THE LAG DIFFERENCE IS NOT A SAMPLING ARTEFACT. SLAP-2M runs at 30 Hz against
Mouse-Dyad-10M's 150 Hz, so its rear onsets are timed 5x more coarsely -- 33 ms against
7 ms. The medians differ by 4.4 SECONDS, two orders of magnitude beyond either
resolution, so the coarser clock cannot produce this.

Source: figs/out/fig12_social.json (figs/fig12_social.py --corpus slap-2m
        --corpus mouse-dyad-10m).

    python3 figs/panels/fig12_02_rate_vs_coordination.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (CORPUS_COLORS, INK, MUTED, corpus, deposit,  # noqa: E402
                       footnote, grid, save, use)

#: (data key, printed familiarity, colour). Hues come from `style.CORPUS_COLORS` so the
#: three Fig 12 panels agree and SCN2A keeps the amber it wears on Figs 10-11.
ARMS = [("mouse-dyad-10m", "novel mice", CORPUS_COLORS["mouse-dyad-10m"]),
        ("slap-2m", "familiar mice", CORPUS_COLORS["slap-2m"]),
        ("scn2a", "rats, mixed genotype", CORPUS_COLORS["scn2a"])]

#: Tick labels: short, because three of them share a narrow axis.
TICKS = ["novel\nmice", "familiar\nmice", "rats"]

#: (axis title, unit, how to pull p25/p50/p75 out of the JSON). Rate first: it is the
#: measure that kills the "the behaviour is just missing there" reading, so it should be
#: the first thing the eye lands on.
MEASURES = [
    ("displays per minute", "per min", "leader", "rate_per_min"),
    ("initiator lag", "s", "leader", "initiator_lag_s"),
    ("min nose gap", "body lengths", "leader", "min_nose_gap"),
    ("near enrichment,\narena-controlled", "× chance", "coupling", "near_q"),
]


def _stats(d, kind, key):
    """(p25, p50, p75) for one measure of one corpus."""
    if kind == "leader":
        if key == "min_nose_gap":          # deposited as a single median only
            return (np.nan, d[f"{key}_p50"], np.nan)
        return (d[f"{key}_p25"], d[f"{key}_p50"], d[f"{key}_p75"])
    # `near_q` is a CURVE; the scalar is its peak, matching how panel a quotes it.
    c = d[key]
    if not c:
        return (np.nan, np.nan, np.nan)
    p50 = np.asarray(c["p50"], float)
    i = int(np.nanargmax(p50))
    return (float(np.asarray(c["p25"], float)[i]), float(p50[i]),
            float(np.asarray(c["p75"], float)[i]))


def main():
    use()
    D = load("fig12_social.json")

    rows = []
    fig, axes = grid(1, len(MEASURES), span="full", row="short")
    axes = np.ravel(axes)

    for ax, (title, unit, kind, key) in zip(axes, MEASURES):
        xs, vals, tops = [], [], []
        for i, (ckey, fam, col) in enumerate(ARMS):
            lo, mid, hi = _stats(D[kind][ckey], kind, key)
            xs.append(i)
            vals.append(mid)
            # Label ABOVE the whisker, not the bar: at these bar heights the p25-p75
            # line runs straight through a bar-top label and strikes the digits out.
            tops.append(max(mid, hi) if np.isfinite(hi) else mid)
            ax.bar(i, mid, width=0.62, color=col, lw=0, zorder=2)
            if np.isfinite(lo) and np.isfinite(hi):
                ax.plot([i, i], [lo, hi], color=INK, lw=1.0, zorder=3,
                        solid_capstyle="butt")
            rows.append({"measure": title.replace("\n", " "), "unit": unit,
                         "corpus": corpus(ckey), "familiarity": fam,
                         "p25": lo, "p50": mid, "p75": hi})
        # The number on the bar, because a four-panel row of small bars is read as a
        # pattern and the magnitudes still have to be recoverable.
        for i, v, top in zip(xs, vals, tops):
            if np.isfinite(v):
                # Offset in POINTS, not data units: where a measure has no whisker the
                # label's anchor IS the bar top, and lint_text flags it as sitting on
                # the data (the min-nose-gap bars, 2026-08-20).
                ax.annotate(f"{v:.2f}".rstrip("0").rstrip("."), (i, top),
                            textcoords="offset points", xytext=(0, 2.2),
                            ha="center", va="bottom", fontsize=6, color=INK, zorder=4)
        if kind == "coupling":
            # 1.0 is chance for an enrichment; without the line the two bars look like
            # "less of something" rather than "one is at chance".
            ax.axhline(1.0, color=INK, lw=0.7, ls=":", alpha=0.6, zorder=1)
        ax.set_xticks(range(len(ARMS)))
        ax.set_xticklabels(TICKS, fontsize=6, linespacing=1.15)
        ax.set_title(title, fontsize=7, color=INK, pad=3)
        ax.set_ylabel(unit, fontsize=6.5, color=MUTED)
        ax.margins(y=0.22)

    deposit(pd.DataFrame(rows), 12, "fig12b_rate_vs_coordination.csv")

    L = D["leader"]
    footnote(axes[-1],
             f"{corpus('mouse-dyad-10m')} "
             f"{L['mouse-dyad-10m']['n_sessions_enumerated']} sessions "
             f"({L['mouse-dyad-10m']['n_sessions_no_events']} with no display), "
             f"{L['mouse-dyad-10m']['n_events']:,} displays · "
             f"{corpus('slap-2m')} {L['slap-2m']['n_sessions_enumerated']} "
             f"({L['slap-2m']['n_sessions_no_events']} with none), "
             f"{L['slap-2m']['n_events']:,} displays. Bars are medians over sessions "
             f"(rate) or displays (lag, gap); whiskers p25-p75. Colour is corpus, "
             f"as in panel a.")

    save(fig, 12, "b", "rate_vs_coordination")


if __name__ == "__main__":
    main()
