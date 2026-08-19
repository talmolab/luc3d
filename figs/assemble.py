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
    # Fig 1 re-lettered 2026-08-16 (Eric: cage render leads the figure).
    (1, "a"): "The rig, from its own data",
    (1, "b"): "Pipeline",
    (1, "c"): "Cross-view re-identification",
    (1, "d"): "Triangulated 3D",
    (1, "e"): "Capability comparison",
    (2, "a"): "Protocol",
    (2, "b"): "Placements vs rig size",
    (2, "c"): "Error vs cameras in the solve",
    (2, "d"): "Anchor-pair geometry",
    (3, "a"): "Grouping strategies",
    (3, "b"): "Hypotheses per frame",
    (3, "c"): "Grouping accuracy",
    (3, "d"): "3D term parameter sweep",
    (3, "e"): "Time per frame",
    # EXPLORATORY (2026-08-13): the corr2d x corr3d sweep re-run on all 50
    # BMimica sessions with the fresh-anchor tracker. The manuscript 3e is
    # untouched. Not in LAYOUTS[3] -- it is a separate finding, not a
    # replacement panel, and adding it would renumber the figure.
    (3, "g"): "corr3d sweep, fresh anchor, 50 sessions",
    (4, "a"): "Triangulation solvers",
    (4, "b"): "Accuracy vs cameras used",
    (4, "c"): "Dropping the worst camera",
    (4, "d"): "Triangulation: LUC3D vs Anipose",
    (4, "e"): "Time per keypoint",
    (5, "a"): "3D pose and 2D camera views for social rearing behavior",
    (5, "b"): "Both rise, noses converge",
    (5, "c"): "One animal is up first",
    (5, "d"): "Close, hold, withdraw",
    (5, "e"): "Brief and still",
    (5, "f"): "Each session has a leader",
    (5, "g"): "One rear invites another — up close",
    # Fig 6 re-lettered 2026-08-19 (difficulty grid leads the figure).
    (6, "a"): "Levels of tracking difficulty",
    (6, "b"): "Cross-view IDF1 by difficulty",
    (6, "c"): "Missing keypoints vs difficulty and cameras",
    (6, "d"): "Animal-count control",
    (6, "e"): "Detection quality",
    (6, "f"): "Difficulty strata",
    # "(+ experimental arm)" retired 2026-08-17: the fresh-anchor arm the panel
    # features was promoted to the shipped configuration, so the suffix became a
    # false statement about the artwork; the arm is labelled inside the panel.
    (7, "a"): "Within- vs cross-view IDF1",
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
    # FIGURE 11 IS A COMBINED VIEW of Figs 7 + 10 built from their existing panel
    # PDFs (Eric 2026-08-16). Titles are the source panels', shortened to fit the
    # denser rows; the letter mapping lives in figs/fig11_sync.py and
    # PANEL-SOURCES.md.
    # a's source title carries "(+ experimental arm)"; at 0.62 scale the panel is
    # 54.6 mm and the full string ran into b's letter, so it is shortened here --
    # the arm is still labelled inside the panel itself.
    (11, "a"): "Within- vs cross-view IDF1",
    (11, "b"): "Within-view IDF1 per session",
    (11, "c"): "Per-session paired difference",
    (11, "d"): "Error composition",
    (11, "e"): "IDF1 vs detector recall",
    (11, "f"): "Fragmentation",
    (11, "g"): "s-DANNCE transfer: one view per dataset, 3D reprojected",
    (11, "h"): "Reprojection vs raw clicks",
    (11, "i"): "IDF1 vs 2D noise",
    (11, "j"): "IDF1 under dropout",
    (11, "k"): "Keypoints vs COM-only",
    (11, "l"): "Switches vs cameras",
    (11, "m"): "Switches vs noise",
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
TITLE_FLUSH: set[tuple[int, str]] = set()

#: figure -> [row, ...] where a row is [(letter, slug), ...].
#: NO SIZES HERE. Panels are built on the column grid in src/style.py and saved at
#: exactly their declared size, so the assembler places each at its true width and
#: a row is simply the panels that share it. Widths that disagreed with the panels'
#: real sizes were how the first pass produced ragged rows.
LAYOUTS = {
    # RE-LETTERED 2026-08-16 (Eric: cage render leads the figure). Panel a is the
    # Blender render of the SLAP-2M rig (blender-images/renders/cage_two_mice.png,
    # from real calibration + tracked poses); the previous a-d moved down to b-e.
    1: [[("a", "render")],
        [("b", "pipeline")],
        [("c", "tracking")],
        [("d", "reconstruction")],
        [("e", "tool_table")]],
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
    # REGROUPED 2026-08-19 (Eric: "put abc on the same row ... and de is the
    # second row" -- panel a alone on row 1 at two-thirds left a third of the
    # page white). a re-spanned two-thirds -> third; letters unchanged. 4c also
    # lost its 50 grey per-session lines the same day, on instruction.
    4: [[("a", "solvers"), ("b", "accuracy_vs_cameras"), ("c", "worst_camera")],
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
    # FIG 6 REFLOWED 2026-08-15 (Eric: "I didn't tell you to get rid of the other
    # plots ... bring the other plots back and keep 6c"). The surface stays at c; the
    # detection-quality and strata rows return (g, h); and the rows pack without
    # white space by pairing the four half-width panels two and two -- the fourth
    # half is the per-camera split built tonight (e), the third leg of the
    # difficulty (c) / animal-count (d) / camera (e) breakdown the review asked for.
    # NOTE the page runs ~235 mm, over the 200 mm soft ceiling -- panels to cut or
    # shrink is Eric's call, not one more overnight re-letter.
    # e REPLACED 2026-08-16 (Eric): the per-camera miss-rate bars out, cross-view
    # IDF1 per difficulty stratum in (panels/fig6_11_idf1_by_difficulty.py; the old
    # bars' data stays deposited at data/fig6/fig6e_percam_quality.csv).
    # REBUILT AROUND THE DIFFICULTY GRID 2026-08-19 (Eric: "put 6d where 6G is,
    # then get rid of 6f and put 6c there, then put the enrichment_grid where
    # 6abcd are"). The Blender difficulty grid (panels/fig6_13_enrichment_grid.py,
    # enrichment x animals, 10 real-session tiles) takes the whole top; the
    # surface and animal-count plots move down into the freed slots and keep
    # their letters c and d by reading order; IDF1 re-letters e->b, detection
    # quality g->e (kept, at HALF span, beside d -- Eric: "we should still have
    # the detection quality one next to d ... so we dont have all that white
    # space"), the strata table h->f. OFF the artwork, still depositing: the
    # rig render (old a, fig6_09), the six-camera frame (old b, fig6_05), and
    # the corpora table (old f, fig6_04 -- cut on instruction).
    6: [[("a", "enrichment_grid")],
        [("b", "idf1_by_difficulty"), ("c", "recovery_surface")],
        [("d", "animal_count"), ("e", "detection_quality")],
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
    # FIG 10 -- the s-DANNCE transfer benchmark (PLAN-fig10-triads-bedding.md /
    # PLAN-fig10-scn2a.md, exploratory until placed). Row 1 is the deposit's own
    # frames with our reprojections (the at-a-glance calibration claim); row 2 the
    # anchor + the two synthetic-difficulty sweeps; row 3 the input ablation and
    # the merge-event caveat panel.
    10: [[("a", "views")],
         [("b", "residuals"), ("c", "noise"), ("d", "dropout")],
         # f REPLACED 2026-08-16 (Eric): the merge scatter out, the camera-count
         # ablation in. The merge finding stays in the legend text and the panel
         # script (fig10_06_merge.py) still renders — kept, not placed.
         [("e", "inputs"), ("f", "cameras")],
         [("g", "switches")]],
    # FIGURE 11 IS A COMBINED VIEW of Figs 7 + 10 built from their existing panel
    # PDFs (Eric 2026-08-16: "combine fig 7 and fig 10 ... make the plots smaller
    # but cram them all in"). It has NO panel scripts of its own: figs/fig11_sync.py
    # copies each source panel PDF into figures/fig11/ at a reduced vector scale
    # (assemble places panels at native width, so "smaller" must happen in the PDF).
    # REGENERATING A SOURCE PANEL DOES NOT UPDATE FIG 11 -- re-run the sync first:
    #     .venv/bin/python figs/fig11_sync.py && .venv/bin/python figs/assemble.py 11
    # Letters a-f are Fig 7 a-f (home-corpus tracker comparison); g-m are Fig 10 a-g
    # (the s-DANNCE transfer benchmark). LAYOUTS[7]/[10] are untouched.
    11: [[("a", "within_vs_cross_variant"), ("b", "survival"), ("c", "by_animals")],
         [("d", "decomposition"), ("e", "recall"), ("f", "fragmentations")],
         [("g", "views")],
         [("h", "residuals"), ("i", "noise"), ("j", "dropout"), ("k", "inputs")],
         [("l", "cameras"), ("m", "switches")]],
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
        lx = max(0.6, x - 2.0)
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
            page.insert_text(fitz.Point(tx * MM, (y - 1.2) * MM), title,
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
