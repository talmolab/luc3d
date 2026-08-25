#!/usr/bin/env python3
"""Composite the identity-switch illustration: the Blender render from
blender-images/idswitch_fig_scene.py (floor + two real animals' fading comet
trails + two real cameras with real, UNANNOTATED image planes), with pose
overlays added directly ON each camera's own image plane -- camera A's
overlay in the animals' TRUE identity colours, camera B's overlay with those
colours SWAPPED -- so the identity switch is shown happening in a camera's own
image plane, not as a separate side-by-side inset (Eric: "the switch should
happen in the image plane of the camera not on images on the side ... get rid
of the images on the side").

Every mark is a vector annotation (matplotlib), placed by analytically
re-projecting the REAL 3D points already computed for the quad's own geometry
(`pose_world`/`trunk_world`, from blender-images/idswitch_fig_prep.py's
`prep_camera`) through the exact staging camera the render used
(blender-images/chen_common.StagingCamera) -- the same technique
hyp_fig_style.py uses for the original hypothesis figure's overlays.

    python3 idswitch_fig_style.py

Reads blender-images/renders/{idswitch_fig_data.json,
idswitch_staging_camera.json, idswitch_render.png}. Writes
figures/drafts/figs/lucid_idswitch_style.png.
"""
import json
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import LineCollection
from matplotlib.colors import to_rgba
from matplotlib.image import imread
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch
from matplotlib.path import Path as MplPath
import matplotlib.patheffects as pe

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "blender-images"))
import chen_common as cc  # noqa: E402
import idswitch_common as ic  # noqa: E402

OUT_DIR = os.path.join(HERE, "figures", "drafts", "figs")
INK = "#000000"


def proj(stg, P):
    return stg.project(np.asarray(P) * cc.MM)


# ---- TYPE AND STROKE SIZES ARE GIVEN IN *ON-PAGE* POINTS ----
# This panel is drawn FIG_W_IN inches wide and then rescaled to PLACED_MM by
# fig13_sync.py, so a size written here in source points prints at
# source / SRC_PER_PAGE on the page. Every size below therefore states what it
# should measure ON THE PAGE and is converted once, through `pt()`.
#
# It used to be the other way round -- raw source points, re-tuned by hand
# ("up ~1.4x from the first accepted draft") every time the fig13 row moved
# this panel's placed width. That is a standing bug: the row geometry is
# solved from THIS panel's crop aspect, so the width changes whenever the
# artwork does, and the type silently changes size with it. Stating the page
# size makes the panel's apparent type independent of the row solve.
#
# THE PAGE VALUES ARE THE ONES ERIC APPROVED at the 99.71 mm placement (source
# 11/12/13 pt and 2.0/4.6/2.6 strokes, divided by that placement's own 1.630),
# so this conversion reproduces the accepted look at any width -- and they are
# the sizes hyp_fig_style.py (13c) now converts to as well, which is what makes
# the two illustrations agree once placed (Eric: "standardize the legend and
# label sizes for 13 c and 13 d, i think 13 d is better, so do that. too").
# THE SCALE IS SET BY THE *CROPPED* WIDTH, NOT THE FIGURE WIDTH -- see
# hyp_fig_style.py's copy of this note for the full reasoning and the measured
# mismatch it fixes. on_page_pt = source_pt * DPI * PLACED_MM / (CROP_W * 25.4).
FIG_W_IN = 6.4
DPI = 300
#: keep in sync with fig13_sync.IDSW_W (duplicated rather than imported, the
#: same call HYP_ASPECT makes in fig13_sync -- this script also runs standalone
#: and must not drag in the assembly machinery).
PLACED_MM = 77.5
#: width in px of `panels/fig13_00_hyp_illustration.content_crop` on the PNG
#: this script writes. RE-MEASURE after any change that moves the ink
#: (figs/_verify_fig13_type.py prints it).
CROP_W_PX = 1852
SRC_PER_PAGE = CROP_W_PX * 25.4 / (DPI * PLACED_MM)


def pt(page_pt):
    """On-page points -> this figure's own source points."""
    return page_pt * SRC_PER_PAGE


#: on-page point sizes, shared with hyp_fig_style.py's own PAGE table.
PAGE_CAMERA, PAGE_CALLOUT, PAGE_LEGEND = 7.4, 8.0, 6.8


def _blend(c0, c1, t):
    a, b = np.array(to_rgba(c0)), np.array(to_rgba(c1))
    return tuple((1 - t) * a + t * b)


#: association-leg weight, and the dash period (render px) of the gradient
#: legs. LW matches the hypothesis figure's own correspondence lines (2.4 at
#: its slightly smaller crop) so the two panels' triangles read as the same
#: kind of mark; the dash period is set in RENDER pixels, not as a fraction of
#: each leg, so a short 2D-to-2D leg and a long 2D-to-3D leg dash at the same
#: rate.
ASSOC_LW = pt(1.60)
DASH_PX, GAP_PX = 15.0, 11.0


def assoc_line(ax, p0, p1, color, *, lw=ASSOC_LW, z=5):
    """SOLID single-colour association leg: the CORRECT 2D detection to its 3D
    instance (Eric: "the solid lines should be from the correct id to the
    3d"). A plain Line2D with no head, exactly like 13c's correspondence
    lines -- see hyp_fig_style.py's own "closed TRIANGLE" comment."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    ax.add_line(Line2D([p0[0], p1[0]], [p0[1], p1[1]], color=color, lw=lw,
                       zorder=z, solid_capstyle="round"))


def assoc_gradient_line(ax, p0, p1, c0, c1, *, lw=ASSOC_LW, z=5):
    """DOTTED colour-GRADIENT association leg, `c0` at p0 fading to `c1` at p1.

    Carries every leg the identity switch is responsible for (Eric: "the
    gradient from the incorrect should go from the 2d instance color to the 3d
    instance color ... make sure the correct 2ds to incorrect 2ds is a dotted
    line"), so the hue itself says which identity each end belongs to: a leg
    that starts orange and ends blue IS the statement that one animal is
    carrying two identities.

    NO ARROWHEAD (Eric: "the arrows should not be pointed to the 3d instance,
    they shouldnt use the arrows they should look like the lines from c") --
    an association is symmetric, and the gradient already gives it a direction
    to read. Drawn as alternating dash/gap segments because matplotlib cannot
    dash a per-segment-coloured LineCollection coherently; each dash takes the
    colour of its own midpoint along the run."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    L = float(np.linalg.norm(p1 - p0))
    n = max(2, int(round(L / (DASH_PX + GAP_PX))))
    frac = DASH_PX / (DASH_PX + GAP_PX)
    segs, cols = [], []
    for i in range(n):
        t0 = i / n
        t1 = t0 + frac / n
        segs.append([p0 + (p1 - p0) * t0, p0 + (p1 - p0) * t1])
        cols.append(_blend(c0, c1, (t0 + t1) / 2))
    ax.add_collection(LineCollection(segs, colors=cols, linewidths=lw,
                                     zorder=z, capstyle="round"))


class _GradientDashHandler:
    """Legend swatch for `assoc_gradient_line`: the same dashed gradient, drawn
    at swatch scale. A plain Line2D proxy cannot show a gradient, and the
    convention is the one thing on this panel a reader cannot guess."""

    def __init__(self, c0, c1):
        self.c0, self.c1 = c0, c1

    def legend_artist(self, legend, orig_handle, fontsize, handlebox):
        x0, y0 = handlebox.xdescent, handlebox.ydescent
        w, h = handlebox.width, handlebox.height
        n = 5
        segs, cols = [], []
        for i in range(n):
            t0, t1 = i / n, i / n + 0.62 / n
            segs.append([(-x0 + w * t0, -y0 + h / 2), (-x0 + w * t1, -y0 + h / 2)])
            cols.append(_blend(self.c0, self.c1, (t0 + t1) / 2))
        lc = LineCollection(segs, colors=cols, linewidths=pt(1.84),
                            transform=handlebox.get_transform())
        handlebox.add_artist(lc)
        return lc


def draw_pose(ax, world_pts, stg, color, lw=None, ms=None, z=6):
    lw = pt(1.23) if lw is None else lw
    ms = pt(2.82) if ms is None else ms
    px = proj(stg, world_pts)
    for a, b in ic.MOUSE_EDGE_IDXS:
        ax.add_line(Line2D([px[a, 0], px[b, 0]], [px[a, 1], px[b, 1]],
                            color=color, lw=lw, zorder=z, solid_capstyle="round"))
    ax.scatter(px[:, 0], px[:, 1], s=ms ** 2, color=color, zorder=z + 1,
              edgecolors="white", linewidths=0.6)
    return px


def content_bbox(data, stg, pad=8):
    pts = []
    # ic.render_floor_half, not data["floor_half"]: the scene sizes its plate
    # to what it actually draws, and the crop must contain the SAME rectangle.
    fh = ic.render_floor_half(data)
    floor = np.array([(fh["x0"], fh["y0"], 0), (fh["x1"], fh["y0"], 0),
                      (fh["x1"], fh["y1"], 0), (fh["x0"], fh["y1"], 0)])
    for p in floor:
        pts.append(proj(stg, p))
    for p in (np.concatenate([np.array(data["trail_al_a"]).reshape(-1, 3),
                              np.array(data["trail_al_b"]).reshape(-1, 3)])
              if ic.SHOW_TRAILS else ic.anchor_poses(data).reshape(-1, 3)):
        pts.append(proj(stg, p))
    for tag in ("cam_a", "cam_b"):
        info = data[tag]
        C_al = np.array(info["C_al"])
        m = 55.0   # just the prop itself -- 75 left dead sky above the top camera
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
    # COMPACTION PASS (Eric: "getting rid of the white space" / "the white
    # space at the top needs to go away and be cropped closer to the top
    # camera"): slim margins only -- the labels are short camera names beside
    # their props plus stemmed callouts inside the content area.
    y0 -= 8
    # the fig-level legend row overlaps the axes' lowest strip, and "correct
    # IDs" now sits UNDER the side pane rather than off its right edge.
    y1 += 48
    # the side camera prop, plus room for the "side camera" label that now sits
    # above and right of it (the label is text, so content_bbox cannot measure
    # it -- without the pad the axes clip it and only the ink-trim downstream
    # saves it).
    x1 += 62
    return x0, y0, x1, y1


def main():
    plt.rcParams.update({"font.size": pt(PAGE_LEGEND), "font.family": "sans-serif",
                          "font.sans-serif": ["Liberation Sans", "Arial", "DejaVu Sans"],
                          "text.color": INK})
    data = json.load(open(ic.DATA_JSON))
    stg = cc.StagingCamera.from_dict(json.load(open(ic.STAGING_CAMERA_JSON)))
    img = imread(ic.RENDER_PNG)

    x0, y0, x1, y1 = content_bbox(data, stg)
    aspect = (x1 - x0) / (y1 - y0)
    fig_w = 6.4
    fig, ax = plt.subplots(figsize=(fig_w, fig_w / aspect + 0.3))
    fig.patch.set_facecolor("white")
    ax.imshow(img)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.set_autoscale_on(False)
    ax.axis("off")
    ax.set_position([0, 0.05, 1, 0.93])

    # camera A's own image plane: TRUE identity colours.
    pose_a = np.array(data["cam_a"]["pose_world"])   # (2,15,3): [TRACK_A, TRACK_B]
    px_a = [draw_pose(ax, pose_a[0], stg, ic.COLOR_A),
            draw_pose(ax, pose_a[1], stg, ic.COLOR_B)]

    # camera B's own image plane: SWAPPED identity colours -- the switch,
    # shown happening in a camera's own image plane rather than a side inset.
    pose_b = np.array(data["cam_b"]["pose_world"])
    px_b = [draw_pose(ax, pose_b[0], stg, ic.COLOR_B),
            draw_pose(ax, pose_b[1], stg, ic.COLOR_A)]

    def quad_px(tag):
        info = data[tag]
        qc = np.array(info["quad_center_al"])
        r, d = np.array(info["right_al"]), np.array(info["down_al"])
        hw, hh = info["half_w_al"], info["half_h_al"]
        return np.array([proj(stg, qc + r * su * hw + d * sv * hh)
                         for su in (-1, 1) for sv in (-1, 1)])

    # ---- THE ASSOCIATION TRIANGLES (Eric, 2026-08-25: "it should make a
    # triangule like c but with the incorrect gradients") ----
    #
    # ONE TRIANGLE PER ANIMAL, on 13c's own vertices: its 3D instance, its 2D
    # detection on camera A (side), its 2D detection on camera B (top). 13c
    # draws exactly this shape for each CORRECT correspondence -- see
    # hyp_fig_style.py's "closed TRIANGLE" comment -- so a reader arrives here
    # already knowing what a triangle means. What differs is that camera B's
    # overlay is drawn under the WRONG identity, and every leg touching it
    # says so by running a colour gradient between the two identities:
    #
    #   side (correct)  --  3D          SOLID, the animal's own colour
    #   top  (switched) --  3D          DOTTED, 2D's wrong colour -> 3D's true
    #   side (correct)  --  top         DOTTED, correct colour -> wrong colour
    #
    # so animal A's triangle has a blue corner at the side pane and at the 3D
    # instance, an orange corner at the top pane, and both legs that reach
    # that corner fade blue-to-orange on the way. Animal B's is the mirror.
    # The 2D ends are the TRUNK node, 13c's own anchor point for a detection,
    # not the pose centroid -- it sits on the body rather than floating at the
    # mean of a curled posture.
    #
    # zorder 4/5: over the render and over the panes' photos, under the pose
    # overlays (z=6) and the white swap arrows (z=9), so a leg never buries
    # the instance it is pointing at.
    trunk_a = np.array(data["cam_a"]["trunk_world"])   # (2,3), [TRACK_A, TRACK_B]
    trunk_b = np.array(data["cam_b"]["trunk_world"])
    anchors = ic.anchor_poses(data)                    # (2,15,3) at IMAGE_FRAME
    true_col = [ic.COLOR_A, ic.COLOR_B]
    for k in range(2):
        p3d = proj(stg, anchors[k].mean(axis=0))
        p_side = proj(stg, trunk_a[k])
        p_top = proj(stg, trunk_b[k])
        wrong_col = true_col[1 - k]   # what camera B drew this animal as
        assoc_line(ax, p_side, p3d, true_col[k], z=5)
        assoc_gradient_line(ax, p_top, p3d, wrong_col, true_col[k], z=5)
        assoc_gradient_line(ax, p_side, p_top, true_col[k], wrong_col, z=4)
        # the two 2D corners, dotted in 13c's own way (a filled disc in the
        # colour that pane assigned, white-edged so it reads on the photo).
        for p, c in ((p_side, true_col[k]), (p_top, wrong_col)):
            ax.scatter(*p, s=52, color=c, edgecolor="white", linewidths=1.0,
                       zorder=8)

    # ANNOTATIONS (Eric: "two large white curved arrows on both sides of the
    # instances which indicate the switching, then 'ID switch' should be a
    # stem leading to those, then 'correct IDs' on the side should be a stem
    # as well. then 'top' and 'side' should be labelled near where the
    # cameras are").
    # -- the swap arrows on camera B's pane: one on each side of the two
    # overlaid instances, each curving from one animal's centroid toward the
    # other's, white so they read on the photo. LARGE on purpose.
    c0, c1 = px_b[0].mean(axis=0), px_b[1].mean(axis=0)
    v = c1 - c0
    L = np.linalg.norm(v)
    vhat = v / L
    nhat = np.array([-v[1], v[0]]) / L
    m_pair = (c0 + c1) / 2
    outline = [pe.withStroke(linewidth=pt(5.21), foreground="#3A3A3A")]
    # left arrow: flanks the pair at a fixed offset. right arrow: pushed fully
    # PAST the blue-drawn instance (its extent along -nhat plus a margin) and
    # MIRRORED (Eric: "the right arrow ... needs to be reflected horizontally
    # and moved to the right of the blue instance so that it is not colliding
    # with the blue instance").
    off_left = 0.72 * L + 20
    off_right = float(np.max((px_b[1] - m_pair) @ (-nhat))) + 12
    for sign, off, rad in ((1, off_left, 0.38), (-1, off_right, -0.38 * -1)):
        a0, a1 = (c0, c1) if sign > 0 else (c1, c0)
        p0 = a0 - vhat * 0.20 * L * sign + nhat * off * sign
        p1 = a1 + vhat * 0.20 * L * sign + nhat * off * sign
        arr = FancyArrowPatch(
            p0, p1, connectionstyle=f"arc3,rad={rad}",
            arrowstyle="-|>", mutation_scale=pt(12.3), lw=pt(2.58), color="white",
            shrinkA=0, shrinkB=0, zorder=9, capstyle="round")
        arr.set_path_effects(outline)
        ax.add_patch(arr)

    def pane_edge_point(tag, txt, target):
        """Where the txt->target line first enters the quad -- keeps a callout
        stem on white canvas (a black stem vanishes on the dark photos)."""
        corners = quad_px(tag)  # (su,sv) order: (-1,-1),(-1,1),(1,-1),(1,1)
        poly = MplPath(corners[[0, 2, 3, 1]])
        for t in np.linspace(0, 1, 200):
            p = txt + t * (target - txt)
            if poly.contains_point(p):
                return p + 0.04 * (target - txt)
        return target

    # -- stemmed callouts, each anchored to a fixed corner of its own pane so
    # the two texts land in DIFFERENT white areas (a generic away-from-centre
    # placement dropped both into the same inter-pane gap, overlapping).
    corners_b = quad_px("cam_b")
    apex_b = m_pair + nhat * (off_left + 0.30 * L)  # near the left arrow's bow
    tr_b = corners_b[np.argmax(corners_b[:, 0] - corners_b[:, 1])]  # top-right corner
    txt_b = tr_b + np.array([60, -30])
    ax.annotate("ID switch", xy=apex_b, xytext=txt_b, fontsize=pt(PAGE_CALLOUT),
               fontweight="bold", color=INK, ha="left", va="center",
               annotation_clip=False,
               arrowprops=dict(arrowstyle="-", color=INK, lw=pt(0.86),
                               shrinkA=3, shrinkB=4))

    # -- camera A's pane: "correct IDs" TUCKED UNDER the side image plane
    # (Eric, 2026-08-25: "just tuck the correct ids under the side view a
    # little more"), stem up to the pane edge pointing at the two skeletons.
    # It used to hang off the pane's RIGHT edge, which cost the crop a 260 px
    # right margin of pure white -- and that margin is the width the fig13 row
    # then had to spend on this panel instead of on the data cells beside it
    # ("make the e,g,f,h larger with the space opened up by moving the correct
    # ids under the side image a bit"). Under the pane the label sits in space
    # the composition already owns.
    m_a = (px_a[0].mean(axis=0) + px_a[1].mean(axis=0)) / 2
    corners_a = quad_px("cam_a")
    bottom_a = corners_a[np.argmax(corners_a[:, 1])]   # lowest corner
    txt_a = np.array([bottom_a[0] + 30, bottom_a[1] + 34])
    ax.annotate("correct IDs", xy=pane_edge_point("cam_a", txt_a, m_a), xytext=txt_a,
               fontsize=pt(PAGE_CALLOUT), fontweight="bold", color=INK, ha="center", va="top",
               annotation_clip=False,
               arrowprops=dict(arrowstyle="-", color=INK, lw=1.4,
                               shrinkA=3, shrinkB=4))

    # -- short camera names at the props, placed just PAST the prop's own
    # projected extent so text never overlaps the rendered box (Eric: "the
    # camera label for top camera needs to not collide with the camera
    # renndering").
    # PLACEMENT IS DECLARED, NOT INFERRED -- ic.CAM_*_LABEL_POS; see the
    # constant's own comment for the two guesses the side camera defeated.
    # PROP_LABEL_R (not content_bbox's 55) is the half-extent the label hugs:
    # 55 mm is a generous box for "keep the prop inside the crop", but the
    # camera unit cs.build_camera_unit actually draws is smaller, so offsets
    # measured off 55 left a visible gap between each name and its own
    # rendering (Eric: "makje sure the camera rendering and camera label are
    # close together in 13d").
    PROP_LABEL_R = 30.0
    GAP = 10.0
    # TWO LINES, ROLE OVER THE WORD "camera" (Eric, 2026-08-25: "should just
    # say top camera and side camera maybe stacked vertically so it says side
    # above camera and top above camera"). Stacked rather than inline because
    # each label has to fit in a gap beside its own prop, and "side camera" set
    # on one line is nearly twice as wide as the prop itself. hyp_fig_style.py
    # (13c) builds its two the same way, so the two panels' camera labels are
    # the same words in the same shape at the same size.
    label_a = f'{data.get("cam_a_label", data["cam_a_name"])}\ncamera'
    label_b = f'{data.get("cam_b_label", data["cam_b_name"])}\ncamera'
    for tag, text, where in (("cam_a", label_a, ic.CAM_A_LABEL_POS),
                             ("cam_b", label_b, ic.CAM_B_LABEL_POS)):
        C_al = np.array(data[tag]["C_al"])
        cam_px = proj(stg, C_al)
        prop = np.array([proj(stg, C_al + np.array([sx, sy, sz]) * PROP_LABEL_R)
                         for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
        if where == "corner":
            # prop hidden behind its own quad: label that quad's bottom-right
            # corner instead.
            corners = quad_px(tag)
            corner_br = corners[np.argmax(corners.sum(axis=1))]
            ax.annotate(text, xy=corner_br, xytext=(0, -6), textcoords="offset points",
                       fontsize=pt(PAGE_CAMERA), fontweight="bold", color=INK, ha="right", va="top")
        elif where == "above":
            # centred just ABOVE the prop (Eric: "bring 'side' slightly above
            # the camera reandering") -- under it, the pane's own lower half
            # is in the way; the sky beside the pane's top-right is empty.
            # UP AND A LITTLE RIGHT of the prop (Eric: "the side label would
            # need to go up to the right a tiny bit", and then again: "the side
            # camera label is colliding with the side image plane and needs to
            # be moved slightly upwards and maybe a hair to the right"): the
            # pane's top corner rises toward the prop on this side, and a
            # two-line label centred straight above it reaches into that
            # corner -- at 2.2 GAP the word "camera" still overlapped the
            # pane's edge on the assembled page.
            ax.text(cam_px[0] + 4.8 * GAP, prop[:, 1].min() - 3.0 * GAP, text,
                    fontsize=pt(PAGE_CAMERA), linespacing=1.15,
                    multialignment="center",
                    fontweight="bold", color=INK, ha="center", va="bottom")
        else:
            # to the right of the prop, vertically centred on it.
            # multialignment="center": the two lines are centred ON EACH
            # OTHER whatever `ha` anchors the block by (Eric: "make sure top is
            # above camera but center aligned"). Without it a left-anchored
            # block sets "top" flush-left under "camera", which is what the
            # first stacked version did.
            ax.text(prop[:, 0].max() + GAP, cam_px[1], text,
                    fontsize=pt(PAGE_CAMERA), linespacing=1.15,
                    multialignment="center",
                    fontweight="bold", color=INK, ha="left", va="center")

    # NO "identity ambiguous after crossing" ENTRY any more: that named the
    # grey post-crossing trail steps, and with SHOW_TRAILS off there is no
    # grey mark on the panel to name. Its slot goes to the gradient
    # convention, which is the one thing here a reader cannot infer -- drawn
    # by _GradientDashHandler, since a Line2D proxy cannot carry a gradient.
    grad_proxy = Line2D([0], [0], lw=0)
    legend_handles = [Line2D([0], [0], color=ic.COLOR_A, lw=pt(1.84), label="Animal 1"),
                      Line2D([0], [0], color=ic.COLOR_B, lw=pt(1.84), label="Animal 2"),
                      grad_proxy]
    fig.legend(handles=legend_handles,
              labels=["Animal 1", "Animal 2", "same animal, switched identity"],
              handler_map={grad_proxy: _GradientDashHandler(ic.COLOR_A, ic.COLOR_B)},
              loc="lower center", ncol=3, frameon=False,
              fontsize=pt(PAGE_LEGEND), labelcolor=INK, bbox_to_anchor=(0.5, 0.0),
              handlelength=1.9, columnspacing=1.2, handletextpad=0.5)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, ic.OUT_PNG_NAME)
    fig.savefig(out_path, dpi=300, facecolor="white")
    print("wrote", out_path, "figsize", fig.get_size_inches())


if __name__ == "__main__":
    main()
