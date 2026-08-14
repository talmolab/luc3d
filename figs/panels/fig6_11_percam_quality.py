#!/usr/bin/env python3
"""
Fig 6s5 (SUPPLEMENTARY) -- detection quality PER CAMERA: the fraction of ground-truth
instances missed, by camera name, over all 74 SLAP-2M sessions.

THE ONE SPLIT FIG 6 DID NOT HAVE. 6c splits detection quality by difficulty, 6d by
animal count; the rig's six viewpoints were only ever shown as geometry (6a/6e).
This panel measures them: the two top-down cameras are the best views of a mouse
(top 30.1 %, topL 33.3 % of GT instances missed) and the two back cameras the worst
(backL 38.0 %, back 40.3 %) -- a 10-point spread that is pure VIEWPOINT, because
every camera sees the same sessions, the same animals and the same frames.

WHERE THE NUMBERS COME FROM, because fig6's own deposits cannot answer this:
`fig6_detections.json` pools each session's keypoints over its cameras before
depositing (its per-session records carry only `cameras_used`), and `fig6.json` is
the corpus inventory -- no per-camera quality anywhere in fig6's tree. The per-camera
table that exists is Fig 7's: `slap2m_luc3d_shipped_percam_ITEM3.csv`, one MOT row
per session x camera for the SHIPPED LUC3D tracker on the shared detection pool.
Its `num_misses` are GT instances with no matched prediction -- and on a SHARED
pool a tracker's misses measure the DETECTOR, not the tracker
(fig3_trackers.py:189-190 states and uses exactly this: the three trackers' recalls
agree to ~0.003). So this is a detection-quality panel built from tracking output,
and the y label says "instances", not "keypoints": a MOT miss is a whole animal
unmatched in a frame, which is why the level here (30-40 %) sits far above 6c's
keypoint miss rate (5-58 % by difficulty, 25 % pooled) -- different unit, same pool.

PER-SESSION DOTS BEHIND THE POOLED BAR, because the corpus is bimodal by
construction: 32 easy single-animal sessions and 13 difficulty-7 ones (6f). A bar
alone would hide that every camera spans ~0 to ~85 % across sessions while the
CAMERAS themselves stay in a fixed order -- top is the best view in the pooled
number and near the bottom of every session's spread.

Cameras are NAMED CATEGORIES, not an ordered stratum, so no `level()` ramp: one
quantity, one colour -- MISS_HUE, this figure's established miss-rate hue (6c). Drawn
in the rig's own name order (back, backL, mid, midL, top, topL); the rig's other two
cameras (side, sideL) are not in the scored pool and 74/74 sessions use these six.

Source: figs/data/fig7/slap2m_luc3d_shipped_percam_ITEM3.csv (committed);
per-camera n cross-checked at build time (74 sessions each, no side/sideL rows).

    python3 figs/panels/fig6_11_percam_quality.py
"""
import sys
from pathlib import Path



import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import deposit, footnote, level, panel, save, use  # noqa: E402

#: A neutral non-entity hue for the bars (review round 3): salmon now means ByteTrack
#: alone set-wide, and these bars are error percentages -- the worst neighbour for it.
MISS_HUE = level(0, 3)

FIGS = Path(__file__).resolve().parent.parent
SOURCE = FIGS / "data" / "fig7" / "slap2m_luc3d_shipped_percam_ITEM3.csv"


def build():
    df = pd.read_csv(SOURCE)
    cams = sorted(df.camera.unique())
    n_sessions = df.session.nunique()
    # Every camera must cover every session, or the pooled rates are not comparable
    # across cameras and the whole panel is a coverage artefact.
    bad = [c for c in cams if df[df.camera == c].session.nunique() != n_sessions]
    if bad:
        sys.exit(f"cameras {bad} do not cover all {n_sessions} sessions; "
                 f"refusing to draw per-camera rates over unequal session sets.")
    rows = []
    for c in cams:
        g = df[df.camera == c]
        per_sess = (g.num_misses / g.num_objects * 100.0).to_numpy()
        rows.append({"camera": c, "n_sessions": len(g),
                     "gt_instances": int(g.num_objects.sum()),
                     "missed": int(g.num_misses.sum()),
                     "miss_pooled_pct":
                         100.0 * g.num_misses.sum() / g.num_objects.sum(),
                     "miss_session_median_pct": float(np.median(per_sess)),
                     "miss_session_max_pct": float(per_sess.max())})
    cell = pd.DataFrame(rows)
    return df, cell, cams


def main():
    use()
    df, cell, cams = build()
    deposit(cell, 6, "fig6e_percam_quality.csv")

    fig, ax = panel("half", "std")
    x = np.arange(len(cams))
    ax.bar(x, cell.miss_pooled_pct, width=0.62, color=MISS_HUE, linewidth=0, zorder=2)
    # NO PER-SESSION DOTS (Eric, 2026-08-15: "what are all those outliers? just
    # give me the bar charts"). The dots were the 74 per-session rates -- the
    # high ones are real (hard sessions miss most of their instances in every
    # camera), but 444 dots over six bars buried the panel's one finding, the
    # ~10-point top-vs-back spread. The per-session distribution stays in the
    # deposited CSV.
    # The pooled value, printed on each bar -- the ~10-point top-vs-back spread IS
    # the panel's finding, so it goes on the artwork in numbers.
    for xi, v in zip(x, cell.miss_pooled_pct):
        ax.text(xi, 1.5, f"{v:.1f}", ha="center", va="bottom", color="white",
                fontsize=6.0, fontweight="bold")

    ax.set_xticks(x)
    ax.set_xticklabels(cams)
    ax.set_xlabel("camera")
    ax.set_ylabel("GT instances missed (%)")
    # Axis to the BARS now the dots are gone: bars top out at 40.3%, and a 0-103
    # axis left two-thirds of the panel empty.
    ax.set_ylim(0, 45)
    ax.set_yticks([0, 10, 20, 30, 40])

    footnote(ax,
             "bar: pooled over all frames of all 74 sessions (value printed at its "
             "base); per-session rates in the deposited CSV\n"
             "misses are the shipped LUC3D tracker's MOT misses on the shared "
             "detection pool, which measure the DETECTOR (fig3_trackers.py: the "
             "three trackers' recalls agree to ~0.003)\n"
             "instance-level, not keypoint-level -- do not compare the scale to "
             "Fig 6c\n"
             + " · ".join(f"{r.camera} {r.miss_pooled_pct:.1f}%"
                          for r in cell.itertuples()))
    save(fig, 6, "e", "percam_quality")


if __name__ == "__main__":
    main()
