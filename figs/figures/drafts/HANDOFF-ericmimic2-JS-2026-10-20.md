# Handoff: eric-mimic2-0-6, LUC3D JavaScript pass, 2026-10-20

**Goal.** Fig 3D, the Fig 1 / Fig 2A app captures and the deposit metadata all reflect LUC3D v1.0.5's JavaScript, not Python and not the August working tree. Also fix the Fig 3 text items.

**Estimate.** 3 to 5 h of work. Machine time is small (one 300-frame HardFight window, plus Playwright captures).

## Read first

1. `figs/figures/drafts/LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md`: rules R1 to R5, gates G1 to G3, items J2 to J15, decisions D1 to D5. **This file is the source of truth. Log every step there.**
2. `figs/figures/drafts/CONSISTENCY-PLAN-2026-10-19.md`: rules 1 to 9 still hold.

## Ground rules

- **Do not assume. Verify, then act.** If a fact is not in a file you read, ask Eric.
- LUC3D = `/root/vast/eric/lucid-main-md56` at `2dc001fe527c4dbaad17fa171da132cfdfe010e6`, clean. Node drivers use `LUCID_ROOT` / `POSE_DIR` pointing there. App captures serve that checkout.
- Python never triangulates, reprojects, undistorts, tracks or assigns identities for anything shown as LUC3D (plan R2, R3).
- Every new deposit or exported pose file carries the R4 stamp (`lucid_root`, `lucid_commit` read at run time, `driver`, `generated_by`). Scripts refuse to run off `2dc001fe` or on a dirty checkout.
- Never overwrite an input a figure reads. Write new names, back up what you change, diff.
- You own the Fig 3 text (L144-160, L285-289 and the Fig 3 caption). Everything else in `luc3d_newest.tex` belongs to eric-mimicc or Eric. Back up the tex before your first edit (`figs/out/md56_logs/luc3d_newest.before_mimic2_JS_2026-10-20.tex`). Grep-verify after every edit.
- Tex style: short plain sentences, no semicolons or colons in prose.
- Commit only when Eric asks.

## Environment

- Node: `export PATH=/root/vast/eric/node26_env/bin:$PATH`. Tracker driver: `figs/fig3-bench/fig3_bench.mjs` with `LUCID_ROOT=/root/vast/eric/lucid-main-md56` (it imports `$LUCID_ROOT/pose/tracker.js`). Figures: `figs/.venv/bin/python`.
- App driver: `figs/_drive.mjs`. `serve()` starts `python3 -m http.server` with `cwd: repoRoot`, and `repoRoot` is the **eric/figs working tree** (`_drive.mjs:20,36`). `SESSION_REL` defaults to `figs/session` (the trimmed 8-camera HardFight clip).
- HardFight: `_bugdata/20260605_133431-HardFight/` (per-camera `*_selective_unfiltered_preview.slp`, `calibration.toml`), video in `_bugdata/20260605_133431-HardFight_reencoded/`. 8 cameras, 60 fps, 3 mice. **It ships no proofread 3D** (`blender-images/hardfight_common.py:8`). Every 3D pose drawn from it today is built by that Python module.

## Before starting: ask Eric

- **D3** Fig 3D: a real switch found in a v1.0.5 run, or v1.0.5 3D with a swap drawn on it and labelled illustrative in the caption.
- **D4** reshoot Fig 1 tiles and Fig 2A on v1.0.5 (recommended yes).
- **D5** Fig 3E caption says box plots, the panel draws bars: change the caption (recommended) or the panel.
Record the answers in the plan.

## Tasks, in order

1. **J11, wrong metadata.** `out/fig7_variant_best_c6b3.json` fields `luc3d_is_experimental`, `provenance` and `slap2m_luc3d_is_substituted` name `figs/fig8-bench/xv_experimental.js`. The cells come from `fig8_methods_50_b3.json` cell `sync_stale20_dist25`, which is v1.0.5 (`lucid_root` md56, `lucid_commit` 2dc001fe, `experimental_tracker` null, fixed 2026-10-20 as X6).
   - Fix the generator (`figs/fig6_variant_best_rebuild.py`) so it writes the source deposit's `lucid_root` / `lucid_commit` instead of the fixed fork text.
   - Patch the deposit's metadata only. Back it up to `figs/out/md56_logs/x6_backup_2026-10-20/` first, and assert every cell is unchanged.
   - Check `fig7_fair_baselines_c6b3nd.json` and `fig7_variant_best_c6b3.json` for any other field that names the fork.

2. **J12, missing commit stamps.** The exhaustive caches, the `headtohead_b3` greedy caches and `out/fig2_cams_identity_b3.json` record no commit. Their v1.0.5 status rests on `out/md56_logs/run_B3Q.sh:20-21`, which asserts the checkout is `2dc001fe` and clean.
   - Read that assert and confirm it ran before these caches were written: check the log timestamps against the cache mtimes.
   - Add `lucid_root` / `lucid_commit` with a `stamp_source` note naming the run script.
   - Add the R4 refusal (commit + clean check) to `figs/stale_sweep_slap2m.py` and `figs/stale_ab_slap2m.py`, which require `LUCID_ROOT` but do not assert the commit.

3. **J9, NumPy fields in the Fig 4C deposit.** `figs/fig4_detections.py` (L76, L256) runs a NumPy `triangulate_batch` for "triage" fields (`signal`, `spearman`, `capture_*`). `panels/fig4_06_detection_quality.py:111-157` does not plot them.
   - Remove that section from the generator, or port it to v1.0.5 JS.
   - Grep the tex to confirm none of those values is quoted.
   - Do not regenerate the deposit unless the plotted fields would change. Show they do not.

4. **J5, Fig 3D (identity-switch illustration).** Today `blender-images/idswitch_fig_prep.py` uses `hardfight_common.py`:
   - `triangulate_point` (L155-167) is a NumPy SVD DLT;
   - `associate_frame` (L207) is a Python cross-view matcher;
   - the swap is staged by swapping one view's overlay (`idswitch_common.py:1-5`).

   Replace both the 3D and the identities with LUC3D v1.0.5 output on the same HardFight window:
   - Run `fig3_bench.mjs` (`LUCID_ROOT` md56) on the window's frames from the per-camera `.slp` files, or drive the app served from the v1.0.5 checkout (Track All, Triangulate All) and export its `points3d` and identities, as `fig1d_pose_export.mjs` does.
   - Stamp the export (R4).
   - Feed it to `idswitch_fig_prep.py` in place of `triangulate_point` / `associate_frame`.
   - Show the switch per D3. If D3 is "real switch", search the v1.0.5 output for one and record its frame. If there is none, ask Eric before staging anything.
   - Re-render, rebuild fig3c into a new tag, and check by eye.
   - Also check whether `hardfight_common.py`'s arena alignment (a NumPy triangulation of sample frames to fit the floor plane, L26-27, L276) feeds anything shown as LUC3D. If it only places the floor of a render, classify it as scene geometry for eric-mimicc's manifest (J10). Otherwise port it too.

5. **J8, app captures on v1.0.5** (per D4). Fig 1 tracking tiles (`figs/fig1_tracking.mjs`), Fig 1C pose (`figs/fig1d_pose_export.mjs`) and Fig 2A tiles (`figs/fig2_protocol.mjs`) all serve the eric/figs working tree.
   - Add an opt-in `APP_ROOT` to `_drive.mjs`, so `serve()` uses `cwd: APP_ROOT`. Point it at `/root/vast/eric/lucid-main-md56`, which must also be able to reach the session files. Check how `SESSION_REL` resolves and copy or link the trimmed session in without modifying the checkout's tracked files.
   - Assert the commit before capturing, and record it in `fig1.json`, `fig2-protocol.json` and `fig1d_pose.json`.
   - Rebuild Fig 1 and fig2c into new tags. List what changed visually and in the JSON (tracked group counts, poses).
   - Also resolve the Fig 1 lettering. `assemble.py` LAYOUT (a = render … e = tool table) disagrees with the caption (A = association … D = rigs, no E). Read the shipped `figs/figures/fig1/fig1.pdf`, report which is right, and ask Eric before changing either.

6. **Fig 3 text.**
   - Methods (around L289) says the sweep samples "twelve values of r". The deposit `fig3_sweep50__distanceThreshold25-stale20-sync_e508a7ab_framematched_b3` has 20 corr3d cells (0 to 24, including 0.02). Read which values `panels/fig3_05_sweep.py` draws, and make the sentence match.
   - Fig 3E caption vs panel, per D5.
   - Check every Fig 3 Methods sentence about how a LUC3D number was made against its generator (plan G3), and log it.

## Done means

- J5, J8, J9, J11 and J12 are ticked in the new plan, each with its file, commit stamp and diff. D3, D4 and D5 are recorded.
- Fig 3D's 3D poses and identities are v1.0.5 output, stamped. No Python triangulation or association is behind any panel shown as LUC3D.
- Tell eric-mimicc in the plan's log when you are done, since its final build (J15) waits on you.
