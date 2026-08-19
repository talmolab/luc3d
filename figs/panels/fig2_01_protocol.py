#!/usr/bin/env python3
"""
Fig 2a -- the reprojection-aided labelling protocol, staged in the real app.

EIGHT TILES ACROSS FOUR STEPS, ALL FROM THE APP. `fig2_protocol.mjs` drives LUC3D
itself: it labels two anchor views, sets every other view's weight to 0 through the
app's own Camera Views panel so the solve genuinely uses only those two, then reads
back the reprojections and the app's own per-view errors. Nothing here is drawn by
hand, and an earlier pass of this rewrite -- which replaced all eight tiles with a
synthetic five-camera cartoon -- threw away the only evidence the panel had.

  1  label two anchor views          -- cam 1 topB, cam 6 sideL
  2  triangulate from ONLY those two -- schematic + the resulting 3D
  3  reprojections appear            -- cam 0 mid, cam 2 topC, neither labelled
  4  accept or nudge                 -- magnified, with a cursor on a reprojection

THE NUMBERS IN STEP 4 ARE MEASURED, not chosen: the two anchor views land low
because they were labelled, while the other six sit higher because they were only
reprojected into. That spread is what a labeller accepts or nudges, and it is
exactly why Fig 5 needed its OWN all-views staging -- reusing this deliberately
crippled two-anchor frame there would have inflated every residual by construction.

THIS PROTOCOL IS NOT NOVEL AND THE FIGURE MUST NOT IMPLY IT IS. JARVIS's
AnnotationTool already "leverages the multi camera recordings by projecting your
manual annotations on a subset of those cameras to the remaining ones" and shows a
reprojection error bar; Label3D is the direct predecessor for reprojection-aided
multi-camera 3D labelling. What is new here is the browser implementation and, above
all, the QUANTIFICATION in panels b-d. Both are named in Fig 1d and must be cited.

Source: figs/out/fig2-protocol.json + figs/out/fig2p-*.png
        (node figs/fig2_protocol.mjs)

SKELETON EDGES: the tiles are re-exported with the app's skeleton edge set
overridden to the complete 26-edge plotting skeleton (figs/_drive.mjs
setSkeletonEdges / MOUSE_EDGES, from src/skeleton_style.py) so the animals read
as mice rather than spiky lines (Eric 2026-08-16). Display-only: nothing on the
tracking/triangulation path reads skeleton.edges, and the manifests' numeric
payloads were diff-verified unchanged. The tiles remain the app's own canvases.

    python3 figs/panels/fig2_01_protocol.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Arc, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.diagram import blank, icon, point, ray  # noqa: E402
from src.style import MUTED, GREY, INK, SALMON, SPAN, TEAL, mm, save, tile, use  # noqa: E402

STEPS = ["Label 2 anchor views", "Triangulate",
         "Reprojections appear", "Accept or nudge"]
REPROJ_CAMS = ["Camera0_mid", "Camera2_topC"]
#: width / height of one grid cell, measured off the laid-out figure below. The
#: magnified crop is cut to exactly this so it FILLS its cell: a square crop in a
#: 1.19 cell is height-bound, which throws away 16% of the available width and,
#: with it, 16% of the magnification for free.
CELL_AR = 32.59 / 27.35


def cam_label(name):
    """`Camera1_topB` -> `cam 1 topB`.

    The camera INDEX is load-bearing here: the panel's whole claim is about which
    views were labelled and which were only reprojected into, so a badge reading
    just `topB` is unattributable. Fig 1b badges its tiles the same way.
    """
    idx, view = name.removeprefix("Camera").split("_", 1)
    return f"cam {idx} {view}"


def viewport_content_bbox(path, tol=40 / 255):
    """(x0, y0, x1, y1) around the skeletons in a 3D-viewport shot.

    The viewport's background is a flat #1a1a1a, so "content" is anything more than
    `tol` away from it -- the same test `_drive.shootEl` uses when it records a bbox.
    Measured here rather than recorded in the manifest because this shot's framing is
    computed at export time and moves whenever the fit or the frame does.
    """
    import matplotlib.image as _mpimg
    a = _mpimg.imread(str(path))[:, :, :3]
    m = np.abs(a - 0x1a / 255).max(2) > tol
    ys, xs = np.where(m)
    if not len(xs):
        sys.exit(f"{path.name}: no content found — did the 3D shot render empty?")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def bbox_of(views, name):
    for v in views:
        if v["name"] == name:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def view_of(views, name):
    return next(v for v in views if v["name"] == name)


def zoom_on_largest(view, ar=CELL_AR, pad=0.20):
    """A RECTANGULAR crop on the biggest instance in a view, at aspect `ar`.

    `load_tile` deliberately squares its crop so a ROW of tiles shares one aspect,
    which is right for the four source views but wrong for the one magnified tile:
    it is alone in its slot, and the reader has to see the offset between the
    reprojected overlay and the animal under it. Two things were costing that:
      * the crop was square in a 1.19 cell, so it rendered height-bound at 27 mm
        in a 33 mm slot;
      * it was 60% of the WHOLE-frame animal bbox taken from the top-left corner,
        which on this frame cuts off the tail of `id_0` at x = 649 -- and the tail
        is exactly where the two-anchor reprojection sits farthest from the
        detection (the per-view spread runs out to 24.6 px).
    Framing on the largest instance's own box from the manifest keeps that offset
    in frame at 6.9 source px/mm instead of 11.7, i.e. a ~15 px reprojection gap
    becomes ~2.2 mm on the page rather than ~1.3 mm. The neighbouring animal is
    clipped at the left edge, which is what the labeller sees on screen anyway.
    """
    b = max(view["details"],
            key=lambda d: (d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1])
            )["box"]
    w, h = (b[2] - b[0]) * (1 + pad), (b[3] - b[1]) * (1 + pad)
    w = max(w, h * ar)
    h = w / ar
    cx, cy = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def click_target(png, zoom, *, spread=15, edge=0.16):
    """Where in `zoom` to put the cursor: the far end of the drawn overlay.

    The manifest carries a centroid and a box per instance but NO node
    coordinates, so a keypoint cannot be addressed from the data. The overlay is,
    however, already drawn in the tile, so the target is recovered from the
    pixels. The tile is a greyscale camera frame, so the overlay is the only
    CHROMATIC ink in it -- any pixel whose channels spread by more than `spread`
    out of 255 belongs to a bone or a node, and nothing else in the frame does.
    (Matching the identity colour itself does not work: the app draws these
    overlays desaturated, so `#00b478` never appears -- the ink runs to a channel
    spread of only ~34.) The target is then the chromatic pixel farthest from
    their centroid, which is a limb end -- nose or tail tip -- and that is exactly
    where the two-anchor reprojection sits farthest from the detection (the
    per-view spread runs to 24.6 px), i.e. the keypoint a labeller would nudge.
    `edge` keeps the cursor's own body inside the window.
    """
    img = plt.imread(png)
    a = (img[..., :3] * 255).round().astype(np.int16) if img.dtype != np.uint8 \
        else img[..., :3].astype(np.int16)
    x0, y0, x1, y1 = (int(round(v)) for v in zoom)
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, a.shape[1]), min(y1, a.shape[0])
    win = a[y0:y1, x0:x1]
    hit = (win.max(axis=2) - win.min(axis=2)) > spread
    if hit.sum() < 20:
        return None
    ys, xs = np.nonzero(hit)
    cx, cy = xs.mean(), ys.mean()
    order = np.argsort(-((xs - cx) ** 2 + (ys - cy) ** 2))
    mx, my = edge * (x1 - x0), edge * (y1 - y0)
    for k in order:                     # first far point with room for the cursor
        if mx <= xs[k] <= (x1 - x0) - mx and my <= ys[k] <= (y1 - y0) - my:
            return x0 + float(xs[k]), y0 + float(ys[k])
    return x0 + float(xs[order[0]]), y0 + float(ys[order[0]])


#: The classic arrow pointer, tip at (0, 0), pointing up and to the left, in units
#: of the cursor's own height. Drawn rather than imported so it scales with the
#: tile's own pixel coordinates and needs no font or asset.
CURSOR = [(0.0, 0.0), (0.0, 1.00), (0.24, 0.76), (0.40, 1.06),
          (0.53, 1.00), (0.37, 0.70), (0.66, 0.66)]


def click_cursor(ax, xy, *, h):
    """Draw a pointer clicking at `xy` (data coords), `h` tall in the same units.

    Step 4 of the protocol is an ACTION -- accept the reprojection or nudge it --
    and until now the tile showed only its result (Eric, 2026-08-18: "I want a
    little mouse to appear like it is clicking on one of the reprojections").
    White fill with a dark outline, because the tile behind it is video and can be
    any value; two short arcs off the tip carry the click.
    """
    x, y = xy
    pts = [(x + dx * h, y + dy * h) for dx, dy in CURSOR]
    ax.add_patch(Polygon(pts, closed=True, facecolor="white", edgecolor=INK,
                         lw=0.7, joinstyle="miter", zorder=7))
    for r, lw in ((0.42, 0.9), (0.72, 0.6)):
        ax.add_patch(Arc((x, y), 2 * r * h, 2 * r * h, angle=0.0,
                         theta1=118.0, theta2=196.0, color=INK, lw=lw, zorder=7))


def chevron(fig, x, y, *, h=0.023, w=0.010, color=GREY, lw=1.2):
    """A `>` between two steps, drawn (not typeset) in figure coordinates.

    The four tiles columns sit in 12.4 mm gutters, so a 1.8 x 3.6 mm chevron has
    room in the middle of one without coming near a tile. Drawn as a polyline
    rather than a `>` glyph because Fig 1a's typeset chevrons are the reason
    `lint_text.py` reports text ON DATA there -- noise that hides real hits.
    """
    fig.add_artist(Line2D([x - w / 2, x + w / 2, x - w / 2], [y + h, y, y - h],
                          transform=fig.transFigure, color=color, lw=lw,
                          solid_capstyle="round", clip_on=False))


def schematic(ax, anchors=()):
    """Two solid rays in from the anchors, several dashed reprojections out.

    THE ANCHOR CAMERAS ARE NAMED (review 2026-08-13: "if you labelled, the diagram
    should label the cam 2 and cam 6"). The tiles either side of this schematic badge
    themselves `cam 1 topB . anchor`, but the ray diagram between them did not, so the
    one element that shows WHY two views suffice was the only one that did not say
    which two. Names come from `anchors`, the same list the tiles use, so the
    schematic cannot drift from the render it sits beside. (For the record, the
    current render's pair is cam 1 topB and cam 6 sideL -- the meeting note's "cam 2"
    was approximate and FIGURE-LEGENDS.md is right.)"""
    blank(ax)
    px, py = 1.6, 0.0
    for cy, cam in zip((1.6, -1.6), list(anchors) + [None, None]):
        icon(ax, "camera", -2.3, cy - 0.3, s=0.6, color=INK)
        ray(ax, -1.6, cy, px, py, color=INK, lw=0.9)
        if cam:
            # Above the upper camera and below the lower one, so neither label sits
            # between the two rays where they converge on the 3D point.
            # BOTH ABOVE their camera. Below the lower one the label ran into the
            # "2 views labelled" caption at the foot of the schematic (lint: 84%
            # overlap); above it there is clear space on both.
            # 0.62 above, not 0.42: the lower camera's icon top edge sits at
            # cy + 0.30, so a 6 pt label 0.42 above it clipped the icon (lint: 5%
            # inked). Both labels use the same offset so the pair reads as a pair.
            ax.text(-2.35, cy + 0.62, cam_label(cam), ha="left", va="bottom",
                    color=INK, fontsize=6.0)
    # SIX grey cameras, because the caption beside them says "other 6" and a reader
    # counts (review 2026-08-14: three were drawn against a caption saying six, on an
    # 8-camera exemplar session in a figure whose other panels are the 5-camera
    # corpus -- the mismatch invited exactly the wrong question). Two columns of
    # three keeps them inside the axes at the same icon size.
    for i_c, cy in enumerate((2.0, 1.2, 0.4, -0.4, -1.2, -2.0)):
        cx_ = 4.0 if i_c % 2 == 0 else 4.6
        icon(ax, "camera", cx_, cy - 0.25, s=0.5, color=GREY)
        ray(ax, px, py, cx_ - 0.1, cy, color=TEAL, ls=(0, (2.0, 1.5)))
    # INK, not salmon: the triangulated point is the pipeline's own product, and
    # salmon is the comparator's hue set-wide (review 2026-08-14).
    point(ax, px, py, color=INK, r=0.17)
    ax.text(px, py + 0.35, "3D", ha="center", va="bottom", color=INK,
            fontsize=6.5, fontweight="bold")
    ax.text(-2.4, -2.6, "2 views labelled", color=INK, fontsize=6.5)
    ax.text(-2.4, -3.2, "other 6: weight 0", color=MUTED, fontsize=6.5)
    # The exemplar is the 8-CAMERA demo session; panels b-d are the 5-camera corpus.
    # Said here because the row of grey cameras is where the count question arises.
    ax.text(5.4, -2.6, "rest reprojected", color=TEAL, fontsize=6.5, ha="right")
    ax.text(5.4, -3.2, "(8-camera session)", color=MUTED, fontsize=6.5, ha="right")
    ax.set_xlim(-2.6, 5.6)
    ax.set_ylim(-3.6, 2.6)


def fix_cam6_id_labels(ax, view):
    """Re-typeset the two colliding identity chips on the cam 6 anchor tile.

    On this frame the app draws each instance's identity label at its box's
    top edge, and id_0's box (x 583-695) and id_1's (x 446-620) overlap -- so
    the BAKED labels collide and the tile reads "id id_1" with id_0's name
    buried (adversarial review 2026-08-17, Agent 3 MAJOR 4). The label pixels
    are app chrome, not evidence, so the fix is to re-set the same two names,
    in the app's own per-instance colours FROM THE MANIFEST (`view["details"]`
    exists precisely "so the composer can put a leader line + label on" --
    fig2_protocol.mjs), on an opaque chip that covers the garbled cluster.
    Nothing else in the photograph is touched, and a re-export that moves the
    animals moves `details` with it, so the vector chips cannot drift from the
    render they cover.

    Axes-fraction geometry, measured off the cropped tile: the baked cluster
    spans x 0.61-0.83, y 0.63-0.70 (imshow's y inverted).
    """
    import matplotlib.patches as mpatches

    by_id = {d["identity"]: d for d in view["details"]}
    # The chip: the app's label background is the dark arena wall here; a black
    # chip is what the legible labels elsewhere in the frame sit on. Sized for
    # the TYPE, not just the garble: at 6 pt each name is ~0.14 of the tile's
    # width, so two names plus a gap need ~0.33 -- the first cut of this fix
    # used the garble's own 0.245 and reproduced the collision in vector.
    ax.add_patch(mpatches.Rectangle((0.545, 0.625), 0.335, 0.085,
                                    transform=ax.transAxes, facecolor="black",
                                    edgecolor="none", zorder=5))
    # id_1's animal is the left of the pair, id_0's the right -- same order the
    # baked labels attempted.
    for name, x, ha in (("id_1", 0.558, "left"), ("id_0", 0.868, "right")):
        ax.text(x, 0.667, name, transform=ax.transAxes, ha=ha, va="center",
                color=by_id[name]["color"], fontsize=6.0, fontweight="bold",
                zorder=6)


def main():
    use()
    p = load("fig2-protocol.json")
    anchors = p["anchors"]
    va, vr = p["views"]["anchor"], p["views"]["reproj"]

    # The measured split: the two anchor views against the six reprojected into.
    per = p["reprojErrorsTwoAnchors"]
    a_vals = [e["perView"][c] for e in per for c in anchors]
    o_vals = [v for e in per for c, v in e["perView"].items() if c not in anchors]

    fig = plt.figure(figsize=(mm(SPAN["full"]), mm(78.0)), layout="constrained")
    fig.get_layout_engine().set(rect=(0, 0, 1, 0.925))
    gs = fig.add_gridspec(2, 4)
    cells = {(r, c): fig.add_subplot(gs[r, c]) for r in (0, 1) for c in range(4)}

    # --- 1: the two anchor views ------------------------------------------
    for r, cam in enumerate(anchors):
        f = OUT / f"fig2p-anchor-f150-{cam}.png"
        if not f.exists():
            sys.exit(f"missing figs/out/{f.name} — run `node figs/fig2_protocol.mjs`")
        ax_t = tile(cells[(r, 0)], f, bbox_of(va, cam),
                    badge=f"{cam_label(cam)} · anchor", pad=0.06)
        if cam == "Camera6_sideL":
            fix_cam6_id_labels(ax_t, view_of(va, cam))

    # --- 2: the solve, and what it produced -------------------------------
    schematic(cells[(0, 1)], anchors)
    # CROPPED TO THE POSE, MEASURED (2026-08-19). This tile used to go in whole
    # (`bbox=None`), so most of it was empty viewport. The driver now stages it at
    # the sideL anchor's own camera pose with a computed FOV fit, and the pose is
    # WIDE and SHORT in that view -- so the fit is set by the horizontal extent and
    # leaves the frame two-thirds empty vertically whatever the driver does. The
    # crop is measured off the pixels rather than recorded, so a re-export cannot
    # slide it off the content.
    tile(cells[(1, 1)], OUT / "fig2p-3d-animals.png",
         viewport_content_bbox(OUT / "fig2p-3d-animals.png"),
         badge="3D from the 2 anchors", pad=0.10)

    # --- 3: two views nobody labelled -------------------------------------
    for r, cam in enumerate(REPROJ_CAMS):
        tile(cells[(r, 2)], OUT / f"fig2p-reproj-f150-{cam}.png", bbox_of(vr, cam),
             badge=f"{cam_label(cam)} · not labelled", pad=0.06)

    # --- 4: magnified, and the measured error split -----------------------
    # The whole image goes in and the crop is done with the LIMITS, because that is
    # the only way to get a non-square window through `tile` (`load_tile` squares
    # any bbox it is given). Badges are in axes coordinates, so they follow.
    zoom = zoom_on_largest(view_of(vr, "Camera0_mid"))
    ax0 = tile(cells[(0, 3)], OUT / "fig2p-reproj-f150-Camera0_mid.png", None,
               badge=f"{cam_label('Camera0_mid')} · magnified")
    ax0.set_xlim(zoom[0], zoom[2])
    ax0.set_ylim(zoom[3], zoom[1])
    # The cursor goes on the tile a labeller would act on: the magnified,
    # unlabelled view whose overlay is a reprojection. Sized at 13% of the zoom
    # height so it reads as a pointer at 33 mm tall and does not cover the animal.
    tgt = click_target(OUT / "fig2p-reproj-f150-Camera0_mid.png", zoom)
    if tgt is None:
        print("  [warn] no overlay ink found — cursor skipped")
    else:
        click_cursor(ax0, tgt, h=0.13 * (zoom[3] - zoom[1]))
        print(f"  cursor at {tgt[0]:.0f}, {tgt[1]:.0f} px in the source frame")

    ax = cells[(1, 3)]
    blank(ax)
    ax.set_aspect("auto")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    # ONLY THE ENCODING KEY (Eric, 2026-08-18: "get rid of '2 anchor solve, this
    # frame', 'anchor views 1.4-4.5px' and 'the other 6 2.5-24.6' ... you can keep
    # dotted = reprojected and solid = detected, and bring those up higher"). The
    # measured per-view split is still computed above and still deposited; it is a
    # caption number now, not artwork. With three lines gone the two that remain
    # start at the top of the cell, directly under the magnified view they explain.
    for i, (t, c, w) in enumerate([
            ("dotted = reprojected", GREY, "normal"),
            ("solid = detected", GREY, "normal")]):
        ax.text(0.0, 0.95 - i * 0.17, t, color=c, fontweight=w, fontsize=7, va="top")

    # STEP NUMBER AND TITLE IN ONE RUN OF TYPE, "1. Label 2 anchor views". The
    # number used to sit in a filled disc; a disc is decoration, it reads as an
    # icon rather than as type, and at 7 pt inside a circle it is the smallest and
    # least legible element on the page. Numbering the titles says "procedure"
    # just as well and keeps every character in the figure's one typeface and
    # weight. The chevrons between cells stay -- they carry the ORDER, which is the
    # panel's actual claim.
    fig.canvas.draw()                    # so get_position() is the laid-out one
    for k, title in enumerate(STEPS):
        p = cells[(0, k)].get_position()
        fig.text(p.x0, 0.94, f"{k + 1}. {title}", ha="left", va="bottom",
                 fontweight="bold", color=INK, fontsize=8)
        if k:
            prev = cells[(0, k - 1)].get_position()
            chevron(fig, (prev.x1 + p.x0) / 2, (p.y0 + p.y1) / 2)

    save(fig, 2, "a", "protocol")


if __name__ == "__main__":
    main()
