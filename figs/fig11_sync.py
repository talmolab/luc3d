#!/usr/bin/env python3
"""
LINT NOTE (2026-08-16): at the 0.635 cram scale, source annotations set at
6.5-7 pt land at 4.1-4.4 pt, below lint_text's 5.0 pt floor. Accepted: Eric asked
for the plots crammed; clearing the floor would need >=0.77 scale and a ~260 mm
page. The remaining BELOW-5pt lint hits on fig11 panels are this, not a defect.

Sync Figure 11's panels from Figures 7 and 10.

FIGURE 11 IS A COMBINED VIEW of Figs 7 + 10 (Eric 2026-08-16: "combine fig 7 and
fig 10 ... make the plots smaller but cram them all in"). It owns NO panel scripts:
every fig11 panel is one of the existing per-panel PDFs under figures/fig7/ and
figures/fig10/, copied here at a REDUCED VECTOR SCALE. That indirection exists
because `assemble.py` places each panel at its native PDF width and refuses rows
wider than the 180 mm page -- so "smaller" has to happen to the panel PDF itself,
not at assembly. `show_pdf_page` into a shrunken page is a lossless vector
transform: type and strokes stay live, they just print smaller (accepted here --
the whole point is to cram).

Re-running a SOURCE panel script does NOT update fig11 -- re-run this after any
fig7/fig10 panel regenerates:

    .venv/bin/python figs/fig11_sync.py && .venv/bin/python figs/assemble.py 11

The letter mapping and per-panel scale live in MAPPING below; keep it in sync with
LAYOUTS[11] / TITLES in assemble.py and the Figure 11 table in PANEL-SOURCES.md.
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

#: (fig11 letter, source figure, source letter, slug, scale).
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
#: anchor diagram (panels/fig11_00_chen_style.py -- the one fig11 panel with its
#: own script, fig13-style) can span both of their rows at 91 mm, directly above
#: the sweep it explains, now lettered f. Fig 7's own panels and PDFs are
#: untouched, as is LAYOUTS[8] (still not assembled as its own figure).
MAPPING = [
    ("f", 8, "d", "pr_switches", FULL_SCALE),
]

#: The a-d block's total width, mm. SOLVED, not chosen: with the block's rows
#: packed to equal per-row heights (below) and the diagram's crop aspect A =
#: 1.609 (fig11_00_chen_style prints it), equal block/diagram heights on a
#: 180 mm page require
#:   (W - GUTTER)*(1/3.1794 + 1/3.36) + (ROW_GAP + LETTER_LEAD) = (176 - W)/A
#: whose solution is 84.57 (block and diagram both 56.8 mm tall, no leftover
#: white in either column). Re-solve if the diagram is re-cropped or any fig7
#: panel changes size; panels/fig11_00_chen_style.py's CHEN_W_MM and
#: assemble.EXTRA_LETTERS[(11, "a")] carry the same numbers and must move with
#: this (build_block prints the letter offsets to copy).
BLOCK_W = 84.26  # re-solved 2026-08-25 (twice): diagram crop aspect now 1.620
#: The four panels merged into the block, as ((row1), (row2)) of
#: (src_fig, src_letter, slug). Within each row every panel is scaled to the
#: SAME height (a taller-native panel shrinks more), so the row bottoms align
#: and the block packs with no ragged edge -- the whitespace complaint this
#: re-cut answers.
BLOCK_ROWS = (((7, "a", "within_vs_cross_variant"), (7, "b", "survival")),
              ((7, "c", "by_animals"), (7, "d", "decomposition")))

#: fig11 files this sync no longer writes; removed so a stale copy cannot be
#: re-placed by hand or linger in the deposit.
STALE = ["fig11a_within_vs_cross_variant.pdf", "fig11b_survival.pdf",
         "fig11c_by_animals.pdf", "fig11d_decomposition.pdf",
         "fig11e_recall.pdf", "fig11f_fragmentations.pdf",
         "fig11g_pr_switches.pdf"]


def build_block(outdir: Path) -> None:
    """The a-d composite: two rows of two fig7 panels, each row scaled to one
    shared height, packed to exactly BLOCK_W. Letters and titles for all four
    are drawn by assemble() itself -- "a" as the block's own LAYOUTS entry and
    b/c/d via assemble.EXTRA_LETTERS -- so every letter sits in the same lead
    band as its neighbours' ("make sure that the letters vertically align",
    Eric 2026-08-25); this PDF holds ONLY the plots. The row-2 letters need
    headroom INSIDE the block, which is what the (ROW_GAP + LETTER_LEAD) inter-
    row gap is."""
    from assemble import GUTTER, LETTER_LEAD, MM, ROW_GAP

    gap = ROW_GAP + LETTER_LEAD
    rows = []
    for row in BLOCK_ROWS:
        docs = [fitz.open(FIGURES / f"fig{f}" / f"fig{f}{l}_{s}.pdf")
                for f, l, s in row]
        dims = [(d[0].rect.width / MM, d[0].rect.height / MM) for d in docs]
        h = (BLOCK_W - GUTTER) / sum(w / hh for w, hh in dims)
        rows.append((row, docs, dims, h))

    total_h = sum(h for *_, h in rows) + gap * (len(rows) - 1)
    out = fitz.open()
    page = out.new_page(width=BLOCK_W * MM, height=total_h * MM)
    y = 0.0
    offsets = []
    for row, docs, dims, h in rows:
        x = 0.0
        for (_f, letter, _s), d, (w, hh) in zip(row, docs, dims):
            ws = w * h / hh
            page.show_pdf_page(
                fitz.Rect(x * MM, y * MM, (x + ws) * MM, (y + h) * MM), d, 0)
            offsets.append((letter, round(x, 2), round(y, 2)))
            x += ws + GUTTER
            d.close()
        y += h + gap
    dst = outdir / "fig11a_block.pdf"
    out.save(dst, deflate=True)
    out.close()
    print(f"  fig11a <- fig7 a+b / c+d block  ({BLOCK_W:.2f} x {total_h:.2f} mm; "
          "sub-letter offsets for assemble.EXTRA_LETTERS: "
          + ", ".join(f"{l} ({dx}, {dy})" for l, dx, dy in offsets) + ")")


def sync() -> None:
    outdir = FIGURES / "fig11"
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
            print(f"  MISSING source {src.relative_to(FIGS)} -- fig11{letter} skipped")
            continue
        dst = outdir / f"fig11{letter}_{slug}.pdf"
        sdoc = fitz.open(src)
        r = sdoc[0].rect
        ddoc = fitz.open()
        page = ddoc.new_page(width=r.width * scale, height=r.height * scale)
        page.show_pdf_page(page.rect, sdoc, 0)
        ddoc.save(dst, deflate=True)
        ddoc.close()
        sdoc.close()
        print(f"  fig11{letter} <- fig{src_fig}{src_letter}_{slug}.pdf  x{scale:g}")


if __name__ == "__main__":
    sync()
