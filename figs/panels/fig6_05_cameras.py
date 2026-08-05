#!/usr/bin/env python3
"""
Fig 6b -- one SLAP-2M frame, six cameras, with the app's overlays.

Shows what a session actually looks like: six simultaneous views of the same
instant, each with LUC3D's pose overlay in the shared identity colours. This is the
raw material behind every number in panels c and d, and the first pass of this
rewrite dropped it entirely in favour of a mean-pose skeleton -- which says nothing
about what is IN the data.

Exported by `fig6_app.mjs` from a real session (difficulty 4, 4 animals, black
bedding), so the difficulty rating panel c stratifies on is visible here as an image.

    python3 figs/panels/fig6_05_cameras.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT  # noqa: E402
from src.style import GREY, SPAN, mm, save, tile, use  # noqa: E402

CAMS = ["back", "backL", "mid", "midL", "top", "topL"]


def main():
    use()
    paths = [OUT / f"fig6-view-f120-{c}.png" for c in CAMS]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        sys.exit(f"missing figs/out/{missing} — run `node figs/fig6_app.mjs`")

    fig, axes = plt.subplots(2, 3, figsize=(mm(SPAN["half"]), mm(40.0)),
                             layout="constrained")
    fig.get_layout_engine().set(rect=(0, 0.07, 1, 0.98))
    for ax, cam, p in zip(axes.ravel(), CAMS, paths):
        tile(ax, p, None, badge=cam, corner="lower left")
    fig.text(0.5, 0.03, "one frame, six cameras · SLAP-2M", ha="center",
             va="center", color=GREY, fontsize=6.5)
    save(fig, 6, "b", "cameras")


if __name__ == "__main__":
    main()
