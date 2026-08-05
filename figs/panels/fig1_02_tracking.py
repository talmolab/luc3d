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

TILE SIZE, AND WHY THE CROPS ARE LANDSCAPE. The row is 180 mm wide and about 33 mm
tall, so the tiles are HEIGHT-limited: a SQUARE tile -- which is all
`src.style.tile()`/`load_tile()` can make, since it pads the bbox out to
`max(w, h)` on both sides -- can never be wider than ~33 mm, and four of them left
~54 mm of the row empty as gaps. `crop_to_aspect()` below takes the crop instead:
TIGHT on the recorded animal bbox vertically, WIDE horizontally. That spends the
54 mm on arena instead of on white space and costs nothing, because how big an
animal PRINTS is set by the crop's height in pixels against the row's height in mm,
not by the tile's width. It also stops the wider camera subsidising the narrower
one: cam 7's animals span 510 px and cam 0's 637, and under the old square crop
cam 7 was scaled by its 707 px WIDTH, printing its animals ~40% smaller than they
need to be.

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

#: Tile aspect (width : height), shared by all four tiles so the row is flush.
#: 1.34 x 4 tiles at the 33 mm row height comes to 176 of the 180 mm, so the
#: tiles are 44 mm wide with a ~1.5 mm gutter between neighbours -- a contact
#: sheet, not four islands, and the same gutter panel c's row lands on. Raising it
#: further would make the tiles WIDTH-limited (the cells are 45 mm) and start
#: costing height, which is the dimension that matters.
TILE_ASPECT = 1.34
#: Breathing room added to the bbox HEIGHT, as a fraction of it. This is the one
#: number that sets how big the animals print, so it stays small; 0.06 leaves
#: ~19 px of margin above and below cam 0's animals at 1280x1024.
TILE_PAD = 0.06


def bbox_for(manifest, cam):
    for v in manifest:
        if v["name"] == cam:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def crop_to_aspect(bbox, src_w, src_h, aspect, pad):
    """`bbox` (source pixels) opened out to exactly `aspect`, clamped to the frame.

    Height comes from the bbox plus `pad`; width follows from `aspect`. When the
    window would fall outside the frame it is SLID rather than shrunk, so every
    tile in the row really does share one aspect and the row stays flush -- a
    shrunk window would silently change that tile's magnification.
    """
    x0, y0, x1, y1 = bbox
    h = min((y1 - y0) * (1 + pad), src_h)
    w = min(h * aspect, src_w)
    h = min(h, w / aspect)              # aspect wins if the width had to clamp
    cx = min(max((x0 + x1) / 2, w / 2), src_w - w / 2)
    cy = min(max((y0 + y1) / 2, h / 2), src_h - h / 2)
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


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
    H = 40.0
    fig, axes = plt.subplots(1, 4, figsize=(mm(w), mm(H)), layout="constrained")
    # Reserve strips for the group headings and the ledger line. With
    # savefig.bbox=None nothing outside [0,1] is rendered, so text drawn at y=1.005
    # simply vanished -- the space has to be taken from the axes instead.
    #
    # `rect` IS `(left, bottom, WIDTH, HEIGHT)`, NOT `(left, bottom, right, top)`.
    # It was written as if it were the latter, so `(0, 0.14, 1, 0.80)` asked for a
    # band running to y = 0.94 rather than to 0.80 -- the tiles grew straight up
    # into the strip meant for the headings and the headings printed on the images
    # (56% and 39% of their boxes inked). The band now really does stop short of the
    # headings.
    #
    # The strips are cut to exactly what the two text lines need -- 3.2 mm for the
    # 7 pt ledger, 3.8 mm for the 8 pt headings -- because every millimetre left in
    # them is a millimetre off the height of all four tiles, and the tiles are
    # height-limited. The panel height is unchanged on purpose: Fig 1 assembles to
    # 199 mm and assemble.py warns past 200.
    fig.get_layout_engine().set(rect=(0, 0.080, 1, 0.825), wspace=0.01,
                                w_pad=0.004, h_pad=0.004)
    for ax, (p, bbox, cam) in zip(axes, tiles):
        # bbox=None: read the frame whole, then crop by setting the view limits.
        # imshow puts source pixels in data coordinates, so the axes shows exactly
        # the window asked for, keeps aspect='equal' (no stretching), and the badge
        # -- drawn in axes coordinates -- still lands in the tile's own corner.
        # (The whole 1280x1024 frame is embedded and clipped to the axes rather than
        # pre-cropped, which costs ~1 MB of PDF and nothing else -- Illustrator
        # honours the clip, and `load_tile`'s own crop cannot make this shape.)
        tile(ax, p, None, badge=cam.split("_", 1)[1], corner="lower left")
        sh, sw = ax.images[0].get_array().shape[:2]
        x0, y0, x1, y1 = crop_to_aspect(bbox, sw, sh, TILE_ASPECT, TILE_PAD)
        ax.set_xlim(x0, x1)
        ax.set_ylim(y1, y0)           # imshow's y axis runs downwards
    # constrained_layout only places the axes when the figure is drawn; before that
    # `get_position()` still returns the DEFAULT subplot params (left=0.125,
    # right=0.9), which put both headings ~7 mm to the right of their own pair.
    fig.canvas.draw()

    # Group headings sit over their own pair, so the before/after split is readable
    # without reading the caption.
    for k, (_, heading) in enumerate(STAGES):
        a0, a1 = axes[2 * k], axes[2 * k + 1]
        x = (a0.get_position().x0 + a1.get_position().x1) / 2
        fig.text(x, 0.912, heading, ha="center", va="bottom", fontweight="bold",
                 color=INK, fontsize=8)

    fig.text(0.5, 0.043,
             f"{led['detections']} per-camera track labels in {j['stats']['nCameras']} "
             f"views → {led['identities']} identities, one per animal in every view "
             f"({led['assigned']} of {led['detections']} assigned)",
             ha="center", va="center", color=GREY, fontsize=7)
    save(fig, 1, "b", "tracking")


if __name__ == "__main__":
    main()
