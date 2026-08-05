#!/usr/bin/env python3
"""
Fig 5c -- how much real correction a bounded review budget finds.

THE RESULT IS THE ORACLE RATIO: at a 10% review budget the cross-view residual finds
27% of the total correction against the best possible 32%, i.e. **85% of what is
achievable from any ordering at all**, from a signal that needs no ground truth. That
ratio is the headline and it is printed on the panel. What is NOT the headline is
"residual beats detector confidence": confidence captures 11.7% where reviewing at
random captures 10.0%, so it is a whisker above the null, and beating it is a weak
statement dressed up as a comparison. The ceiling is the honest denominator, because
it is the one that bounds what any triage signal could deliver on this corpus.

THE X AXIS IS REVIEW BUDGET, not difficulty. An earlier version of this panel
plotted capture against session difficulty, which answers a different (and much less
useful) question: the reader wants to know what they get for reviewing 10% of
keypoints, and that is what the deposited curves measure.

THE CIRCULARITY THIS PANEL AVOIDS, stated up front because it is the whole design.
Ranking keypoints by reprojection error and then reporting captured REPROJECTION
error would be circular -- ranking and payload would be the same quantity. So the
payload is the REAL correction distance (how far the raw detection sits from the
proofread answer, which requires the answer), while the ranking uses only the
cross-view residual (which does not).

AND HERE IS HOW FAR THAT GETS YOU, WHICH IS THE NUMBER THE PANEL USED TO HIDE. The
two quantities are not independent: both involve the proofread 3D reprojected into
each camera, so the residual is correlated with the correction it is being scored
against. The measurement pass deposits exactly that correlation --
`sessions[].spearman`, rho(ranking signal, payload) -- and it is **0.69, ranging
0.53-0.81 across the 74 sessions** (0.667-0.735 if you aggregate by difficulty
stratum first, which is the same thing with the within-stratum spread averaged out).
That correlation IS the mechanism by which the residual recovers 85% of the oracle's
capture, and a reader cannot judge how much of the panel is circular without it. It
is now on the artwork. Note what it does not do: it does not make the panel circular,
because rho < 1 means the payload carries information the ranking signal does not,
and the payload still requires the proofread answer while the ranking does not. It
does mean the 85% should be read as "the residual is a good proxy for the correction
on this corpus", not as "triage is nearly free".

WHAT THIS PANEL CONDITIONS ON, from the deposit's own `caveats`: "The triage analysis
takes cross-view identity from that reference match, i.e. it assumes association is
already correct." So c and d assume Fig 3's problem has been solved perfectly -- a
mis-associated detection is not in this ranking's world at all. The footnote says so.
The reference is also the proofread 3D reprojected into each camera, so it carries
its own reconstruction error.

Four orderings:
  * cross-view residual -- what LUC3D can compute at review time, no answer key;
  * detector confidence -- also available at review time, and barely above random,
                          which is the finding about confidence rather than a foil
                          for the residual;
  * oracle             -- ranks by the answer itself, so it is the CEILING, not a
                          method anyone could run. Drawn in `entity('oracle')` grey
                          because it is a BOUND, not a method (its key entry and its
                          value label are MUTED: grey is legible as a rule and not
                          as type);
  * random             -- the diagonal: reviewing x% at random finds x%.

ALL FOUR VALUES AT THE 10% RULE ARE PRINTED, random included. Random's 10 is what makes
the comparison land: reviewing 10% at random finds 10%, so detector confidence's 12 is
barely better than not ranking at all, while the residual's 27 is 2.7x random and 85%
of the oracle's 32. With the 10 left off the page the reader has to derive the baseline
from the diagonal before the confidence curve's weakness is visible -- and the legacy
panel printed it.

MIND THE KEY NAME. `fig6_detections.json` is read by BOTH Fig 5 and Fig 6, so its
schema is additive-only; a mismatch in exactly this file (`capture_oracle` vs
`capture_by_oracle`) silently dropped this panel's oracle series once already.

Source: figs/out/fig6_detections.json `sessions[].capture_by_*`, `sessions[].spearman`.

    python3 figs/panels/fig5_03_capture.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, entity, footnote, GREY, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: THE RANKING SIGNALS ARE ENTITIES, so their hues come from `entity()` rather than
#: being picked here: the residual is this work's own signal (teal, as everywhere
#: else), confidence is the named alternative (periwinkle), and the oracle is a BOUND
#: -- grey, the same ink the random diagonal takes, because "you cannot do better
#: than this" and "you get this for free" are the same kind of thing. The oracle was
#: salmon, which is `entity('dlt')`: with Fig 4's solvers now on the entity scheme,
#: salmon means DLT on the facing page, so a salmon oracle here would be the exact
#: hue collision the scheme exists to remove.
#:
#: `ink` is the TEXT colour for the series' key entry and value label. It differs from
#: the mark colour only for the oracle: GREY is 2.1:1 on white, fine for a 2 pt dashed
#: rule and not fine for type.
SERIES = [("capture_by_reproj", "cross-view residual", entity("residual"), None),
          ("capture_by_lowconf", "detector confidence", entity("confidence"), None),
          ("capture_by_oracle", "oracle (ceiling)", entity("oracle"), MUTED)]
MARK = "0.1"

#: Where each series' value-at-MARK label goes, as (dx, dy) in points plus the
#: vertical and horizontal anchors. Hand-set per series and NOT symmetric on purpose:
#: the three curves pass within ~5 percentage points of each other at the 10% budget,
#: so a single offset rule puts at least one label on a neighbouring curve. Residual
#: labels DOWN into the gap above the confidence curve; the other two label UP.
#:
#: CONFIDENCE LABELS ON THE OTHER SIDE OF THE RULE, and that is not decoration. The
#: residual's 27 and confidence's 12 are 19 pt apart on this axis, and two 7 pt labels
#: offset 4-5 pt from their own points need 24 -- so the moment the footnote grew a
#: second line and constrained_layout gave the axes ~2 mm less height, the two
#: collided (the linter measured 45% of '12' under '27'). Nudging both offsets towards
#: their curves fixes it with ~1.6 pt to spare, which the next line of text would eat
#: again. Putting one label left of the rule and the others right of it makes the two
#: boxes unable to interact at any panel height, and each still sits at its own
#: curve's level, so attribution does not depend on which side it is on.
LABEL_OFF = {"capture_by_reproj": (5, -4, "top", "left"),
             "capture_by_lowconf": (-5, 4, "bottom", "right"),
             "capture_by_oracle": (5, 6, "bottom", "left")}


def main():
    use()
    sess = load("fig6_detections.json")["sessions"]
    have = [s for s in sess if all(k in s for k, _, _, _ in SERIES)]
    if not have:
        sys.exit("fig6_detections.json has no capture_by_* curves — the schema moved.")

    budgets = sorted(have[0][SERIES[0][0]], key=float)
    rows = []
    for key, label, _, _ in SERIES:
        for b in budgets:
            vals = [s[key][b] for s in have if b in s[key]]
            rows.append({"ranking": label, "budget_pct": float(b) * 100,
                         "captured_pct": float(np.mean(vals)) * 100,
                         "n_sessions": len(vals)})
    df = pd.DataFrame(rows)
    deposit(df, 5, "fig5c_capture.csv")

    # THE TWO NUMBERS THE PANEL IS JUDGED BY, computed here rather than typed in.
    # `at()` is the mean-over-sessions value at the 10% mark, straight out of the same
    # frame the curves are drawn from, so the printed ratio cannot drift from the
    # plotted points; `rho` is the deposited rank correlation between the ranking
    # signal and the payload, over exactly the sessions this panel averages.
    def at(key):
        lab = next(l for k, l, _, _ in SERIES if k == key)
        g = df[df.ranking == lab]
        return float(g.loc[g.budget_pct == float(MARK) * 100, "captured_pct"].iloc[0])

    ratio = at("capture_by_reproj") / at("capture_by_oracle")
    rhos = [s["spearman"] for s in have if s.get("spearman") is not None]

    fig, ax = panel("half", "std", key=3)
    xs = [float(b) * 100 for b in budgets]
    ax.plot([0, max(xs)], [0, max(xs)], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)),
            zorder=1)
    # BELOW the diagonal and unrotated. Set along the line it names it printed on
    # top of it, and a rotated span's bounding box is far taller than the glyphs,
    # so nudging it while keeping the rotation does not clear the stroke. Nothing
    # else is ever drawn under the diagonal here -- every ranking beats random.
    ax.text(max(xs) * 0.995, max(xs) * 0.60, "random", color=MUTED, fontsize=6.5,
            ha="right", va="top")

    for key, label, color, ink in SERIES:
        g = df[df.ranking == label].sort_values("budget_pct")
        ax.plot(g.budget_pct, g.captured_pct, color=color, lw=2.0,
                ls=(0, (2.5, 1.5)) if "oracle" in label else "-", zorder=3)
        ax.plot(g.budget_pct, g.captured_pct, "o", color=color, ms=4, mec="white",
                mew=0.8, zorder=4)
        v = g.loc[g.budget_pct == float(MARK) * 100, "captured_pct"].iloc[0]
        dx, dy, va, ha = LABEL_OFF[key]
        ax.annotate(f"{v:.0f}", (float(MARK) * 100, v), textcoords="offset points",
                    xytext=(dx, dy), color=ink or color, fontsize=6.5,
                    fontweight="bold", ha=ha, va=va)

    # THE RANDOM BASELINE'S VALUE, in the same style as the three series'. Random has
    # no deposited curve -- it IS the diagonal, y = x -- so the number comes from the
    # budget itself rather than from `df`. Placed BELOW-right of (10, 10): the diagonal
    # rises to the right, so a label anchored va="top" 5 pt under the point clears both
    # the dashed rule and the confidence curve above it, and the four values then read
    # top-to-bottom 32 / 27 / 12 / 10 in curve order.
    ax.annotate(f"{float(MARK) * 100:.0f}",
                (float(MARK) * 100, float(MARK) * 100), textcoords="offset points",
                xytext=(5, -5), color=MUTED, fontsize=6.5, fontweight="bold",
                ha="left", va="top")
    ax.axvline(float(MARK) * 100, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.annotate("10% budget", (float(MARK) * 100, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=MUTED, fontsize=6.5,
                ha="center", va="bottom")
    text_legend(ax, [(lab, ink or c) for _, lab, c, ink in SERIES], "above")
    ax.set_xlabel("keypoints reviewed, worst first (%)")
    ax.set_ylabel("correction found (%)")
    ax.set_xlim(0, max(xs))
    # Explicit, and ~12% above the top datum rather than matplotlib's ~5%: the rho
    # block below needs headroom above the oracle curve, and it is placed off the top
    # limit, so pinning the limit is what keeps the two apart as the data changes.
    ax.set_ylim(0, df.captured_pct.max() * 1.12)

    # THE HEADLINE, IN THE WEDGE BETWEEN THE RESIDUAL AND CONFIDENCE CURVES. Past the
    # 10% mark those two curves diverge (27->41 against 12->22), leaving the widest
    # empty region on the panel, and the ratio belongs next to the two numbers it is
    # computed from rather than in a corner. Teal because it is a statement about the
    # residual; "ceiling" is the word the oracle's key entry uses, so the reader does
    # not have to map a second term onto it.
    ax.text(max(xs) * 0.615, at("capture_by_reproj") * 0.96,
            f"{ratio:.0%} of the ceiling", color=entity("residual"),
            fontsize=6.5, fontweight="bold", ha="left", va="top")

    # THE RANK CORRELATION BETWEEN THE RANKING SIGNAL AND THE PAYLOAD, which is the
    # number that decides how much of this panel is circular and which was deposited
    # and never shown. Top left is the one region no curve enters -- the oracle, the
    # highest series, is still below 33% at the 10% mark -- and it is read before the
    # curves, which is the right order for a caveat. MUTED, not a series colour: it is
    # a property of the pair, not of either series.
    if rhos:
        ax.text(max(xs) * 0.025, ax.get_ylim()[1] * 0.99,
                f"ρ(residual, correction) = {np.mean(rhos):.2f}\n"
                f"{min(rhos):.2f}–{max(rhos):.2f} across sessions",
                color=MUTED, fontsize=6.5, ha="left", va="top", linespacing=1.5)

    # THE ASSUMPTION THE WHOLE PANEL RESTS ON, in the deposit's own words: "the triage
    # analysis takes cross-view identity from that reference match, i.e. it assumes
    # association is already correct". This panel therefore conditions on Fig 3's
    # problem being solved perfectly, and that is not something a reader can infer
    # from a capture curve. It goes under the axis, next to the provenance, because it
    # qualifies the whole measurement rather than any one mark.
    footnote(ax, f"mean over {len(have)} SLAP-2M sessions\n"
                 "assumes association is already correct (Fig 3)")
    save(fig, 5, "c", "capture")


if __name__ == "__main__":
    main()
