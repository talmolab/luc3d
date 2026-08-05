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
of the 180 to 162 mm, and to 170 mm once the landscape rig re-export let that tile's
aspect open out from 1.25 to 1.50.

The wins are in the two tiles that were paying for the square. Against the earlier
PORTRAIT 3D exports (800x1696) the 3D view's crop dropped 390 px -> 294 px (the old
box carried 120 px of empty viewport above the animals) and the rig's 1113 px ->
638 px, so at equal row height the rig printed 1.7x larger and the 3D 1.3x. The
video tile is the one that gains nothing: its animals span 620 of 1024 px, so the old
square crop was already sized on their HEIGHT and there is no slack to take. It
prints 0.95x -- the panel is 35 mm rather than the 38 mm this rewrite was tuned at,
because Fig 1 has to clear assemble.py's 200 mm ceiling and 3 mm came out of this row
to pay for the figure-level footer. That 3 mm is worth ~9% on all three tiles if it
is ever available again.

BOTH 3D TILES WERE THEN RE-EXPORTED -- see RE-STAGED below. At the same printed
height the 3D view now carries 1122 px of source instead of 294, 3.8x the linear
resolution. The rig gains far less, 801 px against 638 (1.26x), and deliberately so:
it is LINE ART and a bigger export makes it WORSE, because three.js draws the camera
frustums with `LineBasicMaterial`, whose `linewidth` WebGL ignores -- every frustum
edge is one device pixel however large the canvas is, so its printed weight is (tile
mm)/(crop px) and thins as the export grows. A 4000x2560 re-staging was tried first
and its frustums came out as a barely-there grey smudge at 0.014 mm. The rig's win is
in the other three defects (aspect, framing, clipping) plus a tile 1.2x wider at the
same height, not in pixel count. See the fig1_tracking.mjs rig block for the
arithmetic.

WHY THE RIG CROP IS STILL TIGHTER THAN THE FRAME. The ground-plane grid and the axis
gizmo are app chrome, not data, and on this rig the grid (a bare GridHelper at world
Z=0) floats ABOVE everything; they are now switched off at export time rather than
cropped away. What is left over is the margin `rigFit()` leaves around the content,
so the crop below is still taken on the measured content box.

RE-STAGED (both defects below were in the EXPORTED PIXELS -- no panel-side change
could have fixed either).

  PALETTE. The 3D exports used to be staged BEFORE `setIdentityPalette()` existed, so
  they carried the app's shipped `IDENTITY_COLORS` (#00ff00 green, #ff00ff magenta,
  #00ffff cyan) while panel b carried the colourblind-safe Okabe-Ito palette: the
  same three animals in two colour schemes inside one figure, and the shipped
  green/magenta pair is exactly the one that converges under deuteranopia. Fixed at
  the source: `fig1_tracking.mjs` now calls `setIdentityPalette(page)` AFTER
  `trackAll()` -- the order matters, because `Identity`'s constructor reads the
  palette only at construction time, so the helper rewrites `.color` on identities
  that already exist and calling it any earlier is a no-op. Both 3D tiles are now
  bluish-green / orange / sky blue, the same three colours panel b carries, read from
  the same `fig1.json identityPalette`. The PNGs were re-exported, never recoloured.

  THE RIG TILE'S GEOMETRY. It used to be `showInitialView()` into whatever pane the
  camview tile had left behind: 800x1696 PORTRAIT with the rig in ~19% of the frame
  and the right-hand camera labels running off the edge of the CANVAS -- clipped in
  the source, so no crop could recover them, and what survived printed at ~4 pt. The
  driver now sets the 3D pane to a landscape 800x450 CSS (1600x900 exported at
  deviceScaleFactor 2) and frames it with `rigFit()`, which also fixes the
  orientation: `showInitialView()` resets the up vector to +Z, which on this rig
  points DOWN, so the old tile was rendered upside down with the cameras below the
  animals. The ground-plane grid and axis gizmo are switched off rather than cropped.
  The app's camera labels are switched OFF too: they are screen-space bitmaps at a
  FIXED pixel size, so enlarging the canvas makes them smaller relative to the rig
  rather than bigger, and framing the rig tightly enough for them to be legible piles
  them on top of each other. This tile therefore carries geometry only -- how many
  cameras there are and where they sit -- and `rigFit()` returns every camera's
  projected pixel position (`fig1.json threeD.rigFraming.camScreen`) for a composer
  that wants to typeset its own names at the journal's size.

  MEASURED ON THE CURRENT EXPORT, so this does not have to be re-litigated. The tile
  prints 47.6 x 31.7 mm (78% of the video tile's area, not the quarter the earlier
  portrait export gave), the crop is 1202 x 801 px of `tri3d-rig.png`'s 1600 x 900,
  and the measured content box (272, 56)-(1227, 805) sits inside it with 123 px of
  margin to spare -- so nothing is clipped, all 8 camera frustums are present and
  countable, and with the app's labels off there is no overlapping type left to clip.
  Effective resolution is ~640 dpi and the thinnest frustum edge is one device pixel,
  i.e. 31.7 mm / 801 px = 0.040 mm on the page (median ink run 0.13 mm; the frustum
  colour is 3.0:1 against the tile's #1a1a1a at the median and 6.7:1 at the stroke
  core). That is thin, and THE CROP CANNOT MEANINGFULLY FIX IT: printed stroke width
  is (tile mm)/(crop px), the crop is already only 7% taller than the content it must
  contain, so `TILE_PAD` -> 0 buys 6.8% and nothing else does. The lever that would
  work is a SMALLER export canvas (three.js `LineBasicMaterial` ignores `linewidth`,
  so an edge is one device pixel at any canvas size and a bigger canvas therefore
  prints THINNER), and that is a driver change with its own cost to the skeletons --
  not a panel change. Left alone deliberately.

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
#: crop opens out sideways to fill the row (see TILE SIZE above). Both 3D tiles are a
#: viewport pane whose content sits well inside the frame, so they name their content
#: explicitly -- MEASURED, not guessed: these are the extents of the pixels that
#: differ from the viewport's #1a1a1a background by more than 40/255, i.e. the
#: skeletons plus (rig only) the camera frustums and spheres.
#:
#: `tri3d-camview.png` is 3200x2560 and `tri3d-rig.png` 1600x900, both written by
#: `node figs/fig1_tracking.mjs`. THE BBOXES BELONG TO THOSE EXPORTS: re-run the
#: driver with a different pane size or rig framing and they must be re-measured, or
#: the crop silently slides off the content.
#:
#: `{frame}` is filled from the manifest, never hard-coded: the driver names its
#: exports by frame, so a literal frame number here silently kept reading the OLD
#: tile after the driver was re-run on another frame.
TILES = [
    ("after-f{frame}-Camera0_mid.png", "cam 0 mid: video", None, 1.87),
    ("tri3d-camview.png", "cam 0 mid: 3D", (594, 949, 1573, 1998), 1.95),
    ("tri3d-rig.png", "rig", (272, 56, 1227, 805), 1.50),
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

    # The 3D tiles and panel b must be in the SAME identity palette; both come from
    # the one driver run that recorded this. Report it rather than assert it -- the
    # panel's job is not to gate the build, but a silent mismatch is what shipped once.
    pal = (j.get("identityPalette") or {}).get("identities") or []
    print("  identity palette (from fig1.json): "
          + ", ".join(f"{d['name']} {d['color']}" for d in pal))

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
    for ax, (name_tpl, badge, crop, aspect) in zip(axes, TILES):
        name = name_tpl.format(frame=j["frame"])
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
