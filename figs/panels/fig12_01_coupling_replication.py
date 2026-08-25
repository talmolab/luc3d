#!/usr/bin/env python3
"""
Fig 12a -- the proximity-gated rear coupling reproduces in NEITHER further corpus.

Fig 5g's finding, re-measured on two more corpora with the SAME detector, the same
circular-shift null and the same per-session aggregation (`fig12_social.py` imports
`session_coupling` from `fig5_rear_coupling.py` rather than reimplementing it). All three
share one y-axis, so the comparison is the panel's geometry and not a scaling choice:

  * Mouse-Dyad-10M (novel mice): near rises to 2.9x at the onset and peaks at 4.0x half
    a second later -- the time it takes to get up. Far is flat at 1.2x, null at 1.0x.
    Near >> far is what makes it social.
  * SLAP-2M (familiar mice): near peaks at 1.3x and sits at 1.1x at the onset, inside its
    own null band. Far is 1.0x. There is no coupling to find.
  * s-DANNCE SCN2A (rats, genotypes pooled): near peaks at 1.7x, clear of the null, and
    the rats co-rear the most of any corpus here in absolute terms (1,042 displays,
    1.11/min, 7x the Mouse-Dyad-10M rate). SYNCHRONISED REARING IS PRESENT. What is
    absent is what makes Fig 5's version social: FAR PEAKS AT 1.5x, essentially equal to
    near, so the elevation is not proximity-gated -- something lifts both animals'
    rearing together whether or not they are near each other (arena, time in session, a
    disturbance) -- and there is no consistent initiator (panel c). The rats therefore
    show above-chance co-rearing WITHOUT the proximate coupling and leader structure,
    which is a weaker phenomenon than Fig 5's, not the absence of one.

THE NEAR *AND* FAR NUMBERS ARE BOTH ON THE ARTWORK for exactly that reason. The near
curve alone cannot distinguish interaction from a common cause; the near-minus-far gap
is the test, and it is 2.8x, 0.3x and 0.2x across the three panels.

NONE OF THE THREE IS UNDERPOWERED, and the panel prints the counts that establish it.
SLAP-2M supplies 1,358 near onsets and SCN2A 5,254 -- the most of any corpus here --
against Mouse-Dyad-10M's 2,915. A corpus with more near onsets and a flatter near/far
contrast is evidence of absence, not absence of evidence.

WHAT THE FIXED 2 BODY-LENGTH CUT COSTS, stated because the strong form of the claim
depends on it: SLAP-2M's arena is 3.2 body lengths across and Mouse-Dyad-10M's 6.9, so
"within 2 body lengths" is 48% of the time in one and 17% in the other. Under the
self-normalising tertile split the corpora read 1.75x / 1.37x / 1.67x -- the same
direction, a much smaller gap, overlapping bands. Panel b carries that arm rather than
letting the reader assume the fixed cut is the only analysis.

GENOTYPE IS NOT RESOLVED IN THE SCN2A ARM, and this panel does NOT test the s-DANNCE
paper's claim. Klibaite et al. report that SCN2A KO rats perform MORE synchronised rears
than wild-types: a claim about RATE, between GENOTYPES. Two reasons this panel cannot
speak to it. First, the deposit copy on this machine carries the per-session 3D but not
the per-cohort `ratgen`/`ratp_gen` fields, so all 29 dyads are pooled -- and the dyads are
not even genotype-homogeneous (`ratgen` and `ratp_gen` are separate fields per session).
Second and more fundamental, the enrichment plotted here DIVIDES BY EACH ANIMAL'S OWN
BASE RATE, so a genotype that simply rears more is normalised away by construction. The
measurement is deliberately blind to exactly the effect that paper reports. Their event
definition also differs -- their synchronised rears come from the deposit's behavioural
clustering (`cz_action`/`sz_joint`), not from a neck-height criterion. Testing their claim
would need the genotype fields and a rate measure, and is a separate analysis.

Source: figs/out/fig12_social.json (figs/fig12_social.py --corpus slap-2m
        --corpus mouse-dyad-10m --corpus scn2a).

    python3 figs/panels/fig12_01_coupling_replication.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, corpus, deposit, grid, save, text_legend, use  # noqa: E402

CN = "#8DA0CB"      # near  -- same hues as Fig 5g, so the panels read as one series
CF = "#E5C494"      # far
CX = "#B3B3B3"      # circular-shift null

#: (data key, printed label). Novel first, so the reader meets the established result
#: before the two corpora that fail to reproduce it. Corpus is encoded by POSITION here
#: -- one sub-axis each, titled -- so this panel needs no corpus colours; blue/tan/grey
#: are the near/far/null conditions, exactly as in Fig 5g.
ARMS = [("mouse-dyad-10m", "novel mice"), ("slap-2m", "familiar mice"),
        ("scn2a", "rats, mixed genotype")]


def main():
    use()
    D = load("fig12_social.json")["coupling"]

    rows = []
    for key, _ in ARMS:
        d = D[key]
        t = np.asarray(d["t"], float)
        for cond in ("near", "far", "null"):
            c = d[cond]
            if not c:
                continue
            rows.append(pd.DataFrame({
                "corpus": corpus(key), "condition": cond, "lag_s": t,
                "p25": c["p25"], "p50": c["p50"], "p75": c["p75"],
                "n_sessions": c["n_sessions"],
            }))
    deposit(pd.concat(rows, ignore_index=True), 12, "fig12a_coupling_replication.csv")

    fig, axes = grid(1, len(ARMS), span="full", row="short", sharey=True)
    for ax, (key, fam) in zip(np.ravel(axes), ARMS):
        d = D[key]
        t = np.asarray(d["t"], float)
        i0 = int(np.argmin(np.abs(t)))
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
        ax.set_ylim(0, 6.6)
        ax.set_yticks([0, 1, 2, 3, 4, 5])
        ax.set_xticks([-4, -2, 0, 2, 4])
        ax.set_xlabel("lag from one animal's rear onset (s)")
        ax.set_title(f"{corpus(key)} — {fam}", fontsize=7, color=INK, pad=3)
        # Peak AND onset value, plus the near-onset count: the three numbers a reader
        # needs to tell "no effect" from "not enough data to see one".
        far = np.asarray(d["far"]["p50"], float)
        # NEAR *AND* FAR, because the contrast between them is the test: a near peak
        # that its own far peak matches is a shared drive rather than a proximate social
        # effect (fig5_rear_coupling.py's own criterion). SCN2A reads 1.7x near against
        # 1.5x far -- co-rearing IS above chance there, so the near number alone would
        # overstate how much of Fig 5's finding reproduced.
        ax.text(0.02, 0.985,
                f"near {near[pk]:.1f}× at {t[pk]:+.1f} s, far "
                f"{far[int(np.argmax(far))]:.1f}×\n"
                f"{d['n_onsets']['near']:,} near onsets · "
                f"{d['near']['n_sessions']}/{d['n_sessions']} sessions",
                transform=ax.transAxes, ha="left", va="top", fontsize=6, color=MUTED,
                linespacing=1.3)

    np.ravel(axes)[0].set_ylabel("other animal rearing\n(× its own chance rate)")
    # The key goes on the RATS axis, not the first one: its curves peak at 1.7 so its
    # upper half is empty, whereas Mouse-Dyad-10M's near peak reaches 4.1 and the key
    # landed on the notes there (lint 2026-08-20).
    text_legend(np.ravel(axes)[-1],
                [("within 2 body lengths", CN), ("further apart", CF),
                 ("circular-shift null", CX)], loc="upper right", dy=0.088, size=6.5)
    save(fig, 12, "a", "coupling_replication")


if __name__ == "__main__":
    main()
