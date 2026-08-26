#!/usr/bin/env python3
"""
LINT NOTE (2026-08-16): at the 0.635 cram scale, source annotations set at
6.5-7 pt land at 4.1-4.4 pt, below lint_text's 5.0 pt floor. Accepted: Eric asked
for the plots crammed; clearing the floor would need >=0.77 scale and a ~260 mm
page. The remaining BELOW-5pt lint hits on fig6 panels are this, not a defect.

Build Figure 6's a-d tracker block from its own panel PDFs.

FIGURE 6 (the supplementary identity figure; the repo's fig11 before the
2026-08-26 manuscript renumbering, itself a combined view of the old Figs 7 + 8)
pre-merges its four tracker panels (fig6a-d, panels/fig6_01/02/03/05) into ONE
2x2 composite, `fig6a_block.pdf`, at a REDUCED VECTOR SCALE. That indirection
exists because `assemble.py` places each panel at its native PDF width and
refuses rows wider than the 180 mm page -- so "smaller" has to happen to the
panel PDF itself, not at assembly. `show_pdf_page` into a shrunken page is a
lossless vector transform: type and strokes stay live, they just print smaller.

Re-running a SOURCE panel script does NOT update the block -- re-run this after
any fig6 a-d panel regenerates:

    .venv/bin/python figs/fig6_sync.py && .venv/bin/python figs/assemble.py 6

The block geometry lives in BLOCK_ROWS/BLOCK_W below; keep it in sync with
LAYOUTS[6] / TITLES in assemble.py and the Figure 6 table in PANEL-SOURCES.md.
"""
from __future__ import annotations

from pathlib import Path

import fitz

FIGS = Path(__file__).resolve().parent
FIGURES = FIGS / "figures"

# Scale for the 12 plot panels. 0.635 puts three 88 mm panels (plus gutters) on the
# 180 mm page and prints the 8 pt body at ~5 pt -- dense but legible; below ~0.55
# the tick labels stop being readable in print.
PLOT_SCALE = 0.635
# The fig10a photo strip is 180 mm native; scaled less aggressively because it is
# images, not vectors, and its per-camera crops die faster than type does.
STRIP_SCALE = 0.75
# Fig 8d is ALREADY 180 mm native -- one full-width row of four sub-plots -- so it
# comes in UNSCALED. Two reasons it is not shrunk to PLOT_SCALE with the rest. A
# rectangle: at 0.635 it would be 114 mm in a 180 mm row, leaving 66 mm of white and
# breaking the block this figure is supposed to be. And legibility: its four
# sub-plots are 45 mm wide against a-f's 55.9 mm, so it is ALREADY the most crowded
# thing on the page -- 0.635 would put its tick labels near 4.1 pt, below where the
# a-f panels already sit. Its type therefore prints LARGER than a-f's, which is the
# right direction for the only panel nobody can zoom.
FULL_SCALE = 1.0

#: (fig6 letter, source figure, source letter, slug, scale).
#: HISTORY, because the letters have moved three times.
#: Fig 11 was Fig 7 a-f + Fig 10 a-g. The s-DANNCE half went 2026-08-20 (Eric: "for
#: figure 11 get rid of g, h, i, j, k, l, m"), which left it a duplicate of Figure 7;
#: FIGURE 8 WAS THEN FOLDED IN as panel g (Eric, same day: "figure 11 and figure 8
#: should be combined and all fit together clearly in a rectangle"), which is what
#: gives the figure a reason to exist again -- the home-corpus tracker comparison
#: above the staleness-horizon result that the comparison's winning configuration
#: comes from. RE-CUT 2026-08-25 (Eric): fig7e (IDF1 vs detector recall) and fig7f
#: (fragmentation -- "more a quirk of mot metrics") are DROPPED, and the four
#: remaining tracker panels a-d are PRE-MERGED by build_block() below into ONE
#: 2x2 composite ("make a square on the left out of a,b,c,d and then make them a
#: bit smaller, then make the diagram big on the right") so the Chen-2020-style
#: anchor diagram (panels/fig6_00_chen_style.py -- the one fig6 panel with its
#: own script, fig13-style) can span both of their rows at 91 mm, directly above
#: the sweep it explains, now lettered f. Fig 7's own panels and PDFs are
#: untouched, as is LAYOUTS[8] (still not assembled as its own figure).
MAPPING = []  # fig6f (pr_switches) is saved directly by panels/fig6_07_pr_switches.py
# and fig6e (chen_style) by panels/fig6_00_chen_style.py -- nothing is copied in
# from another figure any more; this sync only builds the a-d block.

#: The a-d block's total width, mm. SOLVED, not chosen. Since the shared-key
#: pass (Eric, 2026-08-25: "put LUC3D SLEAP and ByteTrack under the abcd block
#: ... make sure that the literal letters a b c and d are vertically aligned
#: ... preferably X axes and if possible Y axes aligned") every block panel is
#: the SAME 88 x 50 mm native (fig7a's variant dropped its key band and 62 mm
#: height; fig7d widened 80 -> 88), so the block packs on ONE uniform scale s
#: with one column split -- letters and panel edges align by construction --
#: plus a KEY_STRIP_MM tracker key along the bottom. Equal block/diagram
#: heights on a 180 mm page then require, with diagram crop aspect A = 1.620
#: (fig6_00_chen_style prints it) and gap = ROW_GAP + LETTER_LEAD = 7.5:
#:   100 s + 7.5 + KEY_STRIP_MM = (172 - 176 s) / A,   W = 176 s + GUTTER
#: whose solution is s = 0.4490, W = 83.02 (both columns 57.40 mm tall).
#: Re-solve if the diagram is re-cropped or any block panel changes size;
#: panels/fig6_00_chen_style.py's CHEN_W_MM and
#: assemble.EXTRA_LETTERS[(11, "a")] carry the same numbers and must move with
#: this (build_block prints the letter offsets to copy).
BLOCK_W = 83.02
#: height of the block's bottom key strip ("LUC3D SLEAP ByteTrack", the one
#: place the three names appear -- the per-panel keys are gone)
KEY_STRIP_MM = 5.0
#: The four panels merged into the block, as ((row1), (row2)) of
#: (src_fig, src_letter, slug). ALL FOUR must be the same native size (the
#: uniform-scale/aligned-columns contract above); build_block fails loudly if
#: one drifts.
#: LAYOUTS[6] slug -> the panels the composite under it is built FROM (letter,
#: slug), for make_docs provenance -- same role as fig3_sync.COMPOSITES.
COMPOSITES = {
    "block": [("a", "within_vs_cross_variant"), ("b", "survival"),
              ("c", "by_animals"), ("d", "decomposition")],
}

BLOCK_ROWS = (((6, "a", "within_vs_cross_variant"), (6, "b", "survival")),
              ((6, "c", "by_animals"), (6, "d", "decomposition")))

#: fig6 files this sync no longer writes; removed so a stale copy cannot be
#: re-placed by hand or linger in the deposit.
STALE: list[str] = []  # the a-d source panels now LIVE in figures/fig6 --
# they are real panel outputs (panels/fig6_01/02/03/05), NOT stale copies; never
# list them here or this sync would delete its own block sources.


def build_block(outdir: Path) -> None:
    """The a-d composite: a UNIFORM 2x2 grid of four same-size fig7 panels at
    one scale, packed to exactly BLOCK_W, with the shared tracker key as one
    horizontal strip along the bottom (the only place LUC3D/SLEAP/ByteTrack
    are named -- the per-panel keys are gone; Eric, 2026-08-25). One scale and
    one column split is what puts the b/d letters, and the panels' own edges,
    on the same verticals. Letters and titles for all four are drawn by
    assemble() itself -- "a" as the block's own LAYOUTS entry and b/c/d via
    assemble.EXTRA_LETTERS -- so every letter sits in the same lead band as its
    neighbours'; the row-2 letters' headroom is the (ROW_GAP + LETTER_LEAD)
    inter-row gap."""
    from assemble import GUTTER, LETTER_LEAD, MM, ROW_GAP
    from src.style import PERIWINKLE, SALMON, TEAL

    gap = ROW_GAP + LETTER_LEAD
    docs, dims = {}, {}
    for row in BLOCK_ROWS:
        for f, l, s in row:
            d = fitz.open(FIGURES / f"fig{f}" / f"fig{f}{l}_{s}.pdf")
            docs[l] = d
            dims[l] = (d[0].rect.width / MM, d[0].rect.height / MM)
    if len({dims[l] for row in BLOCK_ROWS for _f, l, _s in row}) != 1:
        raise SystemExit(f"fig6 block panels are not one size: {dims} -- the "
                         "uniform-scale/aligned-columns contract needs all four "
                         "at 88 x 50 mm (see BLOCK_W's comment)")
    w0, h0 = next(iter(dims.values()))
    s = (BLOCK_W - GUTTER) / (2 * w0)
    ws, hs = w0 * s, h0 * s
    total_h = 2 * hs + gap + KEY_STRIP_MM
    out = fitz.open()
    page = out.new_page(width=BLOCK_W * MM, height=total_h * MM)
    offsets = []
    for ri, row in enumerate(BLOCK_ROWS):
        y = ri * (hs + gap)
        for ci, (_f, letter, _s) in enumerate(row):
            x = ci * (ws + GUTTER)
            page.show_pdf_page(
                fitz.Rect(x * MM, y * MM, (x + ws) * MM, (y + hs) * MM),
                docs[letter], 0)
            offsets.append((letter, round(x, 2), round(y, 2)))
            docs[letter].close()

    # the shared tracker key, one bold coloured line -- same idiom as the sweep
    # panel's own bottom strip
    hebo = fitz.Font("Helvetica-Bold")
    page.insert_font(fontname="Fig11BlockHebo", fontbuffer=hebo.buffer)
    key_pt, key_gap = 7.0, 6.0 * MM
    ky = (total_h - KEY_STRIP_MM + 3.4) * MM
    kx = 0.6 * MM
    for name, hexc in (("LUC3D", TEAL), ("SLEAP", PERIWINKLE),
                       ("ByteTrack", SALMON)):
        rgb = tuple(int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
        page.insert_text(fitz.Point(kx, ky), name, fontname="Fig11BlockHebo",
                         fontsize=key_pt, color=rgb)
        kx += hebo.text_length(name, fontsize=key_pt) + key_gap

    dst = outdir / "fig6a_block.pdf"
    out.save(dst, deflate=True)
    out.close()
    print(f"  fig6a <- fig7 a+b / c+d block  ({BLOCK_W:.2f} x {total_h:.2f} mm, "
          f"x{s:.4f} + {KEY_STRIP_MM:g} mm key strip; sub-letter offsets for "
          "assemble.EXTRA_LETTERS: "
          + ", ".join(f"{l} ({dx}, {dy})" for l, dx, dy in offsets) + ")")


def sync() -> None:
    outdir = FIGURES / "fig6"
    outdir.mkdir(parents=True, exist_ok=True)
    for name in STALE:
        p = outdir / name
        if p.exists():
            p.unlink()
            print(f"  removed stale {name}")
    build_block(outdir)
    for letter, src_fig, src_letter, slug, scale in MAPPING:
        src = FIGURES / f"fig{src_fig}" / f"fig{src_fig}{src_letter}_{slug}.pdf"
        if not src.exists():
            print(f"  MISSING source {src.relative_to(FIGS)} -- fig6{letter} skipped")
            continue
        dst = outdir / f"fig6{letter}_{slug}.pdf"
        sdoc = fitz.open(src)
        r = sdoc[0].rect
        ddoc = fitz.open()
        page = ddoc.new_page(width=r.width * scale, height=r.height * scale)
        page.show_pdf_page(page.rect, sdoc, 0)
        ddoc.save(dst, deflate=True)
        ddoc.close()
        sdoc.close()
        print(f"  fig6{letter} <- fig{src_fig}{src_letter}_{slug}.pdf  x{scale:g}")


if __name__ == "__main__":
    sync()
