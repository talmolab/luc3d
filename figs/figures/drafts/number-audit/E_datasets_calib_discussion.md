# Audit E: Discussion, Methods GUI/Datasets/Acquisition/Calibration, Supp calibration/models/Panopticon, Fig 8/9 captions, datasheet

(written incrementally; read-only audit, 2026-10-20)

## Figure mapping
- tex `figs/fig8.pdf` = repo `figs/figures/fig7/fig7.pdf` (Sep 19 21:55). Layout in `assemble.py` LAYOUTS[7] = a slap8 CDF, b slap8 per-camera, c md10 CDF, d md10 per-camera, e calib18 CDF, f calib18 per-camera, g mechanism, h runtime, i ground truth -> matches the Fig 8 caption A-I. Plotted CSVs `data/fig7/fig7*.csv` (Sep 19 21:54) from deposit `out/fig7_calibration.json` (Sep 17 04:43, `opencv = 4.13.0 (both detectors)`). No `fig8.pdf` file exists anywhere in the repo; FIGURES-REPORT-2026-10-20 says the tex's fig8.pdf is repo `figures/fig7`.
- tex `figs/fig9.pdf` = repo `figs/fig9.pdf` (Oct 5). No generator or deposit in the repo (confirmed: no panel script, no out/ json).
- tex `figs/datasheet_combined.pdf`: the copy beside the tex (`figures/drafts/figs/datasheet_combined.pdf`) is Aug 18 (17,181 B); `figures/datasheets/datasheet_combined.pdf` is Oct 1 (17,752 B).

## Calibration (Supp Calibration benchmark L431-435, Supp results L445-453, Fig 8 caption L473)

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 445 | MD rig median calibrat3 0.07 / Anipose 0.09 | data/fig7/fig7ace_error_cdf.csv md10 p50 | 0.0683 / 0.0894 | OK | |
| 445 | SLAP rig 0.10 / 0.32 | same, slap8 | 0.1018 / 0.3183 | OK | |
| 445 | 18-cam 0.21 / 1.28 | same, calib18 | 0.2119 / 1.2777 | OK | |
| 445 | lower at median and p95 in all 31 cameras | data/fig7/fig7bdf_per_camera.csv | 31/31 cameras lower on both | OK | 8+5+18=31 |
| 447 | six-param -> Anipose model 0.212 -> 0.868 | fig7g_mechanism.csv median_px_all | 0.2119 -> 0.8681 | OK | |
| 447 | no rejection 0.252 | same | 0.2519 | OK | |
| 447 | intrinsics frozen 1.235 | same | 1.2355 | OK | |
| 447 | rigid-board term no measurable effect | same | 0.21186 vs 0.21187 | OK | |
| 447 | held-out frames change every config by < 0.004 px | same, all vs heldout | max diff 0.0037 (intrinsics-fixed) | OK | borderline but true |
| 447 | calibrat3 faster on MD rig, slower on other two | fig7h_runtime.csv total_s | md10 177.9 vs 210.0; slap8 261.6 vs 229.1; calib18 499.1 vs 161.0 | OK | timing sittings unlogged (CONSISTENCY-PLAN T3); "each tool run on its own on a 64-core machine" (L435) UNVERIFIABLE |
| 449 | equal frames lowered Anipose median by ~0.1 px on 18-cam | data/fig7/fig7s3_equal_frames.csv | 1.252 -> 1.133 (-0.12) | OK / MISMATCH-METHOD | this control is a 2026-09-29 RERUN on a re-transcoded 18-cam video, scored on 652,540 obs, not the 645,451-obs set of panel E. CSV header says "compare arms WITHIN this file". Text presents it as the same set |
| 449 | same reference camera had no effect | same | 1.252 -> 1.252 | OK | |
| 449 | calibrat3 median remained less than half of aniposelib's | same | 0.188 vs 1.131-1.133 (~1/6) | OK | understated |
| 433 | Anipose median 2,606 frames/camera on 2022-10-07 SLAP | out/fig7_calibration.json slap8.timing.anipose.frames_per_cam | median of [2483,979,2626,2593,2613,2606,2611,2606] = 2606 | OK | |
| 433 | 623 on 18-cam | calib18.timing.anipose.frames_per_cam | 623 | OK | |
| 433 | calibrat3 sampled 882 and 378 | timing.calibrat3_800.detectionPerView medians | 882 / 378.5 | OK (378.5 -> 378 rounds down; 379 if round-half-up) | |
| 433 | sampling target 800 -> 867 to 1,003 frames per session | min frame counts per session (cv2) / integer stride | slap 900,923,867,914; md 1000,1003,904,905; calib18 900 | OK | |
| 431/473 | 8 cams 1280x1024, 4 SLAP sessions; 18 cams 1680x1200, 1 session 1,800 frames; 5 MD cams, 5 sessions | fig7_calibration.json datasets.*.size/cameras/recordings | as stated; calib18 totalFrames 1800 (ablation meta says frames_total 1799) | OK | |
| 473 | SLAP rig 9,029 frames over 4 sessions | /root/vast/eric/calib-bench-b/inputs/slap8 videos (cv2 frame count) | 2701+2768+1733+1827 = 9,029 | OK | |
| 473 | MD rig 12,621 frames over 5 sessions | /root/vast/eric/calibration_test/Eric_calibration_videos (min over cameras) | 2998+3009+2998+1809+1807 = 12,621 | OK | |
| 431/473 | 8x11 ChArUco, 24.0 mm squares, 18.75 mm markers, 4x4 (1000) dict | *_cboard.toml in MD calibration folders | board_x 8, board_y 11, 24, 18.75, 4 bits, 1000 | OK | |
| 433 | both tools on OpenCV 4.13.0 | fig7_calibration.json `opencv` | "4.13.0 (both detectors)" | OK | fig7s4 header notes the earlier published version used OpenCV 5 for Anipose; placed CSVs are the unified 4.13 re-score |
| 451 | synthetic: focal 0.05% vs 2.20% | fig7i_ground_truth.csv d_fx | 0.05 / 2.2 | OK | |
| 451 | rig scale 0.03% vs 2.98% | scale_pct | 0.029 / 2.976 | OK | |
| 453 | Anipose failed to converge on 3 of 6 draws | data/fig7/fig7s5_anipose_divergence.csv | original + 5 repeats; diverged: original, repeat1, repeat3 | OK | |
| 453 | converged draws agree within 0.002 px | same reported_error | 0.101225 / 0.101376 / 0.103094 (range 0.0019) | OK | this is aniposelib's own reported error, not the aniposelib-scored median used in the figure |
| 435 | 64-core machine, Anipose one detection process per camera | timing.anipose.opencv_threads 8/12/3 | no machine log | UNVERIFIABLE | per CONSISTENCY-PLAN T3, sittings separate and unlogged |
| - | Reproducibility of the bench | fig7_calib_deposit_unified.py:18 BENCH=/tmp/claude-0/...calibrat3/.../bench | directory does not exist; no calibrat3 commit recorded in deposit; timing sessions also point at deleted /tmp scratchpads | CONFIRMED not reproducible from stored intermediates | inputs survive (calib-bench-b/inputs, Eric_calibration_videos), calib_b scripts prepared but never run (calib-bench-b/work has only calib18) |

## Datasets (L239-247), datasheet (L491-493)

Sources: Mouse-Dyad corpus `/root/vast/eric/BMimica/*/` points3d h5 (read directly), `out/dataset_sheets.json` (measured 2026-08-18), SLAP-2M `/root/talmolab-smb/eric/slap_2m/master_sheet.xlsx` (read directly), `dataset_sheets.py`.

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 196 | two datasets with 66 million video frames | dataset_sheets.json frames_total + SLAP master_sheet frames x 8 | 50,423,670 + 15,635,520 = 66.06 M | OK | |
| 241 | 56 sessions | BMimica session dirs | 56 | OK | |
| 241 | ~20 min per session at 150 fps | 10,084,734 / 56 / 150 | 1,200.6 s mean | OK | |
| 241 | N = 9, 4 male 5 female, 18 unique pairings | points3d track_names (ID prefix) across 56 sessions | slot 0: 4 IDs, slot 1: 5 IDs, 18 distinct pairs | OK | |
| 241 | males always track 0, females track 1 | same | no ID appears in both slots | OK | |
| 241 | 15-node skeleton (nose, L/R ears, head, neck, trunk, L/R shoulders and haunches, tail base, 3 tail + tip) | node_names | Nose, Ear_R, Ear_L, TTI, TailTip, Head, Trunk, Tail_0..2, Shoulder_l/r, Haunch_l/r, Neck = 15 | OK | TTI = tail base |
| 241 | ~10 M frames per view | dataset_sheets.json frames_per_view | 10,084,734 | OK | |
| 241 | ~20 M 3D instances | poses_3d | 20,169,468 | OK | |
| 241 | ~100 M 2D instances reprojected into five views | poses_2d_reproj = poses_3d x 5 | 100,847,340 | OK | wording here correctly says reprojected. The datasheet row "2D Poses 100.85 million" does NOT say reprojected, and the MD "Files per session" lists analysis.h5 "2D Keypoints / View", inviting a reader to read 100.85 M as proofread 2D. (Intro L103 "100.8 million 2D poses" is outside my range; known open item confirmed: count is 3D x 5 by construction in `measure_mousedyad()`.) |
| 243 | SLAP ~2.8 M 3D poses, ~22.5 M 2D reprojected into eight views | dataset_sheets.py SLAP2M (transcribed from a PNG) | 2.81 M / 22.49 M (=2.81 x 8) | UNVERIFIABLE in repo | transcribed by hand from `slap2m dataset.png`; cross-check pending (sum frames x animals from master_sheet, see below) |
| 243 | 74 sessions, 8 views, 1-4 animals | master_sheet.xlsx | 74 rows; animals 1:32, 2:35, 3:4, 4:3 | OK | |
| 243 | six levels of enrichment | master_sheet obstacle_rating | 0-5 = six levels | OK | |
| 243 | difficulty rating 1 to 7 | master_sheet difficulty | 1..7 (n 12,13,9,13,10,4,13) | OK | |
| 243 | black or white bedding | master_sheet bedding | black 44, white 30 | OK | |
| 243 | 42 multi-animal sessions | master_sheet animals>1 | 42 | OK | |
| 239/243 | strains: 8 CD-1, 4 C57BL/6J, 4 BALB/c (16 animals); coat colours "white, black, and agouti" | master_sheet white/agouti/black mouse columns; datasheet "White, Agouti, Black" | sheet has agouti mice in 42 sessions (agouti_mice sum 42) | WRONG / internally inconsistent | none of CD-1 (albino), C57BL/6J (black) or BALB/c (albino) is agouti. Either a strain is misnamed (an agouti strain, e.g. a C57BL/6J x 129 or CBA, is missing) or the coat-colour list is wrong. Also 8 + 4 BALB/c = 12 albino vs 4 black: check against how many distinct white/agouti/black animals exist. Total 16 was "provided by Eric (2026-10-01)", not derivable |
| 239 | experiments placed mice in an enclosure for 5 to 60 minutes | master_sheet duration (min) | 1.15 to 60.07 min | WRONG (lower bound) | shortest SLAP session is 1.15 min; see tmp listing for how many are < 5 min |
| 255 | SLAP 30 fps except 13 sessions at 60 fps | frames / (duration x 60) | 55 sessions ~30 fps, 13 ~60 fps, 6 sessions round to neither | OK for 13; 6 sessions unresolved | pending listing |
| 255 | resolution 1280x1024 for all three datasets | calibration TOMLs (MD, SLAP 1280x1024 in fig7_calibration.json) | MD and SLAP 1280x1024 | OK (HardFight not checked yet) | |
| 239 | Mouse-Dyad all CD-1 | datasheet "White" | consistent | OK (strain itself UNVERIFIABLE) | |
| 491 | datasheet placed | figures/drafts/figs/datasheet_combined.pdf (Aug 18) vs figures/datasheets/datasheet_combined.pdf (Oct 1) | Aug 18 copy says Mouse-Dyad sex "Male", proofreaders "?", no "Total Animals" row, SLAP proofreading "Manual + Automated" | STALE (confirmed) | Oct 1 copy has "Male, Female", 3 proofreaders, Total Animals 16 / 9 (4M,5F), SLAP proofreading "Manual". The tex's `figs/datasheet_combined.pdf` must be the Oct 1 file |

Follow-ups from master_sheet.xlsx: the 13 60-fps sessions are the 2022-10-19 block, 1.15 to ~3 min long (e.g. 10192022174304 1.15 min, 10192022174609 1.49 min, five more at 2.0-3.0 min), so "5 to 60 minutes" (L239) is wrong at the low end. The 6 sessions with no fps are 3-4-animal 2022-10-07 sessions with blank `duration` (frames ~18k, consistent with 30 fps x 10 min). Sum of frames x animals = 2,812,325 -> the "2.81 million 3D poses" is an upper bound (assumes every animal posed in every frame) and is consistent; 2.81 x 8 = 22.5 M OK.

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 243 | ~2.8 M 3D poses (SLAP) | master_sheet sum(frames x animals) | 2,812,325 | OK (upper bound) | |
| 245 | HardFight single 8-camera 3-mouse session at 60 fps | blender-images/hardfight_common.py header + _bugdata/20260605_133431-HardFight/calibration.toml | 8 cams, 60 fps, 36,000 frames, 3 mice, 1280x1024 | OK | "300-frame window" and "cohort of 12, mostly littermates" UNVERIFIABLE here (Fig 1/2/3 auditors) |
| 247 | s-DANNCE 41 sessions, 2-3 rats, 6 cams, 50 fps | tex L425 (6+6+29) | consistent | OK (not re-derived) | |

## Methods GUI (L216-232), checked against v1.0.5 at /root/vast/eric/lucid-main-md56 (HEAD 2dc001fe, tag v1.0.5)

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 218 | calibrations in TOML or JSON | import-export/file-io.js parseCalibrationTOML / parseCalibrationJSON (L236), picker accepts .toml,.json | yes | OK | |
| 220 | Define Planes: label corners, triangulate, sets origin | ui/plane-definition.js, ui/origin-definition.js, pose/origin-frame.js | present; planes are "3-8 hand-placed corners", DLT only | OK | "in two views" not checked exactly |
| 222 | guided dialog: per-node weights, per-view inclusion, cost thresholds | pose/tracker.js imports getNodeWeightArray, getTrackingThresholds, isCameraTracked from ui/settings.js | present | OK | |
| 224 | linear solve or non-linear refinement, optional rejection above a reprojection threshold | pose/triangulation-core.js (robust solve + BA, outlier-rejection loop L1373-1433) | present | OK | |
| 224 | reprojection errors green / yellow / red | ui/overlays.js errorColor: <2 px green, 2-5 yellow, >5 red; ui/info-panel.js:1521 same bands | present | OK | thresholds not stated in tex (fine) |
| 226 | right-click cycles visible / occluded | ui/interaction.js:983 right-click / ctrl-click "toggle node null" | present | OK | |
| 226 | custom instance delete by label type, view, session, frame | ui/custom-delete-ops.js ("Custom Instance Delete...", type / grouping / view filter / session) | present | OK | |
| 228 | double-click converts reprojected instance | ui/interaction.js:1202 onDoubleClickReprojected | present | OK | |
| 230 | export resolutions 480p to 2160p, reports frame count and estimated file size | ui/export-modals.js:2842/2871 (480p/720p/1080p/2160p), L2921 "Estimated File Size" | present | OK | |
| 232 | SLP 2.8 columnar session data | CLAUDE.md / lib/sleap-io 0.5.5 | yes | OK | |

## Discussion (L196-210) repeats of Results numbers

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 196 | reprojection-aided labeling cuts manual placements by more than half on a five-camera rig | data/fig2/fig2b_placements_vs_rig.csv cameras=5 | 75 -> 32.46 (aided_tau10), -57% | OK | at tau5 it is 47.7 (-36%); "more than half" holds only for the tau10 curve the Results quote |
| 196 | 66 million video frames | see Datasets | 66.06 M | OK | |
| 198 | 32x speed, 0.89 us per keypoint | data/fig2/fig2g_time_per_keypoint.csv | 28.586 / 0.885 = 32.3x; 0.885 us | OK | |
| 198 | calibrat3 lower median on all rigs | data/fig7 | 3/3 rigs | OK | |
| 200 | on equivalent frames greedy misgroups FEWER frames than exhaustive | data/fig3/fig3c_quality.csv misgrouped | 2x5: 1,390 vs 1,401; 2x6: 728 vs 1,541; **3x5: 47 vs 19; 4x3: 45 vs 22** | WRONG as an unqualified statement | greedy misgroups MORE frames than exhaustive at 3 and 4 animals (2.5x and 2x). True only for the two-animal configurations (and for whole-session IDF1/switches, fig3d_frame_matched_rules: 0.969 vs 0.847, 130 vs 2,038 switches). Qualify to "with two animals" or cite the IDF1/switch result |
| 200 | runs over an order of magnitude faster | out/fig3_runtime_clean_b3_j17.json ratio | 14.0x | OK vs J17 | |
| 200 | ablation: without the 3D term greedy falls behind exhaustive | data/fig3/fig3d_sweep.csv r=0 greedy vs fig3d_frame_matched_rules exhaustive | 0.748 vs 0.847 cross IDF1 | OK | |
| 200 | 0.28 to 0.70 ms per frame | out/fig3_runtime_clean_b3_j17.json (0.2819 ms 2x5) and _a4c6 (0.7033 ms 4x6); data/fig3c/fig3e_head_to_head.csv | 0.28 / 0.70 | OK vs J17, but **placed figure is not J17** | `figures/fig3/fig3.pdf` (committed, Oct 20 03:27, md5 1367d4ca...) and `data/fig3/fig3e_head_to_head.csv` (03:27) carry the pre-J17 timing: luc3d_s 0.000238 (2x5) and 0.000653 (4x6), exhaustive 0.0039989 -> 16.8x. The J17 build exists only as untracked `figures/fig3c/fig3c.pdf` (16:57, md5 776d0792...) + `data/fig3c/`. data/fig3 and data/fig3c are NOT duplicates: fig3e_head_to_head.csv differs (all other 5 CSVs identical). Either place fig3c.pdf as figs/fig3.pdf, or the text (14x, 0.28, 0.70) does not match the placed Fig 3F |
| 204 | within-view IDF1 0.92 with two cameras -> 0.97 with four or five | out/fig2_cams_identity_b3.json summary (2dc001fe) | k2 mean of 3 subsets 0.922; k4 0.973; k5 0.968 | OK (rounding) | but "more cameras ... makes fewer errors" is not monotonic: k5 (0.968, 144 switches) is below every k4 subset (0.971-0.973, 92-132 switches) |
| 206 | female starts the large majority across nearly every session and every pairing | data/fig5/fig5f_leader_by_session.csv | female majority in 36/37 sessions (1 tie), 17/17 pairings with displays, 428/539 pooled | OK | 18 pairings exist, 17 had displays |
| 206 | four males and five females, nine animals | BMimica track_names | 4 / 5 | OK | |
| 208 | median cross-view IDF1 0.84 at rating 7 | data/fig4/fig4b_idf1_by_difficulty.csv | 0.8357 (n = 13) | OK | |
| 208 | 15% of keypoints seen by fewer than two cameras at rating 7 | data/fig4/fig4b_occlusion.csv seen_le1_pct_mean | 15.25 (mean of 13 sessions) | OK | it is a mean over sessions, the IDF1 a median; fine |

## Panopticon (L256, L263, L457-459) and Fig 9 caption (L465)

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 457/465 | LED 542 to 2,118 times above background, all nine cameras | none | - | UNVERIFIABLE | no generator, deposit or raw data in the figs repo or /root/vast/eric (searched for panopticon dirs, 758665/2118 strings). `figs/fig9.pdf` (Oct 5) is a finished PDF only |
| 457 | IFI median 9.997 ms, jitter 2.3 us, 19-min recording | none | - | UNVERIFIABLE | internally consistent: a clock 210-223 ppm slow reports 10 ms x (1 - 216e-6) = 9.998 ms |
| 457 | clocks 210-223 ppm below nominal, spread up to 13 ppm, drift 15 ms | none | 13e-6 x 19 min (1,140 s) = 14.8 ms | UNVERIFIABLE but internally consistent | |
| 263/459 | 758,665 corner observations; Panopticon 1.51 px vs calibrat3 0.15 px; focal lengths agree to median 2.1% | none | - | UNVERIFIABLE | |
| 465 | "All panels come from one nine-camera rig ... at 1920x1200 and 100 fps" vs F "a 30 fps calibration" | caption text | - | internal inconsistency (minor) | F's calibration recording is 30 fps on the 100 fps rig; say so or scope "All panels" |
| 263 vs 459 | "The at-rig solve confirms the recording ... by calibrat3" | tex | duplicated sentence | text | already flagged in ADVERSARIAL-REVIEW item 11 |

## 2D pose models (L439-441)

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 439 | SLEAP 1.2.8 / 1.3.3; 9,068 frames / 18,752 instances; 39,644 / 76,279; 5% validation; peak thresholds 0.4 / 0.25 | none in repo | - | UNVERIFIABLE | no training_config / deposit found (also flagged in AUDIT-2026-10-15 A5.12, still open) |
| 441 | median error 3.0 px (p90 12.1) SLAP, 1.6 px (p90 4.8) MD; shoulders hardest, nose/tail base easiest | none | - | UNVERIFIABLE | |
| 439 | centered-instance network places "the 15 keypoints" | BMimica node_names (15); SLAP skeleton not checked | 15 for MD | OK for MD | |

## Problems, most important first

1. **Placed Fig 3 is not the J17 build the Discussion quotes (L200).** Committed `figures/fig3/fig3.pdf` + `data/fig3/fig3e_head_to_head.csv` (03:27) have greedy 0.238 / 0.653 ms and 16.8x; the text (and its uncommitted Results diff) says 0.28 / 0.70 ms and 14x, which exist only in untracked `figures/fig3c/fig3c.pdf` + `data/fig3c/` (16:57, from `out/fig3_runtime_clean_b3_j17*.json`). data/fig3 and data/fig3c differ in exactly this CSV.
2. **L200 "greedy ... misgroups fewer frames than exhaustive" is false at 3 and 4 animals** (`data/fig3/fig3c_quality.csv`: 47 vs 19 at 3x5, 45 vs 22 at 4x3). True only for 2 animals.
3. **Placed datasheet is stale (L491)** - confirmed. The copy next to the tex (`figures/drafts/figs/datasheet_combined.pdf`, Aug 18) says Mouse-Dyad sex "Male" and proofreaders "?", lacks Total Animals; `figures/datasheets/datasheet_combined.pdf` (Oct 1) is correct. Also both copies label the 100.85 M (and SLAP 22.49 M) as plain "2D Poses"; they are 3D x views reprojections by construction (`dataset_sheets.py measure_mousedyad`), while the MD file list advertises analysis.h5 "2D Keypoints / View".
4. **SLAP-2M strains vs coat colours (L239, L243, datasheet).** The listed strains (8 CD-1, 4 C57BL/6J, 4 BALB/c) contain no agouti strain, but text, datasheet and `master_sheet.xlsx` (agouti mice in 42 sessions) all include agouti mice. One of the strain names is wrong.
5. **L239 "5 to 60 minutes" is wrong:** the 13 SLAP 60-fps sessions (2022-10-19) run 1.15 to ~3 min (master_sheet duration).
6. **Calibration bench not reproducible - confirmed.** `fig7_calib_deposit_unified.py:18` reads a deleted `/tmp/claude-0/...calibrat3.../bench`; no calibrat3 commit in `out/fig7_calibration.json`; timing sessions point to deleted /tmp scratchpads; the `calib_b` rerun was prepared but never run. Every placed calibration number does match the deposit/CSVs, and the raw inputs (9,029 / 12,621 frame counts re-verified from the videos) survive.
7. **L449 equal-frame / reference-camera control is from a different run** (2026-09-29, re-transcoded 18-cam video, 652,540 observations) than panel E (645,451). Numbers are right within that file; the text implies the same scoring set.
8. **Fig 9 / Panopticon numbers (L457-459, L263, caption) have no generator, deposit or data** anywhere searched; internally consistent (ppm/IFI/drift arithmetic checks), but unverifiable. Caption "All panels ... 100 fps" vs F "30 fps calibration".
9. **2D-model numbers (L439-441) still unsourced.**
10. Minor: L204 "more cameras -> fewer errors" is not monotonic (5 cams 0.968 / 144 switches vs 4-cam subsets 0.971-0.973 / 92-132); L433 "378" is 378.5; L445 "two rigs used to choose the defaults" - only 1 of the 4 SLAP sessions was the tuning recording (deposit notes the other 3 as held out), so SLAP is mostly held-out too; L435 "64-core machine, each tool on its own" unverifiable (unlogged sittings); "three converged draws agree to within 0.002 px" is aniposelib's self-reported error, not the scored median.

Verified OK (no action): all Fig 8 medians/p95s/31-camera claim, mechanism values, held-out <0.004, runtime ordering, synthetic 0.05/2.20/0.03/2.98%, 3-of-6 divergence, frame-budget medians 2,606/623/882, 867-1,003 stride range, board spec, OpenCV 4.13 on both; Mouse-Dyad 56 sessions, 9 animals (4M/5F), 18 pairings, track 0 = male, 15 nodes, 10.08 M frames/view, 20.17 M 3D, 100.85 M reprojected, ~20 min; SLAP 74 sessions, 42 multi-animal, 1-4 animals, 6 enrichment levels, difficulty 1-7, 13 x 60 fps, 15.6 M frames, 2.81 M / 22.5 M; 66 M frames; HardFight 8 cams 60 fps 1280x1024; GUI claims vs v1.0.5; Discussion 32x/0.89 us, >half placements (tau10), 0.92->0.97, 0.84 / 15% at rating 7, female leads 36/37 sessions and 17/17 pairings.

### SLAP-2M master sheet (found late; supersedes several UNVERIFIABLE rows above)
Source: `/root/vast/eric/slap-2m-side-inference/master_sheet_side_model.tsv` (74 rows; columns white/agouti/black_mice, animals, obstacle_rating, bedding, frames, duration, difficulty).

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 240 | experiments placed mice in an enclosure for 5 to 60 minutes | master sheet frames / fps (60 fps for 2022-10-19, else 30) and `duration` col | min 1.15 min, max 60.07 min; 10 sessions (all 2022-10-19) are 1.1 to 4.3 min | WRONG | should read "1 to 60 minutes" (or "about 1 to 60") |
| 243 / table | white, black and agouti mice | master sheet colour columns | white in 37 sessions, agouti in 42, black in 38 | OK | agouti mice exist, so it is the L240 strain list (CD-1, C57BL/6J, BALB/c: white, black, white) that lacks an agouti strain. See Problems |
| 244 | ~2.8 M 3D poses, ~22.5 M 2D reprojected into 8 views | sum(frames x animals); x 8 | 2,812,325; 22,498,600 | OK | datasheet "22.49 million" truncates 22.499 M (22.50 M) - ROUNDING, cosmetic |
| 196 / 103 / table | SLAP-2M 15.6 M frames, 1.95 M per view | sum(frames) x 8 | 1,954,440 x 8 = 15,635,520 | OK | now has a machine-readable source |
| 244 | 74 sessions, 1-4 animals | animals col | 32 / 35 / 4 / 3 | OK | |
| 244 | six levels of enrichment | obstacle_rating | 0..5 (six levels) | OK | |
| 244 | difficulty 1 to 7 | difficulty | 12/13/9/13/10/4/13 | OK | matches fig4 strata |
| 244 | black or white bedding | bedding | 44 black, 30 white | OK | |
| 254 | 30 fps except 13 sessions at 60 fps | frames / (duration x 60) | 13 x 60 fps (2022-10-19), 61 x 30 fps (6 rows lack duration, all 2022-10-07) | OK | |

## GUI section (L214-232) vs v1.0.5 code (/root/vast/eric/lucid-main-md56, HEAD 2dc001fe = tag v1.0.5)

The section has almost no numbers; checked the concrete feature claims.

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 218 | calibrations in TOML or JSON | import-export/file-io.js, loading/session-loader.js | both handled | OK | |
| 218 | predictions read lazily | loading/sio-lazy-loader.js | present | OK | |
| 222 | per-node weights, per-view inclusion, cost thresholds in a guided dialog | ui/track-range-modal.js:8 | node weights / camera views / 3D weight | OK | |
| 226 | reprojection errors in the info panel appear green, yellow, red | ui/info-panel.js:1409 (headline stats: <2 low, <5 medium, else high); ui/overlays.js:463 errorColor (<2 green, <=5 yellow, >5 red) | colour bands exist | OK / minor | the per-instance-group error cells in the table (info-panel.js:1924-1933) are NOT colour-coded, only the headline values and on-canvas lines are. Bands also differ at exactly 5 px (panel red, canvas yellow). Text gives no thresholds, so no number is wrong |
| 228 | right-click cycles visible/occluded | ui/interaction.js:982-983 (right-click or Ctrl+click toggles node null) | toggle | OK | |
| 228/230 | double-click converts reprojected instance to editable | ui/interaction.js:1202 | yes | OK | |
| 232 | export dialog 480p to 2160p, reports frame count and estimated file size | ui/overlay-export-layout.js:29-32 RES_PRESETS 480/720/1080/2160; ui/export-modals.js:2919-2921 "Exported Frames", "Estimated File Size" | as stated | OK | |
| 234 | SLP format 2.8 columnar session data | lib/sleap-io 0.5.5 (CLAUDE.md) | SLP 2.8 /session_data | OK | |

## Two-dimensional pose estimation models (L437-441)

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 439 | SLEAP 1.2.8 / 1.3.3; 9,068 frames / 18,752 instances; 39,644 / 76,279; 5% validation; peak thresholds 0.4 / 0.25; U-Net, trunk anchor | grep of repo (.md/.py/.json, excluding envs), /root/vast/eric/model_checkpoints, slap-side-model | no training_config / labels package / metrics deposit for these models | UNVERIFIABLE | same finding as AUDIT-2026-10-15-ADVERSARIAL.md:160 and FIX-CHECKLIST A5.12 (still open) |
| 441 | median 3.0 px (p90 12.1) SLAP; 1.6 px (p90 4.8) MD; shoulders hardest, nose / tail base easiest | same | none | UNVERIFIABLE | |
| 439 | 15 keypoints | out/fig12_social.json nodes | 15 | OK | |

## Panopticon (L252-256, L263, Supp L455-467, Fig 9 caption L473)

No deposit, script, or log for any Panopticon number exists in figs/, figures-luc3d, calibrat3, luc3d-page-panopticon or /root/vast/eric/camera_sync (grep for 758,665 / 2,118 / 9.997). fig9.pdf (Oct 5) has no generator in the repo.

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 459 / cap C | LED 542 to 2,118 x above background, all nine cameras | none | - | UNVERIFIABLE | |
| 459 / cap D | 19-min recording, median IFI 9.997 ms, jitter 2.3 us | none; internal check vs 210-223 ppm | 10 ms x (1 - 210..223e-6) = 9.99777-9.99790 ms -> rounds to 9.998 | UNVERIFIABLE / ROUNDING (internal) | 9.997 ms implies ~300 ppm slow, outside the stated 210-223 ppm. One of the two is off (or the median is of quantized timestamps). Worth a look |
| 459 / cap E | clocks 210-223 ppm below nominal, spread up to 13 ppm, 15 ms drift over the recording | internal: 13e-6 x 19 min (1,140 s) | 14.8 ms | OK (internal) / UNVERIFIABLE | |
| 263 / 461 / cap F | 758,665 corner observations seen by >= 2 cameras | none | same number in all three places | UNVERIFIABLE (consistent) | |
| 461 | Panopticon 1.51 px vs calibrat3 0.15 px | none | - | UNVERIFIABLE | |
| 461 / cap G | focal lengths agree to a median 2.1% | none | - | UNVERIFIABLE | |
| cap | Basler a2A1920-165g5m, 1920x1200, 100 fps, Arduino Mega 2560; 2 Hz 50% duty LED | none | - | UNVERIFIABLE | cap F says the calibration was "a 30 fps calibration" on the same rig described as 100 fps; fine if intended, but reads oddly |
| 263 vs 461 | final calibration "by calibrat3" (L263) vs "by calibrat3 ... or Anipose" (L461) | - | - | wording | minor inconsistency |

## Camera calibration (L258-263)

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 260 | SLAP-2M and MD calibrations performed in Anipose | consistent with Fig 8 (calibrat3 benchmarked against them) | - | OK | |
| 260 | all 3D coordinates in millimetres | MD h5 used in mm by fig5_upright.py; ChArUco 24.0 mm squares | - | OK | |
| 261 | calibrat3 benchmarked on three rigs | fig7_calibration.json datasets slap8, md10, calib18 | 3 | OK | |
| 263 | nine-camera Basler rig, 758,665 observations | see Panopticon | - | UNVERIFIABLE | |

## Fig 8 caption, one more check
| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| cap | A to G scored on the corners Anipose itself detected | out/fig7_calibration.json datasets.*.detsets | only `anipose` detset; fig7_calib_deposit_unified.py:48 loads scores_anipose.npz | OK | |

## Problems, most important first

1. **"5 to 60 minutes" is wrong (L240).** The SLAP-2M master sheet (`/root/vast/eric/slap-2m-side-inference/master_sheet_side_model.tsv`) has 10 sessions, all from 2022-10-19, that run 1.1 to 4.3 min. The shortest is 10192022174304, 4,125 frames at 60 fps. The range is about 1 to 60 minutes.
2. **The datasheet copy beside the tex is stale (open item CONFIRMED).** `figures/drafts/figs/datasheet_combined.pdf` (Aug 18) is the only `figs/` asset in drafts/, so it is what a local compile typesets. It prints "No. Proofreaders: ?" for Mouse-Dyad-10M, "Mice Sex: Male" for Mouse-Dyad-10M (it is male + female), and SLAP-2M "Proofreading: Manual + Automated". It also has no Total Animals row. `figures/datasheets/datasheet_combined.pdf` (Oct 1) fixes all four. Copy the Oct 1 file wherever the tex is actually compiled (Overleaf?). No generator script exists for either.
3. **Calibration benchmark is not reproducible from stored intermediates (CONFIRMED, earlier rows).** The deposit script points at a deleted `/tmp/claude-0/...calibrat3/.../bench`, no calibrat3 commit is recorded, and the timing sittings are unlogged. Every Fig 8 number matches the deposit, but the deposit cannot be regenerated. The "64-core machine, run alone" claim (L435) is unverifiable.
4. **Strain list vs coat colours (L240 vs L243 and the datasheet).** L240 lists CD-1 (white), C57BL/6J (black) and BALB/c (white). L243, the datasheet and the master sheet all have agouti mice (agouti in 42 of 74 sessions). The 8/4/4 strain list is missing an agouti strain or has one wrong. It also cannot be checked against any animal-level record.
5. **Discussion L200 "0.28 to 0.70 ms per frame"** matches the J17 timing deposits and the uncommitted tex diff. The placed Fig 3 PDF and `data/fig3` still show 0.238-0.653 ms, so the figure needs rebuilding to match. See B_fig3.md Problem 1. "Over an order of magnitude" holds either way (at least 14x).
6. **2D model section (L439-441) has no source at all.** That covers the SLEAP versions, frame and instance counts, the 5% split, the peak thresholds 0.4 / 0.25, and the errors 3.0 / 12.1 / 1.6 / 4.8 px. This is still open from FIX-CHECKLIST A5.12.
7. **All Panopticon / Fig 9 numbers are unverifiable.** That is 542-2,118x, 9.997 ms, 2.3 us, 210-223 ppm, 13 ppm, 15 ms, 1.51 vs 0.15 px, 758,665 and 2.1%. fig9.pdf (Oct 5) has no generator or deposit anywhere searched. There is one internal tension. 210-223 ppm slow predicts a median interval of 9.9978-9.9979 ms, which rounds to 9.998, not 9.997. The 15 ms drift is consistent with 13 ppm over 19 min (14.8 ms).
8. **The "2D poses" counts are reprojections (open item CONFIRMED).** For MD that is 100.8 M = 5 x 20.17 M 3D. For SLAP it is 22.5 M = 8 x 2.81 M. L242 and L244 say "reprojected", but Intro L103 and the datasheet row "2D Poses" do not. The datasheet's MD file row "analysis.h5 = 2D Keypoints / View" makes it unclear what is shipped. The datasheet's "22.49 million" truncates 22,498,600 (22.50 M).
9. **Small wording items.** The Fig 8 equal-frames control (L449) is a re-run on a re-transcoded 18-cam video with 652,540 observations, not panel E's 645,451 (earlier rows). In the GUI section (L226), the per-group error cells in the info panel are not colour-coded, only the headline values and the canvas lines are. L263 says the final calibration is by calibrat3, while L461 says calibrat3 or Anipose. Six enrichment levels vs seven difficulty ratings may confuse a reader, though the data are right (obstacle_rating 0-5, difficulty 1-7).
10. Code-side, not in the tex: the docstring at `fig5_replication.py:7` says the 37 display sessions cover "18 pairings". The deposit has 17. The 18th pairing (all 56 sessions do have 18) has no displays.

Verified OK, new in this pass: the MD corpus is 56 sessions, 150.10 fps, 20.0 min each, 10,084,734 frames per view. It has 9 animals (4 M, 5 F) in 18 pairings, and the male is always track 0 (read from the track_names of all 56 h5 files). The 15-node skeleton is OK. For SLAP-2M, 74 sessions (32/35/4/3 by animal count), 15.64 M frames, 2.81 M 3D poses, 13 sessions at 60 fps, six enrichment levels, black/white bedding, 42 multi-animal sessions and the 6 analyzed cameras are all OK. The Discussion leader claims hold: 79.4% of displays, 36 of 37 sessions (1 tie), 17/17 pairings. Discussion repeats of Results numbers all OK. The GUI feature claims match v1.0.5 (480p-2160p, frame count and size estimate, TOML/JSON, right-click and double-click, lazy read, SLP 2.8).
