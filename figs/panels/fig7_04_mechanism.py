#!/usr/bin/env python3
"""
Fig 7e -- what the gap is actually made of, and whether it survives out of sample.

THE PANEL THAT ANSWERS "WHY", and it exists because the obvious sceptical reading of
a-d is a good one: calibrat3 rejects outliers in rounds down to a 1 px point-error
threshold, so perhaps it simply discards the observations it cannot fit and the win is
a scoring artefact rather than a better calibration.

TWO THINGS ANSWER THAT, and both are drawn here.

**One factor at a time, same corners.** Every row is calibrat3's own solver re-run on
byte-identical detections with ONE setting changed (figs/fig7_calib_ablation.mjs). The
row that matters most is `no rejection`: the final threshold is set to 0, which
collapses the schedule to a single round that fits every point. If rejection were
carrying the result, that row would fall back to Anipose's rule. Note also that
rejection is not a calibrat3 invention -- aniposelib's `bundle_adjust_iter` is itself an
iterative reject-and-refit loop -- and that rejection cannot inflate the SCORE in any
case, because the score is computed by aniposelib over every observation of Anipose's
own detections and what calibrat3 rejects only changes what it FITS.

**In sample against held out.** A model with more free intrinsics (fx, fy, cx, cy, k1,
k2 per camera against aniposelib's f, k1 with the principal point pinned) fits its own
data better by construction, so the in-sample comparison cannot tell a better model from
a more flexible one. The open mark is the same calibration scored ONLY on frames
calibrat3 never used -- out of sample for calibrat3 and in sample for Anipose, which is
deliberately the unfair direction. A model that had bought its fit with parameters loses
exactly there, and the distance between the filled and open marks on a row IS that
model's overfitting, drawn.

A DOT PLOT WITH ROWS, not a bar chart: the labels are phrases ("Anipose's intrinsics, no
rejection") and a vertical bar chart cannot carry them at 8 pt; and a bar from zero
would waste the whole axis, since every value sits between 0.1 and 5 px.

    python3 figs/panels/fig7_04_mechanism.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARM_COLOR  # noqa: E402
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, text_legend, use  # noqa: E402

#: Which rig the panel draws. The 18-camera rig: it is the harder one, it is the one
#: whose per-camera panel sits directly above this row, and the 8-camera rig's ablation
#: is deposited beside it in the CSV.
RIG = "calib18"

#: (deposit key, printed label). ORDER IS THE ARGUMENT, read bottom to top: start from
#: Anipose, apply calibrat3's solver with Anipose's own intrinsic model, then free the
#: intrinsics, then turn rejection off -- so the reader sees which single change moves
#: the number and which does not.
ROWS = [
    ("anipose", "Anipose"),
    ("abl_intrinsics-fixed", "calibrat3, intrinsics fixed"),
    ("abl_anipose-model", "calibrat3, Anipose's intrinsics"),
    ("abl_anipose-model-no-rejection", "…and no rejection"),
    ("abl_no-board-term", "calibrat3, no board term"),
    ("abl_no-rejection", "calibrat3, no rejection"),
    ("abl_default", "calibrat3, as shipped"),
]


def main():
    use()
    rec = load("fig7_calibration.json")
    ds = rec["datasets"][RIG]
    abl = ds.get("ablation")
    if not abl:
        raise SystemExit("fig7_calibration.json has no `ablation` block; run "
                         "figs/fig7_calib_why.sh and re-deposit")

    # HALF, not two-thirds: row 3 carries three panels once the scoring-set result
    # earned a place on the artwork (88 + 42 + 42 + 2 gutters = 180 mm).
    fig, ax = panel("half", "std", key=2)
    # A CONFIGURATION THE SOLVER DECLINED IS A MISSING ROW, NOT A DEAD BUILD. runSba
    # keeps the initial calibration when a refinement would make the re-triangulated
    # error worse, and writes no TOML; that is a legitimate outcome of an ablation
    # (it is what "this setting does not help" looks like) and it must not stop the
    # figure. The row is dropped and named on stdout so it is never silently absent.
    present = [(k, lbl) for k, lbl in ROWS if abl["all"].get(k) is not None]
    for k, lbl in ROWS:
        if abl["all"].get(k) is None:
            print(f"  [fig7e] no result for {k!r} — row omitted "
                  f"(the solver kept the initial calibration, or the arm was not run)")
    if len(present) < 3:
        raise SystemExit("fig7e: fewer than three ablation arms have results; "
                         "re-run figs/fig7_calib_ablation.mjs")
    rows, ys = [], []
    for i, (key, label) in enumerate(present):
        a = abl["all"][key]
        h = abl["heldout"].get(key)
        color = ARM_COLOR["anipose"] if key == "anipose" else ARM_COLOR["calibrat3"]
        y = len(present) - 1 - i
        ys.append(y)
        # The connector makes the in-sample/held-out pair read as one observation rather
        # than two series; it is drawn first and thin so neither mark sits on it.
        # HELD-OUT IS THE RING, ALL-FRAMES THE DOT, and the ring is drawn LARGER so the
        # two are both visible when they coincide -- which, on this measurement, they
        # always do to three decimals. A ring concentric with its dot is the honest
        # picture of "no generalization gap": same x, nothing hidden. Were a
        # configuration overfitting, its ring would simply sit to the right of its dot
        # and the connector would appear.
        if h is not None:
            ax.plot([a, h], [y, y], color=color, lw=0.8, alpha=0.55, zorder=2)
            ax.plot([h], [y], marker="o", ms=8.0, lw=0, zorder=3, color=color,
                    markerfacecolor="none", markeredgecolor=color, markeredgewidth=1.1)
        ax.plot([a], [y], marker="o", ms=4.0, lw=0, zorder=4, color=color)
        rows.append({"rig": RIG, "arm": key, "label": label,
                     "median_px_all": a, "median_px_heldout": h})

    ax.set_yticks(ys)
    ax.set_yticklabels([lbl for _, lbl in present], fontsize=7)
    ax.set_ylim(-0.7, len(present) - 0.3)
    ax.tick_params(axis="y", length=0, pad=2.0)
    ax.set_xscale("log")
    ax.xaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0), numticks=12))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
    ax.xaxis.set_minor_formatter(NullFormatter())
    ax.set_xlabel("reprojection error, median (px)")
    # A rule at Anipose's value, so every row is read as a distance from the comparator
    # rather than as an absolute a reader has to hold in mind.
    ref = abl["all"].get("anipose")
    if ref is not None:
        ax.axvline(ref, color=ARM_COLOR["anipose"], lw=0.7, ls=(0, (2.5, 1.5)), zorder=1)
    # The coincidence IS the result, so it is stated rather than left to be noticed:
    # a reader who sees only rings would otherwise assume the dots failed to draw.
    gaps = [abs(abl["heldout"][k] - abl["all"][k]) for k, _ in present
            if k in abl["heldout"]]
    note = ("● all frames   ○ held out"
            + (f"  (coincide: max gap {max(gaps):.3f} px)" if gaps and max(gaps) < 0.02
               else "  (open = frames calibrat3 never saw)"))
    text_legend(ax, [(note, INK)], loc="above", size=6.2, dy=0.048)
    deposit(pd.DataFrame(rows), 7, "fig7e_mechanism.csv")
    save(fig, 7, "e", "mechanism")


if __name__ == "__main__":
    main()
