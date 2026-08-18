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

FIGURE NUMBERING IS THE MANUSCRIPT'S, NOT THE REPO'S. `figures/fig11/` is the
combined tracking + transfer figure, which the manuscript prints as Figure 7 (the
standalone figs 7 and 10 are retired to unplaced, as are 8 and 9). The page therefore
shows seven figures numbered 1-7, and FIGURES maps that explicitly rather than leaving
a reader to infer it from a filename.

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

#: (page figure number, artwork directory). The page's Figure N is FIGURES[N-1].
#: fig11 -> Figure 7: see the docstring.
FIGURES = [
    (1, "fig1"),
    (2, "fig2"),
    (3, "fig3"),
    (4, "fig4"),
    (5, "fig5"),
    (6, "fig6"),
    (7, "fig11"),
]

#: The dpi the composites are rendered at by `assemble.py` (its PNG proof). Recorded
#: rather than assumed: if the assembler's dpi changes, the manifest says so.
PROOF_DPI = 300


def git_commit(path: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


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
        "proof_dpi": PROOF_DPI,
        "note": "PNGs are assemble.py's 300 dpi proofs, imported through Astro's "
                "image pipeline; the vector PDF is served from public/pdf/ for the "
                "full-resolution link under each caption.",
        "figures": [],
    }

    stale, missing = [], []
    for n, d in FIGURES:
        src_png = FIGS / "figures" / d / f"{d}.png"
        src_pdf = FIGS / "figures" / d / f"{d}.pdf"
        if not src_png.exists() or not src_pdf.exists():
            missing.append(f"figure {n} ({d}): no {src_png.name} / {src_pdf.name}")
            continue
        dst_png = assets / f"figure{n}.png"
        dst_pdf = pdfs / f"luc3d-figure{n}.pdf"
        entry = {
            "figure": n, "artwork_dir": d,
            "source_png": str(src_png.relative_to(FIGS.parent)),
            "source_pdf": str(src_pdf.relative_to(FIGS.parent)),
            "png_sha256_16": digest(src_png), "png_bytes": src_png.stat().st_size,
            "pdf_sha256_16": digest(src_pdf), "pdf_bytes": src_pdf.stat().st_size,
            "asset": f"src/assets/figures/figure{n}.png",
            "pdf_asset": f"public/pdf/luc3d-figure{n}.pdf",
        }
        manifest["figures"].append(entry)

        if a.check:
            if not dst_png.exists() or digest(dst_png) != entry["png_sha256_16"]:
                stale.append(f"figure {n} ({d}) PNG")
            if not dst_pdf.exists() or digest(dst_pdf) != entry["pdf_sha256_16"]:
                stale.append(f"figure {n} ({d}) PDF")
        else:
            shutil.copy2(src_png, dst_png)
            shutil.copy2(src_pdf, dst_pdf)
            print(f"  figure {n}  <- {d}  "
                  f"({entry['png_bytes'] / 1e6:.1f} MB png, "
                  f"{entry['pdf_bytes'] / 1e6:.1f} MB pdf)")

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
