#!/usr/bin/env python3
"""
Fig 8d -- ALGORITHMIC methods for the cross-view tracker, against the ceiling 8c set.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

WHAT 8a/8b/8c LEAVE TO DO. 8a and 8b swept the ten tracker thresholds: five cannot move
the shipped tracker at all, and the best of the rest (distanceThreshold 50 -> 25) reaches
cross-view IDF1 0.795. 8c then showed that 98.6% of the recoverable loss is IDENTITY, not
coverage, and that the ceiling for a perfect identity fix is 0.937 -- so there is real
headroom, and it is all in association. This panel is what four rounds of algorithmic
methods actually got out of that headroom.

THE TWO REFERENCE LINES ARE THE POINT OF THE PANEL. `dist25` is the bar to clear -- a
method that beats `shipped` but not the best THRESHOLD setting has not earned a code
change. The oracle line is what a perfect identity fix would reach. Read the distance to
both, not the ordering of the bars.

WHAT THE PANEL FOUND, AND IT IS ONE AXIS. Every method here is a way of changing WHICH
3D state an association is scored against, and they line up on a single variable: how
FRESH that state is.

`Target.detsByCam` holds one detection per camera and NEVER EXPIRES IT, and
`_retriangulate()` fuses all of them -- so the 3D anchor blends the current pose with
wherever each other camera last saw the animal. `figs/fig8_diag_anchor_age.py` measures
that: mean detection age 3.0-49.8 frames by session, maxima 844-8,652 frames, nearly five
minutes of staleness at 30 fps. Faithful to the sleap-3d reference, which has no track
aging. The ordering that follows is monotone over four orders of magnitude of switch
count, which is a much stronger statement than one configuration winning:

  fresher   `stale: 1` (evict anything older than this frame)      108-118 switches
  shipped   no expiry at all                                                  324
  staler    `anchorSmooth` 0.1 (EMA the anchor over frames)                  2,800
  stalest   freeze the anchor on near-tie frames (`ambigMargin`)      1,700 - 27,042

The other methods are the controls that make that reading trustworthy, and three of them
refuted the premise they were built on:

  sync (M1)      one Hungarian PER CAMERA, each match re-triangulating immediately, means
                 camera 1's assignment moves the state camera 2 is judged against --
                 Gauss-Seidel where Jacobi was wanted. Freezing the state within a frame
                 is worth +0.027 and -28 switches: real, small, and carried by ONE of the
                 eight sessions.
  bundle (M2)    epipolar-cluster detections across views into 3D bundles, then one
                 Hungarian target->bundle: the standard modern multi-view MOT shape, and
                 70x WORSE here (22,882 switches against 324). Pairwise epipolar error
                 between two cameras is a far weaker cue than agreement with a 5-view 3D
                 state, so the grouping flickered frame to frame and took the identities
                 with it. Not "grouping-then-associating is wrong" -- "this grouping threw
                 away the strong cue".
  xvRefine (M2') the same consistency idea on the STRONG cue: hand a view's detection to
                 another target whenever total triangulation residual falls. It accepted
                 0 and 5 exchanges out of ~170,000 tests. The shipped association is
                 already cross-view consistent -- when a swap happens all five views swap
                 TOGETHER -- so this failure mode simply is not what is going wrong.
  reid (M3)      a skeletal re-identification prototype (all pairwise 3D inter-keypoint
                 distances) standing in for the CNN appearance embedding of
                 BoT-SORT/FairMOT, since the detection pool holds keypoints and no pixels.
                 Dead on this corpus: with the prototype frozen, P(closer to its own
                 animal than to the other) is 0.40-0.57 across 8 full sessions. Same-strain
                 mice, and the between-animal difference is under the triangulation noise.
  motion         constant-velocity prediction. A 1-frame velocity baseline on a DLT
                 triangulation is mostly noise, which is why it came in BELOW plain sync.

WHY THE SWITCH AXIS IS LOGARITHMIC: not as a second ranking, but because `bundle` and
`ambig 400` are two orders of magnitude off the rest and a linear axis would hide it
behind the methods that differ by tens.

Source: figs/out/fig8_methods.json (written by figs/fig8_methods.py) for the methods,
figs/out/fig8_diag_loss_default_full.json for the oracle line, figs/out/fig3_sweep.json
for the noise band. Every method row is proved attributable by
figs/out/fig8_methods_verify.json: the experimental fork with an EMPTY method block is
byte-identical to pose/cross-view-tracker.js on all 8 full sessions.

    python3 figs/panels/fig8_04_methods.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, INK, MUTED, SALMON, TEAL, deposit, footnote,  # noqa: E402
                       grid, save, text_legend, use)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fig8_02_idf1 import noise_band  # noqa: E402  (same measured band as 8b)

#: Short labels. The config names are precise and far too long for a 40 mm axis.
LABEL = {
    "shipped": "shipped",
    "dist25": "distThresh 25",
    "sync": "M1 sync",
    "sync_stale1": "M1 + stale 1",
    "sync_motion": "M1 + motion",
    "sync_smooth": "M5 smooth anchor",
    "sync_xvrefine": "M2' xv-refine",
    "sync_ambig20": "M4 ambig 20",
    "sync_ambig100": "M4 ambig 100",
    "sync_ambig400": "M4 ambig 400",
    "sync_dist10": "M1 + distThresh 10",
    "sync_dist25": "M1 + distThresh 25",
    "dist25_ambig100": "M4 + distThresh 25",
    "sync_dist25_ambig100": "M1 + M4 + distThresh 25",
    "sync_dist25_ambig400": "M1 + M4(400) + distThresh 25",
    "bundle": "M2 bundle",
    "bundle_stale1": "M2 + stale 1",
    "bundle_reid4": "M3 re-id w=4",
    "bundle_reid8": "M3 re-id w=8",
    "bundle_reid4_hyst": "M3 re-id + hysteresis",
    "bundle_reid4_slow": "M3 re-id slow proto",
    "bundle_reid4_freeze": "M3 re-id frozen proto",
    "bundle_reid8_freeze": "M3 re-id frozen w=8",
    "bundle_reid8_freeze_hyst": "M3 re-id frozen + hyst",
    # Round 5-7: the threshold bar, and the anchor-freshness axis that won.
    "dist25_corr36": "distThresh 25 + corr3d 36",
    "sync_dist25_corr36": "M1 + distThresh 25 + corr3d 36",
    "dist25_corr36_ambig100": "M4 + dt25 + corr3d 36",
    "dist25_corr36_robust25": "M6 + dt25 + corr3d 36",
    "sync_dist25_corr36_ambig100": "M1 + M4 + dt25 + corr3d 36",
    "sync_motion_base15": "M1 + motion (15-frame base)",
    "dist25_corr36_motion15": "motion(15) + dt25 + corr3d 36",
    "sync_robust25": "M6 trimmed mean",
    "dist25_robust25": "M6 + distThresh 25",
    "sync_dist25_robust25": "M1 + M6 + distThresh 25",
    "stale1": "stale 1 (no M1)",
    "sync_stale2": "M1 + stale 2",
    "sync_stale5": "M1 + stale 5",
    "sync_stale30": "M1 + stale 30",
    "sync_stale1_dist25": "M1 + stale 1 + distThresh 25",
    "sync_stale1_dist25_corr36": "M1 + stale 1 + dt25 + corr3d 36",
    "stale1_dist25_corr36": "stale 1 + dt25 + corr3d 36 (no M1)",
    "sync_stale10_dist25": "M1 + stale 10 + distThresh 25",
    "sync_stale30_dist25": "M1 + stale 30 + distThresh 25",
    "sync_stale100_dist25": "M1 + stale 100 + distThresh 25",
    "sync_dist10": "M1 + distThresh 10",
}


def build(deposit="fig8_methods.json") -> pd.DataFrame:
    d = load(deposit)
    cells = [c for c in d.get("cells", []) if c.get("idf1_cross") is not None]
    if not cells:
        sys.exit(f"fig8d: no scored cells in {deposit} -- run "
                 "`$PY figs/fig8_methods.py` first")
    total_cf = d["total_camera_frames"]
    rows = []
    for c in cells:
        vs = c.get("vs_shipped") or {}
        rows.append({
            "config": c["config"],
            "label": LABEL.get(c["config"], c["config"]),
            "idf1_cross": c["idf1_cross"],
            "idf1_within": c["idf1_within"],
            "switches": c["switches"],
            "switches_per_100k": c["switches"] * 100_000 / total_cf,
            "n_sessions": c["n_sessions"],
            "sessions_higher_cross_idf1": vs.get("sessions_higher_cross_idf1"),
            "sessions_lower_cross_idf1": vs.get("sessions_lower_cross_idf1"),
            "worst_cross_idf1_delta": vs.get("worst_cross_idf1_delta"),
            "worst_switch_delta": vs.get("worst_switch_delta"),
        })
    df = pd.DataFrame(rows).sort_values("idf1_cross").reset_index(drop=True)

    # Collapse EXACT duplicates: configurations that produced the same switch count and
    # the same IDF1 to six places are the same measurement drawn twice, and two of the
    # pairs here are (adding corr3d = 36 on top of stale 1 + dt = 25 changes nothing;
    # a 100-frame staleness horizon evicts nothing this detector produces). Those are
    # findings, but they belong in the README and the deposited CSV, not as a second
    # identical row on a panel that is already tall. Nothing is dropped silently — the
    # names go in the footnote, and the CSV deposited above keeps every row.
    # The SIMPLER name survives each pair. Encountered in IDF1 order, the twin that
    # happens to sort first would otherwise win, which put `bundle_reid4_hyst` on the
    # panel and folded plain `bundle` away -- backwards, since the added term is the
    # thing shown to do nothing. Fewest underscore-separated tokens wins, shortest
    # breaks the tie.
    def simplicity(cfg):
        return (cfg.count("_"), len(cfg))

    keep, folded = [], []
    for _i, r in df.iterrows():
        row = dict(r)
        twin = next((k for k in keep if k["switches"] == row["switches"]
                     and abs(k["idf1_cross"] - row["idf1_cross"]) < 1e-6), None)
        if twin is None:
            keep.append(row)
        elif simplicity(row["config"]) < simplicity(twin["config"]):
            folded.append((twin["config"], row["config"]))
            keep[keep.index(twin)] = row
        else:
            folded.append((row["config"], twin["config"]))
    return pd.DataFrame(keep).reset_index(drop=True), total_cf, folded, d


def main(all50=False):
    """Draw the methods panel. `all50` reads the 50-SESSION deposit instead of the 8.

    Two things legitimately differ in the 50-session variant, and both are stated on the
    panel rather than quietly reused:

    * NO ORACLE LINE. 8c's perfect-identity ceiling is measured on the 8 sessions; the
      50-session ceiling would need `fig8_diag_loss.py --root fig8m50` over 50 sessions,
      which has not been run. Drawing the 8-session ceiling beside 50-session results
      would be comparing a bound to numbers it does not bound.
    * THE BAND IS THE 8-SESSION GRID'S. It is measured off Fig 3e's plateau, which is an
      8-session measurement. Sampling noise on a 50-session mean is SMALLER, so reusing
      it is conservative -- a point outside this band at 50 sessions is outside it by at
      least this much. Said in the footnote so no one reads it as a 50-session band.
    """
    use()
    deposit_name = "fig8_methods_50.json" if all50 else "fig8_methods.json"
    df, total_cf, folded, dep = build(deposit_name)
    deposit(df, 8, "fig8f_methods50.csv" if all50 else "fig8d_methods.csv")

    oracle = None
    if not all50:
        diag = load("fig8_diag_loss_default_full.json")
        oracle = float(np.mean([r["cross_idf1_oracle_id"] for r in diag["per_session"]]))
    half = noise_band()
    shipped = float(df[df.config == "shipped"].idf1_cross.iloc[0])
    d25 = df[df.config == "dist25"]
    d25v = float(d25.idf1_cross.iloc[0]) if len(d25) else None

    fig, axes = grid(1, 2, span="full", row=max(56.0, 18.0 + 4.6 * len(df)),
                     sharey=True)
    # grid() has no `key=` reservation, so do what panel(key=3) does by hand -- the
    # 3-entry key would otherwise be drawn inside the data area, on top of the top rows.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 4 + 0.02)))
    axL, axR = axes[0], axes[1]
    y = np.arange(len(df))

    # Colour encodes the OUTCOME against the measured band, not the method family.
    # Family was the first attempt and it says nothing a reader wants: `sync_ambig400`
    # and `sync_stale1` share a prefix and sit at opposite ends of the panel. Three
    # states, all defined by the band 8b measured, so the encoding is not a judgement
    # call: clearly better, clearly worse, or not distinguishable from shipped.
    def colour(cfg, v):
        if cfg == "shipped":
            return INK
        if v > shipped + half:
            return TEAL
        if v < shipped - half:
            return SALMON
        return MUTED

    cols = [colour(c, v) for c, v in zip(df.config, df.idf1_cross)]

    # --- left: cross-view IDF1 -------------------------------------------------
    # Band first, under the data, exactly as 8b does: a point inside it is not
    # distinguishable from the shipped default by this measurement.
    axL.axvspan(shipped - half, shipped + half, color=GREY, alpha=0.28, lw=0, zorder=0)
    if oracle is not None:
        axL.axvline(oracle, color=SALMON, lw=1.0, ls=(0, (2.5, 1.5)), zorder=1)
    if d25v is not None:
        axL.axvline(d25v, color=MUTED, lw=0.9, ls=(0, (1.2, 1.2)), zorder=1)
    axL.hlines(y, shipped, df.idf1_cross, color=cols, lw=1.0, zorder=2, alpha=0.55)
    axL.scatter(df.idf1_cross, y, s=16, c=cols, zorder=4, edgecolor="white", lw=0.6)
    axL.set_xlabel("cross-view IDF1", fontsize=7)
    # Include every point: `sync_ambig400` reaches 0.586 and was being clipped off the
    # left edge at a hard-coded 0.60.
    lo = min(float(df.idf1_cross.min()), shipped - half) - 0.02
    axL.set_xlim(lo, 1.0)
    if oracle is None:
        axL.set_xlim(lo, max(1.0, float(df.idf1_cross.max()) + 0.03))
    axL.tick_params(axis="x", labelsize=6.5)
    axL.set_yticks(y)
    axL.set_yticklabels(df.label, fontsize=6.0)
    axL.set_ylim(-0.7, len(df) - 0.3)

    # --- right: within-view ID switches, log --------------------------------------
    axR.set_xscale("log")
    sh_sw = float(df[df.config == "shipped"].switches_per_100k.iloc[0])
    axR.axvline(sh_sw, color=INK, lw=0.9, ls=(0, (1.2, 1.2)), zorder=1)
    axR.hlines(y, sh_sw, df.switches_per_100k, color=cols, lw=1.0, zorder=2, alpha=0.55)
    axR.scatter(df.switches_per_100k, y, s=16, c=cols, zorder=4, edgecolor="white",
                lw=0.6)
    axR.set_xlabel("within-view ID switches per 100,000 camera-frames", fontsize=7)
    # 7.6 pt, not the 6.5 the left axis uses: matplotlib sets a log axis's EXPONENT at
    # ~70% of the label size, so 6.5 renders the exponent at 4.55 pt and lint_text.py
    # rejects it (< 5 pt). 7.6 puts the exponent at ~5.3 pt.
    axR.tick_params(axis="x", labelsize=7.6)

    # The worst single-session IDF1 change, printed rather than plotted. Two of the
    # eight sessions are already at their oracle ceiling, so this number -- not the
    # mean -- is what disqualifies a method.
    for i, r in df.iterrows():
        # `shipped` is the reference, so it has no delta against itself; pandas turns
        # that missing value into NaN, which would print as "worst session +nan".
        if r.worst_cross_idf1_delta is None or pd.isna(r.worst_cross_idf1_delta):
            continue
        axR.text(1.02, i, f"worst session {r.worst_cross_idf1_delta:+.3f}",
                 transform=axR.get_yaxis_transform(), va="center", ha="left",
                 fontsize=5.4, color=MUTED, clip_on=False)

    text_legend(axL, [
        ("shipped tracker; dotted lines are it and the best threshold setting", INK),
        (f"better than shipped by more than the +/-{half:.3f} band", TEAL),
        ("worse than shipped by more than the band; grey = inside it", SALMON),
        ((f"orange rule -- oracle: perfect identities at today's coverage "
          f"= {oracle:.3f}") if oracle is not None
         else f"all {len(dep['sessions'])} sessions; no oracle ceiling measured at this n",
         MUTED),
    ], "above")

    footnote(axL,
             f"grey band +/- {half:.3f} is this grid's own spread, measured off "
             "fig3_sweep.json -- a point inside it is not distinguishable from shipped\n"
             f"switch axis is LOGARITHMIC: the worst method reaches "
             f"{float(df.switches_per_100k.max()):.0f} per 100,000 against shipped's "
             f"{sh_sw:.2f}, and a linear axis would hide it\n"
             "the experimental fork with no method enabled is byte-identical to "
             "pose/cross-view-tracker.js on all 8 full sessions "
             "(fig8_methods_verify.json)\n"
             + (("".join(f"{a} is numerically identical to {b} and is folded into it\n"
                          for a, b in folded)) if folded else "")
             + f"8 BMimica sessions x 5 cameras, full length, {total_cf:,} "
             "camera-frames, one shared detection pool")
    save(fig, 8, "d", "methods")


if __name__ == "__main__":
    main(all50="--all50" in sys.argv)
