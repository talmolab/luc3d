#!/usr/bin/env python3
"""
Fig 7c -- within-view IDF1 per session, across the SLAP-2M corpus.

THIS PANEL REPLACED A DOT SWARM, and the change is substantive, not cosmetic. As
444 jittered dots the finding was invisible; as a survival curve -- the percentage
of sessions scoring at or above each IDF1 threshold -- it is a vertical distance at
any threshold the reader cares to pick.

The trackers separate most in the UPPER TAIL, which both a median bar and a jittered
cloud bury: at IDF1 >= 0.9 the counts are LUC3D 36/74, SLEAP 22/74, ByteTrack 10/74.

The curve is drawn from every session's own IDF1, so it is a true ECDF over the 74
sessions rather than an interpolation through the five deposited thresholds; the 0.9
threshold is marked so the numbers in the caption can be read straight off.

WHAT THIS PANEL MEASURES IS NOT WHAT 7a MEASURES, and the figure previously gave a
reader no way to tell. 7a's "within view" is 0.749 -- BMimica, 50 sessions, 5
cameras. This is SLAP-2M, 74 sessions, 6 cameras, where LUC3D's within-view mean is
0.736. Two different quantities, both called within-view IDF1; the corpus and n are
now on the panel.

BOTH MEAN AND MEDIAN ARE PRINTED, which the deposit asks for: `caveats` --
"Corpus means are dragged by a heavy tail: LUC3D within-view IDF1 mean 0.736 vs
median 0.900. Report both." The survival curve shows exactly that shape (half the
sessions above 0.9, a long tail of hard ones below 0.3), so those two numbers are the
right summary to set beside it.

The in-axes block also carries `camera_session_argmax` -- how many of the 444
camera-sessions each tracker wins outright -- which was on the legacy panel and had
been dropped: LUC3D 229, SLEAP 173, ByteTrack 4, 38 tied.

Source: figs/out/fig3_trackers.json `slap2m.within_view[*].per_session`,
        `slap2m.camera_session_argmax`.

    python3 figs/panels/fig7_01_survival.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, footnote, GREY, PERIWINKLE, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, use)

TRACKERS = [("luc3d", "LUC3D", TEAL), ("sleap", "SLEAP", PERIWINKLE),
            ("bytetrack", "ByteTrack", SALMON)]
MARK = 0.9
N_CAMERAS = 6


def main():
    use()
    t = load("fig3_trackers.json")
    sl = t["slap2m"]
    wv = sl["within_view"]
    am = sl["camera_session_argmax"]
    n_cs = sl["n_camera_sessions"]

    rows = []
    # "half", not "third": at a third of the page this panel could not carry its own
    # corpus label, and the row it shares with 7d used 149 of 180 mm, so the width
    # was free. Both panels in the row are now 88 mm and their axes line up.
    fig, ax = panel("half", "std")
    for key, label, color in TRACKERS:
        v = np.sort(np.asarray(wv[key]["per_session"]))
        n = len(v)
        # Survival: % of sessions at or above each threshold. Step-post, because
        # the value is constant until the next session's score is passed.
        surv = 100.0 * (n - np.arange(n)) / n
        ax.step(v, surv, where="post", color=color, lw=2.0, zorder=3)
        atmark = 100.0 * (v >= MARK).sum() / n
        rows += [{"tracker": label, "idf1": float(x), "survival_pct": float(s)}
                 for x, s in zip(v, surv)]
        ax.plot([MARK], [atmark], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)

    deposit(pd.DataFrame(rows), 7, "fig7c_survival.csv")

    ax.axvline(MARK, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # Lower LEFT: every curve starts near 100% and falls rightwards, so this corner
    # is the only reliably empty one -- against the 0.9 rule the three counts landed
    # on the strokes they describe. The names live here too rather than in a key band
    # above, which keeps the plot its full height for the four-line footer.
    for i, (key, label, color) in enumerate(TRACKERS):
        v = np.asarray(wv[key]["per_session"])
        ax.text(0.03, 0.22 - i * 0.09,
                f"{label}  {int((v >= MARK).sum())}/{len(v)} · {am[key]}/{n_cs}",
                transform=ax.transAxes, ha="left", color=color, fontsize=7,
                fontweight="bold")
    ax.text(MARK - 0.015, 96, f"IDF1 ≥ {MARK}", color=MUTED, fontsize=7, ha="right",
            rotation=90, va="top")

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    # "session mean over 6 cameras" belongs in the axis label, not the footer: the
    # unit of replication is the session, and each session's IDF1 is the mean of its
    # six per-camera scores. The legacy footer said so and it had been dropped; on the
    # label it is next to the quantity it qualifies, and the footer lines stay narrow
    # enough not to hang off an 88 mm panel.
    ax.set_xlabel(f"IDF1 threshold, session mean over {N_CAMERAS} cameras")
    ax.set_ylabel("% of sessions at or above")
    luc = wv["luc3d"]
    footnote(ax, f"one step per session; n = {luc['n_sessions']} SLAP-2M sessions\n"
             f"counts: sessions ≥ {MARK} · camera-sessions won "
             f"({am['tie']} of {n_cs} tied)\n"
             f"LUC3D within-view IDF1: mean {luc['mean']:.3f}, "
             f"median {luc['median']:.3f}")
    save(fig, 7, "c", "survival")


if __name__ == "__main__":
    main()
