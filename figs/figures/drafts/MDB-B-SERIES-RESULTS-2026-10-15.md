# Mouse-Dyad-10M b-series results (LUC3D only, exploratory) — 2026-10-15

All 56 sessions, 5 cameras. LUC3D v1.0.5 (2dc001fe) with the paper's settings (sync, stale 20, distance 25, corr3d 6). Scoring is tail-free in every config (`SCORE_NOTAIL=1`, IoU 0.5), against the same ground truth as the paper. Run on ericmimicc, 14:52–15:44 UTC.

| Config | Pool | Tail in tracking | Detections | Camera frames scored | Cross-view IDF1 | IDP | IDR | Switches | Switches per 100k |
|---|---|---|---|---|---|---|---|---|---|
| paper | sleap-nn-filtered | excluded | 88,688,879 | 50,423,670 | 0.8725 | — | — | 367 | 0.73 |
| b0 (gate) | sleap-nn-filtered | excluded | 88,688,879 | 50,423,670 | 0.8725 | 0.936 | 0.818 | 367 | 0.73 |
| b1 | body ≥ 5 | excluded | 100,357,169 | 50,423,670 | 0.9849 | 0.987 | 0.982 | 64 | 0.13 |
| b2 | sleap-nn-filtered | included | 88,688,879 | 50,423,670 | 0.8718 | 0.935 | 0.818 | 369 | 0.73 |
| b3 | body ≥ 5 | included | 100,357,169 | 50,423,670 | 0.9676 | 0.970 | 0.965 | 144 | 0.29 |

**Gate:** b0 reproduces the paper exactly. All 56 tracker outputs are byte-identical to the paper's v1.0.5 outputs, and all 56 per-session cross-view IDF1 values match the paper deposit (`fig8_methods_50_md56.json`, cell `sync_stale20_dist25`).

## Pools

| Pool | Path | Filter rule | Detections | Body keypoints | Camera frames with both mice detected |
|---|---|---|---|---|---|
| sleap-nn-filtered (paper) | `luc3d-bench/outputs/bmimica/det_h5/` | instance score ≥ 0.85, mean node score ≥ 0.55, ≥ 8 of 15 keypoints visible (tail counted), OKS overlap filter 0.50 | 88,688,879 | 973,370,473 | 77.82% |
| body ≥ 5 | `luc3d-bench/outputs/bmimica/det_h5_bvis5/` | ≥ 5 of the 11 body keypoints visible (tail not counted), no score or overlap filters (the SLAP-2M rule) | 100,357,169 | 1,098,553,033 | 99.05% |

- The body ≥ 5 pool has more than 2 detections in only 3 of 50.4 million camera frames.
- Both pools cover the same frames: 50,424,836 detection frames, and 50,423,670 camera frames scored (the min of ground-truth and detection frames per camera).

## Per-session (b1 vs b0)

- **Cross-view IDF1:** b1 is better in 55 of 56 sessions, with a median gain of +0.077. The per-session median goes from 0.917 to 0.998, and the minimum from 0.537 to 0.708.
- **One session gets worse:** `20250905_171829` (−0.248).
- **Switches:** fewer in 27 sessions, more in 2, and the same in the rest.

## Sources

- Results: `figs/out/mdb_experiment_v105.json`; logs `figs/out/md56_logs/OTHER_MDB_{queue,track,score,summary}.log`.
- Pool counts: read-only recount of all 280 camera-sessions per pool. The body ≥ 5 total matches its build log (`MDB_litepool.log`: kept 100,357,169).

Exploratory only. Adopting b1 or b3 is Eric's decision. It would mean rerunning every Mouse-Dyad arm (SLEAP, ByteTrack, head-to-head, sweeps, camera subsets, Supp 6A/F) on that pool.
