#!/usr/bin/env python3
"""
Fig 7e -- error composition: false positives and ID switches, as a PERCENTAGE of
camera-frames.

PERCENTAGES, NOT RAW COUNTS (review 2026-08, second pass). The counts-version's
bars were exact but unanchored: "3,710 switches" means nothing without the
exposure it accumulated over. A first revision normalised to errors per 100,000
camera-frames; review then asked for plain percent -- the unit nobody has to
convert: an ID switch happens on 0.0316% of LUC3D's camera-frames, i.e. the
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
0.0316% against ByteTrack 0.105%, a 3.3x reduction.

THREE SIGNIFICANT FIGURES, AND IT HAS TO BE THREE. The two comparisons the panel
exists to support survive the rounding only there: SLEAP's switch rate is
essentially LUC3D's (0.0308% vs 0.0316% -- at two significant figures
"0.031 vs 0.032" reads as a coincidence of rounding), and ByteTrack's 3.3x ratio
is recoverable from 0.105 / 0.0316. `%.3g` keeps three significant figures on
both the large FP percentages and the small switch ones.

NOTE LUC3D DOES NOT WIN ON WITHIN-VIEW SWITCHES, and the panel does not pretend
otherwise: SLEAP's 3,608 is fractionally better. LUC3D's advantage is cross-view
(Fig 7a) and under changing background (Fig 7b) -- and it fragments MORE than SLEAP,
which is the panel next door (Fig 7g).

Source: figs/out/fig3_trackers.json `slap2m.error_decomposition`.

    python3 figs/panels/fig7_03_error_decomposition.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, entity, deposit, panel, save,  # noqa: E402
                       text_legend, use)

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



def main():
    use()
    sl = load("fig3_trackers.json")["slap2m"]
    ed = sl["error_decomposition"]
    tcf = sl.get("total_camera_frames")
    if not tcf:
        sys.exit("fig7e: fig3_trackers.json has no slap2m.total_camera_frames -- "
                 "re-run figs/fig3_trackers.py to regenerate the deposit.")

    df = pd.DataFrame([{"tracker": lab, "term": name, "count": ed[k][key],
                        "pct_of_camera_frames": ed[k][key] / tcf * 100,
                        "camera_frames": tcf, "fn_share": ed[k]["fn_share"]}
                       for k, lab, _ in TRACKERS for key, name in TERMS])
    deposit(df, 7, "fig7e_error_decomposition.csv")

    # 80 mm rather than a half: this row now carries three panels (e, f, g) and the
    # six labelled rates need the width. At 88 mm the row would not fit 180 mm.
    fig, ax = panel(80.0, ROW_H, key=1)
    top = max(ed[k]["false_positives"] for k, _, _ in TRACKERS) / tcf * 100 * 1.30
    x = np.arange(len(TERMS))
    for i, (k, lab, color) in enumerate(TRACKERS):
        vals = [ed[k][key] / tcf * 100 for key, _ in TERMS]
        pos = x + (i - 1) * BAR_W
        ax.bar(pos, vals, width=BAR_W, color=color, zorder=2)
        for j, (px, v) in enumerate(zip(pos, vals)):
            # The two switch rates differ by 3% (0.0316 vs 0.0308), so their
            # labels would sit at the same height on adjacent bars. Stagger the
            # middle tracker upward; the FP group is spread enough not to need it.
            lift = 0.055 if (j == 1 and i == 1) else 0.0
            ax.text(px, v + (0.02 + lift) * top, f"{v:.3g}%", ha="center",
                    va="bottom", color=color, fontsize=6, fontweight="bold")

    text_legend(ax, [(lab, c) for _, lab, c in TRACKERS], "above", dy=KEY_DY,
                xy=(0.14, 0.985), transform=fig.transFigure)
    ax.set_xticks(x)
    ax.set_xticklabels([n for _, n in TERMS])
    ax.set_xlim(-0.45, len(TERMS) - 0.55)
    # "% of camera-frames" is the honest unit; the footnote's first line carries
    # the precise denominator. (A longer rotated label clipped at this height --
    # lint: clipped + silently dropped -- so keep it terse.)
    ax.set_ylabel("errors (% of frames)")
    ax.set_ylim(0, top)
    lo = min(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    hi = max(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    # 100_000/… not .1%: the shares are the SAME numbers as before, but the line
    # must be ~4 characters shorter now that 3-digit y ticks push the axes centre
    # (and the axes-centred footnote) rightward -- lint clipped the old wording.
    footnote(ax, f"rate basis: {tcf:,} camera-frames\n"
             f"false negatives: {lo:.1%}–{hi:.1%} of the error")
    save(fig, 7, "e", "decomposition")


if __name__ == "__main__":
    main()
