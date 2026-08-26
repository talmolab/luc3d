#!/usr/bin/env python3
"""
Fig 5g -- confirms the leader from raw rears: she goes first, he joins in.

WHAT THE CURVE IS. Take every rear ONSET by one animal (9,354 of them across 56
Mouse-Dyad-10M sessions) and read out the probability that the OTHER animal is rearing at
each lag around it, divided by that other animal's own base rate. 1.0 is chance. This
is the measurement the rest of the figure rests on -- it is why "both animals reared
at once" is worth defining as an event at all -- and until now it appeared only as one
number in the figure's footer.

TWO TITLED SUB-AXES, NOT ONE SHARED AXIS (revised 2026-08-21, third redesign of this
panel -- see below for why). Each direction has its OWN reference onset -- "male rear
to female onset" and "female rear to male onset" are two different questions with two
different t=0 instants -- but a single shared axis with one vertical dashed line at
"lag 0" visually implies both curves share the same reference moment, which they do
not. Splitting into two sub-axes, each with its own title naming its own onset,
removes that ambiguity outright rather than trying to word around it. This is the
SAME fix already used for the analogous problem in
`panels/fig12_01_coupling_replication.py` (three corpora, each its own sub-axis,
titled, sharing one y-axis).
  * LEFT -- "male rear to female onset": his rearing probability, aligned to her
    onset. At the instant she starts he is BELOW his own chance rate (0.6x) -- not yet
    rearing -- and climbs to 1.7x about 0.8 s later as he catches up. He IS more
    likely than chance to be rearing once she has been up for a moment; it is
    delayed, not absent.
  * RIGHT -- "female rear to male onset": her rearing probability, aligned to his
    onset. At the instant he starts she is ALREADY 4.7x more likely than chance to be
    rearing, peaking at 5.3x a third of a second later.
  * WHY THE RIGHT PANEL IS THE DRAMATIC ONE, not a mistake: a plain co-occurrence
    enrichment is direction-symmetric by construction (P(both)/(P(male)xP(female))
    does not care which name comes first) -- the asymmetry exists ONLY because onset
    breaks that symmetry, and it does so via who is JOINING whom, not "whose rear is
    more potent". Of his near rear onsets, she is already mid-rear 50.2% of the time
    (pooled; 50.0% session median, n=25 sessions) -- literally already up half the
    time he begins, which is what makes the RIGHT panel rise almost instantly. Of her
    near rear onsets, he is already mid-rear only 6.2% of the time (pooled; 3.3%
    session median, n=39 sessions) -- she is starting fresh, which is why the LEFT
    panel sits below chance at lag 0 and only builds afterward.
  * SO BOTH PANELS TELL THE SAME STORY AS FIG 5F, not a different one: hers usually
    comes first (94% of the time he is not yet up when she starts) and his usually
    follows (half of his onsets are joining her). The median catch-up lag over a full
    merged display is 0.37 s (Fig 5c); the 0.8 s here is the same catch-up measured
    directly from raw rear onsets, on far more data (9,354 onsets vs 539 displays)
    and without the display definition's own holding-time requirement.
  * SLAP-2M, WHICH HAS NO SEX CONVENTION TO SPLIT BY, shows no such asymmetry either
    (already-mid-bout 37.9% vs 39.4% for its two directions, ~equal) -- the BMimica
    asymmetry is not an artefact of the split itself.
  * FAR and NULL still bound the claim exactly as before in both panels: FAR (same
    animals, more than 2 body lengths apart) stays flat at ~1.05x, and NULL
    (circular-shift) stays flat at ~0.99x, so neither curve is a base-rate or
    autocorrelation artefact -- both need proximity, and both need the other
    animal's real timing.

REVISION HISTORY (kept so this isn't relitigated a fourth time). Try 1 coloured by
whose onset anchors t=0 with verb-phrase labels ("male initiates") -- read as a
statement about the male's own action when it was actually the female's probability.
Try 2 coloured by whose probability is plotted, matching 5b -- correct, but the
dramatic curve landing on "female" while a shared axis still implied one reference
instant made it read as backwards. Try 3 (this one) keeps the try-2 colour meaning
(each sub-axis plots ONE animal's own probability) but gives each direction its own
axis and title, so there is no shared t=0 to misread in the first place.

NO IN-PANEL NUMBERS (2026-08-21): the onset/peak enrichment values and the
already-mid-bout percentages used to be printed on each sub-axis; both are exact
numbers stated in this docstring and belong in the caption, not repeated on the
artwork -- the panel now carries only the curves, titles and axis labels.

THE NULL IS A CIRCULAR SHIFT, NOT A RESHUFFLE. Rears last about a second and cluster,
so scattering onsets destroys the autocorrelation too and makes almost anything look
significant. Rotating keeps the rate, the bout durations and the autocorrelation
exactly and destroys only the alignment between the two animals -- the one thing
under test.

ONLY SESSIONS THAT CAN MEASURE THE CONDITION VOTE. A session contributes a curve to a
condition only if it supplies at least 20 onsets in it (`MIN_ONSETS` in
`fig4_rear_coupling.py`), counted PER DIRECTION for near_i0/near_i1 -- a session with
plenty of onsets from her but few from him (expected, since she initiates most
displays) can vote on one direction and not the other.

THE CURVES DO NOT RETURN TO 1.0 at the edges; they settle above it. That is proximity,
not timing: two animals that are close at one moment tend to still be close seconds
later, and being close is itself associated with rearing. The COUPLING is the peak
above that shoulder, and each panel is drawn over +-5 s so the shoulder is visible
rather than cropped away.

Source: figs/out/fig5_rear_coupling_2animal.json (figs/fig4_rear_coupling.py
        --slap-animals 2).

    python3 figs/panels/fig5_12_coupling.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, grid, save, text_legend, use  # noqa: E402

# male / female -- same colours as 5b. Each appears on exactly ONE sub-axis (his own
# probability on the left, aligned to her onset; her own probability on the right,
# aligned to his onset), so colour and axis position carry the same information twice
# rather than needing a legend to disambiguate an anchor.
CM, CFEM = "#4393C3", "#D6604D"
CF = "#E5C494"      # far (either direction, pooled -- unchanged)
CX = "#B3B3B3"      # circular-shift null

#: (data key, colour, sub-axis title, own-animal name, whose onset t=0 is).
PANELS = [("near_i1", CM, "male rear to female onset", "male", "female"),
          ("near_i0", CFEM, "female rear to male onset", "female", "male")]


def main():
    use()
    d = load("fig5_rear_coupling_2animal.json")["corpora"]["BMimica"]
    t = np.asarray(d["t"], float)
    deposit(pd.DataFrame({
        "lag_s": t,
        # his rearing probability, aligned to her onset
        "male_p25": d["near_i1"]["p25"], "male_p50": d["near_i1"]["p50"],
        "male_p75": d["near_i1"]["p75"],
        # her rearing probability, aligned to his onset
        "female_p25": d["near_i0"]["p25"], "female_p50": d["near_i0"]["p50"],
        "female_p75": d["near_i0"]["p75"],
        "far_p50": d["far"]["p50"], "null_p50": d["null"]["p50"],
        "null_p25": d["null"]["p25"], "null_p75": d["null"]["p75"],
    }), 4, "fig4g_rear_coupling.csv")

    # TWO-THIRDS, up from half (2026-08-19): 5f became a narrow two-box panel, so
    # this one takes the freed width. 57.3 + 117.3 + the 4 mm gutter is the page.
    # SEPARATE Y-AXES: male's curve tops out at 2.6x, female's at 6.8x. Shared, the
    # male panel's real dip-then-rise (0.6x -> 1.7x) was compressed into the bottom
    # third of the axis and hard to read; each panel now scales to its own data.
    fig, axes = grid(1, 2, span="two-thirds", row="short", sharey=False)
    for ax, (key, col, title, who, anchor) in zip(axes, PANELS):
        ax.fill_between(t, d["null"]["p25"], d["null"]["p75"], color=CX, alpha=0.55,
                        lw=0, zorder=1)
        ax.fill_between(t, d[key]["p25"], d[key]["p75"], color=col, alpha=0.18,
                        lw=0, zorder=2)
        ax.plot(t, d["far"]["p50"], color=CF, lw=1.6, zorder=3)
        ax.plot(t, d["null"]["p50"], color=CX, lw=1.2, ls=(0, (3, 1.6)), zorder=3)
        ax.plot(t, d[key]["p50"], color=col, lw=1.8, zorder=4)
        ax.axhline(1.0, color=INK, lw=0.7, ls=":", alpha=0.6, zorder=1)
        ax.axvline(0, color=INK, lw=0.7, ls="--", alpha=0.5, zorder=1)

        ax.set_xlim(t[0], t[-1])
        ax.set_xticks([-4, -2, 0, 2, 4])
        ax.set_xlabel(f"lag from {anchor} onset (s)")
        ax.set_title(title, fontsize=7, color=INK, pad=3)
        # PER-PANEL Y-RANGE, each with headroom above its own p75 for the notes.
        if key == "near_i1":
            ax.set_ylim(0, 3.1)
            ax.set_yticks([0, 1, 2, 3])
        else:
            ax.set_ylim(0, 7.4)
            ax.set_yticks([0, 1, 2, 3, 4, 5, 6])
        ax.set_ylabel(f"{who} rearing\n(× its own chance rate)")

    # JUST THE TWO REFERENCE LINES, not male/female: each sub-axis already carries
    # exactly one colour plus its own title ("when she starts a rear" + a blue
    # curve unambiguously names the male curve), so repeating "male"/"female" in a
    # legend was redundant AND -- once each panel got its own y-scale -- collided
    # with its own peak (the male panel's real peak reaches 2.7 on a 0-3.1 axis,
    # leaving far less headroom than the old shared 0-7.4 scale gave it).
    text_legend(axes[0], [("further apart", CF), ("circular-shift null", CX)],
                loc="lower right", dy=0.088, size=6.5)
    save(fig, 4, "g", "rear_coupling")


if __name__ == "__main__":
    main()
