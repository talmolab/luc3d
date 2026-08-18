#!/usr/bin/env python3
"""
Fig 7 s4 -- ID accuracy: of the detections matched to a real animal, the percentage
carrying the correct identity.

The review's "Fig 7 add accuracy!" panel (F7.2). IDF1 folds coverage and correctness
into a harmonic mean; this is the literal "% correct" a reader asks for first, with
detector misses and false-positive detections both excluded from the denominator
(IDA = idtp / num_matches; on this corpus false positives are ~0.1% of matches, so
IDA is within a whisker of IDP).

THE DISTRIBUTION IS THE FINDING, which is why every session is a dot and the pooled
value is only a rule: the corpus is bimodal. On the fresh anchor the MEDIAN session
is at 100.0% -- most sessions carry not one wrongly-labelled detection -- while the
worst is at 56.6%, one animal's identity held for roughly half the session. A bare
mean (92.5%) describes no session at all. Same idiom as the set's other
per-session-dots panels; the two operating points use the established solid
(previous default) vs hollow (fresh anchor, the shipped configuration since
2026-08-17) idiom in LUC3D's own hue.

Source: figs/out/fig8_ida_shipped.json, figs/out/fig8_ida_sync_stale20_dist25.json
(both gated: their IDF1 reproduces fig8_methods_50.json's cells).

    python3 figs/panels/fig7_10_ida.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import entity, deposit, panel, save, use  # noqa: E402

# Arm names relabelled 2026-08-17 (fresh-anchor promotion): the deposit
# FILENAMES keep their historical "shipped" spelling; only the names move.
ARMS = [("previous default", "fig8_ida_shipped.json", False),
        ("fresh anchor (shipped)", "fig8_ida_sync_stale20_dist25.json", True)]


def main():
    use()
    teal = entity("luc3d")
    rows = []
    fig, ax = panel("third", "std", key=3)
    for i, (name, src, hollow) in enumerate(ARMS):
        j = load(src)
        v = np.array([r["within_ida"] for r in j["per_session"]]) * 100.0
        pooled = j["summary"]["ida_pooled"] * 100.0
        jit = ((np.arange(len(v)) * 0.6180339887) % 1.0 - 0.5) * 0.30
        if hollow:
            ax.plot(i + jit, v, "o", ms=2.6, mfc="white", mec=teal, mew=0.7,
                    alpha=0.85, zorder=3)
        else:
            ax.plot(i + jit, v, "o", ms=2.6, color=teal, alpha=0.45, mec="none",
                    zorder=3)
        # The POOLED value as a rule across the column -- a rate over all
        # 78-79M matched detections, not a mean of the dots above it.
        ax.plot([i - 0.24, i + 0.24], [pooled] * 2, color=teal, lw=2.0, zorder=4)
        rows += [{"arm": name, "session": r["session"],
                  "ida_pct": r["within_ida"] * 100.0}
                 for r in j["per_session"]]
        rows.append({"arm": name, "session": "POOLED", "ida_pct": pooled})
    deposit(pd.DataFrame(rows), 7, "fig7s4_ida.csv")

    from src.style import text_legend
    text_legend(ax, [("filled: previous default · rule: pooled rate", teal),
                     ("hollow: fresh anchor (shipped)", teal)],
                "above", size=6.5)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["previous\ndefault", "fresh anchor\n(shipped)"])
    ax.set_xlim(-0.6, 1.6)
    ax.set_ylim(50, 101)
    ax.set_yticks([50, 60, 70, 80, 90, 100])
    ax.set_ylabel("ID accuracy (%)\none dot per session")
    save(fig, 7, "s4", "ida")


if __name__ == "__main__":
    main()
