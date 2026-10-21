# Handoff 2026-10-21: number audit done, tex fixed, b Figs 1/2/3/5 promoted (NOT committed)

Written ~01:35 UTC by the session that ran the number audit. Give this to a fresh Claude Code session in the `lucid/figs` repo.

## What Eric wants next

Finish the b series for every figure, promote it to main, then **commit and push `eric/figs`**. Eric approved the commit and push on the condition that no placed figure uses NumPy triangulation. Every number in `figures/drafts/luc3d_newest.tex` must match the placed figures.

## Done today

1. **Number audit of the tex.** About 300 claims were traced to the placed data.
   - Report: `figures/drafts/NUMBER-AUDIT-2026-10-20.md`. It ends with the list of fixes applied.
   - Per-section tables: `figures/drafts/number-audit/{A..E}_*.md`.
   - No large number was wrong. The issues were rounding, wording, and Fig 3 being one build behind.
2. **Tex fixes, 2026-10-21 ~01:25.** Backup: `out/md56_logs/luc3d_newest.before_numberfix_2026-10-21.tex`. Every edit was grep-verified after saving. Eric's editor can overwrite edits, so re-grep before relying on them.
   - L409: 0.993 and 0.988 (were truncated as 0.992 and 0.987).
   - L417: now says "comparison of cross-view IDF1". 12 vs 4 re-checked (exact Wilcoxon P = 0.016).
   - L200: greedy misgroups fewer frames "when pooled over all sessions". It is false at 3×5 and 4×3.
   - L103: "2D poses reprojected from the 3D", and "six analyzed cameras".
   - L301: RANSAC ratio "measured in an earlier sitting".
   - Fig 5G caption: the curves use 32 (male) and 13 (female) sessions.
   - Fig 5 caption: "The box plots in D to F summarize one value per session" (no points are drawn).
   - **Fig 1 caption re-lettered** to match the panels: A arenas, B pipeline, C re-ID, D 3D, E capability table (new sentence). All text references follow the new letters: L109 → 1C, L111 → 1D, L113 → 1A + 1E, Datasets L245 → 1C and D, Blender Methods L354 → 1A and D (dataset 3D), 1D (LUC3D).
   - Eric kept "5 to 60 minutes" (L239) as is.
3. **Checked the b series for Figs 1/2/3/5** (built 10-20 ~21:00 by eric-mimicc, report `figures/drafts/B-SERIES-LUC3D-ONLY-2026-10-20.md`).
   - CSVs are byte-identical to main except `data/fig3/fig3e_head_to_head.csv`, which is the J17 timing the tex quotes.
   - Every LUC3D input in `out/md56_logs/B_loads.tsv` is stamped 2dc001fe. The unstamped ones are not LUC3D output:
     - `fig4_anipose_jspad` is the Anipose baseline.
     - `fig5_upright` and `fig5_rear_coupling_2animal_perdir` are the dataset's 3D.
     - `fig3_runtime_b3` gives only the analytic counts in 3B.
     - The SLAP-2M quality cell was re-derived at 2dc001fe in `provenance_rederive_b3.json`.
   - The grep scan for triangulation calls found only comments, plus `hardfight_common.py:222`, an SVD floor-plane fit on LUC3D's own points for the render.
   - Fig 2 and Fig 3 captions match the b PNGs panel by panel.
4. **Promoted b Figs 1, 2, 3 and 5 to main** by copying byte-for-byte with the `b` dropped from file names (`fig1ba_render.pdf` → `figures/fig1/fig1a_render.pdf`), plus `data/fig{n}b/*.csv` → `data/fig{n}/`. Every copy was cmp-verified.
   - Backup of the previous main: `out/md56_logs/main_before_b_promote_2026-10-21/`.
   - `data/fig5` keeps its main-only `fig5s_*` and `fig5g_rear_coupling.csv`.
   - The `figures/fig{1,2,3,5}b` and `data/fig{1,2,3,5}b` folders are left in place.
   - **Nothing is committed or pushed.**

## The b build for Figs 4, 6 and 7 is NOT ready to promote

Script: `out/md56_logs/run_B_luc3d_build_467.sh`. Output: `run_B_luc3d_build_467.out`. Built by eric-mimicc at 01:31-01:33. All panels built, but **it ended `B467 FAILED: main figures changed`**:

1. **Fig 4D would be wrong.**
   - `data/fig4b/fig4b_idf1_by_difficulty.csv` differs from the placed `data/fig4`.
   - The build loaded `fig9_slap2m_lite_bvis5_notailscore.json` (the Oct 8 file, not a b link). This is audit finding F1: it differs by up to 0.18 IDF1 per session.
   - The placed CSV and the tex match the `_md56` (v1.0.5) version, `out/fig9_slap2m_lite_bvis5_notailscore_md56.json`.
   - **Fix the link to the `_md56` file and rebuild Fig 4b. Do not promote the current fig4b.**
2. **Two other loads didn't go through b links:** `fig4_recovery_proofread2d.json` (4B and 4C occlusion) and `fig6_detections_proofread_notail.json`. Check each one: is it the intended file, and is it free of NumPy triangulation? The script meant 4C to read `fig6_detections_proofread_notail_nopy.json`.
3. **`data/fig6b/fig6h_sdannce_cameras.csv` differs.** Panel H is not placed, so this is harmless. Note why it differs (probably the v1.0.5 s-DANNCE run).
4. **Main `figures/fig6/fig6f_axes.json` was modified** by that build, which tripped its own guard. Check the diff. If it isn't wanted in main, `git checkout` only that file. It was already dirty on 10-18, so look before reverting.
5. Fig 7b's CSVs match main (no DIFF lines). Fig 7 is the calibration figure (placed as Supp `fig8.pdf`).

## Next steps, in order

1. Ask or tell eric-mimicc that its 467 build failed (items 1, 2 and 4 above), so both sessions aren't fixing the same thing.
2. Rebuild Fig 4b with the `_md56` IDF1 deposit. Confirm every `data/fig{4,6,7}b` CSV equals main, except changes that are explained and that the tex agrees with.
3. Run the same NumPy check on the 4/6/7 loads (`out/md56_logs/B467_loads.tsv`): every LUC3D input stamped 2dc001fe, everything else a dataset, baseline or scorer.
4. Compare the Fig 4, Supp 6 and Supp 8 captions against the b PNGs.
5. Promote 4/6/7 the same way as above, backing up first.
6. **Mapping check.** The tex includes `figs/fig{1..9}.pdf` from Overleaf. In the repo, `figures/fig7` = tex Fig 8 (calibration) and tex `fig7.png` = the GUI screenshot. Use the repo's `assemble.py` naming when promoting, not the tex numbers.
7. Commit on `eric/figs`, then push.
   - **Include:** the promoted `figures/` and `data/`, the tex, the drafts reports (`NUMBER-AUDIT-2026-10-20.md`, `number-audit/`, `B-SERIES-LUC3D-ONLY-2026-10-20.md`, this handoff), and the modified code (`git status`): `hardfight_common.py`, `lucid_geom.*`, `_drive.mjs`, scene scripts, panels, `provenance_gate.py`, and others.
   - **Leave out:** large binaries (renders, `.npz`, videos), `figures/fig*b` / `data/fig*b` (variants, never committed before), `data/fig3c` / `figures/fig3c` (superseded), screenshots in `docs/`.
   - Check `git diff --stat` and `git status` before committing. End the message with the `Co-Authored-By` line.

## Don't

- Don't run anything heavy while a timing sitting may be running on another host.
- Don't edit the tex beyond what's needed. Grep-verify every edit, because Eric's editor saves over changes.
- Don't trust an agent's audit claim without re-checking it. The audit had the L417 switch direction reversed (actually 6 better / 2 worse by switches).

## Open decisions for Eric (from the audit, untouched)

- **SLAP-2M tail:** weight 0 in matching, but the tail still enters track births and triangulation.
- **J17 timing sitting:** formally `valid=false`, because of the VS Code server and the Claude CLI at 0.578 core.
- **Strains:** none of the listed strains is agouti, yet 42 sessions have agouti mice.
- **Datasheet:** the Overleaf copy may be the stale Aug 18 one.
- **Claims with no data behind them:** Panopticon (9.997 vs 9.998 ms), the 2D model details, the calibration bench inputs, and the start-up compilation sentence.
