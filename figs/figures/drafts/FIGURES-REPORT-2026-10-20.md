# Figures and open issues, 2026-10-20 (eric-mimicc-0-1)

Nothing is running. Nothing has been committed since `da433b01` (pushed earlier today).

## The figures the tex uses

| Tex include | File | State |
|---|---|---|
| `figs/fig1.pdf` | not built here (static) | unchanged |
| `figs/fig2c.pdf` | `figs/figures/fig2c/fig2c.pdf` | **rebuilt today.** Every LUC3D panel from LUC3D v1.0.5's JavaScript: 2B and 2D now from LUC3D's own solver (was a NumPy copy), 2G from today's watched timing sitting, the 2D camera strip from the LUC3D port of `fig5_views`. Backup of the previous version: `out/md56_logs/c_before_refresh_2026-10-20/` |
| `figs/fig3c.pdf` | `figs/figures/fig3c/fig3c.pdf` | eric-mimic2's build (03:27 UTC, clean 3F timing) |
| `figs/fig4.pdf` | `figs/figures/fig4/fig4.pdf` | same data; re-laid out without the stray "Variant fig4 ... proofread per-camera 2D labels" footer the old file carried |
| `figs/fig5.pdf` | `figs/figures/fig5/fig5.pdf` | 5A from LUC3D (visually identical), 5G per-direction "further apart" lines (main curves and text numbers unchanged), stray footer removed. Old fig4 / fig5: `out/md56_logs/fig45_before_swap_2026-10-20/` |
| `figs/fig6c.pdf` | `figs/figures/fig6c/fig6c.pdf` | unchanged since 10-19 |
| `figs/fig7.png`, `figs/fig8.pdf`, `figs/fig9.pdf` | GUI screenshot / calibration (repo `figures/fig7`) / Panopticon | unchanged |

The main `figures/fig2` to `fig7` folders were restored byte-identical after the stopped swap-in (git shows no change to them).

A complete single-input set of Figs 2-7 also exists in `figs/figures/fig{2..7}x7/` (Fig 5A on LUC3D, Supp 6G on the v1.0.5 s-DANNCE run). The tex does not use it.

## What changed in fig2c, against the previous fig2c

| Panel | Change | Tex |
|---|---|---|
| 2B, 2D | now LUC3D JS, every 15th frame. Every value within 0.4% of the NumPy version | unchanged: 75 -> 32 (32.46), 2.3x, 48, 36%, 12.6 mm at 13 deg, 2.7 mm at 31 deg |
| 2C, 2E, 2F | rebuilt on the LUC3D-built export, within 0.4% | unchanged: 4.74 / 1.21 mm, 4.27 -> 3.30 px, 2.15-2.34 px, 56/56 |
| 2G | new sitting: medians of 100 timed passes, IQR whiskers, one pinned core, nothing else of ours running (watcher-verified). DLT 0.885 us (IQR 0.880-0.894), Anipose linear 28.59, refined 27.45, Anipose optim 134.3 | updated: 32 and 4.9 times (was 5.0), 0.89 us (was 0.95), timing protocol in Methods, caption says median + IQR |

## Tex edits made today (this host)

- Staleness subsection on SLAP-2M with the new title (Eric approved), Methods anchor section to match.
- Camera subsets (L293) from the b3 run. Discussion camera sentence 0.92 -> 0.97.
- Supp 6 B-D numbers from the tail-free SLEAP deposit (32/24/18 P = 0.35, 31/10/1 P = 0.0015, 6 of 7, medians 0.076 / 0.11 / 0.15, 0.992 / 0.987, 0.056%).
- Methods on the b3 pool, tail weights and SLEAP filters for Mouse-Dyad.
- In-app speed provenance (16,030 / 14,694 fps, Eric's M1 measurements) in Methods Software.
- L435 softened ("each tool run on its own on a 64-core machine").
- Switch rate in the Introduction scoped to Mouse-Dyad. Difficulty "2 through 5". ByteTrack "1 to 2 s".
- Fig 2: 2B-G sampling sentence; 2E bottom described as an analysis protocol (Eric D2); 2G numbers and protocol; RANSAC "more than 100 times"; undistortion "about 0.4 and 1.7".
- s-DANNCE wrong-calibration control 0.513 -> 0.519 (v1.0.5 run).
- `fig6.pdf` -> `fig6c.pdf`.

## Open issues, most important first

1. ~~Methods "agreed to within 0.13%"~~ **deleted** (it compared the NumPy run with the LUC3D run).
2. ~~Fig 5A NumPy~~ **done**: `fig5.pdf` now uses the LUC3D version (at most 0.004 px different). Eric: 5A, 3D and the Fig 1 / 2A scene geometry are visualizations and do not matter.
3. **Supp 6G in the placed `fig6c.pdf` was built from the pre-v1.0.5 s-DANNCE run** (`fig10-bench/results/agg`, c9b2a325; found by eric-mimic2). The v1.0.5 run gives an identical placed CSV, so the figure looks the same. The tex control value now uses v1.0.5 (0.519). The `fig6x7` set uses the v1.0.5 run.
4. **2G companion not rerun.** Anipose's undistortion and RANSAC were stopped mid-sitting. The text now says "about 0.4 us" and "more than 100 times", which hold in both earlier sittings (0.41 / 0.41 us; 133x / 144x).
5. **Fig 1 tiles and Fig 2A are captures of the August eric/figs app**, not v1.0.5 (Eric D4: keep). Their captions must not say or imply v1.0.5.
6. **Fig 3D** is an offline illustration (NumPy 3D, Python matcher, staged swap; Eric D3: keep). eric-mimic2 added the caption sentence.
7. **Fig 5 heading "LUC3D reveals a geometric social motif"** and Discussion L196 sit on the dataset's own 3D, not LUC3D output. Eric's call on wording.
8. **From eric-mimic2's investigation, not done** (`PROVENANCE-INVESTIGATION-mimic2-2026-10-20.md`, section 3): stale datasheet copy (Aug 18; an Oct 1 copy exists), 4A synthetic enrichment objects undisclosed, 4B 60 px matching gate undisclosed, 4D deposit lacks a commit stamp and says "EXPLORATORY", "100.8 million 2D poses" are reprojections, calibration bench not reproducible (deleted /tmp inputs, no calibrat3 commit), Fig 9 has no generator, Supp Video 3 caveat and Video 4 length/build, fork defaults in `fig4_slap2m.py` / `fig6_methods.py` / `fig6_slap2m_fair.py` / `fig10_bench.mjs`.
9. **Provenance gate** (`figs/provenance_gate.py` + `provenance_manifest.json`) is written but has not been run. Expected failures if run now: `fig6_detections.json` and `fig6_recovery.json` unclassified, the 4D deposit unstamped, the Fig 3 caches until eric-mimic2's J12 stamps land.
10. **J12** (eric-mimic2, re-deriving every Fig 3 greedy cache at v1.0.5) status not logged yet.
11. `data/fig6c/fig6f_pr_switches.csv` is a Mouse-Dyad leftover of an unplaced panel. Panel F reads `data/fig6slapstale/`.
12. Code changed today and not committed: `lucid_v105.{mjs,py}`, `lucid_geom.{mjs,py}`, `timing_watch.py`, `provenance_gate.py`, `provenance_manifest.json`, `fig2_solvers_*` (v1.0.5 required, stamps, per-pair / accN, multi-pass timing), `fig2_solvers_export.py` and `fig5_views.py` (LUC3D geometry), `fig2g_retime_*.py`, `panels/fig2_02`, `fig2_03`, `fig2_04`, `fig2_16`, `fig4_11`, `fig4_14`, the run scripts in `out/md56_logs/`.
