#!/usr/bin/env python3
"""
Fig 13e -- Fig 3c's grouping-accuracy box-and-whisker, redrawn with THICKER
strokes so the greedy/fresh-anchor box is actually visible.

Eric, 2026-08-20: "13 d greedy is really small and really hard to see, can we
make it a little more visible somehow? thicken the lines or something?" Greedy's
median sits at (or near) zero misgrouped frames, so its box collapses to a
sliver against exhaustive's -- a real result (greedy IS that much more
accurate), not a drawing bug, but at Fig 3c's original 0.9-1.8 pt strokes the
sliver reads as "nothing drawn" rather than "a box so thin it is basically a
line". Thickening every stroke (not just greedy's, so the two boxes stay a
matched pair) makes the sliver a visible, deliberate mark instead of an
apparent gap.

RATE IS PER 100,000 CLEAN FRAMES, not Fig 3c's own per 10,000 (Eric: "lets make
13d per 100,000 instead of 10,000? that way we can see both of the box and
whiskers maybe"). The axis is `symlog` with `linthresh=1` (see Fig 3c's own
comment on why symlog: most sessions are exactly zero, which a pure log axis
cannot place). Scaling every rate x10 does not just relabel the axis -- it
moves greedy's whole distribution out of the cramped LINEAR band near zero
(everything below the linthresh of 1) and into the LOG-scaled band above it,
where equal ratios get equal screen distance instead of being flattened
together. The same underlying data reads as more spread out, not just bigger
numbers.

FILLED BOXES WITH A WHITE MEDIAN LINE, Fig 13i's own style, not Fig 3c's
unfilled outline (Eric: "can we have the median or mean shown as a line across
the box and whisker plot in 13d? also use the same style as 13i"). A median
line the same colour as the box's own outline reads as part of the outline; a
white line cutting across a solid fill reads unambiguously as "this is the
median", which is exactly what `panels/fig13_01_per_session_small.py` already
does for its own boxes.

REUSES FIG 3c's OWN `build()` (imported as a module, not touched -- importing
only runs its top-level definitions; `main()` is guarded and never called, so
Fig 3's own panel and CSV are untouched) and its own pooling step (one box per
method, pooled across all animals x cameras configs -- see that script's own
"POOLED ACROSS animals x cameras" comment for why).

    python3 figs/panels/fig13_03_quality.py
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.colors import to_rgba

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import panel, save, text_legend, use  # noqa: E402
from fig3_sync import CELL_H, CELL_W, place_cell_axes  # noqa: E402
import panels.fig3_04_quality as fig3c  # noqa: E402


def main():
    # CELL SIZE AND 7 PT (2026-08-25 row-2 rebuild, Eric: "the d, e, f is way
    # too small ... lets make d,e,f more visible"): this panel is one cell of
    # the 2x2 block fig13_sync composes beside the idswitch illustration.
    # Native ~47 x 35 mm at 7 pt beats the previous 0.667-scaled copy (an
    # effective 5.3 pt); fig13_sync trues the built PDF to the exact cell.
    use(7.0)
    df, detail, methods, vdetail, session_rates = fig3c.build(as_shipped=False)

    # x10: fig3c.PER is 10,000, this panel is per 100,000 -- see docstring.
    scale = 100_000 / fig3c.PER
    pooled = {name: scale * np.concatenate([session_rates[(lab, name)]
                                           for lab in df.label.unique()
                                           if len(session_rates[(lab, name)])])
             for _, name, _ in methods}

    fig, ax = panel(CELL_W, CELL_H, key=len(methods))
    x = np.arange(len(methods))
    rng = np.random.default_rng(0)
    for i, (key, name, color) in enumerate(methods):
        v = pooled[name]
        if not len(v):
            continue
        ax.scatter(np.full(len(v), i) + rng.uniform(-0.16, 0.16, len(v)),
                  v, s=4, color=color, alpha=0.35, linewidths=0, zorder=1)
        # THICKER THROUGHOUT (Eric: "thicken the lines"), roughly 1.6x Fig 3c's
        # own 1.1/0.9/0.9 pt -- enough that greedy's near-zero box reads as a
        # deliberately thin mark rather than nothing, on both series equally so
        # they stay a matched pair. FILLED, with a WHITE median line (13i's
        # style -- see docstring), not a same-colour median on an unfilled box.
        ax.boxplot([v], positions=[i], widths=0.5, patch_artist=True,
                  showfliers=False, zorder=3, manage_ticks=False,
                  medianprops=dict(color="white", linewidth=2.0),
                  boxprops=dict(facecolor=to_rgba(color, 0.85), edgecolor=color,
                                linewidth=1.8),
                  whiskerprops=dict(color=color, linewidth=1.5),
                  capprops=dict(color=color, linewidth=1.5))

    # full 7 pt again: the 2026-08-25 width rebalance took the cell from
    # 36.1 to 47.25 mm, and "greedy, fresh anchor (shipped)" measures ~37 mm
    # at 7 pt, so it no longer has to be shrunk to fit.
    text_legend(ax, [(n, c) for _, n, c in methods], "above")
    ax.set_xticks(x)
    ax.set_xticklabels([""] * len(methods))
    ax.tick_params(axis="x", length=0)
    ax.set_xlim(-0.6, len(methods) - 0.4)
    ax.set_yscale("symlog", linthresh=1, linscale=0.6)
    top = max(400, float(max(v.max() for v in pooled.values() if len(v))) * 10 ** 0.25)
    ax.set_ylim(0, top)
    # AS MANY DECADES AS `top` NEEDS, not Fig 3c's single hardcoded "+1000" step
    # -- the x10 rescale pushes `top` past 1000 routinely, sometimes past 10000.
    decades = [0, 1, 10, 100, 1000, 10_000, 100_000]
    yticks = [d for d in decades if d == 0 or d <= top]
    ax.set_yticks(yticks)
    ax.set_yticklabels([f"{d:,}" for d in yticks])
    ax.set_ylabel("frames misgrouped vs GT\nper 100,000 clean frames")
    # shared cell x, so the four data cells line up as a grid -- see
    # fig13_sync.CELL_AXES_X.
    place_cell_axes(fig, ax, "quality_col")
    save(fig, 3, "e", "quality")


if __name__ == "__main__":
    main()
