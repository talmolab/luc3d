#!/usr/bin/env python3
"""
Fig 3d -- greedy vs exhaustive against GROUND TRUTH, per configuration.

REPLACES the association-runtime panel (review 2026-08). Runtime appeared twice in
this figure -- panel d as ms/frame across rig sizes, panel f as the same series
inside the head-to-head -- while the question the figure actually owes the reader,
"is the cheap grouping as GOOD as the published exhaustive one?", had no panel of
its own: 3f's title carries agreement between the two methods, but agreement with
each other is not accuracy. This panel scores BOTH methods against the proofread
ground truth, per frame, on exactly the frames the exhaustive method could be run
at all -- so the published method is compared at its best, never on a frame it had
to skip.

WHAT IS PLOTTED: the RATE at which a configuration's grouping differs from the GT
partition -- misgrouped frames per 10,000 clean frames -- with the raw count still
printed beside each marker. Bars would be invisible at these values; dodged markers
with the count printed beside each are not.

THE AXIS IS A RATE BECAUSE THE FOUR CONFIGURATIONS HAVE WILDLY DIFFERENT n (review
2026-08). They are scored on 122,830 / 14,275 / 200 / 366 clean frames, so on a
count axis exhaustive's 3 misgroupings in the 366-frame 4x3 configuration sat
adjacent to its 1 misgrouping in the 122,830-frame 2x5 one -- while as rates those
are 82 and 0.0 per 10,000, three orders of magnitude apart. A total is
uninterpretable without its denominator, and a count axis invited exactly the
cross-configuration comparison the denominators forbid.

PER 10,000 RATHER THAN PERCENT, chosen on how the numbers read: every value here is
under 0.9%, and the two headline totals are 0.00073% and 0.0029% -- four leading
zeros, which no reader can hold or compare. Per 10,000 clean frames puts the axis on
integer ticks (0 / 20 / 40 / 60 / 80) and the headline totals at 0.07 and 0.29.
(Fig 7e's rates ARE plain percent; there the values are 0.03-11%, where percent is
the unit nobody has to convert. The unit follows the magnitude, not a house rule.)

THE COUNTS ARE STILL ON THE ARTWORK, beside each marker, because "1 frame" is a fact
worth stating and a rate alone hides how few events these percentages rest on: the
2x6 configuration's 0.70 per 10,000 is ONE frame, and the 4x3's 82 per 10,000 is
three. The counts are 0, 1 and 3 -- that IS the finding, and the panel states the
totals: over 137,671 clean frames LUC3D's greedy grouping misses 1 (0.07 per 10,000)
and the exhaustive optimum misses 4 (0.29 per 10,000).

THE DISAGREEMENTS DO NOT SPLIT EVENLY, and that is the most interesting number in
the deposit: on the 5 frames where the two methods choose different groupings, the
ground truth sides with greedy on 4 of them. The minimum-reprojection-error grouping
is not always the right grouping -- exhaustive picks it by construction, greedy
happens not to. Optimising the reprojection objective harder than greedy does buys
nothing here, because the objective itself runs out before the search does.

(An earlier version of this panel printed "each method misgroups exactly one of the
137,266 clean frames". That was true of the deposit it was written against; the
current deposit says 1 and 4, with all three extra exhaustive misses in the 4x3
configuration. Both counts are now read from the data at draw time.)

READ THE CEILING HONESTLY. These are the CLEAN frames -- every camera holds
exactly A detections, occlusion-heavy frames excluded by construction (the
composition note on 3f). Near-perfect grouping on clean frames is a statement
about clean frames; neither method is being called perfect overall. The GT
matching transfers proofread identities over an IoU-0.5 match that is
near-saturated on this pool (49 of 1,402,015 detection keys unmatched, all in the
2x6 configuration) -- honest counts in the deposit's `gt_matching` blocks.

Source: figs/out/fig3_quality.json (fig3_quality.py + fig3_rescore_frames.mjs,
over the same per-frame outputs fig3_headtohead.json was computed from).

    python3 figs/panels/fig3_04_quality.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: Method -> (deposit key, display name, colour). SALMON/TEAL match 3a and 3f:
#: salmon is the published exhaustive method, teal is LUC3D, everywhere in Fig 3.
METHODS = [("exhaustive", "exhaustive", SALMON), ("greedy", "LUC3D (greedy)", TEAL)]

#: Rate basis. 10,000 clean frames -- see the docstring for why not percent.
PER = 10_000


def build():
    q = load("fig3_quality.json")
    rows = []
    for c in q["configs"]:
        if c.get("status") != "ok":
            continue
        for key, name, _ in METHODS:
            g = c["gt"][key]
            rows.append({
                "label": f"{c['animals']}×{c['cameras']}",
                "hypotheses": None, "method": name,
                "frames": g["frames"],
                "gt_exact": g["exact_match_frames"],
                "misgrouped": g["frames"] - g["exact_match_frames"],
                # The rate the axis plots, and the count it prints, from the SAME
                # two numbers -- so the marker height and the label beside it
                # cannot disagree.
                "misgrouped_per_10k": (g["frames"] - g["exact_match_frames"])
                / g["frames"] * PER,
                "pair_accuracy_mean": g["pair_accuracy_mean"],
                "n_agree": c["n_agree"], "n_compared": c["n_compared"],
            })
    df = pd.DataFrame(rows)
    detail = [d for c in q["configs"] for d in c.get("disagreement_detail", [])]
    return df, detail


def main():
    use()
    df, detail = build()
    deposit(df, 3, "fig3d_quality.csv")

    fig, ax = panel("third", "std", key=len(METHODS))
    labels = list(dict.fromkeys(df.label))
    x = np.arange(len(labels))
    # Headroom in the SAME proportion the count version used (data max at 3, axes
    # to 3.4, floor at -0.2), so the geometry the notes below were placed against
    # is unchanged by the switch to a rate.
    top = float(df.misgrouped_per_10k.max()) * 3.4 / 3.0
    for mi, (key, name, color) in enumerate(METHODS):
        g = df[df.method == name].set_index("label").loc[labels]
        xs = x + (mi - 0.5) * 0.30
        ax.plot(xs, g.misgrouped_per_10k, "o", color=color, ms=5.5, mec="white",
                mew=1.0, zorder=3)
        # THE RAW COUNT IS THE PRINTED NUMBER, the rate is the height. One
        # misgrouped frame is a fact worth stating and a rate hides how few
        # events it rests on; the axis carries the denominator instead.
        for xi, v, n in zip(xs, g.misgrouped_per_10k, g.misgrouped):
            ax.text(xi, v + 0.038 * top, str(int(n)), ha="center", va="bottom",
                    color=color, fontsize=6.5, fontweight="bold")

    text_legend(ax, [(n, c) for _, n, c in METHODS], "above")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_xlim(-0.55, len(labels) - 0.45)
    # HEADROOM INSIDE THE AXES for both notes. They used to be an `ax.set_title` and
    # a `footnote` (which folds into the x label): in a 57 x 52 mm panel that put a
    # 3-line title, a 2-line key and a 4-line label around a plot area of 5 dots, and
    # constrained_layout resolved it by CLIPPING -- the y label lost its first
    # character, seven text runs were dropped from the PDF entirely, and the title
    # printed straight through the key (lint: 2 CLIPPED, 3 OVERLAP, 7 TRUNCATED).
    # The panel's own title is redundant besides: assemble.py draws one from TITLES.
    # The data occupy the bottom third of the axes, so both notes go inside.
    ax.set_ylim(-0.2 / 3.0 * float(df.misgrouped_per_10k.max()), top)
    # Ticks from the locator over the positive range rather than typed in: the
    # rate depends on the deposit's frame counts, so a hard-coded [0, 1, 2] would
    # go stale the moment the pool changes.
    ax.set_yticks([t for t in ax.get_yticks() if 0 <= t <= top])
    ax.set_ylabel("frames misgrouped vs GT\nper 10,000 clean frames")
    ax.set_xlabel("animals × cameras")

    total = int(df[df.method == "LUC3D (greedy)"].frames.sum())
    wrong = {n: int(df[df.method == n].misgrouped.sum()) for _, n, _ in METHODS}
    #: Pooled rate over ALL clean frames -- the honest denominator for a total, and
    #: the number the two headline sentences below are missing without it.
    rate = {n: wrong[n] / total * PER for _, n, _ in METHODS}
    # BOTH COUNTS, EACH IN ITS METHOD'S COLOUR, and computed rather than typed. The
    # previous version printed "each method misgroups 1 of 137,266 clean frames" in
    # teal, which was true of the deposit it was written against and is not true of
    # this one: on the 4x3 configuration exhaustive now misses 3 frames and greedy
    # none, so the totals are 4 and 1. A hard-coded reading of the data is exactly
    # the failure a re-run is supposed to catch, and it only surfaced because the
    # panel was re-rendered.
    ax.text(0.03, 0.98, f"LUC3D misgroups {wrong['LUC3D (greedy)']} of\n"
            f"{total:,} clean frames\n"
            f"({rate['LUC3D (greedy)']:.2f} per 10,000)",
            transform=ax.transAxes, ha="left", va="top",
            color=TEAL, fontsize=6.5, fontweight="bold", linespacing=1.25)
    ax.text(0.03, 0.70, f"exhaustive misgroups {wrong['exhaustive']}\n"
            f"({rate['exhaustive']:.2f} per 10,000)",
            transform=ax.transAxes, ha="left", va="top", color=SALMON,
            fontsize=6.5, fontweight="bold", linespacing=1.25)
    # The 1-1 split, from the deposit's disagreement_detail (not typed in): on one
    # of the two frames where the methods differ, the reprojection-error OPTIMUM is
    # the GT-wrong grouping. What that MEANS is caption text (FIGURE-LEGENDS.md);
    # the panel carries the counts.
    gt_g = sum(1 for d in detail if d.get("gt_matches") == "greedy")
    gt_e = sum(1 for d in detail if d.get("gt_matches") == "exhaustive")
    ns = [int(df[df.label == lab].frames.iloc[0]) for lab in labels]
    # 0.50, not 0.66: both notes above gained their rate line, so this one drops
    # by two line heights. The n list is what makes the rates checkable.
    ax.text(0.03, 0.50,
            "n = " + " · ".join(f"{n:,}" for n in ns) + " frames\n"
            f"they disagree on {len(detail)}: GT sides with\n"
            f"LUC3D on {gt_g}, exhaustive on {gt_e}",
            transform=ax.transAxes, ha="left", va="top", color=MUTED, fontsize=6,
            linespacing=1.25)
    save(fig, 3, "d", "quality")


if __name__ == "__main__":
    main()
