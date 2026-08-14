#!/usr/bin/env python3
"""
Fig 2 s1 -- identity against the number of cameras: the other half of the
how-many-cameras question.

Panel c answers it for GEOMETRY (held-out reprojection error falls 4.32 -> 3.34 px
from 2 to 4 cameras). This panel answers it for IDENTITY: the shipped cross-view
tracker re-run on camera subsets of the BMimica rig, cross-view IDF1 against k.
Together they are the review's "# of cameras vs error, # of cameras vs switches"
(F2.6). Supplementary letter until Eric places it.

THE SPREAD AT EACH k IS SUBSETS, NOT SESSIONS. Three deterministic subsets per k
(combinations at indices [0, mid, last]; same three for every session), so each dot
is one SUBSET's 50-session mean and the vertical spread is "which cameras you keep",
not session-to-session noise. That spread is itself the finding at k = 2: the best
pair (0.688) beats the worst (0.669) by less than adding a third camera does
(+0.056), so WHICH cameras matters less than HOW MANY -- stated in the legend, not
here.

k = 5 IS THE GATE, NOT A NEW RUN: the full-rig cell re-scores the head-to-head
harness's cached shipped outputs and reproduced fig8_methods_50.json to 0.000e+00,
which is what makes the subset cells comparable to every other 50-session number.

Source: figs/out/fig2_cams_identity.json (`summary`, gate `passed: true`).

    python3 figs/panels/fig2_05_cams_identity.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, TEAL, deposit, panel, save, use)  # noqa: E402


def main():
    use()
    j = load("fig2_cams_identity.json")
    if not j["gate"]["passed"]:
        sys.exit("fig2 s1: the k=5 gate failed in the deposit -- the subset cells "
                 "are not comparable to the published 50-session numbers. Re-run "
                 "figs/fig2_cams_identity.py --stage score and investigate before "
                 "drawing anything.")
    rows = [{"subset": t, **v} for t, v in j["summary"].items()]
    df = pd.DataFrame(rows).sort_values(["k", "subset"])
    deposit(df, 2, "fig2s1_cams_identity.csv")

    fig, ax = panel("third", "std")
    ks = sorted(df.k.unique())
    # One dot per subset; the line threads the per-k MEANS. The k = 5 point is the
    # full rig (one subset by definition), drawn as the same series -- it is the
    # same tracker and the gate proved it is the same measurement.
    means = []
    for k in ks:
        g = df[df.k == k]
        jit = np.linspace(-0.08, 0.08, len(g)) if len(g) > 1 else [0.0]
        ax.plot(k + np.asarray(jit), g.cross_idf1_mean, "o", color=TEAL, ms=4.5,
                mec="white", mew=0.8, zorder=3)
        means.append(g.cross_idf1_mean.mean())
    ax.plot(ks, means, color=TEAL, lw=1.6, zorder=2)

    ax.set_xticks(ks)
    ax.set_xlabel("cameras used, k of 5")
    ax.set_ylabel("cross-view IDF1\n(50-session mean)")
    ax.set_ylim(0.6, 0.8)
    ax.set_yticks([0.6, 0.65, 0.7, 0.75, 0.8])
    save(fig, 2, "s1", "cams_identity")


if __name__ == "__main__":
    main()
