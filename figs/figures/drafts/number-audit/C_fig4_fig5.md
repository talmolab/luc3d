# Audit C: Fig 4 / Fig 5 text, captions, Methods (pool, recovery, behavior), Supp rearing controls

Repo figs/ = /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs. Tex = figures/drafts/luc3d_newest.tex.

## Provenance of the placed Fig 4 / Fig 5
- Placed composites: figures/fig4/fig4.pdf, figures/fig5/fig5.pdf (Oct 20 15:16, committed in 6f8a465f). (out/fig4.pdf / out/fig5.pdf are Aug 4 leftovers, not placed.)
- data/fig4 equals the archived x7 build (out/md56_logs/archived_variant_figs_2026-10-20/data/fig4x7) and main_before_x7 byte-for-byte (except unplaced fig4e_*).
- out/md56_logs/run_PROMOTE_x7.out stops after fig3; PROMOTE_fig4.log is EMPTY (0 bytes, 15:03); PROMOTE_fig5.log is the Oct 15 one. So the x7 promotion never completed for Figs 4-7; a6752bc0 repaired fig5 data afterwards by hand ("5A camera gaps from LUC3D, 5G per-direction table").
- Fig 4D IDF1 CSV (data/fig4/fig4b_idf1_by_difficulty.csv) matches out/fig9_slap2m_lite_bvis5_notailscore_md56.json (cell sync_stale20_dist25) to 1e-16, and differs by up to 0.18 from the plain Oct 8 fig9_slap2m_lite_bvis5_notailscore.json. Note: run_X7_build's pass 2 loaded the PLAIN Oct 8 file (X7_loads.tsv line 41) although PROMOTE_loads.tsv resolved it to _x7 -> _md56. The placed CSV is the md56 one, so fine, but the X7 build itself was not a clean reproduction. The md56 deposit header still says `status: EXPLORATORY -- not part of the manuscript.` (cosmetic).

## Fig 4 claims

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 164 | 74 SLAP-2M sessions | data/fig4/fig4b_occlusion_sessions.csv rows | 74 (12/13/9/13/10/4/13 per rating 1-7) | OK | |
| 164 | rating 1: 0.21% cannot be recovered | fig4b_occlusion.csv seen_le1_pct_mean d1 | 0.2100 | OK | |
| 164 | below 3.3% through rating 5 | seen_le1 d2..d5 | 1.14, 2.97, 2.11, 3.27 | OK | 3.27 is close to 3.3 (fine) |
| 164 | 11.5% at rating 6 | seen_le1 d6 | 11.51 | OK | |
| 164 | 15.2% at rating 7 | seen_le1 d7 | 15.248 | OK | |
| 164 | 6.3% seen by no camera, 8.9% by only one (r7) | seen_0 / seen_1 d7 | 6.300 / 8.947 | OK | 6.3+8.9=15.2 consistent |
| 164 | mean reproj error rises 1.41x, 3.56 -> 5.02 px | fig4c_error_when_present.csv err_mean | 3.5575 -> 5.0176, ratio 1.4105 | OK | |
| 164 | 98th pct doubles 11.2 -> 22.5 px | err_p98 | 11.180 -> 22.488 (2.01x) | OK | |
| 164 | rating 2 median IDF1 = 0.998 | fig4b_idf1_by_difficulty.csv | 0.99849 (n=10) | OK | |
| 164 | rating 7 median IDF1 = 0.836 | same | 0.83574 (n=13) | OK | |
| 164 | every stratum 2-5 median >= 0.98 | same | 0.9985, 0.9833, 0.9938, 0.9801 | OK | rating 5 = 0.9801, borderline but true |
| 164 | rating 2 = "two animals and no enrichment objects" | fig4b_idf1 animals col | d2 all 2-animal | OK | |
| 170 caption | B/C: all 74 sessions, ~30.9 million keypoints, tail excluded | fig4b_occlusion_sessions.csv sum n_keypoints | 30,935,575 | OK | pool fig4_recovery_proofread2d.json, tail nodes dropped (X7_fig4.log) |
| 170 caption | D uses 42 multi-animal sessions | fig4b_idf1 rows | 42 (35 two-, 4 three-, 3 four-animal) | OK | |
| 170 caption | percentiles 80th/95th/98th; mean +- s.e.m. across sessions | panels/fig4_06_detection_quality.py L197-207 | err_mean = mean of session means, sem across sessions; p80/95/98 = by_difficulty (= mean of per-session percentiles, verified d1,d7) | OK | |
| 170 caption | "six proofread cameras" (inset) | fig6_detections_proofread_notail.json cameras_used | 6 for all 74 | OK | |
| 309 | n = 4 to 13 sessions per rating | per-rating counts | 4..13 | OK | |
| 309 | 11 body nodes, ~30.9 million keypoints | as above | 30.94M | OK | 15 nodes - 4 tail = 11 (not recounted from node list) |
| 309 | each percentile line = that percentile of each session's errors averaged within rating | fig4_detections.py L431-433 + check | matches | OK | |
| 271 | Fig 4B and C computed on every frame | out/fig6_detections_proofread_notail.json stride | 1 | OK | |
| 309 | Fig 4C "same matching and keypoints" as 4B | fig6_detections_proofread_notail.json (fig4_detections.py) vs fig4_recovery_proofread2d.json | two different generators | MISMATCH-METHOD (minor) | 4B comes from fig4_recovery_proofread2d.py, 4C from fig4_detections.py --detections proofread. Both "mean keypoint distance" matching per frame/camera, but separate code; the deposit fig6_detections_proofread_notail.json records detection_pool=keeptrack_h5s (the POOL constant is printed regardless of --detections) and its caveats still describe "Raw detections from the benchmark's shared pool" -- the deposit does not self-document that the proofread 2D labels were used. Could not find the invocation log (grep over tree too slow; stopped). |
| 164 / 170 | Fig 4D tracker = LUC3D v1.0.5, bvis5 pool, tail-free | out/fig9_slap2m_lite_bvis5_notailscore_md56.json (via _x7 link) | params {sync, stale 20, distanceThreshold 25}; pool out/tmp/lite_pools/bvis5 = unfiltered predslp minus detections with <5 visible BODY keypoints (build_lite_pools.py TAIL=(4,7,8,9)) | OK / UNVERIFIABLE (stamp) | deposit carries no lucid_commit / pose_dir stamp and no tracking-node setting, so v1.0.5 and tail-free tracking rest on the consistency plan (L65, "Fig 4D already v1.0.5") and the md56 run log, not on the file itself. Multi-animal mean cross IDF1 in same cell = 0.9317 (abstract's 0.932 OK). |
| abstract ~L103 | "across all 74 sessions 95% of keypoints are seen by at least two of the six cameras" | fig4b_occlusion_sessions.csv | pooled 95.11%, mean of sessions 95.29% | OK | |
| abstract ~L103 | median 0.998 two mice no objects, falls to 0.84 most enriched | fig4b_idf1 | 0.9985 / 0.8357 | OK | |
| discussion ~L177 | "median cross-view IDF1 0.84 at rating 7, where 15% of keypoints seen by fewer than two cameras" | as above | 0.836 / 15.25% | OK | |

## Fig 5 claims

Sources: out/fig5_upright.json (Sep 20; 539 events, 37 sessions; inputs /root/vast/eric/BMimica/*/points3d h5, all older than the deposit), data/fig5/*.csv (placed build), out/fig5_rear_coupling_2animal_perdir.json (Oct 15) -> data/fig5/fig5g_rear_coupling_perdir.csv, out/fig5_views_js.json (5A, stamped lucid_commit 2dc001fe), data/fig5/fig5s_controls.csv + fig5s_slot_swap_control.csv (Sep 20, not rebuilt by the x7 build but derived from the same fig5_upright pipeline/inputs).

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 171 / 189 | cameras 58 to 76 degrees above the animals | out/fig5_views_js.json cameras centre_mm vs scene centre (panels/fig5_05 _elev) | 58.4, 59.9, 73.5, 75.7, 76.0 | OK | elevation measured from the one displayed frame's scene centre |
| 173 / 189 | 539 displays in 37 of the 56 sessions | fig5_upright.json n_events / n_sessions; BMimica has 56 sessions with points3d | 539 / 37 / 56 | OK | |
| 173 | median duration 0.71 s | events dur_s median | 0.706 | OK | |
| 173 / 189 C | female rears median 0.40 s before male (female-led) | events lag_s, initiator_track==1 | 0.396 (n=428) | OK | |
| 189 C | striped bar = 9% of delays > 2 s | same | 8.88%; 1 - sum(fig5c bins) = 8.88% | OK | |
| 173 | speed session medians 0.36 male / 0.20 female BL/s; male faster 28/37; Wilcoxon P = 4.6e-4 | fig5d_speed_by_session.csv (recomputed from events speed_bl_s_t0/t1) | 0.3607 / 0.1989; 28; P=4.63e-4 | OK | |
| 173 | pursuit 1.5 s, male -0.89, female -0.07; male more negative all 37; P=1.5e-11 | fig5e_pursuit_by_session.csv (recomputed from pursuit_rel_t0/t1) | -0.886 / -0.072; 37/37; 1.455e-11 | OK | |
| 173 | pair unit: male faster 13 of 14 pairs, more negative pursuit 14/14 | recomputed pairs with >=5 displays | 13/14 (Wilcoxon P 2.4e-4), 14/14 | OK | |
| 173 | each of 4 males more negative than each of 5 females, MW P=0.016 | per-animal medians | males -1.36..-0.59, females -0.22..+1.24; P=0.0159 (complete separation) | OK | |
| 173 | speed across animals MW P=0.19 | same | 0.190 | OK | one female (177397) has a single display, speed 2.51 BL/s |
| 175 | female initiates 428 of 535 (80.0%), male 107, 4 ties | events initiator_track | 428 / 107 / 4 NaN | OK | |
| 175 | female leads 36 of 37 sessions; one exact tie; no male-led session | fig5f_leader_by_session.csv | 36 / 1 tie (20250908_154926, 2-2) / 0 | OK | |
| 175 / 189 F | 23 sessions with >=6 displays, median female share 0.83, Wilcoxon P=2.7e-5 | fig5f_leader_by_session.csv | 23; 0.826; P=2.66e-5 | OK | |
| 177 / 189 | nine mice (4 M, 5 F) in 18 pairings | BMimica points3d h5 track_names (slot 0 / slot 1 animal prefixes) | 4 male IDs, 5 female IDs, 18 distinct pairings over 56 sessions | OK | fig5_upright.py L238 comment "6 animal IDs seen only at slot 0, 9 only at slot 1" counts suffixed track names, not animals; comment only |
| 177 / 317 | displays from 1 to 305 per female (16 to 254 per male) | per-animal sums | F {1,46,58,129,305}; M {16,116,153,254} | OK | |
| 177 | 17 distinct pairings with >=1 display, all female-led | pairs table | 17, female > male in all 17 | OK | |
| 177 / 319 / 321 | 14 pairs with >=5 displays covering 536 displays; median female share 0.81; 14 of 14; sign P=1.2e-4 | pairs table | 14; 536; 0.813; 14/14; P=1.22e-4 | OK | Wilcoxon vs 0.5 (Methods L321) gives P=9.7e-4, not quoted |
| 177 | pooled over those pairs, 425 of 532 with an initiator (79.9%) | pairs table | 425/532 = 79.89% | OK | |
| 179 / 403 | rearing-time share does not predict female initiation share, r=-0.011, P=0.96 (23 sessions) | fig5s_controls.csv per_animal, n>=6 | r=-0.0112, P=0.960 | OK | uses initiated-only denominator; with all displays r=-0.002 |
| 179 / 403 | absolute 60 mm threshold: female leader in all 23 sessions | fig5s_controls.csv mode=abs, restricted to the 23 per-animal sessions | 23/23 female | OK | abs detector's own >=6-display sessions would be 26 with 25 female, 1 male; text/Methods specify "same sessions", consistent |
| 403 | shared threshold: female leader in 20 of 23 | mode=shared on same 23 sessions | 20 female, 2 male, 1 tie | OK | |
| 403 | median body length 90.1 mm male, 84.2 mm female; male longer in 29 of 37; Wilcoxon P<0.0001 | fig5s_controls.csv per_animal L_male_mm/L_female_mm | 90.15 / 84.18; 29; P=1.08e-5 | OK | |
| 403 | 36 sessions with unique leader, leader shorter in 28, sign P=0.0012 | same | 36; 28; P=0.00119 | OK | |
| 179 / 403 | 8 sessions where female longer, female starts 78% (binomial P=6e-9) | same | 8 sessions; 80/102 initiator-known = 78.4%, P=6.4e-9 (80/103 incl. tie = 77.7%) | OK | |
| 323 | slot swap gives identical results | fig5s_slot_swap_control.csv | 539/539 events, same frames, initiator flipped, max diff 0.0 | OK | |
| 181 | male below baseline before and during female onset; reaches 1.7x ~0.8 s later | fig5g_rear_coupling_perdir.csv male_p50 | 0.575 at lag 0; max 1.711 at +0.839 s | OK | |
| 181 | female rises before male onset, 4.7x at male start, peaks 5.2x a third of a second later | female_p50 | 4.705 at 0; max 5.248 at +0.333 s | OK | panels/fig5_12_coupling.py docstring still says "5.3x" (stale docstring) |
| 181 | male starts within 2 BL: female already rearing 50.2%; female starts: male already 6.2% | perdir json already_mid_bout i0 / i1 pooled | 0.5021 / 0.0622 | OK | session medians 50.0% (n=25) and 3.3% (n=39) |
| 181 | "This sequential relationship is not observed when the animals are further apart" | far lines, |lag|<=1.5 s | male_far_p50 1.03-1.44 (median 1.21); female_far_p50 0.41-1.08 | MISMATCH-INTERPRETATION (minor) | far curves are not at chance: male far reaches 1.44x (vs near 1.71x) and female far dips to 0.41x. The leader/follower pattern is absent, but "not observed" is stronger than the data; panel docstring's "FAR stays flat at ~1.05x" is stale |
| 189 G | G uses 9,354 rear onsets from all 56 sessions, 2,915 within two body lengths | perdir json n_onsets all / near | 9,354 / 2,915 (near_i0 936 + near_i1 1,979) | OK / MISMATCH-METHOD (minor) | the plotted near curves are medians over only the sessions with >=20 onsets in that direction: 32 sessions (male around female onsets) and 13 sessions (female around male onsets); "from all 56 sessions" reads as if the curves use all 56. Methods L325 does state the >=20 exclusion. |
| 325 | 24 circular shifts per ordered pair, lags within 5 s, sessions <20 onsets excluded | perdir json n_shifts / lag_s / min_onsets | 24 / 5.0 / 20 | OK | |
| 313 | neck > 0.75 body length; body length = median nose-to-tail-base over session; bouts <0.25 s discarded; gaps <=0.15 s merged; tail bases within 2 BL for >=0.25 s | fig5_upright.py L55-57, L116-117, L156, L169-176 | REAR_FRAC 0.75, L = nanmedian |Nose-TTI|, MIN_EVENT_S 0.25, MERGE_GAP_S 0.15, NEAR_BL 2.0 | OK | separation uses the PAIR's mean body length (Lm) and 3D TTI distance; text says "two body lengths" without saying whose |
| 315 | speed = median over 0.5 s pre-onset (BL/s); pursuit = facing . (self - partner) unit x speed, median over 1.5 s, / session median speed | fig5_upright.py L281-321, L199-201 | matches | OK | speed is tail-base (TTI) speed, not stated |
| 189 | 150 fps, five cameras | fig5_rear_coupling perdir fps_min 150.10; 5 cameras in fig5_views_js | OK | OK | |

Supplementary lines 480-558: no table or figure caption about the rearing controls exists there (only the Supp Fig 6 tracking caption, the datasheet table and the bibliography). The controls are text-only in Supp Section L401-403; their numbers are all checked above.

## Problems, most important first
1. Provenance gap in the build, not in the numbers: out/md56_logs/run_PROMOTE_x7.out stops after fig3 and PROMOTE_fig4.log is empty, so the "promote x7" step never ran for Figs 4-7. data/fig4 is nonetheless byte-identical to the archived fig4x7 and to main_before_x7, and every Fig 4 number checks against it, so the placed Fig 4 is fine. But run_X7_build's pass 2 loaded the plain Oct 8 fig9_slap2m_lite_bvis5_notailscore.json (X7_loads.tsv line 41; differs by up to 0.18 IDF1 per session), not the md56 one; the placed data/fig4/fig4b_idf1_by_difficulty.csv matches md56 to 1e-16. Anyone re-running run_X7_build.sh would reproduce a wrong Fig 4D. Fig 5 data was fixed by hand in a6752bc0.
2. Fig 4D deposit has no LUC3D commit / pose_dir / tracking-node stamp (and still says "EXPLORATORY -- not part of the manuscript"), so "LUC3D v1.0.5, tail-free tracking" for Fig 4D cannot be verified from the file; it rests on the plan doc.
3. Fig 5G text L181 "This sequential relationship is not observed when the animals are further apart": the far curves are not flat (male far up to 1.44x, female far down to 0.41x within +-1.5 s). Consider "is much weaker" or a statement about the asymmetry specifically.
4. Fig 5G caption "G uses 9,354 rear onsets from all 56 sessions": the counts are right, but the plotted near curves are session medians over 32 (left) and 13 (right) sessions. Consider stating the per-panel session Ns.
5. Fig 4C deposit out/fig6_detections_proofread_notail.json does not record that the proofread 2D labels (--detections proofread) were used. Its detection_pool field says keeptrack_h5s and its caveats describe raw detections. The numbers match the tex, but the deposit misdescribes itself. Methods L309 says 4C uses "the same matching and keypoints" as 4B. In fact they come from two generators (fig4_recovery_proofread2d.py vs fig4_detections.py) that use the same matching rule.
6. Stale leftovers (cosmetic): data/fig5/fig5g_rear_coupling.csv (Oct 15, non-perdir, same main-line medians) sits beside the placed perdir CSV. The panel docstrings in panels/fig5_12_coupling.py ("5.3x", "FAR flat ~1.05x") and panels/fig4_06_detection_quality.py (old ratios, s.d. bars) are stale.

No WRONG numbers found in the assigned lines. Every Fig 4 / Fig 5 / rearing-control number in the tex matches the placed data within its rounding.

## Fig 5A, 5G, Methods, controls, repeats (continued run)

| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 175, 190 | five cameras, 150 fps | out/fig5_views_js.json cameras (5), fps 150.105 | 5 / 150.1 | OK | 5A deposit is from LUC3D v1.0.5 JS (lucid_commit 2dc001fe, driver lucid_geom.mjs), as the plan (Eric 10-20) requires |
| 175, 190 | every camera 58 to 76 degrees above the animals | fig5_views_js.json centre_mm vs pose centroid (panels/fig5_05 `_elev`); artwork labels 76, 76, 74, 60, 58 deg | 58.1 .. 75.7 | OK / wording | This is the elevation of each camera centre seen from the animals at one instant of one session (20250827_152238). Line 175 says the cameras are "mounted" at those angles; their optical-axis tilts are 71-89 deg. Caption 190 ("look down ... from 58 to 76 degrees") is fine |
| 185 | male rearing below baseline before and during female onset | fig5g_rear_coupling_perdir.csv male_p50 (= deposit near_i1 p50, allclose) | 0.62 at -1 s, 0.34 at -0.5 s, 0.58 at 0 | OK | |
| 185 | male reaches 1.7x baseline ~0.8 s later | male_p50 max | 1.711 at +0.839 s | OK | |
| 185 | female 4.7x at male onset, peaks 5.2x a third of a second later | female_p50 (= near_i0) | 4.705 at 0; 5.248 at +0.333 s | OK | |
| 185 | male starts within 2 BL: female already rearing 50.2%; female starts: male already rearing 6.2% | fig5_rear_coupling_2animal_perdir.json already_mid_bout i0/i1 pooled | 0.5021 / 0.0622 | OK | pooled over every near onset of all sessions, not only the 13 / 32 sessions the G curves keep (per-session medians 0.50 / 0.033) |
| 185 | relationship not observed further apart | male_far_p50 / female_far_p50 | far curves 0.79-1.45x (male far max 1.45x at -1.07 s; female far 0.79x at 0) | OK (qualitative) | |
| 190 caption | G: 9,354 onsets from all 56 sessions, 2,915 within two BL | deposit n_onsets all / near; n_sessions 56 | 9,354 / 2,915 / 56 | OK, but incomplete | the plotted per-direction near curves keep only sessions with >= 20 onsets: 13 sessions for the right sub-panel (male onsets, near_i0, 936 onsets) and 32 for the left (female onsets, near_i1, 1,979 onsets). Methods 325 states the >= 20 rule, the caption does not |
| 325 | +-5 s lags, circular-shift null 24 shifts per ordered pair, >= 20 onsets per condition | deposit lag_s, n_shifts, min_onsets | 5.0 / 24 / 20 | OK | split by TTI-TTI (tail-base) separation, near_bl 2.0: OK |
| 317 | speed = median over 0.5 s before onset; pursuit = median over 1.5 s before onset, divided by session median speed | fig5_upright.py L281, L288, L314-321, base_spd L175 | as stated | OK | |
| 323, 403 | r = -0.011, P = 0.96 (female-initiated fraction vs female share of rearing time, 23 sessions) | data/fig5/fig5s_controls.csv mode=per_animal, n>=6; Pearson | r = -0.0112, P = 0.960 | OK | |
| 183, 403 | absolute 60 mm threshold: female leader in all 23 | fig5s_controls.csv mode=abs, restricted to the 23 published sessions | 23 / 23 | OK | under its own detection the abs mode has 26 sessions >= 6 displays and one is male-led (20250908_154926, 5-1); the text's "same sessions" restriction (Methods 319/323) makes 23/23 correct |
| 403 | shared pair threshold: female leader in 20 of 23 | mode=shared on the 23 sessions | 20 F, 2 M, 1 tie | OK | |
| 323 | slot swap gives identical results | data/fig5/fig5s_slot_swap_control.csv | 37 sessions + SUMMARY 539 = 539, initiator flipped, max diff 0.0 | OK | "every session" = the 37 with displays |
| 241, 181, 351 | 56 sessions, 9 mice (4 M, 5 F), 18 pairings | /root/vast/eric/BMimica/*/*points3d*.h5 track_names | 56 sessions, 18 pairings, 9 animals | OK | |
| 267 | pool: SLEAP predictions, no instance filter, minus detections with < 5 visible body keypoints, tail not counted | out/tmp/lite_pools/bvis5/*.h5 attrs | lite_min_visible_nodes 5, lite_count_nodes "body (tail excluded)", lite_min_instance_score 0.0, source predslp_pool | OK | (SLAP-2M pool; Mouse-Dyad b3 pool belongs to the Fig 3 audit) |
| 267 | IoU 0.5 GT transfer | fig9_slap2m_lite_bvis5_notailscore_md56.json caveats | IoU >= 0.5 | OK | |
| 170 caption D | "tracked ... as in Figure 3" (LUC3D v1.0.5) | md56 deposit = M3_fig4d.log run that wrote fig9_slap2m_lite_bvis5_main2dc001fe_notailscore.json (Oct 14 23:12, MULTI cross 0.9317 = md56 deposit) | v1.0.5 | OK | deposit file name / "EXPLORATORY" header do not record the commit; only the log does |
| 269 | Fig 2B-G every 15th frame over the same 56 sessions | out/fig4_js.json stride / n_sessions | 15 / 56 | OK | 0.1 s at 150 fps OK. "temporal term disabled" not checked (Fig 2 audit) |
| 269 | Fig 5 on every frame | fig5_upright.py reads full points3d.h5, no stride | every frame | OK | |
| 103 | across all 74 sessions 95% of keypoints seen by >= 2 of the six cameras | fig4b_occlusion_sessions.csv, keypoint-weighted | 95.11% (session mean 95.29%) | OK | |
| 103, 169, 309, 485 vs 113, 243, 431 | camera counts: SLAP-2M recorded with 8, analyzed with 6 | fig4_detections.py CAMS = back, backL, mid, midL, top, topL; fig4_recovery_proofread2d.json n_cameras 6 for all 74; bvis5 pool 6 cameras | consistent | OK | Methods 243 says side and side-left were left out. Line 103 says "the six cameras" before the reader learns (113) the rig has eight; suggest "six analyzed cameras" there |
| 169 caption A | "the four-animal session" | fig4b_idf1_by_difficulty.csv animals | 3 four-animal sessions exist | wording | artwork also says "the 4-animal session"; fine if the grid shows one four-animal cage, otherwise "a four-animal session" |

## Provenance checks of the placed PDFs
- figures/fig5/fig5.pdf (Oct 20 15:16) assembled from panel PDFs dated 14:59, same minute as data/fig5 CSVs; artwork text: "n = 539 displays, 37 sessions", "median 0.40 s", "n = 428 of 539 displays", "> 2 s 9%", camera elevations 76/76/74/60/58 deg -- all agree with the text.
- figures/fig4/fig4.pdf (15:16) from panels dated 15:01; artwork "six proofread cameras", D counts n=0/10/3/10/3/3/13 agree with fig4b_idf1_by_difficulty.csv.
- Leftovers, not placed: figures/fig4/fig4b_idf1_by_difficulty.pdf and fig4e_detection_quality.pdf (Oct 3), data/fig5/fig5g_rear_coupling.csv (Oct 15 non-per-direction table), data/fig5/fig5s_benchmark50_subset.csv (old 50-session subset, Sep 20; not quoted in tex).
- No rearing table or figure caption exists after line 480 (grep "rear" after line 404 hits only the Lever 2006 reference).

## Problems, most important first
1. **Fig 5G caption understates the session filter.** "G uses 9,354 rear onsets from all 56 sessions, 2,915 ... within two body lengths" is true of the counts, but the plotted per-direction near curves keep only sessions with >= 20 onsets: 32 sessions (left, male around female onsets) and 13 (right, female around male onsets). Methods 325 states the rule; the caption should give the 32 / 13. The 50.2% / 6.2% in line 185 are pooled over all near onsets of all sessions, a different session set from the curves (fine, but worth a phrase).
2. **Fig 4C provenance/method wording (309, from the earlier run).** 4B (fig4_recovery_proofread2d.py) and 4C (fig4_detections.py --detections proofread -> out/fig6_detections_proofread_notail.json) come from two generators. "Same matching and keypoints" is true in procedure but not the same code, and the 4C deposit mislabels itself (detection_pool=keeptrack_h5s; caveats talk about the raw shared pool). Numbers are fine.
3. **Build provenance of Fig 4 is not self-documenting.** PROMOTE_fig4.log is empty, the x7 promotion stopped after fig3, and run_X7_build pass 2 loaded the plain Oct 8 fig9 deposit; the placed CSV nevertheless equals the md56 (= v1.0.5, M3_fig4d.log) deposit. The md56 deposit still carries `status: EXPLORATORY -- not part of the manuscript.` and records no LUC3D commit.
4. **Line 175 "mounted between 58 and 76 degrees".** The 58-76 deg is each camera centre's elevation seen from the animals at one instant of one session, not a mounting angle (optical-axis tilts are 71-89 deg). Suggest "positioned 58 to 76 degrees above the animals", as the caption already says.
5. **Camera wording (minor).** Counts are consistent: 8 recorded, side and side-left left out (Methods 243), 6 analyzed everywhere in scope (103, 169, 309, 485; code CAMS). Only line 103 says "the six cameras" before the reader is told the rig has eight; say "six analyzed cameras".
6. **Fig 4A caption "the four-animal session"** while 3 four-animal sessions exist. Fine if the grid shows only one; otherwise "a four-animal session".
7. **Housekeeping.** Unplaced leftovers sit beside placed files: figures/fig4/fig4b_idf1_by_difficulty.pdf, fig4e_detection_quality.pdf (Oct 3), data/fig5/fig5g_rear_coupling.csv, data/fig5/fig5s_benchmark50_subset.csv (old 50-session subset).

Everything else in scope checks out: all Fig 4 B-D numbers, all Fig 5 B-G numbers and P values (recomputed from data/fig5 and out/fig5_upright.json / fig5_rear_coupling_2animal_perdir.json), the pair- and animal-level tests, all four rearing controls (Supp 403), the 56 / 9 / 18 cohort counts (recounted from the BMimica points3d.h5 track names), and the pool definition in 267. Fig 5 B-G read the proofread 3D (approved by Eric 10-20, plan line 69); Fig 5A and Fig 4D are LUC3D v1.0.5.
