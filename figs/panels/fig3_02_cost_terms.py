#!/usr/bin/env python3
"""
Fig 3b -- the association cost itself: what one (target, detection) pair scores.

RESTORED. This panel existed in the legacy figure (`figs/legacy/fig3.py panel_b`)
and was dropped in the restyle, which shifted the letters so that legacy 3c became
3b and the deletion left no gap. It is the method the rest of the figure rests on:
panel a shows the SHAPE of the search, c what the exhaustive search COSTS, d what
LUC3D's search costs, e what the 3D term buys and f the two run head to head --
but none of them say what is being minimised. This panel does, and it prints the
two terms verbatim so a reader can check the implementation against the artwork.

Both terms are drawn in the space they live in, which is the whole point of drawing
them at all rather than setting them as running text in the caption:

  * The 2D term is a distance IN ONE VIEW: the target's current 3D estimate is
    projected into this camera (pi(t)) and compared with the detection d there. It
    decays with the age of the target (e^-lambda.dt), so a target that has not been
    seen for a while stops competing.
  * The 3D term is a distance IN SPACE: the detection back-projects to a ray, and
    the cost is the perpendicular distance from the target's 3D point to that ray.
    No projection, no image plane -- which is why it is drawn as a separate
    geometry rather than as another term on the same picture.

Both are normalised by their own threshold and weighted per node (w_k), and the
per-node contributions are summed. The relative weight of the two terms is
r = corr3d / corr2d, which is exactly the axis panel e sweeps.

NO NUMBERS ON THIS PANEL. It is a definition, not a measurement; the shipped
weights (corr2d 1, corr3d 6) are stated by panel e's `shipped r = 6` rule so they
are not asserted twice, and the Methods sentence the legacy panel used to carry
("summed over nodes; cost = -Sigma; w_k = 0 drops a node") lives in
figs/captions/fig3.md. Running prose does not belong on the artwork.

Source: none -- this is a schematic of `pose/tracker.js`'s cost function.

    python3 figs/panels/fig3_02_cost_terms.py
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.patches import Rectangle

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon, point, ray  # noqa: E402
from src.style import MUTED, GREY, INK, PERIWINKLE, TEAL, grid, save, use  # noqa: E402

#: Data-space box. The panel is 88 x 52 mm, so 10 x 5.9 data units keeps one unit
#: square-ish in both directions and the geometry undistorted -- `aspect("equal")`
#: cannot be used here because it would shrink the axes inside the declared panel
#: size instead of filling it.
W, H = 10.0, 5.9

#: The two terms, verbatim. Subscripts/superscripts go through mathtext because the
#: unicode forms (U+2096 etc.) are not in Liberation Sans and render as boxes.
EQ_2D = ("2D   w$_k$ · corr2d · (1 − |d − π(t)| / velThresh) "
         r"· e$^{-\lambda \Delta t}$")
EQ_3D = "3D   w$_k$ · corr3d · (1 − dist(t, ray(d)) / distThresh)"


def foot_of_perpendicular(p, a, b):
    """Where the perpendicular from `p` meets the line `a`->`b`, in data space."""
    p, a, b = np.asarray(p), np.asarray(a), np.asarray(b)
    v = b - a
    s = float(np.dot(p - a, v) / np.dot(v, v))
    return a + s * v


def draw_2d(ax):
    """The target projected into one view, against the detection in that view."""
    icon(ax, "camera", 0.40, 4.05, s=0.78, color=INK)
    proj, det = (3.40, 4.58), (4.95, 4.16)
    # The projection itself: camera -> pi(t), solid and light, so the reader sees
    # that pi(t) is a projected point and not a second detection.
    ray(ax, 1.22, 4.40, *proj, color=GREY)
    # The residual the term measures, dashed, in the term's own colour.
    ray(ax, *proj, *det, color=PERIWINKLE, ls=(0, (2.2, 1.4)), lw=1.0)
    point(ax, *proj, color=PERIWINKLE, r=0.13)
    point(ax, *det, color=INK, r=0.11)
    ax.text(proj[0], proj[1] + 0.30, "π(target)", color=PERIWINKLE, fontsize=6.5,
            ha="center", va="bottom")
    ax.text(det[0] + 0.26, det[1] - 0.04, "detection d", color=INK, fontsize=6.5,
            ha="left", va="center")
    # 8.0, not 7.0: mathtext sub/superscripts render at ~0.7x, so a 7 pt
    # equation puts its w_k subscript at 4.9 pt, under the 5 pt floor.
    ax.text(0.40, 3.42, EQ_2D, color=PERIWINKLE, fontsize=8.0, va="center")


def draw_3d(ax):
    """The target's 3D point against the ray the detection back-projects to."""
    icon(ax, "camera", 0.40, 1.72, s=0.78, color=INK)
    a, b = (1.22, 2.26), (8.60, 1.22)
    ray(ax, *a, *b, color=GREY)
    # BELOW the ray, not above it. Above, the label's box bottom edge lands on the
    # stroke itself -- lint_text.py's ink-under-text check sees that, and so does a
    # reader. Below the line at this x there is nothing until the 3D term.
    lx = 7.00
    ly = a[1] + (lx - a[0]) / (b[0] - a[0]) * (b[1] - a[1])
    ax.text(lx, ly - 0.30, "ray(d)", color=MUTED, fontsize=6.5, ha="center",
            va="top")
    t = (4.50, 2.66)
    f = foot_of_perpendicular(t, a, b)
    ray(ax, *t, *f, color=TEAL, ls=(0, (2.2, 1.4)), lw=1.0)
    point(ax, *t, color=TEAL, r=0.13)
    # BESIDE the point, not above it: above, it closed to ~1 mm of the 2D equation.
    ax.text(t[0] - 0.28, t[1], "target t", color=TEAL, fontsize=6.5, ha="right",
            va="center")
    ax.text(0.40, 0.58, EQ_3D, color=TEAL, fontsize=8.0, va="center")


def main():
    use()
    fig, ax = grid(1, 1, span="half", row="std", despine=False)
    blank(ax)
    ax.set_aspect("auto")
    ax.add_patch(Rectangle((0, 0), W, H, fill=False, ec="#DDDDDD", lw=0.8))
    ax.text(0.40, 5.42, "Cost per (target, detection) pair", fontweight="bold",
            color=INK, fontsize=7.5, va="center")
    draw_2d(ax)
    draw_3d(ax)
    ax.set_xlim(-0.1, W + 0.1)
    ax.set_ylim(-0.1, H + 0.1)
    save(fig, 3, "s1", "cost_terms")


if __name__ == "__main__":
    main()
