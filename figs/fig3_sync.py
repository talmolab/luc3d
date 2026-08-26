#!/usr/bin/env python3
"""
Sync Figure 13's panels from Figures 3 and 4.

FIGURE 13 IS A COMBINED VIEW of Figs 3 + 4 (Eric 2026-08-20: "we want to add
[the multi-view grouping-hypothesis illustration] to figure 3 in relation to b,
but also we want to combine fig 4 with fig 3, this is a big change, so lets call
it fig3 for now so we dont undo any of our other work"). Fig 3 and Fig 4 are
UNTOUCHED -- their panel scripts, LAYOUTS[3]/LAYOUTS[4] and rendered
`figures/fig3/`, `figures/fig4/` PDFs are exactly as they were. Everything below
is additive, on new figure numbers, following the precedent set by Fig 11
(`fig6_sync.py`, "combine fig 7 and fig 10").

TWO VERSIONS WERE ORIGINALLY BUILT TO COMPARE (Eric, 2026-08-20: "make both
versions for me to see"): fig3 ("stack") and fig301 ("side by side"). Eric
then said "figure 13 is close!" and, later, "forget about 1301 dont use it.
delete it." -- fig301's LAYOUTS/TITLES entries, figures/fig301/, and every
fig301-specific line in this file are gone. Only fig3 is built here now.

FIG13'S THIRD ROW (g, i, j -- the triangulation-solver panels: Fig 4b+4c merged,
Fig 4d, Fig 4e) IS GONE, MOVED TO FIG 2 (Eric, 2026-08-20: "actually i mean to
add 13 g i and j to fig 2 as the third column in that fig. so remove 13 g i and
j from fig 13 and append it to fig 2"). They are now Fig 2's own e/f/g, built by
`panels/fig2_06_solver_accuracy.py` / `fig2_07_per_session.py` /
`fig2_08_time_per_keypoint.py` -- see the first of those for the full history
(the g/h merge into one grid(2,1,...) panel, i's native rebuild at third span
instead of a squeezed copy, j's re-ordering to match, and why their DLT/refined
colours reverted from the fig3-only AMBER/SKY substitute back to Fig 4's own
SALMON/TEAL once they left a page that also carried exhaustive/greedy). Nothing
of that history lives in this file any more; LAYOUTS[13] is a, b (stacked into
a), c, then row 2's d-h (the idswitch illustration plus the 2x2 data block's
two column composites -- see the row-2 geometry comment above CELL_W).

13e (quality) IS A NATIVE REBUILD, not a copy (Eric: "13 d greedy is really
small and really hard to see, can we make it a little more visible somehow?
thicken the lines or something?"). `panels/fig3_13_quality.py` reuses Fig 3c's
own `build()` and pooling but redraws with ~1.6x thicker box/whisker/median
strokes, so greedy's near-zero box (a real result, not a rendering bug) reads as
a deliberate thin mark instead of nothing. Its box is FILLED with a WHITE
median line, not an unfilled outline with a same-colour median (Eric: "have the
median ... shown as a line across the box ... use the same style as 13i" --
13i's own convention, before 13i itself moved to Fig 2).

13a's TOP HALF (the exhaustive/greedy schematic) IS ALSO RECOLOURED, not Fig 3a's
own PDF (Eric: "the colors in 13a for Exhaustive hypothesis testing should be
the same colors as the id lines in 13c as well"). `panels/fig3_15_association.py`
reuses Fig 3a's own drawing functions (monkeypatching the `identity()` lookup
they call) to recolour all three animal paths/dots to 13c's own tab10
blue/orange/green, writing an INTERMEDIATE `figures/fig3/_association_top.pdf`
that `build_stack`'s new `top_path` argument reads instead of the real Fig 3a
PDF -- see that script's own docstring.

Re-running a SOURCE panel script does NOT update fig3 -- re-run this after any
fig3 panel regenerates, and re-run the native fig3 panel scripts after
any change to their own inputs (every row-2 panel is native as of the
2026-08-25 rebuild -- see the geometry comment above CELL_W):

    .venv/bin/python figs/panels/fig3_10_hyp_illustration.py
    .venv/bin/python figs/panels/fig3_13_quality.py
    .venv/bin/python figs/panels/fig3_15_association.py
    .venv/bin/python figs/panels/fig3_06_idswitch.py
    .venv/bin/python figs/panels/fig3_07_sweep_split.py
    .venv/bin/python figs/panels/fig3_18_head_to_head.py
    .venv/bin/python figs/fig3_sync.py
    .venv/bin/python figs/assemble.py 13
    .venv/bin/python figs/_verify_fig3_type.py     # c/d type sizes agree?

THE TWO STAGED-3D PANELS (c, d) ARE RASTER, AND THEIR TYPE SIZE DEPENDS ON
THIS FILE. Each is rendered to a PNG, cropped to its ink, and placed at a width
solved here -- so a point size written in `hyp_fig_style.py` /
`idswitch_fig_style.py` only means something once you know the crop AND the
placed width. Both scripts therefore declare their sizes in ON-PAGE points and
carry a `CROP_W_PX` / `PLACED_MM` pair to convert; those constants are mildly
self-referential (bigger type -> wider crop -> different placement), so after
changing anything that moves ink in either panel, re-run the panel scripts and
this sync, then `_verify_fig3_type.py`, and copy back any constant it reports
as drifted. One pass converges. HYP_ASPECT/AB_STACK_SCALE below are part of the
same loop.

The letter mapping and per-panel scale live below; keep it in sync with
LAYOUTS[13]/TITLES/TITLE_FLUSH/LETTER_NUDGE_MM in assemble.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz

FIGS = Path(__file__).resolve().parent
FIGURES = FIGS / "figures"
sys.path.insert(0, str(FIGS))
from assemble import INK, LETTER_LEAD, LETTER_PT, MM, ROW_GAP, TITLE_PT, TITLES  # noqa: E402

GUTTER = 4.0
PAGE_W = 180.0

#: every straight-copy panel is already sized to fit its row on the source figure.
NATIVE_SCALE = 1.0

#: crop aspect (w/h) of the hyp-illustration source render -- see
#: panels/fig3_10_hyp_illustration.py's own content_crop. Recomputed here (not
#: imported) because that script measures it at build time from the actual PNG;
#: this constant only has to be right enough to size the ROW, and is verified
#: against the built PDF's real aspect in `rescale_pdf` (which reads real
#: dimensions, not this estimate) -- but it fixes what shape c's box + a/c's
#: shared height solve for. Recompute (see that script's content_crop) if the
#: render is re-cropped to a visibly different aspect.
#: 2026-08-25: 1822/1857 = 0.981 -> 1.1046. Moving 13c's side-camera PROP clear
#: of its own image plane (hyp_common.SCHEMATIC_OFFSET_A_PROP_MM, Eric: "for
#: 13c can we move the camera rendering for side to the right a bit") widened
#: that panel's content and, because hyp_fig_style sizes its figure from the
#: content aspect, shortened it; shortening its camera labels to "side/camera"
#: then pulled the right edge back in -- 1822x1857 -> 1700x1662. THIS CONSTANT IS NOT
#: COSMETIC: sync force-fits the built PDF to (h_stack * HYP_ASPECT, h_stack)
#: with independent width and height, so a stale value does not mis-size the
#: panel, it STRETCHES it. At the old value 13c would have been drawn 1.14x too
#: tall. AB_STACK_SCALE below is re-solved with it.
HYP_ASPECT = 0.9531813

#: fig3 ("stack"): scale applied uniformly to BOTH a and b so that the a/b
#: column width + gutter + c's width (c's height forced to match the a/b
#: column's total height) sums to exactly 180 mm. Derived, not guessed -- see
#: the docstring above and the derivation in the PR notes; recompute if a, b or
#: HYP_ASPECT change:
#:   w1(s) = 88*s ;  H(s) = (56.5807 + 52.0)*s + ROW_GAP + LETTER_LEAD
#:   w1(s) + GUTTER + H(s)*HYP_ASPECT = PAGE_W
#: i.e.  s = (PAGE_W - GUTTER - (ROW_GAP + LETTER_LEAD)*AR) / (88 + 108.5807*AR)
#:
#: 0.8669 -> 0.8474 with HYP_ASPECT's 2026-08-25 changes above. c is a landscape
#: panel now, and row 1 forces c's HEIGHT to equal the a/b column's, so a
#: wider-per-unit-height c must take more of the row: c 99.7 -> 101.4 mm, a/b
#: 76.3 -> 74.6, row-1 height 101.6 -> 99.5. Not a free choice -- it is what
#: keeps the row exactly 180 mm with c undistorted.
AB_STACK_SCALE = 0.8817425895

# ---- row-2 geometry (rebuilt 2026-08-25, Eric: "d, e, f is way too small ...
# g should have similar width to c. maybe f should be split up and d, e, and
# split up f should be a square next to g ... the fig 13 g is too big and is
# not necessary") ----
# The idswitch illustration takes IDSW_W (below) and the four data panels --
# quality, head-to-head, and the sweep SPLIT into its two metrics -- form a
# 2x2 block in what is left. Both started at row 1's own widths (d = c, block
# = a) and were rebalanced on 2026-08-25; see IDSW_W. Letters
# run down the block's columns because each column is one composite PDF
# (assemble.py cannot letter the second panel of a top row -- the same
# constraint that created build_stack), which also keeps the two sweep
# metrics a vertically stacked pair sharing their r axis, exactly as they
# were drawn when they were one panel.
#
# SIDES SWAPPED AND RE-LETTERED later the same day (Eric: "h should be on the
# left side and d, e, f, g should be on the right side, and re number
# accordingly"): the illustration OPENS the row as d, the block follows as
# e/f (first column) and g/h (second). The width arithmetic is unchanged --
# IDSW_W + GUTTER + 2*CELL_W + GUTTER = PAGE_W either way.
H_STACK = (56.5807 + 52.0) * AB_STACK_SCALE + ROW_GAP + LETTER_LEAD
C_W = H_STACK * HYP_ASPECT              # c's width, 99.72 mm (row 1's own solve)

#: Row-2 width for the idswitch illustration. It was C_W exactly, so d stacked
#: under c. Then "correct IDs" moved from off the side pane's RIGHT EDGE to
#: UNDER it (idswitch_fig_style.py), which gave back 236 px of pure-white right
#: margin and left that panel's crop nearly square (1097 x 1129) -- and Eric
#: asked for the freed width to go to the data cells: "make the e,g,f,h larger
#: with the space opened up by moving the correct ids under the side image a
#: bit ... also maybe make d slightly smaller".
#:
#: 77.5 mm, and the number is doing three things at once, because on a
#: near-square d the row's WIDTH and its HEIGHT are the same knob (row height =
#: IDSW_W / AR, and the cells are half of that):
#:   - d is 22% smaller than C_W;
#:   - the cells go 36.1 x 39.2 -> 47.3 x 36.2 mm, 31% wider and 21% more area,
#:     and width is the dimension they were actually starved of (7 pt y labels
#:     and tick labels ate a third of a 36 mm panel);
#:   - the whole page lands at ~199 mm, under assemble.py's 200 mm SOFT ceiling
#:     for the first time since Fig 13 was built (238 -> 205 -> 199).
#: Raising it back toward ~90 would buy ~2% more cell area and cost ~13 mm of
#: page height; that trade was declined.
IDSW_W = 77.5
BLOCK_W = PAGE_W - GUTTER - IDSW_W      # the 2x2 data block
CELL_W = (BLOCK_W - GUTTER) / 2         # 47.25 mm per data panel
#: NOMINAL cell height for the native panel scripts (fig3_03/_07/_08). sync()
#: trues every cell to the EXACT height that closes the rectangle against the
#: idswitch panel's aspect -- keep this within a few % of what sync prints so
#: that true-up rescale stays an invisible stretch.
CELL_H = 34.7

#: (left, width) of a data cell's AXES in figure fractions, PER BLOCK COLUMN.
#:
#: The four cells are separate figures, each laid out by constrained_layout
#: against its OWN y label -- and those labels differ in width -- so each plot
#: box landed at a different x. Stacked into a column composite that reads as
#: two panels that do not line up (Eric, 2026-08-25: "make sure g and h align
#: vertically? otherwise looks sloppy").
#:
#: PER COLUMN, not one value for all four. Measured, with the pin disabled, as
#: the left each cell's own labels need:
#:     e 0.3598   f 0.2937   g 0.2507   h 0.2363
#: e is the outlier because its y label is the only two-line one, and a second
#: rotated line costs a full line height (~3.1 mm) of margin. Forcing all four
#: onto e's 0.36 would have taken ~5 mm of plot width off g and h -- the exact
#: opposite of the rebalance that just widened these cells. Each column instead
#: takes the max its own two members need, which is what removes the
#: misalignment a reader can actually see: two plots sitting one above the
#: other with different left edges. The columns differing from each other is
#: ordinary, they are separated by a gutter and carry different y labels.
#:
#: Right edge is 0.9776 for all four (constrained_layout's own, no tick labels
#: overhang there), so width = 0.9776 - left. Re-measure if a y label changes.
CELL_AXES_X = {
    "quality_col": (0.362, 0.615),   # e (two-line label) sets it, f follows
    "sweep_col": (0.252, 0.725),     # g sets it, h follows
}


def place_cell_axes(fig, ax, column):
    """Freeze constrained-layout, then pin this cell's axes to its column's x.

    The layout engine has to run first (so the panel's own labels are sized and
    its vertical extent settled) and then be switched off, or it would simply
    recompute the position at save time and undo this. Only x is pinned: the
    vertical extent stays per-panel, which is right -- g reserves a key band
    that h does not."""
    engine = fig.get_layout_engine()
    if engine is not None:
        engine.execute(fig)
        fig.set_layout_engine("none")
    left, width = CELL_AXES_X[column]
    box = ax.get_position()
    ax.set_position([left, box.y0, width, box.height])


#: LAYOUTS[13] slug -> the panels the composite under it is built FROM, in the
#: order they are stacked, as (letter, slug). Three of Fig 13's five placed
#: slots are composites this file pre-merges (assemble.py can only place one
#: PDF per slot), so no panel script `save()`s those slugs and
#: `make_docs.panel_script` reported them as MISSING -- three false rows that
#: hid which script actually draws e, f, g and h. Same fix, same reason, as the
#: `fig11_sync.MAPPING` lookup make_docs already does for Fig 11.
#: Keep in sync with the build_stack / build_column calls in `sync()`.
COMPOSITES = {
    "association": [("a", "association"), ("b", "cost_model")],
    "quality_col": [("e", "quality"), ("f", "head_to_head")],
    "sweep_col": [("g", "sweep_switches"), ("h", "sweep_idf1")],
}


def _open_scaled(src: Path, scale: float | None = None, w_mm: float | None = None,
                 h_mm: float | None = None) -> fitz.Document:
    """A copy of `src`'s single page, resized to `scale` (uniform) or to an
    explicit (w_mm, h_mm) -- independent width/height, i.e. allowed to distort."""
    sdoc = fitz.open(src)
    r = sdoc[0].rect
    w = w_mm * MM if w_mm is not None else r.width * scale
    h = h_mm * MM if h_mm is not None else r.height * scale
    ddoc = fitz.open()
    page = ddoc.new_page(width=w, height=h)
    page.show_pdf_page(page.rect, sdoc, 0)
    sdoc.close()
    return ddoc


def copy_panel(dst_fig: int, dst_letter: str, src_fig: int, src_letter: str, slug: str,
              *, scale: float = NATIVE_SCALE, w_mm: float | None = None,
              h_mm: float | None = None) -> None:
    src = FIGURES / f"fig{src_fig}" / f"fig{src_fig}{src_letter}_{slug}.pdf"
    if not src.exists():
        print(f"  MISSING source {src.relative_to(FIGS)} -- fig{dst_fig}{dst_letter} skipped")
        return
    outdir = FIGURES / f"fig{dst_fig}"
    outdir.mkdir(parents=True, exist_ok=True)
    dst = outdir / f"fig{dst_fig}{dst_letter}_{slug}.pdf"
    ddoc = _open_scaled(src, scale=None if (w_mm or h_mm) else scale, w_mm=w_mm, h_mm=h_mm)
    ddoc.save(dst, deflate=True)
    ddoc.close()
    size = f"{w_mm:g}x{h_mm:g}mm" if w_mm else f"x{scale:g}"
    print(f"  fig{dst_fig}{dst_letter} <- fig{src_fig}{src_letter}_{slug}.pdf  {size}")


def rescale_pdf(path: Path, w_mm: float, h_mm: float) -> None:
    """Resize an already-built panel PDF in place to an exact (w_mm, h_mm)."""
    ddoc = _open_scaled(path, w_mm=w_mm, h_mm=h_mm)
    ddoc.save(path, deflate=True, incremental=False)
    ddoc.close()
    print(f"  {path.relative_to(FIGS)} rescaled -> {w_mm:.2f}x{h_mm:.2f}mm")


def build_stack(dst_fig: int, dst_letter: str, top: tuple, bottom: tuple,
                scale: float = NATIVE_SCALE, bottom_letter: str | None = None,
                top_path: Path | None = None) -> None:
    """One panel PDF made of two source panels, TOP directly over BOTTOM.

    `top`/`bottom` are (src_fig, src_letter, slug). assemble.py places panels by
    row and cannot span one panel across two rows, so a genuine "one over the
    other" column has to be pre-merged into a single PDF -- this is that merge,
    used for both the a/b stack and the g/h stack. `bottom`'s letter (and its title, when TITLES has an entry --
    (3, "b") deliberately has none) is hand-drawn onto the composite (Helvetica-Bold, LETTER_PT/TITLE_PT, INK,
    matching assemble()'s own style) since assemble() only knows about the ONE
    (dst_letter, slug) entry this composite is filed under -- `top`'s.

    `bottom_letter` is the letter drawn for the bottom half, which is the Fig 13
    LETTER it reads as (e.g. "h"), NOT `bottom`'s own SOURCE letter in whatever
    figure it was copied from -- those coincide for the a/b stack (Fig 3's own
    letter for cost_model is "b", which is also 13's letter for it) but not for
    the g/h stack (Fig 4's own letter for worst_camera is "c", Fig 13's is "h";
    drawing the source letter there mislabelled the panel "c" -- a collision
    with 13c, the hyp illustration). Defaults to `bottom`'s source letter only
    for that reason of historical coincidence; always pass it explicitly for any
    new stack.

    `top_path`, if given, is read as the TOP half's actual source PDF instead of
    the file `top`'s (src_fig, src_letter, slug) would normally point to -- used
    when the top half is a recoloured/modified INTERMEDIATE rather than a real
    deposited panel (e.g. `panels/fig3_15_association.py`'s
    figures/fig3/_association_top.pdf). `top` is still consulted for the dst
    filename's slug.
    """
    from assemble import axes_extent  # local import: needs the real source PDF on disk

    t_fig, t_letter, t_slug = top
    b_fig, b_letter, b_slug = bottom
    drawn_letter = bottom_letter if bottom_letter is not None else b_letter
    a_src = top_path if top_path is not None else \
        FIGURES / f"fig{t_fig}" / f"fig{t_fig}{t_letter}_{t_slug}.pdf"
    b_src = FIGURES / f"fig{b_fig}" / f"fig{b_fig}{b_letter}_{b_slug}.pdf"
    da, db = fitz.open(a_src), fitz.open(b_src)
    ra, rb = da[0].rect, db[0].rect
    w = ra.width * scale
    ha, hb = ra.height * scale, rb.height * scale
    gap = (ROW_GAP + LETTER_LEAD) * MM

    out = fitz.open()
    page = out.new_page(width=w, height=ha + gap + hb)
    page.show_pdf_page(fitz.Rect(0, 0, w, ha), da, 0)
    b_y0 = ha + gap
    page.show_pdf_page(fitz.Rect(0, b_y0, w, b_y0 + hb), db, 0)
    da.close()
    db.close()

    # A UNIQUELY-NAMED EMBEDDED FONT, not the base-14 alias "hebo" assemble()
    # itself uses. Reusing "hebo" here corrupted EVERY title on the FINAL
    # assembled fig3.pdf, not just this composite's own text: PyMuPDF's
    # resource merge, when assemble() later show_pdf_page's this composite into
    # its own page and then inserts ITS OWN "hebo" text right after (its normal
    # per-panel letter/title loop), resolved that outer "hebo" to whatever font
    # object this composite's "hebo" happened to be -- and every panel drawn
    # after "a" on that one shared page inherited it. Reproduced in isolation
    # (a throwaway two-document nesting test) and confirmed this fixes it: a
    # font inserted under a name no other document on the page will ever also
    # ask for cannot collide.
    hebo = fitz.Font("Helvetica-Bold")
    page.insert_font(fontname="Fig13StackHeboBold", fontbuffer=hebo.buffer)

    letter_y = b_y0 - 1.2 * MM
    lx = max(0.6, -2.0) * MM
    page.insert_text(fitz.Point(lx, letter_y), drawn_letter, fontname="Fig13StackHeboBold",
                     fontsize=LETTER_PT, color=INK)
    title = TITLES.get((b_fig, b_letter))
    if title:
        tx_flush = lx + 4.4 * MM
        tx = tx_flush
        span = axes_extent(b_src)   # (x0, x1) in bottom's OWN unscaled mm frame
        if span:
            # `fitz.get_text_length` only knows base-14 names; the embedded font
            # object itself measures the custom-named one.
            tw = hebo.text_length(title, fontsize=TITLE_PT)
            tx = min(max((span[0] + span[1]) / 2 * scale * MM - tw / 2, tx_flush),
                     w - tw)
        page.insert_text(fitz.Point(tx, letter_y), title, fontname="Fig13StackHeboBold",
                         fontsize=TITLE_PT, color=INK)

    outdir = FIGURES / f"fig{dst_fig}"
    outdir.mkdir(parents=True, exist_ok=True)
    dst = outdir / f"fig{dst_fig}{dst_letter}_{t_slug}.pdf"
    out.save(dst, deflate=True)
    out.close()
    top_src_desc = a_src.name if top_path is not None else f"fig{t_fig}{t_letter}"
    print(f"  fig{dst_fig}{dst_letter} <- {top_src_desc} + fig{b_fig}{b_letter} "
         f"(stacked, x{scale:g}, drawn as {dst_letter}/{drawn_letter})")


def build_column(dst_fig: int, dst_letter: str, dst_slug: str, items: list,
                 scale: float) -> float:
    """One panel PDF made of N source panels stacked vertically -- the same
    pre-merge trick as build_stack, generalised (assemble.py cannot span one
    row's panel beside several rows of others, so Eric's fig3 rectangle --
    "d,e,f can be on the right of [the idswitch panel] vertically going
    downwards" -- needs d/e/f merged into ONE column panel). `items` is a list
    of (src_fig, src_letter, slug, drawn_letter); the FIRST item's letter and
    title are drawn by assemble() (the composite is filed under dst_letter =
    that item's Fig-13 letter), the rest are hand-drawn here exactly as
    build_stack draws its bottom half's. Returns the column's height in mm."""
    from assemble import axes_extent

    srcs = [FIGURES / f"fig{f}" / f"fig{f}{l}_{s}.pdf" for f, l, s, _ in items]
    docs = [fitz.open(p) for p in srcs]
    ws = [d[0].rect.width * scale for d in docs]
    hs = [d[0].rect.height * scale for d in docs]
    w = max(ws)
    gap = (ROW_GAP + LETTER_LEAD) * MM

    out = fitz.open()
    page = out.new_page(width=w, height=sum(hs) + gap * (len(items) - 1))
    hebo = fitz.Font("Helvetica-Bold")
    page.insert_font(fontname="Fig13ColHeboBold", fontbuffer=hebo.buffer)
    y = 0.0
    for i, ((f, l, s, drawn), d, hi) in enumerate(zip(items, docs, hs)):
        if i > 0:
            y += gap
            letter_y = y - 1.2 * MM
            lx = 0.6 * MM
            page.insert_text(fitz.Point(lx, letter_y), drawn,
                             fontname="Fig13ColHeboBold", fontsize=LETTER_PT, color=INK)
            title = TITLES.get((dst_fig, drawn)) or TITLES.get((f, l))
            if title:
                tx_flush = lx + 4.4 * MM
                tx = tx_flush
                span = axes_extent(srcs[i])
                if span:
                    tw = hebo.text_length(title, fontsize=TITLE_PT)
                    tx = min(max((span[0] + span[1]) / 2 * scale * MM - tw / 2, tx_flush),
                             w - tw)
                page.insert_text(fitz.Point(tx, letter_y), title,
                                 fontname="Fig13ColHeboBold", fontsize=TITLE_PT, color=INK)
        page.show_pdf_page(fitz.Rect(0, y, ws[i], y + hi), d, 0)
        y += hi
        d.close()

    col_w, col_h = page.rect.width / MM, page.rect.height / MM
    dst = FIGURES / f"fig{dst_fig}" / f"fig{dst_fig}{dst_letter}_{dst_slug}.pdf"
    out.save(dst, deflate=True)
    out.close()
    print(f"  fig{dst_fig}{dst_letter} <- column of {len(items)} (x{scale:g}, "
          f"{col_w:.1f}x{col_h:.1f}mm)")
    return col_h


def sync() -> None:
    hyp = FIGURES / "fig3" / "fig3c_hyp_illustration.pdf"
    quality = FIGURES / "fig3" / "fig3e_quality.pdf"
    assoc_top = FIGURES / "fig3" / "_association_top.pdf"
    if not hyp.exists():
        print(f"  MISSING {hyp.relative_to(FIGS)} -- run "
              f"panels/fig3_10_hyp_illustration.py first")
        return
    if not quality.exists():
        print(f"  MISSING {quality.relative_to(FIGS)} -- run "
              f"panels/fig3_13_quality.py first")
        return
    if not assoc_top.exists():
        print(f"  MISSING {assoc_top.relative_to(FIGS)} -- run "
              f"panels/fig3_15_association.py first")
        return

    # ---- fig3: a/b stacked, c spans both rows beside them ----
    # top_path: "a" is a RECOLOURED copy of Fig 3a (panels/fig3_15_association.py,
    # matching 13c's animal colours), not Fig 3a's own PDF.
    # bottom: fig3's OWN half-span cost_model twin (fig3's b re-spanned to a
    # third on 2026-08-25 for the hyp-illustration row; copying it here shrank
    # 13b's x axis -- Eric: "that is a mistake, change it back").
    build_stack(3, "a", (3, "a", "association"), (3, "b", "cost_model"), AB_STACK_SCALE,
               bottom_letter="b", top_path=assoc_top)
    h_stack = (56.5807 + 52.0) * AB_STACK_SCALE + ROW_GAP + LETTER_LEAD
    rescale_pdf(hyp, h_stack * HYP_ASPECT, h_stack)

    # ---- row 2: the idswitch illustration then the 2x2 data block (see the
    # geometry comment above CELL_W). All four cells are NATIVE fig3 panels
    # at ~CELL_W x CELL_H (e by panels/fig3_13_quality.py, f by
    # panels/fig3_18_head_to_head.py, g/h by panels/fig3_07_sweep_split.py);
    # each is trued here to the EXACT cell height that closes the rectangle:
    #   idsw_h     = IDSW_W / AR         (AR = idswitch panel aspect, w/h)
    #   cell_h     = (idsw_h - (ROW_GAP + LETTER_LEAD)) / 2
    idsw = FIGURES / "fig3" / "fig3d_idswitch.pdf"
    cells = [("e", "quality"), ("f", "head_to_head"),
             ("g", "sweep_switches"), ("h", "sweep_idf1")]
    missing = [p for p in [idsw] + [FIGURES / "fig3" / f"fig3{l}_{s}.pdf"
                                    for l, s in cells] if not p.exists()]
    if missing:
        for p in missing:
            print(f"  MISSING {p.relative_to(FIGS)} -- run its panel script first")
        return
    d0 = fitz.open(idsw)
    AR = d0[0].rect.width / d0[0].rect.height
    d0.close()
    gl = ROW_GAP + LETTER_LEAD
    rescale_pdf(idsw, IDSW_W, IDSW_W / AR)
    cell_h = (IDSW_W / AR - gl) / 2
    if abs(cell_h - CELL_H) > 0.05 * CELL_H:
        print(f"  WARNING: exact cell height {cell_h:.1f}mm is >5% off the nominal "
              f"CELL_H {CELL_H:g}mm the panel scripts build at -- update CELL_H "
              f"and re-run the cell panel scripts, or the true-up stretch will show")
    for letter, slug in cells:
        rescale_pdf(FIGURES / "fig3" / f"fig3{letter}_{slug}.pdf", CELL_W, cell_h)
    col_h = build_column(3, "e", "quality_col",
                         [(3, "e", "quality", "e"),
                          (3, "f", "head_to_head", "f")], 1.0)
    build_column(3, "g", "sweep_col",
                 [(3, "g", "sweep_switches", "g"),
                  (3, "h", "sweep_idf1", "h")], 1.0)
    print(f"  rectangle: columns {col_h:.1f}mm vs idswitch {IDSW_W / AR:.1f}mm tall")


if __name__ == "__main__":
    sync()
