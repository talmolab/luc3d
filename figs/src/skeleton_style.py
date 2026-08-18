"""
Surface-filled pose skeletons -- the viz_08 look, for matplotlib panels.

Any panel that renders a REAL animal pose (the 15-node SLAP mouse skeleton)
draws it through this module, so every pose in the set is the same animal:
translucent body membranes, clean round-capped edges, joint dots, one colour
per animal. Bare stick-and-dot skeletons read as wireframes; the membranes are
what make the marks read as a body (compare
`blender-images/renders/cage_two_mice.png`, which is this exact styling
rendered in Blender).

MOUSE_SURFACES and MOUSE_EDGES are copied VERBATIM from
`blender-images/cage_scene.py`, which itself carries them verbatim from viz_08
cell 16 -- the notebook that defined the look. They are duplicated here rather
than imported because `blender-images/` only imports under Blender's `bpy`;
keep the three copies (notebook, cage_scene.py, here) in sync if the skeleton
ever changes.

Caveat, in the spirit of cage_scene.py's east_wall note: several MOUSE_EDGES
duplicate each other or run under a filled surface (e.g. ``Haunch_right--TTI``
appears twice, and the shoulder/haunch cross-braces are interior to the torso
membranes). That is how viz_08 drew it and the redundancy is harmless -- edges
are opaque strokes of one colour -- so the lists are kept verbatim rather than
de-duplicated.

Missing nodes are handled the way viz_08 handles them: any surface or edge
touching a NaN node is skipped, and NaN joints get no dot.

API:

    from src.skeleton_style import draw_skeleton_2d, draw_skeleton_3d, SLAP_NODES
    draw_skeleton_2d(ax, pts_xy, color)               # pts_xy  (15, 2), SLAP order
    draw_skeleton_3d(ax3d, pts_xyz, color)            # pts_xyz (15, 3), Axes3D

`node_names` maps rows of `pts` to skeleton names, so callers whose arrays are
in a different node order pass their own list. `scale` multiplies stroke
widths and dot sizes for panels drawn smaller than a standard tile.
`surfaces="torso"` keeps only the large torso+head membranes -- for tiny
panels where the full membrane set turns to mush.

For 3D axes the membranes go into one `Poly3DCollection` pre-sorted
back-to-front by centroid depth along the current view direction (from the
axes' azim/elev at call time), with `zsort="average"` so matplotlib re-sorts
per draw if the view is rotated afterwards -- membranes therefore occlude
each other sensibly instead of in insertion order.
"""

from __future__ import annotations

import numpy as np

#: The 15-node SLAP mouse skeleton, in the corpus's canonical node order
#: (matches `out/fig6.json` `mean_pose.node_names` and the app's skeleton).
SLAP_NODES = [
    "Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk",
    "Tail_0", "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right",
    "Haunch_left", "Haunch_right", "Neck",
]

# --------------------------------------------------------------------------
# blender-images/cage_scene.py -- "viz_08 cell 16, mouse surfaces and edges,
# verbatim". Copied, not imported: that module needs bpy.
# --------------------------------------------------------------------------
MOUSE_SURFACES = [
    ["Nose", "Head", "Ear_R"], ["Nose", "Head", "Ear_L"],
    ["Head", "Neck", "Shoulder_left"], ["Head", "Neck", "Shoulder_right"],
    ["Neck", "Trunk", "Haunch_left", "Shoulder_left"], ["Neck", "Trunk", "Haunch_right", "Shoulder_right"],
    ["Trunk", "TTI", "Haunch_left"], ["Trunk", "TTI", "Haunch_right"],
    ["Head", "Shoulder_left", "Shoulder_right"],
    ["Haunch_left", "Haunch_right", "Shoulder_right", "Shoulder_left"],
    ["Haunch_left", "Haunch_right", "TTI"],
]
MOUSE_EDGES = [
    ["TailTip", "Tail_2"], ["Tail_2", "Tail_1"], ["Tail_1", "Tail_0"], ["Tail_0", "TTI"],
    ["TTI", "Trunk"], ["Trunk", "Neck"], ["Neck", "Head"], ["Head", "Nose"],
    ["TTI", "Haunch_left"], ["TTI", "Haunch_right"], ["Trunk", "Haunch_right"], ["Trunk", "Haunch_left"],
    ["Neck", "Shoulder_left"], ["Neck", "Shoulder_right"], ["Ear_L", "Head"], ["Ear_R", "Head"],
    ["Ear_L", "Nose"], ["Ear_R", "Nose"], ["Shoulder_left", "Head"], ["Shoulder_right", "Head"],
    ["Shoulder_left", "Haunch_left"], ["Shoulder_right", "Haunch_right"],
    ["Haunch_right", "TTI"], ["Haunch_left", "TTI"],
    ["Shoulder_left", "Shoulder_right"], ["Haunch_left", "Haunch_right"],
]

#: The load-bearing torso+head membranes, for panels too small for the full set.
TORSO_SURFACES = [
    ["Nose", "Head", "Ear_R"], ["Nose", "Head", "Ear_L"],
    ["Neck", "Trunk", "Haunch_left", "Shoulder_left"],
    ["Neck", "Trunk", "Haunch_right", "Shoulder_right"],
    ["Haunch_left", "Haunch_right", "TTI"],
]

#: Joints that get the LARGER dot -- the body's landmarks, per the brief.
MAJOR_NODES = {"Head", "Trunk", "TTI"}


def _index(node_names):
    return {n: i for i, n in enumerate(node_names)}

def _surface_list(surfaces):
    if surfaces is None or surfaces == "full":
        return MOUSE_SURFACES
    if surfaces == "torso":
        return TORSO_SURFACES
    return surfaces           # caller passed an explicit list of name-lists


def _polys(pts, node_names, surfaces):
    """Surface polygons as coordinate arrays, skipping any touching a NaN node."""
    idx = _index(node_names)
    out = []
    for names in _surface_list(surfaces):
        P = pts[[idx[n] for n in names]]
        if np.isfinite(P).all():
            out.append(P)
    return out


def _segs(pts, node_names):
    """Edge segments as (2, D) arrays, skipping any touching a NaN node."""
    idx = _index(node_names)
    out = []
    for a, b in MOUSE_EDGES:
        S = pts[[idx[a], idx[b]]]
        if np.isfinite(S).all():
            out.append(S)
    return out


def _dot_sizes(node_names, scale):
    """Scatter sizes (pt^2): bigger for Head/Trunk/TTI, per the viz_08 look."""
    return np.array([(3.4 if n in MAJOR_NODES else 2.2) ** 2 * scale ** 2
                     for n in node_names])


def draw_skeleton_2d(ax, pts_xy, color, node_names=SLAP_NODES, scale=1.0, *,
                     surfaces="full", surface_alpha=0.30, edge_lw=1.6,
                     dots=True, zorder=2.0):
    """Draw one surface-filled skeleton on a 2D axes.

    `pts_xy` is (N, 2) in data coordinates, rows in `node_names` order; NaN
    rows are missing nodes and everything touching them is skipped. All marks
    share `color`; `zorder` is the base layer (fills at it, edges +0.1,
    dots +0.2) so two animals interleave whole-body by their base zorder.
    """
    from matplotlib.collections import LineCollection, PolyCollection

    pts = np.asarray(pts_xy, float)
    polys = _polys(pts, node_names, surfaces)
    if polys:
        ax.add_collection(PolyCollection(
            polys, facecolors=color, alpha=surface_alpha, edgecolors="none",
            zorder=zorder))
    segs = _segs(pts, node_names)
    if segs:
        ax.add_collection(LineCollection(
            segs, colors=color, linewidths=edge_lw * scale,
            capstyle="round", joinstyle="round", zorder=zorder + 0.1))
    if dots:
        ok = np.isfinite(pts).all(axis=1)
        ax.scatter(pts[ok, 0], pts[ok, 1],
                   s=_dot_sizes([n for n, k in zip(node_names, ok) if k], scale),
                   c=color, edgecolors="white", linewidths=0.5 * scale,
                   zorder=zorder + 0.2)
    return ax


def draw_skeleton_3d(ax, pts_xyz, color, node_names=SLAP_NODES, scale=1.0, *,
                     surfaces="full", surface_alpha=0.30, edge_lw=1.6,
                     dots=True):
    """Draw one surface-filled skeleton on an Axes3D.

    Membranes go into a single `Poly3DCollection`, pre-sorted back-to-front by
    centroid depth along the axes' CURRENT view direction (azim/elev at call
    time) and with `zsort="average"` so they keep occluding sensibly if the
    view is changed after the call.
    """
    from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection

    pts = np.asarray(pts_xyz, float)
    had_data = ax.has_data()
    polys = _polys(pts, node_names, surfaces)
    if polys:
        # View direction from the axes' azim/elev (matplotlib's convention:
        # the eye sits along this unit vector). Depth = centroid . view_dir;
        # draw far-to-near.
        az, el = np.radians(ax.azim), np.radians(ax.elev)
        view = np.array([np.cos(el) * np.cos(az),
                         np.cos(el) * np.sin(az),
                         np.sin(el)])
        depth = [poly.mean(axis=0) @ view for poly in polys]
        polys = [polys[i] for i in np.argsort(depth)]
        # autolim=False: matplotlib 3.11's Poly3DCollection autolim indexes
        # `col._faces[..., 0]`, which breaks on a RAGGED face list (this
        # skeleton mixes 3- and 4-vertex membranes) and poisons the axis
        # limits with astronomical garbage. Limits are set explicitly below.
        ax.add_collection3d(Poly3DCollection(
            polys, facecolors=color, alpha=surface_alpha, edgecolors="none",
            zsort="average"), autolim=False)
    segs = _segs(pts, node_names)
    if segs:
        lc = Line3DCollection(segs, colors=color, linewidths=edge_lw * scale,
                              capstyle="round", joinstyle="round")
        ax.add_collection3d(lc, autolim=False)
    ok = np.isfinite(pts).all(axis=1)
    if dots and ok.any():
        ax.scatter(pts[ok, 0], pts[ok, 1], pts[ok, 2],
                   s=_dot_sizes([n for n, k in zip(node_names, ok) if k], scale),
                   c=color, edgecolors="white", linewidths=0.5 * scale,
                   depthshade=False)
    if ok.any():
        # Explicit data limits over the finite joints (the membranes and edges
        # lie inside their hull), replacing the collections' broken autolim.
        # `had_data` was captured on entry so a first skeleton SETS the limits
        # and later ones UNION into them.
        ax.auto_scale_xyz(pts[ok, 0], pts[ok, 1], pts[ok, 2],
                          had_data=had_data or (dots and ok.any()))
    return ax
