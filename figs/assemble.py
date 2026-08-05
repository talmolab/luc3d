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
ROW_GAP = 7.0             # mm between rows (also clears the panel letter)
LETTER_LEAD = 4.5         # mm of headroom reserved above each row for its letters
MAX_H = 200.0             # mm, soft ceiling -- warn past this
PREVIEW_DPI = 300         # the composite .png proof; the .pdf is the artefact
FOOTER_PT = 6.5           # figure-level provenance footer
FOOTER_LEAD = 3.4         # mm per footer line

#: figure -> provenance footer. The legacy set carried one of these on every figure
#: naming corpus, n and the caveats; the restyle dropped them all and Fig 4 ended up
#: with NO provenance on the artwork at all. Panel letters are not provenance.
#: Keep each line under ~150 characters so it fits 180 mm at 6.5 pt.
FOOTERS = {
    1: ["a: schematic. b, c: one frame of an 8-camera HardFight recording, driven "
        "through LUC3D itself (load, Track All, Triangulate All).",
        "d: third-party capabilities from published documentation, checked "
        "2026-08-04; qualifications in the caption."],
    2: ["a: the app on an 8-camera recording (a different rig from b-d). "
        "b, c, d: all 50 proofread BMimica sessions, 5 cameras, 2 mice, 15 nodes, "
        "1,277,424 keypoints.",
        "Every session enters every panel: 38,322,720 held-out view measurements in "
        "c; 12,774,240 two-anchor solves in d. See caption."],
    # NOTE: these letters shifted when the cost-terms schematic was restored as b.
    # A footer that names the wrong panels is worse than none, so it moves with the
    # layout above -- check both together.
    3: ["b: the cost function as implemented. c: exact arithmetic. "
        "d: measured by scripts/bench/bench_crossview.mjs.",
        "e: 8 BMimica sessions, a fixed 6,000-frame leading window per cell, "
        "identical across all 24 cells.",
        "f: exhaustive is our reimplementation of the published per-frame procedure. "
        "IDF1 and switches via motmetrics on a shared identity-stripped pool."],
    # "All panels" was doing too much work: b is not from the run c-f are from, and
    # the only place that was said was the stride. The second line now attributes it,
    # names the alignment its floor is bounded by, and says the floor is a comparison
    # floor -- the panel itself carries the short form ("DLT only, stride 200, as
    # Fig 2" and "band: across-session p25-p75"), which is all a 57 mm panel will take.
    4: ["All panels: the same 50 BMimica sessions, 5 cameras, 3 calibrations. "
        "c-f 4,253,636 keypoints at stride 60; b 1,277,424 at stride 200.",
        "b is the Fig 2 measurement: DLT only, brought into this pipeline's frame by "
        "RANSAC-Procrustes, so its floor is a comparison floor, not accuracy.",
        "Median lens-distortion displacement 8.42 px (p95 23.36). See caption for "
        "what is enforced rather than observed."],
    5: ["a: one frame of an 8-camera recording in LUC3D, 3D solved from all 8 views "
        "(the app's normal state, not a held-out or anchored solve).",
        "c, d: 74 SLAP-2M sessions, 1,561,915 keypoints. The ranking in c and d is "
        "measured offline: LUC3D reports the residual for the frame you are on and "
        "has no ranked worklist."],
    6: ["a, b: one SLAP-2M session. c, d, f: 74 SLAP-2M sessions, 1,561,915 "
        "keypoints, raw detections from the benchmark's shared identity-stripped "
        "pool,",
        "matched per frame against the proofread 3D reprojected into each camera. "
        "e: both corpora, read from the files."],
    7: ["Identical identity-stripped detections for every tracker shown. "
        "Session-level statistics throughout; SHIPPED LUC3D configuration.",
        "a: 50 BMimica sessions, 5 cameras, 2 mice. b-g: 74 SLAP-2M sessions. "
        "See caption for n and method."],
}

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
    (1, "a"): "Pipeline",
    (1, "b"): "Cross-view re-identification",
    (1, "c"): "Triangulated 3D",
    (1, "d"): "Capability comparison",
    (2, "a"): "Protocol",
    (2, "b"): "Placements vs rig size",
    (2, "c"): "Cost of two anchors",
    (2, "d"): "Anchor-pair geometry",
    (3, "a"): "Grouping strategies",
    (3, "b"): "Association cost",
    (3, "c"): "Hypotheses per frame",
    (3, "d"): "Association runtime",
    (3, "e"): "3D-term ablation",
    (3, "f"): "Time per frame",
    (4, "a"): "Triangulation solvers",
    (4, "b"): "Accuracy vs cameras used",
    (4, "c"): "Dropping the worst camera",
    (4, "d"): "Error in an unused camera",
    (4, "e"): "Per session, both solvers",
    (4, "f"): "Time per keypoint",
    (5, "a"): "Per-view reprojection error",
    (5, "b"): "Proofreading loop",
    (5, "c"): "Correction found per review budget",
    (5, "d"): "Per session, 10% budget",
    (6, "a"): "Rig and 3D",
    (6, "b"): "One frame, six cameras",
    (6, "c"): "Detection quality",
    (6, "d"): "Animal-count control",
    (6, "e"): "Corpora",
    (6, "f"): "Difficulty strata",
    (7, "a"): "Within- vs cross-view IDF1",
    (7, "b"): "Bedding invariance",
    (7, "c"): "Within-view IDF1 per session",
    (7, "d"): "Per-session paired difference",
    (7, "e"): "Error composition",
    (7, "f"): "IDF1 vs detector recall",
    (7, "g"): "Fragmentation",
}
TITLE_PT = 7.5            # panel titles, below the 9 pt letter

#: figure -> [row, ...] where a row is [(letter, slug), ...].
#: NO SIZES HERE. Panels are built on the column grid in src/style.py and saved at
#: exactly their declared size, so the assembler places each at its true width and
#: a row is simply the panels that share it. Widths that disagreed with the panels'
#: real sizes were how the first pass produced ragged rows.
LAYOUTS = {
    1: [[("a", "pipeline")],
        [("b", "tracking")],
        [("c", "reconstruction")],
        [("d", "tool_table")]],
    2: [[("a", "protocol")],
        [("b", "placements_vs_rig"), ("c", "reprojection_accuracy"),
         ("d", "baseline_angle")]],
    3: [[("a", "association")],
        [("b", "cost_terms"), ("c", "cost_model")],
        [("d", "runtime_scaling"), ("e", "sweep"), ("f", "head_to_head")]],
    4: [[("a", "solvers")],
        [("b", "accuracy_vs_cameras"), ("c", "worst_camera"),
         ("d", "heldout_by_views")],
        [("e", "per_session"), ("f", "time_per_keypoint")]],
    5: [[("a", "per_view_error")],
        [("b", "loop")],
        [("c", "capture"), ("d", "per_session")]],
    6: [[("a", "rig"), ("b", "cameras")],
        [("c", "detection_quality")],
        [("d", "animal_count"), ("e", "corpora")],
        [("f", "difficulty_strata")]],
    7: [[("a", "within_vs_cross"), ("b", "bedding")],
        [("c", "survival"), ("d", "by_animals")],
        [("e", "decomposition"), ("f", "recall"), ("g", "fragmentations")]],
}


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
        lx = max(0.6, x - 2.0)
        page.insert_text(fitz.Point(lx * MM, (y - 1.2) * MM), letter,
                         fontname="hebo", fontsize=LETTER_PT, color=INK)
        # Title beside the letter, as the legacy set had it. Skipped silently when a
        # panel has no entry, so a newly added panel is not blocked on naming it --
        # but check TITLES after any re-lettering, because a title that has drifted
        # onto the wrong panel is worse than none.
        title = TITLES.get((fig_no, letter))
        if title:
            page.insert_text(fitz.Point((lx + 4.4) * MM, (y - 1.2) * MM), title,
                             fontname="hebo", fontsize=TITLE_PT, color=INK)

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
