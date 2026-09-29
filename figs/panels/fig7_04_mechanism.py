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
    ("abl_default", "calibrat3, default"),
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
    # THIRD width, not half: at half the x axis ran to 86.9 mm while a, c and e end at
    # 56.3 mm, so the bottom row did not line up with the three rig rows above it
    # (Eric, 2026-09-17). At a third the axis ends at the same place, and the width
    # freed lets h and i become thirds too. key=0: the panel no longer has a legend.
    fig, ax = panel("third", 41, key=0)
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
        # HELD-OUT IS NOT DRAWN. It agrees with all-frames to 0.004 px, so the ring was
        # concentric with its dot and read as a slightly fatter marker. The number is in
        # the Results and in this panel's CSV, where it can be checked.
        ax.plot([a], [y], marker="o", ms=4.5, lw=0, zorder=4, color=color)
        rows.append({"rig": RIG, "arm": key, "label": label,
                     "median_px_all": a, "median_px_heldout": h})

    ax.set_yticks(ys)
    ax.set_yticklabels([lbl for _, lbl in present], fontsize=7)
    # Row labels wear their arm's colour, so "which of these is Anipose" is answered
    # without reading. Same encoding as every other panel in the figure.
    for tick, (key, _) in zip(ax.get_yticklabels(), present):
        tick.set_color(ARM_COLOR["anipose"] if key == "anipose" else ARM_COLOR["calibrat3"])
    ax.set_ylim(-0.7, len(present) - 0.3)
    ax.tick_params(axis="y", length=0, pad=2.0)
    ax.set_xscale("log")
    ax.xaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0), numticks=12))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
    ax.xaxis.set_minor_formatter(NullFormatter())
    # SHORT LABEL: at a third width the axis is 23 mm and lint_text reported the long
    # form clipped and silently truncated. Every value on this axis is a median.
    ax.set_xlabel("median error (px)")
    # SHORT AXIS. The log locator would otherwise run the axis out to the next round
    # decade and leave the dots strung across the panel, which is a long way for the
    # eye to carry a row label (Eric, 2026-09-17). Clipped to the data with a small
    # margin, and a faint leader drawn on each row for the same reason.
    lo = min(v for v in abl["all"].values() if v is not None)
    hi_x = max(v for v in abl["all"].values() if v is not None)
    ax.set_xlim(lo / 1.18, hi_x * 1.12)
    for y in ys:
        ax.plot([lo / 1.18, hi_x * 1.12], [y, y], color=MUTED, lw=0.35, alpha=0.30,
                zorder=0, solid_capstyle="butt")
    # A rule at Anipose's value, so every row is read as a distance from the comparator
    # rather than as an absolute a reader has to hold in mind.
    ref = abl["all"].get("anipose")
    if ref is not None:
        ax.axvline(ref, color=ARM_COLOR["anipose"], lw=0.7, ls=(0, (2.5, 1.5)), zorder=1)
    # The coincidence IS the result, so it is stated rather than left to be noticed:
    # a reader who sees only rings would otherwise assume the dots failed to draw.
    # No legend: one series of dots, coloured by arm, with the comparator drawn as a
    # rule. Naming "all frames" and "held out" described a distinction the panel had
    # stopped showing once the rings came off.
    deposit(pd.DataFrame(rows), 7, "fig7g_mechanism.csv")
    save(fig, 7, "g", "mechanism")


if __name__ == "__main__":
    main()
