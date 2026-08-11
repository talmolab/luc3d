#!/usr/bin/env python3
"""
Fig 5e -- what kind of behaviour it is: brief, and STILL.

THE STILLNESS IS THE FINDING, and it is the one that decides how the display may be
described. A mutual upright posture at close range is the classic agonistic
configuration, and the obvious caption would be "boxing". But the animals move at a
median 0.44x their OWN baseline speed during the display, with 94% of events below
baseline: they stop, rise, hold for about 0.7 s, and come down. That is a standoff or
a mutual assessment, not a tussle -- and this figure therefore says "upright display"
and never "fight". Video would be needed to go further, and no video was scored.

Speed is each animal's tail-base translation, smoothed over 0.2 s, in body lengths
per second, divided by that animal's own whole-session median so cage size and animal
size cancel. The dashed rule at 1.0 is "as fast as this animal usually moves", which
is the comparison that matters -- an absolute speed would be uninterpretable.

PROBABILITY, NOT COUNTS, and an explicit overflow bin: same two changes as 5c, for
the same two reasons. 0.7% of displays are faster than 2x baseline and used to fall
off the right edge unremarked.

THE HEIGHT MATCH HAS MOVED to its own panel (5g). It was an inset here and its y
axis ran into this panel's median block; it also needed a null it could not fit.

Source: figs/out/fig5_upright.json `events[]` (figs/fig5_upright.py).

    python3 figs/panels/fig5_07_upright_stats.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, use  # noqa: E402

CS = "#E78AC3"      # speed
TOP = 2.0
NBIN = 32


def main():
    use()
    d = load("fig5_upright.json")
    ev = pd.DataFrame(d["events"])
    deposit(ev[["dur_s", "peak_hi", "peak_lo", "height_match", "min_nose_gap",
                "base_gap", "ratio", "speed_rel"]], 5, "fig5e_upright_stats.csv")

    v = ev["speed_rel"].to_numpy(float)
    v = v[np.isfinite(v)]
    edges = np.linspace(0, TOP, NBIN + 1)
    w = edges[1] - edges[0]
    inside = np.histogram(v[v <= TOP], bins=edges)[0] / v.size
    over = float((v > TOP).mean())

    fig, ax = panel("third", "std")
    ax.bar(edges[:-1], inside, width=w, align="edge", color=CS, alpha=0.9, lw=0,
           zorder=2)
    ax.bar([TOP + 0.5 * w], [over], width=w, align="edge", facecolor="none",
           edgecolor=CS, lw=0.8, hatch="///", zorder=2)
    ax.axvline(1.0, color=INK, lw=1.0, ls="--", zorder=3)
    ax.set_xlabel("speed during display\n(× that animal's own baseline)")
    ax.set_ylabel("probability")
    ax.set_xlim(0, TOP + 2.0 * w)
    ax.set_xticks([0, 0.5, 1.0, 1.5, 2.0])
    # HEADROOM FOR THE CALLOUT, in the band above the bars. The histogram peaks in
    # the upper LEFT, which is exactly where a centred label would go, so the block
    # sits right of the mode and above the 1.0 rule instead.
    ax.set_ylim(0, inside.max() * 1.65)

    below = float((v < 1).mean())
    ax.text(0.42, 0.98,
            f"median {np.median(v):.2f}×\n{below * 100:.0f}% below baseline",
            transform=ax.transAxes, ha="left", va="top", fontsize=6.5,
            fontweight="bold", color=CS, linespacing=1.25)
    ax.text(0.42, 0.72, f"median duration {np.median(ev['dur_s']):.2f} s",
            transform=ax.transAxes, fontsize=6, color=MUTED, va="top", ha="left")
    ax.annotate(f"> 2×\n{100 * over:.0f}%", (TOP + 0.5 * w, over),
                textcoords="offset points", xytext=(0, 3), ha="center",
                va="bottom", fontsize=5.5, color=MUTED, linespacing=1.1)
    save(fig, 5, "e", "upright_stats")


if __name__ == "__main__":
    main()
