#!/usr/bin/env python3
"""
Fig 7b -- bedding invariance: does the tracker survive a change of background?

White mice on white bedding is the hard case; black bedding is the easy one. The
SAME identity-stripped detections feed every tracker, and detector recall barely
moves between the two conditions (delta 0.004), so any drop is the TRACKER's, not
the detector's. That control is drawn as the dashed line and is what makes the
comparison interpretable.

LUC3D loses 0.012, SLEAP 0.079, ByteTrack 0.148. The reason is geometric: LUC3D's
association is dominated by the 3D term (Fig 3d), which does not care what the
bedding looks like, while a per-camera appearance/motion tracker degrades with
contrast.

Source: figs/out/fig3_trackers.json `slap2m.by_bedding`.

    python3 figs/panels/fig7_06_bedding.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, PERIWINKLE, SALMON, TEAL, deposit, panel, save,  # noqa: E402
                       use)

TRACKERS = [("luc3d", "LUC3D", TEAL), ("sleap", "SLEAP", PERIWINKLE),
            ("bytetrack", "ByteTrack", SALMON)]
CONDS = ["black", "white"]


def main():
    use()
    bb = load("fig3_trackers.json")["slap2m"]["by_bedding"]

    rows = []
    fig, ax = panel("half", "std")
    for key, label, color in TRACKERS:
        ys = [bb[c][key]["idf1"] for c in CONDS]
        ax.plot([0, 1], ys, color=color, lw=2.0, zorder=3)
        ax.plot([0, 1], ys, "o", color=color, ms=5, mec="white", mew=1.0, zorder=4)
        ax.annotate(f"{label} Δ{ys[0] - ys[1]:+.3f}".replace("+", ""), (1, ys[1]),
                    textcoords="offset points", xytext=(8, 0), color=color,
                    fontsize=6.5, fontweight="bold", va="center",
                    annotation_clip=False)
        rows += [{"tracker": label, "bedding": c, "idf1": y,
                  "n_sessions": bb[c]["n_sessions"]} for c, y in zip(CONDS, ys)]

    # The control: the detector sees essentially the same thing in both conditions,
    # so the tracker drops are the trackers' own.
    rec = [bb[c]["detector_recall"] for c in CONDS]
    ax.plot([0, 1], rec, color=GREY, lw=1.2, ls=(0, (2.5, 1.5)), zorder=2)
    ax.annotate(f"detector recall Δ{rec[0] - rec[1]:.3f}", (1, rec[1]),
                textcoords="offset points", xytext=(8, 8), color=GREY,
                fontsize=6.5, va="center", annotation_clip=False)
    rows += [{"tracker": "detector recall", "bedding": c, "idf1": y,
              "n_sessions": bb[c]["n_sessions"]} for c, y in zip(CONDS, rec)]

    deposit(pd.DataFrame(rows), 7, "fig7b_bedding.csv")
    ax.set_xlim(-0.15, 1.15)
    ax.set_xticks([0, 1])
    ax.set_xticklabels([f"{c} bedding" for c in CONDS])
    ax.set_ylabel("IDF1")
    ax.set_ylim(0, 0.95)
    footnote(ax, f"n = {bb['black']['n_sessions']} + {bb['white']['n_sessions']} "
            f"SLAP-2M sessions; identical detections")
    save(fig, 7, "b", "bedding")


if __name__ == "__main__":
    main()
