#!/usr/bin/env python3
"""
Fig 7c -- per-session paired difference in IDF1, LUC3D minus SLEAP, by animal count.

    ############################################################################
    FIXED 2026-08-13, ON ERIC'S INSTRUCTION: THIS PANEL NOW PLOTS THE SHIPPED
    TRACKER -- AND IT IS THE PANEL WHERE THE SUBSTITUTION IS WORST FOR US, which
    is why the >= 3-animal cells are printed at full size and not smoothed.

    Until then its LUC3D column was `matchFrameInstances`, the pre-#131 PER-FRAME
    matcher (run 2026-05-15); `pose/cross-view-tracker.js` was merged 2026-07-06.
    Same pool, same sessions, the corpus mean improves -- paired Δ +0.075 ->
    +0.091, 48/74 -> 55/74 wins -- BUT THE WHOLE GAIN IS THE 2-ANIMAL STRATUM AND
    THE >= 3-ANIMAL CELLS GET WORSE:

        animals  n   Δ IDF1 pre-#131 -> shipped -> fresh   within switches
        1       32   +0.141 -> +0.142 -> +0.142                  0 ->   0 ->   0
        2       35   +0.035 -> +0.075 -> +0.089              3,206 -> 1,744 -> 1,113
        3        4   -0.030 -> -0.052 -> -0.045                205 ->   744 ->    54
        4        3   -0.028 -> -0.080 -> -0.061                299 ->   606 ->   145

    So the shipped tracker emits 3.6x and 2.0x MORE within-view ID switches than the
    tracker it replaced on the 3- and 4-animal sessions, and scores lower there. The
    EXPERIMENTAL fresh anchor removes nearly all of that blow-up (744 -> 54,
    606 -> 145) and recovers part but not all of the IDF1. n = 4 and n = 3 SESSIONS:
    weak evidence, reproducible, and it must not be averaged into the corpus mean.
    The panel prints each stratum's win count over its n under the tick, the worst
    3-4-animal session deepens from -0.103 to -0.152, and `--variant` draws all
    three arms with the switch counts on the artwork.

    ONE CLAIM OF THIS PANEL'S FLIPS AND IT FLIPS OUR WAY, so it needs saying
    plainly rather than being quietly enjoyed: pooled over the 42 sessions with
    >= 2 animals -- the stratum where cross-view association has anything to do --
    the paired advantage goes +0.024 (23/42, sign P = 0.64, no effect) to +0.052
    (30/42, sign P = 0.008). On the retired tracker this panel's own argument was
    that the pooled +0.075 was carried entirely by the 1-animal cell; on the
    shipped tracker the multi-animal stratum stands on its own. The 1-animal
    caveat STAYS on the artwork -- +0.142 there is still detection gating, not
    association, and it is still the largest effect in the figure.

    `--as-shipped` re-renders the retired arm under a `_pre131` slug.
    `figs/out/fig3_trackers.json` is NOT rewritten. Account:
    `figs/out/ITEM3-SLAP2M-GATE.md`.
    ############################################################################

PAIRED, WITH REAL CONFIDENCE INTERVALS. An earlier version of this panel plotted the
two trackers' raw pooled IDF1 side by side and its docstring claimed no spread was
available. That was wrong: `paired_vs_sleap` deposits per-session differences with
95% CIs, win/loss counts and a sign test. The paired form is also the right one --
these are the SAME sessions scored by both trackers, so the difference is measured
within session and the between-session variation cancels.

WHAT IT SHOWS, INCLUDING WHERE LUC3D LOSES. LUC3D is ahead at 1 animal (+0.142,
25/32 wins) and 2 animals (+0.075, 30/35), and BEHIND at 3 (-0.052, 0/4) and 4
(-0.080, 0/3). Those last two cells rest on 4 and 3 sessions; the panel prints the
win count over n ("0/4") under every tick so the reader can weigh them, and the
negative cells are NOT hidden.

EVERY SESSION IS NOW A DOT (review 2026-08). The 3- and 4-animal cells carry 4 and
3 sessions, and a mean with a bootstrap CI over so few values is doing a lot of
implying — review asked for the sessions themselves. Each cell's deposited
per-session differences are drawn as small dots behind the interval (deterministic
golden-ratio jitter; the deposit stores each cell sorted, which does not matter
here because nothing pairs dot to dot). At 3-4 animals the reader now sees the
whole stratum: seven sessions, all below zero, worst -0.152 (it was -0.103 on the
retired tracker -- the substitution deepened the worst case as well as the mean).
The y limits are set by the DOTS, not the CIs — the widest session (+0.365, one
animal) previously sat outside the axes — and the annotation band hangs below the
lowest mark instead of at a fixed fraction.

THE 1-ANIMAL CELL IS STILL NOT A CROSS-VIEW RESULT, and the panel says so on the
artwork rather than leaving the reader to notice. 32 of the 74 sessions -- 43% of the
corpus -- contain ONE animal, and with one animal there is nothing to associate
across views: whatever produces +0.142 there is detection gating and gap handling,
not cross-view association. That cell is also the largest effect in the figure, so it
dominates the pooled statistic. Split at the mechanism boundary:

    1 animal   n = 32   +0.142   25/32   sign P = 0.002
    >= 2       n = 42   +0.052   30/42   sign P = 0.008
    all 74     n = 74   +0.091   55/74   sign P < 0.001

ON THE RETIRED TRACKER THAT >= 2 ROW WAS +0.024, 23/42, P = 0.64 -- no effect -- and
this docstring's argument was that the pooled number was carried entirely by the
1-animal cell. On the shipped tracker the multi-animal stratum clears the sign test
on its own, so the split now supports a WEAKER claim than it was built to make. It
stays for two reasons: the 1-animal cell is still 2.7x the >= 2 cell and still not a
cross-view result, and the two cells where the mechanism should help MOST (3 and 4
animals) are still NEGATIVE, and got more negative.

The >= 2 figure is recomputed here from the deposited per-session differences of the
2-, 3- and 4-animal cells (the deposit has no combined cell). It is the n-weighted
mean of the three cell means -- (35*0.074837 + 4*-0.051852 + 3*-0.079704)/42 =
0.051733 -- so it can be checked by hand against the file. No bootstrap interval is
printed for it: `boot_ci` resamples in the order it is given and the deposit stores
each cell SORTED, so a CI recomputed here would not be the CI the generator would
have produced. The exact sign test does not have that problem, which is why it is the
statistic shown.

Source: figs/out/fig7_variant_best.json `slap2m.paired_vs_sleap` (`slap2m` = the
SHIPPED tracker); with `--variant`, also `slap2m_fresh_anchor`,
`slap2m_pre131_reference`, and `slap2m_arm_comparison` for the per-stratum switch
counts, which are RAW SUMS over camera-sessions and comparable only within this
denominator; with `--as-shipped`, figs/out/fig3_trackers.json `slap2m` (pre-#131).

    python3 figs/panels/fig7_02_by_animals.py               # the manuscript panel
    python3 figs/panels/fig7_02_by_animals.py --variant     # all three arms
    python3 figs/panels/fig7_02_by_animals.py --as-shipped  # retired arm, _pre131 slug
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (footnote, GREY, INK, MUTED, entity, deposit, panel,  # noqa: E402
                       save, text_legend, use)
from fig7_variant_common import (FRESH_LS, arms, flags,  # noqa: E402
                                 pool_note, slug)

#: The two entities this panel contrasts. `entity()` rather than a local TEAL /
#: PERIWINKLE: the sign of the difference is encoded in the two trackers' own set-wide
#: hues, so teal here MUST be the same teal as 7a's LUC3D and 7e's LUC3D bar, and
#: periwinkle the same SLEAP (review finding C3). Colours unchanged.
LUC3D, SLEAP = entity("luc3d"), entity("sleap")
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0



def sign_p(pos, n):
    """Exact two-sided sign test -- the same function `fig3_trackers.py` uses."""
    if n == 0:
        return 1.0
    k = min(pos, n - pos)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def pooled_multi(pv, counts):
    """(mean, wins, n, sign P) over every session with >= 2 animals -- the stratum where
    cross-view association has anything to do. Recomputed from the deposited per-session
    differences because the deposit has no combined cell; see the docstring for why no
    bootstrap interval is printed for it."""
    multi = [v for a in counts if a >= 2 for v in pv[str(a)]["per_session"]]
    w = sum(1 for v in multi if v > 0)
    return sum(multi) / len(multi), w, len(multi), sign_p(w, len(multi))


def main(variant=False, corrected=True):
    use()
    sl, fresh, ref, tab = arms(variant, corrected)
    pv = sl["paired_vs_sleap"]
    counts = sorted(int(k) for k in pv if k != "all")

    if not variant:
        rows = [{"animals": a, "mean": pv[str(a)]["mean"],
                 "ci95_lo": pv[str(a)]["ci95_lo"], "ci95_hi": pv[str(a)]["ci95_hi"],
                 "n_sessions": pv[str(a)]["n_sessions"], "wins": pv[str(a)]["wins"]}
                for a in counts]
        df = pd.DataFrame(rows)
        deposit(df, 7, f"{slug('fig7c_by_animals', variant, corrected)}.csv")
    else:
        df = pd.DataFrame([{"animals": a, "mean": pv[str(a)]["mean"],
                            "ci95_lo": pv[str(a)]["ci95_lo"],
                            "ci95_hi": pv[str(a)]["ci95_hi"],
                            "n_sessions": pv[str(a)]["n_sessions"],
                            "wins": pv[str(a)]["wins"]} for a in counts])
        # THE VARIANT'S TABLE CARRIES THE SWITCH COUNTS TOO, because the >= 3-animal
        # story is a switch story before it is an IDF1 story and a table of paired IDF1
        # differences alone would hide it.
        deposit(pd.DataFrame(
            [{"arm": arm, "animals": a, "mean": blk["paired_vs_sleap"][str(a)]["mean"],
              "ci95_lo": blk["paired_vs_sleap"][str(a)]["ci95_lo"],
              "ci95_hi": blk["paired_vs_sleap"][str(a)]["ci95_hi"],
              "n_sessions": blk["paired_vs_sleap"][str(a)]["n_sessions"],
              "wins": blk["paired_vs_sleap"][str(a)]["wins"],
              "luc3d_within_idf1": tab[tk][str(a)]["within_idf1"],
              "luc3d_within_switches": tab[tk][str(a)]["within_switches"]}
             for arm, blk, tk in (("LUC3D pre-#131 (manuscript panel)", ref,
                                  "pre131_reference"),
                                 ("LUC3D (shipped)", sl, "shipped"),
                                 ("LUC3D + fresh anchor (EXPERIMENTAL)", fresh,
                                  "fresh_anchor"))
             for a in counts]),
            7, "fig7c_by_animals_variant.csv")

    m_mean, m_wins, m_n, m_p = pooled_multi(pv, counts)

    fig, ax = panel("half", ROW_H, key=4 if variant else 0)
    x = np.arange(len(df))
    ax.axhline(0, color=INK, lw=0.8, zorder=1)
    # THE VARIANT DRAWS THREE ARMS PER STRATUM, offset within the tick: the retired
    # pre-#131 arm (MUTED, left), the SHIPPED tracker (centre, the panel's arm), and the
    # EXPERIMENTAL fresh anchor (right, open marker + dashed interval). The session DOTS
    # are the shipped arm's only -- three clouds of 32/35/4/3 sessions in one tick is
    # unreadable, and the shipped arm is the one whose spread the panel is arguing from.
    dx = 0.0 if not variant else 0.24
    for i, r in df.iterrows():
        a = str(int(r.animals))
        color = LUC3D if r["mean"] > 0 else SLEAP
        # The sessions themselves, behind the interval: sign-coloured like the
        # mean, faint, with value-decorrelated golden-ratio jitter.
        vals = np.asarray(pv[a]["per_session"], float)
        jit = ((np.arange(len(vals)) * 0.6180339887) % 1.0 - 0.5) * 0.30
        for xv, yv in zip(i + jit, vals):
            ax.plot([xv], [yv], "o", color=LUC3D if yv > 0 else SLEAP, ms=2.2,
                    alpha=0.45, mec="none", zorder=2)
        if variant:
            for blk, col, hollow in ((ref, MUTED, False), (fresh, LUC3D, True)):
                c = blk["paired_vs_sleap"][a]
                xv = i - dx if col is MUTED else i + dx
                ax.plot([xv, xv], [c["ci95_lo"], c["ci95_hi"]], color=col, lw=1.1,
                        zorder=3, ls=FRESH_LS if hollow else "-")
                ax.plot([xv], [c["mean"]], "o", color=col, ms=4.6,
                        mfc="white" if hollow else col,
                        mec=col if hollow else "white", mew=0.9, zorder=4)
        ax.plot([i, i], [r.ci95_lo, r.ci95_hi], color=color, lw=1.2, zorder=3)
        ax.plot([i], [r["mean"]], "o", color=color, ms=6, mec="white", mew=1.0,
                zorder=4)
        # Label AWAY from zero -- above a positive mean, below a negative one. The
        # 3- and 4-animal means are -0.052 and -0.080 (they were -0.030 and -0.028 on
        # the retired tracker, close enough to the zero rule that a vertically centred
        # label had the rule running through it -- which is why this exists).
        up = r["mean"] > 0
        ax.annotate(f"{r['mean']:+.3f}", (i, r["mean"]), textcoords="offset points",
                    xytext=(9, 4 if up else -4), color=color, fontsize=6.5,
                    va="bottom" if up else "top")

    if variant:
        # THE >= 3-ANIMAL REGRESSION, ON THE ARTWORK, IN NUMBERS. This is the panel's
        # least flattering fact and it is a SWITCH fact before it is an IDF1 fact, so the
        # raw within-view switch sums go in the key beside the paired differences. n is
        # printed in every line because n = 4 and n = 3 is what these cells rest on.
        def line(a):
            pr, ps, pf = (b["paired_vs_sleap"][a]["mean"] for b in (ref, sl, fresh))
            sr, ss, sf = (tab[k][a]["within_switches"]
                          for k in ("pre131_reference", "shipped", "fresh_anchor"))
            return (f"{a} animals (n = {pv[a]['n_sessions']}): Δ {pr:+.3f} → {ps:+.3f} "
                    f"→ {pf:+.3f} · switches {sr:,} → {ss:,} → {sf:,}", INK)
        text_legend(ax, [
            ("LUC3D − SLEAP: shipped (solid) · fresh anchor (open, EXPERIMENTAL)",
             LUC3D),
            ("grey: LUC3D pre-#131, what Fig 7c printed until 2026-08-13", MUTED),
            line("3"), line("4")],
            "above", size=6, dy=0.052 * 52.0 / ROW_H, xy=(0.05, 0.985),
            transform=fig.transFigure)

    ax.set_xticks(x)
    # TWO lines, not three: n is the denominator of the win count, so "25/32" prints
    # both numbers a separate "n = 32" line was printing.
    ax.set_xticklabels([f"{int(r.animals)}\n{int(r.wins)}/{int(r.n_sessions)}"
                        for _, r in df.iterrows()])
    ax.set_xlabel("animals · wins / sessions", labelpad=2)
    # TWO LINES. Rotated, this label sets ~30 mm of type against a ~19 mm axis at
    # this row height, and a rotated label cannot be shrunk by constrained_layout --
    # it is centred on the axes and simply overhangs, so at anything under 52 mm the
    # page cut its ends off (`lint_text.py` CLIPPED). Wrapped it costs width, of
    # which an 88 mm panel has plenty.
    ax.set_ylabel("Δ IDF1\nLUC3D − SLEAP")
    ax.set_xlim(-0.6, len(df) - 0.2)
    # Limits from the DOTS as well as the CIs: the widest session is +0.364, well
    # past the CI-derived band the earlier version used.
    all_vals = np.asarray([v for a in counts for v in pv[str(a)]["per_session"]])
    lim = max(df.ci95_hi.max(), -df.ci95_lo.min(), all_vals.max(),
              -all_vals.min()) * 1.15
    if variant:
        # The other two arms' intervals have to be inside the axes too: the fresh
        # anchor's 4-animal CI is wider than any shipped-arm CI, and an interval drawn
        # outside the limits is silently clipped.
        lim = max([lim] + [abs(b["paired_vs_sleap"][str(a)][k]) * 1.15
                           for b in (ref, fresh) for a in counts
                           for k in ("ci95_lo", "ci95_hi")])
    ax.text(0.98, 0.96, "LUC3D ahead", transform=ax.transAxes, ha="right",
            va="top", color=LUC3D, fontsize=6.5, fontweight="bold")
    ax.text(0.98, 0.04, "SLEAP ahead", transform=ax.transAxes, ha="right",
            va="bottom", color=SLEAP, fontsize=6.5, fontweight="bold")

    # TWO BRACKETS AND TWO NOTES, in the empty band below the data: one over the
    # 1-animal cell saying why its +0.141 cannot be a cross-view result, one over the
    # 2/3/4 cells carrying their pooled statistic. Both notes live BELOW the data
    # rather than beside it -- placed at the top of the axes the 1-animal note landed
    # on that cell's own "+0.141" label (23% overlap). `by` hangs a fixed margin
    # under the LOWEST MARK (dot or CI end) now that session dots are drawn -- the
    # old fixed -0.37*lim ran through the 2-animal cell's -0.177 session.
    by = min(all_vals.min(), df.ci95_lo.min()) - lim * 0.16
    ty = by - lim * 0.10
    # The floor is set by the notes' 6 pt lines under `ty`, not symmetrically: a
    # mirrored -lim left a quarter of the axes empty below them. 0.52, measured: at
    # 0.32-0.36 the BOTTOM SPINE crossed the last text line's bbox and lint flagged
    # both notes ON DATA (a 0.8 pt rule is ~15% of a 6 pt line's box). The variant's
    # right-hand note is THREE lines rather than two (see there), so it needs a further
    # line of clearance (0.84; 0.68 still left the spine on the last line at 15% inked) or the same spine lands on its last line -- measured the same
    # way, and it is a per-render number rather than a constant for the same reason the
    # 0.52 is.
    ax.set_ylim(ty - lim * (0.84 if variant else 0.52), lim)
    for lo, hi in ((-0.28, 0.28), (0.72, 3.28)):
        ax.plot([lo, hi], [by, by], color=GREY, lw=0.8, zorder=1)
        for xe in (lo, hi):
            ax.plot([xe, xe], [by, by + lim * 0.05], color=GREY, lw=0.8, zorder=1)
    # INK for the notes, GREY for the brackets: the notes carry results and GREY
    # (#B3B3B3) is a series colour at 2.1:1 on white.
    ax.text(-0.55, ty, "1 animal: nothing to\nassociate across views",
            color=INK, fontsize=6, ha="left", va="top", linespacing=1.35)
    ax.text(1.15, ty,
            (f"≥ 2 animals pooled: {m_mean:+.3f}\n"
             f"(n = {m_n}, {m_wins}/{m_n}, P = {m_p:.2f})") if not variant else
            # THREE SHORT LINES, NOT TWO LONG ONES, AND THE WIDTH IS THE BINDING
            # CONSTRAINT. This note is anchored at x = 1.15 in data coordinates, i.e.
            # ~40% across the axes, and "SLEAP ahead" is right-aligned at 0.98 on the
            # same baseline band -- so a line here has ~29 characters at 6 pt before it
            # reaches that label -- and the LAST line is the one on that band, which is
            # why `n` sits on line 1 and the P values get the whole of line 3 -- and ~34
            # before a line leaves the 88 mm panel. Two lines
            # carrying three arms' means AND three P values needed 54 (lint: CLIPPED,
            # TRUNCATED, 87% overlap). Wrapped to three short lines nothing is dropped;
            # the arm ORDER is named once in the key above, so it need not repeat here.
            (f"≥ 2 pooled, n = {m_n}\n"
             f"{pooled_multi(ref['paired_vs_sleap'], counts)[0]:+.3f} → {m_mean:+.3f} → "
             f"{pooled_multi(fresh['paired_vs_sleap'], counts)[0]:+.3f}\n"
             f"sign P "
             f"{pooled_multi(ref['paired_vs_sleap'], counts)[3]:.2f} → {m_p:.2f} → "
             f"{pooled_multi(fresh['paired_vs_sleap'], counts)[3]:.2f}"),
            color=INK, fontsize=6, ha="left", va="top", linespacing=1.35)

    a = pv["all"]
    # `P < 0.001` RATHER THAN `P = 0.000`, which is what `.3f` prints for this cell on
    # the shipped tracker (3.4e-05). A rounded-to-zero P reads as a typesetting slip
    # and invites "P = 0", which is never a true statement about a sign test.
    ap = (f"P = {a['sign_p']:.3f}" if a["sign_p"] >= 0.001 else "P < 0.001")
    # TWO lines. On one line this note is wider than the 88 mm panel, and since the
    # panel is saved at exactly that width the final digit of P was cut off the page.
    #
    # THE SECOND LINE USED TO READ "carried by the 1-animal stratum, NOT a
    # multi-animal result", and on the shipped tracker THAT IS NO LONGER TRUE: the
    # >= 2 stratum is +0.052 at 30/42, sign P = 0.008. It still carries MOST of the
    # pooled number (the 1-animal cell is 2.7x the >= 2 one), so the line now states
    # the two numbers and lets the reader do the comparison, rather than making a
    # claim the data has stopped supporting.
    note = (f"all {a['n_sessions']} sessions: {a['mean']:+.3f} "
            f"[{a['ci95_lo']:+.3f}, {a['ci95_hi']:+.3f}], "
            f"{a['wins']}/{a['n_sessions']}, {ap}\n"
            f"mostly the 1-animal cell: {pv['1']['mean']:+.3f} vs {m_mean:+.3f} for ≥ 2")
    if variant:
        ar = ref["paired_vs_sleap"]["all"]
        af = fresh["paired_vs_sleap"]["all"]
        note += (
            f"\nLUC3D here is the SHIPPED tracker: all {a['n_sessions']} sessions "
            f"{ar['mean']:+.3f} ({ar['wins']}/{ar['n_sessions']}) → {a['mean']:+.3f} "
            f"({a['wins']}/{a['n_sessions']}) → {af['mean']:+.3f} "
            f"({af['wins']}/{af['n_sessions']}) for pre-#131 → shipped → fresh anchor; "
            f"the pre-#131 arm is the tracker retired 2026-07-06"
            f"\nTHE CORPUS GAIN IS THE 2-ANIMAL STRATUM ONLY. At 3 animals (n = "
            f"{pv['3']['n_sessions']}) and 4 animals (n = {pv['4']['n_sessions']}) the "
            f"RETIRED tracker is better and the shipped one emits "
            f"{tab['shipped']['3']['within_switches'] / tab['pre131_reference']['3']['within_switches']:.1f}x "
            f"and "
            f"{tab['shipped']['4']['within_switches'] / tab['pre131_reference']['4']['within_switches']:.1f}x "
            f"MORE within-view ID switches "
            f"({tab['pre131_reference']['3']['within_switches']:,} → "
            f"{tab['shipped']['3']['within_switches']:,} and "
            f"{tab['pre131_reference']['4']['within_switches']:,} → "
            f"{tab['shipped']['4']['within_switches']:,})"
            f"\nthe EXPERIMENTAL fresh anchor removes nearly all of that blow-up "
            f"({tab['fresh_anchor']['3']['within_switches']:,} and "
            f"{tab['fresh_anchor']['4']['within_switches']:,}) and recovers part but not "
            f"all of the IDF1 (3 animals: within-view "
            f"{tab['pre131_reference']['3']['within_idf1']:.4f} retired → "
            f"{tab['shipped']['3']['within_idf1']:.4f} shipped → "
            f"{tab['fresh_anchor']['3']['within_idf1']:.4f} fresh). n = 4 and n = 3 "
            f"SESSIONS: weak, reproducible, never to be averaged away"
            f"\n{pool_note()}")
    footnote(ax, note)
    save(fig, 7, "c", slug("by_animals", variant, corrected))


if __name__ == "__main__":
    main(*flags(sys.argv))
