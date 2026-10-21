#!/usr/bin/env python3
"""
Fig 1b -- what LUC3D does, end to end. (Was 1a until 2026-08-16, when the cage
render became the figure's opening panel -- Eric.)

EIGHT TILES SINCE 2026-10-09 (Talmo), and "this work" is a COLOUR, not a bracket:

  video acquisition -> videos -> 2D pose -> calibrate ->
      [ cross-view association -> triangulate -> proofread 3D ]  -> 3D pose
      |_________________________ LUC3D App _____________________|

  * Every stage this paper contributes is TEAL; the two DATA tiles (`videos`, the
    `3D pose` output) and the SLEAP tile (`2D pose`) are GREY. A small teal key at
    the left of the bracket band says what teal means.
  * `videos` is its own tile, between acquisition and the detector, and `export` is
    gone: the last tile is the thing exported, `3D pose`, with its formats under it
    (`.slp / H5` -- the SLP version number came off the artwork).
  * `cross-view re-ID` is renamed `cross-view association`, and it, `triangulate`
    and `proofread 3D` -- the three stages that run INSIDE the LUC3D app -- are
    grouped under one teal "LUC3D App" bracket, parallel to the `Panopticon App` and
    `Calibrat3 App` sub-labels on the two other tools this paper contributes.

This supersedes the 2026-09-07 framing below, under which every stage (SLEAP's
detector included) was teal and one "this work" bracket spanned the whole row.
Acquisition (Panopticon) and calibration (Calibrat3) are still this work; the
detector and the two data tiles are not. Everything downstream of acquisition runs
in the browser with no install, which is the claim the capability table's "Install:
none / Runs in: browser" row makes and this panel visualises. (That table was Fig 1e
until 2026-10-09; it is now held out of the first submission for a supplementary
table -- see fig1_04_tool_table.py -- so on the submitted Fig 1 this panel carries
the claim alone.)

HISTORY (2026-09-07, superseded 2026-10-09). The bracket used to stop short on
purpose: `videos` and `2D pose` were drawn grey, because the detector is SLEAP's and
the panel was not to read as a claim over the whole pipeline. Then acquisition and
calibration each got a named tool of their own -- `Panopticon App` for the
multi-camera capture and `Calibrat3 App` for the browser calibration -- and the
bracket was widened to the full row, the detector included (Eric: "i want to edit
figure 1b to include video accquisition ... so that way the 'this work' part
includes the whole pipeline"). The 2026-10-09 colouring takes the detector back
out, which is the narrower and more accurate claim.

Drawn as flat chevrons at one stroke weight, Cheese3D-style: no gradients, no
drop shadows, no 3D boxes.

    python3 figs/panels/fig1_01_pipeline.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon  # noqa: E402
from src.style import MUTED, grid, GREY, INK, TEAL, save, use  # noqa: E402

#: label, sub-label, role, icon kind, group
#:
#: ROLE IS ONE OF "ours", "data", "external" (2026-10-09). "ours" is drawn TEAL and
#: is what the key's "this work" means; "data" (a thing that flows between stages:
#: the raw videos, the exported 3D pose) and "external" (SLEAP's detector) are GREY.
#: The colour is the whole claim now, so it is set here per stage and nowhere else.
#:
#: GROUP names the app a stage runs inside, and consecutive stages sharing one are
#: bracketed together under that name. Only the LUC3D app's three are grouped: the
#: other two tools this paper contributes are one stage each and are already named in
#: their own sub-labels.
#:
#: Icons are the pipeline's own objects (review 2026-08), not generic marks: the same
#: camera tiles run through `videos` (play marks -- no detector has run), `2D pose`
#: (two animals in ONE colour -- identity does not exist yet) and `cross-view
#: association` (each animal in its own identity colour); `triangulate` collapses them
#: into one volume; `proofread 3D` is the re-identified instances; `3D pose` is the
#: output, one animal over the ground plane. The glyphs live in src/diagram.py `icon()`.
#:
#: THE OUTPUT TILE IS THE 3D POSE, NOT "export" (2026-10-09). Export was added
#: 2026-08-13 because emitting SLP with the columnar `/session_data` is what makes the
#: 3D and the identities readable by SLEAP at all, and dropping it made the pipeline
#: look like a dead end. The tile now names WHAT comes out rather than the act of
#: writing it, and keeps the formats as its sub-label.
#:
#: THE TOOLS ARE NAMED (2026-09-07, Eric): acquisition is the `Panopticon App` and
#: calibration the `Calibrat3 App`, each in place of a generic description --
#: `videos` read "N cameras" and `calibrate` read "OpenCV.js browser tool" before.
#: `N cameras` is back since 2026-10-09 as the sub-label of the `videos` data tile.
#:
#: `video acquisition` WRAPS TO TWO LINES, on Eric's instruction ("we should call it
#: 'Video Acquisition' with video on top of acquisition"). It is set lowercase like
#: every other stage label in the row; the App names keep their capitals because
#: they are proper names, not descriptions.
#:
#: CALIBRATION SITS IMMEDIATELY BEFORE CROSS-VIEW ASSOCIATION (Eric, 2026-08-17,
#: correcting a first pass that put it before `triangulate`: "calibration goes before
#: cross-view re-ID!"). That is the technically right edge, and the reason is easy to
#: miss: the cross-view tracker is the FIRST stage that consumes calibration, not
#: triangulation. Its cost model carries a 3D term -- the one Fig 3 ablates, where
#: switching it off costs 632 switches per 100,000 -- and a 3D term means
#: triangulating candidate groupings, which needs the calibration. (It began glued to
#: "videos", then became a labelled arrow into `triangulate`, then a box above the
#: row, then a chevron in it: "lets add the calibration as another tab in the pipeline
#: in line with the others not as a separate thing".) It also keeps the LUC3D app's
#: three stages contiguous, which the group bracket needs.
STAGES = [
    ("video\nacquisition", "Panopticon App", "ours", "cameras", None),
    ("videos", "N cameras", "data", "videos", None),
    ("2D pose", "SLEAP or similar", "external", "tiles2d", None),
    ("calibrate", "Calibrat3 App", "ours", "checkerboard", None),
    ("cross-view\nassociation", "1 ID / animal", "ours", "tilesid", "LUC3D App"),
    ("triangulate", "DLT, N ≥ 2 views", "ours", "volume3d", "LUC3D App"),
    ("proofread 3D", "3D + reproj.", "ours", "instances3d", "LUC3D App"),
    ("3D pose", ".slp / H5", "data", "pose3d", None),
]
ROLE_COLOR = {"ours": TEAL, "data": GREY, "external": GREY}

#: Chevron geometry. The box holds the ICON ONLY and the label sits under it --
#: see `main()` for why the label is no longer inside the chevron.
W, H, GAP, NOTCH = 2.05, 1.05, 0.36, 0.24
#: Horizontal margin each side of the row, in data units.
XPAD = 0.35

#: Millimetres per data unit. THIS, NOT THE PANEL HEIGHT, IS THE FIXED QUANTITY.
#: `blank()` sets aspect='equal' and the drawing is much wider than it is tall, so
#: the axes is HEIGHT-bound and the scale is axes_height / (YLIM range). Every chevron,
#: icon, arrow and bracket therefore prints at (panel height) x (this scale) -- but
#: the TEXT does not, because fontsize is in points.
#:
#: IT HAS A CEILING SET BY THE STAGE COUNT, and above it the aspect fit silently
#: SHRINKS the drawing instead of enlarging it. N chevrons and N-1 gaps span
#: N*W + (N-1)*GAP units, plus 2*XPAD of margin, inside a 179.3 mm axes: 7 stages gave
#: 10.42 (and shipped at 10.35); the 8 stages since 2026-10-09 give 179.3 / 19.62 =
#: 9.14. 9.10 is that ceiling with a rounding margin. The marks are 12% smaller than
#: at seven stages; the type is not.
MM_PER_UNIT = 9.10

def _mm(v):
    """Millimetres -> data units."""
    return v / MM_PER_UNIT


#: EVERYTHING UNDER THE CHEVRONS IS TEXT, SO IT IS PLACED IN MILLIMETRES (2026-10-09).
#: These used to be data-unit constants (-1.42 for the sub-labels, -1.80 for the
#: bracket, -2.20 for the bottom), tuned at one MM_PER_UNIT. But text is sized in
#: points, so when the eighth stage dropped the scale by 12% the two-line labels
#: ("video / acquisition", "cross-view / association") grew 14% in data units and ran
#: into the sub-label baseline. Measured from the chevrons' bottom edge in mm, the
#: layout is the one that shipped at 10.35 and survives any stage count:
#:   label tops 1.66 mm down; sub-labels 9.26 mm down, which clears a two-line 8.5 pt
#:   label; the bracket rule 13.2 mm down; its label 1.0 mm under the rule; and the
#:   ink ends 17.3 mm down.
LABEL_DROP_MM, SUB_DROP_MM, BRACKET_DROP_MM, BRACKET_LABEL_MM, BOTTOM_DROP_MM = (
    1.66, 9.26, 13.2, 1.0, 17.3)
Y_LABEL = -H / 2 - _mm(LABEL_DROP_MM)
Y_SUB = -H / 2 - _mm(SUB_DROP_MM)
Y_BRACKET = -H / 2 - _mm(BRACKET_DROP_MM)

#: Vertical extent of the drawing, in data units, cut to the INK. Top: the chevron's
#: top edge at H/2 plus half of its 1.1 pt stroke and a hair. Bottom: the bracket
#: label's baseline. Nothing is drawn above the chevrons (the `.toml` label that once
#: sat there is gone -- see main()).
YLIM = (-H / 2 - _mm(BOTTOM_DROP_MM), H / 2 + 0.06)

#: Type sizes. Raised on 2026-08-17 (7.5 / 6.5 / 7.0 before, Eric: "make the images
#: and text a bit bigger for legibility") so the text grows with the marks rather
#: than shrinking against them. Fontsize is in POINTS, so it does NOT fall with
#: MM_PER_UNIT.
#:
#: THE STAGE PITCH IS THE CONSTRAINT: 8 stages across 179.3 mm is ~22 mm each. The
#: widest sub-labels are "SLEAP or similar" at 21.5 mm and "DLT, N >= 2 views" 21.0,
#: MEASURED off the rendered text. At 8 stages they no longer each fit their own
#: pitch, so `_check_text_fits` tests what actually matters -- the clear air between
#: NEIGHBOURS -- rather than each label against a whole pitch. "1 identity / animal"
#: (21.9 mm) became "1 ID / animal" on 2026-10-09 because it sat 1.3 mm from
#: "DLT, N >= 2 views" and the two read as one string; "ID" is the word the identity
#: chips in Fig 1a already use, so the claim is unchanged.
LABEL_PT, SUB_PT, BRACKET_PT = 8.5, 7.5, 8.0
#: Icon size in data units. 0.50 before 2026-08-17; the multi-view glyphs are
#: `TILES_W * s` wide (see src/diagram.icon), so this is what sets how much of the
#: chevron's spare width they spend.
ICON_S = 0.56
#: constrained_layout's outer pad, in mm. Nothing is drawn outside the axes here, and
#: the assembler already leaves 4.5 mm of lead above every row for the panel letter,
#: so the default 1.06 mm on each side is 2.1 mm of dead figure.
PAD_MM = 0.35
#: Panel height in mm: the ink, at the scale above, plus the outer pad.
ROW_MM = MM_PER_UNIT * (YLIM[1] - YLIM[0]) + 2 * PAD_MM
#: Minimum clear air between two neighbouring texts on one line, in mm. 2, not 1:
#: at 1.3 mm two adjacent sub-labels already read as one run of text at print size.
MIN_AIR_MM = 2.0


def _check_text_fits(fig, ax, texts):
    """Fail the build if two texts on the same line come within MIN_AIR_MM of each
    other, or if any text runs off the axes.

    Measured off the RENDERED extents, not estimated from a characters-times-width
    rule, which got "OpenCV.js browser tool" wrong by 3 mm on the first pass. Until
    2026-10-09 this demanded that every text fit 96% of ONE stage pitch, which is
    sufficient but not necessary: at 8 stages "SLEAP or similar" (21.5 mm) failed a
    21.0 mm allowance while sitting between "N cameras" and "Calibrat3 App" with 5 mm
    of air on each side. Neighbour clearance is the actual collision condition, so
    that is what is checked -- and it still catches the case that matters, two long
    sub-labels side by side."""
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    per_mm = (ax.transData.transform((1, 0))[0]
              - ax.transData.transform((0, 0))[0]) / MM_PER_UNIT   # px per mm
    ax_x0, ax_x1 = ax.get_window_extent(r).x0, ax.get_window_extent(r).x1
    boxes = [(t.get_text(), t.get_window_extent(r)) for t in texts]
    bad = []
    for name, b in boxes:
        if b.x0 < ax_x0 - 0.5 or b.x1 > ax_x1 + 0.5:
            bad.append(f"{name!r} runs off the axes")
    for i, (n1, b1) in enumerate(boxes):
        for n2, b2 in boxes[i + 1:]:
            if min(b1.y1, b2.y1) <= max(b1.y0, b2.y0):
                continue                                  # not on the same line
            air = max(b2.x0 - b1.x1, b1.x0 - b2.x1) / per_mm
            if air < MIN_AIR_MM:
                bad.append(f"{n1!r} / {n2!r} {air:.1f} mm apart")
    if bad:
        raise SystemExit(
            "pipeline text collides: " + "; ".join(bad) + f" (need {MIN_AIR_MM} mm) "
            "-- wrap it with \\n or shorten it; do NOT shrink the type, which would "
            "break the row's single size")


def chevron(ax, x, y, color, h=H, w=W, notch=NOTCH, lw=1.1):
    pts = [(x, y - h / 2), (x + w - notch, y - h / 2), (x + w, y),
           (x + w - notch, y + h / 2), (x, y + h / 2), (x + notch, y)]
    ax.add_patch(Polygon(pts, closed=True, facecolor="none", edgecolor=color,
                         lw=lw, joinstyle="miter"))


def main():
    use()
    fig, ax = grid(1, 1, span="full", row=ROW_MM, despine=False)
    # `w_pad`/`h_pad` are INCHES. Trimmed to PAD_MM because the axes holds every mark
    # this panel draws -- there is no tick label or title outside it to make room for.
    fig.get_layout_engine().set(w_pad=PAD_MM / 25.4, h_pad=PAD_MM / 25.4)
    blank(ax)

    texts = []
    for i, (label, sub, role, kind, _g) in enumerate(STAGES):
        x = i * (W + GAP)
        color = ROLE_COLOR[role]
        chevron(ax, x, 0.0, color)
        # ICON INSIDE THE CHEVRON, LABEL UNDER IT. The label used to sit inside the
        # chevron too, and it did not fit: a chevron is narrowest exactly where the
        # notch cuts it, so the two-line labels dropped through the bottom edge and
        # the widest one-line label ("proofread 3D") ran out through the right point.
        # The three multi-view glyphs (and `videos`) are WIDE (see src/diagram.icon):
        # they are centred on the same point and spend the chevron's spare width,
        # which is what lets three camera tiles stay legible at this scale.
        # The output pose is drawn in INK inside its GREY data chevron, for the
        # reason tiles2d's mice are: grey is 2.1:1 on white and a ~2 mm pose in it
        # vanishes in print. The chevron carries the role; the glyph has to read.
        icon(ax, kind, x + W / 2 - ICON_S / 2, -ICON_S / 2, s=ICON_S,
             color=INK if kind == "pose3d" else color)
        texts.append(ax.text(x + W / 2, Y_LABEL, label, ha="center", va="top",
                             color=INK, fontsize=LABEL_PT, linespacing=1.25))
        # Sub-labels are all on ONE baseline rather than hung off their own label,
        # so the row reads as a row even though some labels wrap and some do not.
        texts.append(ax.text(x + W / 2, Y_SUB, sub, ha="center", va="top",
                             color=MUTED, fontsize=SUB_PT, linespacing=1.25))

        if i:
            ax.add_patch(FancyArrowPatch(
                (x - GAP + 0.06, 0), (x + 0.04, 0), arrowstyle="-|>",
                mutation_scale=7, color=GREY, lw=0.9, shrinkA=0, shrinkB=0))

    # THE `.toml` LABEL IS GONE (Eric, 2026-08-19: "why does it just say .toml above
    # calibrate ... maybe just get rid of that"). A file extension floating over the
    # chevron row reads as a label for `calibrate` itself rather than for the edge out
    # of it. The output tile's sub-label still names the formats, which is where a
    # reader looks for file types. If it ever comes back, it belongs ON the arrow.

    # THE APP BRACKET: one teal bracket under each run of consecutive stages that share
    # a group, in the band where the full-row "this work" bracket used to be. Derived
    # from STAGES rather than hard-coded, so it follows a stage that moves.
    runs, start = [], 0
    for i in range(1, len(STAGES) + 1):
        if i == len(STAGES) or STAGES[i][4] != STAGES[start][4]:
            if STAGES[start][4]:
                runs.append((STAGES[start][4], start, i - 1))
            start = i
    for name, a, b in runs:
        x0, x1 = a * (W + GAP), b * (W + GAP) + W
        ax.plot([x0, x0, x1, x1], [Y_BRACKET + 0.14, Y_BRACKET, Y_BRACKET,
                                   Y_BRACKET + 0.14], color=TEAL, lw=0.9)
        texts.append(ax.text((x0 + x1) / 2, Y_BRACKET - _mm(BRACKET_LABEL_MM), name,
                             ha="center", va="top", color=TEAL, fontsize=BRACKET_PT,
                             fontweight="bold"))

    # THE "this work" KEY, at the left of the same band. Since 2026-10-09 the
    # contributed stages are not one contiguous run (acquisition, then calibration and
    # the LUC3D app, with data and SLEAP's detector between), so a bracket cannot say
    # "this work" any more and the colour has to. A miniature of the chevron itself is
    # the swatch, so the key shows exactly the mark it explains.
    kh = _mm(2.6)
    ky = Y_BRACKET - _mm(BRACKET_LABEL_MM) - _mm(BRACKET_PT * 25.4 / 72) * 0.55
    chevron(ax, 0.0, ky, TEAL, h=kh, w=kh * 1.9, notch=kh * 0.24, lw=0.9)
    texts.append(ax.text(kh * 1.9 + _mm(1.2), ky, "this work", ha="left",
                         va="center", color=TEAL, fontsize=BRACKET_PT,
                         fontweight="bold"))

    span = len(STAGES) * (W + GAP) - GAP
    ax.set_xlim(-XPAD, span + XPAD)
    ax.set_ylim(*YLIM)
    _check_text_fits(fig, ax, texts)
    save(fig, 1, "b", "pipeline")


if __name__ == "__main__":
    main()
