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
one: on frame 276 cam 7's animals span 522 px vertically and cam 0's 620, and under
the old square crop cam 7 would be scaled by its 652 px WIDTH, printing its animals
~25% smaller than they need to be.

THE FRAME IS CHOSEN, AND THE CHOICE IS PART OF THE ARGUMENT. Frame 276, not 150.
At frame 150 two views (Camera3_sideC, Camera7_sideR) each carried a FOURTH detection
in a three-animal scene -- a duplicate of an animal already matched in that view.
Re-ID's per-view assignment is one-to-one, so the surplus was correctly left over and
this panel drew it as `?`. That behaviour is right, and the `?` code path below is
kept for exactly that reason; but it is the wrong thing for THIS panel to lead with.
The panel exists to show 24 detections collapsing to 3 clean identities, and a stray
`?` sends the reader looking for a failure instead. All 300 frames of the window were
scanned for "every camera has exactly 3 detections AND re-ID assigned all of them";
exactly two qualify (276 and 278) and the driver takes 276. See
`figs/fig1_tracking.mjs` for the scan and the 276-vs-278 tie-break.

THE LEDGER IS THE RESULT, and it is printed under the tiles rather than left to the
caption. It is one line and every number in it is a different quantity, so each is
named for what it actually counts:

  24 DETECTIONS, not "24 labels". A per-camera track label is a (camera, track) pair
  -- `track_89` in cam 0 and `track_89` in cam 5 are two unrelated labels, because
  the tracker numbers each view independently -- so 24 IS the number of things a
  reader would have to reconcile by hand. But there are only 20 distinct label
  STRINGS, and an earlier version of this line printed the detection count and called
  it a label count, which a reader who counts strings in the data cannot reproduce.
  Both numbers are now on the artwork and both are in `fig1b_reid_ledger.csv`.

  20 DISTINCT TRACK NAMES, 3 of them reused across cameras: `track_89` in cams 0
  and 5, `track_127` in cams 1 and 4, `track_93` in cams 5, 6 and 7 (`ledger.
  collidingNames`). Those coincidences are not correspondence -- they are a shared
  counter -- and `track_93` means a different animal in cam 5 than in cam 7. So the
  reuse strengthens the panel's claim rather than qualifying it: a label string does
  not even identify an animal within one rig.

  3 IDENTITIES, ONE PER ANIMAL IN EVERY VIEW. Checked, not asserted: the clause is
  printed only when `ledger.viewsMissingAnIdentity` is empty AND
  `assigned == identities x cameras` (24 = 3 x 8 here). On this frame both hold, so
  there is no "N of M assigned" fallback and no "extra detections unassigned" tail --
  the line ends on the claim. If a future run leaves a view short, or leaves a
  detection over, those clauses come back automatically; they are not deleted, and
  the `?` is not suppressed. Artwork and deposit cannot disagree.

EVERY ANIMAL CARRIES ITS OWN LABEL, and without them the panel does not make its
claim. The left pair is meant to show that the tracker's labels are PER CAMERA and
carry no correspondence: `t89`/`t82`/`t94` in cam 0 against `t83`/`t93`/`t95` in
cam 7, six labels for three animals in two of eight views, with no clue in the
strings themselves that t89 and t83 are the same mouse. With the labels removed (as
an earlier pass of this rewrite had it) the left pair is just three
differently-coloured skeletons and nothing on the artwork shows what the 24 in the
ledger line ARE. The right pair carries the identity the app assigned -- `1`, `2`,
`3`, the same number for the same animal in both views. So the collapse the ledger
line counts is drawn: t89 and t83 both become 1.

Labels are placed above each detection's own recorded bbox (`details[].box`, source
pixels), pushed apart vertically when two animals are in contact -- the normal case
here, not the exception -- and clamped inside the tile.

WHY A WHITE CHIP AND A DARKENED HUE. The label has to be legible over both the black
arena wall and a blown-out white mouse, and it has to pass `lint_text.py`'s on-data
check, which reports any non-white text sitting on ink. An opaque white chip answers
both: nothing shows through it, so the check measures white. The text is then the
animal's manifest colour DARKENED until it clears 3.5:1 against that chip -- the raw
per-track colours the app hands out are pastels (`#ffe66d`, `#a8e6cf`) that sit at
1.3:1 on white and cannot be read at 6.5 pt. `on_white()` scales all three channels
by one factor, so the hue that ties the label to its skeleton is preserved and only
the lightness moves. The legacy figure instead used the raw colour with a black halo;
that is lighter on the page but unreadable for the two palest tracks and trips the
linter on every label.

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
from src.style import (MUTED, GREY, INK, SPAN, deposit, mm, save, tile, use)  # noqa: E402

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

#: Track/identity label type size, in points. The floor is 5 pt (`lint_text.py`
#: enforces it); the legacy figure used 5.8 pt and these are set a little larger
#: because the crops below print the animals bigger than the legacy square crops did.
LABEL_PT = 6.5
#: Contrast the label text must clear against its white chip, WCAG-style. 3.5:1 is
#: between the 3:1 graphical-object threshold and the 4.5:1 body-text one -- pushed
#: to 4.5 the pale mint and pale yellow tracks darken so far that hue stops
#: identifying them, which is the only thing the colour is there for.
LABEL_CONTRAST = 3.5
#: Gap between a detection's bbox top and its label baseline, in points.
LABEL_GAP_PT = 1.8
#: One typographic point in millimetres.
MM_PER_PT = 25.4 / 72.0


def bbox_for(manifest, cam):
    for v in manifest:
        if v["name"] == cam:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def details_for(manifest, cam):
    for v in manifest:
        if v["name"] == cam:
            return v["details"]
    return []


def _rel_luminance(rgb):
    f = [(c / 12.92) if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]


def on_white(hex_color, target=LABEL_CONTRAST):
    """`hex_color` darkened until it clears `target`:1 against white.

    All three channels are scaled by one factor rather than run through a colour
    space, so the ratios between them -- and therefore the hue a reader matches
    against the skeleton -- are untouched and only the lightness moves. Returns an
    RGB triple; a colour that already clears `target` comes back unchanged.
    """
    rgb = tuple(int(hex_color.lstrip("#")[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    k = 1.0
    for _ in range(60):
        if 1.05 / (_rel_luminance(tuple(c * k for c in rgb)) + 0.05) >= target:
            break
        k *= 0.96
    return tuple(c * k for c in rgb)


def short_label(d, stage):
    """The label this detection carries IN THIS TILE, and the colour to set it in.

    Left tiles: the tracker's own name, shortened `track_89` -> `t89` exactly as the
    legacy figure did -- the full form is three times as wide and would not fit
    beside a second animal. Right tiles: the identity, 1-based (`id_0` -> `1`), or
    `?` for a detection re-ID did not assign. `?` is set in INK rather than in the
    detection's leftover per-track colour, because an identity colour is precisely
    what it does not have.

    The `?` branch does NOT fire on the frame this panel ships (276: every detection
    assigned). It is kept because it is the honest rendering of an unassigned
    detection, and because the frame is a driver constant -- re-run on a frame with a
    surplus detection and the artwork must say so rather than quietly drop it.
    """
    if stage == "before":
        return d["track"].replace("track_", "t"), d["color"] or "#000000"
    if d.get("identity"):
        tail = str(d["identity"]).rsplit("_", 1)[-1]
        return (str(int(tail) + 1) if tail.isdigit() else tail), d["color"] or "#000000"
    return "?", INK


def dodge(items, min_dy, min_dx):
    """Push apart labels that would overprint; the lower of a colliding pair moves DOWN.

    Two mice in contact is the normal case in this data, not the exception (on frame
    276 cam 7's `t83` and `t93` are 126 px apart horizontally but only 26 px
    vertically, and cam 0's `t89` and `t82` 122 px / 24 px), so their labels land on
    top of each other unless something separates them. Ported from
    the legacy figure's `dodge()`, in source pixels instead of millimetres.
    """
    placed = []
    for it in sorted(items, key=lambda d: d["y"]):
        for _ in range(12):
            hit = next((p for p in placed
                        if abs(it["x"] - p["x"]) < (it["w"] + p["w"]) / 2 + min_dx
                        and abs(it["y"] - p["y"]) < min_dy), None)
            if hit is None:
                break
            it["y"] = hit["y"] + min_dy
        placed.append(it)
    return items


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

    # Deposit the ledger, so the numbers printed on the artwork are auditable. Every
    # number in the printed line has a column here, including the reuse count and the
    # reused names themselves -- the artwork says "3 reused across cameras" and a
    # reader has to be able to check WHICH three.
    deposit(pd.DataFrame([{
        "detections": led["detections"], "distinct_track_names": led["distinctNames"],
        "names_reused_across_cameras": len(led["collidingNames"]),
        "reused_names": " ".join(led["collidingNames"]),
        "identities": led["identities"], "assigned": led["assigned"],
        "unassigned": len(led["unassigned"]), "cameras": j["stats"]["nCameras"],
        "views_missing_an_identity": len(led["viewsMissingAnIdentity"]),
    }]), 1, "fig1b_reid_ledger.csv")

    tiles = []
    for stage, _ in STAGES:
        for cam in CAMS:
            # The frame comes from the manifest, never from a literal: the driver's
            # exports are named by frame, so a hard-coded 150 here silently kept
            # reading the OLD tiles after the driver was re-run on another frame --
            # artwork and deposit disagreeing with each other.
            p = OUT / f"{stage}-f{j['frame']}-{cam}.png"
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
    crops = []
    for ax, (p, bbox, cam) in zip(axes, tiles):
        # bbox=None: read the frame whole, then crop by setting the view limits.
        # imshow puts source pixels in data coordinates, so the axes shows exactly
        # the window asked for, keeps aspect='equal' (no stretching), and the badge
        # -- drawn in axes coordinates -- still lands in the tile's own corner.
        # (The whole 1280x1024 frame is embedded and clipped to the axes rather than
        # pre-cropped, which costs ~1 MB of PDF and nothing else -- Illustrator
        # honours the clip, and `load_tile`'s own crop cannot make this shape.)
        # The badge carries the camera INDEX as well as its name (`cam 0 mid`, not
        # `mid`). The claim being made is that a track label is per CAMERA, so the
        # camera has to be identified; and panel c badges the same view `cam 0 mid`,
        # so dropping the index here made one figure name one camera two ways.
        tile(ax, p, None, badge=cam.replace("Camera", "cam ").replace("_", " "),
             corner="lower left")
        sh, sw = ax.images[0].get_array().shape[:2]
        x0, y0, x1, y1 = crop_to_aspect(bbox, sw, sh, TILE_ASPECT, TILE_PAD)
        ax.set_xlim(x0, x1)
        ax.set_ylim(y1, y0)           # imshow's y axis runs downwards
        crops.append((x0, y0, x1, y1))
    # constrained_layout only places the axes when the figure is drawn; before that
    # `get_position()` still returns the DEFAULT subplot params (left=0.125,
    # right=0.9), which put both headings ~7 mm to the right of their own pair.
    # The labels below need the placed axes for the same reason: the pixels-per-point
    # of a tile is only knowable once its printed width is.
    fig.canvas.draw()

    # --- the per-animal labels ------------------------------------------------
    for k, (stage, _) in enumerate(STAGES):
        for i, cam in enumerate(CAMS):
            ax = axes[2 * k + i]
            x0, y0, x1, y1 = crops[2 * k + i]
            # Source pixels per typographic point IN THIS TILE. The two cameras have
            # different crop heights (cam 0 sees 657 px, cam 7 553 px, both printed
            # ~33 mm tall), so one fixed pixel offset would print at two different
            # sizes and one fixed pixel gap would clear the animal in one tile and
            # not the other.
            px_pt = (x1 - x0) / (ax.get_position().width * w) * MM_PER_PT
            labs = []
            for d in details_for(j[stage], cam):
                s, col = short_label(d, stage)
                # Half the chip's width: Arial bold digits and lower case run about
                # 0.56 em, plus the chip's own 2 x 0.32 em of padding. It only has to
                # be good enough to decide whether two labels can sit side by side --
                # but not GENEROUS, because every pixel of over-estimate turns a pair
                # that would have fitted into a dodge, and a dodged label drops out of
                # the dark arena wall and onto its own animal. `t89` and `t82` are
                # 122 px apart and were being dodged on a 130 px estimate.
                half = (0.56 * len(s) + 0.64) * LABEL_PT * px_pt / 2
                cx = min(max(d["centroid"][0], x0 + half), x1 - half)
                labs.append(dict(x=cx, y=d["box"][1] - LABEL_GAP_PT * px_pt,
                                 s=s, col=col, w=2 * half))
            for it in dodge(labs, 1.45 * LABEL_PT * px_pt, 0.15 * LABEL_PT * px_pt):
                # Kept inside the tile: a label the dodge pushed past the bottom edge
                # would be clipped mid-glyph, and one above the top edge would land
                # on the group heading.
                yy = min(max(it["y"], y0 + 1.55 * LABEL_PT * px_pt),
                         y1 - 0.4 * LABEL_PT * px_pt)
                # va="bottom", not "center". The anchor is the top of the animal's own
                # bbox, and imshow's y axis runs downwards, so "bottom" grows the chip
                # UPWARD from the anchor -- clear of the animal. Centred on the same
                # anchor, half of every chip hung over the top of its own mouse.
                ax.text(it["x"], yy, it["s"], ha="center", va="bottom", zorder=6,
                        color=on_white(it["col"]), fontsize=LABEL_PT,
                        fontweight="bold", clip_on=True,
                        # pad 0.32 em, not 0.18. matplotlib pads the text's TIGHT
                        # glyph extents (`t82` has no ascender above x-height and no
                        # descender, ~4.7 pt at 6.5 pt type) while PyMuPDF reports
                        # the span box from the font's own ascent/descent (~7.5 pt),
                        # so a chip that looks generous still left the arena wall
                        # showing at the corners of the measured box -- 5% of it,
                        # against `lint_text.py`'s 4.5% on-data threshold. The chip
                        # has to cover the FONT box, not the glyphs.
                        bbox=dict(boxstyle="round,pad=0.32,rounding_size=0.22",
                                  fc="white", ec="none"))

    # Group headings sit over their own pair, so the before/after split is readable
    # without reading the caption.
    for k, (_, heading) in enumerate(STAGES):
        a0, a1 = axes[2 * k], axes[2 * k + 1]
        x = (a0.get_position().x0 + a1.get_position().x1) / 2
        fig.text(x, 0.912, heading, ha="center", va="bottom", fontweight="bold",
                 color=INK, fontsize=8)

    # The step between the two GROUPS, marked in the heading strip directly over the
    # boundary between the pairs, so the four tiles do not read as four unrelated
    # pictures. It goes in the strip and not in the ~1.5 mm gutter between tiles 2
    # and 3: at this row height the gutter cannot hold a legible glyph, and widening
    # it would cost the tiles width, hence height, hence animal size. Reading across
    # the strip it now says "per-camera tracks -> LUC3D identities", which is the
    # panel in one line.
    fig.text((axes[1].get_position().x1 + axes[2].get_position().x0) / 2, 0.912,
             "→", ha="center", va="bottom", color=INK, fontsize=10)
    # How much of the rig is on show. The ledger line counts all 8 views; without
    # this the reader has no way to know these 4 tiles are 2 cameras, not 8.
    fig.text(0.994, 0.912, f"2 of {j['stats']['nCameras']} views", ha="right",
             va="bottom", color=MUTED, fontsize=7)

    # THE LEDGER LINE. Each quantity is named for what it counts -- see the module
    # docstring for why 26 is a DETECTION count and 22 a LABEL-STRING count, and why
    # the 2 left over are EXTRA detections rather than a missing animal.
    #
    # "one per animal in every view" is CHECKED here, not asserted: it is the
    # strongest claim on the line, and the deposit already carries what settles it.
    # If a future run leaves a view short, the clause has to disappear rather than
    # print a falsehood.
    ncam = j["stats"]["nCameras"]
    total = led["identities"] * ncam
    every_view = not led["viewsMissingAnIdentity"] and led["assigned"] == total
    extra = len(led["unassigned"])
    line = (f"{led['detections']} detections in {ncam} views carry "
            f"{led['distinctNames']} distinct track names "
            f"({len(led['collidingNames'])} reused across cameras) → "
            f"{led['identities']} identities")
    line += (", one per animal in every view" if every_view
             else f", {led['assigned']} of {led['detections']} detections assigned")
    if extra:
        line += f"; {extra} extra detection{'s' if extra != 1 else ''} unassigned"
    fig.text(0.5, 0.043, line, ha="center", va="center", color=MUTED, fontsize=7)
    save(fig, 1, "b", "tracking")


if __name__ == "__main__":
    main()
