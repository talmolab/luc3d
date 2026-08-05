#!/usr/bin/env python3
"""
Fig 5b -- the per-view reprojection error the app reports, for every animal in one frame.

This is the signal a proofreader actually sees: LUC3D's Instance Info panel reports,
per animal, the reprojection error in each camera. The panel shows why that is
usable as a triage signal -- one animal in this frame sits at ~12 px mean while the
other two sit near 3 px, and the outlier is visible in EVERY view rather than in one.

STAGED FROM AN ALL-VIEWS SOLVE, ON PURPOSE. An earlier draft reused Fig 2a's tiles
and numbers, which come from a deliberately crippled TWO-ANCHOR solve where every
non-anchor residual is inflated by construction (up to 24.6 px). That inflation is
Fig 2's point and the exact opposite of this one: Fig 5 is about proofreading a
fully-informed 3D. Hence `fig5_panel_a.mjs`, a staging run of its own.

ONE FRAME, THREE ANIMALS, EIGHT CAMERAS. This is an illustration of the readout, not
a corpus statistic -- the corpus statistics are panel c and Fig 6c. The caption must
say so.

Source: figs/out/fig5a.json `reprojErrorsAllViews` (written by fig5_panel_a.mjs).

    python3 figs/panels/fig5_02_per_view_error.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import footnote, GREY, SET2, deposit, panel, save, text_legend, use  # noqa: E402


def main():
    use()
    j = load("fig5a.json")
    errs = j["reprojErrorsAllViews"]

    rows = []
    for e in errs:
        for cam, v in e["perView"].items():
            rows.append({"identity": e["identity"], "camera": cam,
                         "reproj_px": v, "mean_px": e["meanError"]})
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5b_per_view_error.csv")

    cams = list(errs[0]["perView"])
    # Camera names carry a role suffix (Camera6_sideL); the role is the informative
    # half, so the tick shows that rather than the index.
    labels = [c.split("_", 1)[1] if "_" in c else c for c in cams]
    x = np.arange(len(cams))

    fig, ax = panel("half", "std", key=3)
    for i, e in enumerate(errs):
        vals = [e["perView"][c] for c in cams]
        ax.plot(x, vals, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(x, vals, "o", color=SET2[i], ms=5, mec="white", mew=1.0, zorder=4)

    text_legend(ax, [(f"animal {e['identity']}  (mean {e['meanError']:.1f} px)",
                      SET2[i]) for i, e in enumerate(errs)], "above")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.set_ylabel("reprojection error (px)")
    ax.set_ylim(0, None)
    footnote(ax, f"one frame ({j['frame']}), {len(cams)} cameras, "
            f"all-views solve")
    save(fig, 5, "a", "per_view_error")


if __name__ == "__main__":
    main()
