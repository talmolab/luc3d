#!/usr/bin/env python3
"""
Fig 7a -- within-view vs cross-view IDF1: which trackers hold identity ACROSS cameras.

THE HEADLINE RESULT OF THE WHOLE FIGURE, and the one my first pass omitted entirely.
A per-camera tracker can score well within a view and still have no idea that
camera 0's animal 1 is camera 3's animal 1. This panel measures exactly that: the
same sessions scored within view, then across views.

LUC3D 0.749 -> 0.749 (x1.00): no drift at all, because cross-view identity is what
it solves. SLEAP 0.115 -> 0.062 (x0.53) and ByteTrack 0.157 -> 0.046 (x0.29) lose
half to three-quarters of their score, because nothing in a per-camera tracker links
views. 3D-MuPPET is flat but at 0.011 -- flatness alone is not the claim; height and
flatness have to be read together.

THE RULE AT 0.20 IS A CEILING, NOT A CHANCE LEVEL, and an earlier version of this
panel got that wrong. It drew the same rule labelled "1/C, C = 5" and its docstring
called it "THE CHANCE LINE ... every per-camera tracker's cross-view score sits BELOW
chance". That contradicted the deposit this panel reads from. `caveats`:

    "Cross-view IDF1 is bounded near 1/C for any tracker with no cross-view
     association mechanism (0.20 at C=5, 0.167 at C=6). At C=5 the per-camera
     trackers land far BELOW that bound ... so the bound is a ceiling on what they
     could achieve, not a level they reach."

WHAT THE RULE ACTUALLY IS. Cross-view IDF1 pools all C cameras into one accumulator
with one global identity per animal. A tracker that labels each camera independently
can have its labelling matched to the truth in at most ONE camera; the other C - 1
cameras carry labels that cannot simultaneously be right. So 1/C = 0.20 is the BEST
such a tracker could score -- an upper bound it fails to reach, not a coin-flip
baseline. CHANCE, by contrast, is set by the number of ANIMALS: with 2 mice, guessing
the cross-view assignment is right about half the time, so a chance level would sit
near 0.5, far ABOVE where SLEAP and ByteTrack land. Both facts are printed at the
rule, because a reader who takes 0.20 for chance draws a WEAKER conclusion than the
data supports -- 0.062 and 0.046 are below the ceiling, which is the stronger claim.

Every mean now carries its deposited 95% CI (`ci95_lo`/`ci95_hi`, bootstrap over
sessions) at both ends of its slope; the panel previously plotted bare means, so a
reader could not see that LUC3D's two intervals coincide (the no-drift result).

Source: figs/out/fig3_trackers.json `bmimica_50_sessions`, `bmimica_wins`, `caveats`.

    python3 figs/panels/fig7_05_within_vs_cross.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, PERIWINKLE, PINK, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: (deposit key, name on the artwork, colour). The deposit calls SLEAP's entry
#: "SLEAP per-camera"; the artwork says "SLEAP" so the name matches panels c-f --
#: the figure used to call the same tracker two different things -- and the
#: per-camera / cross-view split is stated once in the footer instead.
ORDER = [("LUC3D", "LUC3D", TEAL), ("SLEAP per-camera", "SLEAP", PERIWINKLE),
         ("ByteTrack", "ByteTrack", SALMON), ("3D-MuPPET", "3D-MuPPET", PINK)]
NCAM = 5


def main():
    use()
    t = load("fig3_trackers.json")
    bm = t["bmimica_50_sessions"]
    wins = t["bmimica_wins"]
    rows, entries = [], []
    # THE VALUE LABELS LIVE IN THE KEY BAND, not beside their own lines. They were
    # annotated at x = 1.05 with `annotation_clip=False`, which constrained_layout
    # DOES account for -- so the four labels squeezed the axes into the left half of
    # the panel (measured: axes 44.5 of 88 mm) and pulled the centred x-axis footer
    # left with it until its leading characters fell off the page. In the band the
    # plot keeps its full width and the footer is centred on a full-width axis.
    fig, ax = panel("half", "std", key=len(ORDER))
    for rank, (key, name, color) in enumerate(ORDER):
        if key not in bm:
            continue
        wv, cv = bm[key]["within"], bm[key]["cross"]
        w, c = wv["mean"], cv["mean"]
        rows.append({"tracker": name, "within": w,
                     "within_ci95_lo": wv["ci95_lo"], "within_ci95_hi": wv["ci95_hi"],
                     "cross": c,
                     "cross_ci95_lo": cv["ci95_lo"], "cross_ci95_hi": cv["ci95_hi"],
                     "ratio": c / w if w else float("nan"),
                     "n_sessions": wv["n_sessions"]})
        ax.plot([0, 1], [w, c], color=color, lw=2.0, zorder=3)
        for x, s in ((0, wv), (1, cv)):
            ax.plot([x, x], [s["ci95_lo"], s["ci95_hi"]], color=color, lw=1.0,
                    solid_capstyle="butt", zorder=3)
        ax.plot([0, 1], [w, c], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)
        entries.append((f"{name}  {w:.3f} → {c:.3f} ×{c / w:.2f}", color))

    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7a_within_vs_cross.csv")

    # The rule, and what it is. See the docstring: 1/C is the CEILING for a tracker
    # that labels each camera independently, and chance is set by the animal count.
    # Both are printed, because the two readings support different conclusions and
    # the deposit's own caveat picks the ceiling one.
    ax.axhline(1 / NCAM, color=GREY, lw=0.8, ls=(0, (2.5, 1.5)), zorder=1)
    # Anchored at the axes' left edge (x = -0.13), not at x = 0, so the two lines fit
    # inside the plot without running under the tracker values.
    ax.text(-0.13, 1 / NCAM + 0.03,
            f"1/C = {1 / NCAM:.2f}: ceiling for a per-camera tracker "
            "(SLEAP, ByteTrack)\n"
            "not a chance level — chance with 2 animals ≈ 0.5",
            color=GREY, fontsize=6.5, va="bottom", linespacing=1.4)

    text_legend(ax, entries, "above")
    ax.set_xlim(-0.15, 1.05)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["within view", "cross view"])
    ax.set_ylabel("IDF1")
    ax.set_ylim(0, 0.95)
    # "full" distinguishes these from Fig 3d's 6,000-frame leading windows over the
    # same corpus. `drift_abs_max` and the cross-view win counts are deposited and
    # were on the legacy panel; both had been dropped.
    drift = bm["LUC3D"]["drift_abs_max"]
    xwins = min(w["cross"]["wins"] for w in wins.values())
    xn = min(w["cross"]["n"] for w in wins.values())
    # THREE SHORT LINES, not two long ones. At 7.5 pt (what `footnote` sets) the
    # single-line version measured 77 mm and the per-camera line 80 mm on an 88 mm
    # panel; the x label is centred on the axes, so anything wider than the axis
    # extent hangs off the left of the page and the renderer drops the overhang
    # without complaint. Every line here is under 64 mm.
    footnote(ax, f"n = {int(df.n_sessions.iloc[0])} full BMimica sessions, "
             f"{NCAM} cameras, 2 mice\n"
             f"mean ± 95% CI; LUC3D drift ≤ {drift:.3f} in every session\n"
             f"ahead of every other tracker in {xwins}/{xn} sessions")
    save(fig, 7, "a", "within_vs_cross")


if __name__ == "__main__":
    main()
