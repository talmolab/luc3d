#!/usr/bin/env python3
"""
Fig 13d -- the identity-switch illustration (HardFight variant), added on
instruction (Eric, 2026-08-25: "we need to cram this into figure 13 as well").
Lettered g, then h, then d over that day's two row-2 passes (Eric: "g should
have similar width to c ... will make sense to renumber them as well", then
"h should be on the left side and d, e, f, g should be on the right side, and
re number accordingly") -- it now OPENS row 2 on the left, ahead of the 2x2
data block e-h; see fig3_sync.py's row-2 geometry comment for its width.

The source render is the staged 3D scene built by
`blender-images/idswitch_fig_prep.py` -> `idswitch_fig_scene.py` (bpyenv) ->
`figs/idswitch_fig_style.py` (IDSWITCH_DATASET defaults to hardfight), which
writes `figures/drafts/figs/lucid_idswitch_style_hardfight.png`: two real
HardFight camera panes at frame 21144 (sideL "side", mid "top"), the top
pane's overlay colours swapped with two large white curved arrows marking the
exchange, the side pane correct, the two animals' 3D instances at that one
frame on the floor, and a closed association TRIANGLE per animal (3D, side
detection, top detection) whose legs into the switched pane run a colour
gradient between the two identities. The comet trails that used to fill the
floor are off (idswitch_common.SHOW_TRAILS). This script only crops the
render's white margin and drops it
into a panel PDF on the house grid -- same treatment as 13c
(`fig13_00_hyp_illustration.py`, whose crop helper it reuses).

    python3 figs/panels/fig13_06_idswitch.py
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import mm, save, use  # noqa: E402
from fig3_10_hyp_illustration import content_crop  # noqa: E402

SRC = (Path(__file__).resolve().parent.parent / "figures" / "drafts" / "figs"
       / "lucid_idswitch_style_hardfight.png")

#: panel height in mm -- sized like 13c (the other staged-3D illustration,
#: ~100 mm) rather than the 52 mm data-panel rows: the pane photos and the
#: swap arrows are the content, and they need the size to read.
H_MM = 90.0


def main():
    use()
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run blender-images/idswitch_fig_prep.py + "
                  f"idswitch_fig_scene.py + figs/idswitch_fig_style.py first")
    a = mpimg.imread(SRC)
    x0, y0, x1, y1 = content_crop(a)
    print(f"  idswitch illustration: {SRC.name} crop ({x0}, {y0}, {x1}, {y1})")
    crop = a[y0:y1, x0:x1]

    w = H_MM * (crop.shape[1] / crop.shape[0])
    fig, ax = plt.subplots(figsize=(mm(w), mm(H_MM)), layout="constrained")
    ax.imshow(crop)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    save(fig, 3, "d", "idswitch")


if __name__ == "__main__":
    main()
