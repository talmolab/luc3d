#!/usr/bin/env python3
"""
Mechanical checks on the RENDERED SVGs. Three defect classes recurred across the
figure set and every one of them was invisible in the generator source -- they only
exist in the emitted geometry, so this lints the output, not the code:

  1. Type below Nature's 5 pt floor. Found 50 sub-5-pt runs in fig5 alone, including
     the bar value labels a reader is *meant* to read (4.6 pt -> 1.15 mm cap height).
  2. Text crossing the 180 mm trim edge. Fig 2's 2c annotation ended at 180.3 mm and
     was clipped in the render; Fig 5's `24.6` label ended at exactly 180.0 mm.
  3. Artwork taller than a page can hold. Fig 1 reached 236.7 mm, and a ~47 mm caption
     puts the total near 284 mm against Nature Methods' 247 mm limit. nature.py's own
     MAX_H guard was set too high to catch it.

Text width is estimated with the same Helvetica advance-width table nature.py uses for
computed placement, so a flagged overflow here is the same overflow the renderer draws.

Usage: python3 figs/lint.py [figs/out/fig3.svg ...]     (default: all out/fig*.svg)
Exit status is non-zero if anything fails, so it works in a pre-submission gate.
"""
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import text_width  # noqa: E402

MIN_PT = 5.0
TRIM_MM = 180.0
# Artwork ceiling. Nature Methods allows 180 x 247 mm for artwork PLUS caption; a
# 1,000-character caption sets ~14 lines ~= 47 mm, so the artwork itself must stay near
# 200 mm. This is deliberately stricter than nature.py's MAX_H.
MAX_ART_MM = 200.0
PT_PER_MM = 1 / 0.3528

TEXT_RE = re.compile(
    r'<text\s+x="([-\d.]+)"\s+y="([-\d.]+)"'
    r'(?:\s+text-anchor="(\w+)")?'
    r'([^>]*?font-size:([\d.]+)[^>]*?)>(.*?)</text>',
    re.S)
SVG_RE = re.compile(r'<svg[^>]*?width="([\d.]+)mm"[^>]*?height="([\d.]+)mm"')


def unescape(s):
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&#39;", "'"))


def check(path):
    src = open(path).read()
    name = os.path.basename(path)
    fails, warns = [], []

    m = SVG_RE.search(src)
    if not m:
        return [f"{name}: no <svg width/height> found"], []
    w_mm, h_mm = float(m.group(1)), float(m.group(2))
    if h_mm > MAX_ART_MM:
        fails.append(f"{name}: {h_mm:.1f} mm tall, over the {MAX_ART_MM:.0f} mm artwork "
                     f"ceiling (leaves no room for a caption on a 247 mm page)")

    small, over = [], []
    for x, y, anchor, attrs, size_mm, body in TEXT_RE.findall(src):
        txt = unescape(re.sub(r"<[^>]+>", "", body)).strip()
        if not txt:
            continue
        x, size_mm = float(x), float(size_mm)
        pt = size_mm * PT_PER_MM
        if pt < MIN_PT - 0.05:
            small.append((pt, txt[:42]))
        # right edge depends on the anchor the renderer will honour.
        # text_width() takes POINTS and returns mm -- passing the SVG's mm font-size
        # underestimates every width by 1/PT (2.83x) and silently disables this check.
        tw = text_width(txt, pt,
                        weight="bold" if "font-weight:bold" in attrs else "normal")
        right = {"end": x, "middle": x + tw / 2}.get(anchor or "start", x + tw)
        if right > TRIM_MM + 0.05:
            over.append((right, txt[:42]))

    if small:
        worst = min(p for p, _ in small)
        fails.append(f"{name}: {len(small)} text runs below {MIN_PT} pt "
                     f"(smallest {worst:.1f} pt) e.g. " +
                     "; ".join(f'{p:.1f}pt "{t}"' for p, t in sorted(small)[:3]))
    if over:
        fails.append(f"{name}: {len(over)} text runs past the {TRIM_MM:.0f} mm trim edge "
                     f"e.g. " + "; ".join(f'{r:.1f}mm "{t}"'
                                          for r, t in sorted(over, reverse=True)[:3]))
    if abs(w_mm - TRIM_MM) > 0.5:
        warns.append(f"{name}: width {w_mm:.1f} mm is not the {TRIM_MM:.0f} mm "
                     f"double-column measure")
    return fails, warns


def main():
    paths = sys.argv[1:] or sorted(
        glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "out", "fig*.svg")))
    all_fails, all_warns = [], []
    for p in paths:
        f, w = check(p)
        all_fails += f
        all_warns += w
    for w in all_warns:
        print(f"  warn  {w}")
    for f in all_fails:
        print(f"  FAIL  {f}")
    print(f"\n{len(paths)} figures checked, {len(all_fails)} failures, "
          f"{len(all_warns)} warnings")
    return 1 if all_fails else 0


if __name__ == "__main__":
    sys.exit(main())
