# Fig 4B/C rework — implementation plan (2026-10-07)

## Goal

Replace Fig 4B (IDF1 box plot) and 4C (missing-keypoint heatmap) with a row that tells one story per difficulty level:

1. **Irrecoverable keypoints.** What fraction of keypoints is seen by one camera or none, so it can never be triangulated. Which camera pairs actually see what.
2. **Dispersion.** Detection error when a keypoint is present (the middle subplot of current 4E).
3. **Identity.** Cross-view IDF1 from LUC3D on raw detections, not on proofread labels.

Side quest: check whether the sleap-nn filter removes too many poses in the hard sessions and pulls the score down.

## What the data already shows (computed 2026-10-07 from deposits on disk)

### Keypoints visible in ≤1 camera (mean ± s.d. across sessions, % of reference keypoints)

| Pool | d1 | d2 | d3 | d4 | d5 | d6 | d7 |
|---|---|---|---|---|---|---|---|
| keeptrack (sleap-nn filtered + tracked, **what 4B/4E draw today**) | 1.8±2.1 | 5.2±3.1 | 12.0±10.3 | 9.5±7.8 | 10.6±9.2 | 30.3±15.4 | 40.2±9.7 |
| predslp (pre-proofreading predictions, no sleap-nn filter step; inference-time settings unverified) | 1.7±2.0 | 4.4±2.8 | 8.7±6.1 | 6.3±4.2 | 7.1±4.6 | 17.8±10.4 | 20.8±5.5 |
| proofread 2D (human-judged occlusion floor) | 1.7±2.0 | 4.4±2.8 | 8.1±5.3 | 5.6±3.3 | 7.3±4.8 | 18.0±10.3 | 21.1±6.1 |

Sources: `out/fig4_recovery_pernode.json`, `out/fig4_recovery_predslp_pernode.json`, `out/fig4_recovery_proofread2d.json`. All have g = 6 everywhere, because the reprojected 3D is always in frame.

### Per-camera miss rate (`miss_rate`, mean over sessions)

| Pool | d1 | d2 | d3 | d4 | d5 | d6 | d7 |
|---|---|---|---|---|---|---|---|
| keeptrack | 5.3 | 10.7 | 22.3 | 22.1 | 22.5 | 45.8 | 57.7 |
| predslp | 5.0 | 8.8 | 17.2 | 15.8 | 17.3 | 32.8 | 40.1 |
| proofread | 5.0 | 8.8 | 15.7 | 13.6 | 17.4 | 32.5 | 39.5 |

### Median cross-view IDF1, fresh anchor (`sync_stale20_dist25`), multi-animal sessions

| Pool | d2 | d3 | d4 | d5 | d6 | d7 |
|---|---|---|---|---|---|---|
| keeptrack (current 4B) | 0.989 | 0.917 | 0.969 | 0.675 | 0.877 | 0.654 |
| predslp_notail | 1.000 | 0.974 | 0.998 | 0.943 | 0.883 | 0.896 |
| proofread | 1.000 | 0.999 | 1.000 | 0.999 | 0.908 | 0.997 |
| predictions (PAF pool) | 1.000 | 0.453 | 0.999 | 0.871 | 0.907 | 0.483 |

### sleap-nn filter cull rate (`detections_only/_filter_ledger.jsonl`, instances removed)

d1 3.5% · d2 17.2% · d3 24.1% · d4 20.6% · d5 28.0% · d6 49.8% · **d7 57.2%**

**Side-quest answer so far: yes, almost certainly.** The filter removes more than half the instances at d7. It doubles the ≤1-camera fraction there (40% vs 21%), and it costs about 0.24 median IDF1 (0.654 vs 0.896). The unfiltered predictions sit almost on top of the proofread occlusion floor. So most of the d6–d7 loss in current 4B/4E comes from the filter, not from occlusion.

## Decisions needed before building

1. **Which pool is "raw detections" for the new 4B?** The current 4B already uses keeptrack, which is raw detections, not proofread. But keeptrack is sleap-nn **filtered + tracked + capped to the number of animals** (`luc3d-bench/scripts/_keeptrack_pipeline.sh`). Note that the pool's h5 attr says "filter-only (no tracking)". That string is hard-coded in `aggregate_detections_h5.py` and is wrong for keeptrack. The `fig4_detections.py` docstring repeats the error. Options:
   - **predslp** (the pre-proofreading predictions, without our sleap-nn filter step. Any instance cap applied at inference time is not yet checked). Recommended once the side quest confirms it. It only has a `_notail` IDF1 run so far, so a with-tail run is needed for a like-for-like comparison.
   - a **new looser-filter pool** from the side quest (below).
   - keep keeptrack (status quo).
   "Image #3" never reached me. Please confirm which IDF1 plot it was.
2. **Which "visible" means what in panel 1.** Recommendation: draw the **proofread 2D** line as the physical floor ("not visible in two views") and the chosen detector pool as a second line ("not detected in two views"). The gap between them is what a better detector or filter could still recover.
3. **Layout.** Proposed: B = three small subplots side by side (IDF1 · % keypoints in <2 views · error when present), sharing the 1–7 difficulty x-axis. C = the camera-pair coverage panel. Current 4E then drops its middle subplot, since it moves to B.

## Step 0: sanity check (do first)

The proofread-2D pool shows 21% of d7 reference keypoints with a proofread 2D label in ≤1 camera, yet those keypoints **have a proofread 3D point**. If the 3D were triangulated only from proofread 2D, that number would be ≈0. Find out which of these is true:
- the 3D was filled by interpolation or other sources (then "missing in 3D" needs its own definition), or
- `match_frame_wise` drops whole instances (the instance-level gate `MATCH_MAX_PX`), so an unmatched animal counts as m = 0 on every node.

How: pick one d7 session, take keypoints with m ≤ 1 in the proofread2d count, and read the raw proofread `.slp` for that frame, track and node directly. The answer sets the denominator for panel 1.

## Panel 1: irrecoverable keypoints + camera-pair coverage

### New measurement: `figs/fig4_visibility_masks.py`

Fork `fig4_recovery_pernode.py`. Keep the same loaders and the same `match_frame_wise` at stride 1. Change only the counting: per session keep
`hist[node, det_mask]` with `det_mask` the 6-bit set of cameras that carry the keypoint (64 bins, ~15×64 ints per session).
- Add `--pool {keeptrack,predslp,proofread,<new>}` instead of one script per pool (the three existing pernode scripts differ only in the loader).
- Also count the 3D-missing universe, as Step 0 defines it: keypoints with proofread 2D in ≥1 view but no finite proofread 3D, with their 2D mask. These are the "missing in 3D, seen by one camera" keypoints.
- Output: `out/fig4_visibility_masks_<pool>.json`, which also carries difficulty and animals.

Everything else is arithmetic on the mask histogram:
- **% keypoints not visible in ≥2 cameras** = mass on masks with popcount ≤ 1. Per session, then mean ± s.d. per difficulty. Line plot with error bars, same style as 4E left.
- **Pair coverage matrix** C[i,j] = P(cameras i and j both see the keypoint). This is a 6×6 heatmap per difficulty, or one per difficulty bucket (1–2, 3–5, 6–7) to stay readable.
- **"What if not any two"**: for keypoints with popcount ≤ 1, show which single camera has them (a 6-bar stack per difficulty). This says which view is carrying the hard frames.
- **Stratified by camera**: P(camera c sees it AND at least one other camera sees it), per camera per difficulty. This is each camera's marginal value for triangulation.
- Keep the closed-form "at rig size k" from `fig4_recovery.surface_from_hist`. It can be re-derived from masks exactly, with no hypergeometric step, so check it against the old surface as a regression test.

### Panel: `panels/fig4_12_visibility.py`

Replaces `fig4_12_recovery_surface.py` (move the old one to `legacy/`). Deposit `data/fig4/fig4c_visibility_*.csv`.

## Panel 2: error when present

`panels/fig4_06_detection_quality.py` already draws this (middle subplot, mean ± s.d. with a dashed 95th percentile). Lift that subplot into a function, call it from the new B, and drop it from E. If the pool changes (decision 1), re-run `fig4_detections.py` on that pool. It needs a pool flag. Today it has only `--detections raw|proofread`. `fig6_detections_predslp.json` already exists, so check how it was produced and reuse that.

## Panel 3: IDF1 on raw detections

`panels/fig4_11_idf1_by_difficulty.py` takes a `--pool` (→ `out/fig9_slap2m_<pool>.json`). If the pool changes, run `fig4_slap2m.py --pool <pool> --configs sync_stale20_dist25` (with-tail predslp has not been run). Keep the guarded difficulty join. Optional: draw the proofread pool as a faint ceiling marker per stratum, so the reader can see detection quality versus association.

## Side quest: is the filter too strict?

The current filter (`luc3d-bench/scripts/sleap_nn/retrack_one.py`) uses instance score ≥ 0.85, mean node score ≥ 0.55, ≥ 8 visible nodes, and OKS NMS at 0.5. keeptrack then adds sleap-nn tracking with `target_instance_count` = number of animals, which caps detections per frame.

1. **Decompose the loss by stage** (cheap, no new inference). Run the miss-rate and visibility measurements on `detections_only_h5s` (filters, no cap) and on `keepall_h5s` (confirm what it is first). predslp → detections_only isolates the filter. detections_only → keeptrack isolates tracking and the cap. Also split the ledger cull by criterion (instance score, node score, visible nodes, OKS) per difficulty. Hard sessions likely fail mostly on mean node score, because occluded animals have low-confidence nodes.
2. **Looser-filter grid** on 3 sessions per difficulty first, then all 74: mean node score {0.55, 0.4, 0.25, off} × instance score {0.85, 0.5} × cap {N animals, N+1, none}. Keep OKS NMS, since duplicates are real. Rebuild the pool with `aggregate_detections_h5.py --n-dets 5`.
3. **Score each variant** on three measures: miss rate and visibility (recall side), detections per frame unmatched to any reference animal (the precision side, so we don't just trade misses for false positives), and IDF1 with IDP/IDR from `fig4_slap2m.py`. The loosest setting whose IDP holds near keeptrack's is the candidate.
4. If a looser pool wins, it becomes the pool for decision 1. It then needs a methods-text change: the filter thresholds are stated in METHODS.md. Any Fig 3/6 claims built on keeptrack should be checked too, but this plan does not change them.

## Bookkeeping

- `PANEL-SOURCES.md` rows for 4B/4C/4E, `FIGURE-LEGENDS.md`, and the RESULTS text that quotes the 0.649/0.829 medians and the "~11× miss rate".
- Fix the wrong "filter-only (no tracking)" attr text in the `fig4_detections.py` docstring, so the methods describe keeptrack correctly.
- Re-run `assemble.py` for fig4 and check the composite visually.

## Order of work

Step 0 → side-quest stage decomposition (1) → decide the pool → `fig4_visibility_masks.py` on the chosen pool and on proofread → the three B subplots → C pair panel → E trimmed → docs. The looser-filter grid (side quest 2–3) runs in the background in parallel. It only blocks the pool decision if decomposition is inconclusive.
