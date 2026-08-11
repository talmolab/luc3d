#!/usr/bin/env python3
"""
Fig 5d -- the approach: they close, hold, and separate; the initiator waits.

TWO SERIES, TWO THINGS.

MUTUAL VELOCITY (left axis) is the rate of change of the tail-base separation, in body
lengths per second. Negative is closing. It runs at about -0.1 through the approach,
reaches -0.18 at contact, and crosses zero and reverses to +0.09 within a second --
so the display is a closing, a hold, and a withdrawal rather than two animals drifting
past each other. Zero is marked because the sign is the content.

INDIVIDUAL SPEED (right axis), each animal's own tail-base speed divided by its OWN
whole-session median, split by who started the display. This is the panel's finding:
the INITIATOR IS THE SLOWER ANIMAL THROUGHOUT -- 0.66x its baseline a second before
contact against the follower's 1.07x. The initiator stops and rears; the follower is
still travelling and closes the distance. Both drop at contact (0.38x and 0.87x),
which is the stillness Fig 5e quantifies.

WHY EACH ANIMAL IS NORMALISED TO ITSELF. Absolute speeds would mix body size, cage and
recording day into a comparison whose whole point is initiator versus follower within
the same event. Dividing by each animal's own median removes all of that and leaves the
contrast.

Curves are the across-session median of per-session medians; bands p25-p75 over the 37
sessions. The window is +/-2 s around display onset (t = 0 is when the SECOND animal
reaches the rear threshold, so the initiator's own rise happens before it).

Source: figs/out/fig5_upright.json `peri.{dsep,spd_init,spd_follow}`.

    python3 figs/panels/fig5_09_upright_velocity.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (INK, MUTED, deposit, panel, save,  # noqa: E402
                       text_legend, use)

CV = "#FC8D62"       # mutual velocity
CI = "#66C2A5"       # initiator
CF = "#E78AC3"       # follower


def main():
    use()
    d = load("fig5_upright.json")
    t = np.asarray(d["t"], float)
    p = d["peri"]
    for k in ("dsep", "spd_init", "spd_follow"):
        if p.get(k) is None:
            raise SystemExit(
                f"fig5_upright.json has no `peri.{k}` -- re-run figs/fig5_upright.py "
                f"(an earlier version computed these per session and dropped them "
                f"in the summary step)")
    deposit(pd.DataFrame({
        "t_s": t, "sep_velocity_bl_s": p["dsep"]["p50"],
        "initiator_speed_rel": p["spd_init"]["p50"],
        "follower_speed_rel": p["spd_follow"]["p50"],
    }), 5, "fig5d_upright_velocity.csv")

    fig, ax = panel("third", "std", key=3)
    ax.fill_between(t, p["dsep"]["p25"], p["dsep"]["p75"], color=CV, alpha=0.16, lw=0)
    ax.plot(t, p["dsep"]["p50"], color=CV, lw=1.9, zorder=4)
    ax.axhline(0, color=INK, lw=0.7, ls="-", alpha=0.35, zorder=1)
    ax.axvline(0, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)
    ax.set_xlabel("time from display onset (s)")
    ax.set_ylabel("separation velocity\n(body lengths / s) · − = closing")
    lo = min(p["dsep"]["p25"]); hi = max(p["dsep"]["p75"])
    pad = 0.35 * (hi - lo)
    ax.set_ylim(lo - pad * 0.3, hi + pad)
    # THE SIGN CONVENTION LIVES IN THE Y LABEL, not as a floating annotation. Two
    # placements were tried inside the axes (at the trough, and below the zero rule
    # hard left) and both came back 91-96% inked -- the velocity band covers the full
    # width of this panel at every t. A label cannot collide with the data.

    ax2 = ax.twinx()
    for key, c in (("spd_init", CI), ("spd_follow", CF)):
        ax2.plot(t, p[key]["p50"], color=c, lw=1.5, ls=(0, (3, 1.5)), zorder=3)
    ax2.set_ylabel("speed / own baseline", fontsize=6.5, color=MUTED)
    ax2.tick_params(axis="y", labelsize=6.5, colors=MUTED)
    ax2.set_ylim(0, 1.55)
    ax2.spines["top"].set_visible(False)
    ax2.spines["right"].set_color("#BBBBBB")

    text_legend(ax, [("separation velocity", CV), ("initiator speed", CI),
                     ("follower speed", CF)])
    save(fig, 5, "d", "upright_velocity")


if __name__ == "__main__":
    main()
