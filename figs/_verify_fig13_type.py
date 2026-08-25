#!/usr/bin/env python3
"""
Report the type sizes Fig 13's two staged-3D illustrations ACTUALLY print at.

13c (`hyp_fig_style.py`) and 13d (`idswitch_fig_style.py`) are rasterised to a
PNG, cropped to their ink by their panel scripts, and then placed at different
widths in the Fig 13 row. So a size written in either script's source points
does NOT tell you what it measures on the page, and the two scripts using the
same number does NOT make the two panels agree -- which is exactly how their
camera labels ended up at 7.07 pt and 7.56 pt from a shared nominal 7.4 (Eric,
2026-08-25: "we need to verify this from the perspective of fig13, when we
render them earlier they may be the same numbers but not actually the same size
like they should be").

    on_page_pt = source_pt * DPI * PLACED_MM / (CROP_W_PX * 25.4)

This prints, for both panels, the measured CROP_W_PX and the realised on-page
size of every PAGE_* size the scripts declare. Two things to check:

  * each panel's CROP_W_PX constant matches the crop measured here (they are
    mildly self-referential -- bigger type makes a wider crop -- so they are
    re-measured after a build; one pass converges);
  * the realised sizes AGREE between the two panels.

    .venv/bin/python figs/_verify_fig13_type.py

Not a test and not part of any suite -- an investigation tool, like the
`_diag-*` scripts. It reads the built artefacts, so run the panel scripts
first.
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import fitz

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))

import hyp_fig_style as C          # noqa: E402
import idswitch_fig_style as D     # noqa: E402
sys.path.insert(0, str(FIGS / "panels"))
from fig13_00_hyp_illustration import content_crop  # noqa: E402

PANELS = [
    ("13c", C, FIGS / "figures/drafts/figs/lucid_hyp_style_sidetop.png",
     FIGS / "figures/fig13/fig13c_hyp_illustration.pdf"),
    ("13d", D, FIGS / "figures/drafts/figs/lucid_idswitch_style_hardfight.png",
     FIGS / "figures/fig13/fig13d_idswitch.pdf"),
]


def main():
    rows = {}
    for name, mod, png, pdf in PANELS:
        if not png.exists() or not pdf.exists():
            print(f"{name}: MISSING {png if not png.exists() else pdf} -- "
                  f"run its style + panel script first")
            continue
        x0, _, x1, _ = content_crop(mpimg.imread(png))
        crop_w = x1 - x0
        placed = fitz.open(pdf)[0].rect.width / (72.0 / 25.4)
        drift = "" if crop_w == mod.CROP_W_PX else (
            f"   ** CROP_W_PX says {mod.CROP_W_PX}, measured {crop_w} -- "
            f"update it and rebuild **")
        print(f"\n{name}: crop_w {crop_w} px, placed {placed:.2f} mm "
              f"(constant PLACED_MM {mod.PLACED_MM}){drift}")
        sizes = {}
        for attr in sorted(a for a in dir(mod) if a.startswith("PAGE_")):
            declared = getattr(mod, attr)
            realised = (mod.pt(declared) * mod.DPI * placed) / (crop_w * 25.4)
            sizes[attr] = realised
            print(f"    {attr:<16} declared {declared:>5.2f} pt "
                  f"-> on page {realised:>5.2f} pt")
        rows[name] = sizes

    if len(rows) == 2:
        a, b = rows["13c"], rows["13d"]
        shared = sorted(set(a) & set(b))
        print("\nshared sizes, 13c vs 13d on the page:")
        worst = 0.0
        for k in shared:
            d = abs(a[k] - b[k])
            worst = max(worst, d)
            flag = "  <-- MISMATCH" if d > 0.05 else ""
            print(f"    {k:<16} {a[k]:>5.2f}  vs {b[k]:>5.2f} pt{flag}")
        print(f"\nworst disagreement: {worst:.3f} pt"
              f"{'  (OK)' if worst <= 0.05 else '  (FIX)'}")


if __name__ == "__main__":
    main()
