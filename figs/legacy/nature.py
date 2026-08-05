#!/usr/bin/env python3
"""
A very small SVG layout library in MILLIMETRES, set up for Nature-family figures
(the SLEAP paper, Pereira et al. Nat Methods 2022, is the reference we are matching).

Conventions this encodes, so individual figure scripts do not each reinvent them:

  * Widths are the journal's: 88 mm (1 col), 120 mm (1.5 col), 180 mm (2 col).
    Height is free up to ~240 mm (one page).
  * Panel letters are BOLD LOWERCASE (a, b, c) at 8 pt, flush left, sitting above
    the panel content -- not inside a box, not parenthesised, not capitals.
  * Body text is 7 pt Arial (Helvetica / Liberation Sans are metric substitutes);
    small annotation text 6 pt; nothing below 5 pt, which is the floor for print.
  * Rules and leader lines are 0.4 pt; data strokes 0.5-0.75 pt. Nothing hairline
    (< 0.25 pt) because it drops out in print.
  * Images are cropped by clipping a full-resolution PNG, never by rescaling it
    down first -- the crop stays editable and no resampling is baked in.
  * Micrographs/video frames get a scale bar when a mm-per-pixel is known, and
    always sit on a 0.4 pt frame so the panel edge is unambiguous.

Everything is plain SVG: no matplotlib, no external fonts, no build step. Render
with figs/render.mjs (headless Chromium -> PNG at any DPI, and PDF).
"""
from __future__ import annotations

import base64
import html
import os
from dataclasses import dataclass, field

MM = 1.0
PT = 25.4 / 72.0            # 1 pt in mm
FONT = "Arial, Helvetica, 'Liberation Sans', sans-serif"

COL1, COL15, COL2 = 88.0, 120.0, 180.0
# Nature Methods allows 180 x 247 mm for artwork PLUS caption. A ~1,000-character caption
# sets ~14 lines ~= 47 mm, so 240 was never a real ceiling -- Fig 1 passed it at 236.7 mm
# while needing ~284 mm in total. 200 is the ceiling that leaves room for a caption, and
# it is what figs/lint.py enforces on the rendered SVGs.
MAX_H = 200.0
MIN_PT = 5.0        # Nature's type floor
TRIM_MM = 180.0     # double-column measure; anything past this is clipped in the render

# Neutral, print-safe greys/accents for schematics. Data colours come from the
# app (identity colours), never from here -- a figure that recolours its own
# screenshots stops being evidence.
INK = "#000000"
GREY = "#595959"
LIGHT = "#BFBFBF"
FILL = "#F2F2F2"
ACCENT = "#0072B2"          # Okabe-Ito blue
ACCENT2 = "#D55E00"         # Okabe-Ito vermillion


def esc(s) -> str:
    return html.escape(str(s), quote=True)


# Helvetica advance widths, units per 1000 em. Arial is metric-compatible with
# Helvetica, so these are the real advances for the figure font. Having them means
# centring, right-alignment and collision avoidance can be COMPUTED rather than
# eyeballed -- which is what the first pass of Fig 1 got wrong: a caption placed at
# a guessed x overprinted the panel below it.
_W = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
    '{': 334, '|': 260, '}': 334, '~': 584,
    'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722,
    'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667,
    'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944, 'X': 667,
    'Y': 667, 'Z': 611,
    'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556,
    'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556,
    'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722, 'x': 500,
    'y': 500, 'z': 500,
    # symbols the captions actually use
    '→': 800, '←': 800, '≈': 584, '±': 584, '×': 584, '≥': 584, '≤': 584, '−': 584,
    '✓': 600, '–': 556, '—': 1000, '’': 191, '“': 333, '”': 333, 'σ': 556, 'μ': 556,
    '°': 400, '·': 278,
}
for _d in "0123456789":
    _W[_d] = 556


def text_width(s, size=7, weight="normal") -> float:
    """Advance width of `s` in mm at `size` pt. Bold runs ~4% wider in Arial."""
    total = sum(_W.get(ch, 556) for ch in str(s))
    mm = total / 1000.0 * size * PT
    return mm * (1.04 if weight == "bold" else 1.0)


def png_size(path):
    """(width, height) from a PNG's IHDR -- avoids a Pillow dependency."""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG: {path}")
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


@dataclass
class Figure:
    """One journal figure. Coordinates are mm, origin top-left."""
    width: float = COL2
    height: float = 120.0
    parts: list = field(default_factory=list)
    defs: list = field(default_factory=list)
    _uid: int = 0

    def uid(self, prefix="i") -> str:
        self._uid += 1
        return f"{prefix}{self._uid}"

    def add(self, s: str):
        self.parts.append(s)

    # ---------------------------------------------------------------- text ---
    def text(self, x, y, s, size=7, weight="normal", anchor="start",
             fill=INK, italic=False, spacing=None, opacity=None, rotate=None,
             halo=None, halo_w=0.30):
        style = f"font-family:{FONT};font-size:{size * PT:.3f};font-weight:{weight}"
        if italic:
            style += ";font-style:italic"
        if spacing:
            style += f";letter-spacing:{spacing:.3f}"
        extra = ""
        if opacity is not None:
            extra += f' opacity="{opacity}"'
        if rotate is not None:
            extra += f' transform="rotate({rotate} {x:.3f} {y:.3f})"'
        if halo:
            # Same glyphs painted underneath as a thick stroke: the only way a
            # coloured label stays legible over a video frame at print size.
            self.add(f'<text x="{x:.3f}" y="{y:.3f}" text-anchor="{anchor}" '
                     f'fill="none" stroke="{halo}" stroke-width="{halo_w:.4f}" '
                     f'stroke-linejoin="round" style="{style}"{extra}>{esc(s)}</text>')
        self.add(f'<text x="{x:.3f}" y="{y:.3f}" text-anchor="{anchor}" '
                 f'fill="{fill}" style="{style}"{extra}>{esc(s)}</text>')
        return y

    def panel(self, x, y, letter):
        """Bold lowercase panel letter. `y` is its BASELINE."""
        self.text(x, y, letter, size=8, weight="bold")

    def wrapped(self, x, y, s, size=6, width_mm=40, leading=1.15, **kw):
        """Crude greedy wrap -- good enough for short annotations. Returns next y."""
        # 0.5 * font size is a decent mean glyph advance for Arial at these sizes.
        per_char = 0.50 * size * PT
        max_chars = max(6, int(width_mm / per_char))
        words, line, lines = s.split(), "", []
        for w in words:
            trial = (line + " " + w).strip()
            if len(trial) > max_chars and line:
                lines.append(line)
                line = w
            else:
                line = trial
        if line:
            lines.append(line)
        dy = size * PT * leading
        for i, ln in enumerate(lines):
            self.text(x, y + i * dy, ln, size=size, **kw)
        return y + len(lines) * dy

    # --------------------------------------------------------------- shapes ---
    def rect(self, x, y, w, h, fill="none", stroke=INK, sw=0.4 * PT, rx=0, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x:.3f}" y="{y:.3f}" width="{w:.3f}" height="{h:.3f}" '
                 f'rx="{rx:.3f}" fill="{fill}" stroke="{stroke}" '
                 f'stroke-width="{sw:.4f}"{d}/>')

    def line(self, x1, y1, x2, y2, stroke=INK, sw=0.4 * PT, dash=None, cap="butt"):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
                 f'stroke="{stroke}" stroke-width="{sw:.4f}" stroke-linecap="{cap}"{d}/>')

    def _arrowhead(self, color, size=2.6):
        """One marker per (colour, size); reused across the figure."""
        key = f"ah-{color.lstrip('#')}-{int(size * 10)}"
        if key not in [d[0] for d in self.defs]:
            # Marker units are stroke-widths by default; use userSpaceOnUse-ish
            # sizing via markerUnits="userSpaceOnUse" so mm stay mm.
            self.defs.append((key,
                f'<marker id="{key}" markerWidth="{size}" markerHeight="{size}" '
                f'refX="{size * 0.9:.3f}" refY="{size / 2:.3f}" orient="auto" '
                f'markerUnits="userSpaceOnUse">'
                f'<path d="M0,0 L{size:.3f},{size / 2:.3f} L0,{size:.3f} z" fill="{color}"/>'
                f'</marker>'))
        return key

    def arrow(self, x1, y1, x2, y2, color=INK, sw=0.5 * PT, head=2.4, dash=None):
        m = self._arrowhead(color, head)
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
                 f'stroke="{color}" stroke-width="{sw:.4f}" marker-end="url(#{m})"{d}/>')

    def leader(self, x_text, y_text, x_tip, y_tip, s, size=6, color=INK,
               anchor="start", bend=None):
        """Annotation label with a thin arrow to the thing it names."""
        self.text(x_text, y_text, s, size=size, fill=color, anchor=anchor)
        # start the line just past the text baseline box
        pad = 0.6
        sx = x_text + (pad if anchor == "start" else -pad)
        sy = y_text + 0.35
        if bend is not None:
            self.add(f'<path d="M{sx:.3f},{sy:.3f} Q{bend[0]:.3f},{bend[1]:.3f} '
                     f'{x_tip:.3f},{y_tip:.3f}" fill="none" stroke="{color}" '
                     f'stroke-width="{0.4 * PT:.4f}" '
                     f'marker-end="url(#{self._arrowhead(color, 2.0)})"/>')
        else:
            self.arrow(sx, sy, x_tip, y_tip, color=color, sw=0.4 * PT, head=2.0)

    def box_label(self, x, y, w, h, s, size=6.5, fill=FILL, stroke=INK, rx=0.6,
                  sub=None, sub_size=5.5, text_fill=INK):
        """Rounded box with centred label -- the schematic primitive."""
        self.rect(x, y, w, h, fill=fill, stroke=stroke, rx=rx)
        cy = y + h / 2 + (size * PT) * 0.35
        if sub:
            cy = y + h / 2 - 0.1
            self.text(x + w / 2, cy, s, size=size, anchor="middle", fill=text_fill)
            self.text(x + w / 2, cy + sub_size * PT * 1.25, sub, size=sub_size,
                      anchor="middle", fill=GREY)
        else:
            self.text(x + w / 2, cy, s, size=size, anchor="middle", fill=text_fill)

    def swatch(self, x, y, s, color, size=6, sw=1.6):
        """Colour key: a short thick line + label, baseline at y."""
        self.line(x, y - 0.55, x + sw, y - 0.55, stroke=color, sw=0.9 * PT, cap="round")
        self.text(x + sw + 0.8, y, s, size=size)

    # --------------------------------------------------------------- images ---
    def image(self, x, y, w, h, src, crop=None, src_size=None, frame=True,
              embed=False, label=None, label_size=6, label_fill="#FFFFFF",
              scalebar=None, corner=None):
        """
        Place a bitmap in the box (x, y, w, h).

        crop      (x0, y0, x1, y1) in SOURCE PIXELS. The crop is centred and
                  expanded to the box's aspect ratio, so tiles never distort.
        src_size  (width, height) in pixels; required when cropping.
        embed     inline the PNG as a data URI (self-contained SVG, big file).
        label     text drawn inside the top-left of the tile (e.g. camera name).
        scalebar  (length_px, caption) -> bar drawn bottom-right.
        """
        cid = self.uid("clip")
        if embed:
            with open(src, "rb") as f:
                href = "data:image/png;base64," + base64.b64encode(f.read()).decode()
        else:
            # A filesystem path is NOT a usable href: the figure is rendered by
            # loading it over the dev server, so the reference has to be relative
            # to the SVG's own directory (tiles are its siblings in figs/out/).
            href = os.path.basename(src)

        if crop and src_size:
            sw_px, sh_px = src_size
            x0, y0, x1, y1 = crop
            cw, ch = max(1, x1 - x0), max(1, y1 - y0)
            # expand the crop to the tile aspect about its centre
            tile_ar = w / h
            if cw / ch < tile_ar:
                need = ch * tile_ar
                cx = (x0 + x1) / 2
                x0, x1 = cx - need / 2, cx + need / 2
            else:
                need = cw / tile_ar
                cy = (y0 + y1) / 2
                y0, y1 = cy - need / 2, cy + need / 2
            # clamp inside the image, keeping the size if possible
            def clamp(a, b, lim):
                if b - a > lim:
                    return 0.0, float(lim)
                if a < 0:
                    return 0.0, b - a
                if b > lim:
                    return a - (b - lim), float(lim)
                return a, b
            x0, x1 = clamp(x0, x1, sw_px)
            y0, y1 = clamp(y0, y1, sh_px)
            cw, ch = x1 - x0, y1 - y0
            self.last_crop = (x0, y0, x1, y1)
            self.last_norm_crop = (x0 / sw_px, y0 / sh_px, x1 / sw_px, y1 / sh_px)
            scale = w / cw
            ix = x - x0 * scale
            iy = y - y0 * scale
            iw, ih = sw_px * scale, sh_px * scale
            self.px_per_mm = cw / w
        else:
            ix, iy, iw, ih = x, y, w, h
            self.last_crop = (0, 0, src_size[0], src_size[1]) if src_size else None
            self.last_norm_crop = (0.0, 0.0, 1.0, 1.0)
            if src_size:
                self.px_per_mm = src_size[0] / w

        self.add(f'<clipPath id="{cid}"><rect x="{x:.3f}" y="{y:.3f}" '
                 f'width="{w:.3f}" height="{h:.3f}"/></clipPath>')
        self.add(f'<g clip-path="url(#{cid})">'
                 f'<image x="{ix:.4f}" y="{iy:.4f}" width="{iw:.4f}" height="{ih:.4f}" '
                 f'href="{esc(href)}" preserveAspectRatio="none" '
                 f'image-rendering="optimizeQuality"/></g>')
        if frame:
            self.rect(x, y, w, h, stroke=INK, sw=0.4 * PT)
        if label:
            self.text(x + 0.8, y + 1.0 + label_size * PT, label, size=label_size,
                      fill=label_fill, weight="bold")
        if corner:
            self.text(x + w - 0.8, y + 1.0 + label_size * PT, corner, size=label_size,
                      fill=label_fill, anchor="end")
        if scalebar:
            length_px, caption = scalebar
            ppm = getattr(self, "px_per_mm", None)
            if ppm:
                bar_mm = length_px / ppm
                bx2, by = x + w - 1.2, y + h - 1.6
                self.line(bx2 - bar_mm, by, bx2, by, stroke="#FFFFFF", sw=0.9 * PT)
                self.text(bx2, by - 0.7, caption, size=5.5, anchor="end", fill="#FFFFFF")
        return x, y, w, h

    # ----------------------------------------------------------- schematic ---
    def runs(self, x, y, parts, anchor="start", gap=0.0):
        """
        Draw a run of inline spans as ONE line, e.g.
            [("Track All", 6.5, "bold", INK), (": 22 labels -> 3 identities", 6, "normal", GREY)]
        `anchor` "start" | "middle" | "end" positions the WHOLE run, measured with
        the real font metrics -- so a mixed-weight caption can be centred without
        the guesswork that made the first Fig 1 overprint its own panel.
        Returns (x_start, x_end).
        """
        spans = [(str(s), sz, w, fl) for (s, sz, w, fl) in parts]
        total = sum(text_width(s, sz, w) for s, sz, w, _ in spans) + gap * (len(spans) - 1)
        if anchor == "middle":
            cx = x - total / 2
        elif anchor == "end":
            cx = x - total
        else:
            cx = x
        x0 = cx
        for s, sz, w, fl in spans:
            self.text(cx, y, s, size=sz, weight=w, fill=fl)
            cx += text_width(s, sz, w) + gap
        return x0, cx

    def divider(self, x, y, w, label=None, parts=None, size=6, color=LIGHT,
                text_fill=INK, pad=1.6, gap=0.0):
        """
        A hairline rule across `w` with an optional label sitting IN the rule --
        the least fussy way to mark a stage transition between two stacked panels.
        `parts` takes the same span list as runs() for mixed weights.
        """
        if parts is None and label is None:
            self.line(x, y, x + w, y, stroke=color, sw=0.4 * PT)
            return y
        if parts is None:
            parts = [(label, size, "normal", text_fill)]
        tw = (sum(text_width(s, sz, wt) for s, sz, wt, _ in parts)
              + gap * (len(parts) - 1))
        cx = x + w / 2
        gapl, gapr = cx - tw / 2 - pad, cx + tw / 2 + pad
        self.line(x, y, gapl, y, stroke=color, sw=0.4 * PT)
        self.line(gapr, y, x + w, y, stroke=color, sw=0.4 * PT)
        self.runs(cx, y + size * PT * 0.35, parts, anchor="middle", gap=gap)
        return y

    def bracket(self, x0, x1, y, label=None, size=6, color=INK, depth=1.0, below=True):
        """Span bracket under (or over) a range of the figure, with a centred label."""
        s = 1 if below else -1
        self.line(x0, y, x1, y, sw=0.5 * PT, stroke=color)
        self.line(x0, y, x0, y - s * depth, sw=0.5 * PT, stroke=color)
        self.line(x1, y, x1, y - s * depth, sw=0.5 * PT, stroke=color)
        if label:
            ly = y + s * (size * PT + 0.8) if below else y - s * 1.2
            self.text((x0 + x1) / 2, ly, label, size=size, anchor="middle", fill=color)
        return y

    def badge(self, cx, cy, s, r=1.5, fill=INK, text_fill="#FFFFFF", size=5.5):
        """Numbered step disc -- the schematic's "do this first" marker."""
        self.add(f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="{fill}"/>')
        self.text(cx, cy + size * PT * 0.36, str(s), size=size, anchor="middle",
                  fill=text_fill, weight="bold")

    def ring(self, cx, cy, r, color=ACCENT2, sw=0.6, dash=None):
        """Highlight ring: 'look here' without covering the thing being looked at."""
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="none" '
                 f'stroke="{color}" stroke-width="{sw * PT:.4f}"{d}/>')

    def curve(self, x1, y1, x2, y2, bow=0.35, color=INK, sw=0.5, head=True,
              dash=None):
        """
        Curved connector with an optional arrowhead. `bow` is the perpendicular
        offset of the control point as a fraction of the chord -- a gentle arc reads
        as "flow" where a straight line reads as "boundary".
        """
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        dx, dy = x2 - x1, y2 - y1
        cx, cy = mx - dy * bow, my + dx * bow
        d = f' stroke-dasharray="{dash}"' if dash else ""
        m = f' marker-end="url(#{self._arrowhead(color, 2.2)})"' if head else ""
        self.add(f'<path d="M{x1:.3f},{y1:.3f} Q{cx:.3f},{cy:.3f} {x2:.3f},{y2:.3f}" '
                 f'fill="none" stroke="{color}" stroke-width="{sw * PT:.4f}" '
                 f'stroke-linecap="round"{m}{d}/>')

    def zoom_lines(self, src, dst, color=LIGHT, sw=0.4, dash="0.7,0.5"):
        """
        Tie a region of one tile to a magnified tile: draw the source box and two
        dashed leaders to the corresponding corners of the destination. Makes a
        magnified inset verifiable instead of decorative.
        src, dst: (x, y, w, h) in mm.
        """
        sx, sy, sw_, sh = src
        dx, dy, dw, dh = dst
        self.rect(sx, sy, sw_, sh, stroke=color, sw=sw * PT, dash=dash)
        # connect whichever pair of corners does not cross the boxes
        if dx >= sx + sw_:
            pairs = [((sx + sw_, sy), (dx, dy)), ((sx + sw_, sy + sh), (dx, dy + dh))]
        elif dx + dw <= sx:
            pairs = [((sx, sy), (dx + dw, dy)), ((sx, sy + sh), (dx + dw, dy + dh))]
        elif dy >= sy + sh:
            pairs = [((sx, sy + sh), (dx, dy)), ((sx + sw_, sy + sh), (dx + dw, dy))]
        else:
            pairs = [((sx, sy), (dx, dy + dh)), ((sx + sw_, sy), (dx + dw, dy + dh))]
        for (ax, ay), (bx, by) in pairs:
            self.line(ax, ay, bx, by, stroke=color, sw=sw * PT, dash=dash)

    def icon(self, kind, x, y, s=4.0, color=INK, sw=0.45):
        """
        Tiny schematic glyph, drawn inside the box (x, y, s, s). These carry the
        pipeline panel: a reader should be able to follow the stages from the icons
        alone, which is the difference between a schematic and a row of captions.
        kinds: camera, cameras, skeleton, ids, triangulate, cube, check, file, mouse
        """
        k = sw * PT
        cx, cy = x + s / 2, y + s / 2

        def L(x1, y1, x2, y2, c=None, dash=None):
            self.line(x1, y1, x2, y2, stroke=c or color, sw=k, dash=dash, cap="round")

        if kind == "camera":
            self.rect(x, y + s * 0.28, s * 0.62, s * 0.44, stroke=color, sw=k, rx=0.2)
            self.add(f'<path d="M{x + s * 0.62:.3f},{y + s * 0.42:.3f} '
                     f'L{x + s:.3f},{y + s * 0.28:.3f} L{x + s:.3f},{y + s * 0.72:.3f} '
                     f'L{x + s * 0.62:.3f},{y + s * 0.58:.3f} z" fill="none" '
                     f'stroke="{color}" stroke-width="{k:.4f}"/>')
        elif kind == "cameras":
            # three viewpoints around a subject: the multi-camera premise
            for a in (-1, 0, 1):
                bx = cx + a * s * 0.36
                by = y + s * 0.10
                self.rect(bx - s * 0.10, by, s * 0.20, s * 0.14, stroke=color, sw=k, rx=0.15)
                L(bx, by + s * 0.14, cx, y + s * 0.80)
            self.marker(cx, y + s * 0.86, color=color, r=s * 0.08, sw=0)
        elif kind == "skeleton":
            pts = [(0.20, 0.72), (0.40, 0.40), (0.62, 0.52), (0.84, 0.26)]
            for i in range(len(pts) - 1):
                L(x + pts[i][0] * s, y + pts[i][1] * s,
                  x + pts[i + 1][0] * s, y + pts[i + 1][1] * s)
            L(x + 0.40 * s, y + 0.40 * s, x + 0.34 * s, y + 0.14 * s)
            L(x + 0.62 * s, y + 0.52 * s, x + 0.70 * s, y + 0.82 * s)
            for px, py in pts:
                self.marker(x + px * s, y + py * s, color=color, r=s * 0.075, sw=0)
        elif kind == "ids":
            for i, dy in enumerate((0.16, 0.44, 0.72)):
                self.rect(x, y + dy * s, s * 0.42, s * 0.20, stroke=color, sw=k, rx=0.2)
                L(x + s * 0.52, y + (dy + 0.10) * s, x + s, y + (dy + 0.10) * s)
        elif kind == "triangulate":
            # two rays meeting at a point: the DLT premise
            ax, ay = x + s * 0.06, y + s * 0.12
            bx, by = x + s * 0.06, y + s * 0.88
            tx, ty = x + s * 0.92, y + s * 0.50
            L(ax, ay, tx, ty)
            L(bx, by, tx, ty)
            self.rect(ax - s * 0.06, ay - s * 0.07, s * 0.14, s * 0.14,
                      stroke=color, sw=k, rx=0.15)
            self.rect(bx - s * 0.06, by - s * 0.07, s * 0.14, s * 0.14,
                      stroke=color, sw=k, rx=0.15)
            self.marker(tx, ty, color=color, r=s * 0.10, sw=0)
        elif kind == "cube":
            o = s * 0.22
            self.rect(x, y + o, s - o, s - o, stroke=color, sw=k)
            self.rect(x + o, y, s - o, s - o, stroke=color, sw=k)
            L(x, y + o, x + o, y)
            L(x + s - o, y + o, x + s, y)
            L(x, y + s, x + o, y + s - o)
            L(x + s - o, y + s, x + s, y + s - o)
        elif kind == "check":
            L(x + s * 0.16, y + s * 0.54, x + s * 0.40, y + s * 0.78)
            L(x + s * 0.40, y + s * 0.78, x + s * 0.86, y + s * 0.20)
        elif kind == "file":
            f = s * 0.26
            self.add(f'<path d="M{x + s * 0.16:.3f},{y + s * 0.06:.3f} '
                     f'H{x + s * 0.84 - f:.3f} L{x + s * 0.84:.3f},{y + s * 0.06 + f:.3f} '
                     f'V{y + s * 0.94:.3f} H{x + s * 0.16:.3f} z" fill="none" '
                     f'stroke="{color}" stroke-width="{k:.4f}"/>')
            for dy in (0.44, 0.62, 0.80):
                L(x + s * 0.30, y + dy * s, x + s * 0.70, y + dy * s)
        elif kind == "mouse":
            self.add(f'<ellipse cx="{cx:.3f}" cy="{cy:.3f}" rx="{s * 0.34:.3f}" '
                     f'ry="{s * 0.20:.3f}" fill="none" stroke="{color}" '
                     f'stroke-width="{k:.4f}"/>')
            L(cx + s * 0.34, cy, cx + s * 0.48, cy - s * 0.10)
            L(cx - s * 0.34, cy, cx - s * 0.50, cy + s * 0.14)
        return x, y, s, s

    def stage(self, x, y, w, h, title, sub=None, icon_kind=None, fill=FILL,
              stroke=INK, title_size=6.5, sub_size=5.3, rx=0.9, accent=None):
        """
        One pipeline stage: rounded box, optional icon strip at the top, a bold
        title and small grey subtitle. `accent` paints a 0.8 mm bar down the left
        edge, which is how the figure marks the stages this paper contributes.
        """
        self.rect(x, y, w, h, fill=fill, stroke=stroke, rx=rx)
        if accent:
            self.add(f'<path d="M{x + 0.9:.3f},{y:.3f} H{x + rx:.3f} '
                     f'A{rx:.3f},{rx:.3f} 0 0 0 {x:.3f},{y + rx:.3f} '
                     f'V{y + h - rx:.3f} A{rx:.3f},{rx:.3f} 0 0 0 {x + rx:.3f},{y + h:.3f} '
                     f'H{x + 0.9:.3f} z" fill="{accent}" stroke="none"/>')
        cy = y + 1.4
        if icon_kind:
            self.icon(icon_kind, x + w / 2 - 2.0, cy, s=4.0)
            cy += 4.9
        else:
            cy += 0.6
        for ln in str(title).split("\n"):
            self.text(x + w / 2, cy + title_size * PT, ln, size=title_size,
                      anchor="middle", weight="bold")
            cy += title_size * PT * 1.18
        if sub:
            cy += 0.35
            for ln in str(sub).split("\n"):
                self.text(x + w / 2, cy + sub_size * PT, ln, size=sub_size,
                          anchor="middle", fill=GREY)
                cy += sub_size * PT * 1.16
        return x + w

    def tag(self, x, y, s, size=5.3, fill="#FFFFFF", anchor="start", halo="#000000",
            weight="bold"):
        """
        A short label placed directly ON an image, haloed so it survives whatever is
        underneath. Preferred over leader() for annotating a dark 3D tile: a leader
        drawn from a tile corner to a cluster in the middle crosses the whole panel
        and reads as data (that is what the first rig annotation looked like).
        """
        self.text(x, y, s, size=size, anchor=anchor, fill=fill, weight=weight,
                  halo=halo, halo_w=0.34)
        return y

    def chevron(self, x, y, h, w=2.2, color=GREY, sw=0.6):
        """Flow marker between stages -- lighter than a full arrow in a dense row."""
        self.add(f'<path d="M{x:.3f},{y - h / 2:.3f} L{x + w:.3f},{y:.3f} '
                 f'L{x:.3f},{y + h / 2:.3f}" fill="none" stroke="{color}" '
                 f'stroke-width="{sw * PT:.4f}" stroke-linejoin="round" '
                 f'stroke-linecap="round"/>')

    # --------------------------------------------------------------- charts ---
    def ribbon(self, X, Y, xs, lo, hi, color=ACCENT, opacity=0.16):
        """Shaded band between two series -- percentile spread behind a median line."""
        top = " ".join(f"{X(x):.3f},{Y(v):.3f}" for x, v in zip(xs, hi))
        bot = " ".join(f"{X(x):.3f},{Y(v):.3f}" for x, v in reversed(list(zip(xs, lo))))
        self.add(f'<polygon points="{top} {bot}" fill="{color}" '
                 f'fill-opacity="{opacity}" stroke="none"/>')

    def hline(self, X, Y, value, xlim, label=None, color=ACCENT2, dash="1.2,0.9",
              size=5.5, side="right", sw=0.45):
        """Horizontal reference line (a tolerance, a ceiling) with an inline label."""
        y = Y(value)
        self.line(X(xlim[0]), y, X(xlim[1]), y, stroke=color, sw=sw * PT, dash=dash)
        if label:
            if side == "right":
                self.text(X(xlim[1]) - 0.4, y - 0.7, label, size=size, anchor="end",
                          fill=color)
            else:
                self.text(X(xlim[0]) + 0.4, y - 0.7, label, size=size, fill=color)
        return y

    def bars(self, X, Y, items, y0=0.0, width=0.6, labels=True, size=5.5,
             value_fmt="{:.2f}", label_size=5.5, vertical_labels=False):
        """
        Simple vertical bars. `items` = [(x_centre, value, colour, name), ...].
        Values are printed above each bar, because a reader of a small panel should
        not have to measure against an axis.
        """
        for xc, v, col, name in items:
            xl, xr = X(xc - width / 2), X(xc + width / 2)
            yt, yb = Y(v), Y(y0)
            self.rect(xl, min(yt, yb), xr - xl, abs(yb - yt), fill=col, stroke="none", sw=0)
            if labels:
                self.text((xl + xr) / 2, min(yt, yb) - 0.7, value_fmt.format(v),
                          size=size, anchor="middle")
            if name:
                if vertical_labels:
                    self.text((xl + xr) / 2, Y(y0) + 1.2, name, size=label_size,
                              anchor="end", rotate=-90)
                else:
                    self.text((xl + xr) / 2, Y(y0) + label_size * PT + 1.2, name,
                              size=label_size, anchor="middle")

    def box_whisker(self, X, Y, xc, q, width=0.42, color=ACCENT, sw=0.45):
        """
        Box-and-whisker from a percentile dict {p5,p25,p50,p75,p95}. Used instead of
        a bar wherever the DISTRIBUTION is the finding -- a mean bar would hide the
        tail, and here the tail is the whole point.
        """
        xl, xr = X(xc - width / 2), X(xc + width / 2)
        xm = (xl + xr) / 2
        self.line(xm, Y(q["p5"]), xm, Y(q["p95"]), stroke=color, sw=sw * PT)
        for v in ("p5", "p95"):
            self.line(xm - (xr - xl) * 0.22, Y(q[v]), xm + (xr - xl) * 0.22, Y(q[v]),
                      stroke=color, sw=sw * PT)
        self.rect(xl, Y(q["p75"]), xr - xl, Y(q["p25"]) - Y(q["p75"]),
                  fill="#FFFFFF", stroke=color, sw=sw * PT)
        self.line(xl, Y(q["p50"]), xr, Y(q["p50"]), stroke=color, sw=0.8 * PT)

    def legend(self, x, y, items, size=5.8, dy=None, swatch_len=2.4, dash_for=None):
        """Vertical colour key. `items` = [(label, colour), ...]."""
        dy = dy or size * PT * 1.5
        for i, (lab, col) in enumerate(items):
            yy = y + i * dy
            dash = "1.1,0.8" if (dash_for and lab in dash_for) else None
            self.line(x, yy - 0.55, x + swatch_len, yy - 0.55, stroke=col,
                      sw=0.9 * PT, cap="round", dash=dash)
            self.text(x + swatch_len + 0.9, yy, lab, size=size)
        return y + len(items) * dy

    # ---------------------------------------------------------------- table ---
    def table(self, x, y, w, cols, rows, col_w=None, header_size=6, cell_size=6,
              row_h=3.4, rules=True, first_col_left=True, check="✓", cross="–"):
        """
        Nature-style table: no vertical rules, a rule under the header and one at
        the foot, everything else white space.
        `rows` is a list of lists; a cell of True/False renders as check/dash.
        """
        n = len(cols)
        if col_w is None:
            first = w * 0.30
            col_w = [first] + [(w - first) / (n - 1)] * (n - 1)
        xs, acc = [], x
        for cw in col_w:
            xs.append(acc)
            acc += cw
        # header
        hy = y + header_size * PT
        for i, c in enumerate(cols):
            anchor = "start" if (i == 0 and first_col_left) else "middle"
            cx = xs[i] if anchor == "start" else xs[i] + col_w[i] / 2
            self.text(cx, hy, c, size=header_size, weight="bold", anchor=anchor)
        if rules:
            self.line(x, y + header_size * PT + 1.0, x + w, y + header_size * PT + 1.0,
                      sw=0.5 * PT)
        ry = y + header_size * PT + 1.0
        for r in rows:
            ry += row_h
            for i, cell in enumerate(r):
                if cell is True:
                    cell, fill = check, INK
                elif cell is False:
                    cell, fill = cross, GREY
                else:
                    fill = INK
                anchor = "start" if (i == 0 and first_col_left) else "middle"
                cx = xs[i] if anchor == "start" else xs[i] + col_w[i] / 2
                weight = "bold" if (i == 0 and str(r[0]).startswith("LUC3D")) else "normal"
                self.text(cx, ry, str(cell), size=cell_size, anchor=anchor,
                          fill=fill, weight=weight)
        if rules:
            self.line(x, ry + 1.4, x + w, ry + 1.4, sw=0.5 * PT)
        return ry + 1.4

    # ----------------------------------------------------------------- plot ---
    def axes(self, x, y, w, h, xlim, ylim, xlabel=None, ylabel=None,
             xticks=None, yticks=None, size=6, tick_len=0.8, spine=True):
        """Bare two-spine axes (Nature style: no frame, ticks outward)."""
        x0, x1 = xlim
        y0, y1 = ylim

        def X(v):
            return x + (v - x0) / (x1 - x0) * w

        def Y(v):
            return y + h - (v - y0) / (y1 - y0) * h

        if spine:
            self.line(x, y + h, x + w, y + h, sw=0.5 * PT)   # x spine
            self.line(x, y, x, y + h, sw=0.5 * PT)           # y spine
        for t in (xticks or []):
            self.line(X(t), y + h, X(t), y + h + tick_len, sw=0.4 * PT)
            self.text(X(t), y + h + tick_len + size * PT + 0.3, f"{t:g}",
                      size=size, anchor="middle")
        for t in (yticks or []):
            self.line(x - tick_len, Y(t), x, Y(t), sw=0.4 * PT)
            self.text(x - tick_len - 0.5, Y(t) + size * PT * 0.35, f"{t:g}",
                      size=size, anchor="end")
        if xlabel:
            self.text(x + w / 2, y + h + tick_len + (size * PT) * 2.6, xlabel,
                      size=size + 0.5, anchor="middle")
        if ylabel:
            cx = x - tick_len - (size * PT) * 3.0
            cy = y + h / 2
            self.add(f'<text x="{cx:.3f}" y="{cy:.3f}" text-anchor="middle" '
                     f'fill="{INK}" style="font-family:{FONT};'
                     f'font-size:{(size + 0.5) * PT:.3f}" '
                     f'transform="rotate(-90 {cx:.3f} {cy:.3f})">{esc(ylabel)}</text>')
        return X, Y

    def polyline(self, pts, color=ACCENT, sw=0.75 * PT, dash=None, fill="none"):
        d = " ".join(f"{px:.3f},{py:.3f}" for px, py in pts)
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<polyline points="{d}" fill="{fill}" stroke="{color}" '
                 f'stroke-width="{sw:.4f}" stroke-linejoin="round"{da}/>')

    def marker(self, cx, cy, color=ACCENT, r=0.55, shape="o", sw=0.4 * PT):
        if shape == "o":
            self.add(f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="{color}" '
                     f'stroke="#FFFFFF" stroke-width="{sw:.4f}"/>')
        else:
            self.rect(cx - r, cy - r, 2 * r, 2 * r, fill=color, stroke="#FFFFFF", sw=sw)

    # ------------------------------------------------------------------ out ---
    def svg(self) -> str:
        defs = "".join(d[1] for d in self.defs)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{self.width}mm" height="{self.height}mm" '
            f'viewBox="0 0 {self.width} {self.height}">'
            f'<defs>{defs}</defs>'
            f'<rect width="{self.width}" height="{self.height}" fill="#FFFFFF"/>'
            + "".join(self.parts) +
            '</svg>'
        )

    def _assert_type_floor(self, path):
        """Fail on type below MIN_PT or text past the trim edge, naming the offenders.

        Scans the emitted parts rather than tracking state as text is added, so it cannot
        be bypassed by a generator that writes raw SVG via add().
        """
        import re as _re
        name = os.path.basename(path)
        small, over = [], []
        pat = _re.compile(
            r'<text\s+x="([-\d.]+)"\s+y="[-\d.]+"'
            r'(?:\s+text-anchor="(\w+)")?'
            r'([^>]*?font-size:([\d.]+)[^>]*?)>(.*?)</text>', _re.S)
        for x, anchor, attrs, size_mm, body in pat.findall("".join(self.parts)):
            txt = _re.sub(r"<[^>]+>", "", body).strip()
            if not txt:
                continue
            pt = float(size_mm) / PT
            if pt < MIN_PT - 0.05:
                small.append((pt, txt[:38]))
            # text_width takes POINTS and returns mm; passing the mm font-size here
            # understates every width by 1/PT and silently disables the check.
            tw = text_width(txt, pt,
                            weight="bold" if "font-weight:bold" in attrs else "normal")
            x = float(x)
            right = {"end": x, "middle": x + tw / 2}.get(anchor or "start", x + tw)
            if right > TRIM_MM + 0.05:
                over.append((right, txt[:38]))
        msg = []
        if small:
            msg.append(f"{len(small)} runs below {MIN_PT} pt (smallest "
                       f"{min(p for p, _ in small):.1f} pt): " +
                       "; ".join(f'{p:.1f}pt "{t}"' for p, t in sorted(small)[:4]))
        if over:
            msg.append(f"{len(over)} runs past the {TRIM_MM:.0f} mm trim edge: " +
                       "; ".join(f'{r:.1f}mm "{t}"'
                                 for r, t in sorted(over, reverse=True)[:4]))
        if msg:
            raise SystemExit(f"{name}: " + " | ".join(msg))

    def write(self, path):
        # Nothing enforced MAX_H, and Fig 1 silently reached 244 mm -- past the page and
        # leaving no room for a caption. Fail loudly instead.
        if self.height > MAX_H:
            raise SystemExit(
                f"{os.path.basename(path)}: {self.height:.1f} mm exceeds MAX_H "
                f"({MAX_H:.0f} mm). Move prose to figs/CAPTIONS.md or drop a panel.")
        # The type floor and the trim edge were each violated by four of the seven figures
        # and neither was visible in the generator source -- both live only in the emitted
        # geometry. Every generator had grown its own local check; do it once, here.
        self._assert_type_floor(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(self.svg())
        print(f"[svg] {path}  {self.width:.0f}x{self.height:.0f} mm  "
              f"{os.path.getsize(path) / 1024:.0f} KB")
        return path
