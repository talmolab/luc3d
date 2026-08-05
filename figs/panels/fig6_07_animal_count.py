#!/usr/bin/env python3
"""
Fig 6d -- the animal-count control for panel c.

THE CONTROL PANEL c NEEDS. Difficulty and animal count are correlated in this
corpus, so panel c's rise could be "more animals" rather than "harder session". This
splits the same measurement by number of animals: the miss rate rises with animal
count too, so the two are not separable here and panel c must NOT be read as a pure
difficulty effect. Saying so is the point of drawing it.

n is printed per point because the cells are very unbalanced (35 sessions at 2
animals against 4 and 3 at 3 and 4), and any cell resting on a single session is
drawn hollow so it cannot be read as a measurement.

Source: figs/out/fig6_difficulty.json `by_animals`.

    python3 figs/panels/fig6_07_animal_count.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, SALMON, deposit, panel, save, use  # noqa: E402


def main():
    use()
    ba = load("fig6_difficulty.json")["by_animals"]
    ks = sorted(ba, key=int)
    df = pd.DataFrame([{"animals": int(k), "miss_rate": ba[k]["miss_rate"],
                        "err_p50": ba[k]["err_p50"],
                        "n_sessions": ba[k]["n_sessions"]} for k in ks])
    deposit(df, 6, "fig6d_animal_count.csv")

    fig, ax = panel("half", 38.0)
    y = df.miss_rate * 100
    ax.plot(df.animals, y, color=SALMON, lw=2.0, zorder=3)
    for _, r in df.iterrows():
        single = r.n_sessions <= 1
        ax.plot([r.animals], [r.miss_rate * 100], "o", ms=5.5, zorder=4,
                mfc="white" if single else SALMON, mec=SALMON, mew=1.2)
    for _, r in df.iterrows():
        ax.annotate(f"n = {int(r.n_sessions)}", (r.animals, r.miss_rate * 100),
                    textcoords="offset points", xytext=(0, -12), ha="center",
                    color=GREY, fontsize=6.5)

    ax.set_xticks(df.animals)
    ax.set_xlabel("animals in the session")
    ax.set_ylabel("keypoints missing (%)")
    ax.set_ylim(0, y.max() * 1.35)
    ax.text(0.03, 0.97, "hollow = n = 1 session", transform=ax.transAxes, va="top",
            color=GREY, fontsize=6.5)
    save(fig, 6, "d", "animal_count")


if __name__ == "__main__":
    main()
