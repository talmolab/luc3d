#!/usr/bin/env python3
"""
Fig 6d -- what is in the two corpora.

Everything here is read from the files themselves by `fig6_measure.py`, not from a
lab notebook: 130 sessions with 3D, 12,039,174 frames, 29.5 hours.

TWO NUMBERS PER CORPUS THAT MUST NOT BE CONFLATED: sessions TOTAL and sessions WITH
3D. SLAP-2M has 84 sessions of which 74 carry 3D; BMimica has 56 of 56. Quoting 84
alongside BMimica's 56 would overstate the usable corpus by ten sessions, so both are
drawn and the 3D count is the one the bar length encodes.

Drawn as a rules-only table rather than a bar chart: these are six exact counts of
different units (sessions, frames, hours), and a bar chart of quantities that do not
share a unit is decoration.

Source: figs/out/fig6.json `corpora`.

    python3 figs/panels/fig6_04_corpus.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import SPAN, mm, GREY, INK, deposit, save, use  # noqa: E402

COLS = ["", "cameras", "animals", "sessions\nwith 3D", "frames", "hours"]


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


def main():
    use()
    corpora = load("fig6.json")["corpora"]

    rows = []
    for c in corpora:
        rows.append({
            "corpus": c["name"],
            # These arrive as lists; render as a range so the cell reads "1–4"
            # rather than a Python list repr.
            "cameras": _rng(c.get("cameras_range")),
            "animals": _rng(c.get("animals_range")),
            "sessions_with_3d": f"{c['sessions_with_3d']}/{c['sessions_total']}",
            "frames": f"{c['frames_total']:,}",
            "hours": f"{c['hours']:.1f} @{round(c['fps'])} fps",
        })
    tot_3d = sum(c["sessions_with_3d"] for c in corpora)
    tot_fr = sum(c["frames_total"] for c in corpora)
    tot_h = sum(c["hours"] for c in corpora)
    rows.append({"corpus": "total", "cameras": "", "animals": "",
                 "sessions_with_3d": str(tot_3d), "frames": f"{tot_fr:,}",
                 "hours": f"{tot_h:.1f}"})
    df = pd.DataFrame(rows)
    deposit(df, 6, "fig6d_corpus.csv")

    nrow = len(df)
    widths = [0.20, 0.14, 0.14, 0.17, 0.19, 0.16]
    x0 = [sum(widths[:i]) for i in range(len(COLS))]

    # The header is TWO lines tall ("sessions / with 3D"), so it needs more than the
    # one row-height a body row gets -- at one row height its two lines printed on
    # the rules above and below it. `HDR` is its centre and the rules sit 0.9 of a
    # row away, which is why the figure is a row taller than the table.
    HDR = nrow + 1.2

    fig, ax = plt.subplots(figsize=(mm(SPAN["half"]), mm(4.2 * (nrow + 2.7))),
                           layout="constrained")
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, HDR + 1.2)

    def row_y(i):
        return nrow - i - 0.2

    for j, c in enumerate(COLS):
        ax.text(x0[j], HDR, c, fontweight="bold", va="center", color=INK,
                fontsize=7)

    for i, r in df.iterrows():
        last = i == nrow - 1                     # the total row
        vals = [r.corpus, r.cameras, r.animals, r.sessions_with_3d, r.frames, r.hours]
        for j, v in enumerate(vals):
            ax.text(x0[j], row_y(i), str(v), va="center", fontsize=7,
                    color=INK,
                    fontweight="bold" if last else "normal")

    for y, lw in ((HDR + 0.9, 0.9), (HDR - 0.9, 0.6),
                  (row_y(nrow - 2) - 0.5, 0.6), (row_y(nrow - 1) - 0.5, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)

    save(fig, 6, "e", "corpora")


if __name__ == "__main__":
    main()
