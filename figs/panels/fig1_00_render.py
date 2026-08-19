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

LEFT TILE. figs/blender-images/renders/fig1_renders/slap2m-4mice_f06020.png --
a Blender (Cycles) render produced by figs/blender-images/cage_scene.py from
REAL session data: the cage corners (aligned_cage_points3d.h5), the FOUR
animals' tracked 3D poses (aligned_points3d.h5) and the real 8-camera rig from
calibration.toml + alignment.toml of SLAP-2M session 2022-10-07/10072022145420
at frame 6020. Four animals, not two, since 2026-08-19 (Eric: "I want 4 animals
in there instead because I think it is a better representation of the data";
the 2-animal slap2m_f00398.png it replaces stays in fig1_renders/). Nothing is
hand-posed -- camera positions, cage geometry and all skeletons are the
session's own calibration and tracked poses, placed by the script.

THE FRAME IS BORROWED FROM FIG 6a AND MUST STAY IN STEP WITH IT. 6020 is the
original-recording frame Fig 6a's camera-view inset shows (its prepared session
starts at 6000 and the app exports that session's frame 20), so this render, Fig
6a's 4-animal cage tile and Fig 6a's six camera views are all one instant. The
colours are the renders' own tab10 in H5 TRACK ORDER, and the APP EXPORT was
recoloured to match them rather than the reverse -- see
blender-images/enrichment_scene.py TRACK_TO_IDENTITY and figs/fig6_app.mjs
PALETTE. Change the frame there, not here. Regenerate with (from
figs/blender-images/):

    bpyenv/bin/python cage_scene.py \
        --session /root/talmolab-smb/eric/slap_2m/2022-10-07/10072022145420 \
        --frame 6020 --clamp-tail --open-front --res 1280 960 --samples 256 \
        --out renders/fig1_renders/slap2m-4mice_f06020.png

RIGHT TILE, REGENERATION. `--ortho 2.15` IS NOT OPTIONAL AND IS NOT THE DEFAULT.
bmimica_scene.py fits its own ortho to the content, which at 1280x960 comes out at
1.547 m and frames the arena far tighter than this panel wants: the cube then runs
off the bottom of the tile. 2.15 m is the value that reproduces this panel's
framing, recovered by measuring the content box (548 px wide against the 547 px the
shipping tile had) after an accidental re-render at the fitted value lost it. The
scene JSON must be at frame 55701; `figs/fig1_bmimica_scene.py --frame 55701`
regenerates it, but needs cv2, which the figs venv lacks.

    bpyenv/bin/python bmimica_scene.py --res 1280 960 --ortho 2.15 \
        --out renders/fig1_renders/mouse-dyad_f55701.png

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

RIGHT TILE. figs/blender-images/renders/fig1_renders/mouse-dyad_f55701.png --
the same Blender scene code (blender-images/bmimica_scene.py imports cage_scene.py wholesale:
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

RE-RENDERED AND RE-SPANNED 2026-08-19 (Eric). The portrait crops of the
cage_two_mice / bmimica_arena stills at two-thirds span left a third of the
page white beside the figure's opening panel. Both tiles are now the LANDSCAPE
1280x960 video-frame framings named above (same scene scripts, the frame index
in each file name), cropped 12% off each side and printed across the FULL
180 mm span.
That puts the pair at ~87 mm of image height -- about what the portrait pair
had -- while filling the page width. The paragraphs above describe the scenes'
data provenance, which is unchanged; the crop/span rationale they carry is
superseded by this note and the comments at TILES and `w` below. Fig 1 still
runs over the 200 mm soft ceiling; the overrun is taken here, not out of the
other panels.

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

#: (label, render, crop) per tile, left to right. BOTH RENDERS AND CROPS RECORDED
#: since 2026-08-19 (Eric: use the fig1_renders pair and fill the page width; the
#: portrait cage-still/arena-still pair at two-thirds span left too much
#: whitespace). Both new renders are 1280x960 LANDSCAPE video-frame framings; the
#: crop is 12% off each side (Eric: "crop off 10-20% on each side just to fill out
#: the page"), verified against the measured content boxes -- content spans
#: x 385-984 (SLAP-2M, 4-mice render) and x 382-929 (Mouse-Dyad-10M), so the kept
#: x 154-1126 clears every camera by >140 px. Full height is kept: the camera
#: stalks run off the top of frame by design, and the cage shadow reaches the
#: bottom. `content_crop` below is the tool that measured them; rerun it before
#: changing either crop.
TILES = [
    ("SLAP-2M", RENDERS / "fig1_renders" / "slap2m-4mice_f06020.png", (154, 0, 1126, 960)),
    ("Mouse-Dyad-10M", RENDERS / "fig1_renders" / "mouse-dyad_f55701.png", (154, 0, 1126, 960)),
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
        if not path.exists():
            sys.exit(f"missing {path} — see blender-images/FIGURE-NOTES.md "
                     f"for the scene scripts")
        a = mpimg.imread(path)
        x0, y0, x1, y1 = crop if crop else content_crop(a)
        print(f"  {label}: {path.name} crop ({x0}, {y0}, {x1}, {y1})")
        imgs.append((label, a[y0:y1, x0:x1]))

    # FULL SPAN since 2026-08-19 (Eric): at two-thirds the row left a third of the
    # page white beside the figure's opening panel. The landscape tiles cropped 12%
    # per side put the pair at ~87 mm of image height across the whole 180 mm --
    # about the height the old portrait pair had at two-thirds span.
    w = SPAN["full"]
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
