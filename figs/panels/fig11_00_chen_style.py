#!/usr/bin/env python3
"""
Fig 11e -- the tracker's 2D and 3D anchor correspondence, drawn Chen-2020 style,
placed directly above the fresh-anchor parameter sweep it explains.

Eric, 2026-08-25: "fig11 should have [lucid_chen2020_style.png] in it and we need
to integrate it similarly to how we integrated the diagrams in fig13 ... I just
want to have the chen2020 diagram near the fresh anchor parameter sweep so we can
explain that clearly." The diagram shows the two association cost terms as one
scene from one real frame: the 2D term against a RETAINED 2D anchor in the image
(dashed outline -- the thing the stale window evicts), and the 3D term as the
detection's back-projected ray against the 3D anchor node. The sweep row below
(fig11f, Fig 8d) varies exactly how stale that retained anchor may grow, so the
two panels are one argument: what the anchor is, then what its age costs.

Integration follows fig13's pattern exactly (`fig13_00_hyp_illustration.py`):
the source PNG is DRAWN elsewhere -- `blender-images/fig_chen_correspondence.py`
(bpyenv render) -> `figs/fig_chen2020_style.py` (this repo's compositor, which
writes `figures/drafts/figs/lucid_chen2020_style.png`; since 2026-08-25 without
internal "(a)/(b)" sub-letters, which would clash with this figure's own panel
letters) -- and this script only crops its white margin and drops it into a
panel PDF on the house grid, reusing fig13's `content_crop`.

WIDTH IS THE FIGURE'S ARITHMETIC, NOT A CHOICE, and since the same-day re-cut
("make a square on the left out of a,b,c,d ... then make the diagram big on the
right" -- Eric, 2026-08-25) the diagram spans BOTH rows of the 2x2 a-d block
beside it: with the crop's measured aspect A = 1.609, CHEN_W_MM = 91.43 is the
solution of the equal-heights equation in fig11_sync.BLOCK_W's comment (block
and diagram both 56.8 mm tall, the page exactly full). The crop aspect is
re-measured at build time and the build FAILS LOUDLY if it has drifted from the
solved value -- a silent drift would quietly reopen the whitespace this
geometry exists to close; re-solve and update both constants instead.

    python3 figs/panels/fig11_00_chen_style.py
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import mm, save, use  # noqa: E402
from fig13_00_hyp_illustration import content_crop  # noqa: E402

SRC = (Path(__file__).resolve().parent.parent / "figures" / "drafts" / "figs"
       / "lucid_chen2020_style.png")

#: solved width (see WIDTH IS THE FIGURE'S ARITHMETIC) and the crop aspect that
#: solution assumed -- keep all three of CHEN_W_MM / SOLVED_ASPECT /
#: fig11_sync.BLOCK_W moving together.
#: RE-SOLVED twice on 2026-08-25 as the diagram's type moved: bigger labels
#: widened the crop (1.609 -> 1.723), then stacking the two anchor labels
#: ("2D Anchor" over "Node (x_t'')", centred) narrowed it again (-> 1.620;
#: block 84.26, this panel 91.74, shared height 56.63).
CHEN_W_MM = 91.74
SOLVED_ASPECT = 1.620


def main():
    use()
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run figs/fig_chen2020_style.py first")
    a = mpimg.imread(SRC)
    x0, y0, x1, y1 = content_crop(a)
    crop = a[y0:y1, x0:x1]
    aspect = crop.shape[1] / crop.shape[0]
    if abs(aspect - SOLVED_ASPECT) > 0.02:
        sys.exit(f"chen2020 crop aspect {aspect:.3f} drifted from the solved "
                 f"{SOLVED_ASPECT} — re-solve the fig11 block/diagram geometry "
                 "(fig11_sync.BLOCK_W's comment) and update the constants")

    w_mm = CHEN_W_MM
    h_mm = w_mm / aspect
    print(f"  chen2020 crop ({x0}, {y0}, {x1}, {y1}), aspect {aspect:.3f} -> "
          f"{w_mm:.2f} x {h_mm:.2f} mm")

    fig, ax = plt.subplots(figsize=(mm(w_mm), mm(h_mm)), layout="constrained")
    ax.imshow(crop)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    save(fig, 11, "e", "chen_style")


if __name__ == "__main__":
    main()
