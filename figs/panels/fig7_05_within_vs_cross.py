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

THIS PANEL'S "WITHIN VIEW" IS NOT PANEL c'S. Both are called within-view IDF1 and
they are different quantities: 0.749 here is BMimica, 50 sessions, C = 5, while c is
SLAP-2M, 74 sessions, C = 6, where LUC3D's within-view mean is 0.736 and its median
0.900. Nothing about the two numbers announces the difference -- 0.749 and 0.736 look
like the same measurement rounded twice -- so the corpus is named in this panel's
footer AND the pointer `c-g: SLAP-2M` rides on its last line, with the mirror note on
c. See the footnote comment for why it goes there rather than on a fourth line.

Every mean now carries its deposited 95% CI (`ci95_lo`/`ci95_hi`, bootstrap over
sessions) at both ends of its slope; the panel previously plotted bare means, so a
reader could not see that LUC3D's two intervals coincide (the no-drift result).

FOUR TRACKERS HERE, THREE IN b-g, AND THE KEY SAYS WHY. 3D-MuPPET is measured on
BMimica only; the SLAP-2M deposit has no 3D-MuPPET column anywhere. The tracker sets
genuinely differ between the two corpora, but a reader who is not told that reads the
missing fourth series as a dropped comparison -- so its key entry carries
"· BMimica only", right where the question comes up.

Source: figs/out/fig3_trackers.json `bmimica_50_sessions`, `bmimica_wins`, `caveats`.

    python3 figs/panels/fig7_05_within_vs_cross.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, entity, footnote, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: (deposit key, name on the artwork, colour). The deposit calls SLEAP's entry
#: "SLEAP per-camera"; the artwork says "SLEAP" so the name matches panels c-g --
#: the figure used to call the same tracker two different things -- and the
#: per-camera-ness is carried at the 0.20 rule instead, which is the one place it is
#: load-bearing: the rule is the ceiling *because* SLEAP and ByteTrack label each
#: camera on its own, and both names are printed there.
#:
#: COLOURS COME FROM `entity()`, not from a hue picked here. All four series are
#: recurring ENTITIES -- LUC3D, SLEAP and ByteTrack appear in five of this figure's
#: seven panels and in Figs 3-5 as well -- so their hues are reserved set-wide and
#: `entity()` is the only place that mapping lives. Hard-coding TEAL/PERIWINKLE here
#: is how periwinkle came to mean DLT in Fig 4 and SLEAP in Fig 7 (review finding C3).
#: The hues are unchanged by the switch; what changes is that they can no longer
#: drift apart panel by panel.
ORDER = [("LUC3D", "LUC3D", entity("luc3d")),
         ("SLEAP per-camera", "SLEAP", entity("sleap")),
         ("ByteTrack", "ByteTrack", entity("bytetrack")),
         ("3D-MuPPET", "3D-MuPPET", entity("3d-muppet"))]

#: WHY THIS PANEL HAS FOUR SERIES AND b-g HAVE THREE, said next to the series that is
#: only here. 3D-MuPPET is measured on BMimica alone: `fig3_trackers.json` lists it
#: under `bmimica_50_sessions` and nowhere under `slap2m`, whose `within_view`,
#: `error_decomposition` and paired tables carry luc3d/sleap/bytetrack only. Read with
#: the figure footer ("a: 50 BMimica sessions ... b-g: 74 SLAP-2M sessions") that is a
#: complete answer to "where did the fourth tracker go", and it rides in the key band
#: `panel(key=...)` has already reserved, so it costs no axes height -- see the
#: footnote comment below for what a fourth footnote line would have cost instead.
#: Entry measures 65.6 mm from the key's x = 12.3 mm, i.e. 77.9 of 88 mm.
CORPUS_NOTE = {"3D-MuPPET": "· BMimica only"}
NCAM = 5

#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render, this panel's ink spanned 50.0 of 52.1 mm and the page came to 196.3 mm --
#: 19.3% of its scanlines carrying no ink at all (review findings 6.12 / C9). At 47 mm
#: the ink is the same ink: nothing is resized, no type is touched, the axes simply
#: stops being taller than its content. A row is as tall as its TALLEST panel, so this
#: only pays if its row-mate (7b) comes down with it, which it does.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0

#: `text_legend`'s "above" branch hard-codes `dy = 0.052` in FIGURE coordinates, i.e.
#: 2.70 mm at the 52 mm height it was tuned for and 2.44 mm at 47 mm -- and 8 pt type
#: sets a ~3.24 mm span box, so at the shorter height the four key lines would overlap
#: by 25% of a box and `lint_text.py` would (correctly) fail. Passing `dy` and an
#: explicit `transform` keeps the ABSOLUTE line spacing at 2.70 mm, so the key reads
#: exactly as it did at 52 mm. This is the documented way to override that branch: it
#: is skipped when `transform` is not None, and `xy` then supplies the anchor the
#: branch would have set.
KEY_DY = 0.052 * 52.0 / ROW_H


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
    fig, ax = panel("half", ROW_H, key=len(ORDER))
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
        # errorbar, and ms=3.2 rather than 5: LUC3D's interval is +-0.04, which a
        # 5 pt marker covers completely -- the whiskers were drawn and invisible.
        # Caps make a +-0.04 interval readable at a plot height of ~25 mm.
        for x, s in ((0, wv), (1, cv)):
            ax.errorbar([x], [s["mean"]],
                        yerr=[[s["mean"] - s["ci95_lo"]], [s["ci95_hi"] - s["mean"]]],
                        fmt="o", color=color, ms=3.2, mec="white", mew=0.6,
                        elinewidth=1.0, capsize=1.8, capthick=1.0, zorder=5)
        entry = f"{name}  {w:.3f} → {c:.3f} ×{c / w:.2f}"
        if name in CORPUS_NOTE:
            entry += f"  {CORPUS_NOTE[name]}"
        entries.append((entry, color))

    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7a_within_vs_cross.csv")

    # The rule, and what it is. See the docstring: 1/C is the CEILING for a tracker
    # that labels each camera independently, and chance is set by the animal count.
    # Both are printed, because the two readings support different conclusions and
    # the deposit's own caveat picks the ceiling one.
    # entity("ceiling") -- the same GREY every bound in the set is drawn in (Fig 5's
    # oracle, Fig 4's random baseline). A bound is not a method and must not borrow a
    # method's hue.
    ax.axhline(1 / NCAM, color=entity("ceiling"), lw=0.8, ls=(0, (2.5, 1.5)),
               zorder=1)
    # Anchored at the axes' left edge (x = -0.13), not at x = 0, so the two lines fit
    # inside the plot without running under the tracker values.
    ax.text(-0.13, 1 / NCAM + 0.015,
            f"1/C = {1 / NCAM:.2f}: ceiling for a per-camera tracker "
            "(SLEAP, ByteTrack)\n"
            "not a chance level — chance with 2 animals ≈ 0.5",
            color=MUTED, fontsize=6.5, va="bottom", linespacing=1.4)

    text_legend(ax, entries, "above", dy=KEY_DY, xy=(0.14, 0.985),
                transform=fig.transFigure)
    ax.set_xlim(-0.15, 1.05)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["within view", "cross view"])
    ax.set_ylabel("IDF1")
    ax.set_ylim(0, 0.95)
    # Explicit: the shorter plot made matplotlib fall back to 0.0 / 0.5 alone, and
    # a reader cannot place the 0.20 rule against two ticks.
    ax.set_yticks([0, 0.2, 0.4, 0.6, 0.8])
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
    # without complaint. Every line here is under 68 mm, measured.
    #
    # A FOURTH LINE IS NOT FREE, which is why the "BMimica only" note rides in the
    # key instead (see CORPUS_NOTE). `footnote` folds into the x label, so each line
    # is 3.2 mm taken out of THIS panel's axes: measured, a fourth line shrinks the
    # plot from 22.0 to 18.8 mm, and the two-line ceiling annotation then fills a
    # third of the data area. The key band is already reserved by `panel(key=4)`.
    #
    # `c–g: SLAP-2M` RIDES ON LINE 3 FOR THAT REASON, and it is not decoration.
    # TWO DIFFERENT QUANTITIES IN THIS FIGURE ARE BOTH CALLED "within-view IDF1":
    # this panel's 0.749 is BMimica, 50 sessions, C = 5; panel c's survival curve is
    # SLAP-2M, 74 sessions, C = 6, where the same tracker's within-view mean is 0.736
    # and its median 0.900. A reader who meets 0.749 here and a curve centred near
    # 0.90 there has no way to know they are different corpora unless BOTH panels say
    # so, so each names its own corpus AND points at the other (c carries the mirror
    # note "a is BMimica"). Naming only this one would still leave c unlabelled.
    footnote(ax, f"n = {int(df.n_sessions.iloc[0])} full BMimica sessions, "
             f"{NCAM} cameras, 2 mice\n"
             f"mean ± 95% CI; LUC3D drift ≤ {drift:.3f} in every session\n"
             f"ahead of every tracker in {xwins}/{xn} sessions · c–g: SLAP-2M")
    save(fig, 7, "a", "within_vs_cross")


if __name__ == "__main__":
    main()
