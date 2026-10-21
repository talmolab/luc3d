# Handoff: finish the LUC3D-only b series (2026-10-20)

You are continuing a job in a long-running screen session. Work through it to the
end without detaching and without stopping to ask, except where this file says
**ASK ERIC**. Repo: `/root/vast/eric/sleap-3d-gui/scratch/repos/lucid` (branch
`eric/figs`), figures in `figs/`.

## The rule (Eric, verbatim intent)

"Make the b series the completely luc3d generated ones and not use any numpy
triangulation, that's sloppy ... otherwise it is false advertising." We publish the
code. Every 3D pose, identity, or camera placement a **b-series** figure shows must be
either:

1. **the dataset's own 3D as shipped**, or
2. **computed by LUC3D v1.0.5**: commit `2dc001fe527c4dbaad17fa171da132cfdfe010e6`, clean
   checkout `/root/vast/eric/lucid-main-md56` (`POSE_DIR=/root/vast/eric/lucid-main-md56/pose`).
   Use the app modules / `figs/lucid_geom.mjs` / `figs/lucid_v105.mjs`.

**Never** a Python/NumPy/cv2 triangulation, association, or reprojection presented as
LUC3D. Never the eric/figs working-tree app. Never an old cache.
The memory rules in `MEMORY.md` apply too (v1.0.5 only, no Python reimplementations).

## Hard guardrails

- **Do not touch the main series.** Write only `*_b` deposits/renders,
  `figs/out/b_app/`, `figs/figures/fig{1,2,3,5}b`, `figs/data/fig{1,2,3,5}b`. The main
  inputs' hashes are in `figs/out/md56_logs/B_main_inputs_before.sha256`. Run
  `sha256sum -c` on it at the end, and it must pass.
- **Do not modify `/root/vast/eric/lucid-main-md56`**: it must stay clean, or every
  driver refuses to run.
- Builds use `FIG_RENDER_REQUIRE=1`, so a missing `_b` render fails instead of silently
  falling back to an August NumPy-era render.
- Back up the tex before editing it (`figs/out/md56_logs/luc3d_newest.before_<TAG>.tex`).
  Eric's prose rules: Nature Neuro tone, no colons or semicolons in prose, no sentences
  opening with "Because", edit lightly.
- Do not promote b to the main figures. That waits for Eric's approval.
- Do not commit unless Eric asks.

## Keep the report current

`figs/figures/drafts/B-SERIES-LUC3D-ONLY-2026-10-20.md` is Eric's report. Fill in
sections 4 to 7 as each step lands: what ran, the log path, the key numbers, anything
that moved. Also add a dated line to the Log of
`figs/figures/drafts/LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md` (closes J4, J5, J8 for the b series).

## Already done (do not redo)

Read the report's sections 1 to 3. In short:
- `blender-images/hardfight_common.py` reads only `figs/out/hardfight_luc3d.npz` (LUC3D
  v1.0.5 tracker + DLT over all 36,000 HardFight frames). Its NumPy DLT and matcher are gone.
- `fig5_views.py` → `out/fig5_views_js.json`, and `fig1_bmimica_scene.py` →
  `out/fig1_bmimica_scene_b.json`, both on `lucid_geom` (LUC3D), stamped.
- `_drive.mjs` takes `LUCID_APP_ROOT` / `FIG_OUT_DIR`, asserts v1.0.5, and stamps manifests.
- v1.0.5 app exports in `figs/out/b_app/`: `fig1d_pose.json`, `fig2a_pose.json`,
  `fig2-protocol.json`, `fig2p-*.png` (the Fig 2A tiles).
- `out/fig1_hardfight_scene_b.json` and `out/fig2a_scene_b.json` are rebuilt from those poses.
- The render script is written but **not run**: `figs/out/md56_logs/run_B_luc3d_renders.sh`.

## Environment

```bash
S=/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/5a3ae376-29a1-459f-99db-64d7565dd8d8/scratchpad
NODE=/root/vast/eric/node26_env/bin/node
# headless Chromium libs (Playwright drivers):  LD_LIBRARY_PATH=$S/chromelibs/lib
# v1.0.5 serve root (symlinks + figs/session):   LUCID_APP_ROOT=$S/v105_serve
# bpy X11 libs: in the render script already (…/4d4f3317-…/scratchpad/bpylibs)
# Python for figures: figs/.venv/bin/python   Blender: figs/blender-images/bpyenv/bin/python
```
If `$S` was cleaned up, rebuild it. Chromium libs: `mamba create -p $S/chromelibs -c
conda-forge nspr nss atk-1.0 at-spi2-atk at-spi2-core xorg-libxcomposite
xorg-libxdamage xorg-libxfixes xorg-libxrandr libxkbcommon alsa-lib`. Serve root: symlink
each entry of `lucid-main-md56/*` into `$S/v105_serve/`, plus
`$S/v105_serve/figs/session -> figs/session`. Always give each Playwright driver its own
`PORT` (for example 8313 and up). `_drive.mjs` refuses a port that is already serving.

## Steps

### 1. Renders
```bash
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs
bash out/md56_logs/run_B_luc3d_renders.sh > out/md56_logs/B_luc3d_renders.log 2>&1
```
This runs Cycles on the A40 and takes tens of minutes. When it finishes, check that
these exist and are non-empty: `blender-images/renders/{idswitch_render_hardfight_b,
fig1d_pose_b,fig1d_rig_b,fig2a_pose_b,fig5a_upright_b}.png`,
`blender-images/renders/fig1_renders/mouse-dyad_f55701_b.png`, and
`figures/drafts/figs/lucid_idswitch_style_hardfight_b.png`. **Look at each PNG** with the
Read tool. Compare it with its base render. The animals should be in the same places
to within a few mm, not missing, and not swapped in colour. The hash check at the end
of the log must print OK for all 10 files.

### 2. Fig 1 app captures on v1.0.5
Fig 1's tracking tiles and Fig 1D's video tile (`out/after-f*-*.png`, written by
`figs/fig1_tracking.mjs`) are August working-tree captures. Re-shoot them on v1.0.5
into `out/b_app`:
```bash
LD_LIBRARY_PATH=$S/chromelibs/lib LUCID_APP_ROOT=$S/v105_serve POSE_DIR=/root/vast/eric/lucid-main-md56/pose \
  FIG_OUT_DIR=out/b_app PORT=8313 $NODE fig1_tracking.mjs > out/md56_logs/B_v105_fig1_tracking.log 2>&1
```
Read `fig1_tracking.mjs` first. If it writes anywhere other than `outDir`, or depends on
a server already running, fix that so nothing lands in `out/`.

### 3. Point the b build at the v1.0.5 app outputs
The panels read app tiles straight from `OUT` (`figs/out`):
`panels/fig2_01_protocol.py` reads `fig2p-*.png` and `fig2-protocol.json`, and the
Fig 1 panels read `after-*.png` (grep `panels/fig1_*.py` for `OUT /`).
Add a `FIG_APP_OUT` env var (default `OUT`) that only these app-capture paths use, so
the b build reads `out/b_app/`. Keep the change minimal and in the files' own style.
Also check `panels/fig1_03_reconstruction.py:145` and `panels/fig2_01_protocol.py:365`.
They `load("fig1_hardfight_scene.json")` / `load("fig2a_scene.json")` through the
variant system, and under `FIG_VARIANT=x7` that resolves to the **base** August JSONs
(`out/fig2a_scene_x7.json -> fig2a_scene.json`). Make the b build read the `_b` JSONs
(and `out/b_app/fig2-protocol.json`). For example, use a b link set derived from
`out/md56_logs/X7_links.tsv` with those entries overridden. Then confirm it in
`B_loads.tsv`: no HardFight scene, pose, or protocol file may load from a non-b,
non-b_app path.

### 4. Build Figs 1, 2, 3, 5 as the b series
Use section 3 and section 4 of `out/md56_logs/run_B_numpyfree.sh` (the build plus the
verification block). **Do not run that whole script.** Its section 1 rebuilds the scene
JSONs from the August poses, and its precheck refuses because `_b` files now exist. Put
the build into a new script, `out/md56_logs/run_B_luc3d_build.sh`, with these settings:
`FIG_TAG=b`, `FIG_RENDER_REQUIRE=1`, `FIG_APP_OUT=out/b_app`, x7's env (`FIG6F_NOEVICT`,
`SIGN_TIES_EXCLUDED`, `FIG5G_PERDIR`, `F3_TRUE_MEDIAN`, `FIG3F_CLEAN=1`,
**`FIG3F_CLEAN_TAG=_j17`**, `FIG6_SDANNCE_AGG=figs/fig10-bench/results_v105/agg`),
`FIG_VARIANT_LOG`, and `FIG_VARIANT_REQUIRE`. Every figure must exit 0 with 0 failed
panels. Then:
- `grep "\[render b\]" ` the build logs. Every render line must say `-> …_b.png`, never `BASE used`.
- Diff `data/fig{n}b/*.csv` against `data/fig{n}/`. List every CSV that changed in the
  report, with the reason. The numbers should only move where the 3D source changed:
  Fig 3D, Fig 1, the 2A tile, the 5A render. Fig 2B to 2G and Fig 3E to 3H data should be
  identical. If they aren't, find out why before going on.
- Look at every assembled `figures/fig{1,2,3,5}b/fig*b.png`.

### 5. Static scan (plan G2) over the b build's dependency path
For every script the b build ran (panels, deposit generators, Blender prep), grep for
`triangulate_batch|def triangulate|np\.linalg\.svd|cv2\.triangulatePoints|cv2\.projectPoints|cv2\.undistortPoints|fig2_measure`.
Classify each hit in the report. Allowed: scene geometry or a PCA floor fit on
LUC3D/dataset points, label placement, operations on a dataset's own shipped 2D/3D, and
baselines/scorers. Anything that triangulates or reprojects what a figure presents as
LUC3D is a failure. Fix it with LUC3D and rebuild.

### 6. Tex (`figs/figures/drafts/luc3d_newest.tex`), back it up first
- **L157, Fig 3D caption.** It currently says "Its 3D poses were reconstructed offline
  for this figure rather than by LUC3D, and the swap is drawn rather than taken from a
  tracking run." That is false for the b series. Rewrite it so the 3D poses and
  identities are LUC3D's (v1.0.5, HardFight) and only the exchanged identities in the
  top camera are drawn for illustration. Keep Eric's sentence structure.
- **L354, Blender Methods.** Add one plain sentence saying which renders show the
  dataset's own 3D (Fig 1C SLAP-2M tile and Mouse-Dyad tile poses, Fig 3C, Fig 4A,
  Fig 5A poses) and which show LUC3D's reconstruction (Fig 1D, Fig 2A, Fig 3D). Use the
  report's audit table to check each one.
- Grep the tex for any number taken from a panel whose data changed in step 4, and
  update it.
- **ASK ERIC** before any change that goes beyond these. The tex places `figs/figN.pdf`
  (the main series), and the b series is not placed until Eric promotes it.

### 7. Finish
- `sha256sum -c figs/out/md56_logs/B_main_inputs_before.sha256` must pass, and
  `git status` must show nothing under `figs/figures/fig{1,2,3,5}/` or `figs/data/fig{1,2,3,5}/`.
- Update `MODULES.md` only if you touched app modules (you should not have).
- Report sections 4 to 7 complete. Set Status to DONE, or BLOCKED with the reason.
- Final message: one short summary for Eric with the report path, what moved, and
  anything waiting on him.
