#!/usr/bin/env python3
"""
Fig 7f -- session IDF1 against the shared detector's recall.

THE HONEST CEILING. Every tracker in this figure is fed the SAME identity-stripped
detections, and this panel shows how much of a session's IDF1 is simply the
detector's recall: r = 0.975 for LUC3D, 0.949 for SLEAP, one point per session.

Read with Fig 7e: false negatives are 98.8-99.3% of every tracker's error budget.
Association is what separates the trackers, but the level is set by detection, and
a figure that only showed the separation would oversell it.

Points ABOVE the IDF1 = recall diagonal are sessions where the tracker kept
identity on essentially every detection it was given.

BYTETRACK'S CORRELATION IS NOW ON THE PANEL, and it is the one number here that
cuts against the panel's own claim. `detector_recall_corr` deposits
bytetrack r = 0.780, R2 = 0.608 -- much weaker than LUC3D's 0.975 or SLEAP's 0.949.
A tracker whose session IDF1 is only loosely tied to recall is a tracker whose OWN
failures dominate, so "the level is set by detection" is a statement about the two
good trackers, not a law. Leaving it out made the claim look more general than the
data supports.

BOTH R2 VALUES ARE PRINTED, not just LUC3D's. R2 is the quantity the claim is
actually about -- the share of between-session IDF1 variance detection accounts for --
and the footer used to give 0.95 for LUC3D and nothing for the counter-example, which
is the same asymmetry one step further down: the reader was handed the strongest R2 in
the panel and left to square r = 0.780 into 0.61 for themselves. 0.95 against 0.61 is
the comparison, so both are set on one line.

WHY ITS POINTS ARE NOT DRAWN. They cannot be. `detector_recall_corr.per_session`
deposits four columns -- recall, LUC3D IDF1, SLEAP IDF1, animal count -- and no
ByteTrack column; ByteTrack's per-session IDF1 survives only in
`within_view.bytetrack.per_session`, which the generator stores SORTED, so session
identity is gone and no point can be paired with its recall. The r is exact and is
printed; the scatter would have to be invented. Re-run `fig3_trackers.py` with a
bytetrack column in `per_session` if the cloud is wanted.

Source: figs/out/fig3_trackers.json `slap2m.detector_recall_corr`.

    python3 figs/panels/fig7_07_recall.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, entity, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a row buys nothing.
ROW_H = 47.0

#: `text_legend`'s "above" branch hard-codes `dy = 0.052` in FIGURE coordinates -- i.e.
#: 2.70 mm at the 52 mm height it was tuned for, but only 2.44 mm at 47 mm, and 8 pt
#: type sets a ~3.24 mm span box, so the four key lines would overlap by a quarter of a
#: box and `lint_text.py` would (rightly) fail. Passing `dy` with an explicit
#: `transform` holds the ABSOLUTE spacing at 2.70 mm, so the key reads as it did: that
#: branch is skipped whenever `transform` is not None, and `xy` supplies the anchor it
#: would otherwise have set.
KEY_DY = 0.052 * 52.0 / ROW_H


def main():
    use()
    d = load("fig3_trackers.json")["slap2m"]["detector_recall_corr"]
    per = np.asarray(d["per_session"], float)
    # Columns are [recall, luc3d IDF1, sleap IDF1, n_animals]. VERIFIED, not
    # assumed: corr(col0, col1) = 0.975 and corr(col0, col2) = 0.949 reproduce the
    # deposited r values exactly, which pins the order.
    recall, luc, sle = per[:, 0], per[:, 1], per[:, 2]

    deposit(pd.DataFrame({"detector_recall": recall, "luc3d_idf1": luc,
                          "sleap_idf1": sle}), 7, "fig7f_recall.csv")

    # Everything that names something lives in the reserved band ABOVE the plot.
    # Inside the axes there is nowhere for it to go: the cloud hugs the diagonal
    # over the whole range, so the "IDF1 = recall" label -- set along the line --
    # printed on the line, and the two r values were a single teal block that
    # coloured SLEAP's r as if it were LUC3D's.
    # Hues from `entity()`: LUC3D/SLEAP/ByteTrack are recurring entities and their
    # colours are reserved set-wide, so the mapping lives in one place instead of
    # being re-picked per panel (review finding C3). GREY stays a MARK colour here --
    # it labels the dashed identity rule, not a method.
    entries = [(f"LUC3D r = {d['luc3d']['r']:.3f}", entity("luc3d")),
               (f"SLEAP r = {d['sleap']['r']:.3f}", entity("sleap")),
               (f"ByteTrack r = {d['bytetrack']['r']:.3f} (not plotted)",
                entity("bytetrack")),
               ("dashed: IDF1 = recall", GREY)]
    # 54 mm: this row carries three panels (e, f, g) and must sum to 180 mm.
    fig, ax = panel(54.0, ROW_H, key=len(entries))
    ax.plot([0, 1], [0, 1], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)
    ax.plot(recall, sle, "o", color=entity("sleap"), ms=3, alpha=0.8, zorder=3)
    ax.plot(recall, luc, "o", color=entity("luc3d"), ms=3, alpha=0.8, zorder=4)
    text_legend(ax, entries, "above", dy=KEY_DY, xy=(0.14, 0.985),
                transform=fig.transFigure)
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
    footnote(ax, f"one point per session, n = {len(recall)}\n"
             f"R²: LUC3D {d['luc3d']['r2']:.2f} · "
             f"ByteTrack {d['bytetrack']['r2']:.2f}\n"
             "ByteTrack pairing not deposited")
    save(fig, 7, "f", "recall")


if __name__ == "__main__":
    main()
