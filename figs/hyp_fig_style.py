#!/usr/bin/env python3
"""Composite the multi-view grouping-hypothesis figure: the Blender render
from blender-images/hyp_fig_scene.py (floor + 3 real animals + 2 real cameras
with real image planes), with every dot/line/label added here as vector
annotations (matplotlib), placed by analytically re-projecting the same real
3D quantities through the exact staging camera the render used
(blender-images/chen_common.StagingCamera). Same technique as
fig_chen2020_style.py.

Design: camera A is the REFERENCE view -- its 3 detections are shown in
distinct colors (tab10). Camera B's 3 detections are shown in a single
NEUTRAL grey -- deliberately NOT colored by ground truth, since the whole
point of this figure is that which grey blob in B corresponds to which
colored blob in A is not yet resolved. All 3x3=9 candidate correspondence
lines are drawn between the two views' detections, each colored by its
SOURCE (camera A) identity, with no visual hint about which of the 9 are
actually correct -- that's the "possible hypotheses" being illustrated. (A
later, separate step will triangulate each of the 6 complete one-to-one
hypotheses and show the correct one solid vs. incorrect ones transparent.)

    python3 hyp_fig_style.py --variant sidetop
    python3 hyp_fig_style.py --variant toptop

Reads blender-images/renders/{hyp_fig_data_<variant>.json,
hyp_staging_camera_<variant>.json, hyp_correspondence_<variant>.png}. Writes
figures/drafts/figs/lucid_hyp_style_<variant>.png.
"""
import argparse
import json
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.image import imread
from matplotlib.lines import Line2D

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "blender-images"))
import chen_common as cc  # noqa: E402
import hyp_common as hc  # noqa: E402

OUT_DIR = os.path.join(HERE, "figures", "drafts", "figs")

INK = "#000000"
COLORS = hc.TAB10_3
#: camera B's "unresolved" overlay: white (was grey) + dotted edges, so it
#: reads as a distinct, deliberately-unlabeled detection against the dark
#: photo rather than just a duller version of camera A's solid colors.
NEUTRAL = "#FFFFFF"
NEUTRAL_EDGE = "#4A4A4A"  # thin outline so white markers/dots don't wash out
#: incorrect-hypothesis lines: lighter than NEUTRAL_EDGE, which nearly
#: vanished against the dark photo backgrounds -- still clearly thinner/duller
#: than the colored correct lines, just visible against both light and dark.
INCORRECT_GREY = "#B8B8B8"


def proj(stg, P):
    return stg.project(np.asarray(P) * cc.MM)


def draw_pose(ax, world_pts, stg, color, lw=None, ms=None, z=5, ls="-",
              edgecolor="white"):
    """One instance overlay on an image plane.

    EVERY node carries a WHITE outline by default, which is 13d's own
    convention and the reason its overlays read against the photo (Eric: "i
    like the way we are rendinging the instances on 13d, they are easier to
    see with the white outline, so add that to the instance overlays on
    fig13c"). Camera B's unresolved detections pass their own dark edge
    instead -- their fill is already white, so a white outline would be
    invisible."""
    lw = pt(PAGE_POSE_LW) if lw is None else lw
    ms = pt(PAGE_POSE_MS) if ms is None else ms
    px = proj(stg, world_pts)
    for a, b in hc.MOUSE_EDGE_IDXS:
        ax.add_line(Line2D([px[a, 0], px[b, 0]], [px[a, 1], px[b, 1]],
                            color=color, lw=lw, ls=ls, zorder=z, solid_capstyle="round",
                            dash_capstyle="round"))
    ax.scatter(px[:, 0], px[:, 1], s=ms ** 2, color=color, zorder=z + 1,
               linewidths=0.6 * (lw / pt(PAGE_POSE_LW)),
               edgecolors=edgecolor or "none")
    return px


# ---- TYPE SIZES ARE GIVEN IN *ON-PAGE* POINTS, SHARED WITH 13d ----
# This panel is drawn FIG_W_IN inches wide and placed PLACED_MM wide on Fig 13,
# so a size written in source points prints at source / SRC_PER_PAGE. The two
# staged-3D illustrations on that page (13c here, 13d in idswitch_fig_style.py)
# are drawn at DIFFERENT figure widths and placed at DIFFERENT widths, so equal
# source sizes print at different sizes -- which is exactly what happened:
# 13c's labels came out a point smaller than 13d's on the page. Stating the
# PAGE size in both scripts and converting through each one's own scale is what
# makes them agree (Eric: "standardize the legend and label sizes for 13 c and
# 13 d, i think 13 d is better, so do that. too").
#
# The values are 13d's, which is the one Eric picked.
#
# THE SCALE IS SET BY THE *CROPPED* WIDTH, NOT THE FIGURE WIDTH. This panel is
# rendered to a PNG at DPI, the panel script CROPS that PNG to its ink, and
# fig13_sync places the crop PLACED_MM wide -- so what a source point measures
# on the page depends on the CROP, not on `figsize`. Deriving it from figsize
# (as this did at first) silently over-states the scale by the fraction of the
# render that gets trimmed, and the fraction differs between the two panels:
# 13c is saved with bbox_inches="tight" (already trimmed) while 13d is not.
# Measured on the built artefacts, the two panels' camera labels printed at
# 7.07 pt and 7.56 pt from the SAME nominal 7.4 -- exactly the mismatch Eric
# caught ("they may be the same numbers but not actually the same size ... we
# need to verify this from the perspective of fig13").
#
#   on_page_pt = source_pt * DPI * PLACED_MM / (CROP_W_PX * 25.4)
#
# CROP_W_PX is measured from the built PNG and is mildly self-referential (a
# bigger label makes a wider crop), so it is re-measured after a build; one
# pass converges. `scripts` note: figs/_verify_fig13_type.py prints the
# realised on-page sizes for both panels -- run it after touching either.
FIG_W_IN = 5.4
DPI = 300
#: c's width in the Fig 13 row -- fig13_sync's own c_w solve. Duplicated rather
#: than imported: this script runs standalone (and for the `toptop` variant,
#: which Fig 13 does not place at all).
PLACED_MM = 98.41
#: width in px of `panels/fig13_00_hyp_illustration.content_crop` on the PNG
#: this script writes. RE-MEASURE after any change that moves the ink.
CROP_W_PX = 1588
SRC_PER_PAGE = CROP_W_PX * 25.4 / (DPI * PLACED_MM)


def pt(page_pt):
    """On-page points -> this figure's own source points."""
    return page_pt * SRC_PER_PAGE


#: keep in sync with idswitch_fig_style.py's PAGE_* -- these are the sizes the
#: two illustrations agree on ONCE PLACED, which is the only place they can be
#: compared.
PAGE_CAMERA, PAGE_LEGEND = 7.4, 6.8
#: pose overlay stroke / node size, on-page points -- 13d's own values, so the
#: two panels' skeletons carry the same weight (Eric: "they need to look fairly
#: consistent").
PAGE_POSE_LW, PAGE_POSE_MS = 1.23, 2.82
#: the UNRESOLVED (top-camera) detections are drawn heavier than the resolved
#: ones (Eric: "bigger nodes and edges for the unresolved detections in the top
#: camera image plane overlays"): they are the thing this panel is about, and
#: they are white-on-dark-photo, which needs more stroke to read than a
#: saturated colour does.
#:
#: 3.9 -> 3.15 on the nodes after looking at it on the page. This panel's top
#: view is the WHOLE arena with three animals in it, so a 15-node skeleton
#: covers very few pixels -- at 3.9 pt the nodes touched and the dotted edges
#: between them disappeared behind their own markers, which loses the "dotted =
#: unresolved" cue the legend names. 3.15 is still visibly heavier than the
#: resolved 2.82 without the skeleton closing up. (13d can carry much bigger
#: nodes because its panes are a tight two-animal crop.)
PAGE_UNRES_LW, PAGE_UNRES_MS = 1.55, 3.15

#: prop half-extent (aligned mm) the camera labels hug, and the gap they leave
#: -- the same two knobs idswitch_fig_style.py uses, so the labels sit the same
#: way relative to their renders in both panels. NOT content_bbox's own 75 mm:
#: that is a generous "keep the prop in frame" box, while the camera unit
#: cage_scene actually draws is smaller, and a label measured off 75 floats.
PROP_LABEL_R = 42.0
LABEL_GAP = 9.0


def label(ax, xy, text, dxdy=(8, -8), fontsize=None, color=INK, ha="left", va="center",
         leader=True, box=True, style="normal", weight="normal"):
    fontsize = pt(PAGE_CAMERA) if fontsize is None else fontsize
    kw = dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.8) if box else None
    arrow = dict(arrowstyle="-", color=color, lw=0.6, shrinkA=0, shrinkB=3) if leader else None
    ax.annotate(text, xy=xy, xycoords="data", xytext=dxdy, textcoords="offset points",
                fontsize=fontsize, color=color, ha=ha, va=va, zorder=20, bbox=kw,
                arrowprops=arrow, fontstyle=style, fontweight=weight,
                linespacing=1.15)


def content_bbox(data, stg, pad=8):
    pts = []
    fh = data["floor_half"]
    floor = np.array([(fh["x0"], fh["y0"], 0), (fh["x1"], fh["y0"], 0),
                      (fh["x1"], fh["y1"], 0), (fh["x0"], fh["y1"], 0)])
    for p in floor:
        pts.append(proj(stg, p))
    for tag in ("cam_a", "cam_b"):
        info = data[tag]
        C_al = np.array(info["C_al"])
        m = 75.0  # mm, camera-prop footprint margin -- see fig_chen2020_style.py's note
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    pts.append(proj(stg, C_al + np.array([sx, sy, sz]) * m))
        right_al, down_al = np.array(info["right_al"]), np.array(info["down_al"])
        qc = np.array(info["quad_center_al"])
        hw, hh = info["half_w_al"], info["half_h_al"]
        for su in (-1, 1):
            for sv in (-1, 1):
                pts.append(proj(stg, qc + right_al * (su * hw) + down_al * (sv * hh)))
    pts = np.array(pts)
    x0, y0 = pts.min(axis=0) - pad
    x1, y1 = pts.max(axis=0) + pad
    y0 -= 22  # headroom for camera-a's own title text only
    return x0, y0, x1, y1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default=hc.DEFAULT_VARIANT, choices=list(hc.CAMERA_PAIRS))
    args = ap.parse_args()
    variant = args.variant

    plt.rcParams.update({"font.size": pt(PAGE_LEGEND), "font.family": "sans-serif",
                          "font.sans-serif": ["Liberation Sans", "Arial", "DejaVu Sans"],
                          "text.color": INK})
    data = json.load(open(hc.data_json_path(variant)))
    stg = cc.StagingCamera.from_dict(json.load(open(hc.staging_camera_path(variant))))
    img = imread(hc.render_path(variant))

    x0, y0, x1, y1 = content_bbox(data, stg)
    aspect = (x1 - x0) / (y1 - y0)
    fig_w = FIG_W_IN
    fig, ax = plt.subplots(figsize=(fig_w, fig_w / aspect + 0.28))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.imshow(img)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.set_autoscale_on(False)
    ax.axis("off")
    ax.set_position([0, 0.05, 1, 0.95])

    n = data["n_animals"]
    X_al = np.array(data["X_al"])  # (3,15,3) mm -- real 3D, for centroid routing
    trunk_a = np.array(data["cam_a"]["trunk_world"])  # (3,3)
    trunk_b = np.array(data["cam_b"]["trunk_world"])
    pose_a = np.array(data["cam_a"]["pose_world"])    # (3,15,3)
    pose_b = np.array(data["cam_b"]["pose_world"])

    # camera A: instance overlay in real identity colors
    trunk_a_px = np.zeros((n, 2))
    for i in range(n):
        draw_pose(ax, pose_a[i], stg, COLORS[i], z=6)
        trunk_a_px[i] = proj(stg, trunk_a[i])
        ax.scatter(*trunk_a_px[i], s=26, color=COLORS[i], edgecolor="white",
                  linewidths=0.8, zorder=9)

    # camera B: instance overlay in NEUTRAL white + dotted -- identity unresolved
    trunk_b_px = np.zeros((n, 2))
    for j in range(n):
        draw_pose(ax, pose_b[j], stg, NEUTRAL, z=6, ls=(0, (1.6, 1.6)),
                  lw=pt(PAGE_UNRES_LW), ms=pt(PAGE_UNRES_MS),
                  edgecolor=NEUTRAL_EDGE)
        trunk_b_px[j] = proj(stg, trunk_b[j])
        ax.scatter(*trunk_b_px[j], s=26, color=NEUTRAL, edgecolor=NEUTRAL_EDGE,
                  linewidths=0.9, zorder=9)
        label(ax, trunk_b_px[j], "?", dxdy=(0, -14), ha="center", color=NEUTRAL_EDGE,
              leader=False, box=False, fontsize=pt(PAGE_CAMERA))

    # each of the 3x3=9 candidate correspondences is a SINGLE straight line
    # directly between the two image-plane detections (camera A's point to
    # camera B's point) -- NOT routed through the 3D floor centroid. Per Eric:
    # this step is about associating IDs in 2D, across views, before any
    # triangulation happens, so the lines belong strictly image-plane to
    # image-plane. Correct (i==j) pairs are solid, thick, and colored by
    # identity; incorrect pairs are grey, thin, and solid too -- so they read
    # as background candidates rather than competing for attention with the
    # one real correspondence.
    for i in range(n):
        for j in range(n):
            correct = i == j
            color = COLORS[i] if correct else INCORRECT_GREY
            lw = 2.4 if correct else 1.4
            alpha = 0.95 if correct else 0.85
            ax.add_line(Line2D([trunk_a_px[i, 0], trunk_b_px[j, 0]],
                               [trunk_a_px[i, 1], trunk_b_px[j, 1]],
                               color=color, lw=lw, alpha=alpha, zorder=4 + correct))

    # ONLY the 3 correct pairs additionally connect down to the real 3D
    # center of mass -- together with the direct image-to-image line above,
    # each correct correspondence forms a closed TRIANGLE (camera A point,
    # camera B point, real 3D centroid), since only the true correspondence
    # also resolves to a consistent triangulated position. The 6 incorrect 2D
    # associations stay dashed image-to-image only, with no 3D leg at all --
    # there isn't a consistent 3D point for a wrong pairing to show.
    centroid_px = np.array([proj(stg, X_al[i].mean(axis=0)) for i in range(n)])
    for i in range(n):
        for p0, p1 in ((trunk_a_px[i], centroid_px[i]), (centroid_px[i], trunk_b_px[i])):
            ax.add_line(Line2D([p0[0], p1[0]], [p0[1], p1[1]],
                               color=COLORS[i], lw=2.4, alpha=0.95, zorder=5))

    cam_a_px = proj(stg, data["cam_a"]["C_al"])
    cam_b_px = proj(stg, data["cam_b"]["C_al"])
    # SAME WORDS, SHAPE, SIZE AND WEIGHT AS 13d's (Eric, 2026-08-25: "make
    # sure those camera labels match in size and style should just say top
    # camera and side camera maybe stacked vertically"). Was "Camera A (side)"
    # -- the A/B lettering was a second naming scheme for the same two cameras
    # that 13d already calls "side" and "top", and nothing else in either
    # panel refers to a "camera A". Bold and unboxed to match 13d; both labels
    # sit on white canvas here, so the white bbox that let the old text read
    # over the photo is no longer earning its place.
    # PLACED RELATIVE TO EACH PROP THE WAY 13d PLACES ITS OWN (Eric: "the top
    # camera label in 13c should be placed similar relative to the top camera
    # label in 13d, and the side camera label in 13c should be placed similar
    # relative to the camera render as 13d ... they need to look fairly
    # consistent"), i.e. measured off the prop's PROJECTED BOX rather than off
    # its centre by a fixed point offset:
    #   top  -> to the RIGHT of the prop, vertically centred on it
    #   side -> ABOVE the prop, horizontally centred, a hair right
    # PROP_LABEL_R / GAP mirror idswitch_fig_style.py's, in this panel's own
    # aligned-mm units.
    #
    # It is also what stops the two collisions Eric found: at a fixed
    # (14, -6) offset from the prop CENTRE the top label ran down onto the top
    # image plane, and the side label sat below its prop against the side
    # plane's edge. Anchoring to the box's own top/right edge keeps both clear
    # whatever the props' projected size turns out to be.
    def prop_box(tag):
        C_al = np.array(data[tag]["C_al"])
        return np.array([proj(stg, C_al + np.array([sx, sy, sz]) * PROP_LABEL_R)
                         for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])

    box_a, box_b = prop_box("cam_a"), prop_box("cam_b")
    # side: above its prop, centred, nudged right (13d's "above" rule).
    ax.text(cam_a_px[0] + 1.6 * LABEL_GAP, box_a[:, 1].min() - 2.2 * LABEL_GAP,
            f"{data['cam_a_name']}\ncamera", fontsize=pt(PAGE_CAMERA),
            fontweight="bold", color=INK, ha="center", va="bottom",
            multialignment="center", linespacing=1.15, zorder=20)
    # top: right of its prop, vertically centred (13d's "right" rule).
    ax.text(box_b[:, 0].max() + LABEL_GAP, cam_b_px[1],
            f"{data['cam_b_name']}\ncamera", fontsize=pt(PAGE_CAMERA),
            fontweight="bold", color=INK, ha="left", va="center",
            multialignment="center", linespacing=1.15, zorder=20)

    legend_handles = [Line2D([0], [0], color=COLORS[i], lw=2.2, label=f"Animal {i+1}")
                     for i in range(n)]
    # legend swatch uses the dark outline (not NEUTRAL white itself, which
    # would be invisible against the legend's own white background)
    legend_handles.append(Line2D([0], [0], color=NEUTRAL_EDGE, lw=1.6, ls=(0, (1.6, 1.6)),
                                 # names the camera the way the artwork now
                                 # labels it -- "camera B" was left dangling
                                 # when the props were relabelled side/top.
                                 label=f"unresolved detection "
                                       f"({data['cam_b_name']} camera)"))
    fig.legend(handles=legend_handles, loc="lower center", ncol=len(legend_handles),
              frameon=False, fontsize=pt(PAGE_LEGEND), labelcolor=INK, bbox_to_anchor=(0.5, -0.015),
              handlelength=1.6, columnspacing=1.0, handletextpad=0.5)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"lucid_hyp_style_{variant}.png")
    fig.savefig(out_path, dpi=300, bbox_inches="tight", facecolor="white")
    print("wrote", out_path, "figsize", fig.get_size_inches())


if __name__ == "__main__":
    main()
