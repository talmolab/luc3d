#!/usr/bin/env python3
"""
Fig 3d -- measured LUC3D association runtime across rig sizes.

The wall-clock counterpart to panel c's analytic counts, deliberately on its own
axis: a closed-form hypothesis count and a timing have different failure modes and
must not be read off the same scale.

Measured with `scripts/bench/bench_crossview.mjs` over real sessions, so each point
is a rig LUC3D actually ran, not an extrapolation.

n = 1 SESSION PER LINE, AND THE PANEL SAYS SO. Each animal-count series is one
session swept over camera subsets of its own 6-camera detection pool (2 animals
10072022131531, 3 animals 10072022142111, 4 animals 10072022145420), so the
separation BETWEEN the lines confounds animal count with session. What the sweep
ALONG a line does isolate is C: the deposit's second caveat states the detection
pool is identical across the camera-subset cells of a given animal count, so within
a line only C changes.

DUPLICATE CELLS ARE PLOTTED, NOT AVERAGED. `fig3_runtime.json measured` contains
TWO rows for (2 animals, 5 cameras): 0.959 ms from the SLAP-2M session that carries
the rest of that line, and 1.124 ms from a BMimica session (20250827_141755) on a
different corpus. Averaging them would invent a third number that was never
measured and would hide the disagreement; drawing the line through both made the
teal series BACK-TRACK at x = 5, which reads as a measurement error. So: the line
and its filled markers are the one session that spans the camera axis, and any
other session measured at the same cell is drawn as an OPEN marker at its own value
(footnoted). Nothing is dropped and nothing is combined.

Source: figs/out/fig3_runtime.json `measured`.

    python3 figs/panels/fig3_04_runtime.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, SET2, deposit, footnote, panel, save,  # noqa: E402
                       text_legend, use)


def build() -> pd.DataFrame:
    m = load("fig3_runtime.json")["measured"]
    df = pd.DataFrame(m)
    df = df[df.get("status").isna() | (df.status != "blocked")] if "status" in df \
        else df
    df["ms_per_frame"] = df.seconds_per_frame * 1e3
    # Which session carries each animal-count line: the one with the most camera
    # cells, i.e. the one that actually sweeps the x axis. Everything else at the
    # same (animals, cameras) is a second, separately drawn measurement.
    df["on_line"] = False
    for _a, g in df.groupby("animals"):
        spine = g.session.value_counts().idxmax()
        df.loc[g.index[g.session == spine], "on_line"] = True
    return df.sort_values(["animals", "cameras"]).reset_index(drop=True)


def main():
    use()
    df = build()
    deposit(df, 3, "fig3d_runtime.csv")

    # key must equal the number of entries stacked in the band. Three animal counts
    # were being keyed as two, so the "4 animals" entry fell out of the reserved band
    # and into the top of the plot.
    animals = sorted(df.animals.unique())
    fig, ax = panel("third", "std", key=len(animals))
    for i, a in enumerate(animals):
        g = df[(df.animals == a) & df.on_line].sort_values("cameras")
        ax.plot(g.cameras, g.ms_per_frame, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(g.cameras, g.ms_per_frame, "o", color=SET2[i], ms=5, mec="white",
                mew=1.0, zorder=4)
        # Open, so it cannot be read as a point on the swept line -- it is the same
        # rig on another corpus, and it is a real measurement either way.
        o = df[(df.animals == a) & ~df.on_line]
        ax.plot(o.cameras, o.ms_per_frame, "o", mfc="white", mec=SET2[i], mew=1.4,
                ms=5, ls="none", zorder=5)

    text_legend(ax, [(f"{a} animals", SET2[i]) for i, a in enumerate(animals)],
                "above")
    ax.set_xticks(sorted(df.cameras.unique()))
    ax.set_xlabel("cameras")
    ax.set_ylabel("association time (ms per frame)")
    ax.set_ylim(0, None)
    footnote(ax, "○ second corpus, same rig\none session per line, n = 1")
    # The real-time budget is 20 ms/frame at 50 fps and the WORST measured
    # configuration is ~2.4 ms, so a rule at 20 sits 8x above every point: drawn, it
    # flattened the data to the axis and (with bbox_inches="tight") stretched the
    # panel to 420 mm. The headroom is stated instead, which is also the more
    # useful form -- the reader wants the margin, not a line they cannot see.
    worst = df.ms_per_frame.max()
    ax.text(0.97, 0.06, f"worst case {worst:.1f} ms/frame\n"
            f"{20.0 / worst:.0f}× under the 20 ms budget at 50 fps",
            transform=ax.transAxes, ha="right", va="bottom", color=MUTED,
            fontsize=7)
    save(fig, 3, "d", "runtime_scaling")


if __name__ == "__main__":
    main()
