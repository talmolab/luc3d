#!/usr/bin/env python3
"""
Fig 6f -- the difficulty strata, as a table.

The numbers behind panel c, per stratum, so every point on that curve can be traced to
a session count, a keypoint count and a composition. Drawn as a rules-only table
because these are exact counts in five different units -- sessions, keypoints, pixels,
percent and animals -- and a bar chart of quantities that do not share a unit is
decoration.

READ THE SESSION COUNTS. The strata are unbalanced and some are small; panel c plots
them as an even curve, and this table is what stops that curve being read as seven
equally-weighted measurements.

FOUR COLUMNS CAME BACK, and each one is load-bearing rather than nostalgic:

  * **Animals** -- the SET of animal counts per stratum (1 / 1,2 / 1,3 / 1,2,4 / ...).
    This is the confound panel d controls for, and this column is where a reader can
    check it: difficulty 1 is single-animal only and difficulty 7 is 2-3 animals, so
    the two variables are not crossed. Comma-joined, never en-dashed -- "1-2-4" reads
    as a range the stratum does not contain.
  * **Bedding (b/w)** -- black/white counts, the corpus's other nuisance variable
    (Fig 7b measures its effect). Over the 74 sessions it is 44 black / 30 white and
    it is not balanced across the strata either.
  * **Error mean (px)** -- NOT `err_p50`, which is what this column briefly held. The
    mean is the statistic panel c plots, the caption quotes ("rises 1.30-fold, 3.65 ->
    4.74 px") and the p99 column supports; a p50 column here silently disagreed with
    all three. `err_p50` is still in the deposited CSV.
  * **Error p99 (px)** -- the tail. `captions/fig6.md:77` quotes "the 99th 1.88x" from
    this column, so removing it left a caption citing a number on no artwork.

Every value comes straight from `by_difficulty` except Animals and Bedding, which are
counted over the same file's per-session records, so the table cannot drift from the
curve it documents.

Body text is INK. It was `GREY` (= `SET2[7]` = #B3B3B3) at 2.1 : 1 on white -- a table
whose headers were legible and whose data was not.

Headers wrap to two lines: ten columns in 180 mm is 18 mm a column, and "Error mean
(px)" sets ~19 mm at 7 pt on one line.

Source: figs/out/fig6_detections.json `by_difficulty` and `sessions`.

    python3 figs/panels/fig6_08_difficulty_strata.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, SPAN, deposit, mm, save, use  # noqa: E402

#: header (a "\n" wraps its unit onto a second line), fraction of the panel width,
#: cell key. Column widths are set so no HEADER needs hyphenating: at 6.6 pt
#: "Difficulty" sets ~12 mm and gets 15.8, "Bedding (black/white)" ~16 mm and gets 24.
COLS = [("Difficulty", 0.088, "difficulty"),
        ("Sessions", 0.082, "sessions"),
        ("Keypoints", 0.098, "keypoints"),
        ("Animals", 0.082, "animals"),
        ("Bedding\n(black/white)", 0.135, "bedding"),
        ("Missing\n(%)", 0.092, "missing_pct"),
        ("Error mean\n(px)", 0.110, "err_mean"),
        ("Error p95\n(px)", 0.104, "err_p95"),
        ("Error p99\n(px)", 0.104, "err_p99"),
        ("> 20 px\n(%)", 0.105, "over_tau_pct")]
LINE = 2.90      # mm per table line
#: Vertical layout in ROW UNITS, with the two-line header given 1.5 of them. Measured
#: rather than nudged: at this LINE one unit is ~3.1 mm and 7 pt type is ~0.75 of a
#: unit, so a rule less than ~0.5 units from a baseline strikes through the type -- the
#: first spacing ruled straight across the difficulty-1 row, and the second put the top
#: rule inside the SIX two-line headers' first-line span boxes (12 lint hits: only the
#: single-line headers were clear, which is exactly the tell).
HDR_Y = 8.10     # centre of the header block
RULES = (9.25, 7.15, -0.15)   # above header, below header, below body
#: Top of the y range, i.e. how much dead space sits above the top rule. 9.35, down
#: from 9.60: the two-line 6.6 pt header block spans up to 9.04, the top rule is at
#: 9.25, and 0.35 units above THAT was 1.0 mm of nothing on top of constrained_layout's
#: own ~1.06 mm pad (review findings 6.12 / C9). This is the whole recoverable slack in
#: this panel -- the body pitch is already 2.85 mm for a 2.84 mm 7 pt span box, i.e. the
#: densest table in the set, and the remaining blank scanlines are that box's own
#: internal white plus the two layout pads. Do not chase them.
YTOP = 9.35


def main():
    use()
    det = load("fig6_detections.json")
    bd = det["by_difficulty"]
    sess = det.get("sessions") or []
    ks = [k for k in sorted(bd, key=int) if bd[k].get("n_sessions")]

    rows = []
    for k in ks:
        v = bd[k]
        ss = [q for q in sess if str(q.get("difficulty")) == str(k)]
        an = sorted({q["animals"] for q in ss if q.get("animals")})
        nb = sum(1 for q in ss if q.get("bedding") == "black")
        nw = sum(1 for q in ss if q.get("bedding") == "white")
        rows.append({
            "difficulty": int(k), "sessions": v["n_sessions"],
            "keypoints": v["n_keypoints"],
            "animals": ", ".join(str(a) for a in an) if an else "–",
            "bedding": f"{nb}/{nw}" if ss else "–",
            "missing_pct": v["miss_rate"] * 100.0,
            "err_mean": v["err_mean"], "err_p50": v["err_p50"],
            "err_p95": v["err_p95"], "err_p99": v["err_p99"],
            "over_tau_pct": v["frac_over_tau"] * 100.0})
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5f_difficulty_strata.csv")

    #: how each cell is set -- everything else is printed as-is.
    fmt = {"difficulty": "{:d}", "sessions": "{:d}", "keypoints": "{:,d}",
           "missing_pct": "{:.1f}", "err_mean": "{:.2f}", "err_p95": "{:.2f}",
           "err_p99": "{:.2f}", "over_tau_pct": "{:.2f}"}

    nrow = len(df)
    x0 = [sum(w for _h, w, _k in COLS[:j]) for j in range(len(COLS))]

    fig, ax = plt.subplots(figsize=(mm(SPAN["full"]), mm(LINE * (YTOP + 0.55))),
                           layout="constrained")
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, YTOP)

    def row_y(i):
        return nrow - 1 - i + 0.5

    for j, (h, _w, _k) in enumerate(COLS):
        ax.text(x0[j], HDR_Y, h, fontweight="bold", va="center", color=INK,
                fontsize=6.6, linespacing=1.15)
    for i, r in df.iterrows():
        for j, (_h, _w, key) in enumerate(COLS):
            v = r[key]
            txt = fmt[key].format(int(v) if fmt.get(key, "").endswith("d") else v) \
                if key in fmt else str(v)
            ax.text(x0[j], row_y(i), txt, va="center", fontsize=7, color=INK)

    for y, lw in zip(RULES, (0.9, 0.6, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)
    # h -> f in the 2026-08-19 re-letter (the difficulty grid leads the figure)
    save(fig, 5, "f", "difficulty_strata")


if __name__ == "__main__":
    main()
