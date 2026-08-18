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

#: (fig11 letter, source figure, source letter, slug, scale).
#: Narrative order: the home-corpus tracker comparison first (Fig 7 a-f), then the
#: s-DANNCE transfer benchmark (Fig 10 a-g). Slugs are kept identical to the source
#: so the provenance is readable off the filename.
MAPPING = [
    ("a", 7, "a", "within_vs_cross_variant", PLOT_SCALE),
    ("b", 7, "b", "survival", PLOT_SCALE),
    ("c", 7, "c", "by_animals", PLOT_SCALE),
    ("d", 7, "d", "decomposition", PLOT_SCALE),
    ("e", 7, "e", "recall", PLOT_SCALE),
    ("f", 7, "f", "fragmentations", PLOT_SCALE),
    ("g", 10, "a", "views", STRIP_SCALE),
    ("h", 10, "b", "residuals", PLOT_SCALE),
    ("i", 10, "c", "noise", PLOT_SCALE),
    ("j", 10, "d", "dropout", PLOT_SCALE),
    ("k", 10, "e", "inputs", PLOT_SCALE),
    ("l", 10, "f", "cameras", PLOT_SCALE),
    ("m", 10, "g", "switches", PLOT_SCALE),
]


def sync() -> None:
    outdir = FIGURES / "fig11"
    outdir.mkdir(parents=True, exist_ok=True)
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
