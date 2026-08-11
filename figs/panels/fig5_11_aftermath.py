#!/usr/bin/env python3
"""
Fig 5g -- how the display ends: the initiator turns away, the follower keeps watching.

THE QUESTION THIS REPLACED. The panel used to show that the two animals' peak heights
match within a display (0.91 against a shuffled null of 0.86). That is true, small, and
says nothing about the animals' relationship. What happens AFTER the display does.

WHAT IT SHOWS. Body-axis angle to the partner, from the display's last frame onward:
0 deg is pointed straight at the partner, 180 deg is pointed straight away. At the
moment the display breaks the two animals are ALREADY asymmetric -- initiator 61 deg,
follower 30 deg -- and they diverge from there: by 3 s the initiator is at 88 deg,
side-on or past it, while the follower is still at 37 deg, pointed at the animal it was
displaying with. Per session (24 sessions with >=5 displays) the initiator's angle is
larger in 22 of 24, median 76 vs 30 deg at 1 s (Wilcoxon p = 1.2e-6).

SO THE ANSWER TO "DOES THE FOLLOWER FLEE" IS NO, and the asymmetry runs the other way
from the obvious guess: the animal that started the display is the one that breaks it
off. Nobody leaves -- at 3 s the pair is still within 2 body lengths after 72% of
displays, and the follower has moved AWAY by more than half a body length after only
21% of them.

THE CONTROL, and why the "still together" number is NOT in the headline. Each display
is matched to a moment in the same session at the same separation (+-0.15 BL) with the
animals not both reared and no display within 3 s. After those matched moments the pair
is still within 2 BL 74% of the time -- indistinguishable from the display's 72%. Two
mice 0.9 body lengths apart in a cage stay near each other whatever just happened, so
"they stay together" is not a finding and is not claimed. The same control puts the two
roles at 56 vs 46 deg, a 10 deg gap against the display's 35 deg, which is what makes
the asymmetry specific to the display rather than to the way the roles are defined.

THE SECOND FACT ON THE PANEL. A display is followed by ANOTHER display within 10 s on
40% of occasions, against 18% after the matched moments (paired by session: 0.35 vs
0.11, higher in 22 of 24, p = 4e-5) and a 6% base rate at a random moment when the two
are within 2 body lengths. The display is not a terminal event; it comes in bouts.

Source: figs/out/fig5_aftermath.json (figs/fig5_aftermath.py).

    python3 figs/panels/fig5_11_aftermath.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, text_legend, use  # noqa: E402

CI = "#66C2A5"      # initiator -- the same hue panel d gives it
CF = "#E78AC3"      # follower
CC = "#B3B3B3"      # the matched control
MIN_DISPLAYS = 5


def curves(ev, key, kind):
    """Per-session median curve, then the across-session p25/p50/p75."""
    df = pd.DataFrame([{"session": e["session"], **{f"v{i}": v
                                                    for i, v in enumerate(e[key])}}
                       for e in ev if e["kind"] == kind])
    g = df.groupby("session").filter(lambda x: len(x) >= MIN_DISPLAYS)
    m = g.groupby("session").median()
    return (np.percentile(m, 25, axis=0), np.median(m, axis=0),
            np.percentile(m, 75, axis=0), m.shape[0])


def main():
    use()
    d = load("fig5_aftermath.json")
    t = np.asarray(d["t"], float)
    ev = d["events"]

    (i25, i50, i75, ns) = curves(ev, "facing_init", "display")
    (f25, f50, f75, _) = curves(ev, "facing_follow", "display")
    (_, ci50, _, _) = curves(ev, "facing_init", "control")
    (_, cf50, _, _) = curves(ev, "facing_follow", "control")
    deposit(pd.DataFrame({
        "t_s": t, "initiator_p50": i50, "initiator_p25": i25, "initiator_p75": i75,
        "follower_p50": f50, "follower_p25": f25, "follower_p75": f75,
        "control_initiator_p50": ci50, "control_follower_p50": cf50,
    }), 5, "fig5g_aftermath.csv")

    D = [e for e in ev if e["kind"] == "display"]
    C = [e for e in ev if e["kind"] == "control"]
    rq_d = float(np.mean([e["requeue_10s"] for e in D]))
    rq_c = float(np.mean([e["requeue_10s"] for e in C]))

    fig, ax = panel("half", "short")
    for lo, mid, hi, c in ((i25, i50, i75, CI), (f25, f50, f75, CF)):
        ax.fill_between(t, lo, hi, color=c, alpha=0.16, lw=0)
        ax.plot(t, mid, color=c, lw=1.8, zorder=3)
    # The control as ONE grey band spanning its two roles, not two more lines: its
    # point is that the gap between the roles nearly vanishes, and a band states that
    # better than a pair of curves the reader has to difference by eye.
    ax.fill_between(t, cf50, ci50, color=CC, alpha=0.45, lw=0, zorder=1)

    ax.set_xlim(0, t[-1])
    # HEADROOM, not a corner. Every corner of the data area is inked: the initiator
    # band reaches the top right, the follower band the bottom, and the control band
    # the middle. The raised limit reserves a strip above 100 deg that no curve can
    # enter, which is where all three notes go.
    ax.set_ylim(0, 152)
    ax.set_yticks([0, 45, 90])
    ax.set_xlabel("time from the end of the display (s)")
    ax.set_ylabel("body axis to partner (°)")
    ax.axhline(90, color=INK, lw=0.7, ls=":", alpha=0.5, zorder=1)

    # The key goes INSIDE, top right, with its own line spacing: `loc="above"` puts
    # it in figure coordinates at a fixed 0.052 of figure height, which on a 40 mm
    # row is 2.1 mm of lead for 2.8 mm type -- the two entries overlapped (lint:
    # OVERLAP 34%). The top right is clear because the initiator's band only reaches
    # it after t = 1 s and stops below 120 deg.
    text_legend(ax, [("initiator", CI), ("follower", CF)], loc="upper right",
                dy=0.115)
    ax.text(0.02, 0.99,
            f"0° = pointed at the partner · grey: matched control\n"
            f"another display within 10 s: {100 * rq_d:.0f}% "
            f"(control {100 * rq_c:.0f}%) · {ns} sessions",
            transform=ax.transAxes, ha="left", va="top", fontsize=6, color=MUTED,
            linespacing=1.3)
    save(fig, 5, "g", "aftermath")


if __name__ == "__main__":
    main()
