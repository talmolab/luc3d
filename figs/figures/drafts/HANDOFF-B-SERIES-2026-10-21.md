# Handoff: LUC3D-only b series (2026-10-20 → 10-21, eric-mimicc-0-1)

Repo `/root/vast/eric/sleap-3d-gui/scratch/repos/lucid`, branch `eric/figs`, figures under
`figs/`. **Nothing from this thread is committed.** The full narrative is in
`figs/figures/drafts/B-SERIES-LUC3D-ONLY-2026-10-20.md`, sections 1-9. This file is the
short version plus what is still open.

## The rule (Eric)

"Get rid of all the numpy triangulation from all the figures … use luc3d triangulations and
rerender everything", "make a new b series … so you dont overwrite what we have".

Every 3D pose, identity or camera placement a figure shows is either:
1. the **dataset's own 3D**, or
2. computed by **LUC3D v1.0.5**: commit `2dc001fe527c4dbaad17fa171da132cfdfe010e6`, clean checkout
   `/root/vast/eric/lucid-main-md56`, `POSE_DIR=/root/vast/eric/lucid-main-md56/pose`.

Never Python/NumPy/cv2 geometry presented as LUC3D. Do not modify the md56 checkout; every
driver refuses a dirty one.

## State right now

- **NumPy triangulation is out of every figure.** The last trace, the triage block of
  `fig4_detections.py`, is deleted.
- **The b series is complete: `figs/figures/fig{1..7}b/`, `figs/data/fig{1..7}b/`.** Every panel
  builds, with 0 failures.
- **Main Figs 1, 2, 3, 5 are now byte-identical to b.** Another session promoted them on
  2026-10-21 ~01:32 UTC (not this thread). Backup:
  `figs/out/md56_logs/main_before_b_promote_2026-10-21/`. That is why git shows
  `figures/fig{1,2,3,5}/*` and `data/fig3/fig3e_head_to_head.csv` modified.
- **Main Figs 4, 6, 7 are NOT promoted.** Their data equal b except Supp 6H (see below). Their
  PDFs differ only because they were rebuilt.
- **Tex** (`figs/figures/drafts/luc3d_newest.tex`): Eric is editing it in parallel (he re-lettered
  Fig 1 to A arenas … D triangulated 3D). This thread changed only the Fig 3D caption and one
  Blender-Methods sentence. **Seven more fixes are proposed, not applied (see Open 1). Ask Eric
  before editing the tex.**

## Where each figure's 3D now comes from

| Figure (tex letters) | Source |
|---|---|
| 1D, 2A, 3D (HardFight renders) | `figs/hardfight_luc3d.py` runs LUC3D's tracker + DLT over all 36,000 frames → `out/hardfight_luc3d.{npz,json}`. `blender-images/hardfight_common.py` now only reads it: its NumPy DLT and Python matcher are deleted, and overlays go through LUC3D `reprojectPoint`. The floor alignment is fitted to LUC3D's cloud (`renders/hardfight_alignment_b.json`). |
| 1D pose, 2A two-anchor pose | v1.0.5 app exports: `out/b_app/fig1d_pose.json`, `fig2a_pose.json` |
| 1C re-ID tiles, 2A tiles | reshot on the v1.0.5 app → `out/b_app/` (Fig 1 tracking identical to August) |
| 1A Mouse-Dyad tile, 5A | dataset pose; camera alignment / projections via `figs/lucid_geom.{mjs,py}` (LUC3D). `out/fig1_bmimica_scene_b.json`, `out/fig5_views_js.json` |
| 1A SLAP-2M tile, 3C, 4A, 5B-G | dataset's own 3D (allowed) |
| 2B-G, 3E-H, 4D, Supp 6 | LUC3D v1.0.5 JS deposits (earlier plan work, J2/J3/J12/J17) |

## Code changed in this thread (all uncommitted)

- **Geometry → LUC3D:**
  - `lucid_geom.mjs/.py`: new `project_pinhole` mode.
  - `blender-images/hardfight_common.py`: rewritten.
  - `blender-images/idswitch_common.py`: LUC3D identities, no re-linking.
  - `fig1_bmimica_scene.py`: alignment via `lucid_geom`.
  - `blender-images/fig5a_scene.py`: reads `fig5_views_js.json`.
  - `fig4_detections.py`: part B deleted. Backup `out/md56_logs/fig4_detections.before_partB_removal_2026-10-21.py`.
- **Series plumbing:**
  - `src/style.py` `tagged_render()` plus `FIG_RENDER_REQUIRE=1`.
  - `src/data_loader.py` `APP_OUT` / `FIG_APP_OUT`.
  - Panels `fig1_00`, `fig1_02`, `fig1_03`, `fig2_01`, `fig3_16`, `fig5_05` read tagged renders / app captures.
  - `assemble.py`: `(1,"b")` footer-free.
  - `blender-images/hyp_fig_prep.py`: tagged raw-frame path.
  - The previous session also changed `_drive.mjs` (`LUCID_APP_ROOT`, `FIG_OUT_DIR`, v1.0.5 assert + stamp).
- **Stamps:**
  - `fig1_hardfight_scene.py` and `fig2a_scene.py` carry the v1.0.5 stamp forward.
  - `out/fig3_headtohead_clean_b3_j17.json` is stamped (metadata only; backup in `out/md56_logs/j17_hh_backup_2026-10-21/`).
- **Bugs fixed:**
  - `panels/fig4_11_idf1_by_difficulty.py` read the **pre-v1.0.5** Oct 8 deposit under any variant except md56/x7; `b` added.
  - `panels/fig6_07_pr_switches.py` overwrote the **main** `figures/fig6/fig6f_axes.json` on every tagged build. It now writes only when untagged (restored from git), and the missing `import os` was added.
  - `idswitch_fig_style.py` now registers the bundled Liberation Sans (this host has none, so the legend clipped).
- **Provenance:**
  - `provenance_manifest.json` classifies every b input.
  - `provenance_gate.py` takes `--out` and also scans `render_path_scripts` (Blender prep).

## Build scripts and logs (`figs/out/md56_logs/`)

- `run_B_luc3d_renders.sh` → `B_luc3d_renders.log`: the seven `_b` renders (Cycles, A40). Ends with a main-input hash check.
- `run_B_luc3d_build.sh` → `run_B_luc3d_build.out`: Figs 1, 2, 3, 5.
- `run_B_luc3d_build_467.sh` → `run_B_luc3d_build_467.out`: Figs 4, 6, 7. Fig 4 was rebuilt after the `fig4_11` fix; log `B_fig4.log`.
- Link set `B_links.tsv` (x7's links + 8 overrides, all required); loads `B_loads.tsv`, `B467_loads.tsv`.
- Gate outputs `provenance_gate_b.json`, `provenance_gate_x7.json`.
- `run_B_numpyfree.sh` is **superseded, do not run** (built from the August app poses).

**Build env** (copy from the scripts): `FIG_TAG=b FIG_VARIANT=b FIG_RENDER_REQUIRE=1
FIG_APP_OUT=out/b_app FIG3F_CLEAN=1 FIG3F_CLEAN_TAG=_j17 FIG6F_NOEVICT=stale0_dist25
SIGN_TIES_EXCLUDED=1 FIG5G_PERDIR=1 F3_TRUE_MEDIAN=1
FIG6_SDANNCE_AGG=figs/fig10-bench/results_v105/agg`, plus `FIG_VARIANT_REQUIRE` = column 1 of `B_links.tsv`.
Python for figures: `figs/.venv/bin/python`.

**Environment quirks:**
- Blender is `figs/blender-images/bpyenv/bin/python` (bpy 5.2). It needs
  `LD_LIBRARY_PATH=/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/4d4f3317-8497-49a9-8c88-e58530b1c39e/scratchpad/bpylibs`
  (6 X11 libs symlinked from `/root/miniforge3/pkgs/*/lib`; rebuild if /tmp is cleaned).
- ffmpeg: `PATH=/root/vast/eric/luc3d-bench/video_env/bin:$PATH`.
- Playwright drivers need `LD_LIBRARY_PATH=$S/chromelibs/lib` and `LUCID_APP_ROOT=$S/v105_serve`,
  where `S=/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/5a3ae376-29a1-459f-99db-64d7565dd8d8/scratchpad`.
  The recipe to rebuild those is in `HANDOFF-B-SERIES-LUC3D-2026-10-20.md`.
- Bench env (cv2, toml): `/root/vast/eric/luc3d-bench/lp3d_env/bin/python`.

## What b changes vs the earlier main figures

- **Fig 3D:** LUC3D's identities. The pair is the same, but A/B (blue/orange) swap, and one post-contact trail ends at frame 21244 instead of 21736.
- **Fig 2A 3D tile:** the v1.0.5 two-anchor solve moves keypoints up to 18 mm.
- **Fig 3F timing = J17** (0.28 ms, 14×), which is what the tex quotes. The old main had stale T1 values.
- **Supp 6H:** v1.0.5 s-DANNCE run (0.983 vs 0.995 at 2 cameras). Not placed, not quoted.
- **Everything else is data-identical to the old main.**

## Open items for Eric

1. **Tex fixes found by the four audits (proposed, NOT applied).**
   - L409 "0.993 for SLEAP and 0.988 for ByteTrack" → **0.992 / 0.987**. The panel plots these; the tex took a stale summary key.
   - L301 "more than 100 times slower" → about **80** (82×).
   - L269 "all from one run of the application's own solvers" → "computed with the application's own solvers". 2B-G come from four runs, and 2F/2G include Anipose.
   - L285 "1,000 per session" → "up to 1,000".
   - L285 "roughly doubles its cost" → drop the factor (indirect estimate is about 3×).
   - L285 "No other process of ours ran": the J17 watcher saw editor/Claude activity up to 0.58 core, and the sitting is `valid: false`. Reword, or accept.
   - L285 the 4×6 bar description: the two ends also use different per-hypothesis rates (83.9 vs 111 µs).
   - Unverifiable from repo data, not necessarily wrong: SLAP-2M corpus counts (74 / 15.6 M / 1-4 mice), Mouse-Dyad 50.4 M frames, ~20 M 3D / ~100 M 2D, in-browser 16,030 / 14,694 fps, "18 pairings" (b data hold 17 in the display sessions), several calibration-Methods numbers (882/378 frames, "about 0.1 px", "three of six draws", 9,029 / 12,621).
2. **Promote Figs 4, 6, 7?** 1, 2, 3, 5 already are. Use the same pattern: back up main first.
3. **Provenance gate still fails, on pre-existing commit-stamp gaps (not NumPy):**
   - `fig3_runtime_b3.json`
   - `md56main/fig3_quality__…f7733dbf_b3.json`
   - `fig9_slap2m_lite_bvis5_notailscore_md56.json` (4D)
   - `stale_sweep_slap2m.json` (6F)
   - `fig10-bench/results_v105/agg` (6G)
   - two unclassified Fig 4 deposits (`fig6_detections.json`, `fig6_recovery.json`; the latter's generator `fig4_recovery.py` does not triangulate)

   The G2 text hit on the `panels/fig5_05_upright_views.py:24` docstring is stale wording ("cv2.projectPoints"); the code uses LUC3D.

   Run:
   ```
   python3 figs/provenance_gate.py --links figs/out/md56_logs/B_links.tsv \
     --loads figs/out/md56_logs/B_loads.tsv --out figs/out/md56_logs/provenance_gate_b.json
   ```
   (from `figs/`).
4. `out/fig6_detections.json` (the other Fig 4 detection panels) is still the August file, with unplotted NumPy triage fields. It regenerates slightly differently with current code. Eric said not to chase it.
5. **Cleanup not done:**
   - `fig2_measure.py` (the NumPy DLT), `j3_alignment_check.py` and `fig4_idf1_3d.py` are still outside `legacy/`. No figure uses them.
   - `fig4_detections.py` writes `detection_pool=keeptrack_h5s` even on proofread runs (a label only).
6. **Commit:** nothing from this thread is committed. If committing, include the code changes above, the b data and figures, `out/` deposits stay gitignored, and the report and this handoff.
