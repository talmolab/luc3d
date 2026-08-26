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

THE TWO CURVES ARE NOW MALE/FEMALE, NOT RANKS (revised 2026-08-21). Until now they
were "reaches higher"/"reaches lower", assigned PER EVENT by which animal peaked
higher, explicitly NOT by identity -- an adversarial pass had found that label changes
hands within a session on about a quarter of displays, so averaging by TRACK identity
was rejected as something that would "wash both curves toward their mean" without the
figure being able to say what identity meant. What changed: Eric pointed out that
track slot in this corpus is not an arbitrary per-session label after all -- slot 0 is
always male and slot 1 always female (checked against every session's track_names: 6
animal IDs seen only at slot 0, 9 only at slot 1, zero in both) -- so keying by track
is keying by SEX, which is exactly the identity axis that does not wash out: female is
the one that reaches higher on 80.9% of displays, not ~50%, so male/female curves stay
separated by nearly the same margin the old hi/lo curves showed by construction. Male
is structurally the LONGER animal (median 90.1 vs 84.2 mm body length, male longer in
29/37 sessions, paired Wilcoxon P<0.0001) and still the one that reaches lower here:
whatever makes the difference, it is not who is bigger -- see `fig5_10_leader.py`.

Height in this panel is a within-display measurement in units of each animal's own
body length (each mouse's own median nose-to-tail-base distance), because the corpus
spans animals of different sizes; millimetres would mix growth with posture.

Band is the across-session p25-p75 of the per-session median curves.

Source: figs/out/fig5_upright.json `peri.{t0,t1,gap}` (figs/fig4_upright.py).

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

# male / female -- distinct from the teal/pink "taller"/"shorter" pair panels a and c
# still use for their own (rank, not sex) framing, so a colour never carries two
# different meanings across the figure.
CA, CB = "#4393C3", "#D6604D"      # male, female
CG = "#FC8D62"                     # the nose gap


def main():
    use()
    d = load("fig5_upright.json")
    t = np.asarray(d["t"], float)
    p = d["peri"]
    deposit(pd.DataFrame({
        "t_s": t,
        "male_p50": p["t0"]["p50"], "female_p50": p["t1"]["p50"],
        "nose_gap_p50": p["gap"]["p50"],
        "male_p25": p["t0"]["p25"], "male_p75": p["t0"]["p75"],
        "female_p25": p["t1"]["p25"], "female_p75": p["t1"]["p75"],
        "nose_gap_p25": p["gap"]["p25"], "nose_gap_p75": p["gap"]["p75"],
    }), 4, "fig4d_upright_dynamics.csv")

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
    for key, c in (("t0", CA), ("t1", CB)):
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

    # MALE/FEMALE, not "reaches higher"/"reaches lower" (revised 2026-08-21) -- see
    # the docstring: track slot 0/1 is a stable sex identity in this corpus, so this
    # is the same separation the old rank labels showed, now with the identity that
    # actually explains it.
    text_legend(ax, [("male", CA), ("female", CB), ("nose gap", CG)])

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
    save(fig, 4, "b", "upright_dynamics")


if __name__ == "__main__":
    main()
