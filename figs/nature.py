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
MAX_H = 240.0

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

    def write(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(self.svg())
        print(f"[svg] {path}  {self.width:.0f}x{self.height:.0f} mm  "
              f"{os.path.getsize(path) / 1024:.0f} KB")
        return path
