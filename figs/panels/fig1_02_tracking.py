#!/usr/bin/env python3
"""
Fig 1b -- cross-view re-identification: per-camera tracks -> LUC3D identities.

FOUR TILES, TWO CAMERAS, BEFORE AND AFTER. Two cameras are shown because the whole
point is CROSS-view: with one camera there is nothing to re-identify. Left pair =
what the per-camera tracker produces (a different track label per camera, no
correspondence between them); right pair = after Track All, one identity per animal,
consistent across every view.

Every tile comes out of LUC3D's own canvases after the real pipeline ran (load ->
Track All -> Triangulate All) on real 8-camera data. Nothing is mocked, no skeleton
is hand-placed: `_drive.mjs`'s `exportViews()` reads the video and overlay canvases
at native 1280x1024, composites them, and records where each animal was and the
exact colour the app drew it in. The crops below use those recorded bounding boxes.

WHY NATIVE CROPS AND NOT GUI SCREENSHOTS. A view pane is a CSS-scaled 1280x1024
canvas laid out 4-across, so a pane crop is ~300 px wide and a mouse is a few dozen
pixels -- illegible in print. (The first pass of this rewrite used the whole-window
5120x2880 screenshots and was exactly that unreadable.)

THE LEDGER IS THE RESULT, and it is printed under the tiles rather than left to the
caption: 26 per-camera track labels across 8 views collapse to 3 identities, with 24
of 26 detections assigned. The 2 unassigned are named in `fig1.json` (`ledger.
unassigned`) -- a partially-occluded animal in Camera3_sideC and Camera7_sideR --
and the panel does not pretend the assignment is total.

Colours are the Okabe-Ito palette spliced in by `setIdentityPalette()`, NOT the app's
shipped IDENTITY_COLORS: those start #00ff00, #ff00ff, #00ffff, and under
deuteranopia the green and magenta converge -- the two animals a reader is meant to
tell apart become the same colour. The app on disk is deliberately untouched.

    python3 figs/panels/fig1_02_tracking.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.style import (GREY, INK, SPAN, deposit, mm, save, tile, use)  # noqa: E402

import pandas as pd  # noqa: E402

#: The two cameras shown. Deliberately one overhead and one side view, so the
#: re-identification is across genuinely different viewpoints.
CAMS = ["Camera0_mid", "Camera7_sideR"]
STAGES = [("before", "per-camera tracks"), ("after", "LUC3D identities")]


def bbox_for(manifest, cam):
    for v in manifest:
        if v["name"] == cam:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def main():
    use()
    j = load("fig1.json")
    led = j["ledger"]

    # Deposit the ledger, so the numbers printed on the artwork are auditable.
    deposit(pd.DataFrame([{
        "detections": led["detections"], "distinct_track_names": led["distinctNames"],
        "identities": led["identities"], "assigned": led["assigned"],
        "unassigned": len(led["unassigned"]), "cameras": j["stats"]["nCameras"],
    }]), 1, "fig1b_reid_ledger.csv")

    tiles = []
    for stage, _ in STAGES:
        for cam in CAMS:
            p = OUT / f"{stage}-f150-{cam}.png"
            if not p.exists():
                sys.exit(f"missing figs/out/{p.name} — run `node figs/fig1_tracking.mjs`")
            tiles.append((p, bbox_for(j[stage], cam), cam))

    w = SPAN["full"]
    fig, axes = plt.subplots(1, 4, figsize=(mm(w), mm(40.0)), layout="constrained")
    # Reserve strips for the group headings and the ledger line. With
    # savefig.bbox=None nothing outside [0,1] is rendered, so text drawn at y=1.005
    # simply vanished -- the space has to be taken from the axes instead.
    fig.get_layout_engine().set(rect=(0, 0.14, 1, 0.80))
    for ax, (p, bbox, cam) in zip(axes, tiles):
        tile(ax, p, bbox, badge=cam.split("_", 1)[1], pad=0.06,
             corner="lower left")

    # Group headings sit over their own pair, so the before/after split is readable
    # without reading the caption.
    for k, (_, heading) in enumerate(STAGES):
        a0, a1 = axes[2 * k], axes[2 * k + 1]
        x = (a0.get_position().x0 + a1.get_position().x1) / 2
        fig.text(x, 0.845, heading, ha="center", va="bottom", fontweight="bold",
                 color=INK, fontsize=8)

    fig.text(0.5, 0.055,
             f"{led['detections']} per-camera track labels in {j['stats']['nCameras']} "
             f"views → {led['identities']} identities, one per animal in every view "
             f"({led['assigned']} of {led['detections']} assigned)",
             ha="center", va="center", color=GREY, fontsize=7)
    save(fig, 1, "b", "tracking")


if __name__ == "__main__":
    main()
