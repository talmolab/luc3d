# Fig 3b and Fig 6b: no sleap-nn filter, no match gate (2026-10-07)

## Goal

Rebuild Fig 3 and Fig 6 with the SLAP-2M arms on the UNFILTERED pre-proofreading
predictions (`predslp` pool) instead of the sleap-nn-filtered `keeptrack` pool. The
tracker is the one in the figures now, with NO match gate (PR #248's `matchGate`, which
is on by default in dev). Publish the results as **Fig 3b** and **Fig 6b**, next to the
originals.

## Isolation (no contamination)

Built in `eric/figs` itself (Eric, 2026-10-07: "you dont really have to do a worktree,
just use this repo ... try to keep them separate"). Separation is by NAME. Every switch
defaults to the old behaviour, and nothing the base figures read is overwritten.

| Switch | Script | Tagged outputs |
|---|---|---|
| `FIG3_VARIANT=unfilt` | `fig3_headtohead.py`, `fig3_quality.py`, `fig3_hh_freshanchor.py`, `fig3_scale_runtime.py` | `out/fig3_{headtohead,quality,runtime,scale}_unfilt.json`, `out/fig3_{headtohead,quality}__<tag>_unfilt.json`; caches `out/tmp/{headtohead,headtohead_var,scale_runtime}_unfilt/` |
| `FAIR_VARIANT=unfilt` | `fig6_slap2m_fair.py` | `out/fig6_slap2m_fair_unfilt{.json,_percam.csv}`, `out/fig7_variant_best_unfilt.json`; runs in `out/tmp/slap2m_fair_unfilt/` |
| `FIG_TAG=b FIG_VARIANT=unfilt` | panels, `fig3_sync.py`, `fig6_sync.py`, `assemble.py` | `figures/fig3b/`, `figures/fig6b/`, `data/fig3b/`, `data/fig6b/` |

- `panels/fig3_04_quality.py` picks its fresh-anchor deposit by glob. It now skips
  `*_unfilt.json`, which would otherwise sort after the base file and leak into base Fig 3.
- **No gate:** `grep -rn matchGate pose scripts/bench figs/fig6-bench figs/fig3-bench`
  returns nothing on eric/figs. The gate code does not exist here, so it cannot be on.
- Logs and run scripts: `out/unfilt_logs/`.

## What changes and what does not

| Panel | Corpus | Changes? |
|---|---|---|
| 3a, 3c, 3d | drawn | no |
| 3b cost model | arithmetic + one runtime number | rebuilt from the new runtime deposit |
| **3e grouping accuracy** | Mouse-Dyad-10M + SLAP-2M | **SLAP-2M arm rerun** |
| 3f time per frame | same | taken from the existing gate-off unfiltered timing run (see step 3) |
| 3g/h 3D term sweep | Mouse-Dyad-10M | no |
| 6a within vs cross, 6f stale sweep | Mouse-Dyad-10M | no |
| **6b-d LUC3D vs SLEAP vs ByteTrack** | SLAP-2M | **all three trackers on unfiltered input** |
| 6e drawn, 6g rats | — | no |

## Steps

### 0. Setup

- Add the variant switches above.
- Seed the Mouse-Dyad-10M head-to-head and fresh-anchor caches from the original run,
  because that corpus has no filter and the code is unchanged. The SLAP-2M cells start empty.

### 1. Equivalence

No separate check is needed. The code is the same code that made the original deposits.
Two things are verified along the way instead:
- The exhaustive numbers for Mouse-Dyad-10M must be identical to the base deposit.
- `fig6_slap2m_fair.py --stage score` re-checks LUC3D's per-camera IDF1 against
  `fig9_slap2m_predslp.json` exactly, its built-in harness gate.

### 2. Fig 3e on unfiltered input

`SLAP2M_POOL=<predslp_pool> fig3_headtohead.py`, then `fig3_quality.py`, Node 26 (the
version the Methods state).

**Eligibility.** The exhaustive arm only runs on frames where EVERY camera holds EXACTLY A
detections, where a detection counts if it has at least one keypoint. Detections with
missing nodes are allowed. With unfiltered input, extra detections make frames
ineligible. So report frames considered / eligible / computed per config, filtered vs
unfiltered, next to the accuracy numbers, so a change in 3e can be split into "different
frames" and "different answers".

### 3. Fig 3e greedy arm, then Fig 3f and 3b

- `fig3_hh_freshanchor.py --run` re-runs the fresh-anchor greedy arm (the LUC3D series 3e
  draws) on the unfiltered pool and re-uses the new exhaustive outputs.
- Then, once the machine is quiet (after the Fig 6 chain), `fig3_scale_runtime.py`
  re-times 3f on the unfiltered pool. It runs on Node 26, as in the Methods.

### 4. Fig 6b-d

- **LUC3D:** the gate-free unfiltered run already exists in eric/figs
  (`fig9_slap2m_predslp.json`, cell `sync_stale20_dist25`; caches
  `out/tmp/fig9slap_predslp/sync_stale20_dist25`). Staged here as `fig9_slap2m.json`.
- **SLEAP and ByteTrack:** rerun here on the unfiltered pool (Eric: "do the luc3d slap2m
  runs and the sleap and bytetrack on unfiltered").
  - SLEAP: sleap-nn 0.2.0 with NO `--filter_*` flags and the same N cap, from the raw
    `.predictions.slp`.
  - ByteTrack: never-retire + stitch to N, as in the figure.
  - The bench `sleap_nn_env` is broken, so it runs through a venv that points at its
    site-packages (`out/tmp/snenv_unfilt`).
- Then `--stage verify`, `--stage score` (which checks LUC3D's per-camera IDF1 against
  `fig9_slap2m_predslp.json` exactly) and `--stage install`. Install seeds
  `fig7_variant_best_unfilt.json` from the base file and replaces only its `slap2m_fair`
  block, the block 6b-d draw.

### 5. Build and compare

- `FIG_TAG=b FIG_VARIANT=unfilt make_figures.py 3 6`, which writes `figures/fig3b/` and
  `figures/fig6b/`.
- `figs/UNFILT-REPORT.md`: every changed number, figure vs unfiltered gate-off, with the
  gate-on unfiltered number from `lucid-matchgate` as a reference column.
