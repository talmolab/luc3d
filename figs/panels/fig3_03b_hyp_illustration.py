#!/usr/bin/env python3
"""
Fig 3c -- what a cross-view grouping HYPOTHESIS actually is, next to b's count
of them.

b (`fig3_03_cost_model.py`) plots how many hypotheses exhaustive association
considers per frame -- a number, (A!)^C. It never shows what one hypothesis
IS. This panel is the Blender/matplotlib render built in
`blender-images/hyp_fig_scene.py` + `hyp_fig_style.py` (real 3-animal SLAP-2M
session 2022-10-07/10072022142111, frame 11586, real "side"+"top" cameras):
one 3D floor, two real camera views with real photos and instance overlays
for 3 animals, all 3x3 candidate cross-view pairings drawn as thin grey
lines, and the 3 CORRECT pairings singled out in colour as a closed triangle
(image point -> real 3D centroid -> image point). Sitting beside b, it turns
"(A!)^C hypotheses" into "here is one hypothesis, and here is why the other
eight are wrong."

PROMOTED FROM FIG 13. The identical illustration has been Fig 13's panel c
since 2026-08-20 (`panels/fig13_00_hyp_illustration.py`, whose docstring
carries the three-pass sizing history); Fig 3 itself was left untouched then.
On 2026-08-25, after the distortion correction, the frame re-picks (6707 ->
11724 -> 11586, see blender-images/hyp_common.py) and the blue/orange swap,
Eric: "ok so then integrate this into fig3 as a pdf" -- so the illustration
becomes Fig 3's own panel c, placed beside b on row 1, and the old c/d/e
(quality/sweep/head-to-head) re-letter to d/e/f (see LAYOUTS[3] in
assemble.py).

Same sizing rule as the Fig 13 twin: std row height, width from the crop's
own aspect ratio.

SOURCE IMAGE is drawn, not measured here: regenerate it from
`blender-images/hyp_fig_prep.py` -> `blender-images/hyp_fig_scene.py`
(bpyenv) -> `figs/hyp_fig_style.py` (this repo's own compositor), which
writes `figures/drafts/figs/lucid_hyp_style_sidetop.png`. This script only
crops its thin white margin and drops it into a panel PDF on the house grid.

    python3 figs/panels/fig3_03b_hyp_illustration.py
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import ROW_H, mm, save, use  # noqa: E402
from fig13_00_hyp_illustration import SRC, content_crop  # noqa: E402


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
