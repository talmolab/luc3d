#!/usr/bin/env python
"""Assemble the SLAP-2M difficulty figure from enrichment_scene tiles.

Eric's original draft layout (cage_renders / difficulty.png): # OF ANIMALS ON
X (1..4), ENVIRONMENTAL ENRICHMENT ON Y (rows 0, 2, 5 bottom-to-top), with the
upper-right cells simply ABSENT — the dataset has no 3-4-animal enriched
sessions (except (3,4), deliberately not placed, as in the draft), and the
staircase silhouette reads better than a lattice of n/a cells. 10 tiles.

The tiles share one camera (enrichment_scene --fit cage), so they are all
cropped identically by the union of their content boxes.

  bpyenv/bin/python enrichment_grid.py           # -> renders/enrichment_grid.png
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
RENDERS = os.path.join(HERE, "renders")
ENRICH_ROWS = [5, 2, 0]         # y axis, top row first (difficulty grows upward)
ANIMAL_COLS = [1, 2, 3, 4]      # x axis
#: the cells the figure places — the draft's 3x4 with the top-right four empty
CELLS = {(0, a) for a in ANIMAL_COLS} | {(2, 1), (2, 2), (5, 1), (5, 2)}
PAD = 26                        # px between tiles (at tile scale)
TILE_W = 560                    # resized tile width
LABEL = 92                      # gutter for the axis labels


def content_bbox(im, bg=(255, 255, 255), tol=12):
    diff = ImageChops.difference(im.convert("RGB"), Image.new("RGB", im.size, bg))
    return diff.convert("L").point(lambda p: 255 if p > tol else 0).getbbox()


def main():
    raw = {(o, a): Image.open(os.path.join(RENDERS, f"enrich_a{a}_o{o}.png"))
           for (o, a) in CELLS}
    boxes = [content_bbox(im) for im in raw.values()]
    x0 = min(b[0] for b in boxes) - 12
    y0 = min(b[1] for b in boxes) - 12
    x1 = max(b[2] for b in boxes) + 12
    y1 = max(b[3] for b in boxes) + 12
    tiles = {}
    for key, im in raw.items():
        im = im.crop((max(0, x0), max(0, y0), min(im.width, x1), min(im.height, y1)))
        s = TILE_W / im.width
        tiles[key] = im.resize((TILE_W, round(im.height * s)), Image.LANCZOS)
    tile_h = max(t.height for t in tiles.values())
    W = LABEL + len(ANIMAL_COLS) * (TILE_W + PAD) + PAD
    H = LABEL + len(ENRICH_ROWS) * (tile_h + PAD) + PAD
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
        axis = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 38)
    except OSError:
        font = axis = ImageFont.load_default()
    for i, o in enumerate(ENRICH_ROWS):
        y = PAD + i * (tile_h + PAD)
        for j, a in enumerate(ANIMAL_COLS):
            t = tiles.get((o, a))
            if t is None:
                continue
            x = LABEL + PAD + j * (TILE_W + PAD)
            sheet.paste(t, (x, y + (tile_h - t.height) // 2))
        draw.text((LABEL - 30, y + tile_h // 2 - 18), str(o),
                  fill=(40, 40, 40), font=font, anchor="ma")
    for j, a in enumerate(ANIMAL_COLS):
        x = LABEL + PAD + j * (TILE_W + PAD) + TILE_W // 2
        draw.text((x, H - LABEL + 10), str(a), fill=(40, 40, 40), font=font, anchor="ma")
    # axis titles: x along the bottom, y rotated up the left edge
    draw.text((LABEL + (W - LABEL) // 2, H - 44), "# of animals",
              fill=(40, 40, 40), font=axis, anchor="mm")
    ylab = Image.new("RGB", (H - LABEL, 52), (255, 255, 255))
    ImageDraw.Draw(ylab).text(((H - LABEL) // 2, 26), "environmental enrichment",
                              fill=(40, 40, 40), font=axis, anchor="mm")
    sheet.paste(ylab.rotate(90, expand=True), (0, 0))
    out = os.path.join(RENDERS, "enrichment_grid.png")
    sheet.save(out)
    print("wrote", out, sheet.size)


if __name__ == "__main__":
    main()
