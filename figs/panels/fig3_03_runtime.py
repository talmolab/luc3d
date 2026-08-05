#!/usr/bin/env python3
"""
Fig 3c -- measured LUC3D association runtime across rig sizes.

The wall-clock counterpart to panel b's analytic counts, deliberately on its own
axis: a closed-form hypothesis count and a timing have different failure modes and
must not be read off the same scale.

Measured with `scripts/bench/bench_crossview.mjs` over real sessions, so each point
is a rig LUC3D actually ran, not an extrapolation.

Source: figs/out/fig3_runtime.json `measured`.

    python3 figs/panels/fig3_03_runtime.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, SET2, deposit, panel, save, text_legend, use  # noqa: E402


def build() -> pd.DataFrame:
    m = load("fig3_runtime.json")["measured"]
    df = pd.DataFrame(m)
    df = df[df.get("status").isna() | (df.status != "blocked")] if "status" in df \
        else df
    df["ms_per_frame"] = df.seconds_per_frame * 1e3
    return df.sort_values(["animals", "cameras"]).reset_index(drop=True)


def main():
    use()
    df = build()
    deposit(df, 3, "fig3c_runtime.csv")

    fig, ax = panel("third", "std", key=2)
    animals = sorted(df.animals.unique())
    for i, a in enumerate(animals):
        g = df[df.animals == a].sort_values("cameras")
        ax.plot(g.cameras, g.ms_per_frame, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(g.cameras, g.ms_per_frame, "o", color=SET2[i], ms=5, mec="white",
                mew=1.0, zorder=4)

    text_legend(ax, [(f"{a} animals", SET2[i]) for i, a in enumerate(animals)],
                "above")
    ax.set_xticks(sorted(df.cameras.unique()))
    ax.set_xlabel("cameras")
    ax.set_ylabel("association time (ms per frame)")
    ax.set_ylim(0, None)
    # The real-time budget is 20 ms/frame at 50 fps and the WORST measured
    # configuration is ~2.4 ms, so a rule at 20 sits 8x above every point: drawn, it
    # flattened the data to the axis and (with bbox_inches="tight") stretched the
    # panel to 420 mm. The headroom is stated instead, which is also the more
    # useful form -- the reader wants the margin, not a line they cannot see.
    worst = df.ms_per_frame.max()
    ax.text(0.97, 0.06, f"worst case {worst:.1f} ms/frame\n"
            f"{20.0 / worst:.0f}× under the 20 ms budget at 50 fps",
            transform=ax.transAxes, ha="right", va="bottom", color=GREY,
            fontsize=7)
    save(fig, 3, "c", "runtime_scaling")


if __name__ == "__main__":
    main()
