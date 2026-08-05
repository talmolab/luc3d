#!/usr/bin/env python3
"""
Fig 1c -- the triangulated 3D, in LUC3D's own viewport, next to the image it came from.

THREE TILES, AND THE ORDER IS THE ARGUMENT: the camera's video, the same camera's
view of the 3D reconstruction, and the whole rig. Reading left to right you can
check the reconstruction against the pixels it was computed from, then see where the
cameras that produced it actually sit.

WHY THE VIEWPORT IS SET TO A REAL CAMERA'S PERSPECTIVE. An arbitrary orbit angle
cannot be checked against anything. Using the app's own "Show Camera View" button
puts the 3D skeletons exactly where that camera's 2D pane shows the animals, so
tiles 1 and 2 are the SAME scene from the SAME viewpoint and the reader can compare
rather than take it on faith.

WHICH WAY IS UP. This rig's calibration frame has +Z pointing DOWN: the overhead
cameras have a SMALLER z than the animals on the floor. Assuming Z-up (the
viewport's default) renders the rig upside down with the animals floating above the
cameras, which is how the first pass of this panel came out. `rigFit()` takes "up"
from the data instead -- whichever Z direction points from the animals toward the
cameras.

FRAMING. The app's own "Show Initial View" fits the scene BOUNDS, which leaves the
animals a few pixels across. `rigFit()` projects the real content, takes its
bounding box in the render, and scales the viewing distance AND pans so that box
fills the frame. Fitting a bounding sphere was tried first and is both loose and
off-centre -- the rig is a flat-ish shell whose centroid is not where the content
lands on screen.

TILE SIZE. The row is 180 mm wide but only ~32 mm tall, so the tiles are
HEIGHT-limited and a square tile can never be wider than ~32 mm -- three of them
left half the row empty and the rig tile 24 mm wide, which is not enough to read a
camera label in. The crops below are therefore TIGHT on the content vertically
(that, against the row's height in mm, is the only thing that sets how big anything
prints) and opened out to a landscape `aspect` horizontally, which fills the row at
no cost in magnification. `src.style.tile()`/`load_tile()` cannot do this -- they pad
the bbox out to `max(w, h)` on both sides and always return a SQUARE -- so the crop
is taken here and applied as view limits, and the cell widths are set from the
aspects so no cell is wider than the tile it holds. The row of tiles went from 91 mm
of the 180 to 162 mm.

The wins are in the two tiles that were paying for the square: the 3D view's crop
drops 390 px -> 294 px (the old box carried 120 px of empty viewport above the
animals) and the rig's 1113 px -> 638 px, so at equal row height the rig prints 1.7x
larger and the 3D 1.3x. The video tile is the one that gains nothing: its animals
span 637 of 1024 px, so the old square crop was already sized on their HEIGHT and
there is no slack to take. It prints 0.95x -- the panel is 35 mm rather than the
38 mm this rewrite was tuned at, because Fig 1 has to clear assemble.py's 200 mm
ceiling and 3 mm came out of this row to pay for the figure-level footer. That 3 mm
is worth ~9% on all three tiles if it is ever available again.

WHY THE RIG CROP CUTS THE GROUND PLANE. The rig render is 800x1696 of which the
cameras, the labels and the animals occupy only x 262-800, y 630-1226; the rest is
the viewport's ground-plane grid and axis gizmo, which are app chrome rather than
data. Keeping them in frame cost more than half the tile's pixels.

KNOWN DEFECT -- THE PALETTE DOES NOT MATCH PANEL b. The 3D exports were staged
BEFORE `setIdentityPalette()` existed, so they still carry the app's shipped
`IDENTITY_COLORS` (#00ff00 green, #ff00ff magenta, #00ffff cyan) while panel b
carries the colourblind-safe Okabe-Ito palette. Same three animals, two colour
schemes inside one figure -- and the shipped green/magenta pair is exactly the one
that converges under deuteranopia. `setIdentityPalette()` is wired into
`fig2_protocol.mjs` and `fig5_panel_a.mjs` but NOT into `fig1_tracking.mjs`. THE FIX
IS TO RE-STAGE: add `setIdentityPalette(page)` to `fig1_tracking.mjs` AFTER
`trackAll()` (it rewrites `.color` on identities that already exist, so calling it
earlier is a no-op) and re-run the driver. Do not recolour the PNGs.

    python3 figs/panels/fig1_03_reconstruction.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.style import INK, SPAN, mm, save, tile, use  # noqa: E402

VIEW_CAM = "Camera0_mid"

#: file, badge, CONTENT bbox in source pixels (None = use the manifest's own bbox),
#: tile aspect (w:h). The bbox is what must stay in frame; the aspect is how far the
#: crop opens out sideways to fill the row (see TILE SIZE above). The 3D tiles are
#: 800x1696 of mostly empty viewport, so they name their content explicitly --
#: measured, not guessed: these are the extents of the coloured (non-chrome) pixels.
#: The rig's aspect is capped by its own source width: 800 px / 638 px = 1.25, which
#: is why it is the narrow tile of the three -- and why the rig would benefit from a
#: re-export at a landscape viewport far more than from any framing done here.
TILES = [
    ("after-f150-Camera0_mid.png", "cam 0 mid: video", None, 1.87),
    ("fig1b-e-3d-camview-clean.png", "cam 0 mid: 3D", (156, 759, 393, 1034), 1.95),
    ("fig1b-d2-3d-rig.png", "rig", (262, 630, 800, 1226), 1.25),
]
#: Breathing room added to the bbox HEIGHT, as a fraction of it -- the number that
#: sets how big everything prints, so it stays small.
TILE_PAD = 0.07


def crop_to_aspect(bbox, src_w, src_h, aspect, pad):
    """`bbox` (source pixels) opened out to exactly `aspect`, clamped to the frame.

    Height comes from the bbox plus `pad`; width follows from `aspect`. When the
    window would fall outside the frame it is SLID rather than shrunk, so the tile
    keeps the aspect its cell was sized for -- a shrunk window would leave a gap
    and quietly change that tile's magnification.
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
    bbox = None
    for v in j["after"]:
        if v["name"] == VIEW_CAM:
            b = v["bbox"]
            bbox = (b["x0"], b["y0"], b["x1"], b["y1"])

    print("  WARNING: the 3D exports predate setIdentityPalette() — their identity "
          "colours do NOT match panel b. See the docstring.")

    fig, axes = plt.subplots(1, 3, figsize=(mm(SPAN["full"]), mm(35.0)),
                             layout="constrained",
                             gridspec_kw={"width_ratios": [a for *_, a in TILES]})
    # `rect` is `(left, bottom, WIDTH, HEIGHT)`, NOT `(left, bottom, right, top)`.
    # Written as the latter, `(0, 0.11, 1, 0.985)` put the tiles' band from y = 0.11
    # to y = 1.095 -- off the top of the page, so every tile lost its top ~9%, taking
    # part of the burned-in camera names in the rig view with it. The band now really
    # does stop inside the page.
    #
    # Only the 7 pt stat line is reserved for, 3.1 mm at the bottom; the tiles run to
    # the top edge of the panel, since the assembler already leaves 4.5 mm of lead
    # above every row for the panel letter. Every millimetre in a strip is a
    # millimetre off the height of all three tiles, and they are height-limited.
    #
    # THE PANEL HEIGHT IS THE WHOLE BUDGET HERE: the tiles are exactly as tall as the
    # band and no taller, so every millimetre taken off this figsize comes straight
    # off all three of them. At 35 mm the band is 31.9 mm and the row of tiles is
    # 164 of the 180 mm; at 38 mm it was 34.7 mm and 176 mm. Fig 1 has to clear
    # assemble.py's 200 mm ceiling, so this is where the trade lands.
    fig.get_layout_engine().set(rect=(0, 0.088, 1, 0.912), wspace=0.01,
                                w_pad=0.004, h_pad=0.004)
    for ax, (name, badge, crop, aspect) in zip(axes, TILES):
        p = OUT / name
        if not p.exists():
            sys.exit(f"missing figs/out/{name} — run `node figs/fig1_tracking.mjs`")
        # bbox=None: read the frame whole, then crop by setting the view limits.
        # imshow puts source pixels in data coordinates, so the axes shows exactly
        # the window asked for, keeps aspect='equal' (no stretching), and the badge
        # -- drawn in axes coordinates -- still lands in the tile's own corner.
        tile(ax, p, None, badge=badge, corner="lower left")
        sh, sw = ax.images[0].get_array().shape[:2]
        x0, y0, x1, y1 = crop_to_aspect(crop if crop is not None else bbox,
                                        sw, sh, aspect, TILE_PAD)
        ax.set_xlim(x0, x1)
        ax.set_ylim(y1, y0)           # imshow's y axis runs downwards

    fig.text(0.5, 0.046,
             f"{j['stats']['groupsThisFrame']} animals triangulated from "
             f"{j['stats']['nCameras']} cameras · "
             f"{j['stats']['nodes3dFilled']}/{j['stats']['nodes3d']} 3D nodes filled",
             ha="center", va="center", color=INK, fontsize=7)
    save(fig, 1, "c", "reconstruction")


if __name__ == "__main__":
    main()
