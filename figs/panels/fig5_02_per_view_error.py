#!/usr/bin/env python3
"""
Fig 5a -- what the app reports for the frame you are on: the reprojection against
the detection (two tiles), and the per-view reprojection error for every animal.

This is the signal a proofreader actually sees: LUC3D's Instance Info panel reports,
per animal, the reprojection error in each camera. The panel shows why that is
usable as a triage signal -- one animal in this frame sits at ~12 px mean while the
other two sit near 3 px, and the outlier is visible in EVERY view rather than in one.

THE TWO TILES ARE THE EVIDENCE, and they were briefly deleted from this panel. Fig 5
claims a human reads a number off the screen; without the screen the panel is a plot
of three numbers and nothing shows what the number MEANS. So:
  * LEFT tile -- the whole frame as the app draws it, all three animals, all
    overlays, framed on the app-recorded bbox of the instances in that view.
  * RIGHT tile -- MAGNIFIED on the single (view, animal) with the largest residual
    among the exported views, which is the one place the disagreement is actually
    SEEABLE. At an all-views solve most keypoints agree to ~3 px, invisible at print
    size, so a whole-frame tile alone would illustrate nothing. The bar chart says
    that crop is 16.8 px rather than merely "large".
  * The key underneath decodes the overlay (solid / dotted / red). Without it the
    magnified tile is uninterpretable.
The (view, animal) pick is computed from the manifest, not hard-coded, so it cannot
drift away from the number printed on the tile.

GROUPED BARS, NOT A LINE. Cameras are a CATEGORICAL axis: a line from mid to topB to
topC implies ordering and interpolation between cameras that do not exist, and the
"dip at topL" it draws for animal 2 is an artefact of the manifest's camera order.

STAGED FROM AN ALL-VIEWS SOLVE, ON PURPOSE. An earlier draft reused Fig 2a's tiles
and numbers, which come from a deliberately crippled TWO-ANCHOR solve where every
non-anchor residual is inflated by construction (up to 24.6 px). That inflation is
Fig 2's point and the exact opposite of this one: Fig 5 is about proofreading a
fully-informed 3D. Hence `fig5_panel_a.mjs`, a staging run of its own.

ONE FRAME, THREE ANIMALS, EIGHT CAMERAS. This is an illustration of the readout, not
a corpus statistic -- the corpus statistics are panel c and Fig 6c. The caption must
say so.

Source: figs/out/fig5a.json (`reprojErrorsAllViews` + `views.check`) and the app
exports figs/out/fig5a-f150-*.png, both written by:

    node figs/fig5_panel_a.mjs        # re-stages the frame and re-exports the tiles

    python3 figs/panels/fig5_02_per_view_error.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, FIGS, GREY, SET2, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, tile, use)

#: Fraction of the animal's longer bbox side added on EVERY side of the magnified
#: crop, so the tile shows the animal plus enough cage to read the error segments
#: against. Matches the legacy panel's 0.40-per-side framing.
ZOOM_PAD = 0.80

KEY = "solid = detected · dotted = reprojected from the 3D · red = the error"


def pretty(name):
    """`Camera4_topR` -> `cam 4 topR`, the app's own view name made readable."""
    return name.replace("Camera", "cam ").replace("_", " ")


def worst_view_animal(j):
    """The (view, animal, error) with the largest residual AMONG THE EXPORTED VIEWS.

    Only three of the eight views were exported as PNGs, so the pick has to be
    restricted to those -- otherwise it names a tile that does not exist. Returned
    straight out of the manifest so the crop and the printed number always agree.
    """
    best = None
    for v in j.get("views", {}).get("check", []):
        for det in v.get("details") or []:
            for rec in j.get("reprojErrorsAllViews") or []:
                if det.get("identity") != f"id_{rec.get('identity')}":
                    continue
                e = (rec.get("perView") or {}).get(v["name"])
                if e is not None and (best is None or e > best[2]):
                    best = (v, det, e)
    return best


def main():
    use()
    j = load("fig5a.json")
    errs = j["reprojErrorsAllViews"]

    rows = []
    for e in errs:
        for cam, v in e["perView"].items():
            rows.append({"identity": e["identity"], "camera": cam,
                         "reproj_px": v, "mean_px": e["meanError"]})
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5a_per_view_error.csv")

    cams = list(errs[0]["perView"])
    # Camera names carry a role suffix (Camera6_sideL); the role is the informative
    # half, so the tick shows that rather than the index.
    # "0 mid", not "mid": this panel's own tile badges read "cam 0 mid" / "cam 4 topR",
    # so bare role names put two camera-naming conventions inside ONE panel and made
    # the bars look like they belonged to different cameras from the tiles. The index
    # is what ties a bar to a tile. Legacy used this same short "0 mid" form on the
    # axis, keeping "cam N name" for the badges where there is room for it.
    labels = [f"{c[6:].split('_', 1)[0]} {c.split('_', 1)[1]}"
              if c.startswith("Camera") and "_" in c
              else (c.split("_", 1)[1] if "_" in c else c) for c in cams]
    x = np.arange(len(cams))

    # Two square image tiles and the bar chart, in one panel, at 180 mm: the tiles
    # and the numbers are one idea (what the app reports for this frame) and were
    # laid out together in the legacy figure.
    fig, axes = grid(1, 3, span="full", row=58.0,
                     gridspec_kw={"width_ratios": [1.0, 1.0, 2.35]})
    ax_l, ax_r, ax = axes
    # An `imshow` axes shrinks to its image's aspect inside the box it was given, and
    # by default it shrinks about the CENTRE -- which floated both tiles half a
    # centimetre below the bar chart's top spine. Anchor them north instead, and size
    # the width ratios so the slot is about as wide as the height allows the (square)
    # tile to be, or the leftover shows up as a gap between the tiles.
    for a in (ax_l, ax_r):
        a.set_anchor("N")
    # A band at the bottom for the overlay key, drawn in FIGURE coordinates because
    # it spans both tiles rather than belonging to either axes. NOTE the signature:
    # set(rect=(left, bottom, WIDTH, HEIGHT)) -- passing (left, bottom, right, top)
    # here silently ate the top of both tiles once.
    fig.get_layout_engine().set(rect=(0.0, 0.052, 1.0, 0.948))

    left = j.get("views", {}).get("check") or []
    pick = worst_view_animal(j)
    if left and pick:
        v = left[0]
        b = v["bbox"]
        # The manifest records an ABSOLUTE path from the machine that staged the run,
        # so resolve by basename against figs/out/ -- otherwise the panel only builds
        # on that machine.
        tile(ax_l, FIGS / "out" / Path(v["file"]).name,
             (b["x0"], b["y0"], b["x1"], b["y1"]), badge=pretty(v["name"]))
        vv, det, err = pick
        bx0, by0, bx1, by1 = det["box"]
        tile(ax_r, FIGS / "out" / Path(vv["file"]).name,
             (bx0, by0, bx1, by1), pad=ZOOM_PAD,
             badge=f"{pretty(vv['name'])} · {det['identity'].replace('id_', 'animal ')}")
        # The magnitude, on the tile it belongs to. White like the other badges, so
        # it reads on the picture and lint_text.py leaves it alone. BOTTOM right, not
        # top right: "cam 4 topR · animal 2" is long enough at this tile width to run
        # straight into a top-right corner value.
        ax_r.text(0.97, 0.03, f"{err:.1f} px", transform=ax_r.transAxes, ha="right",
                  va="bottom", color="white", fontsize=6.5, fontweight="bold")
        fig.text(0.006, 0.014, KEY, color=MUTED, fontsize=6.0, ha="left", va="bottom")
    else:
        # Never fabricate a tile: say what is missing and what makes it.
        print("  WARNING: figs/out/fig5a.json has no views.check exports — "
              "panel a is drawing the bar chart only. Run: node figs/fig5_panel_a.mjs")
        for a in (ax_l, ax_r):
            a.set_axis_off()
            a.text(0.5, 0.5, "run\nnode figs/fig5_panel_a.mjs", ha="center",
                   va="center", color=MUTED, fontsize=6.5)

    worst = max(max(e["perView"].values()) for e in errs)
    ymax = 5.0 * math.ceil(worst / 5.0)
    w = 0.82 / len(errs)
    for i, e in enumerate(errs):
        vals = [e["perView"][c] for c in cams]
        ax.bar(x + (i - (len(errs) - 1) / 2) * w, vals, w, color=SET2[i], zorder=3)

    # The key sits INSIDE the bar axes, upper left: with three axes in one panel the
    # figure-coordinate "above" band would land over the left tile, and the upper
    # left of this axes is empty (no bar there exceeds half the y range).
    text_legend(ax, [(f"animal {e['identity']}  (mean {e['meanError']:.1f} px)",
                      SET2[i]) for i, e in enumerate(errs)],
                "upper left", size=6.5, dy=0.088)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.set_ylabel("reprojection error (px)")
    ax.set_ylim(0, ymax)
    ax.set_yticks(np.arange(0, ymax + 1, 5))
    footnote(ax, f"one frame ({j['frame']}), {len(cams)} cameras, all-views solve")
    save(fig, 5, "a", "per_view_error")


if __name__ == "__main__":
    main()
