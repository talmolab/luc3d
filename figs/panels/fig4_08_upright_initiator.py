#!/usr/bin/env python3
"""
Fig 5c -- she is up first, and the lag is big enough to measure.

RESTRICTED TO FEMALE-LED DISPLAYS (revised 2026-08-21). This used to pool BOTH
directions -- "the initiator", whichever animal it was that display -- into one
lag distribution. Now that track slot is known to be a stable sex identity (track 0
male, track 1 female in every session, see fig5_10_leader.py), and she is the
initiator on 432 of 539 resolvable displays (80.1%, Fig 5f), the more informative
version of this panel is HER OWN lag distribution specifically: of the displays she
starts, how long is she up before he joins. The 107 male-led displays are excluded
here, not silently folded in -- their own lag looks similar (median 0.32 s vs her
0.39 s) but that is a separate fact belonging to Fig 5f/5g, not this panel.

WHAT THE PANEL SHOWS. The display begins when the SECOND animal comes up, so the
display's own onset says nothing about who started it; that needs each animal's own
rear bout. She is already up a median 0.39 s before he joins (p25-p75 0.17-0.90 s).
0.39 s is 59 frames at this rig's 150 fps and would be a handful at 30 fps -- one
reason this analysis lives on Mouse-Dyad-10M.

PROBABILITY, NOT COUNTS. The y axis is the fraction of her OWN 432 female-led
displays in each 62.5 ms bin (not all 539), so bin height does not depend on corpus
size and two histograms in one figure are comparable.

THE LAST BIN IS AN OVERFLOW BIN and is drawn open-hatched with its own label. A
handful of her leads run longer than 2 s (out to double digits) and the previous
version simply dropped tails like this off the right edge of a 0-2 s axis, which
silently removed the tail from a distribution whose shape is the panel's claim.

Source: figs/out/fig5_upright.json `events[].{lag_s,initiator_track}`
        (figs/fig4_upright.py).

    python3 figs/panels/fig5_08_upright_initiator.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, use  # noqa: E402

CL = "#D6604D"      # female -- matches 5b/5f/5g's female colour
TOP = 2.0           # everything past here goes in the overflow bin
NBIN = 32


def main():
    use()
    d = load("fig5_upright.json")
    ev = pd.DataFrame(d["events"])
    female_led = ev[ev["initiator_track"] == 1]
    lag = female_led["lag_s"].to_numpy(float)
    lag = lag[np.isfinite(lag)]

    edges = np.linspace(0, TOP, NBIN + 1)
    w = edges[1] - edges[0]
    inside = np.histogram(lag[lag <= TOP], bins=edges)[0] / lag.size
    over = float((lag > TOP).mean())
    deposit(pd.DataFrame({"bin_left_s": edges[:-1], "bin_right_s": edges[1:],
                          "p_female_led_displays": inside}),
            4, "fig4c_initiator_lag.csv")

    fig, ax = panel("third", "std")
    ax.bar(edges[:-1], inside, width=w, align="edge", color=CL, alpha=0.9,
           lw=0, zorder=2)
    # The overflow bin is drawn in outline so it cannot be read as one more equal
    # bin of the same distribution.
    ax.bar([TOP + 0.5 * w], [over], width=w, align="edge", facecolor="none",
           edgecolor=CL, lw=0.8, hatch="///", zorder=2)
    ax.axvline(float(np.median(lag)), color=INK, lw=1.0, ls="--", zorder=3)

    ax.set_xlim(0, TOP + 2.0 * w)
    ax.set_ylim(0, max(inside.max(), over) * 1.55)
    ax.set_xticks([0, 0.5, 1.0, 1.5, 2.0])
    ax.set_xlabel("female up before follower (s)")
    ax.set_ylabel("probability")

    # ONE annotation, in the headroom the raised ylim reserves, at the top LEFT --
    # the distribution's mode is at 0.1-0.2 s but its height is a third of the
    # panel, so this band is clear. Nothing else is placed inside the axes.
    ax.text(0.30, 0.98, f"median {np.median(lag):.2f} s\n"
            f"n = {len(lag)} of {len(ev)} displays", transform=ax.transAxes,
            ha="left", va="top", fontsize=6.5, fontweight="bold", color=CL,
            linespacing=1.25)
    ax.annotate(f"> 2 s\n{100 * over:.0f}%", (TOP + 0.5 * w, over),
                textcoords="offset points", xytext=(0, 3), ha="center",
                va="bottom", fontsize=5.5, color=MUTED, linespacing=1.1)
    save(fig, 4, "c", "upright_initiator")


if __name__ == "__main__":
    main()
