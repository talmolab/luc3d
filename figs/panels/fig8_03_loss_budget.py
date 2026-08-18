#!/usr/bin/env python3
"""
Fig 8c -- WHERE the shipped tracker's cross-view IDF1 actually goes, per session.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHY THIS PANEL EXISTS. 8a and 8b sweep thresholds and find almost nothing, and the
natural next move is to try better ALGORITHMS. That move is worthless without first
knowing what the missing IDF1 is made of, because two failure modes produce the same
number and they have disjoint fixes:

    IDENTITY error   the tracker labelled a detection, and labelled it wrong
    COVERAGE error   the tracker labelled nothing, so a real detection that ground
                     truth matches is a miss however good the identities are

This panel measures the split. Three IDF1s per session, from
`figs/fig8_diag_loss.py`, all on the SAME result JSONs Fig 8a/8b scored:

    as_is        the tracker's own identities                    = what 8a/8b report
    oracle_id    every detection the tracker LABELLED, relabelled to the id of its
                 best-IoU ground-truth box                       = the ceiling a
                                                                   perfect identity
                                                                   fix could reach at
                                                                   TODAY's coverage
    oracle_full  every detection with a bbox, relabelled the same way = the ceiling
                                                                   if coverage were
                                                                   perfect too

THE ANSWER, AND IT IS LOPSIDED. Mean as_is 0.735, oracle_id 0.937, oracle_full 0.939.
So 0.202 of the 0.205 recoverable loss -- 98.6% of it -- is IDENTITY, and 0.003 is
coverage. 99.4% of detections with a bbox already get an identity. Any effort spent on
emitting more output is spent on 1.4% of the problem.

THE SECOND READING IS THE ONE THAT PICKED THE METHODS. Look at 20250904_131913: it
loses 0.311 IDF1 with TEN within-view switches, against a 7,205,370 camera-frame
denominator. That combination is only possible if the few switches that do occur are
PERMANENT -- a swap costs every frame after it, because after two targets exchange
animals both are perfectly consistent with their new detections and nothing in the
tracker can notice. Consistent with that, the same tracker scores 0.935 over the
leading 20,000 frames of each session and 0.735 over the whole length.

So the shipped tracker's problem is not that it switches often. It switches almost
never and cannot undo it. That is why Fig 8d's methods split into PREVENTION (make the
ambiguous decision better) and RECOVERY (undo a decision already made), and why the
recovery half needs a feature attached to the ANIMAL rather than to the trajectory.

Source: figs/out/fig8_diag_loss_default_full.json, written by
`figs/fig8_diag_loss.py --cell default` (full sessions, no frame cap).

    python3 figs/panels/fig8_03_loss_budget.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, SALMON, TEAL, deposit, footnote,  # noqa: E402
                       panel, save, text_legend, use)


def build() -> pd.DataFrame:
    d = load("fig8_diag_loss_default_full.json")
    rows = d.get("per_session") or []
    if not rows:
        sys.exit("fig8c: no per_session rows in fig8_diag_loss_default_full.json -- "
                 "run `$PY figs/fig8_diag_loss.py --cell default` first")
    df = pd.DataFrame(rows).sort_values("cross_idf1_as_is").reset_index(drop=True)
    df["id_gap"] = df.cross_idf1_oracle_id - df.cross_idf1_as_is
    df["cov_gap"] = df.cross_idf1_oracle_full - df.cross_idf1_oracle_id
    return df


def main():
    use()
    df = build()
    deposit(df[["session", "cross_idf1_as_is", "cross_idf1_oracle_id",
                "cross_idf1_oracle_full", "id_gap", "cov_gap", "assign_rate",
                "within_switches_as_is", "det_bbox", "det_labelled"]],
            8, "fig8c_loss_budget.csv")

    fig, ax = panel(span="half", row="tall", key=3)
    y = np.arange(len(df))

    # The bar is the LOSS, decomposed, drawn from as_is rightward to each ceiling --
    # so the panel reads as "here is what is missing and what kind it is", not as
    # three competing scores. as_is is the left edge, i.e. the thing being explained.
    ax.barh(y, df.id_gap, left=df.cross_idf1_as_is, height=0.62,
            color=SALMON, lw=0, zorder=3, label="identity")
    ax.barh(y, df.cov_gap, left=df.cross_idf1_oracle_id, height=0.62,
            color=GREY, lw=0, zorder=3, label="coverage")
    ax.plot(df.cross_idf1_as_is, y, "o", color=INK, ms=4.0, mec="white", mew=0.8,
            zorder=5)

    # Switch counts in a FIXED column past the ceiling line, not at each bar's end.
    # At the bar end they collided with the IDF1 = 1 rule on the two sessions that are
    # already at ceiling, and a ragged right edge reads as data when it is annotation.
    # The pairing of a large identity bar with a tiny switch count is the finding, so
    # the column has to be legible on every row.
    for i, r in df.iterrows():
        ax.text(1.045, i, f"{int(r.within_switches_as_is)}", va="center", ha="right",
                fontsize=5.8, color=MUTED)
    # "sw", not "switches": the full word is wide enough to reach back across the
    # IDF1 = 1 rule, which reads as the rule being annotated rather than the column.
    ax.text(1.045, len(df) - 0.5, "sw", va="center", ha="right",
            fontsize=5.8, color=MUTED, style="italic")

    ax.set_yticks(y)
    ax.set_yticklabels(df.session, fontsize=6.0)
    ax.set_xlabel("cross-view IDF1", fontsize=7)
    ax.set_xlim(0.50, 1.05)
    ax.set_xticks([0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    ax.tick_params(axis="x", labelsize=6.5)
    ax.axvline(1.0, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)

    mean_as_is = float(df.cross_idf1_as_is.mean())
    mean_oid = float(df.cross_idf1_oracle_id.mean())
    mean_ofull = float(df.cross_idf1_oracle_full.mean())
    idf = mean_oid - mean_as_is
    cov = mean_ofull - mean_oid

    text_legend(ax, [
        ("shipped tracker (dot)", INK),
        (f"recoverable by identity: +{idf:.3f}", SALMON),
        (f"recoverable by coverage: +{cov:.3f}", GREY),
    ], "above")

    footnote(ax,
             f"mean {mean_as_is:.3f} as-is, {mean_oid:.3f} with perfect identities at "
             f"today's coverage, {mean_ofull:.3f} with perfect coverage too\n"
             f"{100 * idf / (idf + cov):.1f}% of the recoverable loss is identity; "
             f"{float(df.assign_rate.mean()) * 100:.1f}% of detections with a bbox "
             "already get one\n"
             "oracle = each detection relabelled to its best-IoU GT box; a detection "
             "matching no GT keeps a private id so it stays a false positive\n"
             "8 Mouse-Dyad-10M sessions x 5 cameras, full length, 7,205,370 camera-frames, "
             "one shared detection pool")
    save(fig, 8, "c", "loss_budget")


if __name__ == "__main__":
    main()
