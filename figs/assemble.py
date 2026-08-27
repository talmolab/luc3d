#!/usr/bin/env python3
"""
Assemble the per-panel PDFs into a composite figure.

`figures-mimic-mjx` stops at one PDF per panel and assembles by hand in Illustrator.
This does that step in code so the whole figure is reproducible end to end, while
keeping the per-panel PDFs as the primary artefact -- they are still the thing you
open in Illustrator when you want to nudge something by eye.

HOW IT WORKS. Each panel PDF is embedded as VECTOR content via PyMuPDF's
`show_pdf_page`, not rasterised, so type stays live and editable downstream and the
composite carries exactly the strokes the panel scripts drew. Panel letters are set
in Helvetica-Bold, metric-compatible with Arial and one of the base-14 fonts every
PDF consumer has, so the letters match the panels' body type without embedding a
second family.

LAYOUT IS BY ROWS, NOT BY COORDINATES, and that is deliberate. Only each panel's
WIDTH is specified; its height follows from its own aspect ratio, and each row is
placed below the tallest panel of the row above it. Hand-written y coordinates were
tried first and produced exactly the failure you would expect -- Fig 1's tall 3D
panel ran into the tool table below it, and Fig 7's axis labels ran into the next
row's legend -- because the author of the layout does not know how tall
`bbox_inches="tight"` made a panel. Nothing here can overlap.

Nature's double-column width is 180 mm, single column 88 mm. Keep the finished
artwork under ~200 mm so a caption still fits on a 247 mm page; `assemble()` warns
when a figure exceeds that.

    python3 figs/assemble.py            # every figure that has panels
    python3 figs/assemble.py 4 2        # just these
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz

FIGS = Path(__file__).resolve().parent
FIGURES = FIGS / "figures"

MM = 72.0 / 25.4          # mm -> PostScript points
LETTER_PT = 9.0           # panel letters, a step above the 8 pt body
INK = (0.30, 0.30, 0.30)  # matches src.style.INK (#4C4D4C)

MARGIN = 3.0              # mm, top/bottom page margin
PAGE_W = 180.0            # mm, Nature double column (matches src.style.PAGE_W)
GUTTER = 4.0              # mm between panels in a row (matches src.style.GUTTER)
ROW_GAP = 3.5             # mm between rows (also clears the panel letter)
LETTER_LEAD = 4.0         # mm of headroom reserved above each row for its letters
MAX_H = 200.0             # mm, soft ceiling -- warn past this
PREVIEW_DPI = 300         # the composite .png proof; the .pdf is the artefact
FOOTER_PT = 6.5           # figure-level provenance footer
FOOTER_LEAD = 3.4         # mm per footer line

#: figure -> provenance footer. The legacy set carried one of these on every figure
#: naming corpus, n and the caveats; the restyle dropped them all and Fig 4 ended up
#: with NO provenance on the artwork at all. Panel letters are not provenance.
#: Keep each line under ~150 characters so it fits 180 mm at 6.5 pt.
#: FIGURE-LEVEL FOOTERS ARE NO LONGER DRAWN. Every figure used to carry two to five
#: lines of grey provenance under the artwork -- corpus, n, method caveats. That is
#: caption text, and a submitted figure should not set its own caption: the journal
#: sets it, in the legend, in the journal's type. All of it now lives in
#: `figs/FIGURE-LEGENDS.md` (the legends as they should be pasted into the
#: manuscript), `figs/METHODS.md` (how each number was produced) and
#: `figs/PANEL-SOURCES.md` (which script made which panel).
#:
#: The mechanism is kept, not deleted: an entry here is still drawn, so a working
#: draft can put provenance back on the artwork while a figure is being audited.
FOOTERS: dict[int, list[str]] = {}

#: (figure, letter) -> panel title, drawn beside the letter at assembly.
#:
#: The legacy set gave every panel a bold title and the restyle dropped all of them,
#: leaving bare letters. `figures-mimic-mjx` has no panel titles -- but it also does
#: not assemble, and its letters are added by hand in Illustrator where a title would
#: be typed alongside. Dropping the titles cost real navigation: seven figures of
#: unlabelled letters make the reader carry the caption to understand any panel.
#:
#: They are drawn HERE, not in the panels, for two reasons. Panel scripts have no
#: vertical headroom for a title (fig4's b/c/d had to shed y-label lines just to fit
#: their provenance), and a title inside a panel would scale with the panel while the
#: letter beside it did not. At assembly both are one typographic unit.
TITLES = {
    # MANUSCRIPT RENUMBERING 2026-08-26 (Eric): the six manuscript figures map
    # onto the repo's former numbering as 1, 2, 13, 5, 6, 11 -> 1, 2, 3, 4, 5, 6.
    # Figures 3(old), 4(old), 7-13 no longer exist as their own compositions;
    # their design history lives in git (eric/figs before this commit).
    # Fig 1 re-lettered 2026-08-16 (Eric: cage render leads the figure).
    (1, "a"): "Dataset arena visualizations with camera rigs and poses",
    (1, "b"): "Pipeline",
    (1, "c"): "Cross-view re-identification",
    (1, "d"): "Triangulated 3D",
    (1, "e"): "Capability comparison",
    (2, "a"): "Protocol",
    (2, "b"): "Placements vs rig size",
    (2, "c"): "Error vs cameras in the solve",
    (2, "d"): "Anchor-pair geometry",
    # Row 3 added 2026-08-20 (Eric: "add 13 g i and j to fig 2 as the third
    # column in that fig") -- see panels/fig2_06_solver_accuracy.py's docstring.
    (2, "e"): "Accuracy vs cameras used",
    (2, "f"): "Triangulation: LUC3D vs Anipose",
    (2, "g"): "Time per keypoint",
    # Fig 3 (cross-view tracking; the repo's fig13, itself the old fig3 + fig4
    # combination). NO (3, "b") ENTRY, deliberately: b is stacked directly
    # under a into ONE composite PDF (fig3_sync.build_stack), which draws b's
    # LETTER only -- the shipped artwork carries no b title, and an entry here
    # would make build_stack start drawing one. NO (3, "h") ENTRY: h (the
    # sweep's IDF1 half, under g in the block's second column composite) is
    # deliberately untitled -- g's title covers the stacked pair and h's y
    # label names its metric.
    (3, "a"): "Grouping strategies",
    (3, "c"): "Visualization of ID grouping hypotheses in two camera views",
    (3, "d"): "An identity switch in one camera view",
    (3, "e"): "Grouping accuracy",
    (3, "f"): "Time per frame",
    (3, "g"): "3D term sweep",
    # Fig 4 (social rearing; the repo's fig5).
    (4, "a"): "3D pose and 2D camera views for social rearing behavior",
    (4, "b"): "Both rise, noses converge — female reaches higher",
    (4, "c"): "One animal is up first",
    (4, "d"): "Female is still; male is travelling",
    (4, "e"): "Male is pursuing female",
    (4, "f"): "Female initiates displays",
    (4, "g"): "Female rears first; male mostly joins in",
    # Fig 5 (SLAP-2M datasets; the repo's fig6, re-lettered 2026-08-19 --
    # difficulty grid leads the figure).
    (5, "a"): "Levels of tracking difficulty",
    (5, "b"): "Cross-view IDF1 by difficulty",
    (5, "c"): "Missing keypoints vs difficulty and cameras",
    (5, "d"): "Animal-count control",
    (5, "e"): "Detection quality",
    (5, "f"): "Difficulty strata",
    # Fig 6 (supplementary identity comparison + fresh-anchor sweep; the repo's
    # fig11, itself the old fig7 tracker comparison + the old fig8d sweep + the
    # Chen-2020-style anchor diagram). a is the pre-merged 2x2 tracker block
    # (fig6_sync.build_block); its b/c/d sub-letters are drawn via EXTRA_LETTERS.
    (6, "a"): "Within vs cross IDF1",
    (6, "b"): "Within-view IDF1",
    (6, "c"): "Per-session paired difference",
    (6, "d"): "Error composition",
    (6, "e"): "The tracker's 2D and 3D anchor correspondence",
    (6, "f"): "Staleness horizon sweep on Mouse-Dyad-10M sessions",
}
TITLE_PT = 7.5            # panel titles, below the 9 pt letter

#: Panel titles are CENTRED OVER THEIR AXES rather than set flush beside the letter
#: (Eric, 2026-08-18: "the letters can stay where they are but the titles should be
#: more centered, moved to the right a centimeter or two so that they are more centered
#: above the x axis" -- then, for every other figure, "can we do the same thing for the
#: titles in all the other figures?"). On a plot panel the letter sits at the panel's
#: left edge while the axes start past the y label and its ticks, 13-16 mm in on a
#: third-width panel, so a flush title reads as hanging off the left of the plot it
#: names.
#:
#: There is no table of offsets: `axes_extent` reads the spines out of each panel's own
#: PDF and the title is centred on them, so a redrawn or resized panel keeps its title
#: centred instead of drifting off a stale constant. A panel with no spines -- an image
#: plate, a schematic, a rule-only table -- reports none and keeps the flush position,
#: which is the right answer there: its ink already starts at the panel's left edge.
#: Opt out by letter here if a particular title is better off flush.
#: (3, "a"): the a/b stack composite carries BOTH panels' drawings on one page,
#: so axes_extent's spine scan would centre a's title on b's real (ticked) axes
#: rather than a's own (a has none -- it is a blank schematic). Flush is the
#: correct position for a anyway; this just avoids the ambiguous measurement.
#: (2, "e"): same reasoning, for Fig 2's own merged accuracy/worst-camera panel
#: (`panels/fig2_06_solver_accuracy.py`, moved here from the draft Fig 13's "g")
#: -- it has TWO real ticked axes on one page, so this is a genuine
#: simplification (it would otherwise centre on the union of both axes'
#: spines), not a no-op.
#: (6, "a"): the entry is the pre-merged 2x2 block, whose axes_extent spans all
#: four sub-panels -- centring drifted a's title onto b's (drawn flush by
#: EXTRA_LETTERS, which axes_extent cannot serve either).
TITLE_FLUSH: set[tuple[int, str]] = {(3, "a"), (2, "e"), (6, "a")}

#: (figure, letter) -> extra mm to shift a title RIGHT of where the rules above
#: put it. For a plate -- an image panel with no axes for `axes_extent` to find
#: -- the title falls back to flush beside the letter, which on a wide plate
#: leaves it hanging at the far left while every neighbouring plot panel has
#: its title centred over its axes. There is nothing in the PDF to centre on,
#: so the alignment has to be stated.
#:
#: EMPTY. Fig 13's c was nudged here for a while to sit over the e/f column
#: below it, but a plate's title starts a fixed 4.4 mm after its own letter,
#: so pulling the title left far enough to reach that column ran it into the
#: letter. The alignment Eric was after is done with LETTER_NUDGE_MM instead --
#: see there.
TITLE_NUDGE_MM: dict[tuple[int, str], float] = {}

#: (figure, letter) -> extra mm to shift a panel LETTER right.
#:
#: A letter normally HANGS 2 mm left of its panel (`lx = max(0.6, x - 2.0)`),
#: out in the gutter. A letter drawn INSIDE a pre-merged composite cannot do
#: that -- `build_column`/`build_stack` have no negative coordinates to draw
#: into, so they set their inner letters at composite_x + 0.6. The two rules
#: disagree by 2.6 mm, which is why Fig 13's e sat 2.6 mm left of f, and g of h
#: (Eric, 2026-08-25: "the literal letters e and f do not look vertically
#: aligned, the literal letters g and h are not vertically aligned").
#:
#: Nudging the composite's OWN letter to +0.6 makes each stacked pair line up.
#: c gets the same +2.6 so that EVERY letter on this figure sits at
#: panel_x + 0.6: a and d already do (they start at x = 0, so the max() clamps
#: them there), f and h are drawn there inside their composites, and c/e/g are
#: nudged onto it. That is what puts c's letter over e's -- the two panels
#: start within 0.04 mm of each other -- which is the alignment Eric asked for
#: ("move the 13c title over ... so it aligns with e and f"); the title then
#: follows its own letter at the usual 4.4 mm, as on every other panel.
LETTER_NUDGE_MM: dict[tuple[int, str], float] = {
    (3, "c"): 2.6, (3, "e"): 2.6, (3, "g"): 2.6,
}

#: (figure, entry letter) -> [(sub letter, dx_mm, dy_mm), ...]: extra letters the
#: ASSEMBLER draws onto a pre-merged composite, at (panel_x + dx, panel_y + dy)
#: with the same -1.2 mm baseline rise and TITLES lookup as any entry letter.
#:
#: This exists because fig3's approach -- composites drawing their INNER letters
#: themselves -- cannot letter a sub-panel on a composite's TOP row: the letter
#: band sits ABOVE the panel, i.e. outside the composite's own page, and content
#: outside the page is clipped. Drawn here instead, a top-row sub-letter lands in
#: the assembler's own lead band, at exactly the height of the neighbouring
#: entries' letters ("make sure that the letters vertically align", Eric
#: 2026-08-25). A dy > 0 letters a lower row inside the composite, whose headroom
#: is the composite's own inter-row gap. Sub-letter TITLES are placed flush
#: (letter + 4.4 mm) -- axes_extent cannot see one sub-panel inside a merged PDF.
#:
#: Fig 6a is the 2x2 a-d tracker block (fig6_sync.build_block, which PRINTS
#: these offsets on every run -- copy them here after any geometry change).
EXTRA_LETTERS: dict[tuple[int, str], list[tuple[str, float, float]]] = {
    (6, "a"): [("b", 43.51, 0.0), ("c", 0.0, 29.95), ("d", 43.51, 29.95)],
}

#: figure -> [row, ...] where a row is [(letter, slug), ...].
#: NO SIZES HERE. Panels are built on the column grid in src/style.py and saved at
#: exactly their declared size, so the assembler places each at its true width and
#: a row is simply the panels that share it. Widths that disagreed with the panels'
#: real sizes were how the first pass produced ragged rows.
LAYOUTS = {
    # MANUSCRIPT RENUMBERING 2026-08-26: see the note atop TITLES. Rows are
    # carried over verbatim from the figures they renumber (1<-1, 2<-2, 3<-13,
    # 4<-5, 5<-6, 6<-11); the per-figure design history lives in git.
    1: [[("a", "render")],
        [("b", "pipeline")],
        [("c", "tracking")],
        [("d", "reconstruction")],
        [("e", "tool_table")]],
    2: [[("a", "protocol")],
        [("b", "placements_vs_rig"), ("c", "reprojection_accuracy"),
         ("d", "baseline_angle")],
        [("e", "solver_accuracy"), ("f", "per_session"), ("g", "time_per_keypoint")]],
    # a/b are pre-merged by fig3_sync.build_stack (b's letter/title drawn onto
    # the composite); e/f and g/h are that sync's two column composites.
    3: [[("a", "association"), ("c", "hyp_illustration")],
        [("d", "idswitch"), ("e", "quality_col"), ("g", "sweep_col")]],
    4: [[("a", "upright_views"), ("b", "upright_dynamics")],
        [("c", "upright_initiator"), ("d", "upright_velocity"),
         ("e", "upright_stats")],
        [("f", "leader"), ("g", "rear_coupling")]],
    5: [[("a", "enrichment_grid")],
        [("b", "idf1_by_difficulty"), ("c", "recovery_surface")],
        [("d", "animal_count"), ("e", "detection_quality")],
        [("f", "difficulty_strata")]],
    # a is the pre-merged 2x2 tracker block (fig6_sync.build_block; sub-letters
    # b/c/d drawn via EXTRA_LETTERS so they sit level with a and e); the anchor
    # diagram spans both of a's rows; the sweep closes the rectangle full width.
    6: [[("a", "block"), ("e", "chen_style")],
        [("f", "pr_switches")]],
}


def axes_extent(pdf: Path) -> tuple[float, float] | None:
    """(x0, x1) spanned by a panel's axes, in mm from its own left edge.

    A SPINE, not merely a long horizontal line: the stroke must have a vertical
    stroke meeting one of its ends, which is what separates an x axis from a table
    rule (`fig1e`, `fig6f` and `fig6h` are full-width rules with no verticals at
    all, and they keep the flush title). The extent is the union over every such
    spine, so a panel holding a row of sub-plots -- `fig6g`'s three, `fig11j`'s
    three -- centres over the whole row rather than over its first axes.

    Returns None when nothing qualifies, or when the axes already start at the
    panel's left edge, where centring would move a title that is not misplaced.
    """
    doc = fitz.open(pdf)
    page = doc[0]
    w, h = page.rect.width, page.rect.height
    # WHETHER TICKS ARE REQUIRED depends on whether the panel embeds an image. The
    # thing a spine can be confused with is an image tile's border, and only a panel
    # that places a raster HAS tiles -- so a plate (`fig5a`, `fig6a`, `fig6b`,
    # `fig11g`) must show ticks before its "spine" is believed, while a vector plot
    # can be taken on the corner alone. That distinction is what lets `fig4d`,
    # `fig7f` and `fig11f` centre: their axes are categorical, drawn with no tick
    # marks at all, so a ticks-always rule left exactly the panels Eric asked about
    # sitting flush.
    plate = bool(page.get_images())
    hor, ver = [], []
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] != "l":
                continue
            p0, p1 = it[1], it[2]
            # 0.15, not 0.25, of the panel width: a panel holding a ROW of small
            # sub-plots has short spines -- `fig6g`'s three run 44.8 mm on a 180 mm
            # panel (0.249) and `fig11j`'s 7.5 mm on 36.4 (0.21) -- and at 0.25 both
            # fell through to the flush position by a hair. Nothing else in these
            # panels is a long horizontal WITH a vertical at one end: box medians and
            # whisker caps are millimetres, legend rules have no verticals, and bars,
            # heat cells and colour bars are rectangles rather than lines.
            if abs(p0.y - p1.y) < 0.4 and abs(p1.x - p0.x) >= 0.15 * w:
                hor.append((min(p0.x, p1.x), max(p0.x, p1.x), p0.y))
            elif abs(p0.x - p1.x) < 0.4:
                # EVERY vertical, at every length: the long ones are candidate y
                # spines and the SHORT ones are the tick marks the test below needs.
                # Filtering by length here is the bug that made this reject every
                # panel in the set -- a 1.7 mm tick on a 52 mm panel is 0.03 of its
                # height and never survived a 0.15 gate.
                ver.append((p0.x, min(p0.y, p1.y), max(p0.y, p1.y)))
    doc.close()
    # AN AXES IS A SPINE *PLUS ITS TICKS*, and the ticks are what make the test
    # sound. A corner alone is not enough: an image tile's border draws exactly the
    # same signature -- a long horizontal with a vertical rising from its left end --
    # and on `fig5a`'s plate of five camera views that misread the tile frames as
    # axes and threw the title 52 mm right. Only a real x axis also carries short
    # verticals hanging DOWN off the stroke at the tick positions, so requiring two
    # of them separates plots from plates, tables and schematics.
    def ticked(x0: float, x1: float, y: float) -> bool:
        corner = any((abs(vx - x0) < 1.0 or abs(vx - x1) < 1.0)
                     and (vy1 - vy0) >= 0.15 * h
                     for vx, vy0, vy1 in ver if vy0 - 1.0 <= y <= vy1 + 1.0)
        ticks = sum(1 for vx, vy0, vy1 in ver
                    if abs(vy0 - y) < 0.6 and (vy1 - vy0) <= 3.5 * MM
                    and x0 - 0.5 <= vx <= x1 + 0.5)
        return corner and (ticks >= 2 or not plate)

    spines = [(x0, x1) for x0, x1, y in hor if ticked(x0, x1, y)]
    if not spines:
        return None
    x0 = min(s0 for s0, _ in spines) / MM
    x1 = max(s1 for _, s1 in spines) / MM
    return None if x0 < 3.0 else (x0, x1)


def panel_pdf(fig_no: int, letter: str, slug: str) -> Path | None:
    p = FIGURES / f"fig{fig_no}" / f"fig{fig_no}{letter}_{slug}.pdf"
    return p if p.exists() else None


def stale(fig_no: int) -> list[str]:
    """Panels whose SOURCE is newer than their rendered PDF.

    A composite silently embedding superseded panel content is reachable and was
    reached: between two edits the committed figN.pdf carried a clipped row and a
    miscoloured key while every file was present and looked complete. Nothing in
    the build noticed, because `assemble` only checks that a panel PDF EXISTS.
    """
    out = []
    for row in LAYOUTS.get(fig_no, []):
        for letter, slug in row:
            pdf = panel_pdf(fig_no, letter, slug)
            if pdf is None:
                continue
            for src in (FIGS / "panels").glob(f"fig{fig_no}_*.py"):
                if f'"{letter}", "{slug}"' in src.read_text():
                    if src.stat().st_mtime > pdf.stat().st_mtime:
                        out.append(f"fig{fig_no}{letter} ({src.name})")
                    break
    return out


def assemble(fig_no: int) -> Path | None:
    if fig_no not in LAYOUTS:
        print(f"  fig{fig_no}: no layout defined in assemble.py")
        return None
    rows = LAYOUTS[fig_no]

    for s_ in stale(fig_no):
        print(f"  fig{fig_no}: STALE — {s_} is newer than its PDF; re-run its panel")

    resolved, missing = [], []
    for row in rows:
        out = []
        for letter, slug in row:
            p = panel_pdf(fig_no, letter, slug)
            if p is None:
                missing.append(f"fig{fig_no}{letter}_{slug}.pdf")
                continue
            src = fitz.open(p)
            r = src[0].rect
            # True size, straight from the panel PDF -- the panel declared it on the
            # column grid, so nothing here has to guess or rescale.
            out.append((letter, p, r.width / MM, r.height / MM))
            src.close()
        if out:
            resolved.append(out)
    for m in missing:
        print(f"  fig{fig_no}: MISSING figures/fig{fig_no}/{m}")
    if not resolved:
        return None

    # Rows stack; within a row panels sit side by side with one gutter, and the row
    # is centred on the page so a short row is not left-heavy.
    placements, y, over = [], MARGIN, []
    for row in resolved:
        y += LETTER_LEAD
        row_w = sum(w for *_, w, _ in row) + GUTTER * (len(row) - 1)
        # A row wider than the page USED to be centred, which put its first panel at
        # a NEGATIVE x and cut that panel's y axis and legend off the artwork. The
        # per-panel renders looked perfect and lint_text.py only inspects panels, so
        # nothing reported it: fig3's b/c/d row was 210.6 mm on a 180 mm page and
        # panel b landed at x = -15.3 mm. Refuse rather than silently truncate.
        # 0.05 mm, not 1e-6: a panel declared at exactly 88.0 mm round-trips through
        # the PDF's points as 88.00000000000001, so two halves plus a gutter came to
        # marginally over 180 and a zero-tolerance guard rejected every valid
        # two-panel row. 0.05 mm is far below anything that could clip a glyph.
        if row_w > PAGE_W + 0.05:
            over.append((", ".join(l for l, *_ in row), row_w))
        # Centre, with NO lower clamp. A `max(MARGIN, ...)` clamp was tried and is
        # wrong: for a full-width 180 mm panel it yields x = 3, so 3 mm of the panel
        # fell off the right of every figure -- it cut the 4th tile of fig1b and the
        # "3D proofreading" column of fig1d. The clamp existed to stop a negative x,
        # which the row guard above now makes impossible.
        x = (PAGE_W - row_w) / 2.0
        for letter, p, w, h in row:
            placements.append((letter, p, x, y, w, h))
            x += w + GUTTER
        y += max(h for *_, h in row) + ROW_GAP

    foot = FOOTERS.get(fig_no, [])
    page_w, page_h = PAGE_W, y - ROW_GAP + MARGIN + FOOTER_LEAD * len(foot)
    if over:
        for letters, w in over:
            print(f"  fig{fig_no}: ROW TOO WIDE — panels ({letters}) sum to "
                  f"{w:.1f} mm on a {PAGE_W:.0f} mm page. Narrow a panel's span.")
        return None

    doc = fitz.open()
    page = doc.new_page(width=page_w * MM, height=page_h * MM)
    for letter, p, x, y, w, h in placements:
        src = fitz.open(p)
        page.show_pdf_page(
            fitz.Rect(x * MM, y * MM, (x + w) * MM, (y + h) * MM), src, 0)
        src.close()
        lx = max(0.6, x - 2.0) + LETTER_NUDGE_MM.get((fig_no, letter), 0.0)
        page.insert_text(fitz.Point(lx * MM, (y - 1.2) * MM), letter,
                         fontname="hebo", fontsize=LETTER_PT, color=INK)
        # Title beside the letter, as the legacy set had it. Skipped silently when a
        # panel has no entry, so a newly added panel is not blocked on naming it --
        # but check TITLES after any re-lettering, because a title that has drifted
        # onto the wrong panel is worse than none.
        title = TITLES.get((fig_no, letter))
        if title:
            tx = lx + 4.4
            if (fig_no, letter) not in TITLE_FLUSH:
                span = axes_extent(p)
                if span:
                    tw = fitz.get_text_length(title, fontname="hebo",
                                              fontsize=TITLE_PT) / MM
                    # Centred on the axes, but never left of the flush position (it
                    # would run into the letter) and never past the panel's right
                    # edge (it would overhang the artwork and be silently clipped).
                    tx = min(max(x + (span[0] + span[1]) / 2 - tw / 2, tx),
                             x + w - tw)
            tx += TITLE_NUDGE_MM.get((fig_no, letter), 0.0)
            page.insert_text(fitz.Point(tx * MM, (y - 1.2) * MM), title,
                             fontname="hebo", fontsize=TITLE_PT, color=INK)
        # Sub-letters of a pre-merged composite (see EXTRA_LETTERS). dy = 0 rows
        # land in this row's own lead band, exactly level with the entry letters.
        for sub, dx, dy in EXTRA_LETTERS.get((fig_no, letter), []):
            sx = x + dx + (0.6 if dx == 0.0 else 0.0)
            page.insert_text(fitz.Point(sx * MM, (y + dy - 1.2) * MM), sub,
                             fontname="hebo", fontsize=LETTER_PT, color=INK)
            stitle = TITLES.get((fig_no, sub))
            if stitle:
                page.insert_text(fitz.Point((sx + 4.4) * MM, (y + dy - 1.2) * MM),
                                 stitle, fontname="hebo", fontsize=TITLE_PT,
                                 color=INK)

    fy = page_h - MARGIN - FOOTER_LEAD * (len(foot) - 0.35)
    for line in foot:
        page.insert_text(fitz.Point(MARGIN * MM, fy * MM), line,
                         fontname="helv", fontsize=FOOTER_PT,
                         color=(0.45, 0.45, 0.45))
        fy += FOOTER_LEAD

    out = FIGURES / f"fig{fig_no}" / f"fig{fig_no}.pdf"
    doc.save(out, deflate=True)
    flag = "  ** over the 200 mm ceiling **" if page_h > MAX_H else ""
    print(f"  assembled {out.relative_to(FIGS)}  "
          f"({page_w:.0f} x {page_h:.0f} mm, {len(placements)} panels){flag}")

    # A PNG of the whole composite, for looking at. The PDF stays the artefact --
    # this is a proof, which is why it renders at PREVIEW_DPI rather than the
    # panels' 600: 600 dpi on a 180 x 193 mm page is a 4252 x 4560 px, ~10 MB file
    # that nothing in the workflow actually needs.
    png = out.with_suffix(".png")
    doc[0].get_pixmap(dpi=PREVIEW_DPI).save(png)
    doc.close()
    print(f"            {png.relative_to(FIGS)}  ({PREVIEW_DPI} dpi proof)")
    return out


def main(argv):
    figs = [int(a) for a in argv if a.isdigit()] or sorted(LAYOUTS)
    for n in figs:
        print(f"fig{n}:")
        assemble(n)


if __name__ == "__main__":
    main(sys.argv[1:])
