#!/usr/bin/env python3
"""
Fig 6e -- what is in the two corpora, and which of them the rest of the figure
measures.

(The file is `fig6_04_corpus.py` and it emits panel **e**. The docstring used to claim
"Fig 6d", which belongs to `fig6_07_animal_count.py`; any caption written from the old
docstring cited the wrong panel.)

Everything here is read from the files themselves by `fig6_measure.py`, not from a lab
notebook: 130 sessions with 3D, 12,039,174 frames, 29.6 hours.

WHICH CORPUS EACH PANEL MEASURES IS IN THE LEGEND, NOT IN THIS TABLE. c, d and f are
SLAP-2M only, and BMimica carries 84 % of the corpus frame count while contributing
nothing to those panels, so the 130-session / 12.0 M-frame total here is a COMPOSITION
statement and must not be read as the n behind c, d and f. That qualification used to
be a "Measured in c, d, f" row on the table itself, which was a build-time note rather
than an attribute of a corpus -- two of its three cells read "no", so a seventh of the
table told the reader which columns to ignore. The legend now carries it, and this
table describes the corpora and nothing else. If the legend ever loses that sentence,
the biggest number on the figure goes back to being unqualified.

`8 (6 proofread)` IS ALSO A DISCLOSURE, NOT A TYPO. `fig6.json corpora[1]` records 8
cameras for SLAP-2M, but every SLAP-2M measurement in this paper uses 6: panel b shows
six tiles, `fig3_runtime.json blocked` states the shared detection pool covers only
`back/backL/mid/midL/top/topL` and that C = 7, 8 are NOT measured, and Fig 7's caveats
compute the cross-view bound at C = 6. The per-session `proofread_camera_files` count
in `fig6.json` is where the 6 comes from, so the qualifier is measured rather than
asserted. Printing a bare `8` claims eight-camera results that do not exist.

`yes` / `no`, NOT legacy's `✓` / `–`: Liberation Sans (the metric-compatible Arial
substitute this repo falls back to) has no U+2713, and matplotlib resolves ONE font per
text object, so a tick mark renders as a missing-glyph box and warns on every save.

TWO NUMBERS PER CORPUS THAT MUST NOT BE CONFLATED: sessions TOTAL and sessions WITH
3D. The cell carries both, and on the current data they are equal everywhere --
SLAP-2M `74 of 74`, BMimica `56 of 56`, total `130 of 130`.

IT USED TO READ `74 of 84`, AND THAT WAS A BUG IN THE MEASUREMENT, NOT A DISCLOSURE.
`fig6_measure.py` enumerated SLAP-2M by walking `{SLAP_ROOT}/20*/<session>/`, which
holds 84 session directories; ten of them are recordings that never entered the
corpus. SLAP-2M is defined by `master_sheet.xlsx`, which has exactly 74 rows, and
every measured SLAP-2M panel in this figure already reported 74. So the table was
announcing ten sessions of unfinished proofreading that do not exist. `scan_slap` now
joins on the master sheet (see its docstring); if this cell ever shows a mismatch
again, check the sheet before assuming the corpus grew.

TRANSPOSED -- attributes down, corpora across. Untransposed this is eight columns in
88 mm, i.e. 11 mm a column, and `8 (6 proofread)` alone sets ~18 mm at 7 pt; legacy
could afford the wide form because it gave the table the full 180 mm. Transposing puts
the long strings in a 27 mm label column and the short values in three ~20 mm ones, and
costs nothing but the reading direction.

Drawn as a rules-only table rather than a bar chart: these are exact counts of
different units (sessions, frames, hours, nodes), and a bar chart of quantities that do
not share a unit is decoration.

Body text is INK. It was `GREY` (= `SET2[7]` = #B3B3B3), a categorical SERIES colour
used as a text ink at 2.1 : 1 on white against the headers' 8.6 : 1 -- a table whose
labels are legible and whose data is not.

Source: figs/out/fig6.json `corpora`, `bmimica`, `slap2m`, `mean_pose`.

    python3 figs/panels/fig6_04_corpus.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, SPAN, deposit, mm, save, use  # noqa: E402

#: corpus name -> the key in fig6.json holding its per-session records, and whether
#: panels c, d and f measure it.
SOURCES = {"BMimica": ("bmimica", False), "SLAP-2M": ("slap2m", True)}

#: mm per table line -- the ROW PITCH, and the one number that sets how much of this
#: panel is white. At 4.05 the 300 dpi render was 48.5% blank scanlines, the highest in
#: Fig 6 (review finding 6.12), and every one of those runs was INTERLINE: 7 pt body
#: type sets a ~2.5 mm box in a 4.05 mm pitch, i.e. 1.6x leading, so the blank was
#: leading and nothing else. 3.60 mm is 1.46x -- still airier than 6f's 1.15x, which is
#: the densest table in the set and perfectly readable -- and takes the panel from
#: 36.45 to 32.4 mm.
#:
#: WHAT THAT DOES AND DOES NOT BUY. It does NOT shorten the page: this panel shares its
#: row with 6d and a row is as tall as its tallest panel, so the 4 mm becomes white
#: BELOW the table rather than white inside it. 6d's own floor is 36 mm (its four-entry
#: key; see that file), so 4.05 could only have been justified as "fill the slot". The
#: pitch is reduced anyway because the table itself reads better tighter -- a reader
#: scans a 7-row table as a block, and 1.6x leading breaks it into seven separate
#: lines -- and because the next reviewer measuring blankness measures the PANEL.
LINE = 3.60

#: Rule geometry, and the two kinds are pinned DIFFERENTLY on purpose -- getting this
#: wrong is how the first attempt at the tighter pitch ruled through six cells.
#:
#: An OUTER rule (above the header, below the last row) has type on one side only, so
#: its clearance is a typographic distance and belongs in MILLIMETRES: 7 pt type sets a
#: ~2.84 mm span box, i.e. ~1.42 mm above its baseline, and a rule expressed as a
#: fraction of the pitch would have walked in from 2.6 mm to 2.3 mm when LINE dropped.
RULE_MM = {"top": 2.63, "bottom": 2.23}
#: An INTERIOR rule has type on BOTH sides, so it must sit at the MIDPOINT of the gap
#: and therefore belongs in ROW UNITS -- mm-pinning it is exactly the error: at
#: LINE = 3.60 adjacent 2.84 mm boxes are only 0.52 mm apart, so a rule pinned 2.03 mm
#: below one baseline lands 0.05 mm off the next row's box and `lint_text.py` reports
#: the whole last row as ON DATA. Both are 0.5 because every baseline in this table
#: is exactly one unit from the next -- `row_y(-1)` is 7.9, not 8.1 (len(ROWS) is 7),
#: which is worth stating because assuming a 1.2-unit header gap puts the rule 0.7 pt
#: INSIDE the first body row and lint reports it as ink under "Cameras".
RULE_U = {"header": 0.5}

#: Outer pad, in mm, reserved OUTSIDE the row grid (see the figsize below).
PAD_MM = 1.0
#: NO "Measured in c, d, f" ROW. It was a build-time note, not an attribute of a
#: corpus: two of its three cells read "no", so a third of the table's ink said which
#: columns the reader should ignore. Which corpus each panel measures belongs in the
#: legend, where it now is, and the table is left describing the corpora themselves.
ROWS = ["Cameras", "Animals", "Sessions with 3D", "Frames", "Hours", "Nodes"]


def _rng(v):
    """A range like [1, 2, 3, 4] -> "1-4"; a single value -> that value."""
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        v = [x for x in v if x is not None]
        if not v:
            return ""
        return f"{min(v)}" if min(v) == max(v) else f"{min(v)}–{max(v)}"
    return str(v)


def _cameras(sessions, total):
    """`8` -> `8 (6 proofread)` when the sessions' own proofread-camera count is less.

    Reads `proofread_camera_files`, which `fig6_measure.py` counts off the files, so
    the qualifier is measured. Sessions recording 0 (no proofread cameras at all) are
    skipped: they are the ten SLAP-2M sessions without 3D, and folding them in would
    make the maximum 0 and drop the column to nonsense.
    """
    vals = sorted({s.get("proofread_camera_files") for s in sessions
                   if s.get("proofread_camera_files")})
    if vals and total and str(vals[-1]) != str(total):
        return f"{total} ({vals[-1]} proofread)"
    return str(total) if total else ""


def main():
    use()
    d6 = load("fig6.json")
    corpora = {c["name"]: c for c in d6["corpora"]}
    nodes = str(len(d6["mean_pose"]["node_names"]))

    cols, cells = [], {}
    for name, (key, measured) in SOURCES.items():
        c = corpora.get(name)
        if not c:
            continue
        cols.append(name)
        cells[name] = {
            "Cameras": _cameras(d6.get(key) or [], _rng(c.get("cameras_range"))),
            "Animals": _rng(c.get("animals_range")),
            "Sessions with 3D": f"{c['sessions_with_3d']} of {c['sessions_total']}",
            "Frames": f"{c['frames_total']:,}",
            "Hours": f"{c['hours']:.1f} @{round(c['fps'])} fps",
            "Nodes": nodes,
        }
    used = [corpora[n] for n in cols]
    cells["Total"] = {
        "Cameras": "–",
        "Animals": _rng(sorted({a for c in used
                                for a in (c.get("animals_range") or [])})),
        "Sessions with 3D": (f"{sum(c['sessions_with_3d'] for c in used)} of "
                             f"{sum(c['sessions_total'] for c in used)}"),
        "Frames": f"{sum(c['frames_total'] for c in used):,}",
        # SUM OF THE DISPLAYED VALUES, not display of the exact sum (review round
        # 3): 18.68 + 10.86 = 29.54 prints as 29.5, while the addends print as 18.7
        # and 10.9 -- so the table showed 18.7 + 10.9 = 29.5 and failed its own
        # arithmetic as read. Rounding the addends first makes the printed column
        # self-consistent; the exact total lives in the deposit.
        "Hours": f"{sum(round(c['hours'], 1) for c in used):.1f}",
        "Nodes": nodes,
    }
    cols.append("Total")

    deposit(pd.DataFrame([{"attribute": r, **{c: cells[c][r] for c in cols}}
                          for r in ROWS]), 6, "fig6f_corpora.csv")

    nline = len(ROWS) + 1                     # + the header
    widths = [0.31, 0.25, 0.25, 0.19]
    x0 = [sum(widths[:i]) for i in range(len(widths) + 1)]

    # THE PAD IS ADDED TO THE FIGURE HEIGHT, NOT TAKEN OUT OF THE ROWS. Sizing the
    # figure at LINE * lines and letting constrained_layout take its pad out of that
    # makes one row unit slightly less than LINE mm, by an amount that depends on the
    # ROW COUNT -- the pad is absolute, so a shorter table is compressed harder. The
    # type is a fixed 7 pt either way, so the interline gap closes while the glyphs do
    # not, and dropping a single row was enough to bring the header rule down onto the
    # first row (lint: ON DATA on "Cameras" and its cells). Reserving the pad outside
    # the grid keeps one unit at exactly LINE mm for any number of rows.
    fig, ax = plt.subplots(
        figsize=(mm(SPAN["half"]), mm(LINE * (nline + 1.0) + 2 * PAD_MM)),
        layout="constrained")
    fig.get_layout_engine().set(h_pad=PAD_MM / 25.4, w_pad=PAD_MM / 25.4)
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, nline + 1.0)

    def row_y(i):
        return len(ROWS) - i - 0.1

    for j, c in enumerate(cols):
        ax.text(x0[j + 1], row_y(-1), c, fontweight="bold", va="center", color=INK,
                fontsize=7)
    # EVERY ROW IS SET THE SAME. The last row used to be bold, because it was the
    # "measured in c, d, f" disclosure and carried the qualification the table existed
    # for. With that row gone the bolding had moved onto "Nodes", emphasising the one
    # attribute that is identical in every column.
    for i, r in enumerate(ROWS):
        ax.text(x0[0], row_y(i), r, va="center", fontsize=7, color=INK)
        for j, c in enumerate(cols):
            ax.text(x0[j + 1], row_y(i), cells[c][r], va="center", fontsize=7,
                    color=INK)

    # The two outer rules convert from mm to row units here; the two interior rules are
    # already in row units because they have to stay on the midpoint (see RULE_MM /
    # RULE_U).
    # THREE RULES, NOT FOUR. The fourth sat above the last row, separating the
    # "Measured in c, d, f" disclosure from the body. With that row gone it became a
    # rule between "Hours" and "Nodes", dividing the table where nothing divides.
    for y, lw in ((row_y(-1) + RULE_MM["top"] / LINE, 0.9),
                  (row_y(-1) - RULE_U["header"], 0.6),
                  (row_y(len(ROWS) - 1) - RULE_MM["bottom"] / LINE, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)

    save(fig, 6, "f", "corpora")


if __name__ == "__main__":
    main()
