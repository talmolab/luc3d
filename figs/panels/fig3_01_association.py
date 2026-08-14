#!/usr/bin/env python3
"""
Fig 3a -- exhaustive vs greedy cross-view association, as the two shapes of the work.

REDRAWN TWICE, and the two rejections bracket what this panel may show.

The FIRST version drew one set of crossing lines between camera columns -- the
ANSWER -- and read as noise, because the answer is not what separates the methods.
The SECOND drew the hypothesis SET as an abstract grid of rectangles with the
winner filled; review (2026-08) rejected that too: a grid of anonymous rectangles
says "many things" without saying many things OF WHAT, and it dropped the cameras
and animals -- the matching -- out of the picture entirely.

What separates the methods is the shape of the SEARCH over the same matching
problem, so both boxes now draw the same raw material -- C cameras, A detections
per camera -- and differ only in what they do with it:

LEFT, exhaustive (Maree, Afshar, Oline, Leonardis, Falkner & Pereira 2024, Proc.
Measuring Behavior 217-224): every way of stringing one detection per camera into
an identity is in play at once, so EVERY cross-camera pairing is drawn -- the full
A x A bipartite bundle between each adjacent pair of camera columns, the
combinatorial explosion itself, (A!)^C whole-frame hypotheses of which the drawn
grey mesh is the per-gap cross-section. The one kept grouping is the set of A
disjoint salmon paths threading the mesh: every grouping is triangulated + scored
and the lowest-reprojection one kept, but that is what panels c/f quantify -- here
it is said by the sub-heading's (A!)^C and the mesh, with no caption lines (review:
the panel carried too much text; the notes under both boxes are gone).

RIGHT, greedy (LUC3D): one Hungarian assignment per camera, each committing before
the next is considered. The chain is C solves, not (A!)^C hypotheses.

That paper's own "Future directions ▸ Faster multi-view association" proposes exactly
this greedy variant, so the comparison is one it invited.

THE HEIGHT IS DERIVED, NOT DECLARED, AND THE DRAWING SCALE IS PINNED. `MM_PER_UNIT`
was measured off the original 42 mm version of this panel (axes 39.88 mm over a
5.2-unit ylim) and must NOT be recomputed from the current height -- pinning it is
what keeps the drawing at its print size while dead space comes out. Removing the
two note lines under each box freed ~1.0 data units; `H_BOX` drops by that amount,
so the boxes shrink by exactly the text that was removed and the artwork keeps its
size. Every type size is untouched.

    python3 figs/panels/fig3_01_association.py
"""
import sys
from pathlib import Path

from matplotlib.patches import FancyArrowPatch, Rectangle

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon  # noqa: E402
from src.style import (MUTED, GREY, INK, SALMON, TEAL, grid, identity,  # noqa: E402
                       save, use)

NCAM = 4                   # camera columns, both boxes
NA = 3                     # detections per camera, exhaustive box

#: The content band both sides share, in data units: the exhaustive box's dot
#: columns and the greedy box's camera+H rows both live in a BAND_H-tall region
#: whose floor is Y_BAND, so the two halves stay registered.
BAND_H = 1.70

#: THE VERTICAL LAYOUT, in data units, and the pinned scale that turns it into
#: millimetres. `MM_PER_UNIT` was measured off the 42 mm version of this panel
#: (axes 39.88 mm over a 5.2-unit ylim) and must NOT be recomputed from the new
#: height. H_BOX was 4.34 with two 0.5-unit note lines under the band; the notes
#: are gone (review 2026-08: too much text), so the box gives back their ~1.0
#: units and the band floor sits 0.35 above the box floor.
MM_PER_UNIT = 39.88 / 5.2
H_BOX = 3.42
Y_TITLE = H_BOX - 0.38
Y_SUB = H_BOX - 0.90
Y_BAND = 0.35                                  # floor of the content band
YPAD = 0.03                                    # axes margin outside the box
HPAD_MM = 0.80
ROW_MM = MM_PER_UNIT * (H_BOX + 2 * YPAD) + 2 * HPAD_MM

#: Exhaustive box geometry. Camera icons sit on the same row as the greedy box's
#: (Y_BAND + 1.20, size 0.62); under each, NA detection dots. The kept grouping is
#: WINNER[gap] = for each animal a, which dot row it continues to in the next
#: column -- chosen non-identity in the outer gaps so the salmon paths visibly
#: thread the mesh rather than running straight across.
X_COLS = [1.15 + i * 2.35 for i in range(NCAM)]
Y_DOTS = [Y_BAND + 0.15, Y_BAND + 0.55, Y_BAND + 0.95]
Y_CAM = Y_BAND + 1.20
WINNER = [(1, 0, 2), (0, 1, 2), (2, 1, 0)]     # perm[row in col c] -> row in col c+1


def box(ax, title, sub, accent):
    """The two-line heading. NO FRAME AND NO ACCENT BAR (review 2026-08-14: "i dont
    really like the way that 3a is structured, it looks weird with the colour indicator
    and in a box... just make the text for Exhaustive hypothesis testing in the orange
    colour and the Greedy per-view assignment in green").

    The frame and the 0.16-wide colour swatch were two devices doing what one coloured
    word does: say which method this half is. Dropping them also removes the only
    boxes in the figure that carry no data, and the title now uses the method's own
    entity hue, which is the same hue that method has in 3d and 3f.
    """
    ax.text(0.45, Y_TITLE, title, fontweight="bold", color=accent, fontsize=7.5,
            va="center")
    # 8.0, not 6.5: mathtext superscripts render at ~0.7x, so (A!)$^C$ at
    # 6.5 pt put its C at 4.55 pt -- under Nature's 5 pt floor.
    ax.text(0.45, Y_SUB, sub, color=MUTED, fontsize=8.0, va="center")


#: Identity palette slots for the three schematic animals, shared by both halves of
#: the panel. 0, 4, 5 = green, orange, blue -- the hues the app's demo session gives
#: its identities in the fig2a screenshots. See the block comment at the winner paths.
ID_IDX = [0, 4, 5]


def draw_exhaustive(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Exhaustive hypothesis testing", "Maree et al. 2024 · (A!)$^C$ per frame",
        SALMON)
    # The full pairing mesh first (zorder 2), the kept grouping's paths over it
    # (zorder 3), the detections and cameras on top (zorder 4).
    for c in range(NCAM - 1):
        for r1 in range(NA):
            for r2 in range(NA):
                ax.plot([X_COLS[c], X_COLS[c + 1]], [Y_DOTS[r1], Y_DOTS[r2]],
                        color="#DDDDDD", lw=0.6, zorder=2,
                        solid_capstyle="round")
    # One consistent whole-frame grouping: A disjoint paths threading the mesh.
    #
    # COLOURED BY IDENTITY, NOT BY METHOD (review 2026-08-13: "not all orange lines,
    # the colours should be IDs"). The three kept paths are not three copies of one
    # thing -- each is one ANIMAL's detections linked across the cameras, which is
    # exactly what an identity is, so each takes its own `identity()` hue and the same
    # hues the app's screenshots and Fig 1a's icons use. SALMON stays on the accent
    # bar, where it means the METHOD (exhaustive), which is the entity rule.
    #
    # The dots stay INK: before a grouping is chosen a detection has no identity, and
    # that is the whole premise of the panel -- the same statement Fig 1a's `tiles2d`
    # glyph makes by drawing both animals in one colour.
    # IDENTITY INDICES 0, 4, 5 (review round 3). Not 0,1,2: identity(2) is a dark
    # teal colliding with the LUC3D entity hue. Not 0,1,3 either: the SCREENSHOTS the
    # reader matches these against (fig2a's mice, labelled id_0/id_1/id_2 in the app)
    # wear palette slots 0, 4 and 5 -- green, orange, blue -- because the demo session
    # stores those colours. The schematic must use the hues a reader can actually see
    # in a photograph, or the "same animal, same colour" promise fails exactly where
    # it is tested.
    rows = list(range(NA))
    for c, perm in enumerate(WINNER):
        for a in range(NA):
            ax.plot([X_COLS[c], X_COLS[c + 1]],
                    [Y_DOTS[rows[a]], Y_DOTS[perm[rows[a]]]],
                    color=identity(ID_IDX[a]), lw=1.4, zorder=3,
                    solid_capstyle="round")
        rows = [perm[r] for r in rows]
    for c in range(NCAM):
        icon(ax, "camera", X_COLS[c] - 0.31, Y_CAM, s=0.62, color=INK)
        for r in range(NA):
            ax.plot([X_COLS[c]], [Y_DOTS[r]], "o", ms=3.6, mfc=INK, mec="white",
                    mew=0.6, zorder=4)
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-YPAD, H_BOX + YPAD)


def draw_greedy(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Greedy per-view assignment", "LUC3D · C Hungarian solves, O(C·A³)", TEAL)
    # Offsets from the content band's floor, so this side keeps its registration
    # with the pairing mesh opposite it (camera row +1.20, H row +0.20).
    y_cam, y_h = Y_BAND + 1.20, Y_BAND + 0.20
    for i in range(NCAM):
        x = 0.7 + i * 2.35
        icon(ax, "camera", x, y_cam, s=0.62, color=INK)
        ax.add_patch(Rectangle((x, y_h), 0.72, 0.62, fill=False, ec=TEAL, lw=0.9))
        ax.text(x + 0.36, y_h + 0.31, "H", ha="center", va="center", color=TEAL,
                fontsize=7, fontweight="bold")
        # THE RESULT OF EACH SOLVE, in the identity hues, so the two halves of this
        # panel end in the same place: A identities, resolved in every camera. Without
        # them the greedy side showed only machinery ("H") and the reader had to take
        # on trust that it produces the same object the exhaustive side draws.
        # A ROW under the solve, not a column: stacked, the three dots needed 0.78
        # units below `y_h` and the content band has 0.20 before it leaves the box --
        # they rendered outside the frame. Laid across the H box's own width they sit
        # inside the band with room to spare.
        for a in range(NA):
            # ms 5.0, not 3.4: at this panel's print scale 3.4 pt is ~1.2 mm and the
            # dark-green/dark-teal pair was indistinguishable (review 2026-08-14).
            # Same 0,1,3 identity indices as the exhaustive half's paths.
            ax.plot([x + 0.14 + a * 0.26], [Y_BAND + 0.10], "o", ms=5.0,
                    mfc=identity(ID_IDX[a]), mec="white", mew=0.6, zorder=4)
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.86, y_h + 0.31),
                                         (x + 2.2, y_h + 0.31),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-YPAD, H_BOX + YPAD)


def main():
    use()
    # STACKED, NOT SIDE BY SIDE (review 2026-08-13: "move greedy under exhaustive and
    # then c can go next to it"). Two consequences, both intended: the two strategies
    # are read top-to-bottom in the order the text introduces them, and the panel
    # becomes HALF the page wide, which is what frees the right-hand half of that row
    # for panel c -- the quantitative version of the same contrast (hypotheses per
    # frame). `row` doubles because the panel now carries two content bands.
    fig, axes = grid(2, 1, span="half", row=2 * ROW_MM, despine=False)
    # Vertical pad only. `w_pad` is left at matplotlib's default, so the horizontal
    # geometry -- and therefore the ink bounding box's WIDTH -- is untouched.
    fig.get_layout_engine().set(h_pad=HPAD_MM / 25.4)
    draw_exhaustive(axes[0])
    draw_greedy(axes[1])
    save(fig, 3, "a", "association")


if __name__ == "__main__":
    main()
