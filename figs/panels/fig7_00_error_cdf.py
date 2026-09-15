#!/usr/bin/env python3
"""
Fig 7a/7c -- the reprojection-error distribution, pooled over every observation.

THE PRIMARY RESULT OF THE FIGURE, and a distribution rather than a bar because the
median alone hides the thing that actually matters on a calibration: the tail. A rig
whose median is 0.3 px and whose 99th percentile is 40 px has a handful of cameras
that will throw a triangulated keypoint metres away, and a bar chart of medians says
nothing about it. Drawn as a CUMULATIVE curve on a LOG x axis, so the whole range --
0.03 px to tens of px -- is legible at once and the reader can read off "what
fraction of observations land inside any tolerance I care about".

WHAT IS ON THE X AXIS. One point per (camera, 3D point) observation: the 3D point is
triangulated from every camera that saw it, reprojected into each of them, and the
distance to the detected corner is the datum. The triangulation, the distortion model
and the error definition are aniposelib's, running on aniposelib's own detections --
calibrat3 contributes only the camera parameters being tested. That is the whole
design: the app's own reprojection numbers are not evidence about the app.

WHY THE CURVES ARE DRAWN FROM DEPOSITED QUANTILES, not from the raw errors. There are
10^6-10^7 observations per arm per session; the deposit keeps the exact value at 120
quantile stops instead, which is the same curve to well under a line width and lets a
panel be redrawn without the corpora. Every stop it plots is an exact order statistic
of the full array, not a subsample.

    python3 figs/panels/fig7_00_error_cdf.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARMS, MAIN_C3, MAIN_DETSET  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, text_legend, use  # noqa: E402

#: Panel letter per dataset. a is the 8-camera rig, c the 18-camera one; each sits at
#: the head of its own row, with that rig's per-camera panel beside it.
LETTERS = {"slap8": "a", "calib18": "c"}

#: (letter, slug) this script draws, SPELLED AS LITERALS. `assemble.stale()` and
#: `make_docs.py` attribute a panel to its script by searching the source for the exact
#: text `"a", "error_cdf_cal_test2"`, and this file's `save()` call builds both the
#: letter and the slug from the dataset key -- so without this constant both tools
#: report the panels as MISSING and PANEL-SOURCES.md loses the rows.
PANELS = [("a", "error_cdf_slap8"), ("c", "error_cdf_calib18")]



def curves(ds):
    """(arm key, printed name, colour, filled, x, y, overall) per arm, x px, y %."""
    out = []
    for key, name, color, filled in ARMS:
        arm = ds["detsets"][MAIN_DETSET]["arms"].get(MAIN_C3 if key == "calibrat3" else key)
        if arm is None:
            # A MISSING ARM IS SKIPPED, NOT FATAL. The solver-on-our-corners arm exists
            # only where it was run: the 18-camera rig has it, the 8-camera rig's four
            # recordings do not. Refusing to draw the panel over an arm it never had
            # would block the two rigs that DO have their own comparison.
            continue
        out.append((key, name, color, filled,
                    np.asarray(arm["quantiles"]["v"]), np.asarray(arm["quantiles"]["q"]),
                    arm["overall"]))
    return out


def draw(dskey, ds):
    # KEY=3 RESERVES THE BAND ABOVE THE AXES for the three arm names. Without it the
    # stack lands on the curves' own upper-left corner, which is exactly where the
    # low-error arm goes vertical.
    fig, ax = panel("third", "std", key=3)
    rows = []
    # ONE THIN CURVE PER RECORDING, under the pooled one. The 8-camera rig has FOUR
    # distinct calibration recordings (the SLAP-2M tree looks like it has dozens, but
    # every session folder on a date holds a byte-identical copy of that date's one
    # recording). Drawing them individually turns "n" from a claim in the caption into
    # something the reader can see: four nearly coincident curves per tool is the
    # replication, and any recording that behaved differently would separate here.
    for r in (ds.get("recordings") or {}).values():
        for key, name, color, filled in ARMS:
            a = r["arms"].get(key)
            if a is None:
                continue
            ax.plot(a["quantiles"]["v"], a["quantiles"]["q"], color=color, lw=0.5,
                    alpha=0.55, zorder=2, solid_capstyle="butt")
    for key, name, color, filled, x, y, _ in curves(ds):
        # SOLID for a library's default configuration, DASHED for the same library
        # run on the other tool's corners -- one hue per library, the dash carries
        # the configuration (see fig7_common's note).
        ax.plot(x, y, color=color, lw=2.0 if filled else 1.2,
                ls="-" if filled else (0, (2.5, 1.5)), zorder=3, solid_capstyle="butt")
        rows.append(pd.DataFrame({"dataset": dskey, "arm": key, "error_px": x,
                                  "cumulative_pct": y}))

    ax.set_xscale("log")
    ax.set_xlim(0.05, 60)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("reprojection error (px)")
    ax.set_ylabel("observations ≤ error (%)")
    # The median rule is the one annotation that turns a shape into a number a reader
    # can quote. Grey, thin, behind the data: it is a reading aid, not a result.
    ax.axhline(50, color=MUTED, lw=0.6, ls=(0, (1.5, 1.5)), zorder=1)
    ax.text(0.054, 52, "median", color=MUTED, fontsize=6.5, va="bottom")

    # MEDIAN AND p95, not the median alone -- on the 8-camera rig THE CURVES CROSS:
    # Anipose is lower at the median and several times worse above it, so a panel that
    # printed only the median would report the half of the comparison that happens to
    # be a dead heat and stay silent about the half that is not. The two numbers are
    # the two places a reader's eye already lands on a CDF.
    for i, (key, name, color, filled, x, y, o) in enumerate(curves(ds)):
        ax.text(0.97, 0.06 + 0.085 * (len(ARMS) - 1 - i),
                f"{'– – ' if not filled else ''}{o['med']:.2f} | {o['p95']:.2f}",
                transform=ax.transAxes, color=color, fontweight="bold", fontsize=7,
                ha="right", va="bottom")
    ax.text(0.97, 0.06 + 0.085 * len(ARMS), "median | p95 (px)", transform=ax.transAxes,
            color=MUTED, fontsize=6.5, ha="right", va="bottom")

    # 6.2 pt, not the house 8: the third entry names a library AND a configuration
    # AND carries its dash, and at 8 pt that line is wider than the 57 mm panel. The
    # alternative -- shortening it to fit -- would drop the very words that say what
    # the arm is, on the panel where that arm is the point.
    # SAY HOW MANY RECORDINGS, because the thin per-recording curves sit almost on top
    # of the pooled one and a reader would otherwise read a single recording. The spread
    # IS the replication result, so it is quoted rather than left to be squinted at.
    recs = ds.get("recordings") or {}
    if recs:
        held = sum(1 for r in recs.values() if not r.get("tuning"))
        meds = [r["arms"]["calibrat3_800"]["overall"]["med"] for r in recs.values()
                if "calibrat3_800" in r["arms"]]
        ax.text(0.015, 0.985, f"{len(recs)} recordings ({held} held out)\n"
                              f"calibrat3 median {min(meds):.2f}–{max(meds):.2f} px",
                transform=ax.transAxes, fontsize=6.0, color=MUTED, va="top", ha="left")
    # THE KEY NAMES ONLY WHAT THIS PANEL DRAWS. The solver-on-our-corners arm exists for
    # the 18-camera rig and not for the 8-camera recordings, and a key advertising a
    # dashed curve that is not on the panel is worse than no key.
    drawn = {c[0] for c in curves(ds)}
    text_legend(ax, [(n, c) for k, n, c, _ in ARMS if k in drawn],
                loc="above", size=6.2, dy=0.048)
    save(fig, 7, LETTERS[dskey], f"error_cdf_{dskey}")
    return pd.concat(rows)


def main():
    use()
    rec = load("fig7_calibration.json")
    out = []
    for dskey in LETTERS:
        ds = rec["datasets"].get(dskey)
        if ds is None:
            raise SystemExit(f"fig7_calibration.json has no dataset {dskey!r}")
        out.append(draw(dskey, ds))
    deposit(pd.concat(out), 7, "fig7ac_error_cdf.csv")


if __name__ == "__main__":
    main()
