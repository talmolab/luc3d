"""Generate the app's icons and link-preview image from the logo.

    python scripts/make_icons.py [--source docs/assets/luc3d-logo.webp] [--font PATH] [--font-bold PATH]

Writes into icons/:
  favicon.ico            16, 32, 48 px (the tile, glow removed, transparent corners)
  favicon-16.png, favicon-32.png
  icon-192.png, icon-512.png     (web app manifest, same cut)
  apple-touch-icon.png   180 px, opaque: iOS rounds the corners itself and
                         would fill transparent ones with black
  og-image.png           1200x630 link preview (Open Graph / Twitter card)

The source is the logo with its outer glow and drop shadow. Every size is
resampled premultiplied (PIL "RGBa"), so fully transparent pixels stay RGB-zero
and the small sizes do not fringe. Needs Pillow and numpy; the preview's text
uses Segoe UI by default (Windows), any TTF works via --font / --font-bold.
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')

# The tile's opaque body; the glow around it never reaches this alpha.
TILE_ALPHA = 250


def resize(im, size):
    """Premultiplied resample, so transparent pixels carry no colour."""
    return im.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')


def cut_tile(logo):
    """The tile alone, glow removed, centred on a transparent square."""
    a = np.asarray(logo)[:, :, 3]
    body = a >= TILE_ALPHA
    rows = np.where(body.any(1))[0]
    cols = np.where(body.any(0))[0]
    top, bottom, left, right = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    px = np.array(logo.crop((left, top, right, bottom)))
    # Drop the glow showing through the rounded corners; the resample to icon
    # size anti-aliases the hard edge.
    px[:, :, 3] = np.where(px[:, :, 3] >= TILE_ALPHA, 255, 0)
    px[px[:, :, 3] == 0] = 0
    tile = Image.fromarray(px, 'RGBA')
    side = max(tile.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(tile, ((side - tile.width) // 2, (side - tile.height) // 2))
    return square


def tile_background(tile):
    """The tile's dark fill: the median of its opaque, unlit pixels."""
    px = np.asarray(tile).reshape(-1, 4)
    dark = px[(px[:, 3] == 255) & (px[:, :3].max(1) < 40)]
    return tuple(int(v) for v in np.median(dark[:, :3], axis=0))


def apple_touch(tile, bg, size=180):
    flat = Image.new('RGBA', tile.size, bg + (255,))
    flat.alpha_composite(tile)
    return resize(flat, (size, size)).convert('RGB')


def font(path, size):
    return ImageFont.truetype(path, size)


def og_image(logo, bg, font_regular, font_bold, size=(1200, 630)):
    w, h = size
    base = np.zeros((h, w, 3), np.float32)
    base[:] = np.array(bg, np.float32) * 0.7
    # A soft teal light behind the logo.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = 300, h / 2
    d = np.sqrt(((xx - cx) / 520) ** 2 + ((yy - cy) / 420) ** 2)
    glow = np.clip(1 - d, 0, 1) ** 2
    base += glow[:, :, None] * np.array([10, 60, 62], np.float32)
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')

    mark = resize(logo, (440, 440))
    img.alpha_composite(mark, (int(cx - 220), int(cy - 220)))

    draw = ImageDraw.Draw(img)
    x = 560
    title = font(font_bold, 150)
    draw.text((x - 6, 135), 'LUC3D', font=title, fill=(240, 246, 247))
    sub = font(font_regular, 38)
    draw.text((x, 330), 'Label Unification and', font=sub, fill=(150, 214, 206))
    draw.text((x, 378), 'Correspondence in 3D', font=sub, fill=(150, 214, 206))
    small = font(font_regular, 28)
    draw.text((x, 455), 'Multi-view pose annotation', font=small, fill=(150, 160, 166))
    draw.text((x, 491), 'in the browser', font=small, fill=(150, 160, 166))
    return img.convert('RGB')


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--source', default=os.path.join(ROOT, 'docs', 'assets', 'luc3d-logo.webp'))
    p.add_argument('--font', default=r'C:\Windows\Fonts\segoeui.ttf')
    p.add_argument('--font-bold', default=r'C:\Windows\Fonts\segoeuib.ttf')
    args = p.parse_args()

    logo = Image.open(args.source).convert('RGBA')
    tile = cut_tile(logo)
    bg = tile_background(tile)
    os.makedirs(OUT, exist_ok=True)

    def save(im, name):
        path = os.path.join(OUT, name)
        im.save(path, optimize=True)
        print('wrote', os.path.relpath(path, ROOT), im.size)

    for n in (16, 32):
        save(resize(tile, (n, n)), 'favicon-%d.png' % n)
    for n in (192, 512):
        save(resize(tile, (n, n)), 'icon-%d.png' % n)
    ico = os.path.join(OUT, 'favicon.ico')
    sizes = [resize(tile, (n, n)) for n in (48, 32, 16)]
    sizes[0].save(ico, format='ICO', sizes=[(n, n) for n in (48, 32, 16)], append_images=sizes[1:])
    print('wrote', os.path.relpath(ico, ROOT), '16/32/48')
    save(apple_touch(tile, bg), 'apple-touch-icon.png')
    save(og_image(logo, bg, args.font, args.font_bold), 'og-image.png')


if __name__ == '__main__':
    main()
