# Preprint audit: every finding, verified

**Manuscript audited:** `figs/figures/drafts/luc3d_newest.tex` as of 2026-09-29 03:10 (frozen copy `sweep_snapshot_0310.tex`, sha1 `6acb3a780ba1`). Line numbers refer to that file.
**Status:** all 8 second-pass ledgers complete (869 ledger rows). E5 verified (50/50 identical).

## ▶ TEXT CHANGES STILL NEEDED (checked against the 2026-09-29 15:25 `luc3d_newest.tex`)

Everything below was checked against the file you pasted at 15:25. Each **Current** is copied verbatim by script, so Ctrl-F finds it. **Done since the last check (13, all correct):** L136 Fig 2G caption, L154 (3.8 / 3.3), L167 and L180 (5.2), L175 (body length), L180 caption (your "79%", accurate: 428 of 539), L186 (Figure 5E), L278, L304 (RANSAC), L306 (protocol + undistortion), L338 ("long sessions"), L342, L354, L429.

N1–N6 are must-fix (two are needed because Fig 2E changed, four are typos or reverted fixes). N7–N10 are the remaining 2A items. N11 is optional.

- [ ] **N1 · L136** · **must: figure changed**
  - **Why:** Figure 2E bottom now plots **both** solvers (re-rendered 2026-09-29). This sentence still says "the DLT solve". Values: DLT 2.06 → 1.71 px (−0.345), refined 1.61 → 1.52 px (−0.095), both lower in 50/50 sessions.
  - **Current:** `Reprojection error in the kept views, all views in the DLT solve compared with the same solve with the worst view dropped, mean and t-based 95\% CI (bottom).`
  - **Replace with:** `Reprojection error in the kept views, each solver's all-view solve compared with the same solver with its worst view dropped, mean and t-based 95\% CI (bottom).`
- [ ] **N2 · L302** · **must: figure changed**
  - **Why:** Same figure change. The operation also drops the worst-fitting view **per keypoint** (by reprojection error), not "the camera with the least reliable detections". Both solvers improve in 50/50 sessions.
  - **Current:** `Figure~\ref{fig2}E scores the same solve before and after dropping the camera with the least reliable detections and shows an overall decrease in reprojection error.`
  - **Replace with:** `Figure~\ref{fig2}E scores each solver before and after dropping, for each keypoint, the view that fits it worst, and shows a decrease in reprojection error for both.`
- [ ] **N3 · L171** · must: ticked but not applied
  - **Why:** Ticked in the checklist but **not in the text**. 0.826 is the share of all displays (ties in the denominator); over initiated displays it is 0.857.
  - **Current:** `Over the 23 sessions with at least six displays, the female's median share of initiations is 0.83 (paired Wilcoxon $P = 2.7 \times 10^{-5}$, Figure~\ref{fig4}F).`
  - **Replace with:** `Over the 23 sessions with at least six displays, the female's median share of displays is 0.83 (paired Wilcoxon $P = 2.7 \times 10^{-5}$, Figure~\ref{fig4}F).`
- [ ] **N4 · L148** · must: visible typo
  - **Why:** **Reverted again** by a paste. The stray backtick prints as an opening quote mark.
  - **Current:** ``` The exhaustive rule is over the $\sim$22 million camera frames without missing instances.` ```
  - **Replace with:** `The exhaustive rule is over the $\sim$22 million camera frames without missing instances.`
- [ ] **N5 · L148** · must: reverted
  - **Why:** **Reverted again** by a paste.
  - **Current:** `It is computed as the number of detections matched to the right individual divided by the average of the ground-truth and predicted detection counts weighting false positives and false negatives equally.`
  - **Replace with:** `It is computed as the number of detections matched to the right individual divided by the average of the ground-truth and predicted detection counts, which weights false positives and false negatives equally.`
- [ ] **N6 · L180** · must: typo
  - **Why:** **New** double period, introduced with the 5.2× edit.
  - **Current:** `Around the male onset, the female is already $4.7\times$ above chance rate at lag 0, peaking at $5.2\times$ a third of a second later (right)..`
  - **Replace with:** `Around the male onset, the female is already $4.7\times$ above chance rate at lag 0, peaking at $5.2\times$ a third of a second later (right).`
- [ ] **N7 · L142** · should: 2A pending
  - **Why:** 2A #19 in the checklist. Describes the tracker as it was before the sync fix.
  - **Current:** `Following \citet{Chen2020}, LUC3D instead solves one Hungarian assignment per camera and commits it before moving on to the next, at a cost of $C \cdot A^3$ (the greedy Hungarian approach, Figure~\ref{fig3}A).`
  - **Replace with:** `Following \citet{Chen2020}, LUC3D instead solves one Hungarian assignment per camera and commits it before moving on to the next, with every camera scored against the same frame-start targets, at a cost of $C \cdot A^3$ (the greedy Hungarian approach, Figure~\ref{fig3}A).`
- [ ] **N8 · L397** · should: 2A pending
  - **Why:** 2A #20. The step from no eviction to N = 1 also switched on sync and the tighter threshold.
  - **Current:** `The largest single step was from no eviction to $N = 1$, and the differences among the evicting windows were small at the session level ($N = 20$ versus $N = 1$, 10 and 30, two-sided Wilcoxon signed-rank test, $P = 0.24$, 0.94 and 0.29).`
  - **Replace with:** `The largest single step was from no eviction to $N = 1$, which also turns on synchronous scoring and the tighter distance threshold, and the differences among the evicting windows were small at the session level ($N = 20$ versus $N = 1$, 10 and 30, two-sided Wilcoxon signed-rank test, $P = 0.24$, 0.94 and 0.29).`
- [ ] **N9 · L203** · should: 2A pending
  - **Why:** 2A #21. "About 30 times" holds only at 2 animals × 5 cameras (29×). The rest are 40×–8,800×.
  - **Current:** `On the frames where exhaustive enumeration can be run, which excludes frames with a missed or duplicated detection, greedy Hungarian matching with a 3D correspondence term misgroups fewer frames than the exhaustive strategy and runs about 30 times faster.`
  - **Replace with:** `On the frames where exhaustive enumeration can be run, which excludes frames with a missed or duplicated detection, greedy Hungarian matching with a 3D correspondence term misgroups fewer frames than the exhaustive strategy and runs about 30 times faster at two animals in five cameras and far faster in larger configurations.`
- [ ] **N10 · L243** · should: 2A pending
  - **Why:** 2A #22. The shortest session is 1.15 min.
  - **Current:** `In general, the experiments consisted of placing mice into an enclosure for 2 to 60 minutes and observing behavior.`
  - **Replace with:** `In general, the experiments consisted of placing mice into an enclosure for 1 to 60 minutes and observing behavior.`
- [ ] **N11 · L338** · optional
  - **Why:** Optional. Exact for the 61 sessions at 30 fps; the 13 at 60 fps get 1 s, and your L256 now states they exist.
  - **Current:** `SLEAP by default maintains an unbounded track pool, and ByteTrack, as run in the benchmark, retires any track lost for more than 60 frames, which is 2~s for SLAP-2M and 0.4~s for Mouse-Dyad-10M.`
  - **Replace with:** `SLEAP by default maintains an unbounded track pool, and ByteTrack, as run in the benchmark, retires any track lost for more than 60 frames, which is up to 2~s for SLAP-2M and 0.4~s for Mouse-Dyad-10M.`

---

## ACTION PLAN (read this first)

**Bottom line:** the core results hold. Every headline tracking, triangulation, rearing and calibration number was reproduced from the data. The shipped tracker reproduces the benchmark output byte for byte (E5). What needs fixing is (1) sentences that say something false or describe a figure panel wrongly, (2) a few numbers with no data behind them, and (3) three figures. About 870 checkable sentences were ledgered; roughly 80% passed outright.

**Tier 1: must fix before release (a reviewer could call these wrong)**
- The **A items** (10). Mostly one clause each. **A10** (the tracker's eviction mechanism, L286/L395) and **A9** (calibration controls on the old OpenCV setup) need real rewording or data.
- The **F items** (8), which need data or your answer: Panopticon deposit (F2), the 4.13 calibration controls (F1), HardFight proofreading (F4), ethics approval per dataset (F6), and the others.
- The **D items** (8): Fig 2E bottom (DLT only, wrong colour), Fig 2G clipped "300", the Supp Fig 1F legend "stale 0" → "no eviction", the datasheet "?".
- **I1:** upload the rebuilt Supplementary Figure 1. **I3:** deploy `main` to the live site.

**Tier 2: quick corrections (mostly one word or number each)**
- The **B items** (44), e.g. 5.3→5.2, "80% of displays" → "80% of displays with an initiator", panel letters, denominators, typos. Plus the **E items** (code and deposits).

**Tier 3: wording, your call (reviewers push back on these; not grounds for retraction)**
- The **C items** (21, overclaims such as "necessary", "real-time", "far fewer") and the **G items** (author decisions).

**Recorded, not for the text:** J1 (held-out camera error), per your instruction.

**Needs YOUR answer (short list):** F4 HardFight proofreading · F6 ethics approval per dataset · F2 where the Panopticon measurements live · G1 whether "LUC3D" names the app or the suite (L99 vs L263) · B31 which timing protocol to plot (matched best-of-3 gives 4.4× / 4.7×) · A10 whether to reword the mechanism (recommended) rather than change the tracker (not before Friday).

---

## How this audit was done, and what "verified" means

1. **First pass:** 8 independent read-only auditors, one per manuscript region plus one cross-cutting (repeated numbers, every `\ref`, panel letters). Each traced claims to the deposit the placed panel reads (`figs/out/*.json`, `figs/data/figN/*.csv`), to the drawing script, or to the app's code.
2. **I re-verified every finding myself** except the seven marked *(ledger evidence; not re-run by me)*, which are low severity and carry their reproduce command in the ledger. Every first-pass finding was re-verified against the files before listing it here. One finding was rejected (section H). One was my own deposit bug, now fixed (E1).
3. **Second pass:** 8 more auditors build an exhaustive per-sentence **ledger**: every checkable sentence, its source, the value, a verdict and a reproduce command. The ledgers are in the scratchpad (`ledger_*.md`), and coverage counts are in section I.

**Why this wasn't caught before:** the v1–v4 copydesk checklists were copy-edit reviews (wording, style, some facts). None traced every number to its data. Last night's work was scoped to the SLAP-2M fair re-run and the Supplementary Figure 1 text. This is the first full data audit.

**Reproduce conventions:**
- `PY=figs/.venv/bin/python`, run from the repo root `/root/vast/eric/sleap-3d-gui/scratch/repos/lucid`.
- `T=figs/figures/drafts/luc3d_newest.tex`.
- `LB=/root/vast/eric/luc3d-bench/liezl_env/bin/python`, which has cv2, pandas and motmetrics.

---

## A. FALSE as written (retraction risk). Fix before release.

| # | Line | Current text | What is true | Evidence / reproduce | Minimal fix |
|---|---|---|---|---|---|
| A1 | L146 | "one second of 150 fps Mouse-Dyad-10M video would take more than three days to process" | The 4-animal × 6-camera bound is a **SLAP-2M** configuration. Mouse-Dyad-10M is 2 animals × 5 cameras: 11.5 ms/frame, so about 1.7 s per second of video. At SLAP-2M's rate, 30 × 1,980.9 s ≈ 16.5 h. | `$PY -c "import json;[print(c['key'],c['dataset']) for c in json.load(open('figs/out/fig3_headtohead.json'))['configs'] if c['animals']==4]"` → `A4_C6_slap2m_hard SLAP-2M`. `figs/data/fig3/fig3e_head_to_head.csv` row 4×6: `exhaustive_lo_s` = 1980.90 | "one second of 30 fps SLAP-2M video would take more than 16 hours to process" |
| A2 | L118 | "enclosure" | **AUTHOR DECISION 2026-09-29: keep. Not an error.** The flag came from the `figs/DATA-LOCATIONS.md` note, which should be updated to match | — | no change |
| A3 | L131 | "leads to more accurate 3D estimates compared with ground truth" | Fig 2E top is scored against the held-out camera's **raw detections**. No ground-truth 3D is involved. | `figs/panels/fig2_12_accuracy_vs_cameras.py` docstring: "score against that camera's RAW DETECTION… No reference 3D enters it" | delete "compared with ground truth" |
| A4 | L136 | Fig 2G caption: "~17 million keypoints, the same keypoints in every column" | Only the two LUC3D bars were timed on 17,013,412 keypoints. Anipose linear was timed on 200,000 and Anipose optim on 345,000. | `$PY -c "import json;t=json.load(open('figs/out/fig4_anipose.json'))['timing'];print(t['anipose']['n'],t['anipose_optim']['at_n'])"` → 200000 345000 | "~17 million keypoints for LUC3D; Anipose timed on 200,000 (linear) and 345,000 (optimized) keypoints" |
| A5 | L256 | "The video resolution for all datasets is 1280x1024 pixels." | The 18-camera calibration rig is 1680×1200 (L402) and Panopticon is 1920×1200 (L451). | `grep -n "1680\|1920" $T` | "for all three pose datasets" |
| A6 | L256 | "The SLAP-2M video data has a frame rate of 30 FPS." | **13 of 74 sessions (every 2022-10-19 session) are 60 fps.** 61 are 30 fps. | `$LB -c "import pandas as p;m=p.read_csv('/root/vast/eric/luc3d-bench/outputs/predictions_master_sheet.tsv',sep='\t');print((m.frames/(m.duration*60)).round(1).value_counts(dropna=False))"` → 30.0×55, 60.0×13, NaN×6. The 6 NaN sessions read 30.0 fps from the video with cv2; `10192022174304/mid` reads 60.002 fps | "30 FPS (60 FPS for the 13 sessions recorded on 19 October 2022)" |
| A7 | L300 | "The application's menu labels the non-linear solver as ``Refined''." | **DOWNGRADED to a precision fix.** On `main` (PR #224, dcd7afb) the solver is titled "Refined (Ref)"; the menu item reads "Ref" and the info panel "Refined". This branch (`eric/figs`) and the **deployed site still show "BA"** | `git grep -n Refined origin/main -- ui/` (settings-modal.js:231 "Refined (Ref)"); `git show origin/main:index.html \| grep data-method=\"ba\"` → "Ref" | "…labels the non-linear solver ``Refined (Ref)''", **and deploy `main` before release (see I4)** |
| A8 | L112 | "overlaying the reconstruction onto Camera 0's perspective (left)" | The render is no longer drawn from camera 0's viewpoint. It uses a corner view, and the left tile shows the 2D detections. | `sed -n 33,36p figs/panels/fig1_03_reconstruction.py`: "It is no longer drawn from cam 0's calibrated viewpoint" | describe the tile as it is drawn, e.g. "showing that camera's detections (left)" |
| A9 | L406, L414 | equal-frames and reference-camera controls on the old OpenCV 5 setup | **RESOLVED 2026-09-29 by re-running both controls with both tools on OpenCV 4.13** (`figs/fig7_calib_controls_413.sh`, version asserted). All L414 claims hold: equal frames −0.12 px, same reference 0.000, calibrat3 0.188 against 1.133/1.131. New transcode, so the absolute defaults (1.252/0.188) differ from the figure's (1.280/0.212) | `figs/data/fig7/fig7s3_equal_frames.csv` (4.13); old: `fig7s3_equal_frames_opencv5.csv` | **no text change** |
| A10 | L286 (and the mechanism story in Supp 5.2, L395) | "every camera is scored against a recent anchor, which is what prevents a long-lost identity from competing for assignments at full strength" | **The shipped code does not do this.** Eviction removes stale per-camera detections, but the target's 3D anchor (`points3d`) is neither cleared nor recomputed. `_retriangulate` keeps the old anchor when fewer than 2 detections remain, and targets are never deleted. The per-frame time penalty applies only to the 2D term. So an identity lost in every camera keeps its last 3D position and scores the **full** 3D term. Eviction's real effect: anchors that are re-triangulated come only from recent views. The measured switch reduction stands; the stated mechanism does not | `sed -n 160,168p pose/cross-view-tracker.js` (keeps points3d if <2 dets); `sed -n 261,268p` (eviction deletes detsByCam only); `sed -n 346,350p` (decay on 2D only); ledger probe `ledger_L213-297.md` row L286: after 100 empty frames detsByCam = 0, points3d unchanged, adj3d = 36.0 = max | rewrite the mechanism to what the code does, e.g. "An anchor is therefore only ever re-triangulated from cameras that saw the animal recently, so views that lost the animal no longer pull the anchor toward stale positions." Also check L395's "continues to compete… at full strength" framing, which is still true **with** eviction for fully lost identities. **Do not change the tracker before Friday**: that would change every tracking number |

## B. MISMATCH (numbers or attributions disagree). Fix before release.

| # | Line | Current text | Issue | Evidence / reproduce | Minimal fix |
|---|---|---|---|---|---|
| B1 | L167 + Fig 4 caption G (L180) | "peaks at 5.3 times a third of a second later" | The peak is 5.2477, which rounds to 5.2 | `$PY -c "import pandas as p;print(p.read_csv('figs/data/fig4/fig4g_rear_coupling.csv').female_p50.max())"` → 5.2477 | "5.2" in both places |
| B2 | L180 Fig 4 caption lead | "the female starts 80\% of the displays" | 80% is 428 of the **535 displays with an initiator**. Of all 539 it is 79.4% | `$PY -c "import json,pandas as p;e=p.DataFrame(json.load(open('figs/out/fig5_upright.json'))['events']);print(e.initiator_track.value_counts(dropna=False))"` → 1:428, 0:107, NaN:4 | "80\% of the displays with an initiator" |
| B3 | L186 | "Figure~\ref{fig5}C shows… from 5.3 to 57.7\%" | 5.3 and 57.7 are **panel E's** per-session means. Panel C's pooled rates are 5.38 and 57.07, and the caption quotes 57.1 | `figs/data/fig5/fig5e_detection_quality.csv` miss_rate .0534/.5770; `fig5c_recovery_surface.csv` raw_miss_pct 5.38/57.07 | add "(Figure~\ref{fig5}E)" after "57.7\%" |
| B4 | L203 | "runs about 30 times faster" | 29× holds only at 2 animals × 5 cameras. The others are 40×, ~4,400× and ~8,800×, and 4×6 is intractable | `$PY -c "import pandas as p;d=p.read_csv('figs/data/fig3/fig3e_head_to_head.csv');print((d.exhaustive_s/d.luc3d_s).round(0).tolist())"` | "runs about 30 times faster at two animals in five cameras, and far faster at more" (note: "at least 30" would be false, since 2×5 is 29.2×) |
| B5 | L209 | "starting the large majority of them across nearly every session and every pairing" | 17 pairings produced displays. The female majority holds in all 17, but the weakest pair is 3 of 5 (60%) | group `figs/data/fig4/fig4f_leader_by_session.csv` by male_id\|female_id and take female_lead/(female_lead+male_lead): min 0.60 | "the majority of them" |
| B6 | L249 | "a 300-frame window was taken for Figure 1 and Figure 2A" | HardFight is also Fig 3D, and only Fig 1C/D (not A, B, E) | Fig 3 caption L159 "D is one frame of the HardFight recording" | "for Figure~\ref{fig1}C and D, Figure~\ref{fig2}A and Figure~\ref{fig3}D" |
| B7 | L338 | "Both defaults fragment identities on 20-minute sessions." / "2~s at SLAP-2M's 30 fps" | SLAP-2M sessions are 1–60 min (median about 10), and 13 are 60 fps (so 60 frames is 1 s there) | see A6 | "on long sessions"; "1 to 2~s at SLAP-2M's 30 and 60 fps" |
| B8 | L354 | "The paired comparisons in Supplementary Figure~\ref{fig6}A and C report 95\% bootstrap confidence intervals" | Panel C shows boxes (median, IQR, 1.5×IQR), not a CI | `figs/panels/fig6_02_by_animals.py` boxplot `whis=1.5`; caption L429 | "Supplementary Figure~\ref{fig6}A reports" |
| B9 | L395 | "an identity that lost its animal minutes earlier" | The maximum measured anchor age is 8,652 frames = 57.7 s (8 sessions) | `$PY -c "import json;print(max(s['max_age_frames'] for s in json.load(open('figs/out/fig8_diag_anchor_age.json'))['per_session'])/150)"` | drop "minutes": "that lost its animal earlier" |
| B10 | L278 | "committing each camera's assignment before the next is solved" | This describes the tracker before the sync fix. Now every camera in a frame is scored against the same frame-start targets, and it re-triangulates at frame end | `sed -n 150,158p pose/cross-view-tracker.js` ("every camera's Hungarian this frame sees the SAME points3d") | "solves one Hungarian assignment per camera against the same frame-start targets" |
| B11 | L243 | "placing mice into an enclosure for 2 to 60 minutes" | The shortest SLAP-2M session is 1.15 min (10192022174304) | master sheet `duration` min = 1.146 | "1 to 60 minutes" |
| B12 | L131 | "error falls from 4.32 pixels with two cameras to 3.34 pixels with four" | This is the **DLT** curve. Refined goes 4.42 → 3.15 | `figs/data/fig2/fig2e_accuracy_vs_cameras.csv` dlt_p50 / ba_p50 | "error in the DLT solve falls from 4.32…" |
| B13 | L142 | "…32 hypotheses for two animals in five cameras and ∼190 million… (Figure~\ref{fig3}B)" | Panel B draws 2/4/6/8 cameras only, so it has no 5-camera curve | `grep -n "^CAMERAS" figs/panels/fig3_03_cost_model.py` → [2, 4, 6, 8] | move the `\ref` to just after "four animals in six cameras" |
| B14 | L118 Fig 1B caption | "The bracket marks the stages contributed by this paper." | The bracket deliberately spans all 7 stages, including SLEAP's 2D detector, which L112 says LUC3D does not include | `sed -n 1,23p figs/panels/fig1_01_pipeline.py` | "The bracket marks the pipeline this paper presents end to end." |
| B15 | L118 Fig 1D caption | "Middle, the 3D viewport." | The middle tile is a Blender render of the app's reconstruction, not a capture of the viewport | `figs/panels/fig1_03_reconstruction.py` (reads `fig1d_pose.png`) | "Middle, the reconstructed 3D poses." |
| B16 | L429 Supp Fig 1 caption A | "(mean +- 95\% bootstrap CI)" | The LUC3D interval is a normal approximation (1.96·sd/√n). Only SLEAP and ByteTrack are bootstrapped | `grep -n "1.96" figs/fig6_variant_tracker.py` | "(mean ± 95\% CI)" |
| B17 | Supp Fig 1F legend (artwork) + L397 | legend "stale 0"; text "the largest single step was from no eviction to N = 1" | The "stale 0" arm is the `shipped` configuration: **no eviction, no sync, distThresh 50**. N = 0 would mean evict everything. The step to N = 1 also turns on sync and distThresh 25 | `figs/out/fig8_methods_50.json` configs; `figs/panels/fig6_07_pr_switches.py` L13–15 ("LABELLED 'no eviction'") vs L114 `("shipped","stale 0",INK)` | relabel the legend "no eviction"; L397 "the largest single step was from no eviction to N = 1, which also enables synchronous scoring and the tighter threshold" |
| B18 | L112 | "notably Label3D and JARVIS both provide it" | "it" has no clear antecedent. In Fig 1E, Label3D has 3D proofreading and JARVIS only reprojection-error review | `figs/data/fig1/fig1e_tool_table.csv` | name the capability for each |
| B19 | L404 | "gives 882 and 378" | The 18-camera calibrat3 median is 378.5 (9th/10th of 18 = 375/382, `figs/out/fig7_calibration.json` datasets.calib18.timing.calibrat3_800.detectionPerView) | | "379" |
| B20 | L443 Supp Fig 3 caption I | "camera center… each as a percentage of its known value" | Camera center is a residual divided by the median camera spacing | `grep -n centre_pct figs/fig7_calib_gt_compare.py` | "(camera center, as a percentage of the median camera spacing)" |
| B21 | L406 | "The settings changed, the synthetic-rig parameters and the held-out frame counts are given in Supplementary Section~\ref{subsec-calib}." | That section gives neither the synthetic-rig parameters nor the held-out count (900 is only in the Supp Fig 3 caption) | | drop "the synthetic-rig parameters and", and cite Supplementary Figure~\ref{fig8} for the frame count |
| B22 | L389 | "higher by 0.026 (26 of 74 sessions, sign test $P = 0.14$)" | Correct numbers, but it is a mean. SLEAP is ahead in 39, 9 are tied, the median is about 0, and the text does not say P excludes ties | `figs/out/fig6_slap2m_fair.json` `paired.luc3d_minus_sleap__all` | your call (you asked for minimal). Optional: "(26 of 74 sessions, 9 tied, sign test excluding ties $P = 0.14$)" |
| B23 | L171 | "the female's median share of initiations is 0.83" | 0.826 is the share of **all displays** (ties in the denominator). Over displays with an initiator it is **0.857** | scratchpad `chk4.py` → `chk4_output.txt` L17–18 | "median share of displays is 0.83", or "share of initiations is 0.86" |
| B24 | L175 | "the per-animal threshold based on body height" | The threshold is in **body lengths** (0.75 BL) | `sed -n 8,12p figs/fig4_controls.py`; `figs/fig4_upright.py` | "based on body length" |
| B25 | L180 Fig 4 caption E | "the female is neither approaching nor retreating" | Female session medians are negative in 29 of 37 sessions (median −0.07, Wilcoxon vs 0 P = 0.004): small but not zero | `chk4_output.txt` L121 | "the female barely moves relative to him", or report the value |
| B26 | L180 Fig 4 caption G | "yellow, the same onsets further apart" | Near and far are **different** onsets (2,915 near vs 6,439 far) | `chk4_output.txt` L60 | "yellow, onsets with the pair further apart" |
| B27 | L180 Fig 4 caption footer | "have no initiator and are excluded from C and F" | F's shares keep the 4 tied displays in the denominator | `chk4_output.txt` L13–18 | "excluded from C" (or recompute F without ties) |
| B28 | L186 | "(See Figure~\ref{fig5}E) (middle)" | malformed double parenthetical | text | "(Figure~\ref{fig5}E, middle)" |
| B29 | L148 | "...without missing instances.`" and "counts weighting false positives" | the stray backtick and wording fix were **reverted by the 03:10 paste** (checklist L148 items) | `grep -n 'instances.\`' $T` | remove the backtick; ", which weights" |
| B30 | L142, L278, Fig 3A caption | "commits it before moving on to the next" / "sequential Hungarian" | reads as though each camera's match changes the next camera's cost. It does not: every camera sees the frame-start state (see B10) | `sed -n 45,56p pose/cross-view-tracker.js` | "solves each camera in turn against the same frame-start targets" |
| B31 | L306 + Fig 2G | "taking the best of three runs" / "4.6 and 5.2 times faster" | Only aniposelib (and a separate 200k-keypoint LUC3D recheck) were best-of-three. The **plotted LUC3D bars** (6.32 / 44.0 µs) are a **single pass** over 17M keypoints (`figs/out/fig4.json` methods). Timed the same way as Anipose (best of 3, n = 200k), LUC3D is 6.60 / 48.99 µs, so the speed-ups are **4.4× and 4.7×** | `$PY -c "import json;t=json.load(open('figs/out/fig4_anipose.json'))['timing'];print(t['luc3d_recheck']['dlt_us_per_keypoint'],t['luc3d_recheck']['ba_us_per_keypoint'],t['anipose']['us_per_keypoint'],t['anipose_optim']['us_per_keypoint'])"` | **your call:** (a) plot the matched best-of-3 numbers and quote 4.4× / 4.7×, or (b) keep the bars and say they are a single pass over 17M keypoints, with the best-of-three recheck agreeing within 4% (DLT) and 11% (refined) |
| B32 | L304 + Fig 2G | "The temporal smoothing term in the non-linear path was disabled." | True for the **accuracy** run (Fig 2F, `optim_nosmooth`). The Fig 2G **timing** of Anipose optim called `optim_points` with library defaults, i.e. smoothing **on** | `sed -n 434,437p figs/fig2_solvers_anipose.py` | "…was disabled for the accuracy comparison; the timing uses the library defaults" |
| B33 | L338, L342 | "ByteTrack default setting often prematurely retires tracks" / "Both defaults" | ByteTrack's library default is `lost_track_buffer = 30`. The benchmark's 60 was a tuned value (`run_bytetrack_bench.py`: "tuned winner… 2026-05-17") | `grep -n "lost_track_buffer: int" .../supervision/tracker/byte_tracker/core.py` → 30 | "ByteTrack as first run (60-frame buffer)…" |
| B34 | L302 | "dropping the camera with the least reliable detections" | Fig 2E bottom drops the **worst-fitting view per keypoint** (by reprojection error), not a camera | `figs/out/fig4_robust_sessions.json` claim: "the same solve with the worst-fitting view dropped" | "dropping, for each keypoint, the worst-fitting view" |
| B35 | L312 | "Missing keypoints are by reported by difficulty rating" | typo | text | "are reported by" |
| B36 | L258 | "between output capture signals and output stimulation" | typo/garble | text | "between capture signals and stimulation output" |
| B37 | L326 | "every per-animal feature identical to the last digit" | The slot-swap control compares a fixed set of paired fields, not every feature | `sed -n 40,72p figs/fig4_slot_swap_control.py` | "every compared per-animal feature identical…" |
| B38 | L340 | SLEAP flags listed without `--tracking_clean_instance_count` | That flag was also set (both corpora) | `figs/fig6_sleap_max2_retrack.py` CAP_FLAGS; `figs/fig6_slap2m_fair.py` cap_flags | add it (= the existing checklist entry "L342 Imprecise") |
| B39 | L422 + Supp Fig 4E | "differed from one another by up to 13 parts per million, a drift of 15~ms" | panel E spans about −211 to −223 ppm (≈12 ppm, ≈14 ms over 19 min). No deposit exists to settle it exactly (F2) | rendered `figs/fig9.pdf` panel E | set from the deposit once it exists |
| B40 | Supp Fig 4 caption (L451) | "100\,fps" | every preview pane in panel A reads "30 fps". Panel D's 9.997 ms median interval confirms 100 fps acquisition, so the panes show the display rate | rendered `figs/fig9.pdf` panel A | caption: "(preview panes display at 30 fps)" |
| B41 | L443 caption G | "with one setting changed" | the "…and no rejection" row changes two (Anipose's intrinsics + no rejection) | `figs/data/fig7/fig7g_mechanism.csv` row `abl_anipose-model-no-rejection` | "one or two settings changed" |
| B42 | L443 caption | "(A to G are scored on Anipose's own detected corners so the comparison that does not favor calibrat3." | ungrammatical | text | "…corners, so the comparison does not favor calibrat3.)" |
| B43 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* L274 | "At 150 fps an animal moves less than a millimeter between consecutive frames" | holds for the median; 26–40% of frame steps exceed 1 mm *(ledger L213-297 reproduce)* | ledger row L274 | "typically moves less than a millimeter" |
| B44 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* L272 | Fig 3E "every frame" | Fig 3E is scored on eligible (clean) frames only | `figs/out/fig3_quality*.json` | "on the eligible frames" |

## C. OVERCLAIMS (states more than anything measured). Reword before release.

| # | Line | Current text | Why | Minimal fix |
|---|---|---|---|---|
| C1 | L205 | "far fewer manual labels than a traditional single-view set up" | The only measurement (Fig 2B) is against labelling every view of the rig by hand: 75 → 32 placements. No training set was built | "fewer manual labels than labeling every view by hand" |
| C2 | L207 | "Without LUC3D it scales linearly with the number of cameras (…doubles… quadruples…)" | Proofreading time was never measured | "it is expected to scale linearly…" |
| C3 | L209 | "multi-camera 3D pose estimation was necessary to characterize it" / "would not be visible without cross-view identity and metric distance" | No 2D or single-view comparison was run | "was used to characterize it" |
| C4 | L186 | "because the animals occlude one another while most enrichment objects are transparent" | Transparency is recorded nowhere, and the cause was not measured | delete the clause, or "consistent with the animals occluding one another" |
| C5 | L112 | "LUC3D identifies that the remaining detection is a duplicate" | The tracker only leaves it unassigned. Duplicate status was established afterwards | "LUC3D leaves the remaining detection unassigned; it is a duplicate of…" |
| C6 | L99 | "speeds up multi-view labeling considerably" | Labelling time was not measured, only placements | "reduces the manual placements needed for multi-view labeling" |
| C7 | L101 | "accurate labels in all remaining views" | At 5 cameras, 2.5 of 45 reprojected placements still need correcting at 10 px | "labels in all remaining views" |
| C8 | L101 | proofreading "requires reviewing it once rather than once per camera" | No proofreading-effort measurement exists | frame it as design, not a measured result |
| C9 | L395 | "the parameter sweep in Supplementary Figure~\ref{fig6}F identifies their main cause" | Every evicting arm also changes sync and distThresh, so F cannot isolate eviction | "is consistent with their main cause" |
| C10 | L186 | "IDF1 score degrades with increased difficulty" | The medians are not monotonic (0.989, 0.917, 0.969, 0.675, 0.877, 0.654) | "generally degrades" |
| C11 | L203 | "The ablation shows that the 3D term is what makes the greedy search competitive" | r = 0 (632/100k) is on the ~45M full-session frames and exhaustive (81/100k) on the ~22M clean frames. The only frame-matched comparison is the default, greedy 8.0 vs exhaustive 81 on the same 21.6M frames (`figs/out/fig3_frame_matched_bmimica.json` arms). L148 discloses the two bases | "The ablation suggests…" |
| C12 | L207 | "produces an automated proofread output" | the output still contains errors (IDF1 0.861, hardest SLAP-2M stratum median 0.654) | "produces an automated first-pass output for…" |
| C13 | L211 | "eliminating installation requirements… makes 3D pose estimation accessible" | the 2D detector (SLEAP) must still be installed (L112, L270) | "eliminating installation for everything after 2D detection…" |
| C14 | L203 | "real-time interactive cross-view tracking" | timed in Node at 0.39–1.0 ms/frame. The app runs Track Frame and batch Track All; no real-time mode is measured | "interactive cross-view tracking" |
| C15 | L125 | "while increasing the precision of each keypoint's placement" | not measured (Fig 2B measures effort only) | delete the clause |
| C16 | Section 2.6 title | "without sacrificing overall pose quality" | no deposit measures the accuracy of recovered keypoints | *(your call)* "Multi-view recovers missing points" |
| C17 | L199 | "speed up labeling and proofreading" | no timing | "reduce the manual work of labeling and proofreading" |
| C18 | L320 | "A negative score means the animal is oriented toward its partner and approaching it, and a positive score means it is oriented away and retreating" | The pursuit score is cos(facing, direction to partner) × **unsigned** speed (`figs/fig4_upright.py` L199–201), so the score alone cannot tell toward from away. **Checked 2026-09-29: the approach claim itself holds.** Separation closes before onset in 30 of 37 sessions (median −0.05 BL/s, Wilcoxon P = 0.003), and the male is faster in 28 of 37 (0.36 vs 0.20 BL/s). The results sentences (L169, L209) can stay | reproduce: `$PY -c "import json,pandas as p;from scipy import stats;e=p.DataFrame(json.load(open('figs/out/fig5_upright.json'))['events']);g=e.groupby('session').approach_bl_s.median();print((g<0).sum(),len(g),stats.wilcoxon(g).pvalue)"`. Fix only L320: "A negative score means the animal is moving while oriented toward its partner, and a positive score that it is moving while oriented away." Optionally cite the separation closing as support |
| C19 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* L219 | "prediction files larger than the browser's available memory can still be opened" | the lazy loader keeps the whole column store resident (≈1.8 GB typed arrays on the real project, CLAUDE.md luc3d #193); only frames are lazy | "large prediction files can be opened without loading every frame" |
| C20 | L404 | "Its detector covers every frame in which a camera sees the board" (Its = aniposelib) | aniposelib 0.8.0 `CalibrationObject.detect_video(skip=20)` samples every 20th frame until the board appears, then windows around it (verified from the library source) | "…nearly every frame…", or describe the sampling |
| C21 | L243 | "All three recordings have been manually proofread in 3D." | SLAP-2M proofreading was in 2D, "Manual + Automated" (datasheet). HardFight: only predicted instances found (F4) | describe per dataset |

## D. FIGURE fixes (artwork). Re-render, then re-upload.

| # | Figure | Problem | Evidence | Fix |
|---|---|---|---|---|
| D1 | **Fig 2E bottom** | Plots **only the DLT solve** (all views vs worst view dropped) but draws it in **TEAL**, the colour the top axis's legend uses for "refined". Refined is not plotted at all. Its bars are a t-based 95% CI of the mean, while the caption's CI sentence describes a median CI | `figs/out/fig4_robust_sessions.json` claim "the all-view DLT solution…"; `figs/panels/fig2_06_solver_accuracy.py` L76 `color = TEAL` and mean ± tcrit·sem | colour it SALMON (DLT), and caption the bottom as "(DLT; mean and t-based 95\% CI)". Or add the refined series if you want both |
| D2 | **Fig 2G** | The top y tick label "**300**" is clipped by the panel's top edge | rendered `figs/figures/fig2/fig2.pdf` (tick at y ≈ 425 pt, only its lower half visible) | raise the panel's top margin or drop the 300 tick; re-assemble Fig 2 |
| D3 | Fig 2G | Anipose-optim whisker (203.6–228.8) is undescribed in the caption | `figs/panels/fig2_08_time_per_keypoint.py` | caption: say what the whisker is |
| D4 | Supp Fig 1F | legend "stale 0" → "no eviction" (see B17) | `figs/panels/fig6_07_pr_switches.py` L114 | relabel, re-sync fig6, re-assemble |
| D5 | Datasheet | SLAP-2M "Total Animals" prints a literal "?" | `figs/dataset_sheets.py` L97 `("Total Animals", "?")`; `figs/figures/datasheets/datasheet_combined.pdf` | fill in the count or delete the row |
| D6 | Fig 1D label | "Hard Fight rig", but "HardFight" everywhere else | rendered fig1 | "HardFight" |
| D7 | Fig 3F caption | error bar on the 4×6 open marker (up to 75,587 s, slowest rate × (A!)^C) is not described | `figs/panels/fig3_06_head_to_head.py` `exhaustive_hi_s` | caption: "bar, slowest to fastest measured rate" |
| D8 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* Supp Fig 1 caption E | "on one real frame": the anchor gaps are drawn schematically and the scene uses two frames | `figs/panels/fig6_00_chen_style.py` *(ledger L377-432)* | "schematic on a real frame" |

## E. CODE / DEPOSIT fixes (reproducibility)

| # | Item | Status |
|---|---|---|
| E1 | `figs/out/fig6_slap2m_fair.json` stored only the ties-as-losses sign P (0.014). The text quotes the ties-excluded 0.14, which was in no file | **FIXED 2026-09-29.** The driver now also writes `sign_p_ties_excluded` (all 0.136, ≥2 animals 0.164, 3–4 animals 0.0156). Reproduce: `$LB figs/fig6_slap2m_fair.py --stage stats` |
| E2 | `figs/fig4_controls.py` has `MIN_DISPLAYS = 5` (prints 24 sessions), but the text and Methods report ≥6 (23 sessions) | **TODO:** set 6 (as `fig4_replication.py` `MIN_SESSION_DISPLAYS_F = 6` already does). The text numbers match the ≥6 deposit |
| E3 | `figs/DATA-LOCATIONS.md` says SLAP-2M is "30.0 fps on every session" and "18.1 h" | **TODO:** 13 sessions are 60 fps, so the corrected total is about 17.4 h. Repo doc only, not in the manuscript |
| E4 | `panels/fig3_06_head_to_head.py` uses `FPS = 50.0` in an unplaced footnote | low; fix to avoid future reuse |
| E5 | **Shipped tracker ≡ benchmarked configuration** (L336 "every measurement in the paper describes the released tracker") | **VERIFIED 2026-09-29: 50/50 sessions byte-identical.** The real `pose/cross-view-tracker.js`, run through `figs/fig3-bench/fig3_bench.mjs`, reproduces the SHA-256 of the identities+frames payload of every deposited `figs/out/tmp/fig8m50/sync_stale20_dist25/` run. Deposit: `figs/out/verify_shipped_tracker.json`. Reproduce: `NODE=/root/vast/eric/node22_env/bin/node figs/.venv/bin/python figs/verify_shipped_tracker.py --sessions 50 --workers 25` |
| E6 | L324 pair-level sign test (14/14, P = 1.2e-4) and the female-share Wilcoxon | no script or deposit computes them. The ledger recomputed 14/14, P = 1.2e-4 and 9.7e-4, so the text is right but not reproducible from the repo | **TODO:** add them to `fig4_replication.py` output |
| E7 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* un-suffixed `figs/out/fig3_quality.json` does not match the paper; only the suffixed default-arm file does | **TODO:** rename or delete so nobody reads the wrong one *(ledger L197-212)* |

## F. DATA that must exist before release

| # | Claim | Problem | What to do |
|---|---|---|---|
| F1 | Calibration controls (A9) | **DONE.** Re-run on 4.13 | see A9 |
| F2 | Panopticon: 1.15 vs 0.48 px, 32,532 corner observations, 1.3% focal agreement, timing (9.997 ms median interval, 2.3 µs jitter, 210–223 ppm), 542–2,118×, nine-camera Basler rig | **No deposit anywhere in the repo.** Nobody can reproduce these | deposit the Panopticon measurement outputs (or cite where they live) |
| F3 | L404 "867 to 1,003 frames per session"; L443 "9,029" and "12,621" frames | Per-session frame lists are not deposited | deposit them (from the calibration bench) |
| F4 | L243 "All three recordings have been manually proofread in 3D" | Every HardFight file on disk contains only predicted instances. The datasheet says SLAP-2M is "Manual + Automated" | **Your answer needed:** where is the proofread HardFight? Otherwise reword |
| F5 | L136 / L262 six Mouse-Dyad sessions of 2025-09-08 | Empty `calibration/`, run on the previous day's rig, which the text does not say | add "(6 using the preceding day's calibration)" |
| F6 | L253 ethics | only Princeton IACUC is cited. SLAP-2M and HardFight may have been recorded elsewhere | **Your answer needed:** approval body per dataset |
| F7 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* L406 "calibrat3's detections passed to aniposelib's solver" control | exists only in the old run (HEAD `fig7s2`); its result is reported nowhere | report it or remove the sentence |
| F8 | *(ledger evidence; not re-run by me; reproduce command in the ledger)* L406/L416 synthetic rig | built with an off-centre principal point and fy ≠ fx, which aniposelib's model cannot represent. Not disclosed | disclose the parameters (8 cameras, 1280×1024, principal-point offset median 19.7 px, fy/fx +3.5%, k2 0.05: `figs/out/fig7_calibration.json` `synthetic.raw`) |

## G. AUTHOR DECISIONS (not errors in data)

- **G1, L99 vs L263.** L99 says "LUC3D also includes … a browser-based camera calibration tool", while L263 says "This paper presents a browser-based calibration tool called calibrat3". The LUCID app itself does not calibrate (MODULES.md). Decide whether "LUC3D" names the app or the suite, and say it once.
- **G2, L148.** The exhaustive reference's identities are threaded across frames by nearest-3D-centroid matching, which is our scaffolding and not the published method. Consider disclosing it.
- **G3, L201.** "fast enough for interactive use in the browser" rests on timings from Node, not the browser.
- **G5, licenses.** The luc3d and calibrat3 GitHub repos have no license file *(reported by ledger; confirm on GitHub)*. Release without a license = not legally reusable.
- **G6, L129** "solved from all five views and then corrected by hand": the repo does not document how the Mouse-Dyad proofread 3D was made. Confirm.

## H. REJECTED (checked and found not to be a problem)

- **L387 "the same SLEAP and ByteTrack settings as Supplementary Figure 1A".** The SLAP-2M SLEAP run used flags identical to Mouse-Dyad's `SHARED_FLAGS` plus the per-session cap. Only the sleap-nn version and N differ, and L340 discloses both.
- **The Supp Fig 1 caption does not need changing** after the rebuild. No numbers; every panel description still holds.

## I. Pre-release steps outside the text

1. **Upload the rebuilt Supplementary Figure 1.** Nothing in the repo copies figures to the LaTeX build. Repo `figs/figures/fig6/fig6.pdf` goes to build `figs/fig6.pdf`. Also note that build `figs/fig8.pdf` = repo `figs/figures/fig7/fig7.pdf` (calibration), while build `figs/fig7.png` (GUI screenshot) and `figs/fig9.pdf` (Panopticon) are not in the repo.
2. **Unfinished statement:** L365 is `% TODO: add code availability statement` *(confirm in ledger)*.
3. **Deploy `main` to the live site** (luc3d.sleap.ai still shows the old "BA" label; the paper describes `main`).
4. **Commit** the drivers, deposits, rebuilt figure and `.tex` (nothing is committed yet).

## J. ON RECORD, NOT FOR THE TEXT (your decision 2026-09-29: do not add to the manuscript)

Kept here so the answer is ready if a reviewer asks. **No edit is proposed.**

- **J1, held-out-camera triangulation error (Fig 2F data).** The paper reports in-solve error, where LUC3D refined is lowest (2.152 px, 50/50 sessions). The same deposit's held-out rows give Anipose 3.107, Anipose optim 3.111, LUC3D refined 3.147 (worse than Anipose in 49/50) and DLT 3.336 px. The difference is about 1%, so "little difference" (L154) and "match the accuracy" (L201) stand. Reproduce: `$PY -c "import pandas as p;d=p.read_csv('figs/data/fig2/fig2f_per_session.csv');print(d.groupby('group')[['anipose','anipose_optim','dlt','refined']].median())"`

## Coverage (all 8 ledgers complete)

| Region | Ledger | Rows | PASS | Problems |
|---|---|---|---|---|
| L1–122 | `ledger_L001-122.md` | 76 | 52 | 10 (+14 not checkable) |
| L377–432 | `ledger_L377-432.md` | 84 | 66 | 11 (+7 not checkable) |
| L123–162 | `ledger_L123-162.md` | 120 | 95 | 17 (+8 not checkable) |
| L163–196 | `ledger_L163-196.md` | 114 | 96 | 15 (+3 not checkable) |
| L197–212 + abstract | `ledger_L197-212.md` | 48 | 25 | 18 (+5 not checkable) |
| L213–297 | `ledger_L213-297.md` | 179 | 148 | 25 (+6 not checkable) |
| L298–376 | `ledger_L298-376.md` | 125 | 102 | 17 (+6 not checkable) |
| L400–end | `ledger_L400-end.md` | 123 | ~91 | 26 (+6 not checkable) |
