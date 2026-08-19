#!/usr/bin/env python3
"""
Fig 6b -- one SLAP-2M frame, six cameras, with the app's overlays and a 50 mm bar.

Shows what a session actually looks like: six simultaneous views of the same
instant, each with LUC3D's pose overlay in the shared identity colours. This is the
raw material behind every number in panels c and d, and the first pass of this
rewrite dropped it entirely in favour of a mean-pose skeleton -- which says nothing
about what is IN the data.

Exported by `fig6_app.mjs` from a real session (difficulty 4, 4 animals, black
bedding), so the difficulty rating panel c stratifies on is visible here as an image.

TWO THINGS THIS PANEL LOST AND HAS NOW GOT BACK, both of which were already sitting
in `out/fig6-app.json`:

  * **The 50 mm scale bars.** Legacy burned one into every tile
    (`legacy/fig6.py:103 scale_bar()`); the restyle drew none, and for a while no
    image panel in the whole set carried a bar. This paper quotes its results in
    millimetres (4.75 mm, 7.2 mm, 64.5 mm nose-to-trunk) and six camera tiles with
    no bar give the reader no spatial referent at all. `scale.L` (= 50) and
    `scale.perView.<cam>.pxPerUnit` are the calibration-derived px-per-mm AT THE
    ANIMALS' DEPTH, measured by the app's own projection (`fig6_app.mjs
    measureScale`). A perspective image has no single scale, so this is explicitly
    the scale in the fronto-parallel plane through the animals -- which is where
    the content is. `anisotropy` (0.0001-0.0122 here) is how non-square that
    projection is; it is printed nowhere because at ~1 % it is under the bar's own
    drawing precision, but it is the number to check if these views ever get more
    oblique.

  * **The crop.** Every tile was `tile(ax, p, None)` -- the whole uncropped
    1280 x 1024 frame at ~16 mm, so a mouse was ~3 mm and most of each tile was
    black cage wall. `views[].bbox` is the app's own per-view bounding box over the
    frame's instances, so cropping to it is framing on where the animals actually
    were rather than on a guess. Widened to the TILE's aspect (not to a square, as
    `style.load_tile` does) so six tiles share one aspect and the grid has no gaps.

TILE GEOMETRY IS HAND-PLACED, not `constrained_layout`. Six tiles at a fixed aspect
in a 2 x 3 grid are fully determined by the panel box, and the layout engine's job --
fitting decorations -- is not wanted here: it shrinks the images to make room and
leaves the row 12 mm short of its own width. Badges therefore also cannot drift onto
a tile edge (they did, at 0.97 in axes coordinates on a tile this small); they sit
inside a measured inset.

SKELETON EDGES: the tiles are re-exported with the app's skeleton edge set
overridden to the complete 26-edge plotting skeleton (figs/_drive.mjs
setSkeletonEdges / MOUSE_EDGES, from src/skeleton_style.py) so the animals read
as mice rather than spiky lines (Eric 2026-08-16). Display-only: nothing on the
tracking/triangulation path reads skeleton.edges, and the manifests' numeric
payloads were diff-verified unchanged. The tiles remain the app's own canvases.

    python3 figs/panels/fig6_05_cameras.py
"""
import json
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT  # noqa: E402
from src.style import INK, mm, save, use  # noqa: E402

CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
W, H = 78.0, 44.0        # mm; a + b share the 180 mm row (a is 98 mm wide)
COLS, ROWS = 3, 2
TG = 0.8                 # mm between tiles
CAP = 3.4                # mm reserved at the bottom for the provenance line
TILE_AR = 1.25           # 1280 x 1024 native, so tiles stay near the source aspect
#: Translucent backing for white in-image type, in place of legacy's stroke halo.
HALO = dict(facecolor="#000000", alpha=0.45, edgecolor="none", pad=0.9)


def crop_to(img, bbox, aspect, pad=0.06):
    """Crop `img` to `bbox` (source px), widened to exactly `aspect`.

    Mirrors `fig6_09_rig.crop_to`; kept local to each panel rather than added to
    `src/style.py`, which is shared with every other figure.
    """
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


def main():
    use()
    man_p = OUT / "fig6-app.json"
    if not man_p.exists():
        sys.exit("missing figs/out/fig6-app.json — run `node figs/fig6_app.mjs`")
    app = json.loads(man_p.read_text())
    # Frame from the MANIFEST, not a literal -- this line said `f120` while the
    # driver's last run wrote `f20`, so the panel drew frame-120 images cropped by
    # frame-20 bboxes (found 2026-08-19). This panel is currently off the artwork;
    # the same fix is live in panels/fig6_13_enrichment_grid.py.
    paths = {c: OUT / f"fig6-view-f{app['frame']}-{c}.png" for c in CAMS}
    missing = [p.name for p in paths.values() if not p.exists()]
    if missing:
        sys.exit(f"missing figs/out/{missing} — run `node figs/fig6_app.mjs`")
    boxes = {v["name"]: v["bbox"] for v in app.get("views") or []}
    per = (app.get("scale") or {}).get("perView") or {}
    L = (app.get("scale") or {}).get("L") or 50.0

    tw = (W - (COLS - 1) * TG) / COLS
    th = tw / TILE_AR
    grid_h = ROWS * th + (ROWS - 1) * TG
    y_top = H - (H - CAP - grid_h) / 2.0        # mm from the bottom, top edge

    fig = plt.figure(figsize=(mm(W), mm(H)))
    for i, cam in enumerate(CAMS):
        cx = (i % COLS) * (tw + TG)
        cy = y_top - (i // COLS + 1) * th - (i // COLS) * TG
        ax = fig.add_axes([cx / W, cy / H, tw / W, th / H])
        img = mpimg.imread(str(paths[cam]))
        b = boxes.get(cam)
        if b:
            img = crop_to(img, (b["x0"], b["y0"], b["x1"], b["y1"]), TILE_AR)
        ax.imshow(img)
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        # White type, INSIDE the tile by a measured inset. `style.tile` puts badges
        # at 0.97, which on a 25 mm tile lands on the boundary -- three badges sat
        # over the top edge of their tiles in the previous build.
        ax.text(0.04, 0.94, cam, transform=ax.transAxes, ha="left", va="top",
                color="white", fontsize=6.0, fontweight="bold", bbox=HALO)

        ppm = (per.get(cam) or {}).get("pxPerUnit")
        if ppm:
            # 50 mm is ~6 % of a tile here (the animals are ~30 % of it), so the bar
            # is SHORT and its caption is wider than it is. Caption beside the bar on
            # one baseline, not stacked above it: stacked, the words read as a label
            # for the picture rather than for the rule.
            frac = L * ppm / img.shape[1]        # bar length, fraction of tile width
            x1, y = 0.955, 0.075
            ax.plot([x1 - frac, x1], [y, y], transform=ax.transAxes, color="white",
                    lw=1.5, solid_capstyle="butt", clip_on=False, zorder=5)
            # Two of the six views put a brightly lit acrylic rail in this corner, so
            # plain white type disappears there -- legacy haloed it (`f.tag`); a
            # translucent backing does the same job and keeps the span WHITE, which
            # is how `lint_text.py` tells a burned-in image label from plot text.
            ax.text(x1 - frac - 0.02, y, f"{L:.0f} mm", transform=ax.transAxes,
                    ha="right", va="center", color="white", fontsize=5.4,
                    bbox=HALO, zorder=5)

    fig.text(0.5, CAP / H / 2.4,
             f"difficulty 4 · 4 animals · black bedding · bars {L:.0f} mm",
             ha="center", va="center", color=INK, fontsize=6.0)
    save(fig, 6, "b", "cameras")


if __name__ == "__main__":
    main()
