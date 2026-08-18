#!/usr/bin/env python3
"""
Fig 5c -- the display has an initiator, and the lag is big enough to measure.

WHAT THE PANEL SHOWS. The display begins when the SECOND animal comes up, so the
display's own onset says nothing about who started it; that needs each animal's own
rear bout. The initiator is already up a median 0.37 s before the follower joins
(p25-p75 0.16-0.89 s). 0.37 s is 56 frames at this rig's 150 fps and would be a
handful at 30 fps -- one reason this analysis lives on Mouse-Dyad-10M.

WHO the initiator is has moved to its own panel (5f). It was an inset here, and an
inset is the wrong place for the result: it ran into this panel's own annotation,
and the statistic it drew -- max(share_0, share_1) over ALL sessions -- was inflated
by sessions with one to four displays, where that maximum is 1.00 by construction.

PROBABILITY, NOT COUNTS. The y axis is the fraction of all resolvable displays in
each 62.5 ms bin, so bin height does not depend on how many displays the corpus
happens to contain and two histograms in one figure are comparable.

THE LAST BIN IS AN OVERFLOW BIN and is drawn open-hatched with its own label. 7.8%
of displays have a lag longer than 2 s (out to 19 s) and the previous version simply
dropped them off the right edge of a 0-2 s axis, which silently removed the tail
from a distribution whose shape is the panel's claim.

Source: figs/out/fig5_upright.json `events[].lag_s` (figs/fig5_upright.py).

    python3 figs/panels/fig5_08_upright_initiator.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, use  # noqa: E402

CL = "#FC8D62"      # the lag
TOP = 2.0           # everything past here goes in the overflow bin
NBIN = 32


def main():
    use()
    d = load("fig5_upright.json")
    ev = pd.DataFrame(d["events"])
    lag = ev["lag_s"].to_numpy(float)
    lag = lag[np.isfinite(lag)]

    edges = np.linspace(0, TOP, NBIN + 1)
    w = edges[1] - edges[0]
    inside = np.histogram(lag[lag <= TOP], bins=edges)[0] / lag.size
    over = float((lag > TOP).mean())
    deposit(pd.DataFrame({"bin_left_s": edges[:-1], "bin_right_s": edges[1:],
                          "p_displays": inside}), 5, "fig5c_initiator_lag.csv")

    fig, ax = panel("third", "std")
    ax.bar(edges[:-1], inside, width=w, align="edge", color=CL, alpha=0.9,
           lw=0, zorder=2)
    # The overflow bin is drawn in outline so it cannot be read as one more equal
    # bin of the same distribution -- it is 7.8% of displays spread over 2-19 s.
    ax.bar([TOP + 0.5 * w], [over], width=w, align="edge", facecolor="none",
           edgecolor=CL, lw=0.8, hatch="///", zorder=2)
    ax.axvline(float(np.median(lag)), color=INK, lw=1.0, ls="--", zorder=3)

    ax.set_xlim(0, TOP + 2.0 * w)
    ax.set_ylim(0, max(inside.max(), over) * 1.55)
    ax.set_xticks([0, 0.5, 1.0, 1.5, 2.0])
    ax.set_xlabel("initiator up before the follower (s)")
    ax.set_ylabel("probability")

    # ONE annotation, in the headroom the raised ylim reserves, at the top LEFT --
    # the distribution's mode is at 0.1-0.2 s but its height is a third of the
    # panel, so this band is clear. Nothing else is placed inside the axes.
    ax.text(0.30, 0.98, f"median {np.median(lag):.2f} s", transform=ax.transAxes,
            ha="left", va="top", fontsize=6.5, fontweight="bold", color=CL)
    ax.annotate(f"> 2 s\n{100 * over:.0f}%", (TOP + 0.5 * w, over),
                textcoords="offset points", xytext=(0, 3), ha="center",
                va="bottom", fontsize=5.5, color=MUTED, linespacing=1.1)
    save(fig, 5, "c", "upright_initiator")


if __name__ == "__main__":
    main()
