# Fig 3b and Fig 6b: unfiltered SLAP-2M, no match gate (2026-10-08)

Figures: `figures/fig3b/fig3b.png`, `figures/fig6b/fig6b.png`. Plan: `UNFILT-PLAN.md`.
Every SLAP-2M arm uses the unfiltered pre-proofreading predictions (`out/tmp/predslp_pool`).
The tracker is eric/figs' own, which has no match-gate code. Mouse-Dyad-10M and s-DANNCE
panels are unchanged. The base `fig3/`, `fig6/` folders and their deposits were not written.

## Fig 3e: grouping accuracy (frames misgrouped vs GT per 100,000 eligible frames)

A frame is eligible when every camera has exactly A detections.

| Config | Eligible frames, filtered → unfiltered | Exhaustive | Greedy (LUC3D) |
|---|---|---|---|
| Mouse-Dyad-10M 2×5 | 48.0% → 48.0% (4,324,330 frames both) | 12.9 → 12.9 | 13.2 → 13.2 |
| SLAP-2M 2×6 | 43.6% → 75.2% (237,841 → 410,713) | 301 → 792 | 145 → 478 |
| SLAP-2M 3×5 | 14.4% → 42.9% (10,419 → 8,000 sampled) | 154 → 275 | 125 → 613 |
| SLAP-2M 4×3 | 34.4% → 64.0% (19,135 → 3,000 sampled) | 852 → 1,300 | 47 → 67 |

- The filter mostly removed animals, which made frames ineligible. Without it, 2-3x more
  frames qualify, and they are harder ones, so both methods misgroup more.
- Greedy still beats exhaustive at 2×6 and 4×3. **At 3×5 greedy is now worse** (613 vs
  275 per 100k). That is n = 4 sessions and a 2,000-frame sample each: 49 vs 22
  misgrouped frames.
- **Sampling:** the original Fig 3 enumerated every eligible frame at 3×5 and 4×3. Here
  they are uniform samples of 2,000 / 1,000 eligible frames per session (the script's
  default). Full enumeration would take ~35 h, because eligible frames rose 2-3x.
- The greedy arm 3e plots (fresh anchor: sync, stale 20, dist 25) is byte-identical to
  the head-to-head's default greedy, because that IS the app default now (hooks.mjs).
- Greedy/exhaustive per-frame agreement: 99.81 → 99.45% (2×6), 99.76 → 99.34% (3×5),
  99.04 → 98.70% (4×3).

## Fig 3f: time per frame

| Config | LUC3D, filtered → unfiltered | Exhaustive, filtered → unfiltered |
|---|---|---|
| 2×5 | 0.39 → 0.41 ms | 11 → 11 ms (cached) |
| 2×6 | 0.40 → 0.40 ms | 16 → 28 ms |
| 3×5 | 0.61 → 0.64 ms | 2.7 → 4.9 s |
| 4×3 | 0.62 → 0.71 ms | 5.5 → 9.9 s |
| 4×6 | 1.00 → 1.11 ms | extrapolated |

**The exhaustive times are NOT trustworthy.** The hypothesis count per frame is fixed, so
the ~1.8x rise is machine load. The head-to-head ran while SLEAP was using 28 cores.
LUC3D's timings were re-measured on a quiet machine and are fine. Fix: re-time exhaustive
on a quiet box (about 20 min), or keep the original exhaustive times, since it is the same
algorithm on the same hypothesis count.

## Fig 6b-d: LUC3D vs SLEAP vs ByteTrack (SLAP-2M, 74 sessions)

| | LUC3D | SLEAP | ByteTrack |
|---|---|---|---|
| Within-view IDF1 mean | 0.899 → **0.963** | 0.872 → 0.923 | 0.838 → 0.882 |
| Within-view IDF1 median | 0.978 → 1.000 | 0.972 → 1.000 | 0.919 → 0.960 |
| ID switches | 1,991 → 2,688 | 5,267 → 5,402 | 7,148 → 13,011 |
| False positives | 19,254 → 145,480 | 21,854 → 149,143 | 24,184 → 162,853 |
| False negatives | 1,379,179 → **6,652** | 1,295,522 → 2,926 | 1,448,618 → 219,233 |

Paired LUC3D − SLEAP within-view IDF1 (6c):

| Animals | n | Filtered | Unfiltered |
|---|---|---|---|
| 1 | 32 | −0.001 (0 wins) | +0.000 (10 wins) |
| 2 | 35 | +0.038 (19 wins) | **+0.064 (27 wins, sign p 0.002)** |
| 3 | 4 | +0.092 (4 wins) | +0.081 (4 wins) |
| 4 | 3 | +0.096 (3 wins) | +0.142 (3 wins) |
| all | 74 | +0.026 (26 wins) | +0.040 (44 wins) |

- Every tracker improves without the filter, mainly because misses almost disappear
  (LUC3D's false negatives drop 1.38M → 6.7k).
- The cost is false positives, up ~7x for every tracker, from the extra spurious detections.
- LUC3D's lead over SLEAP widens at 2 and 4 animals and narrows slightly at 3. Its lead over
  ByteTrack widens.
- LUC3D's switches rise 1,991 → 2,688 but stay half of SLEAP's and a fifth of ByteTrack's.

## Provenance

- SLEAP: sleap-nn 0.2.0, no `--filter_*` flags, same N cap. Run via
  `out/tmp/snenv_unfilt`, a venv over the bench site-packages. 444/444 camera-sessions,
  all at or under N tracks.
- ByteTrack: never-retire + stitch to N, unchanged.
- LUC3D: `out/tmp/fig9slap_predslp/sync_stale20_dist25`. The score stage re-checked its
  per-camera IDF1 against `fig9_slap2m_predslp.json` exactly.
- Logs and run scripts: `out/unfilt_logs/`.
