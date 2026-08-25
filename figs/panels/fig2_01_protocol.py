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
        + blender-images/renders/fig2a_pose.png for the "3D from the 2 anchors"
        tile (figs/fig2a_scene.py -> blender-images/fig1d_scene.py --mode pose)

OVERLAYS ARE DRAWN HERE, IN THE FIG 13 STYLE (Eric 2026-08-25: "we should also
do the overlays in the style that we did in fig13 ... so the overlay and 3d for
fig2 as well"). The driver exports CLEAN video frames plus the per-node 2D as
numbers -- `details[].points` (detected) and `reprojections[]` (the two-anchor
3D reprojected back, read from the app's own reprojectedInstances) -- and this
panel draws them with src/skeleton_style.draw_pose_overlay: solid thin identity-
coloured skeletons on the anchor tiles, DASHED identity-coloured skeletons with
hollow dots on the not-labelled tiles, both together on the magnified tile, so
"dotted = reprojected / solid = detected" is carried by the linestyle exactly as
before. The identity chips are typeset here too (vector, from the manifest's own
colours) instead of being baked app chrome. The 26-edge plotting skeleton comes
from skeleton_style.MOUSE_EDGES, the same set the app tiles were previously
re-exported with (Eric 2026-08-16).

THE 3D TILE IS A BLENDER RENDER since 2026-08-25 (Eric: "lets do a blender style
render like we just did for fig 1d (center) for fig2a2 (bottom)"): the TWO-ANCHOR
solve's ball-and-stick mice in the same identity colours on the movement-fitted
arena floor, rendered from the cam 6 sideL anchor's own viewpoint -- the tile
sits under that camera's video, same reasoning as the app-viewport shot it
replaces. Framed computationally at the cell's aspect, placed full-frame.

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
from src.skeleton_style import SLAP_NODES, draw_pose_overlay  # noqa: E402
from src.style import MUTED, GREY, INK, SALMON, SPAN, TEAL, mm, save, tile, use  # noqa: E402

RENDERS = Path(__file__).resolve().parent.parent / "blender-images" / "renders"

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


def bbox_of(views, name):
    for v in views:
        if v["name"] == name:
            b = v["bbox"]
            return (b["x0"], b["y0"], b["x1"], b["y1"])
    return None


def view_of(views, name):
    return next(v for v in views if v["name"] == name)


#: draw_pose_overlay stroke/dot weights for the ~27 mm photo tiles. Fig 13's
#: defaults (lw 1.23 / ms 2.82) were tuned at ~90 mm panes; at a third of that
#: the same on-page points bury the animal, so both are scaled down together
#: (judged at print size, not derived). The magnified tile prints the animal
#: ~3x larger, so it takes weights near Fig 13's own.
TILE_LW, TILE_MS = 0.85, 1.9
#: magnified tile: the DETECTED pose sits slightly lighter UNDER the reprojected
#: one -- at this magnification the two nearly coincide over the torso, and two
#: equal-weight strokes braid into visual mush; the offset at the extremities
#: (the panel's actual evidence) reads best with the dashed stroke dominant.
MAG_DET_LW, MAG_DET_MS = 1.0, 2.2
MAG_REP_LW, MAG_REP_MS = 1.35, 2.7
#: the reprojected variant's dash pattern (draw_pose_overlay's docstring gives
#: (2.2, 1.6); the gap is widened so the dashes still read as dashes at the
#: ~27 mm tiles' stroke width)
REPROJ_LS = (0, (2.3, 2.1))


def photo_tile(ax, path, bbox, *, badge, pad=0.06):
    """A video tile framed like `tile(..., bbox)` but KEEPING source-pixel data
    coordinates, so `draw_pose_overlay` can draw straight from the manifest.

    `tile`'s `load_tile` crops the ARRAY (data coords become crop-relative);
    here the frame goes in whole and the same square window -- max side widened
    by `pad`, clipped to the frame -- is applied via the axes LIMITS instead
    (the fig1_03_reconstruction.py idiom). Returns (ax, window)."""
    ax = tile(ax, path, None, badge=badge)
    sh, sw = ax.images[0].get_array().shape[:2]
    x0, y0, x1, y1 = bbox
    m = max(x1 - x0, y1 - y0) * (1 + pad) / 2.0
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    win = (max(0, cx - m), max(0, cy - m), min(sw, cx + m), min(sh, cy + m))
    ax.set_xlim(win[0], win[2])
    ax.set_ylim(win[3], win[1])          # imshow's y axis runs downwards
    return ax, win


def pts_of(entry):
    """manifest per-node points ([x, y] | null, skeleton order) -> (15, 2) array."""
    return np.array([[np.nan, np.nan] if q is None else q
                     for q in entry["points"]], float)


def draw_detected(ax, view, *, lw=TILE_LW, ms=TILE_MS):
    """Solid Fig 13-style pose per detected instance, in its identity colour."""
    for d in view["details"]:
        draw_pose_overlay(ax, pts_of(d), d["color"], lw=lw, ms=ms,
                          dot_edge_lw=0.45, zorder=5)


def draw_reprojected(ax, view, *, lw=TILE_LW, ms=TILE_MS):
    """Dashed identity-coloured pose with hollow dots -- the panel's
    "dotted = reprojected" mark, per draw_pose_overlay's reprojected variant."""
    for r in view["reprojections"]:
        draw_pose_overlay(ax, pts_of(r), r["color"], lw=lw, ms=ms, ls=REPROJ_LS,
                          dot_face="none", dot_edge=r["color"], dot_edge_lw=0.55,
                          zorder=6)


def id_chips(ax, view, win, *, names=None):
    """The identity chips the app used to bake in, re-typeset in vector.

    One chip per instance -- the identity name in its own colour on an opaque
    dark chip (the app's label look) -- anchored above the instance's box. Chips
    that would collide are pushed apart along x (cam 6's id_0/id_1 boxes overlap
    on this frame, which is exactly the garble the old `fix_cam6_id_labels`
    existed to cover), and every chip is clamped inside the window.
    """
    x0, y0, x1, y1 = win
    w = x1 - x0
    chip_w = 0.155 * w                    # ~4 chars at 6 pt bold in a ~30 mm tile
    ds = sorted(view["details"], key=lambda d: (d["box"][0] + d["box"][2]) / 2)
    if names is not None:
        ds = [d for d in ds if d["identity"] in names]
    xs = [(d["box"][0] + d["box"][2]) / 2.0 for d in ds]
    for _ in range(20):                   # relax pairwise overlaps
        moved = False
        for i in range(len(xs) - 1):
            gap = xs[i + 1] - xs[i]
            if gap < chip_w:
                push = (chip_w - gap) / 2
                xs[i] -= push
                xs[i + 1] += push
                moved = True
        if not moved:
            break
    for d, cx in zip(ds, xs):
        cx = min(max(cx, x0 + chip_w / 2), x1 - chip_w / 2)
        cy = max(d["box"][1] - 0.035 * (y1 - y0), y0 + 0.06 * (y1 - y0))
        ax.text(cx, cy, d["identity"], ha="center", va="bottom",
                color=d["color"], fontsize=6.0, fontweight="bold", zorder=7,
                bbox=dict(boxstyle="square,pad=0.3", facecolor="black",
                          edgecolor="none"))


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


def click_target(view, zoom, *, edge=0.16):
    """Where in `zoom` to put the cursor: the reprojected keypoint farthest out.

    The cursor goes on a REPROJECTED node (the thing a labeller accepts or
    nudges). The manifest now carries every reprojected node's 2D, so the target
    is picked from the data -- an earlier version of this function had to recover
    it from the tile's pixels by chroma, because only centroids were exported.
    Among the reprojected nodes inside the window (with `edge` margin so the
    cursor's own body fits), take the one farthest from their common centroid:
    a limb end -- nose or tail tip -- which is exactly where the two-anchor
    reprojection sits farthest from the detection (the per-view spread runs to
    24.6 px), i.e. the keypoint a labeller would nudge.
    """
    x0, y0, x1, y1 = zoom
    P = np.vstack([pts_of(r) for r in view["reprojections"]])
    P = P[np.isfinite(P).all(axis=1)]
    ins = P[(P[:, 0] >= x0) & (P[:, 0] <= x1) & (P[:, 1] >= y0) & (P[:, 1] <= y1)]
    if not len(ins):
        return None
    c = ins.mean(axis=0)
    mx, my = edge * (x1 - x0), edge * (y1 - y0)
    room = ins[(ins[:, 0] >= x0 + mx) & (ins[:, 0] <= x1 - mx)
               & (ins[:, 1] >= y0 + my) & (ins[:, 1] <= y1 - my)]
    if not len(room):
        room = ins
    k = np.argmax(((room - c) ** 2).sum(axis=1))
    return float(room[k, 0]), float(room[k, 1])


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


def main():
    use()
    p = load("fig2-protocol.json")
    anchors = p["anchors"]
    va, vr = p["views"]["anchor"], p["views"]["reproj"]
    # The exported per-node arrays are in the session skeleton's node order;
    # draw_pose_overlay's edge set is written in SLAP_NODES. They are the same
    # 15-node skeleton -- assert it, so a session swap fails loudly here rather
    # than drawing bones between the wrong joints.
    assert p["skeletonNodes"] == SLAP_NODES, \
        f"exported node order {p['skeletonNodes']} != skeleton_style.SLAP_NODES"

    # The photo overlays, the Blender pose tile and the chips must share one
    # identity palette. Report rather than assert -- a silent mismatch is what
    # shipped once (fig1_03_reconstruction.py's precedent).
    pal = [d["color"] for d in (p.get("identityPalette") or {}).get("identities", [])]
    print("  identity palette (fig2-protocol.json): " + ", ".join(pal))
    scn = load("fig2a_scene.json")
    print("  blender pose palette (fig2a_scene.json): " + ", ".join(scn["pose_colors"]))
    if pal != scn["pose_colors"]:
        print("  *** PALETTE MISMATCH between app export and blender deposit ***")

    # The measured split: the two anchor views against the six reprojected into.
    per = p["reprojErrorsTwoAnchors"]
    a_vals = [e["perView"][c] for e in per for c in anchors]
    o_vals = [v for e in per for c, v in e["perView"].items() if c not in anchors]

    fig = plt.figure(figsize=(mm(SPAN["full"]), mm(78.0)), layout="constrained")
    fig.get_layout_engine().set(rect=(0, 0, 1, 0.925))
    gs = fig.add_gridspec(2, 4)
    cells = {(r, c): fig.add_subplot(gs[r, c]) for r in (0, 1) for c in range(4)}

    frame = p["frame"]

    # --- 1: the two anchor views ------------------------------------------
    for r, cam in enumerate(anchors):
        f = OUT / f"fig2p-anchor-f{frame}-{cam}.png"
        if not f.exists():
            sys.exit(f"missing figs/out/{f.name} — run `node figs/fig2_protocol.mjs`")
        v = view_of(va, cam)
        ax_t, win = photo_tile(cells[(r, 0)], f, bbox_of(va, cam),
                               badge=f"{cam_label(cam)} · anchor")
        draw_detected(ax_t, v)
        id_chips(ax_t, v, win)

    # --- 2: the solve, and what it produced -------------------------------
    schematic(cells[(0, 1)], anchors)
    # BLENDER RENDER, FULL-FRAME. The render is framed computationally at this
    # cell's own aspect (fig2a_scene.py deposits, fig1d_scene.py --mode pose
    # fits), so nothing is cropped here -- the old app-viewport shot needed its
    # content bbox measured off the pixels; this tile does not. Dark-ink badge:
    # the background is now a white room, not the app's dark viewport.
    p3d = RENDERS / "fig2a_pose.png"
    if not p3d.exists():
        sys.exit("missing blender-images/renders/fig2a_pose.png — run "
                 "`figs/.venv/bin/python figs/fig2a_scene.py`, then "
                 "`blender-images/bpyenv/bin/python blender-images/fig1d_scene.py "
                 "--mode pose --scene figs/out/fig2a_scene.json --out "
                 "blender-images/renders/fig2a_pose.png` (see fig2a_scene.py)")
    tile(cells[(1, 1)], p3d, None, badge="3D from the 2 anchors",
         badge_color=INK)

    # --- 3: two views nobody labelled -------------------------------------
    for r, cam in enumerate(REPROJ_CAMS):
        v = view_of(vr, cam)
        ax_t, _ = photo_tile(cells[(r, 2)], OUT / f"fig2p-reproj-f{frame}-{cam}.png",
                             bbox_of(vr, cam),
                             badge=f"{cam_label(cam)} · not labelled")
        draw_reprojected(ax_t, v)

    # --- 4: magnified, and the accept-or-nudge evidence --------------------
    # The whole image goes in and the crop is done with the LIMITS (non-square
    # window). Reprojected DASHED over detected SOLID -- at this magnification
    # the offset between them is the tile's whole content, and the linestyles
    # carry the "dotted = reprojected / solid = detected" key below.
    vm = view_of(vr, "Camera0_mid")
    zoom = zoom_on_largest(vm)
    ax0 = tile(cells[(0, 3)], OUT / f"fig2p-reproj-f{frame}-Camera0_mid.png", None,
               badge=f"{cam_label('Camera0_mid')} · magnified")
    ax0.set_xlim(zoom[0], zoom[2])
    ax0.set_ylim(zoom[3], zoom[1])
    draw_detected(ax0, vm, lw=MAG_DET_LW, ms=MAG_DET_MS)
    draw_reprojected(ax0, vm, lw=MAG_REP_LW, ms=MAG_REP_MS)
    # The cursor goes on the tile a labeller would act on: the magnified,
    # unlabelled view whose overlay is a reprojection. Sized at 13% of the zoom
    # height so it reads as a pointer at 33 mm tall and does not cover the animal.
    tgt = click_target(vm, zoom)
    if tgt is None:
        print("  [warn] no reprojected keypoint in the zoom — cursor skipped")
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
