#!/usr/bin/env python3
"""
Fig 7d -- error composition: false positives and ID switches, as a PERCENTAGE of
camera-frames.

    ############################################################################
    FIXED 2026-08-13, ON ERIC'S INSTRUCTION: THIS PANEL NOW PLOTS THE SHIPPED
    TRACKER, and its "LUC3D does not win on switches" note is GONE because the
    shipped tracker does win. Until then the LUC3D column came from
    `fig3_trackers.json`, where it was produced by `matchFrameInstances`, the
    pre-#131 PER-FRAME matcher, on 2026-05-15; `pose/cross-view-tracker.js` was
    merged 2026-07-06. Same pool, same 444 camera-sessions:

        ID switches        3,710 -> 3,094  (0.0316% -> 0.0264% of camera-frames)
        false positives   34,240 -> 37,126 (0.292%  -> 0.317%)

    THE SWITCH CLAIM FLIPS SIGN. The retired arm's note read "LUC3D DOES NOT WIN
    ON WITHIN-VIEW SWITCHES ... SLEAP's 3,608 is fractionally better". The shipped
    tracker is at 3,094 against SLEAP's UNCHANGED 3,608 -- LUC3D ahead by 14% --
    and the experimental fresh anchor at 1,312, a 2.7x margin.

    THAT CORRECTION IS IN OUR FAVOUR, SO THE ONE THAT IS NOT MUST BE DRAWN WITH IT:
    the shipped tracker emits 8.4% MORE false positives than the tracker it
    replaced (34,240 -> 37,126). Both terms are bars on this panel, so a reader
    gets both movements or neither -- and the FP bars are ~12x the switch bars, so
    the term we lost on is the one the eye lands on first. That is the correct
    emphasis and it is not to be "fixed".

    `--as-shipped` re-renders the retired arm under a `_pre131` slug; `--variant`
    additionally draws the fresh anchor and marks the retired heights as grey
    rules. `figs/out/fig3_trackers.json` is NOT rewritten. Account:
    `figs/out/ITEM3-SLAP2M-GATE.md`.
    ############################################################################

PERCENTAGES, NOT RAW COUNTS (review 2026-08, second pass). The counts-version's
bars were exact but unanchored: "3,710 switches" means nothing without the
exposure it accumulated over. A first revision normalised to errors per 100,000
camera-frames; review then asked for plain percent -- the unit nobody has to
convert: an ID switch happens on 0.0264% of LUC3D's camera-frames, i.e. the
tracker holds identity on 99.97% of them, which is the sentence a reader takes
away. The denominator comes from the deposit itself
(`slap2m.total_camera_frames` = 11,726,640, summed from the motmetrics
per-camera-session frame counts at generation time, verified identical across
trackers), never typed in here; the panel refuses a deposit without it. The RAW
COUNTS are retained in the deposited CSV, so nothing is lost to the
normalisation.

FALSE NEGATIVES ARE DELIBERATELY NOT PLOTTED, and the caption must say why. They are
98.8-99.3% of every tracker's error budget, so a chart including them shows three
identical bars and hides the terms a tracker actually controls. The FN share is
stated in the footer instead; the bars are the controllable remainder.

An earlier version plotted all three SHARES OF THE ERROR BUDGET on a log axis.
That was legible but answered the wrong question: shares of a budget dominated
by detection say more about the detector than the tracker. Percentages of
EXPOSURE (camera-frames) are what separate the trackers -- ID switches LUC3D
0.0264% against ByteTrack 0.105%, a 4.0x reduction.

THREE SIGNIFICANT FIGURES, AND IT HAS TO BE THREE. Both switch rates round to the
same two-significant-figure string: LUC3D 0.0264% and SLEAP 0.0308% become "0.026 vs
0.031", which understates a 17% gap, and ByteTrack's 4.0x ratio is only recoverable
from 0.105 / 0.0264. (On the retired arm this mattered even more -- 0.0316 vs 0.0308
was a real dead heat that two figures turned into a coincidence of rounding.) `%.3g`
keeps three significant figures on both the large FP percentages and the small switch
ones.

LUC3D NOW WINS ON WITHIN-VIEW SWITCHES, WHICH IT DID NOT BEFORE. 3,094 against
SLEAP's 3,608 -- 14% fewer, and 0.0264% vs 0.0308% of camera-frames. This paragraph
used to say the opposite ("SLEAP's 3,608 is fractionally better"), and that was a true
statement ABOUT THE RETIRED TRACKER, whose 3,710 was a dead heat with SLEAP. What has
NOT changed: LUC3D still fragments MORE than SLEAP, which is the panel next door (Fig
7g), and it still emits more false positives than either the retired arm or SLEAP --
so "wins on switches" is not "wins on 7d".

Source: figs/out/fig7_variant_best.json `slap2m.error_decomposition` (`slap2m` = the
SHIPPED tracker); with `--variant`, also `slap2m_fresh_anchor` = experimental arm and
`slap2m_pre131_reference` = the retired arm, drawn as grey reference rules; with
`--as-shipped`, figs/out/fig3_trackers.json `slap2m` (pre-#131).

    python3 figs/panels/fig7_03_error_decomposition.py               # the manuscript panel
    python3 figs/panels/fig7_03_error_decomposition.py --variant     # + fresh anchor
    python3 figs/panels/fig7_03_error_decomposition.py --as-shipped  # retired, _pre131 slug
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (MUTED, footnote, entity, deposit, panel, save,  # noqa: E402
                       text_legend, use)
from fig7_variant_common import (FRESH_LABEL, FRESH_NOTE, SHIPPED_LABEL,  # noqa: E402
                                 arms, flags, pool_note, slug)

#: Hues from `entity()` -- one hue per tracker across the whole set, resolved in one
#: place instead of re-picked per panel (review finding C3). Colours unchanged.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]
TERMS = [("false_positives", "false positives"), ("id_switches", "ID switches")]
BAR_W = 0.26
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

#: `text_legend`'s "above" branch hard-codes `dy = 0.052` in FIGURE coordinates: 2.70
#: mm at the 52 mm height it was tuned for, 2.44 mm at 47 mm. An 8 pt span box is
#: ~3.24 mm, so at the shorter height the three names overlapped by 23% of a box and
#: `lint_text.py` failed. Passing `dy` with an explicit `transform` (which is how that
#: branch is bypassed) holds the spacing at 2.70 mm, so the key reads unchanged.
KEY_DY = 0.052 * 52.0 / ROW_H

#: fig11-compact type size, source pt: the DEFAULT render ships inside fig11's
#: 2x2 block at ~0.48 vector scale (fig11_sync.BLOCK_ROWS), so 11.5 pt prints
#: ~5.5 pt there (Eric, 2026-08-25: bigger ticks/labels/legends/numbers on the
#: block panels). The --variant diagnostic keeps its original sizes.
COMPACT_FS = 11.5



def main(variant=False, corrected=True, fresh_arm=False):
    use()
    sl, fresh, ref, _tab = arms(variant, corrected, fresh_arm)
    ed = sl["error_decomposition"]
    tcf = sl.get("total_camera_frames")
    if not tcf:
        sys.exit("fig7e: the deposit has no slap2m.total_camera_frames -- re-run "
                 "figs/fig3_trackers.py (or figs/fig7_variant_tracker.py --slap2m, "
                 "which is what the corrected render reads) to regenerate it.")

    # THE SERIES, AND THE VARIANT'S EXTRA ARM. `--variant` puts the SHIPPED tracker in
    # the LUC3D slot and draws the experimental fresh anchor beside it, both in
    # `entity("luc3d")` teal -- the arm is distinguished by a HATCH and by the word
    # EXPERIMENTAL in the key, never by recolouring LUC3D (see fig7_variant_common).
    # (block, label, colour, hatch)
    series = [(sl, SHIPPED_LABEL if variant else "LUC3D", entity("luc3d"), None)]
    if variant:
        series.append((fresh, FRESH_LABEL, entity("luc3d"), "////"))
    series += [(sl, "SLEAP", entity("sleap"), None),
               (sl, "ByteTrack", entity("bytetrack"), None)]
    tkey = ["luc3d", "luc3d", "sleap", "bytetrack"] if variant \
        else ["luc3d", "sleap", "bytetrack"]

    # ONLY THE LUC3D COLUMN MOVED, asserted rather than assumed. The substitution
    # re-scores LUC3D and copies the sleap/bytetrack rows of _eval_baseline.csv through
    # byte for byte, so if either of those moved, something re-scored that should not
    # have and every paired statistic in this figure would be comparing two different
    # baselines.
    if variant:
        for t in ("sleap", "bytetrack"):
            for term, _n in TERMS:
                for other, who in ((ref, "pre-#131"), (fresh, "fresh anchor")):
                    if other["error_decomposition"][t][term] != ed[t][term]:
                        sys.exit(f"fig7e: {t}'s {term} differs between the shipped arm "
                                 f"and the {who} arm -- only the LUC3D column may move.")

    # THE DEFAULT DEPOSIT IS UNCHANGED, COLUMN FOR COLUMN. The variant's table needs an
    # `arm` column and four extra rows; adding them to the manuscript panel's committed
    # CSV would edit a manuscript artefact for no reason, so the two shapes are built
    # separately rather than one being a superset of the other.
    if not variant:
        df = pd.DataFrame([{"tracker": lab, "term": name, "count": ed[k][key],
                            "pct_of_camera_frames": ed[k][key] / tcf * 100,
                            "camera_frames": tcf, "fn_share": ed[k]["fn_share"]}
                           for k, lab, _ in TRACKERS for key, name in TERMS])
    else:
        rows = [(lab, tk, blk) for (blk, lab, _c, _h), tk in zip(series, tkey)]
        rows.append(("LUC3D pre-#131 (what the manuscript panel plotted until "
                     "2026-08-13)", "luc3d", ref))
        df = pd.DataFrame([{"arm": lab, "tracker": tk, "term": name,
                            "count": blk["error_decomposition"][tk][key],
                            "pct_of_camera_frames":
                                blk["error_decomposition"][tk][key] / tcf * 100,
                            "camera_frames": tcf,
                            "fn_share": blk["error_decomposition"][tk]["fn_share"]}
                           for lab, tk, blk in rows for key, name in TERMS])
    deposit(df, 7,
            f"{slug('fig7d_error_decomposition', variant, corrected, fresh_arm)}.csv")

    # 80 mm rather than a half: this row now carries three panels (e, f, g) and the
    # six labelled rates need the width. At 88 mm the row would not fit 180 mm.
    #
    # THE VARIANT PUTS ITS VALUES IN THE KEY, NOT ON THE BARS. Four bars per group at
    # BAR_W 0.20 are ~6 mm apart on an 80 mm panel and a "0.0264%" label sets ~8 mm at
    # 6 pt, so eight on-bar labels cannot be laid out without collisions (and
    # `lint_text.py` would say so). In the key each line carries its own two rates and
    # nothing can overlap.
    nser = len(series)
    bar_w = BAR_W if not variant else 0.20
    # THE MANUSCRIPT PANEL'S KEY SITS INSIDE THE AXES, TOP RIGHT, AND RESERVES NO
    # BAND (`key=0`). It used to be drawn in the `panel(key=...)` band above the
    # plot -- but with `key=1` reserving ONE line's worth (3.6 mm at ROW_H) for the
    # THREE names actually stacked there, the second and third lines fell back into
    # the axes: at Fig 11's 0.635 cram scale "ByteTrack" landed ON the y spine's top
    # (measured on the assembled page: key ink x 109.1-133.4 / y 153.1-168.6 against
    # a spine at x 110.5 running from y 161.1). Reserving three lines instead would
    # have cost 8.8 of 50 mm of plot height on a panel whose whole figure is crammed.
    # The bars leave the top-right quadrant empty -- `top` is 1.30x the tallest FP bar
    # and the ID-switch bars are ~12x shorter -- so the names go there, where they
    # collide with nothing and the axes keeps its full height. The VARIANT keeps the
    # band: its six entries carry rates and are too wide to sit inside the data area.
    # 88, not 80, since 2026-08-25: fig11_sync.build_block packs a/b/c/d on ONE
    # uniform scale with a shared column split, which needs all four panels the
    # same declared width (a/b/c are "half" = 88 mm).
    fig, ax = panel(88.0, ROW_H, key=(nser + 2) if variant else 0)
    top = max(blk["error_decomposition"][tk]["false_positives"]
              for (blk, _l, _c, _h), tk in zip(series, tkey)) / tcf * 100 * 1.30
    x = np.arange(len(TERMS))
    entries = []
    for i, ((blk, lab, color, hatch), tk) in enumerate(zip(series, tkey)):
        e = blk["error_decomposition"][tk]
        vals = [e[key] / tcf * 100 for key, _ in TERMS]
        pos = x + (i - (nser - 1) / 2) * bar_w
        # The hatched call is the VARIANT's only; the plain one is byte-for-byte the
        # manuscript panel's, because passing hatch/edgecolor/linewidth even as no-ops
        # changes the emitted PDF stream (measured: the default render's sha256 moved).
        if hatch:
            ax.bar(pos, vals, width=bar_w, color=color, zorder=2, hatch=hatch,
                   edgecolor="white", linewidth=0.0)
        else:
            ax.bar(pos, vals, width=bar_w, color=color, zorder=2)
        if not variant:
            for j, (px, v) in enumerate(zip(pos, vals)):
                # The two switch rates are 0.0264% and 0.0308% -- 17% apart in value
                # but ~1% of the axis height apart in POSITION, so their labels would
                # still sit on the same line on adjacent bars. Stagger the middle
                # tracker upward; the FP group is spread enough not to need it. (On the
                # retired arm these were 0.0316 vs 0.0308, i.e. closer still.)
                # COMPACT_FS since the fig11 compact pass (Eric, 2026-08-25: "make
                # the numbers bigger") -- this render ships inside fig11's 2x2
                # block at ~0.48 vector scale, so 11.5 pt here prints ~5.5 pt. At
                # that size the labels are ~13 mm wide on bars ~6 mm apart, so
                # same-height centred labels overlap whatever the values do: the
                # OUTER labels lean outward off their bar's far edge (green sets
                # right-aligned at its left flank, orange left-aligned at its
                # right flank) and the middle one, which has nowhere sideways to
                # go, lifts in the switches group where its neighbours' values
                # are within a label-height of its own.
                # FP group: centred (its values are a label-height apart already;
                # nudging green outward ran it into the y ticks). Switches group:
                # the middle label lifts a full label-height and the orange one
                # leans right off its bar's far flank -- the two moves that
                # actually collided at this size.
                side = 1 if (i == 1 and j == len(series) - 1) else 0
                lift = 0.24 if (j == 1 and i == 1) else 0.0
                # SHORT LABELS (Eric, 2026-08-25: "lets use precision like .31%
                # and .53% etc no need for the 0. or the 3 or 4 decimal places
                # for 11d" -- the full-precision labels collided at COMPACT_FS).
                # Two decimals above ~0.1, three below (the switch rates all
                # start .0xx and two decimals would print two of them as the
                # same number); leading zero stripped. Full precision stays in
                # the deposit CSV and the caption.
                short = (f"{v:.2f}" if v >= 0.0995 else f"{v:.3f}").lstrip("0")
                ax.text(px + side * bar_w * 0.30, v + (0.02 + lift) * top,
                        f"{short}%", va="bottom", color=color,
                        ha="left" if side else "center",
                        fontsize=COMPACT_FS, fontweight="bold")
        else:
            entries.append((f"{lab}  FP {vals[0]:.3g}% · sw {vals[1]:.3g}%", color))
            if lab == FRESH_LABEL:
                entries.append((FRESH_NOTE, color))

    if variant:
        # THE RETIRED ARM AS A GREY MARK ON THE BAR IT SUPERSEDES, not as a fifth bar.
        # It is not a method on offer -- it is where this panel's own published number
        # sits -- so it gets the set's reference-level grey and a rule rather than a
        # series colour and an area. A reader sees the shipped bar and, on it, the
        # height the manuscript prints.
        er = ref["error_decomposition"]["luc3d"]
        p0 = x + (0 - (nser - 1) / 2) * bar_w
        for px, key in zip(p0, [k for k, _ in TERMS]):
            ax.plot([px - bar_w * 0.62, px + bar_w * 0.62], [er[key] / tcf * 100] * 2,
                    color=MUTED, lw=1.1, zorder=6, solid_capstyle="butt")
        # SHORT: at 6 pt on an 80 mm panel this key line has ~52 characters before it
        # runs off the artwork, and matplotlib drops the overhang silently (lint:
        # CLIPPED + TRUNCATED). "what Fig 7d printed until 2026-08-13" does not fit and
        # is in the footnote instead; the grey rule's job here is to say WHICH arm.
        entries.append((f"grey rule: LUC3D pre-#131, retired "
                        f"(sw {er['id_switches'] / tcf * 100:.3g}%)", MUTED))

    if variant:
        text_legend(ax, entries, "above", dy=KEY_DY, xy=(0.14, 0.985),
                    transform=fig.transFigure)
    # DEFAULT render: no in-panel key since the shared-key pass (Eric,
    # 2026-08-25: "put LUC3D SLEAP and ByteTrack under the abcd block, so we
    # dont have to repeat it 3 different times") -- fig11_sync.build_block draws
    # the one tracker key for all four block panels.
    ax.set_xticks(x)
    ax.set_xticklabels([n for _, n in TERMS])
    ax.set_xlim(-0.45, len(TERMS) - 0.55)
    # "% of camera-frames" is the honest unit; the footnote's first line carries
    # the precise denominator. (A longer rotated label clipped at this height --
    # lint: clipped + silently dropped -- so keep it terse.)
    ax.set_ylabel("errors (% of frames)")
    ax.set_ylim(0, top)
    if not variant:
        ax.tick_params(labelsize=COMPACT_FS)
        ax.yaxis.label.set_fontsize(COMPACT_FS)
    lo = min(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    hi = max(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    # 100_000/… not .1%: the shares are the SAME numbers as before, but the line
    # must be ~4 characters shorter now that 3-digit y ticks push the axes centre
    # (and the axes-centred footnote) rightward -- lint clipped the old wording.
    note = (f"rate basis: {tcf:,} camera-frames\n"
            f"false negatives: {lo:.1%}–{hi:.1%} of the error")
    if variant:
        er = ref["error_decomposition"]["luc3d"]
        ef = fresh["error_decomposition"]["luc3d"]
        note += (
            f"\nLUC3D here is the SHIPPED tracker (pose/cross-view-tracker.js), re-scored "
            f"per camera-session; the arm Fig 7d printed until 2026-08-13 is the pre-#131 per-frame matcher "
            f"retired 2026-07-06 -- ID switches {er['id_switches']:,} -> "
            f"{ed['luc3d']['id_switches']:,}, false positives {er['false_positives']:,} -> "
            f"{ed['luc3d']['false_positives']:,}"
            f"\nso the retired arm's note 'LUC3D does not win on within-view "
            f"switches' no longer holds: the previous default {ed['luc3d']['id_switches']:,} against "
            f"SLEAP's unchanged {ed['sleap']['id_switches']:,}, and the now-shipped fresh "
            f"anchor {ef['id_switches']:,} -- but the previous-default arm's false positives are "
            f"{ed['luc3d']['false_positives'] / er['false_positives'] - 1:+.1%} against the "
            f"retired one, so the correction is not one-sided"
            f"\n{pool_note()}")
    footnote(ax, note)
    save(fig, 7, "d", slug("decomposition", variant, corrected, fresh_arm))


if __name__ == "__main__":
    main(*flags(sys.argv))
