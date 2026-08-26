#!/usr/bin/env python3
"""
Fig 13c -- what a cross-view grouping HYPOTHESIS actually is, next to 13b's count
of them.

13b (`fig3_03_cost_model.py`, reused verbatim as Fig 3's own "b") plots how many
hypotheses exhaustive association considers per frame -- a number, (A!)^C. It
never shows what one hypothesis IS. This panel is the Blender/matplotlib render
built in `blender-images/hyp_fig_scene.py` + `hyp_fig_style.py` (real 3-animal
SLAP-2M session 2022-10-07/10072022142111, frame 6707, real "side"+"top" cameras):
one 3D floor, two real camera views with real photos and instance overlays for
3 animals, all 3x3 candidate cross-view pairings drawn as thin grey lines, and the
3 CORRECT pairings singled out in colour as a closed triangle (image point -> real
3D centroid -> image point). Sitting beside 13b, it turns "(A!)^C hypotheses" into
"here is one hypothesis, and here is why the other eight are wrong."

Placed right after b on instruction (Eric, 2026-08-20: "add
[lucid_hyp_style_sidetop.png] to figure 3 in relation to b"). Fig 3 itself is
UNTOUCHED -- this lives only on Fig 13, the combined Fig-3+Fig-4 draft assembled
by `figs/fig3_sync.py` (see LAYOUTS[13] in assemble.py).

THIRD PASS AT THIS PANEL'S SIZE, and this one gives up on making it big.
Attempt 1 put it beside a/b at third span (Eric: "there is a lot of white space
under a and b ... extend them downwards" -- the row's height was set by this
panel and stranded a/b's shrunken content above dead space). Attempt 2 gave it
the whole page width alone (Eric: "there should be no white space on either side
of the c ... we need it all to stack" -- true, but at 180 mm tall it made the
figure enormous and was still, on its own admission, "too big"; Eric: "we must
use the real estate efficiently"). Both attempts treated this panel as
special -- entitled to a size on its own terms -- which is exactly what kept
producing a mismatched row.

THIS PASS SIZES IT LIKE EVERY OTHER SUPPORTING PANEL: std row height (52 mm),
the same height d, e, f, g, h, i, j already use, so it can share a fully-packed
row instead of anchoring one alone. Width follows from the crop's own aspect
ratio (not hardcoded, so a re-crop keeps this panel filling its box exactly --
same principle `fig1_00_render.py` uses for its two tiles), which happens to
come out near-square (~51 mm) -- see LAYOUTS[13] row 2 (c, d, e: 51 + 57.3 +
57.3 + 8 mm gutters = 173.6 of 180 mm, no dead space). It reads smaller than the
standalone versions of this figure, which is the real trade-off of packing it
at the same scale as a bar chart -- accepted so the row costs no wasted page.

SOURCE IMAGE is drawn, not measured here: regenerate it from
`blender-images/hyp_fig_prep.py` -> `blender-images/hyp_fig_scene.py`
(bpyenv) -> `figs/hyp_fig_style.py` (this repo's own compositor), which writes
`figures/drafts/figs/lucid_hyp_style_sidetop.png`. This script only crops its
thin white margin and drops it into a panel PDF on the house grid.

    python3 figs/panels/fig13_00_hyp_illustration.py
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import ROW_H, mm, save, use  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "figures" / "drafts" / "figs" / "lucid_hyp_style_sidetop.png"

#: px of white margin kept around the measured content, and the "is it white"
#: threshold. The render's own background is flat white (not a gradient, unlike
#: the Blender cage renders in fig1_00_render.py), so a plain luminance test is
#: enough -- no gradient/saturation mask needed.
CROP_PAD = 20
WHITE_TH = 0.98


def content_crop(a, pad=CROP_PAD):
    L = a[:, :, :3].mean(2)
    mask = L < WHITE_TH
    ys, xs = np.where(mask)
    if not len(xs) or not len(ys):
        sys.exit("content_crop found no content — is the render empty?")
    h, w = L.shape
    return (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
            min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad))


def main():
    use()
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run blender-images/hyp_fig_prep.py + "
                  f"hyp_fig_scene.py + figs/hyp_fig_style.py first")
    a = mpimg.imread(SRC)
    x0, y0, x1, y1 = content_crop(a)
    print(f"  hyp illustration: {SRC.name} crop ({x0}, {y0}, {x1}, {y1})")
    crop = a[y0:y1, x0:x1]

    h = ROW_H["std"]
    w = h * (crop.shape[1] / crop.shape[0])   # width follows the crop's own aspect
    fig, ax = plt.subplots(figsize=(mm(w), mm(h)), layout="constrained")
    ax.imshow(crop)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    save(fig, 3, "c", "hyp_illustration")


if __name__ == "__main__":
    main()
