#!/usr/bin/env python3
"""
Fig 7e -- session IDF1 against the shared detector's recall.

    ############################################################################
    FIXED 2026-08-13, ON ERIC'S INSTRUCTION: THIS PANEL NOW PLOTS THE SHIPPED
    TRACKER -- and it has a wrinkle the other corrected panels do not: ITS X AXIS
    MOVED TOO, so SLEAP's and ByteTrack's printed r values changed even though
    their IDF1 columns did not.

    Until then the LUC3D cloud came from `matchFrameInstances`, the pre-#131
    PER-FRAME matcher (run 2026-05-15); `pose/cross-view-tracker.js` was merged
    2026-07-06. Same 74 sessions, same pool:

        r(session IDF1, recall)   LUC3D 0.9747 -> 0.9900   (R2 0.950 -> 0.980)

    WHY THE X AXIS IS NOT A FIXED PROPERTY OF THE DETECTOR. `fig3_trackers.py`
    takes the recall column from the LUC3D ROWS ("the detection pool is shared, so
    any tracker's recall measures the DETECTOR"), but motmetrics' `recall` counts
    MATCHED predictions, and LUC3D drops detections it has not assigned an identity
    -- so the x coordinate of EVERY point, including SLEAP's and ByteTrack's,
    shifts when the LUC3D arm changes (corpus mean 0.7285 -> 0.7268). That is why
    the key now reads SLEAP r = 0.945 and ByteTrack r = 0.775 where it read 0.949
    and 0.780, with their IDF1 columns byte-identical. The effect is small, all
    three clouds still share ONE recall column so the panel stays internally
    consistent, and it does not touch the claim -- but a panel whose x axis depends
    on which arm is plotted has to say so, and this is where it says it.

    `--as-shipped` re-renders the retired arm under a `_pre131` slug; `--variant`
    draws all three arms, each against ITS OWN recall column. `fig3_trackers.json`
    is NOT rewritten. Account: `figs/out/ITEM3-SLAP2M-GATE.md`.
    ############################################################################

THE HONEST CEILING. Every tracker in this figure is fed the SAME identity-stripped
detections, and this panel shows how much of a session's IDF1 is simply the
detector's recall: r = 0.990 for LUC3D, 0.945 for SLEAP, one point per session.

Read with Fig 7e: false negatives are 98.8-99.3% of every tracker's error budget.
Association is what separates the trackers, but the level is set by detection, and
a figure that only showed the separation would oversell it.

Points ABOVE the IDF1 = recall diagonal are sessions where the tracker kept
identity on essentially every detection it was given.

BYTETRACK'S CORRELATION IS NOW ON THE PANEL, and it is the one number here that
cuts against the panel's own claim. `detector_recall_corr` deposits
bytetrack r = 0.775, R2 = 0.601 -- much weaker than LUC3D's 0.990 or SLEAP's 0.945.
A tracker whose session IDF1 is only loosely tied to recall is a tracker whose OWN
failures dominate, so "the level is set by detection" is a statement about the two
good trackers, not a law. Leaving it out made the claim look more general than the
data supports.

BOTH R2 VALUES ARE PRINTED, not just LUC3D's. R2 is the quantity the claim is
actually about -- the share of between-session IDF1 variance detection accounts for --
and the footer used to give 0.95 for LUC3D and nothing for the counter-example, which
is the same asymmetry one step further down: the reader was handed the strongest R2 in
the panel and left to square r = 0.775 into 0.60 for themselves. 0.98 against 0.60 is
the comparison, so both are set on one line.

ITS POINTS ARE DRAWN NOW (review 2026-08). An earlier version could not draw them:
`detector_recall_corr.per_session` deposited four columns -- recall, LUC3D IDF1,
SLEAP IDF1, animal count -- and ByteTrack's per-session IDF1 survived only in
`within_view.bytetrack.per_session`, which the generator stores SORTED, so session
identity was gone and no point could be paired with its recall. `fig3_trackers.py`
now APPENDS ByteTrack IDF1 as column 4 of `per_session` (appended, not inserted, so
the positional reads of columns 0-2 here kept meaning what they meant), and the
regeneration was verified: every pre-existing number in the deposit is unchanged
and corr(col0, col4) reproduces the deposited bytetrack r exactly. The panel
refuses to run on a pre-regeneration deposit rather than silently dropping the
cloud again.

Source: figs/out/fig7_variant_best.json `slap2m.detector_recall_corr` (`slap2m` = the
SHIPPED tracker); with `--variant`, also `slap2m_fresh_anchor` and
`slap2m_pre131_reference`; with `--as-shipped`, figs/out/fig3_trackers.json `slap2m`
(pre-#131).

    python3 figs/panels/fig7_07_recall.py               # the manuscript panel
    python3 figs/panels/fig7_07_recall.py --variant     # all three arms
    python3 figs/panels/fig7_07_recall.py --as-shipped  # retired arm, _pre131 slug
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (MUTED, footnote, GREY, entity, deposit, panel,  # noqa: E402
                       save, text_legend, use)
from fig7_variant_common import arms, flags, pool_note, slug  # noqa: E402

#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a row buys nothing.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0

#: `text_legend`'s "above" branch hard-codes `dy = 0.052` in FIGURE coordinates -- i.e.
#: 2.70 mm at the 52 mm height it was tuned for, but only 2.44 mm at 47 mm, and 8 pt
#: type sets a ~3.24 mm span box, so the four key lines would overlap by a quarter of a
#: box and `lint_text.py` would (rightly) fail. Passing `dy` with an explicit
#: `transform` holds the ABSOLUTE spacing at 2.70 mm, so the key reads as it did: that
#: branch is skipped whenever `transform` is not None, and `xy` supplies the anchor it
#: would otherwise have set.
KEY_DY = 0.052 * 52.0 / ROW_H


def main(variant=False, corrected=True):
    use()
    sl, fresh, ref, _tab = arms(variant, corrected)
    d = sl["detector_recall_corr"]
    per = np.asarray(d["per_session"], float)
    # Columns are [recall, luc3d IDF1, sleap IDF1, n_animals, bytetrack IDF1].
    # VERIFIED, not assumed: corr(col0, col1) = 0.990, corr(col0, col2) = 0.945 and
    # corr(col0, col4) = 0.775 reproduce the deposited r values exactly, which pins
    # the order. The 5th column is the 2026-08 regeneration; refuse a stale deposit
    # rather than silently reverting to a ByteTrack-less cloud.
    if per.shape[1] < 5:
        sys.exit("fig7f: the deposit's per_session has no bytetrack column "
                 "(4 columns) -- re-run figs/fig3_trackers.py, and "
                 "figs/fig7_variant_tracker.py --slap2m for the corrected render.")
    recall, luc, sle, byt = per[:, 0], per[:, 1], per[:, 2], per[:, 4]
    r_byt = float(np.corrcoef(recall, byt)[0, 1])
    if abs(r_byt - d["bytetrack"]["r"]) > 1e-6:
        sys.exit(f"fig7f: column 4 does not reproduce bytetrack r "
                 f"({r_byt:.6f} vs {d['bytetrack']['r']:.6f}) -- column order moved.")

    if not variant:
        deposit(pd.DataFrame({"detector_recall": recall, "luc3d_idf1": luc,
                              "sleap_idf1": sle, "bytetrack_idf1": byt}),
                7, f"{slug('fig7e_recall', variant, corrected)}.csv")
    else:
        # The variant's table carries all three LUC3D arms AND all three recall
        # columns, because the x coordinate is arm-dependent (see the notice above) and
        # a table with one recall column would misrepresent that.
        pr = np.asarray(ref["detector_recall_corr"]["per_session"], float)
        pf = np.asarray(fresh["detector_recall_corr"]["per_session"], float)
        deposit(pd.DataFrame({
            "recall_shipped_arm": recall, "luc3d_shipped_idf1": luc,
            "recall_pre131_arm": pr[:, 0], "luc3d_pre131_idf1": pr[:, 1],
            "recall_fresh_arm": pf[:, 0], "luc3d_fresh_idf1": pf[:, 1],
            "sleap_idf1": sle, "bytetrack_idf1": byt, "animals": per[:, 3]}),
            7, "fig7e_recall_variant.csv")

    # Everything that names something lives in the reserved band ABOVE the plot.
    # Inside the axes there is nowhere for it to go: the cloud hugs the diagonal
    # over the whole range, so the "IDF1 = recall" label -- set along the line --
    # printed on the line, and the two r values were a single teal block that
    # coloured SLEAP's r as if it were LUC3D's.
    # Hues from `entity()`: LUC3D/SLEAP/ByteTrack are recurring entities and their
    # colours are reserved set-wide, so the mapping lives in one place instead of
    # being re-picked per panel (review finding C3). GREY stays a MARK colour here --
    # it labels the dashed identity rule, not a method.
    if not variant:
        entries = [(f"LUC3D r = {d['luc3d']['r']:.3f}", entity("luc3d")),
                   (f"SLEAP r = {d['sleap']['r']:.3f}", entity("sleap")),
                   (f"ByteTrack r = {d['bytetrack']['r']:.3f}", entity("bytetrack")),
                   ("dashed: IDF1 = recall", GREY)]
    else:
        # FOUR LUC3D-BEARING LINES AT 6 pt on a 54 mm panel: the three arms' r values
        # and the note that the x axis is arm-dependent. LUC3D keeps its hue on both
        # of its arms (open markers mark the experimental one); the retired arm is the
        # only thing in MUTED.
        entries = [(f"LUC3D shipped r = {d['luc3d']['r']:.3f}", entity("luc3d")),
                   (f"LUC3D + fresh (EXPT, open) r = "
                    f"{fresh['detector_recall_corr']['luc3d']['r']:.3f}",
                    entity("luc3d")),
                   (f"LUC3D pre-#131 r = "
                    f"{ref['detector_recall_corr']['luc3d']['r']:.3f}", MUTED),
                   (f"SLEAP r = {d['sleap']['r']:.3f}", entity("sleap")),
                   (f"ByteTrack r = {d['bytetrack']['r']:.3f}", entity("bytetrack")),
                   ("dashed: IDF1 = recall · x moves with the arm", GREY)]
    # 54 mm: this row carries three panels (e, f, g) and must sum to 180 mm.
    fig, ax = panel(54.0, ROW_H, key=len(entries))
    ax.plot([0, 1], [0, 1], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)
    # ByteTrack UNDER the other two clouds: it is the counter-example the panel
    # keeps honest, not the claim, and its points scatter widest off the diagonal.
    ax.plot(recall, byt, "o", color=entity("bytetrack"), ms=3, alpha=0.8, zorder=2)
    ax.plot(recall, sle, "o", color=entity("sleap"), ms=3, alpha=0.8, zorder=3)
    if variant:
        # The two extra LUC3D arms, each against ITS OWN recall column: the retired arm
        # in MUTED (a reference level, not a method), the experimental fresh anchor as
        # open teal rings so it cannot be mistaken for the shipped cloud.
        pr = np.asarray(ref["detector_recall_corr"]["per_session"], float)
        pf = np.asarray(fresh["detector_recall_corr"]["per_session"], float)
        ax.plot(pr[:, 0], pr[:, 1], "o", color=MUTED, ms=2.4, alpha=0.75, zorder=3)
        ax.plot(pf[:, 0], pf[:, 1], "o", ms=3.4, mfc="none",
                mec=entity("luc3d"), mew=0.7, zorder=5)
    ax.plot(recall, luc, "o", color=entity("luc3d"), ms=3, alpha=0.8, zorder=4)
    text_legend(ax, entries, "above", dy=KEY_DY, size=None if not variant else 6,
                xy=(0.14, 0.985), transform=fig.transFigure)
    ax.set_xlabel("shared detector recall")
    ax.set_ylabel("session IDF1")
    ax.set_xlim(0, 1.02)
    ax.set_ylim(0, 1.02)
    ax.set_xticks([0, 0.5, 1.0])
    ax.set_yticks([0, 0.5, 1.0])
    # BOTH R² VALUES, side by side. The key carries the two r's a reader can check
    # against the cloud; R² is the number the panel's CLAIM rests on, because it is
    # the share of session-to-session IDF1 variance that detection alone accounts for
    # -- 0.95 for LUC3D against 0.61 for ByteTrack. Printing only LUC3D's made the
    # strongest case the only case. Measured at 39.5 mm on this 54 mm panel, so it
    # fits where a second full sentence would not.
    note = (f"one point per session, n = {len(recall)}\n"
            f"R²: LUC3D {d['luc3d']['r2']:.2f} · "
            f"ByteTrack {d['bytetrack']['r2']:.2f}")
    if variant:
        dr, df_ = ref["detector_recall_corr"], fresh["detector_recall_corr"]
        note += (f"\nLUC3D here is the SHIPPED tracker: r = {d['luc3d']['r']:.4f} "
                 f"(R² {d['luc3d']['r2']:.4f}) against the pre-#131 tracker this panel "
                 f"printed until 2026-08-13, r = {dr['luc3d']['r']:.4f} "
                 f"(R² {dr['luc3d']['r2']:.4f}), "
                 f"retired 2026-07-06; the EXPERIMENTAL fresh anchor is "
                 f"r = {df_['luc3d']['r']:.4f}"
                 f"\nTHE X AXIS IS ARM-DEPENDENT: the recall column is taken from the "
                 f"LUC3D rows and motmetrics' recall counts MATCHED predictions, so it "
                 f"shifts with the arm (mean {np.mean(pr[:, 0]):.4f} pre-#131, "
                 f"{np.mean(recall):.4f} shipped, {np.mean(pf[:, 0]):.4f} fresh) and "
                 f"SLEAP's own r moves ({dr['sleap']['r']:.4f} -> {d['sleap']['r']:.4f}) "
                 f"although its IDF1 column is byte-identical"
                 f"\n{pool_note()}")
    footnote(ax, note)
    save(fig, 7, "e", slug("recall", variant, corrected))


if __name__ == "__main__":
    main(*flags(sys.argv))
