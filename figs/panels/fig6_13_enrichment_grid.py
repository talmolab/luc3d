#!/usr/bin/env python3
"""
Fig 6a -- the SLAP-2M difficulty landscape: enrichment x animal count, as renders.

Ten Blender tiles — blender-images/renders/enrich_a1_o0.png and its nine
siblings, rendered by blender-images/enrichment_scene.py — one per (animals,
obstacle_rating) condition the corpus actually contains at the placed cells:
# OF ANIMALS ON X (1-4), ENVIRONMENTAL ENRICHMENT ON Y (rows 0, 2, 5 bottom to
top). The upper-right cells are ABSENT, not empty-plotted: the dataset has no
3-4-animal enriched sessions (its support is 14 of 24 combos; (3,4) exists but
is not placed, matching Eric's original draft cage_renders/difficulty.png whose
staircase silhouette IS the coverage statement). Each tile is a REAL session
recorded under that condition -- cage corners, tracked poses and frame choice
are the session's own (NaN-free, low bone-warp, animals separated); only the
green enrichment objects are synthetic props (no session carries triangulated
object points), arranged per the notebook anchors and placed clear of the
animals. Provenance: blender-images/FIGURE-NOTES.md, section enrichment_scene.py.

Replaces the old panels a-d (rig render, six-camera frame, recovery surface,
animal-count control) at the top of the figure on Eric's instruction 2026-08-19;
the surface and animal-count PLOTS move down the figure (new c, d), the rig
render comes off it (its script still deposits).

THE SIX-CAMERA FRAME (old panel b) LIVES ON INSIDE THIS PANEL (Eric, same day:
"cram what used to be b in that empty space above ... like it is expanded from
one of the cage visualizations, with dashed lines from that cage to the videos").
The staircase's empty upper-right holds a bordered inset of the six proofread
camera views -- figs/out/fig6-view-f<frame>-*.png with figs/out/fig6-app.json's
per-view bboxes and 50 mm scale bars, exactly fig6_05_cameras.py's tiles at the
same ~26 mm size.

THE CALLOUT IS EXACT, IN SESSION, FRAME AND COLOUR (Eric, 2026-08-19: "we should
use the same frame from the data that we used for the render too ... so people
dont get confused"). The manifest's sessionRel is session-slap-10072022145420,
the session the (4 animals, enrichment 0) tile renders; that prepared session
starts at original frame 6000 and the app exports its frame 20, so the tile is
rendered at original frame 6020 (enrichment_scene.COMBOS) -- one instant, two
displays. The app's identity palette was permuted to tab10 so each animal is the
same colour in both (fig6_app.mjs PALETTE, derived in
enrichment_scene.TRACK_TO_IDENTITY and verified at 100% per animal). The dashed
source box sits on that cage tile and the leaders run from it up to the inset.

TILES SHARE ONE CAMERA (enrichment_scene --fit cage), so they are cropped
IDENTICALLY: the union of the ten content boxes, measured off the pixels at
build time -- a re-rendered tile cannot silently shift inside its cell or lose
a wall. Grid geometry is hand-placed like fig6_05_cameras.py: equal-aspect
tiles in a fixed lattice are fully determined by the panel box, and a layout
engine would only shrink them to fit decorations.

    python3 figs/panels/fig6_13_enrichment_grid.py
"""
import json
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT  # noqa: E402
from src.style import INK, SPAN, mm, save, use  # noqa: E402

RENDERS = Path(__file__).resolve().parent.parent / "blender-images" / "renders"

#: the inset's camera views -- fig6_05_cameras.py's constants, verbatim
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
TILE_AR = 1.25
HALO = dict(facecolor="#000000", alpha=0.45, edgecolor="none", pad=0.9)
#: the cage tile the views expand from: fig6-app.json sessionRel is
#: session-slap-10072022145420 = enrichment_scene.COMBOS[(4, 0)]
SOURCE_CELL = (0, 4)


def crop_to(img, bbox, aspect, pad=0.06):
    """Crop `img` to `bbox` (source px), widened to exactly `aspect`.

    Mirrors `fig6_05_cameras.crop_to`; kept local per panel, as there."""
    Him, Wim = img.shape[:2]
    x0, y0, x1, y1 = bbox
    m = max(x1 - x0, y1 - y0) * pad
    x0, y0, x1, y1 = x0 - m, y0 - m, x1 + m, y1 + m
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    w, h = x1 - x0, y1 - y0
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    s = min(1.0, Wim / w, Him / h)
    w, h = w * s, h * s
    cx = min(max(cx, w / 2.0), Wim - w / 2.0)
    cy = min(max(cy, h / 2.0), Him - h / 2.0)
    X0, Y0 = int(round(cx - w / 2.0)), int(round(cy - h / 2.0))
    return img[Y0:Y0 + int(round(h)), X0:X0 + int(round(w))]

#: y rows top-to-bottom, x columns left-to-right, and the placed cells --
#: keep in step with enrichment_grid.py (the standalone PIL preview of the
#: same figure) and enrichment_scene.COMBOS (the corpus authority).
ENRICH_ROWS = [5, 2, 0]
ANIMAL_COLS = [1, 2, 3, 4]
CELLS = {(0, a) for a in ANIMAL_COLS} | {(2, 1), (2, 2), (5, 1), (5, 2)}

W = SPAN["full"]
GUTTER_L = 8.0        # mm, row values + rotated axis title
GUTTER_B = 8.0        # mm, column values + axis title
TG = 1.6              # mm between tiles
PAD = 12              # px kept around the union content box


def content_bbox(a, tol=0.05):
    """Union-crop support: everything that differs from the white backdrop."""
    m = (1.0 - a[:, :, :3].min(2)) > tol
    ys, xs = np.where(m)
    if not len(xs):
        sys.exit("content_bbox found no content — is the render empty?")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def main():
    use()
    imgs = {}
    for (o, a) in CELLS:
        p = RENDERS / f"enrich_a{a}_o{o}.png"
        if not p.exists():
            sys.exit(f"missing {p} — run blender-images/enrichment_scene.py "
                     f"--animals {a} --objects {o}")
        imgs[o, a] = mpimg.imread(str(p))
    boxes = [content_bbox(im) for im in imgs.values()]
    x0 = max(0, min(b[0] for b in boxes) - PAD)
    y0 = max(0, min(b[1] for b in boxes) - PAD)
    x1 = max(b[2] for b in boxes) + PAD
    y1 = max(b[3] for b in boxes) + PAD
    imgs = {k: im[y0:y1, x0:x1] for k, im in imgs.items()}

    ar = (x1 - x0) / (y1 - y0)                     # shared tile aspect, w/h
    tw = (W - GUTTER_L - (len(ANIMAL_COLS) - 1) * TG) / len(ANIMAL_COLS)
    th = tw / ar
    H = len(ENRICH_ROWS) * th + (len(ENRICH_ROWS) - 1) * TG + GUTTER_B

    fig = plt.figure(figsize=(mm(W), mm(H)))
    for i, o in enumerate(ENRICH_ROWS):
        cy = H - (i + 1) * th - i * TG
        for j, a in enumerate(ANIMAL_COLS):
            if (o, a) not in imgs:
                continue
            cx = GUTTER_L + j * (tw + TG)
            ax = fig.add_axes([cx / W, cy / H, tw / W, th / H])
            ax.imshow(imgs[o, a])
            ax.set_xticks([])
            ax.set_yticks([])
            for s in ax.spines.values():
                s.set_visible(False)
        fig.text((GUTTER_L - 1.6) / W, (cy + th / 2) / H, str(o), ha="right",
                 va="center", color=INK, fontsize=7.0)
    for j, a in enumerate(ANIMAL_COLS):
        fig.text((GUTTER_L + j * (tw + TG) + tw / 2) / W, (GUTTER_B - 3.6) / H,
                 str(a), ha="center", va="center", color=INK, fontsize=7.0)
    fig.text((GUTTER_L + (W - GUTTER_L) / 2) / W, 1.2 / H, "# of animals",
             ha="center", va="center", color=INK, fontsize=7.0)
    # 2.4 mm, not 1.4: a rotated 7 pt line's span box is ~3.3 mm wide (full
    # ascender + descender), so centring it 1.4 mm from the edge clipped it
    # (lint_text.py CLIPPED 'environmental enrichment')
    fig.text(2.4 / W, (GUTTER_B + (H - GUTTER_B) / 2) / H,
             "environmental enrichment", ha="center", va="center", color=INK,
             fontsize=7.0, rotation=90)

    # ---- the six-camera inset in the staircase's empty upper-right ----
    man_p = OUT / "fig6-app.json"
    if not man_p.exists():
        sys.exit("missing figs/out/fig6-app.json — run `node figs/fig6_app.mjs`")
    app = json.loads(man_p.read_text())
    # THE FRAME COMES FROM THE MANIFEST, NEVER A LITERAL. `fig6_05_cameras.py` hard-
    # coded `fig6-view-f120-*`, and when the driver was re-run at FRAME=20 on
    # 2026-08-16 it wrote `fig6-view-f20-*` and left the f120 files behind -- so that
    # panel has been drawing frame-120 IMAGES cropped by frame-20 BBOXES ever since
    # (found 2026-08-19 while matching this inset to its cage tile; the mismatch is
    # what made the two disagree by ~100 frames). Reading the name off `frame` makes
    # a stale export impossible.
    paths = {c: OUT / f"fig6-view-f{app['frame']}-{c}.png" for c in CAMS}
    missing = [p.name for p in paths.values() if not p.exists()]
    if missing:
        sys.exit(f"missing figs/out/{missing} — run `node figs/fig6_app.mjs`")
    vboxes = {v["name"]: v["bbox"] for v in app.get("views") or []}
    per = (app.get("scale") or {}).get("perView") or {}
    L = (app.get("scale") or {}).get("L") or 50.0

    # the empty region: grid rows 5 and 2 (top two), columns for 3 and 4 animals
    bx0 = GUTTER_L + 2 * (tw + TG) + 2.2       # clear of the 1-2-animal tiles
    bx1 = W - 0.4                              # border inside the mediabox
    by0 = GUTTER_B + th + TG + 3.0             # clear of the bottom (source) row
    by1 = H - 0.2
    fig.add_artist(Rectangle((bx0 / W, by0 / H), (bx1 - bx0) / W, (by1 - by0) / H,
                             transform=fig.transFigure, fill=False, ec=INK,
                             lw=0.8, zorder=6))
    IP, CAP_MM, HEAD_MM, ITG = 1.6, 3.2, 4.2, 0.8   # inner pad, caption, heading
    itw = (bx1 - bx0 - 2 * IP - 2 * ITG) / 3
    ith = itw / TILE_AR
    block_h = 2 * ith + ITG
    # centre the tile block in the space left between heading and caption
    free = (by1 - by0) - HEAD_MM - CAP_MM - block_h
    ty_top = by1 - HEAD_MM - free / 2
    # 2.6 mm below the border, not 1.6: a 7 pt span box is ~3.3 mm tall, so at
    # 1.6 the heading's box touched the inset's top rule (lint ON DATA)
    fig.text((bx0 + IP) / W, (by1 - 2.6) / H, "One frame, six cameras",
             ha="left", va="center", color=INK, fontsize=7.0, fontweight="bold")
    for i, cam in enumerate(CAMS):
        cx = bx0 + IP + (i % 3) * (itw + ITG)
        cy = ty_top - (i // 3 + 1) * ith - (i // 3) * ITG
        ax = fig.add_axes([cx / W, cy / H, itw / W, ith / H])
        img = mpimg.imread(str(paths[cam]))
        b = vboxes.get(cam)
        if b:
            img = crop_to(img, (b["x0"], b["y0"], b["x1"], b["y1"]), TILE_AR)
        ax.imshow(img)
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        ax.text(0.05, 0.93, cam, transform=ax.transAxes, ha="left", va="top",
                color="white", fontsize=6.0, fontweight="bold", bbox=HALO)
        ppm = (per.get(cam) or {}).get("pxPerUnit")
        if ppm:
            frac = L * ppm / img.shape[1]
            x1b, yb = 0.95, 0.08
            ax.plot([x1b - frac, x1b], [yb, yb], transform=ax.transAxes,
                    color="white", lw=1.5, solid_capstyle="butt", clip_on=False,
                    zorder=5)
            ax.text(x1b - frac - 0.02, yb, f"{L:.0f} mm", transform=ax.transAxes,
                    ha="right", va="center", color="white", fontsize=5.4,
                    bbox=HALO, zorder=5)
    fig.text((bx0 + bx1) / 2 / W, (by0 + CAP_MM * 0.45) / H,
             "the 4-animal session seen by its six proofread cameras",
             ha="center", va="center", color=INK, fontsize=6.0)

    # ---- the callout: dashed box on the source cage tile, dashed leaders up ----
    so, sa = SOURCE_CELL
    si, sj = ENRICH_ROWS.index(so), ANIMAL_COLS.index(sa)
    sx0 = GUTTER_L + sj * (tw + TG)
    sy1 = H - (si + 1) * th - si * TG + th     # tile top edge
    sy0 = sy1 - th
    dash = dict(color=INK, lw=0.7, ls=(0, (3.0, 2.0)), zorder=6)
    fig.add_artist(Rectangle((sx0 / W, sy0 / H), tw / W, th / H,
                             transform=fig.transFigure, fill=False,
                             ec=INK, lw=0.7, ls=(0, (3.0, 2.0)), zorder=6))
    for (xa, ya), (xb, yb) in (((sx0, sy1), (bx0, by0)),
                               ((sx0 + tw, sy1), (bx1, by0))):
        fig.add_artist(Line2D([xa / W, xb / W], [ya / H, yb / H],
                              transform=fig.transFigure, **dash))

    save(fig, 6, "a", "enrichment_grid")


if __name__ == "__main__":
    main()
