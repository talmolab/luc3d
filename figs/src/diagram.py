"""
Line-art primitives for the schematic panels.

The data panels take their look from `figures-mimic-mjx`. The schematics take
theirs from the Cheese3D paper's rig/pipeline diagrams: flat line art at a single
stroke weight, no 3D shading or drop shadows, no gradients, colour used only to
carry meaning (a camera that moves vs one held fixed), and every element labelled
in the same 8 pt Arial as the data panels so a reader crossing from a schematic to
a plot does not change type size.

Deliberately small. `nature.py` grew a 40-method drawing API and the figures grew
to match -- the composite panels ended up carrying more annotation than data, which
is the "slop" this rewrite is undoing. Anything more elaborate than the primitives
here should be drawn in Illustrator at assembly time, not generated.

All coordinates are in axes data space, and every helper returns nothing: draw onto
a `blank()` axes and set the limits yourself.
"""

from __future__ import annotations

import numpy as np
from matplotlib.patches import (Circle, Ellipse, FancyArrowPatch, Polygon,
                                Rectangle)

from .style import GREY, INK, SET2

#: One stroke weight for the whole schematic, matching the data panels' axes.
LW = 0.9


def blank(ax):
    """Strip an axes to bare paper: no spines, no ticks, equal aspect."""
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_aspect("equal")
    return ax


def camera(ax, x, y, s=1.0, color=INK, angle=0.0, label=None, labelpos="below"):
    """A camera: body + lens cone, drawn as flat line art pointing +x.

    `angle` rotates it about (x, y) in degrees, so a rig can be drawn by placing
    each camera on its real bearing.
    """
    th = np.radians(angle)
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])

    def place(pts):
        return (np.asarray(pts) * s) @ R.T + (x, y)

    # Explicit closed polygons. `Path(verts, closed=True)` needs matching `codes`
    # to actually close, and silently drew open chevrons instead of a camera.
    body = place([(-0.9, -0.6), (0.35, -0.6), (0.35, 0.6), (-0.9, 0.6)])
    ax.add_patch(Polygon(body, closed=True, fill=False, ec=color, lw=LW,
                         joinstyle="miter"))
    cone = place([(0.35, -0.5), (1.05, -0.9), (1.05, 0.9), (0.35, 0.5)])
    ax.add_patch(Polygon(cone, closed=True, fill=False, ec=color, lw=LW,
                         joinstyle="miter"))
    if label:
        dy = -1.5 * s if labelpos == "below" else 1.5 * s
        ax.text(x, y + dy, label, ha="center",
                va="top" if labelpos == "below" else "bottom", color=color)


def lock(ax, x, y, s=1.0, color=GREY):
    """A padlock: this camera is held FIXED by the solver."""
    ax.add_patch(Rectangle((x - 0.32 * s, y - 0.28 * s), 0.64 * s, 0.5 * s,
                           fill=False, ec=color, lw=LW * 0.8))
    t = np.linspace(np.pi, 0, 24)
    ax.plot(x + 0.2 * s * np.cos(t), y + 0.22 * s + 0.2 * s * np.sin(t),
            color=color, lw=LW * 0.8)


def free(ax, x, y, s=1.0, color=INK):
    """A short double arrow: this camera is FREE to move (joint bundle adjustment)."""
    ax.add_patch(FancyArrowPatch((x - 0.5 * s, y - 0.35 * s),
                                 (x + 0.5 * s, y + 0.35 * s),
                                 arrowstyle="<|-|>", mutation_scale=6,
                                 color=color, lw=LW * 0.8, shrinkA=0, shrinkB=0))


def ray(ax, x0, y0, x1, y1, color=GREY, ls="-", lw=None):
    """A sight line from a camera to a point."""
    ax.plot([x0, x1], [y0, y1], color=color, ls=ls, lw=lw or LW * 0.8, zorder=1)


def point(ax, x, y, color=INK, r=0.16, filled=True):
    """A reconstructed 3D point."""
    ax.add_patch(Circle((x, y), r, facecolor=color if filled else "white",
                        edgecolor=color, lw=LW, zorder=4))


def residual(ax, x0, y0, x1, y1, color, curved=False, label=None):
    """The residual a solver minimises.

    `curved=True` bows the connector, which is how the native-distorted-space
    solvers are distinguished from DLT's straight algebraic offset -- the one real
    geometric distinction between them, so it is drawn rather than captioned.
    """
    if curved:
        p = FancyArrowPatch((x0, y0), (x1, y1), connectionstyle="arc3,rad=0.35",
                            arrowstyle="-", color=color, lw=LW * 1.3,
                            linestyle=(0, (2.5, 1.5)), shrinkA=0, shrinkB=0,
                            zorder=3)
        ax.add_patch(p)
    else:
        ax.plot([x0, x1], [y0, y1], color=color, lw=LW * 1.3,
                ls=(0, (2.5, 1.5)), zorder=3)
    ax.add_patch(Circle((x1, y1), 0.11, facecolor=color, edgecolor="none",
                        zorder=4))
    if label:
        ax.text((x0 + x1) / 2, (y0 + y1) / 2 + 0.3, label, color=color,
                ha="center", va="bottom", fontsize=7)


def loop(ax, x, y, r=0.55, color=INK, label=None):
    """A circular arrow: this solver ITERATES."""
    t = np.linspace(0.35 * np.pi, 1.85 * np.pi, 60)
    ax.plot(x + r * np.cos(t), y + r * np.sin(t), color=color, lw=LW)
    ax.add_patch(FancyArrowPatch(
        (x + r * np.cos(t[-2]), y + r * np.sin(t[-2])),
        (x + r * np.cos(t[-1]), y + r * np.sin(t[-1])),
        arrowstyle="-|>", mutation_scale=7, color=color, lw=0, shrinkA=0,
        shrinkB=0))
    if label:
        ax.text(x, y - r - 0.25, label, ha="center", va="top", color=color,
                fontsize=7)


# --------------------------------------------------------------------------
# the pipeline icon set
# --------------------------------------------------------------------------
# Ported from the legacy `nature.py`'s `icon()`, and kept for the reason its
# docstring gave: "a reader should be able to follow the stages from the icons
# alone, which is the difference between a schematic and a row of captions."
# The first pass of this rewrite dropped them and the flow charts became exactly
# that row of captions.
#
# Same shapes, same proportions, redrawn in matplotlib. Every icon is drawn into
# the unit box (x, y) .. (x+s, y+s) so a stage can place one without measuring.

def mouse_pose(ax, bx, by, bw, bh, color=INK, lw=None, dot=0.075):
    """The set's mini mouse -- nose-head-hip-tailbase spine plus two limbs -- drawn to
    fill the rectangle (bx, by, bw, bh) in ordinary y-up coordinates.

    ONE SHAPE, USED EVERYWHERE. Fig 1a's `pose2d` / `pose3d` / `instances3d` glyphs
    already drew this; the multi-view tile glyphs first used a stroke-and-dot mark
    instead and it read as a smudge rather than an animal (review 2026-08-14: "they
    should still look like little mice like the proofread3d does, but just 2D
    projections in the squares"). Hoisted here so both call sites are literally the
    same drawing at different sizes, and a change to the animal is a change to all of
    them. The fractions are the legacy y-DOWN ones flipped once, here, rather than at
    every call site.
    """
    lw = lw or LW * 0.85
    spine = [(0.10, 0.38), (0.38, 0.70), (0.66, 0.56), (0.94, 0.80)]
    limbs = (((0.38, 0.70), (0.30, 0.34)), ((0.66, 0.56), (0.76, 0.26)))
    P = lambda f: (bx + f[0] * bw, by + f[1] * bh)
    for a, b in zip(spine, spine[1:]):
        (x1, y1), (x2, y2) = P(a), P(b)
        ax.plot([x1, x2], [y1, y2], color=color, lw=lw, solid_capstyle="round",
                zorder=4)
    for a, b in limbs:
        (x1, y1), (x2, y2) = P(a), P(b)
        ax.plot([x1, x2], [y1, y2], color=color, lw=lw, solid_capstyle="round",
                zorder=4)
    for f in spine:
        ax.add_patch(Circle(P(f), min(bw, bh) * dot, facecolor=color,
                            edgecolor="none", zorder=5))


#: How many icon-heights wide the multi-view glyphs are. Three tiles plus their gaps
#: at a legible size; see the block comment in `icon()`.
TILES_W = 2.7


def icon(ax, kind, x, y, s=1.0, color=INK, lw=None):
    """One pipeline glyph in the box (x, y, s, s) -- except the multi-view glyphs
    (`tiles2d`, `tilesid`, `volume3d`), which are `TILES_W * s` wide and CENTRED on
    x + s/2, and return their own (x, y, w, h).

    kinds: camera, cameras, skeleton, ids, triangulate, cube, check, file, mouse,
    pose2d, pose3d, instances3d

    The last three are the Fig 1a pipeline glyphs (review 2026-08: the pipeline's
    icons should show THIS pipeline's objects, not generic marks): `pose2d` is two
    animals' 2D poses in ONE colour -- detections exist, identity does not yet;
    `pose3d` is one animal's pose over a ground plane -- the triangulated result;
    `instances3d` is two animals over the plane in the identity palette's two
    hues -- re-identified instances, which is what proofreading acts on. They share
    one mini-pose shape so the object reads as "the same animal, further along".

    COORDINATES ARE FLIPPED relative to the legacy source. `nature.py` drew these
    in SVG, where y grows DOWNWARD; matplotlib's y grows upward, so a direct port
    mirrors every glyph vertically -- the checkmark came out as a caret and the
    multi-camera icon hung its cameras below the subject instead of above it.
    `Y(f)` maps a legacy fraction to the matplotlib box, and every vertical term
    below goes through it.
    """
    lw = lw or LW * 0.85
    cx = x + s / 2

    def Y(f):
        return y + (1.0 - f) * s

    def L(x1, f1, x2, f2):
        ax.plot([x1, x2], [Y(f1), Y(f2)], color=color, lw=lw,
                solid_capstyle="round", zorder=3)

    def box(bx, f_top, bw, fh):
        # f_top is the legacy (y-down) top edge; height fh in fractions.
        ax.add_patch(Rectangle((bx, Y(f_top + fh)), bw, fh * s, fill=False,
                               ec=color, lw=lw, zorder=3))

    def dot(dx, f, r):
        ax.add_patch(Circle((dx, Y(f)), r, facecolor=color, edgecolor="none",
                            zorder=4))

    if kind == "camera":
        box(x, 0.28, s * 0.62, 0.44)
        ax.add_patch(Polygon([(x + s * 0.62, Y(0.42)), (x + s, Y(0.28)),
                              (x + s, Y(0.72)), (x + s * 0.62, Y(0.58))],
                             closed=True, fill=False, ec=color, lw=lw, zorder=3))
    elif kind == "cameras":
        for a in (-1, 0, 1):
            bx = cx + a * s * 0.36
            box(bx - s * 0.10, 0.10, s * 0.20, 0.14)
            L(bx, 0.24, cx, 0.80)
        dot(cx, 0.86, s * 0.08)
    elif kind == "skeleton":
        pts = [(0.20, 0.72), (0.40, 0.40), (0.62, 0.52), (0.84, 0.26)]
        for i in range(len(pts) - 1):
            L(x + pts[i][0] * s, pts[i][1], x + pts[i + 1][0] * s, pts[i + 1][1])
        L(x + 0.40 * s, 0.40, x + 0.34 * s, 0.14)
        L(x + 0.62 * s, 0.52, x + 0.70 * s, 0.82)
        for px, py in pts:
            dot(x + px * s, py, s * 0.075)
    elif kind == "ids":
        for dy in (0.16, 0.44, 0.72):
            box(x, dy, s * 0.42, 0.20)
            L(x + s * 0.52, dy + 0.10, x + s, dy + 0.10)
    elif kind == "triangulate":
        L(x + s * 0.06, 0.12, x + s * 0.92, 0.50)
        L(x + s * 0.06, 0.88, x + s * 0.92, 0.50)
        box(x + s * 0.00, 0.05, s * 0.14, 0.14)
        box(x + s * 0.00, 0.81, s * 0.14, 0.14)
        dot(x + s * 0.92, 0.50, s * 0.10)
    elif kind == "cube":
        o = 0.22
        box(x, o, s * (1 - o), 1 - o)
        box(x + o * s, 0.0, s * (1 - o), 1 - o)
        L(x, o, x + o * s, 0.0)
        L(x + s * (1 - o), o, x + s, 0.0)
        L(x, 1.0, x + o * s, 1 - o)
        L(x + s * (1 - o), 1.0, x + s, 1 - o)
    elif kind == "check":
        L(x + s * 0.16, 0.54, x + s * 0.40, 0.78)
        L(x + s * 0.40, 0.78, x + s * 0.86, 0.20)
    elif kind == "file":
        f = 0.26
        ax.add_patch(Polygon([(x + s * 0.16, Y(0.06)),
                              (x + s * (0.84 - f), Y(0.06)),
                              (x + s * 0.84, Y(0.06 + f)),
                              (x + s * 0.84, Y(0.94)),
                              (x + s * 0.16, Y(0.94))],
                             closed=True, fill=False, ec=color, lw=lw, zorder=3))
        for dy in (0.44, 0.62, 0.80):
            L(x + s * 0.30, dy, x + s * 0.70, dy)
    elif kind == "mouse":
        ax.add_patch(Ellipse((cx, Y(0.5)), s * 0.68, s * 0.40, fill=False,
                             ec=color, lw=lw, zorder=3))
        L(cx + s * 0.34, 0.50, cx + s * 0.48, 0.40)
        L(cx - s * 0.34, 0.50, cx - s * 0.50, 0.64)
    elif kind in ("pose2d", "pose3d", "instances3d"):
        # One mini pose shared by the three glyphs: nose-head-hip-tailbase spine
        # with two limb strokes -- the "skeleton" glyph compressed so two of them
        # fit a box. (ox, oy) place its own unit box inside the icon box; sc
        # scales it; the fractions are in the LEGACY y-down frame like the rest.
        def pose(ox, oy, sc, col):
            spine = [(0.10, 0.62), (0.38, 0.30), (0.66, 0.44), (0.94, 0.20)]
            for i in range(len(spine) - 1):
                ax.plot([x + (ox + spine[i][0] * sc) * s,
                         x + (ox + spine[i + 1][0] * sc) * s],
                        [Y(oy + spine[i][1] * sc), Y(oy + spine[i + 1][1] * sc)],
                        color=col, lw=lw, solid_capstyle="round", zorder=3)
            for (a, b) in (((0.38, 0.30), (0.30, 0.66)), ((0.66, 0.44), (0.76, 0.74))):
                ax.plot([x + (ox + a[0] * sc) * s, x + (ox + b[0] * sc) * s],
                        [Y(oy + a[1] * sc), Y(oy + b[1] * sc)],
                        color=col, lw=lw, solid_capstyle="round", zorder=3)
            for px, py in spine:
                ax.add_patch(Circle((x + (ox + px * sc) * s, Y(oy + py * sc)),
                                    s * sc * 0.055, facecolor=col,
                                    edgecolor="none", zorder=4))

        def plane(col):
            # Ground parallelogram along the icon's floor: the one 3D cue, kept
            # to a single thin outline (no shading, per the module header).
            ax.add_patch(Polygon([(x + s * 0.02, Y(0.88)), (x + s * 0.34, Y(1.00)),
                                  (x + s * 0.98, Y(0.94)), (x + s * 0.66, Y(0.82))],
                                 closed=True, fill=False, ec=col, lw=lw * 0.8,
                                 zorder=2))

        if kind == "pose2d":
            # Two animals, ONE colour: detections without identity.
            pose(0.00, 0.02, 0.58, color)
            pose(0.40, 0.42, 0.58, color)
        elif kind == "pose3d":
            plane(color)
            pose(0.10, 0.02, 0.80, color)
        else:  # instances3d
            # The identity palette's first two hues, not the chevron's colour:
            # here colour IS the payload (one identity per animal). `identity()`
            # rather than SET2 since 2026-08-13: SET2[0]/SET2[1] are teal and salmon,
            # which are RESERVED ENTITY hues (this work / its comparator), so the two
            # animals in this glyph were wearing the colours that mean "LUC3D" and
            # "the baseline" three panels later -- and they disagreed with the two
            # identity hues the tiles glyphs and the app's own screenshots use.
            from src.style import identity as _id
            plane(GREY)
            pose(0.00, 0.00, 0.58, _id(0))
            pose(0.40, 0.34, 0.58, _id(4))
    elif kind in ("tiles2d", "tilesid", "volume3d"):
        # ##################################################################
        # THE PIPELINE'S ACTUAL SHAPE (review 2026-08-13). The three glyphs
        # before this one drew ONE pose per stage, so Fig 1a asserted a
        # single-view pipeline -- the opposite of the paper's claim. These
        # three carry the real story in colour alone:
        #
        #   tiles2d   N camera tiles, two animals each, ALL ONE COLOUR
        #             -- detections exist in every view, identity does not
        #   tilesid   the SAME tiles, each animal now in its own identity
        #             colour, consistent tile to tile -- that is the
        #             cross-view re-ID result and nothing else changed
        #   volume3d  ONE 3D volume, two animals, the SAME two identity
        #             colours -- the views have collapsed into one space
        #
        # Colours come from `identity()`, which mirrors the app's own
        # IDENTITY_COLORS, so the schematic and the Fig 1b/1c screenshots
        # name the same animal the same way.
        #
        # WIDE, NOT SQUARE: three tiles in a 0.5-unit square would be 1.5 mm
        # each at this panel's scale. `s` is read as the HEIGHT and the glyph
        # spends `TILES_W * s` of width, which the chevron has to spare.
        # ##################################################################
        from src.style import identity as _identity
        n_tiles = 3
        wide = TILES_W * s
        x0 = cx - wide / 2.0
        tw = wide / (n_tiles + (n_tiles - 1) * 0.22)     # tile width
        gap = tw * 0.22

        def animal(ax_, bx, by, bw, bh, fx, fy, col, scale=1.0):
            """One mini mouse (see `mouse_pose`) centred on (fx, fy) of the tile,
            at `scale` of the tile's width -- the SAME glyph the proofread-3D icon
            draws, so a reader follows one animal shape through the whole row."""
            aw, ah = bw * 0.52 * scale, bh * 0.42 * scale
            mouse_pose(ax_, bx + fx * bw - aw / 2, by + fy * bh - ah / 2, aw, ah,
                       color=col, lw=lw, dot=0.085)

        # tiles2d draws its mice in INK even when the chevron (and `color`) is GREY:
        # the un-contributed 2D-pose stage's grey is 2.1:1 on white, and at ~2 mm the
        # one-colour "before" state of the collapse story vanished in print (review
        # 2026-08-14). The tile FRAMES keep the stage colour; the animals must read.
        if kind in ("tiles2d", "tilesid"):
            # Two animals per tile at DIFFERENT positions in each tile: the same
            # pair seen from three viewpoints, not three copies of one picture.
            # Pulled apart: a mini pose fills ~half the tile, so the old
            # near-diagonal pairs overlapped once the glyph stopped being a stroke.
            poses = [((0.27, 0.28), (0.71, 0.72)),
                     ((0.29, 0.73), (0.73, 0.27)),
                     ((0.26, 0.70), (0.72, 0.30))]
            for t in range(n_tiles):
                bx = x0 + t * (tw + gap)
                ax.add_patch(Rectangle((bx, y), tw, s, fill=False, ec=color,
                                       lw=lw * 0.9, zorder=3))
                for a, (fx, fy) in enumerate(poses[t]):
                    # slots 0 and 4 (green, orange): the hues the app's own demo
                    # session gives its first two identities in the fig2a
                    # screenshots (review round 3) -- not 0 and 1, whose magenta
                    # exists in no photograph in the set.
                    col = INK if kind == "tiles2d" else _identity((0, 4)[a])
                    animal(ax, bx, y, tw, s, fx, fy, col)
        else:
            # ONE box for the collapsed 3D volume, with a ground parallelogram so
            # it reads as a space rather than a fourth camera tile.
            bw = wide * 0.62
            bx = cx - bw / 2.0
            ax.add_patch(Polygon([(bx, y + s * 0.16), (bx + bw * 0.18, y),
                                  (bx + bw, y + s * 0.10),
                                  (bx + bw * 0.82, y + s * 0.26)],
                                 closed=True, fill=False, ec=GREY,
                                 lw=lw * 0.8, zorder=2))
            ax.add_patch(Rectangle((bx, y), bw, s, fill=False, ec=color,
                                   lw=lw * 0.9, zorder=3))
            for a, (fx, fy) in enumerate(((0.30, 0.42), (0.70, 0.66))):
                animal(ax, bx, y, bw, s, fx, fy, _identity((0, 4)[a]), scale=1.05)
        return x0, y, wide, s
    else:
        raise ValueError(f"unknown icon kind: {kind}")
    return x, y, s, s
