#!/usr/bin/env python3
"""
Fig 5b -- the display's time course: both animals rise, and their noses converge.

WHAT MAKES THIS A RESULT RATHER THAN A DEFINITION. The event is defined by both
animals being reared and within two body lengths. It is NOT defined by their noses
being close, by their heights matching, or by anything happening at a particular
time -- so the convergence of the noses to 0.13 body lengths (about 11 mm) exactly at
onset, and the two height curves rising together and peaking together, are contingent
and could have come out otherwise. Two animals that merely happened to rear near each
other would give two unrelated humps and a flat gap.

TWO SCALES, ONE AXIS EACH. The gap is NOT inverted: inverting it so that "closer"
pointed upward like "higher" was tried and put the gap curve along the top of the
panel, where it read as a third height trace and covered the space the series names
need. Left alone, the gap FALLS while the heights RISE and the two cross, which
states the coupling more directly than a shared direction would.

THE TWO CURVES ARE RANKS, NOT ANIMALS. "Reaches higher" and "reaches lower" are
assigned PER EVENT by which animal peaked higher, not by identity, because averaging
by identity would wash both curves toward their mean. This is why the two curves are
separated at the peak (1.18 vs 1.02 body lengths) but converge away from the event:
the labelling is conditioned on the peak, so the gap between them at t = 0 is partly
that selection and must not be read as two stable classes of animal. What is NOT
selection is the timing -- both peak together, which is the panel's claim.

The series were called "taller animal" and "shorter animal" until an adversarial pass
asked whether either named an individual. Neither does. The label changes hands
within a session on about a quarter of displays; the animal that reaches higher is
the structurally longer one on only 41% of displays; and the animals that reach
higher during displays are NOT the ones that rear higher in general -- the followers
peak at a median 118 mm over their own rear bouts against the initiators' 89 mm.
Height in this panel is a within-display rank in units of each animal's own body
length, and that is all it is.

Heights are in BODY LENGTHS (each animal's own median nose-to-tail-base distance)
because the corpus spans animals of different sizes; millimetres would mix growth
with posture.

Band is the across-session p25-p75 of the per-session median curves.

Source: figs/out/fig5_upright.json `peri.{hi,lo,gap}` (figs/fig5_upright.py).

    python3 figs/panels/fig5_06_upright_dynamics.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (INK, MUTED, deposit, panel, save,  # noqa: E402
                       text_legend, use)

CA, CB = "#66C2A5", "#E78AC3"      # taller / shorter, matching the pose panel
CG = "#FC8D62"                     # the nose gap


def main():
    use()
    d = load("fig5_upright.json")
    t = np.asarray(d["t"], float)
    p = d["peri"]
    deposit(pd.DataFrame({
        "t_s": t,
        "taller_p50": p["hi"]["p50"], "shorter_p50": p["lo"]["p50"],
        "nose_gap_p50": p["gap"]["p50"],
        "taller_p25": p["hi"]["p25"], "taller_p75": p["hi"]["p75"],
        "shorter_p25": p["lo"]["p25"], "shorter_p75": p["lo"]["p75"],
        "nose_gap_p25": p["gap"]["p25"], "nose_gap_p75": p["gap"]["p75"],
    }), 5, "fig5d_upright_dynamics.csv")

    # `key=3` reserves a band ABOVE the axes for the series names, which is this
    # repo's idiom and the only placement that cannot land on data. Hand-placed
    # labels beside each curve were tried first and collided with all three series:
    # the two height curves converge away from the peak, and the gap curve crosses
    # them.
    # HALF/TALL, was third/std (Eric, 2026-08-19: "make b bigger to fill out that
    # white space"). Panel a beside it is half-width and 64 mm tall, so at 57.3 x 52
    # this panel left about 31 mm of the 180 mm row empty on its right and sat 12 mm
    # short of a's bottom edge. 88 + 88 + the 4 mm gutter is exactly the page.
    fig, ax = panel("half", "tall", key=3)
    for key, c in (("hi", CA), ("lo", CB)):
        ax.fill_between(t, p[key]["p25"], p[key]["p75"], color=c, alpha=0.16, lw=0)
        ax.plot(t, p[key]["p50"], color=c, lw=1.8, zorder=3)
    ax.axvline(0, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)
    ax.set_xlabel("time from display onset (s)")
    ax.set_ylabel("nose height (body lengths)")
    ax.set_ylim(0.2, 1.45)

    # THE GAP IS NOT INVERTED. An inverted axis was tried so that "closer" pointed
    # the same way as "higher", and it put the gap curve along the TOP of the panel
    # where it read as a third height trace and covered the space the labels needed.
    # Left as it is, the gap FALLS while the heights RISE and the two cross -- which
    # states the coupling more directly than a shared direction would.
    ax2 = ax.twinx()
    ax2.fill_between(t, p["gap"]["p25"], p["gap"]["p75"], color=CG, alpha=0.13, lw=0)
    ax2.plot(t, p["gap"]["p50"], color=CG, lw=1.6, ls=(0, (3, 1.6)), zorder=2)
    ax2.set_ylabel("nose gap (body lengths)", color=CG, fontsize=6.5)
    ax2.tick_params(axis="y", colors=CG, labelsize=6.5)
    ax2.set_ylim(0, 0.95)
    ax2.spines["top"].set_visible(False)
    ax2.spines["right"].set_color(CG)

    # "REACHES HIGHER", NOT "TALLER ANIMAL". The old wording named an individual and
    # the data do not support one: the label is assigned per display by which animal
    # peaked higher, in units of its OWN body length, and it changes hands within a
    # session on a quarter of displays. It is also not the bigger mouse -- the
    # animal that reaches higher during a display is the longer one on 41% of them.
    text_legend(ax, [("reaches higher", CA), ("reaches lower", CB),
                     ("nose gap", CG)])

    gmin = int(np.argmin(p["gap"]["p50"]))
    ax2.annotate(f"{p['gap']['p50'][gmin]:.2f} BL", (t[gmin], p["gap"]["p50"][gmin]),
                 textcoords="offset points", xytext=(13, -1), ha="left",
                 color=CG, fontsize=6.5, fontweight="bold", va="center")
    # TWO LINES: on one line the string ran from x = 0.02 past the axes'
    # midline and sat on the dashed t = 0 rule (adversarial review 2026-08-17).
    # Wrapped (and with the mid-line comma dropped -- the first line otherwise
    # still grazed the rule at this width), it ends left of t = 0 and stays
    # above the gap band's p75.
    ax.text(0.01, 0.97, f"n = {d['n_events']} displays\n{d['n_sessions']} sessions",
            transform=ax.transAxes, fontsize=6, color=MUTED, va="top")
    save(fig, 5, "b", "upright_dynamics")


if __name__ == "__main__":
    main()
