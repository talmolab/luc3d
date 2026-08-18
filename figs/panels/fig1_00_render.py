#!/usr/bin/env python3
"""
Fig 1a -- BOTH rigs, each rendered from its own session's data.

TWO TILES SINCE 2026-08-17 (Eric): the SLAP-2M cage render, which had this panel
to itself, now sits beside the same render for Mouse-Dyad-10M -- the corpus the tracking
and identity figures are measured on -- so the reader meets both rigs at once. The
tiles print at the SAME HEIGHT and carry their corpus name in-image, so no panel
letter moves and nothing else in Fig 1 is renumbered.

NOT TO A COMMON SCALE, and the caption says so rather than implying it. Both are
orthographic, but the two scenes have different vertical extents (SLAP-2M's ortho
span is 1.34 m, Mouse-Dyad-10M's 1.55 m -- set by cameras 1.35 m above a 0.65 m arena),
so equal printed HEIGHT is what makes them read as a pair; equal millimetres per
point would make the Mouse-Dyad-10M tile taller than the row allows. The metric anchor is
in the caption instead (Mouse-Dyad-10M's 650 mm arena).

LEFT TILE. figs/blender-images/renders/cage_two_mice.png -- a Blender
(Cycles) render produced by figs/blender-images/cage_scene.py from REAL session
data: the cage corners (aligned_cage_points3d.h5), the two animals' tracked 3D
poses (aligned_points3d.h5) and the real 8-camera rig from calibration.toml +
alignment.toml of SLAP-2M session 2022-10-07/10072022180149. Nothing is
hand-posed -- camera positions, cage geometry and both skeletons are the
session's own calibration and tracked poses, placed by the script. Regenerate
with (from figs/blender-images/):

    bpyenv/bin/python cage_scene.py            # ~1 min on the A40, Cycles/OptiX

Added on Eric's request 2026-08-16 ("it looks really nice, would be a great
thing to add first there") as the figure's opening panel; the previous a-d
(pipeline, tracking, reconstruction, tool table) moved down one letter to b-e.

CROP. The render is 2000x1500 with a lot of empty backdrop: the content --
every camera body, the cage and its floor shadow -- spans x 594-1537,
y 0-1427 px (measured: pixels darker than the backdrop gradient by > 0.02).
The crop below keeps all of it with ~70 px of margin at left/right/bottom and
keeps y = 0, because the camera stalks run off the top of the frame by design
(they hang from a ceiling above the image). Verified against the measured
content box, so no camera and no part of the cage shadow is cut.

RIGHT TILE. figs/blender-images/renders/bmimica_arena.png -- the same Blender
scene code (blender-images/bmimica_scene.py imports cage_scene.py wholesale:
materials, lights, ortho camera, camera bodies, support rods, ball-and-stick
animals) on Mouse-Dyad-10M session 20250827_152238. The five camera bodies are the REAL
5-camera calibration, brought into the floor-aligned 3D frame by the alignment
fig5_views.py already fitted and deposited (98.3 % inliers, 1.32 mm residual);
the two animals are that session's tracked 3D at one frame -- since 2026-08-17 a
MUTUAL UPRIGHT DISPLAY, both animals rearing with their noses converging, chosen
by fig1_bmimica_scene.py's stated rule (Eric: "a frame where it is more clear
what the mice are doing"). NO CAGE GEOMETRY IS MEASURED FOR THIS CORPUS, so the
volume is a CUBE on the animals' measured movement FOOTPRINT: 650 mm square,
from the 0.1-99.9 percentile x/y span squared up, extruded by its own side.
It is not an enclosure and the caption must not call it a cage. It was drawn at
the animals' 147 mm vertical extent until Eric asked for "4 or 5 times taller"
-- the reasoning, and what the real arena's clear acrylic walls do and do not
license, is in fig1_bmimica_scene.py's docstring. Numbers deposited in
out/fig1_bmimica_scene.json.

CROPS are measured off the pixels of each render (content = strong luminance
gradient or non-grey), not guessed: SLAP-2M x 594-1537, Mouse-Dyad-10M x 1-1268 (the
cube nearly fills its frame's width) with content reaching y 1999. Both keep
y = 0, because the camera stalks run off the top of frame by design in both
scenes.

SPAN. Both crops are content-PORTRAIT (h/w 1.34 and 1.58): the cameras hang high
above the arena, so trimming the backdrop cannot make either landscape without
cutting a camera. Two tiles side by side therefore need the width of a
two-thirds span (117.3 mm) to print at a usable height; at span="third" the pair
would be ~28 mm tall each. Tile widths are set by their own aspect ratios so the
HEIGHTS match (that is the pairing), which puts the panel at ~84 mm of image.
Fig 1 runs over the 200 mm soft ceiling with any usable size of this panel; the
overrun is taken here, not out of the other panels.

    python3 figs/panels/fig1_00_render.py
"""
import sys
from pathlib import Path

import matplotlib as mpl
import matplotlib.image as mpimg
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import INK, SPAN, mm, save, use  # noqa: E402

RENDERS = Path(__file__).resolve().parent.parent / "blender-images" / "renders"

#: The Mouse-Dyad-10M render, whichever name the scene script wrote. TWO NAMES ON PURPOSE:
#: `bmimica_scene.py` was being reframed in a parallel session while this panel was
#: built, and the two candidate outputs differ in framing (hence the measured crop
#: below rather than a recorded one). First existing wins; add to the front of the
#: list, do not reorder silently.
BMIMICA_CANDIDATES = ["bmimica_arena.png", "bmimica_rig.png"]

#: (label, render, crop) per tile, left to right. The SLAP-2M crop is in SOURCE
#: pixels (x0, y0, x1, y1) of its 2000x1500 render, RECORDED because that render is
#: approved and frozen; the Mouse-Dyad-10M crop is None, i.e. MEASURED off the pixels at
#: build time by `content_crop` -- so a reframed Mouse-Dyad-10M render cannot silently
#: cut a camera or leave a band of backdrop.
TILES = [
    ("SLAP-2M", RENDERS / "cage_two_mice.png", (520, 0, 1610, 1465)),
    ("Mouse-Dyad-10M", None, None),
]

#: px of backdrop kept around the measured content box, and the mask thresholds.
#: Content = a strong luminance step (the ink edges, the camera bodies' silhouettes)
#: or a non-grey pixel (blue camera bodies, the animals). Both renders' backdrops are
#: a smooth grey gradient whose own gradient magnitude is ~0.003, two orders below
#: GRAD_TH, so the mask is not close to a tie; columns/rows need >3 mask pixels so
#: denoiser speckle cannot define the box.
CROP_PAD = 40
GRAD_TH, SAT_TH, MIN_HITS = 0.06, 0.05, 3


def content_crop(a, pad=CROP_PAD):
    """(x0, y0, x1, y1) around everything that is not backdrop.

    y0 is forced to 0: the camera support rods run off the TOP of frame by design in
    both scenes, so the content box's top edge is the frame's, and padding above it
    would only add whitespace."""
    import numpy as np
    L = a[:, :, :3].mean(2)
    g = np.zeros_like(L)
    g[:-1, :] += np.abs(np.diff(L, axis=0))
    g[:, :-1] += np.abs(np.diff(L, axis=1))
    m = (g > GRAD_TH) | ((a[:, :, :3].max(2) - a[:, :, :3].min(2)) > SAT_TH)
    xs = np.where(m.sum(0) > MIN_HITS)[0]
    ys = np.where(m.sum(1) > MIN_HITS)[0]
    if not len(xs) or not len(ys):
        sys.exit("content_crop found no content — is the render empty?")
    h, w = L.shape
    return (max(0, int(xs.min()) - pad), 0,
            min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad))


#: mm between the two tiles -- narrower than the 4 mm page gutter, because these
#: are two views of one thing rather than two panels.
TILE_GAP = 3.0

#: Corpus labels: INK, bold, centred UNDER each tile. Bold, not semibold: the house
#: font (Liberation Sans) has no semibold face and matplotlib falls back to 700 with
#: a findfont warning.
#:
#: MOVED OUT of the images and enlarged 7 -> 9 pt on 2026-08-17, when the
#: three-line sub-caption came off (Eric: "no caption necessary, if anything right
#: under it in big bold letters on the left it says SLAP-2M and on the right it says
#: BMimica-12M"). THE QUOTE IS VERBATIM AND THE NAME IN IT IS NOT THE CURRENT ONE: the
#: right-hand tile was called BMimica-12M for about twenty minutes, then BMimica-10M
#: (the corpus's frame count, 10,084,734), and is now Mouse-Dyad-10M. The tile takes its
#: name from TILES above; `src.style.CORPUS_NAMES` records the aliases. Do not "correct"
#: the quote to match the label.
#:
#: Everything the caption carried -- that the tiles print at one height rather than one
#: scale, and that Mouse-Dyad-10M's cube is the animals' own movement footprint and NOT
#: an enclosure -- now has to live in the figure legend, which is where
#: FIGURE-LEGENDS.md keeps it.
LABEL_PT = 9.0



#: Height of the strip under the images that holds the two labels, mm: a 9 pt line
#: (3.2 mm) plus its descent and a gap off the image edges.
#:
#: The labels are FIGURE text placed in this reserved strip (a `rect` handed to the
#: layout engine), NOT axes xlabels, because an xlabel here cannot be kept on the
#: page: both axes hold an `imshow`, so their aspect is FIXED, and constrained
#: layout spends any extra figure height on centring the row rather than on the
#: label. Measured on the old three-line caption: raising the reserve from 12.0 to
#: 16.5 mm (+7.1 pt of page) moved its overflow only 3.5 -> 2.4 pt, because the text
#: fell with the page. Reserving the strip fixes the labels' distance from the
#: bottom edge whatever the renders' aspect ratios do.
LABEL_STRIP_MM = 5.5
#: pt of clear space under the labels' baseline box
LABEL_BOTTOM_PT = 1.5


def main():
    use()
    imgs = []
    for label, path, crop in TILES:
        if path is None:                       # the Mouse-Dyad-10M tile, see CANDIDATES
            hits = [RENDERS / n for n in BMIMICA_CANDIDATES
                    if (RENDERS / n).exists()]
            if not hits:
                sys.exit(f"no Mouse-Dyad-10M render in {RENDERS} "
                         f"({' or '.join(BMIMICA_CANDIDATES)}) — run "
                         f"blender-images/bmimica_scene.py")
            path = hits[0]
        if not path.exists():
            sys.exit(f"missing {path} — run blender-images/cage_scene.py")
        a = mpimg.imread(path)
        x0, y0, x1, y1 = crop if crop else content_crop(a)
        print(f"  {label}: {path.name} crop ({x0}, {y0}, {x1}, {y1})")
        imgs.append((label, a[y0:y1, x0:x1]))

    w = SPAN["two-thirds"]
    # equal-height tiles: widths in proportion to each crop's aspect ratio, so
    # the row's height is set once and both images fill their box exactly
    aspects = [im.shape[1] / im.shape[0] for _, im in imgs]
    img_h = (w - TILE_GAP) / sum(aspects)
    h = img_h + LABEL_STRIP_MM

    fig, axes = plt.subplots(
        1, len(imgs), figsize=(mm(w), mm(h)), layout="constrained",
        gridspec_kw={"width_ratios": aspects})
    strip = LABEL_STRIP_MM / h                 # the reserved strip, figure fraction
    fig.get_layout_engine().set(w_pad=0.004, h_pad=0.004, wspace=TILE_GAP / w,
                                rect=(0.0, strip, 1.0, 1.0 - strip))
    for ax, (_, im) in zip(axes, imgs):
        ax.imshow(im)
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
    # the two corpus labels, centred under their own tile. Drawn AFTER a draw pass
    # so each tile's finished x-extent is known -- constrained layout only settles
    # the axes positions at draw time, and these are figure text, not axes text.
    fig.canvas.draw()
    y = mm(LABEL_STRIP_MM) * 72.0 - LABEL_PT - LABEL_BOTTOM_PT      # pt from bottom
    for ax, (label, _) in zip(axes, imgs):
        p = ax.get_position()
        fig.text((p.x0 + p.x1) / 2, (y / 72.0) / mm(h), label, color=INK,
                 fontsize=LABEL_PT, fontweight="bold", ha="center", va="baseline")
    save(fig, 1, "a", "render")


if __name__ == "__main__":
    main()
