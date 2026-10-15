# md56: tracking accuracy must be rerun on origin/main (2026-10-14)

Eric's decision: every tracker-dependent md56 result is rerun on **all sessions** with
current `origin/main` of talmolab/luc3d (**2dc001fe**, includes #300 inverse iteration).

**Pinned release: luc3d v1.0.5 = 2dc001fe** (tag verified, empty diff). Use only v1.0.5 from
here on; record `v1.0.5` / `2dc001fe` in every deposit. `MD56-B-FIGURE-SETTINGS.md` §1 still says
"Not a release; about 40 commits after v1.0.4", which is now out of date.

Cached outputs from other code are not reused. `MD56-B-FIGURE-SETTINGS.md` §1 records that tracking accuracy
("fresh anchor, sweeps, staleness configs, camera subsets") came from the `eric/figs`
branch's `pose/` + `figs/fig6-bench/xv_experimental.js`. That branch split from main on
2026-08-26 and is 97 commits behind. The 50 old sessions in those deposits are cached
outputs from even earlier code.

## How to run the tracker on main

`figs/fig3-bench/fig3_bench.mjs` with `LUCID_ROOT=/root/vast/eric/lucid-main-md56` loads
main's real `pose/` and main's own `scripts/bench/hooks.mjs` (defaults: distanceThreshold
25, stale 20, corr3dWeight 6, matchGate 0) and takes `--params {"thresholds":{...}}`.
It ignores any `method` block. Main's association is always frame-synchronous, so `sync`
has no switch. `stale` and `distanceThreshold` are ordinary thresholds.

Gate, session `20250908_152229`, full length: main's own
`scripts/bench/bench_crossview.mjs` and `fig3_bench.mjs` + `LUCID_ROOT` at
`{distanceThreshold 25, stale 20, corr2d 1, corr3d 6}` give **identical** assignments on
all 179,313 frames. The old eric/figs cache cell (`sweep50/…e508a7ab/c2_1_c3_6`) for that
session is also identical. That is one session at one setting, not a proof for the rest.

## Status

| Result | Old source | Rerun on main |
|---|---|---|
| Fig 3G/H sweep, both arms | `fig3_sweep50*_md56.json` (eric/figs; 50 sessions cached) | **Running on ericmimicc** (`md56_logs/run_S2.sh`, `SWEEP50_LUCID_ROOT`, new in `fig3_sweep50.py`). Writes `*_md56main.json`, cache `tmp/sweep50_2dc001fe/`, prints `PHASE S2 DONE` |
| Fig 3E greedy arm | `fig3_quality__…e508a7ab_md56.json` via `fig3_hh_freshanchor.py` | TODO (main box) |
| Supp Fig 6A LUC3D, 6F staleness configs | `fig8_methods_50_md56.json` via `fig6_methods.py` (fig6_bench + xv_experimental) | TODO (main box) |
| Camera subsets (text) | `fig2_cams_identity_md56.json` | TODO (main box) |
| Fig 3G/H frame-matched greedy | `fig3_frame_matched_bmimica_md56.json` | Check: greedy came from the head-to-head pass, recorded as `LUCID_ROOT`=2dc001fe |
| Fig 4D (SLAP-2M IDF1 by difficulty) | `fig9_slap2m.json` (2026-08-13) | TODO; not md56, but old tracker code |
| Fig 5 (social rearing) | `fig5_upright.json`, `fig5_rear_coupling_2animal.json` | Unverified whether these use LUC3D-tracked/triangulated 3D or proofread 3D |

## The "previous default" arm cannot run on main

`MD56-B-FIGURE-SETTINGS.md` defines it as pre-#210: distanceThreshold 50, no eviction,
**no sync**. Main has no way to turn sync off. The S2 rerun therefore tracks
`{distanceThreshold 50, stale 0}` on main ("previous settings", same association code as
the current arm). **Eric to decide:** use that, keep the old-code arm explicitly labelled as
pre-#210, or drop the arm. The panel (`panels/fig3_05_sweep.py`) reads
`fig3_sweep50.json` + a `…stale20-sync_*` glob, so the new filenames need mapping either
way.
