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
    (1, "a"): "Pipeline",
    (1, "b"): "Cross-view re-identification",
    (1, "c"): "Triangulated 3D",
    (1, "d"): "Capability comparison",
    (2, "a"): "Protocol",
    (2, "b"): "Placements vs rig size",
    (2, "c"): "Cost of two anchors",
    (2, "d"): "Anchor-pair geometry",
    (3, "a"): "Grouping strategies",
    (3, "b"): "Hypotheses per frame",
    (3, "c"): "Grouping accuracy, head to head",
    (3, "d"): "3D-term ablation",
    (3, "e"): "Time per frame",
    # EXPLORATORY (2026-08-13): the corr2d x corr3d sweep re-run on all 50
    # BMimica sessions with the fresh-anchor tracker. The manuscript 3e is
    # untouched. Not in LAYOUTS[3] -- it is a separate finding, not a
    # replacement panel, and adding it would renumber the figure.
    (3, "g"): "corr3d sweep, fresh anchor, 50 sessions",
    (4, "a"): "Triangulation solvers",
    (4, "b"): "Accuracy vs cameras used",
    (4, "c"): "Dropping the worst camera",
    (4, "d"): "Per session, vs Anipose",
    (4, "e"): "Time per keypoint",
    (5, "a"): "One display, five views",
    (5, "b"): "Both rise, noses converge",
    (5, "c"): "One animal is up first",
    (5, "d"): "Close, hold, withdraw",
    (5, "e"): "Brief and still",
    (5, "f"): "Each session has a leader",
    (5, "g"): "One rear invites another — up close",
    (6, "a"): "Rig and 3D",
    (6, "b"): "One frame, six cameras",
    (6, "c"): "Detection quality",
    (6, "d"): "Animal-count control",
    (6, "e"): "Corpora",
    (6, "f"): "Difficulty strata",
    (7, "a"): "Within- vs cross-view IDF1 (+ experimental arm)",
    (7, "b"): "Within-view IDF1 per session",
    (7, "c"): "Per-session paired difference",
    (7, "d"): "Error composition",
    (7, "e"): "IDF1 vs detector recall",
    (7, "f"): "Fragmentation",
    # FIGURE 8 IS EXPLORATORY AND UNPLACED. It is not part of the manuscript: it has
    # no entry in FIGURE-LEGENDS.md, METHODS.md, RESULTS.md or CAPTIONS.md, and no
    # panel of Figures 1-7 refers to it. It is assembled here only so
    # `assemble.py 8` produces something a reader can look at while deciding whether
    # any shipped tracker default should move. Nothing was renumbered to make room.
    (8, "a"): "ID-switch rate per threshold",
    (8, "b"): "Cross-view IDF1 per threshold",
    (8, "c"): "Where the IDF1 goes",
    (8, "d"): "Parameter sets on all 50 sessions",
    (8, "e"): "All 50 sessions",
    # FIGURE 9 IS EXPLORATORY AND UNPLACED, on the same footing as Figure 8: no entry in
    # FIGURE-LEGENDS.md, METHODS.md, RESULTS.md or CAPTIONS.md, and no panel of Figures
    # 1-7 refers to it. It is the SECOND-CORPUS check on Fig 8's winner -- the same two
    # configurations run over the 42 MULTI-ANIMAL SLAP-2M sessions instead of the 50
    # BMimica ones (the corpus has 74; the 32 one-animal sessions were dropped on
    # 2026-08-13 because they contribute exactly 0 switches and 0 misgrouped detections and
    # so only inflated the denominator) --
    # assembled only so `assemble.py 9` produces something a reader can look at while
    # deciding whether any shipped tracker default should move. The arm it draws
    # (`M1 + stale 20 + distThresh 25`) is EXPERIMENTAL: it lives in
    # figs/fig8-bench/xv_experimental.js and is NOT in the shipped app. Nothing was
    # renumbered to make room.
    (9, "a"): "Cross-view identity on 42 multi-animal SLAP-2M sessions",
    (9, "b"): "Switch and misgrouped-detection rates",
    (9, "c"): "By difficulty and animal count",
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
    # 3a STACKED AND HALVED, c MOVED UP BESIDE IT (review 2026-08-13). a now reads
    # exhaustive-above-greedy in the order the text introduces them and takes half the
    # page, so c -- the quantitative form of the same contrast, hypotheses per frame --
    # sits in the freed half. b keeps its own row.
    # 3b (association cost) CUT from the layout 2026-08-14 (review: "maybe get rid of
    # the b association cost, it just takes up too much space and doesn't really add
    # anything"). `fig3_02_cost_terms.py` still runs and still deposits -- un-plotted,
    # not deleted, as Fig 7's bedding panel and Fig 8's threshold sweeps are. NOTE it
    # was the only place the cost function appeared on any artwork, so METHODS.md now
    # has to carry the 2D and 3D terms in full or the r sweep in 3e is a sweep over an
    # unstated quantity. Panels re-lettered: c->b, d->c, e->d, f->e.
    3: [[("a", "association"), ("b", "cost_model")],
        [("c", "quality"), ("d", "sweep"), ("e", "head_to_head")]],
    4: [[("a", "solvers")],
        [("b", "accuracy_vs_cameras"), ("c", "worst_camera")],
        [("d", "per_session"), ("e", "time_per_keypoint")]],
    # ROW 3 REPLACED (2026-08): the review cut "Correction found per review budget"
    # and "Six timelines vs one identity" -- the first was a triage curve whose
    # ranking signal and payload were correlated (rho 0.69), the second plotted a
    # count LUC3D loses on to argue something the dots did not measure. In their
    # place, a downstream 3D behaviour: the mutual upright display. Its panel scripts
    # are fig5_05/06/07; fig5_03_capture.py and fig5_04_proofread.py are still in the
    # tree and still deposit their CSVs, but are no longer placed on the artwork.
    # FIG 5 IS NOW ENTIRELY THE MUTUAL UPRIGHT DISPLAY (2026-08). The per-view
    # reprojection panel and the proofreading-loop schematic were cut on request; the
    # figure makes one argument -- what 3D tracking buys you for a two-animal social
    # interaction -- rather than three unrelated ones. Panel scripts are
    # fig5_05/06/08/09/07 in that letter order; fig5_02/03/04 remain in the tree,
    # still deposit their CSVs, and are no longer placed.
    # ROW 3 ADDED (2026-08): the two insets on 5c and 5e became panels. Both were
    # colliding with their host panel's own annotation, and both were carrying a
    # result that could not be defended at inset size -- 5c's needed the unit of
    # replication changed from the session to the ANIMAL, and 5e's needed a null.
    5: [[("a", "upright_views"), ("b", "upright_dynamics")],
        [("c", "upright_initiator"), ("d", "upright_velocity"),
         ("e", "upright_stats")],
        [("f", "leader"), ("g", "rear_coupling")]],
    6: [[("a", "rig"), ("b", "cameras")],
        [("c", "detection_quality")],
        [("d", "animal_count"), ("e", "corpora")],
        [("f", "difficulty_strata")]],
    # Panel a carries the EXPERIMENTAL high-performing arm (2026-08-13, on
    # instruction): the variant is fig7a plus `LUC3D + fresh anchor`. (It was briefly
    # lettered "h" by mistake; every `fig7h_*` artifact has been deleted and the code no
    # longer emits that name.) The manuscript panel
    # fig7a_within_vs_cross.pdf is untouched on disk and still renders byte-identical;
    # swapping the slug back restores it.
    #
    # ONLY PANEL a CARRIES THE FRESH-ANCHOR ARM, and the reason is no longer "it has
    # never been run on SLAP-2M" -- it has been, and `fig7_variant_best.json` holds it as
    # `slap2m_fresh_anchor` (item 3/4). The reason is that it is EXPERIMENTAL and not in
    # the shipped app, so it enters the composite on one panel, on instruction, labelled.
    # On b-g it is drawn only by `--variant`, which writes a `_variant` slug that is not
    # a letter here and so cannot reach the artwork.
    #
    # PANELS c, d, e, f, g were switched to the SHIPPED tracker on 2026-08-13 (Eric):
    # their slugs are unchanged, but the panel scripts now read `fig7_variant_best.json`'s
    # `slap2m` block instead of `fig3_trackers.json`'s pre-#131 one. See figs/README.md
    # and each panel's docstring. `b` (bedding) was NOT in that instruction and still
    # plots the pre-#131 arm, so this composite currently carries TWO tracker generations
    # under the name "LUC3D".
    # BEDDING CUT 2026-08-13 (review): the panel claimed invariance to bedding colour,
    # but the detector's training set is overwhelmingly black-background, so the
    # white-bedding arm is confounded with out-of-distribution DETECTION and the claim
    # cannot be defended. `fig7_06_bedding.py` and its CSV stay on disk and still
    # regenerate -- un-plotted, not deleted, as Fig 8's dropped panels are. Cutting it
    # also removed the last panel still plotting the retired pre-#131 tracker, so the
    # figure no longer carries two tracker generations under the name "LUC3D".
    # Panels c-g moved up one letter to b-f.
    7: [[("a", "within_vs_cross_variant"), ("b", "survival")],
        [("c", "by_animals"), ("d", "decomposition")],
        [("e", "recall"), ("f", "fragmentations")]],
    # EXPLORATORY, NOT IN THE MANUSCRIPT -- see the note beside its TITLES entries.
    # Rows 1-2: two full-width 2x5 blocks of small multiples, one threshold per
    # sub-plot, the ID-switch rate above and cross-view IDF1 below.
    # Rows 3-4 (added): the THRESHOLD sweeps above answer "do the constants matter";
    # 8c and 8d answer the question that follows. 8c decomposes the shipped tracker's
    # IDF1 loss into identity versus coverage and so sets the ceiling any method could
    # reach; 8d is what the algorithmic methods got out of it. 8c comes first because
    # it is what chose 8d's methods, and 8d is unreadable without its ceiling line.
    # Row 5 (added): 8a-8d are measured on Fig 3e's 8 sessions, which is what makes them
    # comparable to Fig 3e and is also their weakness -- Fig 4 over all 50 sessions once
    # REVERSED a subset conclusion in this repo. 8e is the all-50-session check on the two
    # configurations 8d put forward, and it is the panel that decides whether any of them
    # is a candidate for a shipped default.
    # FIG 8 IS NOW THE METHODS RESULT ONLY, on all 50 BMimica sessions.
    # 8a/8b (the ten threshold sweeps) and 8c (the identity-vs-coverage loss budget) were
    # dropped from the figure on 2026-08-12: 8e showed the threshold conclusion did not
    # survive the full corpus (+0.084 IDF1 on 8 sessions -> +0.012 mean / -0.001 median on
    # 50), so plotting it beside a result that DOES survive invited the wrong reading.
    # Their scripts, rendered PDFs and deposited CSVs are all still on disk and still
    # regenerate -- they are un-plotted, not deleted.
    # 8e (per-session paired differences) was dropped from the figure on
    # instruction 2026-08-13; its script and rendered PDF are retained.
    8: [[("d", "pr_switches")]],
    # EXPLORATORY, NOT IN THE MANUSCRIPT -- see the note beside its TITLES entries.
    # Three full-width rows, one question each, in the order a reader has to take them:
    # 9a is the distribution (survival curves for identity precision, recall and cross-view
    # IDF1 over the 42 MULTI-ANIMAL sessions -- the pooled all-74 curve was dropped
    # 2026-08-13 -- with the deposit's identity-only ceiling drawn and labelled as belonging
    # to a DIFFERENT detection pool); 9b is the two failure rates per 100,000 camera-frames
    # with their raw totals beside them; 9c is where those rates live, by the master sheet's
    # own 1-7 difficulty rating and by animal count. 9a first because 9b's rates are
    # meaningless without knowing the IDF1 barely moved, and 9c last because it explains 9b
    # rather than restating it.
    # 58 + 64 + 96 = 218 mm of panels, which lands the page at 243 mm and OVER the 200 mm
    # soft ceiling -- 9c grew to 96 mm when it became a 2x5 block of five metrics by two
    # stratifications, and it cannot carry ten sub-plots plus its key in 52. Fig 9 is
    # exploratory and unplaced, so the overrun is tolerated here rather than paid for by
    # cramming 9c; do not grow a Fig 9 panel further without shrinking another.
    9: [[("a", "idf1_survival")],
        [("b", "rates")],
        [("c", "strata")]],
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
