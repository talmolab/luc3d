#!/usr/bin/env python3
"""
Find overlapping and out-of-bounds text in the rendered panel PDFs.

This is the useful half of the legacy `lint.py`, reinstated for the reason its own
notes gave: these defects exist only in the EMITTED geometry, so no amount of
reading the generator source finds them. Text that lands on other text, or on a
data mark, or off the page, is invisible until something measures it.

It works on the PDFs, not the figures: every text span's bounding box is read with
PyMuPDF and compared against every other span in the same panel.

    python3 figs/lint_text.py              # every panel
    python3 figs/lint_text.py 3 7          # only these figures

Exit status is non-zero if anything is reported, so it works as a pre-submission
gate. Overlap area is reported as a fraction of the smaller span, and a small
tolerance is allowed because glyph boxes touch legitimately in tight kerning.
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz

FIGS = Path(__file__).resolve().parent
FIGURES = FIGS / "figures"

#: Ignore overlaps smaller than this fraction of the smaller span's area.
TOL = 0.18
#: Ignore spans this short (single glyphs, tick minus signs).
MIN_CHARS = 2


#: Badges burned onto image tiles are WHITE and are meant to sit on the picture.
#: Skipping them keeps the report about plot text, which is what is actionable.
def _is_badge(page, rect):
    d = page.get_text("dict", clip=rect)
    for b in d["blocks"]:
        for line in b.get("lines", []):
            for sp in line["spans"]:
                if sp.get("color", 0) in (16777215, 0xFFFFFF):
                    return True
    return False


def spans(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            for s in line["spans"]:
                t = s["text"].strip()
                if len(t) >= MIN_CHARS and s.get("color", 0) != 16777215:
                    out.append((t, fitz.Rect(s["bbox"]), round(s["size"], 1)))
    return out


def ink_under_text(path, ss, dpi=200, thresh=0.045):
    """Report text that sits on top of DATA.

    THE COLOUR-FAMILY APPROACH DOES NOT WORK and was tried first. It cannot see the
    most common case of all -- a legend entry drawn ON its own curve, in its own
    colour -- because there is no second colour to find. It reported 70 false hits at
    a loose threshold and 0 at a tight one.

    What works: render the panel TWICE, once as-is and once with the text removed by
    redaction (line art and images preserved), then look inside each text box in the
    text-free render. Any ink there was underneath the words.

    `thresh` is the fraction of the box that must be inked, tuned so a label merely
    touching an axis spine does not trip it.
    """
    import numpy as np

    doc = fitz.open(path)
    page = doc[0]
    for _t, r, _z in ss:
        page.add_redact_annot(r)
    # Remove the TEXT only -- keep every stroke and fill, which is the point.
    page.apply_redactions(text=fitz.PDF_REDACT_TEXT_REMOVE,
                          images=fitz.PDF_REDACT_IMAGE_NONE,
                          graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    pix = page.get_pixmap(dpi=dpi)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
        pix.height, pix.width, pix.n)[:, :, :3].astype(int)
    pw, ph = page.rect.width, page.rect.height
    doc.close()

    sx, sy = pix.width / pw, pix.height / ph
    hits = []
    for t, r, _z in ss:
        x0, y0 = max(0, int(r.x0 * sx)), max(0, int(r.y0 * sy))
        x1, y1 = int(r.x1 * sx) + 1, int(r.y1 * sy) + 1
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        inked = (crop.min(axis=2) < 232).mean()
        if inked >= thresh:
            hits.append(("on-data", t, "", round(inked * 100)))
    return hits


def check(path: Path):
    doc = fitz.open(path)
    page = doc[0]
    page_r = page.rect
    ss = spans(page)
    issues = []

    for i in range(len(ss)):
        t1, r1, z1 = ss[i]
        # off the page (or hanging over its edge)
        if not fitz.Rect(page_r).contains(r1):
            # 0.05 pt, not 0.5. Two independent overhangs of 0.15 pt and 0.3 pt
            # slipped under the old tolerance and silently lost a digit of
            # "P = 0.014" and part of a title -- the renderer drops off-page glyphs
            # without complaint, so the tolerance has to be tighter than anything
            # that can cost a character.
            if r1.x0 < page_r.x0 - 0.05 or r1.x1 > page_r.x1 + 0.05 \
               or r1.y0 < page_r.y0 - 0.05 or r1.y1 > page_r.y1 + 0.05:
                issues.append(("clipped", t1, "", 0.0))
        for j in range(i + 1, len(ss)):
            t2, r2, z2 = ss[j]
            inter = r1 & r2
            if inter.is_empty:
                continue
            a = inter.get_area()
            small = min(r1.get_area(), r2.get_area()) or 1.0
            if a / small >= TOL:
                issues.append(("overlap", t1, t2, a / small))
    issues += ink_under_text(path, ss)
    doc.close()
    return issues


def main(argv):
    want = {int(a) for a in argv if a.isdigit()}
    bad = 0
    for p in sorted(FIGURES.glob("fig*/fig*_*.pdf")):
        n = int(p.parent.name.replace("fig", ""))
        if want and n not in want:
            continue
        iss = check(p)
        if iss:
            bad += len(iss)
            print(f"\n{p.relative_to(FIGURES)}")
            for kind, t1, t2, frac in iss[:12]:
                if kind == "clipped":
                    print(f"    CLIPPED  {t1!r}")
                elif kind == "on-data":
                    print(f"    ON DATA  {t1!r}  ({int(frac)}% of its box inked)")
                else:
                    print(f"    OVERLAP  {t1!r} × {t2!r}  ({frac:.0%})")
            if len(iss) > 12:
                print(f"    ... and {len(iss) - 12} more")
    print(f"\n{bad} text issues")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
