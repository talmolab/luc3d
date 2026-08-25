#!/usr/bin/env python3
"""Composite the Chen et al. (2020) Fig. 2 -style correspondence figure: ONE
Blender render (blender-images/fig_chen_correspondence.py) holding both
sub-panels side by side, with every dot/line/label added here as vector
annotations (matplotlib), placed by analytically re-projecting the same real
3D quantities through the exact staging camera the render used
(blender-images/chen_common.StagingCamera + PANEL_OFFSET_M). Nothing here is
drawn in Blender, so wording/placement tweaks are instant -- no re-render
needed.

    python3 fig_chen2020_style.py

Reads blender-images/renders/{chen_fig_data.json, chen_staging_camera.json,
chen_correspondence_combined.png}. Writes
figures/drafts/figs/lucid_chen2020_style.png.

Sized as a SMALL diagram (Eric: meant to eventually sit inside Fig 3, not as a
standalone full-page figure) -- ~3.4 x 2.0 in at 300 dpi, cropped tightly to
the real content rather than the render's mostly-white canvas.
"""
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

RENDERS = os.path.join(HERE, "blender-images", "renders")
OUT_DIR = os.path.join(HERE, "figures", "drafts", "figs")
OUT_PATH = os.path.join(OUT_DIR, "lucid_chen2020_style.png")

# Per Eric: plain black text, not the house-style muted grey/ink.
INK = "#000000"
MAIN = cc.TAB10_MAIN
OTHER = cc.TAB10_OTHER
#: the retained-anchor ghost. Same-day colour history (Eric, 2026-08-25): first
#: "gray and slightly transparent outline" -- but grey blended into the
#: grayscale photo ("i cant really see it in 2D correspondence") -- then "darker
#: and transparent blue ... like the 3d anchor ghost in the 3d correspondence",
#: which is panel b's translucent blue mesh. So: MAIN's hue darkened, semi-
#: transparent, still dashed with hollow dots so prior and detection stay two
#: different KINDS of mark, not two skeletons split only by dash pattern.
GHOST = "#14507e"
GHOST_ALPHA = 0.65
ANCHOR_GREY = "#5A5A5A"


def proj(stg, P, panel):
    """chen_fig_data.json stores 3D quantities in mm (aligned frame, LOCAL to
    one panel, i.e. before the panel offset); the staging camera works in
    meters over the WHOLE combined scene -- convert units and add this
    panel's world offset before projecting."""
    return stg.project(np.asarray(P) * cc.MM + cc.PANEL_OFFSET_M[panel])


def image_plane_hit(data, P):
    """Where the REAL camera sees a 3D point on the image-plane quad.

    The quad is built (chen_fig_prep.quad_point) as a flat plane at a fixed
    depth along the camera's forward axis, spanned by right_al/down_al -- i.e.
    it IS this camera's image plane, scaled up for legibility. So the point
    where the camera images a 3D position X is exactly where the line C -> X
    crosses that plane, which is what this returns (aligned frame, mm).

    This is the same construction the drawn epipolar ray already asserts: that
    ray runs C -> X_t(mu) and visually passes through x_t on the photo. Doing
    the ghost the same way keeps the 2D residual and the 3D residual two views
    of ONE geometric fact rather than two independently placed annotations.
    """
    C = np.asarray(data["C_al"], float)
    qc = np.asarray(data["quad_center_al"], float)
    n = np.cross(np.asarray(data["right_al"], float),
                 np.asarray(data["down_al"], float))
    v = np.asarray(P, float) - C
    return C + v * (np.dot(qc - C, n) / np.dot(v, n))


def draw_pose(ax, world_pts, stg, panel, color, lw=1.1, ms=3.0, ls="-", alpha=1.0, z=5,
             halo=False, dot_face=None, dot_edge="white", dot_edge_lw=0.6):
    """SINCE 2026-08-25 this is the PAPER'S overlay mark (Eric: "lets make the
    overlays the same style as all the other overlays in the paper"): solid
    coloured edges + white-rimmed dots, the src/skeleton_style.draw_pose_overlay
    vocabulary that Figs 1c/1d/2a/13c/13d all carry -- re-implemented here rather
    than imported because this compositor projects through its own staging camera
    and per-panel offset. `dot_face`/`dot_edge` expose the ghost variant (hollow
    grey-rimmed dots)."""
    px = proj(stg, world_pts, panel)
    if halo:
        # a white halo under the line/markers -- the retained-anchor pose is
        # otherwise nearly invisible against the busy grayscale photo (Eric:
        # "the distance shown in 2D in gray is far too difficult to see").
        for a, b in cc.MOUSE_EDGE_IDXS:
            ax.add_line(Line2D([px[a, 0], px[b, 0]], [px[a, 1], px[b, 1]],
                                color="white", lw=lw + 1.6, ls="-", alpha=0.9,
                                zorder=z - 1, solid_capstyle="round"))
        ax.scatter(px[:, 0], px[:, 1], s=(ms + 2.2) ** 2, color="white",
                  alpha=0.9, zorder=z - 1, linewidths=0)
    for a, b in cc.MOUSE_EDGE_IDXS:
        ax.add_line(Line2D([px[a, 0], px[b, 0]], [px[a, 1], px[b, 1]],
                            color=color, lw=lw, ls=ls, alpha=alpha, zorder=z,
                            solid_capstyle="round"))
    ax.scatter(px[:, 0], px[:, 1], s=ms ** 2,
               facecolors=(dot_face if dot_face is not None else color),
               edgecolors=dot_edge, linewidths=dot_edge_lw, alpha=alpha,
               zorder=z + 1)
    return px


#: every label/leader-line offset below is in POINTS (fixed physical size),
#: not data pixels -- so placement doesn't have to be retuned when the
#: render resolution changes. Offsets are kept SMALL (labels close to their
#: point) per Eric's request.
def dashed_line(ax, p0, p1, color, z=8, lw=1.0, dashes=(0, (3, 2)), halo=False):
    if halo:
        # a white halo under the dashes -- otherwise a thin dark line is hard
        # to read against the busy grayscale photo (Eric: "the distance shown
        # in the 2D image plane ... look more clear").
        ax.add_line(Line2D([p0[0], p1[0]], [p0[1], p1[1]], color="white",
                            lw=lw + 2.2, ls="-", alpha=0.9, zorder=z - 1))
    ax.add_line(Line2D([p0[0], p1[0]], [p0[1], p1[1]], color=color, lw=lw,
                        ls=dashes, zorder=z))


def label(ax, xy, text, dxdy=(6, -6), fontsize=9.5, color=INK, style="italic",
          weight="normal", ha="left", va="center", leader=True, box=True,
          ma=None):
    kw = dict(boxstyle="round,pad=0.1", fc="white", ec="none", alpha=0.75) if box else None
    arrow = dict(arrowstyle="-", color=color, lw=0.5, shrinkA=0, shrinkB=3) if leader else None
    ax.annotate(text, xy=xy, xycoords="data", xytext=dxdy, textcoords="offset points",
                fontsize=fontsize, color=color, fontstyle=style, fontweight=weight,
                ha=ha, va=va, zorder=20, bbox=kw, arrowprops=arrow,
                multialignment=ma or ha)


#: Panel a's 2D ghost is PLACED in the bottom-right corner of the image plane rather
#: than left where the animal really was (Eric, 2026-08-20: "move it to the right of the
#: image plane, so its in the bottom right corner?", after "make the ghost ... more far
#: away from the animal, so we can see them and clearly see that distance metric").
#:
#: READ THIS BEFORE QUOTING THE PANEL. Two earlier steps exaggerated the ghost's
#: MAGNITUDE along its own true offset -- 71 px real -> 127 px drawn, the most the photo
#: could hold -- which is panel b's precedent (cc.exaggerated_ghost) and keeps the claim
#: "the animal was back THERE" intact. Putting it in a CORNER gives up that direction:
#: the drawn separation is now a composition choice, not a measured displacement, so the
#: line's length and heading say nothing about where the animal actually was. It is a
#: schematic of WHAT IS MEASURED (anchor node -> current node in one view), which is
#: what this panel is for. The real number is untouched in the data
#: (data["d2d_px"] = 71.3) and is what any caption or Methods figure must cite; do NOT
#: describe the drawn gap as the animal's motion.
#:
#: STILL RIGID -- every node moves by one vector, so the ghost's shape is the anchor's
#: exactly. Per-node scaling balloons it into a distorted skeleton ("the ghost is
#: gigantic" -- Eric).
#:
#: WHICH CORNER IS WHICH: the quad's +u projects to screen-LEFT under this staging
#: camera (screen dir -0.98, +0.20) and +v to screen-DOWN (-0.16, +0.99), so the
#: bottom-right corner ON SCREEN is quad uv (u = -1, v = +1), NOT (+1, +1). Verified by
#: projecting all four corners: (-1,-1) lands top-right at x=980, (-1,+1) bottom-right
#: at x=921,y=493. Anyone re-tuning this by editing the sign of u will move it the wrong
#: way.
GHOST_2D_CORNER_UV = (-0.97, 0.97)      # (u, v) the ghost's bbox is pushed into


def place_ghost_2d_corner(data, anchor_pose, corner_uv=GHOST_2D_CORNER_UV):
    """Rigidly translate the on-quad anchor pose into one corner of the image plane.

    The ghost spans ~1.15 of the quad's 2.0-wide u axis, so it cannot sit *inside* a
    corner -- what this does is push its bounding box until it touches the two corner
    edges, which lands it in the bottom-right half hugging that corner. Inset to 0.97
    rather than 1.0 so the outermost node's marker and its halo stay on the photo; a
    pose clipped by the image-plane edge reads as a rendering bug.
    """
    qc = np.asarray(data["quad_center_al"], float)
    right = np.asarray(data["right_al"], float)
    down = np.asarray(data["down_al"], float)
    hw, hh = data["half_w_al"], data["half_h_al"]
    crop_w = data["crop_size_px"][0]
    mm_per_px = hw / (crop_w / 2)

    A = np.asarray(anchor_pose, float)
    M = np.asarray(data["current_pose_main_world"], float)
    t = data["measure_idx"]
    u = (A - qc) @ right / hw
    v = (A - qc) @ down / hh

    # push toward the corner: u to its target (negative = screen right), v likewise.
    # `min`/`max` pick the edge each target implies -- u<0 pins u_min, v>0 pins v_max --
    # so the same call works if the corner is ever moved to another quadrant.
    du = corner_uv[0] - (u.min() if corner_uv[0] < 0 else u.max())
    dv = corner_uv[1] - (v.min() if corner_uv[1] < 0 else v.max())
    ghost = A + right * (du * hw) + down * (dv * hh)

    drawn_px = np.linalg.norm(ghost[t] - M[t]) / mm_per_px
    real_px = np.linalg.norm(A[t] - M[t]) / mm_per_px
    gu = (ghost - qc) @ right / hw
    gv = (ghost - qc) @ down / hh
    assert max(np.abs(gu).max(), np.abs(gv).max()) <= 1.0, "ghost left the image plane"
    print(f"  panel a 2D ghost: placed in corner uv{corner_uv}; drawn gap "
          f"{drawn_px:.0f} px ({100 * drawn_px / crop_w:.0f}% of crop width) vs the real "
          f"{real_px:.1f} px -- SCHEMATIC, see the note above the function")
    return ghost


def panel_a(ax, data, stg):
    # THE WHOLE GHOST POSE IS DRAWN ON THE IMAGE PLANE (Eric, 2026-08-20: "the ghost
    # should be in the image plane of the 2d correspondence as well"). This REVERSES
    # an earlier decision to mark only the anchor's trunk point, which was taken
    # because a second full pose sitting almost on top of the real one was illegible
    # at any colour ("far too difficult to see"). What makes it legible now is the
    # treatment, not the geometry: faded, DASHED, under the detected pose (z=6 vs 7),
    # and carrying draw_pose's white halo, so it reads as a prior rather than as a
    # third animal. The marked node and the distance line are unchanged -- the pose
    # is context for a measurement that was already here, so if it ever crowds the
    # photo again the pose is the part to drop, not the line.
    #
    # `anchor_pose_world` is already ON the quad (chen_fig_prep.quad_point maps the
    # anchor's own detected pixels onto it), so nothing is reprojected here -- this
    # is the retained anchor exactly as the camera recorded it, then MOVED into the
    # image plane's bottom-right corner by place_ghost_2d_corner -- read the note above
    # that function before describing the drawn gap as anything measured.
    ghost_pose = place_ghost_2d_corner(data, data["anchor_pose_world"])
    anchor_all_px = draw_pose(ax, ghost_pose, stg, "a", GHOST,
                              lw=0.9, ms=2.2, ls=(0, (2.2, 1.6)),
                              alpha=GHOST_ALPHA, z=6, halo=True,
                              dot_face="none", dot_edge=GHOST, dot_edge_lw=0.8)
    draw_pose(ax, data["current_pose_other_world"], stg, "a", OTHER, z=5)
    main_px = draw_pose(ax, data["current_pose_main_world"], stg, "a", MAIN, z=7)

    t = data["measure_idx"]
    anchor_t = anchor_all_px[t]
    dashed_line(ax, anchor_t, main_px[t], INK, lw=1.6, dashes=(0, (4, 2.5)), halo=True)
    # BLACK edge, matching the black circle on panel b's ghost: the two panels now
    # mark "the point the distance is measured FROM" the same way. Was ANCHOR_GREY,
    # which is why the legend's third entry no longer names a grey line.
    ax.scatter(*anchor_t, s=34, facecolor="white", edgecolor=INK,
              linewidths=1.8, zorder=10)
    ax.scatter(*main_px[t], s=22, color=INK, zorder=10)
    # BOTH NAMES (Eric, 2026-08-20: "lets give it a math name and the colloquial name,
    # so give it both"), and NODE rather than Instance -- Eric's own suggestion, and the
    # figure's notation requires it: lowercase x is a 2D POINT at one keypoint
    # (cc.MEASURE_NODE_NAME = Shoulder_left), which is what the circle marks and what
    # the distance is measured between. The *instance* is the dashed pose around it, so
    # "Anchor Instance ($x_{t''}$)" would have had the words contradict the symbol.
    # Upright words, italic symbol: mathtext inside $..$ keeps its own style, so the
    # name reads as a name and the symbol as a symbol in one line.
    # Set BELOW-LEFT of the node since 2026-08-25 (Eric: "move the 2D Anchor
    # Node (Xt)'' label to the left because it is colliding with the image plane
    # on the right") -- below-right ran the (now larger) text into panel b's
    # photo. Below-left at this offset lands in the empty floor-plane white
    # UNDER the detected pose, not across it, which is what the old below-left
    # placement got wrong.
    # TWO LINES: at 9.5 pt the one-line form is ~340 px and, extending left,
    # widened the whole figure's content crop (the fig11 geometry guard caught
    # the aspect drift); wrapped it stays inside the floor plane.
    # UP AND TO THE RIGHT (Eric, 2026-08-25, third placement this label has
    # needed): below-right ran into panel b's photo, below-left onto the
    # triangulated blue pose. Above-right sits in the gap between panel a's
    # image plane and panel b's content -- the wrapped two-line form is what
    # keeps it out of panel b.
    # "2D Anchor" over "Node (x_t'')", CENTRED (Eric, 2026-08-25: "stack 2D
    # Anchor on top of Node (xt'') so it doesnt take up so much room? centered
    # alignment, then do the same with the 3d anchor node label") -- the balanced
    # two-line block is narrower than the name-then-symbol wrap it replaces.
    # x = 11.6 pt: +1.5, +0.5, then +0.2 mm ON THE PAGE, all on instruction
    # (Eric, 2026-08-25) -- the PNG places at 91.74 of its 111.8 mm figsize in
    # fig11, so one page mm is 72/25.4/0.8206 = 3.45 figure pt.
    label(ax, anchor_t, "2D Anchor\n" + r"Node ($x_{t''}$)", dxdy=(11.6, 9),
          ha="left", va="bottom", color=INK, style="normal", ma="center")
    label(ax, main_px[t], r"$x_t$", dxdy=(9, 8), ha="left", color=INK)


def panel_b(ax, data, stg):
    draw_pose(ax, data["current_pose_other_world"], stg, "b", OTHER, z=5)
    main_px = draw_pose(ax, data["current_pose_main_world"], stg, "b", MAIN, z=7)
    t = data["measure_idx"]
    x_t_px = main_px[t]

    C_al = np.array(data["C_al"])
    ray_dir = np.array(data["ray_dir_al"])
    true_param = data["true_ray_param_mm"]
    ray_start = C_al + ray_dir * (true_param * 0.18)     # a bit past the camera/plane
    ray_end = C_al + ray_dir * (true_param * 1.35)        # a bit past X_t(mu)
    X_true_t = np.array(data["X_true_al"])[t]
    # ghost anchored to the TRUE pose (matches the solid mesh in
    # fig_chen_correspondence.py) -- its visible offset is the exaggerated
    # PREDICTION ERROR, not the anchor-to-now displacement.
    ghost_pose_render = cc.exaggerated_ghost(np.array(data["X_true_al"]),
                                             np.array(data["X_hat_al"]), ray_dir)
    X_hat_render = ghost_pose_render[t]
    closest_render = C_al + ray_dir * np.dot(X_hat_render - C_al, ray_dir)

    ray_px = proj(stg, np.array([ray_start, ray_end]), "b")
    Xtrue_px = proj(stg, X_true_t, "b")
    Xc_px = proj(stg, C_al, "b")
    Xhat_px = proj(stg, X_hat_render, "b")
    closest_px = proj(stg, closest_render, "b")

    # the epipolar/back-projection ray: dashed, thick -- this is the one 3D
    # line the whole panel is about.
    ax.add_line(Line2D(ray_px[:, 0], ray_px[:, 1], color=INK, lw=2.2,
                        ls=(0, (4.5, 3)), zorder=6, solid_capstyle="round"))
    ax.scatter(*Xtrue_px, s=22, color=INK, zorder=9)
    ax.scatter(*Xhat_px, s=22, facecolor="none", edgecolor=INK, linewidths=1.4, zorder=9)

    # BLACK, not the animal's blue (Eric, 2026-08-20: "make the dotted blue line
    # black with a black circle on the ghost"). The residual is a MEASUREMENT, not
    # part of the animal, and in blue it read as another skeleton edge; the black
    # circle on the ghost above says the same thing. It stays thin and short-dashed
    # so it cannot be confused with the thick long-dashed epipolar ray, which is now
    # the only other black line in the panel.
    dashed_line(ax, Xhat_px, closest_px, INK, lw=1.0)

    # NO GHOST ON THIS PANEL'S PHOTO (Eric, 2026-08-20: "not in the 3d"). It was
    # briefly drawn here; the ghost overlay belongs on panel a's image plane, which
    # is the 2D-correspondence panel. Panel b keeps ONE residual -- ghost to ray, in
    # 3D -- which is the term it exists to show.

    # X_c: label only, no marker dot -- a dot here just sits on top of (and
    # hides) the camera prop's own lens. Pushed further left + a short leader
    # now that it's far enough to need one, so the text itself clears the cube.
    label(ax, Xc_px, r"$X_c$", dxdy=(-26, -14), color=INK, leader=True)
    # SAME RELATIVE PLACEMENT AS PANEL a's x_t (up-right of the node; Eric,
    # 2026-08-25: "make sure Xt is placed similarly relative to the instances")
    # -- it sat up-left here, so the same symbol hung on opposite sides in the
    # two panels.
    label(ax, x_t_px, r"$x_t$", dxdy=(9, 8), ha="left", color=INK)
    # X_t(mu) and X_hat_t sit close together (the ghost is now anchored to the
    # true pose, so its offset is just the small prediction-error residual) --
    # putting their labels on OPPOSITE sides (left/right) keeps both stems
    # short and guarantees they don't cross. X_t(mu) leans toward the epipolar
    # line it sits on; X_hat_t leans away from it, to the right.
    label(ax, Xtrue_px, r"$X_t(\mu)$", dxdy=(-6, -10), ha="right", color=INK)
    # Same treatment as panel a's -- see there for why it is Node and not Instance.
    # Kept ABOVE-RIGHT with its leader, where the bare symbol was: that is the only
    # side clear of the epipolar ray and of X_t(mu)'s own label.
    # TWO LINES for the same reason as panel a's anchor label (one line at
    # 9.5 pt drove the crop aspect off the fig11-solved value), split and
    # CENTRED the same way as panel a's so the two anchor labels read as a pair.
    label(ax, Xhat_px, "3D Anchor\n" + r"Node ($\hat{X}_t$)", dxdy=(14, 12),
          ha="left", color=INK, style="normal", ma="center")


#: BUG this fixes: the crop used to include only the camera's CENTER point
#: (C_al), not its rendered footprint -- cage_scene.build_camera_unit's body
#: is a 0.042x0.042x0.058m box plus a lens/hood extending further forward, so
#: the cube's silhouette extends well past its own center in every direction.
#: For panel a (the leftmost panel) the floor's own left edge sat CLOSER to
#: the crop boundary than the camera center did, so the crop's left edge cut
#: straight through the camera body -- reproduced by checking the numbers
#: (panel a floor left edge vs. camera center vs. the cube's ~90-120px
#: half-extent at this render scale: the gap between them was under 50px).
#: This margin (world meters, isotropic -- safe regardless of the camera's
#: rotation) bounds the whole assembly (body + lens + hood).
CAMERA_PROP_MARGIN_M = 0.075


def content_bbox(data, stg, pad=14):
    """Bounding box (px, in the render's own pixel space) of the real content
    -- floor corners, image-plane quad corners, camera FOOTPRINT -- across
    BOTH panels, so the saved figure can crop away the render's mostly-white
    canvas instead of shipping it at full size."""
    pts = []
    floor = cc.floor_corners_mm(data["floor_half"])
    C_al = np.array(data["C_al"])
    right_al, down_al = np.array(data["right_al"]), np.array(data["down_al"])
    hw, hh = data["half_w_al"], data["half_h_al"]
    qc = np.array(data["quad_center_al"])
    quad_corners = np.array([qc - right_al * hw - down_al * hh, qc + right_al * hw - down_al * hh,
                             qc + right_al * hw + down_al * hh, qc - right_al * hw + down_al * hh])
    m = CAMERA_PROP_MARGIN_M * 1000  # mm, to match the other quantities here
    camera_bbox_corners = np.array([C_al + np.array([sx, sy, sz]) * m
                                    for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    for panel in ("a", "b"):
        for p in floor:
            pts.append(proj(stg, p, panel))
        for p in quad_corners:
            pts.append(proj(stg, p, panel))
        for p in camera_bbox_corners:
            pts.append(proj(stg, p, panel))
    pts = np.array(pts)
    x0, y0 = pts.min(axis=0) - pad
    x1, y1 = pts.max(axis=0) + pad
    # the camera prop's own extent is now in `pts` (camera_bbox_corners above);
    # this is ONLY for the panel title text that sits above the camera.
    y0 -= 55
    return x0, y0, x1, y1


def main():
    plt.rcParams.update({"font.size": 7.0, "font.family": "sans-serif",
                          "font.sans-serif": ["Liberation Sans", "Arial", "DejaVu Sans"],
                          "text.color": INK})
    data = cc.load_json()
    stg = cc.StagingCamera.from_dict(
        json.load(open(os.path.join(RENDERS, "chen_staging_camera.json"))))

    img = imread(os.path.join(RENDERS, "chen_correspondence_combined.png"))

    x0, y0, x1, y1 = content_bbox(data, stg)
    aspect = (x1 - x0) / (y1 - y0)
    fig_w = 4.4
    fig, ax = plt.subplots(figsize=(fig_w, fig_w / aspect + 0.35))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.imshow(img)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y1, y0)
    ax.set_autoscale_on(False)
    ax.axis("off")
    ax.set_position([0, 0.06, 1, 0.94])  # fill the canvas -- no dead margin left/bottom

    panel_a(ax, data, stg)
    panel_b(ax, data, stg)

    # panel titles, placed above each panel's own camera (found by projecting
    # each panel's real camera center) rather than a fixed fraction of width
    cam_a_px = proj(stg, data["C_al"], "a")
    cam_b_px = proj(stg, data["C_al"], "b")
    # NO "(a)/(b)" prefixes since 2026-08-25: the diagram now ships INSIDE Fig 11
    # (panels/fig11_00_chen_style.py), whose own panel letters would clash with
    # internal sub-letters. The two titles alone carry the split.
    # 10 pt, and the labels/legend at 9.5/9 (Eric, 2026-08-25: "make the labels
    # and text bigger in 11e it is too hard to see xt the anchor labels, the
    # xtmu and the legend is too small as well!") -- the PNG places at 91.4 mm of
    # its 111.8 mm figsize in fig11, so everything prints at 0.82x these sizes.
    ax.text(cam_a_px[0], y0 + 10, "2D correspondence", fontsize=10, color=INK,
            ha="center", va="top")
    ax.text(cam_b_px[0], y0 + 10, "3D correspondence", fontsize=10, color=INK,
            ha="center", va="top")

    legend_handles = [
        Line2D([0], [0], color=MAIN, lw=1.6, label="Animal 1"),
        Line2D([0], [0], color=OTHER, lw=1.6, label="Animal 2"),
        # STILL "retained anchor", because that is the only thing this swatch can
        # honestly name: the dashed pose is drawn in panel a ONLY, and there it
        # IS the retained anchor. Panel b's ghost is a translucent solid mesh from
        # the Blender render, not a dashed line, so a swatch reading "ghost" would
        # describe an object that appears nowhere in the panel it would send the
        # reader to; X-hat_t labels it on the artwork instead, as it always did.
        # GREY AGAIN since 2026-08-25 (with the ghost itself -- see GHOST above).
        Line2D([0], [0], color=GHOST, lw=1.0, ls=(0, (2.2, 1.6)), alpha=GHOST_ALPHA,
               label="retained anchor"),
    ]
    fig.legend(handles=legend_handles, loc="lower center", ncol=3, frameon=False,
              fontsize=9.0, labelcolor=INK, bbox_to_anchor=(0.5, -0.01),
              handlelength=1.6, columnspacing=1.0, handletextpad=0.5)

    os.makedirs(OUT_DIR, exist_ok=True)
    fig.savefig(OUT_PATH, dpi=300, bbox_inches="tight", facecolor="white")
    print("wrote", OUT_PATH, "figsize", fig.get_size_inches())


if __name__ == "__main__":
    main()
