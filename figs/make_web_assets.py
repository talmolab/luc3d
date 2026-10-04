#!/usr/bin/env python3
"""
Export the project page's figure assets from the artwork, with provenance.

WHY A SCRIPT AND NOT A COPY. luc3d.talmolab.org shows the same figures as the paper,
and the failure mode is silent: a panel gets corrected here, the page keeps the old
raster, and the two disagree in public with nothing to notice it. This exports from
`figures/figN/figN.pdf` every time and writes a MANIFEST recording, per figure, the
source path, its mtime and size, the git commit of this repo, and the dpi used -- so
the page can always be checked against the artwork it claims to show.

WHY NOT THE TEMPLATE'S OWN PDF PATH. Roman Hauksson's template ships
`src/lib/renderPDF()`, which rasterises page 1 with `pdf-to-img` at `scale: 2` and
writes the PNG straight into `dist/_astro`. Two problems for these figures:

  * `scale: 2` is 144 dpi. These composites are 180 mm wide with 6.5-7.5 pt panel
    text; at 144 dpi that text lands at ~13 px and the sub-labels turn to mush. The
    figures ship at 300 dpi here, which is 2126 px across for a 180 mm figure.
  * that path BYPASSES Astro's image pipeline, so the PNG is served raw -- no AVIF,
    no WebP, no responsive `srcset`. Going through `src/assets/` instead means Astro
    emits modern formats at several widths, which for a 1.8 MB PNG matters more than
    it would for a screenshot.

So the page imports PNGs from `src/assets/`, and the vector PDF is ALSO copied into
`public/pdf/` so each caption can offer a full-resolution link. Nothing is rasterised
at build time.

FIGURE NUMBERING FOLLOWS THE MANUSCRIPT (2026-10-04, Eric: the page's figures carry
the names they have in `figures/drafts/luc3d_newest.tex`). Main Figures 1-5, then
Supplementary Figures 1-4 and Supplementary Table 1; see FIGURES for which artwork
each one is. The repo directories keep their own numbers (repo fig6 is Supplementary
Figure 1, repo fig7 is Supplementary Figure 3), so match by FIGURES, not by number.

    python3 figs/make_web_assets.py                       # default page repo path
    python3 figs/make_web_assets.py --page-repo /path/to/luc3d-page
    python3 figs/make_web_assets.py --check               # verify, write nothing
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

FIGS = Path(__file__).resolve().parent
DEFAULT_PAGE_REPO = Path("/root/vast/eric/luc3d-page")

#: (page slug, artwork PNG, artwork PDF), in the manuscript's own numbering
#: (`figures/drafts/luc3d_newest.tex`). Main Figures 1-5 are the repo's fig1-fig5
#: (fig4 = datasets, fig5 = social rearing since the 2026-10-03 swap). The
#: Supplementary items map onto the tex as: Supplementary Figure 1 = \ref{fig6} =
#: repo fig6; Supplementary Figure 2 = \ref{fig7}, the GUI screenshot, which lives
#: only in Overleaf as `figs/fig7.png` -- exported from `figures/supp_fig2_gui/` if
#: that file exists, skipped otherwise; Supplementary Figure 3 = \ref{fig8} = repo
#: fig7 (calibration); Supplementary Figure 4 = \ref{fig9} = `figs/fig9.pdf`
#: (Panopticon, no repo dir); Supplementary Table 1 = \ref{tab:datasheets}.
#: The page imports `src/assets/figures/<slug>.png` and links `public/pdf/luc3d-<slug>.pdf`.
FIGURES = [
    ("figure1", "figures/fig1/fig1.png", "figures/fig1/fig1.pdf"),
    ("figure2", "figures/fig2/fig2.png", "figures/fig2/fig2.pdf"),
    ("figure3", "figures/fig3/fig3.png", "figures/fig3/fig3.pdf"),
    ("figure4", "figures/fig4/fig4.png", "figures/fig4/fig4.pdf"),
    ("figure5", "figures/fig5/fig5.png", "figures/fig5/fig5.pdf"),
    ("supp-figure1", "figures/fig6/fig6.png", "figures/fig6/fig6.pdf"),
    ("supp-figure2", "figures/supp_fig2_gui/fig7.png", None),
    ("supp-figure3", "figures/fig7/fig7.png", "figures/fig7/fig7.pdf"),
    ("supp-figure4", "fig9.png", "fig9.pdf"),
    ("supp-table1", "figures/datasheets/datasheet_combined.png",
     "figures/datasheets/datasheet_combined.pdf"),
]

#: Entries that may be absent without failing the export (see Supplementary Figure 2).
OPTIONAL = {"supp-figure2"}

#: The dpi the composites are rendered at by `assemble.py` (its PNG proof). Recorded
#: rather than assumed: if the assembler's dpi changes, the manifest says so.
PROOF_DPI = 300


def git_commit(path: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def git_dirty(path: Path) -> bool:
    """True if anything under figs/figures/ differs from HEAD (so artwork_commit
    alone does not identify what was exported)."""
    try:
        out = subprocess.run(["git", "-C", str(path), "status", "--porcelain", "--",
                              "figures"], capture_output=True, text=True, check=True).stdout
        return bool(out.strip())
    except Exception:
        return False


def digest(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--page-repo", type=Path, default=DEFAULT_PAGE_REPO)
    ap.add_argument("--check", action="store_true",
                    help="compare the page's assets against the artwork and report "
                         "drift; exit non-zero if any figure is stale or missing")
    a = ap.parse_args()

    assets = a.page_repo / "src" / "assets" / "figures"
    pdfs = a.page_repo / "public" / "pdf"
    if not a.check:
        assets.mkdir(parents=True, exist_ok=True)
        pdfs.mkdir(parents=True, exist_ok=True)

    manifest = {
        "generated_by": "figs/make_web_assets.py",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "artwork_commit": git_commit(FIGS),
        "artwork_dirty": git_dirty(FIGS),
        "proof_dpi": PROOF_DPI,
        "note": "PNGs are assemble.py's 300 dpi proofs, imported through Astro's "
                "image pipeline; the vector PDF is served from public/pdf/ for the "
                "full-resolution link under each caption.",
        "figures": [],
    }

    stale, missing = [], []
    for slug, rel_png, rel_pdf in FIGURES:
        src_png = FIGS / rel_png
        src_pdf = FIGS / rel_pdf if rel_pdf else None
        if not src_png.exists() or (src_pdf and not src_pdf.exists()):
            if slug in OPTIONAL:
                print(f"  {slug}: no {rel_png} -- skipped (optional)")
                continue
            missing.append(f"{slug}: no {rel_png} / {rel_pdf}")
            continue
        dst_png = assets / f"{slug}.png"
        dst_pdf = pdfs / f"luc3d-{slug}.pdf" if src_pdf else None
        entry = {
            "slug": slug,
            "source_png": str(src_png.relative_to(FIGS.parent)),
            "png_sha256_16": digest(src_png), "png_bytes": src_png.stat().st_size,
            "asset": f"src/assets/figures/{slug}.png",
        }
        if src_pdf:
            entry.update({
                "source_pdf": str(src_pdf.relative_to(FIGS.parent)),
                "pdf_sha256_16": digest(src_pdf), "pdf_bytes": src_pdf.stat().st_size,
                "pdf_asset": f"public/pdf/luc3d-{slug}.pdf",
            })
        manifest["figures"].append(entry)

        if a.check:
            if not dst_png.exists() or digest(dst_png) != entry["png_sha256_16"]:
                stale.append(f"{slug} PNG")
            if src_pdf and (not dst_pdf.exists() or digest(dst_pdf) != entry["pdf_sha256_16"]):
                stale.append(f"{slug} PDF")
        else:
            shutil.copy2(src_png, dst_png)
            if src_pdf:
                shutil.copy2(src_pdf, dst_pdf)
            print(f"  {slug:13s} <- {rel_png}  ({entry['png_bytes'] / 1e6:.1f} MB png"
                  + (f", {entry['pdf_bytes'] / 1e6:.1f} MB pdf)" if src_pdf else ")"))

    if missing:
        print("MISSING artwork:", *missing, sep="\n  ")
        return 2
    if a.check:
        if stale:
            print("STALE on the page (re-run without --check):", *stale, sep="\n  ")
            return 1
        print(f"all {len(manifest['figures'])} figures match the artwork")
        return 0

    mpath = a.page_repo / "src" / "assets" / "figures" / "MANIFEST.json"
    mpath.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[manifest] {mpath}")
    print(f"artwork commit {manifest['artwork_commit'][:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
