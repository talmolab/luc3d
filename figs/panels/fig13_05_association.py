#!/usr/bin/env python3
"""
Fig 13a's "top" half (the exhaustive/greedy association schematic), RECOLOURED
so its per-animal marks match 13c's animal colours (Eric: "the colors in 13a
for Exhaustive hypothesis testing should be the same colors as the id lines in
13c as well").

Fig 3a (`fig3_01_association.py`) colours its three animal paths/dots with
`identity(0)`, `identity(4)`, `identity(5)` -- the app's own screen-primary
identity palette, print-darkened. 13c (`blender-images/hyp_fig_style.py`) draws
its three animals in `hyp_common.TAB10_3` (`#1F77B4`/`#FF7F0E`/`#2CA02C`,
matplotlib's own tab10 blue/orange/green) -- a DIFFERENT palette family, so the
"same three animals, same colours" the two panels sit side by side implying was
not actually true.

REUSES FIG 3a's OWN DRAWING CODE (`draw_exhaustive`, `draw_greedy`, imported as
a module -- not touched; `main()` is guarded and never called, so Fig 3's own
panel is untouched) via a MONKEYPATCH: both functions call the module-global
name `identity`, resolved at call time, so replacing
`fig3_01_association.identity` with a small lookup into TAB10_3 (keyed on the
SAME indices, 0/4/5, the drawing code already passes it) recolours every mark
those functions draw without duplicating their ~100 lines of layout code.
Recolours BOTH halves (exhaustive's paths AND greedy's dots use the same three
identity indices), not just the exhaustive one named in the request -- leaving
greedy on the old palette would have made the two halves of ONE panel disagree
with each other about what colour animal 0 is.

Writes to figures/fig13/_association_top.pdf -- an INTERMEDIATE, not a real
deposited panel (hence the leading underscore, matching the house's `_diag`/
`_bench` convention for non-deliverable files). fig13_sync.build_stack reads it
as the "top" half of the a/b stack instead of Fig 3a's own PDF, then overwrites
figures/fig13/fig13a_association.pdf with the merged a+b composite -- run this
script BEFORE fig13_sync.py.

    python3 figs/panels/fig13_05_association.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import grid, use  # noqa: E402
import panels.fig3_01_association as fig3a  # noqa: E402

FIGS = Path(__file__).resolve().parent.parent
OUT = FIGS / "figures" / "fig13" / "_association_top.pdf"

#: 13c's own tab10 blue/orange/green (`blender-images/hyp_common.py`'s
#: TAB10_3), keyed on the SAME identity indices fig3_01_association.py already
#: passes (`ID_IDX = [0, 4, 5]`) so the monkeypatch below needs no change to
#: the drawing code's own calls.
TAB10_3 = ["#1F77B4", "#FF7F0E", "#2CA02C"]
RECOLOR = {0: TAB10_3[0], 4: TAB10_3[1], 5: TAB10_3[2]}


def main():
    use()
    fig3a.identity = lambda i, print_safe=True: RECOLOR[i]

    fig, axes = grid(2, 1, span="half", row=2 * fig3a.ROW_MM, despine=False)
    fig.get_layout_engine().set(h_pad=fig3a.HPAD_MM / 25.4)
    fig3a.draw_exhaustive(axes[0])
    fig3a.draw_greedy(axes[1])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=600)
    print(f"  wrote {OUT.relative_to(FIGS)}")


if __name__ == "__main__":
    main()
