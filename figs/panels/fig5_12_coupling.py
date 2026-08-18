#!/usr/bin/env python3
"""
Fig 5g -- the coupling itself: one animal's rear makes the other's far more likely,
but only when they are close.

WHAT THE CURVE IS. Take every rear ONSET by one animal (9,354 of them across 56
Mouse-Dyad-10M sessions) and read out the probability that the OTHER animal is rearing at
each lag around it, divided by that other animal's own base rate. 1.0 is chance. This
is the measurement the rest of the figure rests on -- it is why "both animals reared
at once" is worth defining as an event at all -- and until now it appeared only as one
number in the figure's footer.

THE THREE CURVES ARE THE ARGUMENT, not decoration:
  * NEAR (the two within 2 body lengths at the onset) rises to 2.9x chance at the
    onset itself and peaks at 4.0x about half a second later. Half a second is the
    time it takes to get up: the other animal is responding.
  * FAR (more than 2 body lengths apart) is flat at 1.05x. Same animals, same
    session, same detector -- the effect needs proximity, so it is not a shared drive
    such as a disturbance in the room or a time-of-session drift, which would lift
    both conditions equally.
  * NULL is a CIRCULAR SHIFT of the other animal's rear series, 24 per pair, and it
    is flat at 0.99x with a tight band. A reshuffle would have been the wrong null:
    rears last about a second and cluster, so scattering onsets destroys the
    autocorrelation too and makes almost anything look significant. Rotating keeps the
    rate, the bout durations and the autocorrelation exactly and destroys only the
    alignment between the two animals -- the one thing under test.

THE NEAR CURVE DOES NOT RETURN TO 1.0 at the edges; it settles near 1.2x. That is
proximity, not timing: two animals that are close at one moment tend to still be close
seconds later, and being close is itself associated with rearing. The COUPLING is the
peak above that shoulder, and the panel is drawn over +-5 s so the shoulder is visible
rather than cropped away.

ONLY SESSIONS THAT CAN MEASURE THE CONDITION VOTE. A session contributes a curve to a
condition only if it supplies at least 20 onsets in it (`MIN_ONSETS` in
`fig5_rear_coupling.py`); 21 of 56 sessions fail that for NEAR because their two
animals are rarely within two body lengths. Aggregated without the rule the near
band's p25 sat at 0.00 while its median was 2.2x -- a quarter of sessions were
contributing curves of mostly zeros, which is noise with the right units, not
evidence of no effect.

THE HONEST NEGATIVE, in the caption rather than on the panel: SLAP-2M's two-animal
sessions give 1.08x near and 0.97x far. Its arena is 3.2 body lengths across against
Mouse-Dyad-10M's 6.9, so "within 2 body lengths" is most of the time there and the near/far
contrast barely exists.

Source: figs/out/fig5_rear_coupling_2animal.json (figs/fig5_rear_coupling.py
        --slap-animals 2).

    python3 figs/panels/fig5_12_coupling.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, text_legend, use  # noqa: E402

CN = "#8DA0CB"      # near
CF = "#E5C494"      # far
CX = "#B3B3B3"      # circular-shift null


def main():
    use()
    d = load("fig5_rear_coupling_2animal.json")["corpora"]["BMimica"]
    t = np.asarray(d["t"], float)
    i0 = int(np.argmin(np.abs(t)))
    deposit(pd.DataFrame({
        "lag_s": t,
        "near_p25": d["near"]["p25"], "near_p50": d["near"]["p50"],
        "near_p75": d["near"]["p75"],
        "far_p50": d["far"]["p50"], "null_p50": d["null"]["p50"],
        "null_p25": d["null"]["p25"], "null_p75": d["null"]["p75"],
    }), 5, "fig5g_rear_coupling.csv")

    fig, ax = panel("half", "short")
    ax.fill_between(t, d["null"]["p25"], d["null"]["p75"], color=CX, alpha=0.55,
                    lw=0, zorder=1)
    ax.fill_between(t, d["near"]["p25"], d["near"]["p75"], color=CN, alpha=0.18,
                    lw=0, zorder=2)
    ax.plot(t, d["far"]["p50"], color=CF, lw=1.6, zorder=3)
    ax.plot(t, d["null"]["p50"], color=CX, lw=1.2, ls=(0, (3, 1.6)), zorder=3)
    ax.plot(t, d["near"]["p50"], color=CN, lw=1.8, zorder=4)
    ax.axhline(1.0, color=INK, lw=0.7, ls=":", alpha=0.6, zorder=1)
    ax.axvline(0, color=INK, lw=0.7, ls="--", alpha=0.5, zorder=1)

    near = np.asarray(d["near"]["p50"], float)
    pk = int(np.argmax(near))
    ax.set_xlim(t[0], t[-1])
    ax.set_ylim(0, 6.6)          # headroom above the p75 for the notes
    ax.set_yticks([0, 1, 2, 3, 4, 5])
    ax.set_xticks([-4, -2, 0, 2, 4])
    ax.set_xlabel("lag from one animal's rear onset (s)")
    ax.set_ylabel("other animal rearing\n(× its own chance rate)")

    text_legend(ax, [("within 2 body lengths", CN), ("further apart", CF),
                     ("circular-shift null", CX)], loc="upper right", dy=0.088,
                size=6.5)
    # The two counts are NOT the same population and the label says so: the onset
    # total is every rear in the corpus, while the near curve is the subset of
    # sessions that supply enough near onsets to estimate it.
    ax.text(0.02, 0.985,
            f"{near[i0]:.1f}× at the onset, {near[pk]:.1f}× at "
            f"{t[pk]:+.1f} s\n{d['n_onsets']['all']:,} onsets · {d['n_sessions']} "
            f"sessions (near: {d['near']['n_sessions']})",
            transform=ax.transAxes, ha="left", va="top", fontsize=6, color=MUTED,
            linespacing=1.3)
    save(fig, 5, "g", "rear_coupling")


if __name__ == "__main__":
    main()
