#!/usr/bin/env python3
"""
Fig 3e -- greedy vs exhaustive, run for real, on identical detections.

DO NOT PLOT IDF1 HERE. An earlier version of this panel drew greedy 0.982 against
exhaustive 0.714 and read as "the greedy method beats the published exhaustive one".
That gap is an ARTEFACT of our own harness, and `fig3_headtohead.json` says so in
its first caveat: exhaustive is a PURE PER-FRAME procedure with no cross-frame
identity mechanism at all, so to make IDF1 and switch counts computable
`fig3_exhaustive.mjs` threads identity between frames by nearest-3D-centroid
Hungarian matching. That threading is scaffolding we added, not part of Maree et
al.'s method, and the IDF1 gap measures the scaffolding. The file names the clean
comparison explicitly: **agreement_rate** -- does exhaustive choose the same
partition of detections as greedy, using only the paper's actual per-frame method.

So the panel reports the two things that ARE properties of the methods:

  * **Agreement.** On 137,266 frames where exhaustive could be run at all, the two
    choose the same grouping 99.999% of the time. The greedy solve is not an
    approximation that degrades quality here; it reaches the same answer.
  * **Tractability.** Measured exhaustive cost per frame, per configuration, and
    the configuration where it cannot be run at all: 4 animals x 6 cameras is
    191,102,976 hypotheses per frame, above the harness's 10^6 cap, so ZERO frames
    were computable. That is the regime the corpus actually contains.

READ THE FRAME COUNTS. A frame only enters the exhaustive computation if every
included camera has EXACTLY `animals` non-null detections, so that "A! per view" is
well posed; occlusions, misses and extra false positives are skipped and counted
(`frames_considered` vs `frames_clean`), not silently dropped. Exhaustive therefore
never faced the frames that are hardest for association, which makes the agreement
number, if anything, generous to it.

Source: figs/out/fig3_headtohead.json.

    python3 figs/panels/fig3_05_head_to_head.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, INK, PERIWINKLE, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, use)


def main():
    use()
    h = load("fig3_headtohead.json")
    cap = h["caps"]["max_hypotheses_per_frame"]

    rows = []
    for c in h["configs"]:
        rows.append({
            "label": f"{c['animals']}×{c['cameras']}",
            "animals": c["animals"], "cameras": c["cameras"],
            "hypotheses": c["hypotheses"],
            "s_per_frame": c.get("seconds_per_frame_exhaustive"),
            "frames_computed": c.get("frames_computed", 0),
            "dataset": c.get("dataset"),
        })
    df = pd.DataFrame(rows).sort_values("hypotheses").reset_index(drop=True)
    deposit(df, 3, "fig3e_head_to_head.csv")

    fig, ax = panel("third", "std")
    x = np.arange(len(df))
    runnable = df.frames_computed > 0

    ms = df.s_per_frame.fillna(0) * 1e3
    ax.bar(x[runnable], ms[runnable], width=0.55, color=PERIWINKLE, zorder=2)
    for xi, v, hyp in zip(x[runnable], ms[runnable], df.hypotheses[runnable]):
        ax.text(xi, v * 1.25, f"{hyp:,}", ha="center", va="bottom", color=GREY,
                fontsize=6.5)

    # The configuration that cannot be run at all is the point of the panel, so it
    # gets a marked empty slot rather than being omitted from the axis.
    for xi in x[~runnable]:
        hyp = df.hypotheses[xi]
        ax.bar(xi, ms[runnable].max() * 3.0, width=0.55, color=SALMON, alpha=0.18,
               zorder=1)
        ax.text(xi, ms[runnable].max() * 3.2, f"{hyp:,}\nintractable", ha="center",
                va="bottom", color=SALMON, fontsize=6.5, fontweight="bold")

    ax.set_yscale("log")
    ax.set_xticks(x)
    ax.set_xticklabels(df.label)
    ax.set_xlabel("animals × cameras")
    ax.set_ylabel("exhaustive, ms per frame")
    ax.set_ylim(1, ms[runnable].max() * 30)

    # Both of these were free-floating text and both collided with the bars. The
    # agreement rate is the panel's headline, so it goes in the title position; the
    # provenance goes in the label.
    ax.set_title(f"same grouping as LUC3D on {h['agreement_rate']:.3%} of "
              f"{h['frames_compared']:,} frames", color=TEAL, fontsize=7,
              fontweight="bold", loc="left")
    footnote(ax, "hypotheses/frame above each bar")
    save(fig, 3, "e", "head_to_head")


if __name__ == "__main__":
    main()
