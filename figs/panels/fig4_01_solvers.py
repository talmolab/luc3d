#!/usr/bin/env python3
"""
Fig 4a -- the two triangulation solvers the app ships, and what separates them.

THE NAMING IS WRONG IN THE APP'S UI AND THIS PANEL DOES NOT REPEAT IT. LUCID's
menu calls the second solver "Bundle Adjustment", but it holds the cameras FIXED,
so it is non-linear TRIANGULATION (aniposelib's `optim_points`). The panel labels
each solver with what it actually minimises and what the app calls it.

TWO CARDS, NOT THREE (review 2026-08). An earlier version drew a third, grey card
for true joint bundle adjustment (`bundleAdjustCameras`, deliberately not wired to
the UI because rewriting a project's calibration invalidates every 3D point derived
from it -- `pose/triangulation.js` says so itself). Review cut it: LUC3D does not
DO joint bundle adjustment, and a figure about the app's solvers has no business
diagramming an algorithm the tool never runs -- a reader skimming three cards
reads three capabilities. The nomenclature point survives in the second card's
tag; the not-wired function stays in Methods prose, not artwork.

What is drawn, per solver, is the one distinction that matters:
  * which error it minimises  -- straight (algebraic) vs bowed (geometric, in the
    camera's native distorted pixels);
  * the padlock -- the cameras are held fixed by BOTH solvers.

This is a nomenclature correction, not a result, which is why it leads as a
schematic and carries no numbers.

    python3 figs/panels/fig4_01_solvers.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, camera, free, lock, point, ray, residual, loop  # noqa: E402
from src.style import MUTED, entity, grid, GREY, INK, save, use  # noqa: E402

#: The legacy panel drew each solver in its own outlined card with a thick coloured
#: rule down the left edge; the restyle dropped both and left three unbounded
#: columns of line art that read as one continuous drawing. The card is what makes
#: "three solvers" legible as three things, so it is restored here.
CARD = (-1.85, -3.55, 5.85, 4.42)   # x0, y0, x1, y1 in data coordinates

#: THE SOLVER COLOURS COME FROM `entity()`, not from a local pick. DLT was drawn in
#: periwinkle here, which is SLEAP's hue in Fig 7 -- a reader who learns periwinkle
#: on one page was then told it meant something else on the next. `entity('dlt')`
#: is the set-wide "the thing this work is compared against" colour and
#: `entity('refined')` is the set-wide "this work" colour, so every fig4 panel
#: says the same thing with the same two hues.
#:
#: `ink` is the TEXT colour for the card's status tag and is not always `color`:
#: GREY is #B3B3B3, i.e. 2.1:1 on white, which is below every legibility floor for
#: type. Marks and rules may be GREY; words that must be read are MUTED.
SOLVERS = [
    dict(title="Linear DLT", sub="algebraic error · closed form",
         tag="app default", color=entity("dlt"), fixed=True, curved=False,
         iterative=False),
    dict(title="Non-linear triangulation", sub="geometric error · native pixels",
         tag="app menu: “Bundle Adjustment”", color=entity("refined"), fixed=True,
         curved=True, iterative=False),
]


def card(ax, s):
    """The outlined card and its coloured left rule, drawn BEHIND everything.

    Data coordinates, not `transAxes`: `blank()` sets `aspect="equal"`, so the axes
    box is resized to the data aspect and an axes-fraction rectangle would not
    enclose the title block. The limits below are widened to make room for the card
    so nothing is drawn outside them -- panels are saved at an exact size with no
    tight bbox, and ink outside the axes is simply cut off.
    """
    x0, y0, x1, y1 = CARD
    ax.add_patch(FancyBboxPatch(
        (x0, y0), x1 - x0, y1 - y0,
        boxstyle="round,pad=0,rounding_size=0.25",
        linewidth=0.8, edgecolor="#DCDCDC", facecolor="none", zorder=0))
    # The rule carries the solver's colour, which is the same colour its residual
    # and its status tag are drawn in, so the card is attributable at a glance.
    ax.plot([x0 + 0.09] * 2, [y0 + 0.16, y1 - 0.16], color=s["color"], lw=3.0,
            solid_capstyle="butt", zorder=1)


def draw(ax, s):
    blank(ax)
    ink = s.get("ink", s["color"])
    card(ax, s)
    cy_hi, cy_lo = 1.9, -1.9
    px, py = 3.4, 0.0

    for cy in (cy_hi, cy_lo):
        camera(ax, 0.0, cy, s=0.62, color=INK)
        ray(ax, 0.7, cy, px, py)
        if s["fixed"]:
            lock(ax, 0.0, cy - 1.1, s=0.62)
        else:
            free(ax, 0.05, cy - 1.05, s=0.62, color=s["color"])

    point(ax, px, py, color=INK)
    residual(ax, px, py, px + 1.5, py + 1.0, s["color"], curved=s["curved"])
    if s["iterative"]:
        # `ink`, not `color`: `loop()` draws its label in the colour it is given, and
        # "repeat" at GREY is unreadable type. The arc darkening with it is fine --
        # MUTED still recedes against the INK line art.
        loop(ax, px + 0.75, py - 1.3, r=0.5, color=ink, label="repeat")

    ax.set_xlim(CARD[0] - 0.15, CARD[2] + 0.15)
    ax.set_ylim(CARD[1] - 0.12, CARD[3] + 0.12)
    # Title block reads top-down: what it is, what it minimises, what the app calls it.
    ax.text(-1.4, 4.3, s["title"], fontweight="bold", va="top", color=INK)
    ax.text(-1.4, 3.6, s["sub"], va="top", color=MUTED, fontsize=7)
    ax.text(-1.4, 3.0, s["tag"], va="top", color=ink, fontsize=7)


def main():
    use()
    # 46 mm, not 50. `blank()` sets aspect="equal" and the card is ~square, so the row
    # height sets the card WIDTH too: at 50 mm each card was 45 mm wide inside a 60 mm
    # slot, i.e. a quarter of the row was gutter that no panel asked for. 46 mm buys
    # back the 4 mm the third footer line costs and keeps the composite off the 200 mm
    # ceiling; the type stays 8 pt, and the tightest clearance in the card -- the
    # status tag above the upper camera -- is still ~0.1 of a data unit.
    #
    # two-thirds, not full: with the joint-BA card cut (review 2026-08) two ~45 mm
    # cards in a 180 mm row would swim in 45 mm of gutter that reads as a missing
    # third card. At 117.3 mm the two cards keep the same slot width they had.
    fig, axes = grid(1, 2, span="two-thirds", row=46.0, despine=False)
    for ax, s in zip(axes, SOLVERS):
        draw(ax, s)
    fig.subplots_adjust(wspace=0.05)
    save(fig, 4, "a", "solvers")


if __name__ == "__main__":
    main()
