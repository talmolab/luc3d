#!/usr/bin/env python3
"""
Fig 6e -- what is in the two corpora, and which of them the rest of the figure
measures.

(The file is `fig6_04_corpus.py` and it emits panel **e**. The docstring used to claim
"Fig 6d", which belongs to `fig6_07_animal_count.py`; any caption written from the old
docstring cited the wrong panel.)

Everything here is read from the files themselves by `fig6_measure.py`, not from a lab
notebook: 130 sessions with 3D, 12,039,174 frames, 29.5 hours.

THE LAST ROW IS THE POINT OF THE TABLE. c, d and f are **SLAP-2M only**. BMimica
carries 84 % of the corpus frame count and contributes NOTHING to the finding, so this
is the only place the 130-session / 12.0 M-frame figure appears -- and it must appear
as a composition statement with an explicit "measured here" marker, or the 130 reads as
the n behind panels c, d and f. Legacy had that column; the restyle dropped it, which
left the biggest number on the figure unqualified.

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
3D. SLAP-2M has 84 sessions of which 74 carry 3D; BMimica 56 of 56. Quoting 84
alongside BMimica's 56 would overstate the usable corpus by ten sessions, so the cell
carries both and the total row says `130 of 140`.

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
RULE_U = {"header": 0.5, "body": 0.5}
ROWS = ["Cameras", "Animals", "Sessions with 3D", "Frames", "Hours", "Nodes",
        "Measured in c, d, f"]


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
            "Measured in c, d, f": "yes" if measured else "no",
        }
    used = [corpora[n] for n in cols]
    cells["Total"] = {
        "Cameras": "–",
        "Animals": _rng(sorted({a for c in used
                                for a in (c.get("animals_range") or [])})),
        "Sessions with 3D": (f"{sum(c['sessions_with_3d'] for c in used)} of "
                             f"{sum(c['sessions_total'] for c in used)}"),
        "Frames": f"{sum(c['frames_total'] for c in used):,}",
        "Hours": f"{sum(c['hours'] for c in used):.1f}",
        "Nodes": nodes,
        "Measured in c, d, f": "no",
    }
    cols.append("Total")

    deposit(pd.DataFrame([{"attribute": r, **{c: cells[c][r] for c in cols}}
                          for r in ROWS]), 6, "fig6e_corpora.csv")

    nline = len(ROWS) + 1                     # + the header
    widths = [0.31, 0.25, 0.25, 0.19]
    x0 = [sum(widths[:i]) for i in range(len(widths) + 1)]

    fig, ax = plt.subplots(figsize=(mm(SPAN["half"]), mm(LINE * (nline + 1.0))),
                           layout="constrained")
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, nline + 1.0)

    def row_y(i):
        return len(ROWS) - i - 0.1

    for j, c in enumerate(cols):
        ax.text(x0[j + 1], row_y(-1), c, fontweight="bold", va="center", color=INK,
                fontsize=7)
    for i, r in enumerate(ROWS):
        last = r == ROWS[-1]                  # the "measured here" disclosure row
        ax.text(x0[0], row_y(i), r, va="center", fontsize=7, color=INK,
                fontweight="bold" if last else "normal")
        for j, c in enumerate(cols):
            ax.text(x0[j + 1], row_y(i), cells[c][r], va="center", fontsize=7,
                    color=INK, fontweight="bold" if last else "normal")

    # The two outer rules convert from mm to row units here; the two interior rules are
    # already in row units because they have to stay on the midpoint (see RULE_MM /
    # RULE_U).
    for y, lw in ((row_y(-1) + RULE_MM["top"] / LINE, 0.9),
                  (row_y(-1) - RULE_U["header"], 0.6),
                  (row_y(len(ROWS) - 2) - RULE_U["body"], 0.6),
                  (row_y(len(ROWS) - 1) - RULE_MM["bottom"] / LINE, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)

    save(fig, 6, "e", "corpora")


if __name__ == "__main__":
    main()
