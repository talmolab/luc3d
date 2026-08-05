#!/usr/bin/env python3
"""
Fig 5d -- the same comparison per session, at a 10% review budget.

Panel c's curves are means over sessions. This is the check that the mean is not
hiding a corpus in which the residual only wins on average: one point per session,
correction found by ranking on the cross-view residual against correction found by
ranking on detector confidence.

EVERY POINT ABOVE THE DIAGONAL IS A SESSION WHERE THE RESIDUAL WINS. The panel
prints how many, so "the residual is the better signal" is a count and not an
impression.

WHAT 74/74 IS AND IS NOT. It is a consistency check on panel c's mean, and it is not
the figure's result. The comparator is nearly the null: reviewing 10% of keypoints at
random finds 10% of the correction, and ranking by detector confidence finds 11.7% --
so the whole x axis of this panel lives within a couple of points of "do not rank at
all", which is why the 10% line is DRAWN. Sweeping a near-null 74 times out of 74 is
a statement about detector confidence, not about how good triage is; the number that
says how good triage is, is panel c's oracle ratio (27/32 = 85% of the achievable
capture). Read this panel as "the mean in c is not carried by a handful of sessions".

THE AXES ARE CLIPPED TO THE DATA, not squared off at a round 45. The confidence
values span 9.2-16.6% and the residual values 21.4-44.5%, so equal 0-45 axes spent
about eight ninths of the panel on empty paper and shrank the only interesting
structure -- the vertical spread of the cloud -- to a smudge. The `equal` diagonal
survives the clip: it runs from the origin to the top of the x range in the lower
left, which is all it needs to establish which side of it the cloud is on, and it is
labelled along its own slope (computed from the transform, since the axes are no
longer isometric and a hand-set rotation would be wrong).

CONDITIONS ON CORRECT ASSOCIATION, like panel c: the deposit's `caveats` say the
triage analysis "takes cross-view identity from that reference match, i.e. it assumes
association is already correct", so every point here presupposes Fig 3's problem is
solved. Stated under the axis.

Source: figs/out/fig6_detections.json `sessions[].capture_by_{reproj,lowconf}`.

    python3 figs/panels/fig5_04_per_session.py
"""
import sys
from math import atan2, degrees
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, INK, deposit, entity, footnote, panel,  # noqa: E402
                       save, use)

BUDGET = "0.1"


def main():
    use()
    sess = load("fig6_detections.json")["sessions"]
    rows = [{"session": s["session"],
             "by_residual_pct": s["capture_by_reproj"][BUDGET] * 100,
             "by_confidence_pct": s["capture_by_lowconf"][BUDGET] * 100}
            for s in sess
            if BUDGET in s.get("capture_by_reproj", {})
            and BUDGET in s.get("capture_by_lowconf", {})]
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5d_per_session.csv")

    wins = int((df.by_residual_pct > df.by_confidence_pct).sum())
    # ONE LIMIT PER AXIS, each from its own data, which is the whole point of the
    # clip. `hi_x` is ~19 and `hi_y` ~50, i.e. the legacy panel's 0-20 x 0-50.
    hi_x = df.by_confidence_pct.max() * 1.12
    hi_y = df.by_residual_pct.max() * 1.12
    diag = min(hi_x, hi_y)   # the diagonal exists only where both axes reach

    fig, ax = panel("half", "std")
    ax.plot([0, diag], [0, diag], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)

    # THE NULL, drawn because this panel's x axis is a near-null and a reader cannot
    # see that from the numbers alone: at a 10% budget, reviewing at random finds 10%,
    # so every session's confidence ranking lands within a few points of this rule
    # while its residual ranking is 2-4x above it. Vertical only: the y axis is 21-45
    # and nowhere near the null, so a matching horizontal rule would carry no
    # information and would cross the cloud.
    null = float(BUDGET) * 100
    ax.axvline(null, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # Left of the rule and above the cloud: the cloud starts at x = 9.2, and the one
    # session that reaches y = 44.5 sits at x = 12.5, so this corner is empty.
    ax.text(null - 0.35, hi_y * 0.985, "random = 10%", color=MUTED, fontsize=6.5,
            ha="right", va="top")

    ax.plot(df.by_confidence_pct, df.by_residual_pct, "o", color=entity("residual"),
            ms=3.5, alpha=0.85, zorder=3)

    ax.set_xlabel("found by confidence (%)")
    ax.set_ylabel("found by residual (%)")
    ax.set_xlim(0, hi_x)
    ax.set_ylim(0, hi_y)
    # LOWER RIGHT, which is the one corner that cannot collide: the residual wins
    # in every session, so there is no point below the diagonal. In the upper left
    # the block sat on the highest-scoring session's marker.
    ax.text(0.98, 0.04, f"n = {len(df)}\nresidual wins in {wins}/{len(df)}",
            transform=ax.transAxes, ha="right", va="bottom", color=INK,
            fontsize=6.5, fontweight="bold")
    footnote(ax, "assumes association is already correct (Fig 3)")

    # THE DIAGONAL'S LABEL, rotated to the diagonal AS DRAWN. The axes are no longer
    # isometric -- x spans ~19 units and y ~50 over a box that is wider than it is
    # tall -- so y = x is a shallow line and a hand-set rotation (38 degrees, from
    # when both axes ran 0-45) would sit at the wrong angle. Draw once so
    # constrained_layout has fixed the axes box, then read the slope off transData.
    # Everything that changes the layout (labels, footnote) is set above this point.
    fig.draw_without_rendering()
    (px0, py0), (px1, py1) = ax.transData.transform([(0, 0), (diag, diag)])
    ang = atan2(py1 - py0, px1 - px0)
    # Offset PERPENDICULAR to the line, in points, not "va=bottom on the line": a text
    # box sits lower than its baseline by its descender, so anchoring on the stroke
    # leaves the stroke inside the box (the linter measured 7% of it inked). 4 pt along
    # the normal clears it at any rotation.
    ax.annotate("equal", (diag * 0.62, diag * 0.62), textcoords="offset points",
                xytext=(-4 * np.sin(ang), 4 * np.cos(ang)), color=MUTED, fontsize=6.5,
                rotation=degrees(ang), rotation_mode="anchor", ha="center",
                va="bottom")

    save(fig, 5, "d", "per_session")


if __name__ == "__main__":
    main()
