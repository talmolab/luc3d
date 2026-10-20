# LUC3D paper fix checklist (2026-10-15)

**Purpose.** Use this checklist to work through every problem found in today's audits, one item at a time, until the paper is ready to send. The evidence and full findings are in `figs/figures/drafts/AUDIT-2026-10-15-ADVERSARIAL.md`, referred to below as **AUDIT** with a section number (§). This file says *what to do*, *in what order*, and *how to prove it is done*.

**Line numbers** (`L103`, …) refer to `luc3d_newest.tex` as of ~06:00 UTC on 2026-10-15. They drift as edits land, so always find the sentence by its quoted text, not by its line number.

---

## How to use this file (read first, every session)

0. **Rerun, don't revert (Eric).** Whatever is wrong gets rerun correctly and its numbers replaced from the new deposit. A revert, a placeholder or a softened sentence is never the fix for a wrong number. The only exception is a claim Eric decides to drop.
0b. **Two machines share `/root/vast` (NFS) and `figs/out/`.** **ericmimicc** runs B8 (Fig 3G/H frame-matched rescoring) and B1 (SLEAP tail-free re-track, Mouse-Dyad, tracking only), per Eric's `HANDOFF-OTHER-JOB-2026-10-15.md` (queued 06:35 UTC: `figs/out/md56_logs/OTHER_queue_job{1,2}.sh`). **ericmimic2** (main box) runs B2 (SLAP-2M SLEAP re-track), the scoring of B1, B3, B5, B6, B7, B11–B13, and all timing (C1–C4). See also `HANDOFF-ericmimic2-2026-10-15.md`. Both machines log every start, finish and failure in `figs/figures/drafts/RUN-STATUS-2026-10-15.md`.
1. **Work in phase order: 0 → A → B → C → D.** Do not start a phase-B or phase-C job until every *blocking decision* it depends on is answered (§2).
2. **Confirm with Eric before launching each compute batch** (every phase B or C job). He stopped runs once today. Phase A (text, captions and code with no compute) is approved: "fix everything you need to fix".
3. **A box is ticked only with evidence.** Next to each tick, write the evidence: a file path plus field, a log line, a command and its output, or a commit hash. "Ran it" is not evidence. "Checked the script" is not evidence for a data property. Open the data file.
4. **"Done" means all five:** complete, on v1.0.5, tail rule satisfied, comparison fair (§1 template), and an old-vs-new table shown to Eric. Otherwise say "ran, not verified".
5. **Only one agent edits `luc3d_newest.tex` at a time.** Before editing, check `git diff` and the file's mtime, because other sessions have been editing it today.
6. **Never chain jobs blindly.** A runner script must propagate failure exit codes. `run_F3samefr.sh` printed "DONE" on a stack overflow and released the next job.
7. **When you find a new problem, add it to this file** (next free ID in the right phase). Do not fix it silently.
8. **Manuscript prose rules:** Nature Neuroscience tone; no colons or semicolons in prose; no "Because" sentence openers; edit Eric's text lightly. Supp 6B/C and Supp 9 captions currently break the semicolon rule.

---

## STATUS UPDATE 2026-10-15 ~13:40 UTC (main box) — read this first

**Corrections to this file.**
- **E6 hardware** is an **Apple M1 Pro, 16 GB**, Google Chrome, LUC3D v1.0.5 (Eric). The tex says this (Methods, software section).
- **0b machine split changed.**
  - **B1 (Mouse-Dyad SLEAP) runs on the MAIN BOX**, in private dirs `retracked_notail_src_mb/` and `retracked_max2_notail_mb/` (`run_B1_mainbox_mb.sh`).
  - ericmimicc's first attempt crashed (no `libGL`/`libEGL`). Its relaunch then collided with the main box's at 07:18 (HDF5 lock error in the shared `retracked_notail_src/`). The shared dirs are **abandoned and untrusted**.
  - ericmimicc confirmed at 07:25 that it will not run B1. It ran only B8.
- **D5 (SLEAP version) was answered by Eric:** "don't change the versions". SLAP-2M stays on sleap-nn 0.2.0 and Mouse-Dyad on 0.3.0. Only the tail changed. L416 now discloses "with sleap-nn 0.2.0 in place of 0.3.0".
- **D7 answered:** restrict to Mouse-Dyad. Done in the abstract.
- **D11 answered:** Fig 5 features stay as defined. Eric: "ok so its basically the same then".
- **B6 per-direction 5G redraw approved:** Eric, "ok you can fix it".

**Environment facts found today (new).**
- **uv envs and `libGL`.** sleap-nn's tracking path imports `skia`, which needs system `libgl1 libegl1 libglib2.0-0`. These were installed on both machines.
- **uv versions.** uv 0.11.23 with CPython 3.11.14 restores `sleap_nn_030_env` and `luc3d-bench/sleap_nn_env` exactly. The old `*_fix`/`snenv_unfilt` venvs borrow miniforge's Python.
- **Gates passed.**
  - The uv sleap_nn_env reproduces the deposited SLAP-2M `sleap_cap/` 6/6 cameras (`run_SLAPNT_ctrl.out`).
  - The uv sleap_nn_030_env reproduces the deposited Mouse-Dyad `retracked_max2/` 5/5 (`B1_ctrl.log`).

| ID | Status | Evidence |
|---|---|---|
| **B3** | **DONE, all identical.** Tail nulled in the LUC3D tracker input, 130/130 sessions IDENTICAL by payload digest (56 Mouse-Dyad, 74 SLAP-2M). No LUC3D rerun needed. Methods sentence added after "the four tail nodes were given zero weight". | `out/tailnan_check_v105.json`, `md56_logs/TAILNAN.log` |
| **B5** | **DONE.** s-DANNCE on v1.0.5: 0 of 41 sessions changed. All text numbers hold, except the wrong-calibration control 0.513 → **0.519** (tex updated). The swap positions are now deposited (`results_v105/agg/swapdiag/`). | `md56_logs/SDV105_compare.txt` |
| **B6** | **Ran.** Controls at ≥6 reproduce the text exactly (23 sessions, r = −0.011, P = 0.96, 23/23, 20/23). Near curves unchanged (4.7×, 5.2×, 1.7×). Per-direction far line peaks at 1.30 (female) and 1.45 (male, about 1 s before onset); null stays ≈1.0. **5G redraw is in FINALBUILD.** | `md56_logs/F5FIX_compare.txt`, `out/fig5_rear_coupling_2animal_perdir.json` |
| **B2** | **DONE, verified, tex updated.** SLAP-2M SLEAP tail-free: 444/444 inputs body-identical with tail NaN, 444/444 outputs ≤ N tracks and no tail. LUC3D vs SLEAP: all 30/26/18 → **32/24/18** (P 0.69 → 0.35); ≥2 animals 29/12/1 → **31/10/1** (P 0.012 → 0.0015); 3–4 animals 5/7 → **6/7** (P 0.45 → 0.13); medians 0.066/0.10/0.12 → 0.076/0.11/0.15. | `out/fig6_slap2m_fair_sleapnt.json`, `md56_logs/SLAPNT_*.log` |
| **B7** | **SLAP-2M part DONE** (re-run with eks_env after two runner-env slips). ByteTrack IDF1 > 1: 10 → 0. ByteTrack within-view mean/median 0.904/0.987 → 0.902/0.986. LUC3D vs ByteTrack 68/6/0 → 71/2/1. Mouse-Dyad part (`fig7_bytetrack_max2_s6small.json`) done. **Install into figures is in FINALBUILD.** | `out/fig6_slap2m_fair_final.json`, `md56_logs/FINAL_slap_score.log` |
| **B8** | **Coverage DONE** (ericmimicc, Gate 2 PASS ×3), with its tex update. **Artwork redraw is in FINALBUILD.** D3 is still open. | RUN-STATUS 09:25 |
| **B1** | **RUNNING** (main box): gate PASS, prep checked 280/280, tracking ~157/280 at 13:22 UTC. | `md56_logs/run_B1_mainbox_mb.out` |
| **C1/C2** | **QUEUED** in `run_OVERNIGHT3.sh`. They start only after B1 is scored, nothing of ours is running, and load has stayed < 2 for 5 min. A load ceiling of 4 marks a sitting invalid. **C4 (RANSAC) fixed:** in C1 it now runs on the same 200,010 pre-undistorted keypoints with `undistort=False` (`fig2g_retime_extra.py`). | `run_OVERNIGHT3.sh` |
| **D1 prep** | `md56_logs/run_FINALBUILD.sh` written. It runs after OVERNIGHT3: `final` link set, Supp 6 fair/variant/install with true medians, Figs 2–6 rebuilt with no footer, and a footer check. | — |
| A1.2, A1.3, A1.5, A3.1, A3.3, A3.5, A3.6, A3.10 (controls clause), A3.11, A4.5 (D/E/F caption), A4.7 (30.9M scope), A5.3, A5.9 | **DONE in tex** (13:30–13:40 UTC). Backups are in the session scratchpad (`luc3d_newest.pre-*.tex`). | `git diff figs/figures/drafts/luc3d_newest.tex` |
| A2.3 | Panel label changed to "previous settings" (`panels/fig3_05_sweep.py`). The caption now names the second curve (50 mm limit, no eviction). | — |

**New items not in the original checklist.**
- **N1.** The other machine edited the tex (B8 paragraph and a Methods sentence) despite rule 5. The change was reviewed and kept.
- **N2.** Agents left whole-disk `bfs`/`find /` crawls running for up to 38 min; all were killed. Before any timing: `pgrep -a bfs`.
- **N3.** The Fig 3G/H Methods sentence (ericmimicc) says "The greedy rates over the full sessions … are given in the text". Verify L150 actually gives them after the redraw.
- **N4.** C3 (calibration timing) cannot run: the calibrat3 inputs are in deleted /tmp dirs (A6.10). **Needs Eric.**
- **N5.** Still `% PENDING`: the Methods sentence "SLEAP's tracker was given the same detections with the four tail nodes removed, in both datasets" waits on B1. The Fig 3G/H caption's "same ~24 million camera frames" waits on the FINALBUILD redraw.

**Still open decisions for Eric:** D1 (done as "report both" in the tex; confirm), D2, D3, D4, D6, D8, D9, D10, D12, plus N4.

---

## 0. Global invariants (every number in the paper must satisfy all of these)

| ID | Invariant | How to verify (data, not docs) |
|---|---|---|
| **G1 Code** | Every tracking, solver and timing number comes from **LUC3D v1.0.5 = 2dc001fe** (`/root/vast/eric/lucid-main-md56`). No fork cells, no `lucid-switch-correct`, no `xv_experimental.js` results. | The deposit records `lucid_commit` = 2dc001fe. Where the driver lives outside the checkout (`fig3_bench.mjs` and `fig3_exhaustive.mjs` in eric/figs), the deposit also records the driver's path and sha256. |
| **G2 Tail** | In **every tracking result, for every arm** (LUC3D, exhaustive, SLEAP, ByteTrack, baselines), the four tail nodes **TailTip, Tail_0, Tail_1, Tail_2** (indices 4, 7, 8, 9 in both the Mouse-Dyad and SLAP-2M 15-node order) are absent from (a) the **tracker input** and (b) the **scoring**. **TTI (tail base, index 3) is a body node and stays.** "Absent from the input" means **NaN in the keypoints fed to the tracker**, not "weight 0": LUC3D's target creation ignores `nodeWeights`. **The only exception is Fig 2 triangulation, which uses all 15 nodes** (Eric, 2026-10-15; the Methods say so). | Open a tracker's actual input file and assert columns 4, 7, 8, 9 are all NaN. For scoring, assert `SCORE_NOTAIL=1` / `excludeTail` took effect: log it, and record it in the deposit (G5). |
| **G3 Same data** | Every comparison passes the §1 fairness template. | Fill in the §1 table for that comparison and paste it into the item. |
| **G4 Timing** | Every timing runs **alone**, with nothing of ours running, a real idle wait, pinned threads, load logged throughout, and identical inputs across arms. Full protocol in phase C0. | A load log is deposited next to the result. Its peak 1-min load is recorded in the deposit. |
| **G5 Provenance** | Every new deposit records: commit; driver path and sha256; node/python and key package versions; tail flags (`SCORE_NOTAIL`, `excludeTail`, tail-NaN input); session list; frame counts and the denominator definition; start/end UTC; host; load summary (for timing). Filenames are **immutable** (suffix or timestamp), and `*_v105.json` links point to immutable files, never to files another writer rewrites in place. | `python -c` dump of the deposit's provenance block. |
| **G6 No hand numbers** | Every number in the tex traces to a deposit field. Keep the number map `figs/figures/drafts/NUMBER-MAP.md` (tex sentence → deposit path → field → value), and regenerate numbers from it, never by retyping. | Before submission, every numeric token in the tex appears in the map. |
| **G7 Honest status** | Never write "done", "bit-identical", "verified" or "idle" without the check that proves it. Record measured values ("~91% idle", "47/56 sessions identical"), not adjectives. | Re-read every status line in docs and commits before committing. |
| **G8 No premature commits** | Do not commit or push figures or tex that contain known problems. Pushing needs Eric's go. Commits 32d40da7, 01fb3530 and 8899b01f are already on `origin/eric/figs` with known problems; fix them forward, and do not force-push. | `git log origin/eric/figs..HEAD` reviewed with Eric before any push. |

---

## 1. Fairness template (copy into every comparison item and fill in every row)

| Dimension | Arm 1 | Arm 2 (…) | Identical? |
|---|---|---|---|
| Sessions (count and list hash) | | | |
| Frames (exact set; clean vs all; frame-list hash) | | | |
| Cameras (exact set per cell) | | | |
| Detection pool / input file (path, filter rule) | | | |
| Tail removed from tracker input (verified in the file) | | | |
| Tail removed from scoring (flag recorded) | | | |
| Ground truth (path / version) | | | |
| Code (commit, driver sha256) | | | |
| Tool versions (sleap-nn, motmetrics, opencv, …) | | | |
| Metric definition and denominator | | | |
| Timing only: n, timer scope (what is inside the timer), threads, sitting, peak load | | | |

Every "No" must be fixed, or disclosed in the caption and the text with its size. A comparison with an unexplained "No" cannot be reported.

---

## 2. Decisions

### 2a. Already made by Eric (do not reopen)

| ID | Decision | Status |
|---|---|---|
| E1 | Fig 2 triangulation keeps all 15 nodes (Methods L135/L305 say so). | Nothing to do. |
| E2 | Every **tracking** result ignores the tail for **every arm**, at **tracking input and scoring** (= G2). | Drives B1–B4. |
| E3 | Supp 6F eviction credit: compare against v1.0.5 `stale0_dist25`. "The comparison isolates eviction." | Done in tex today. **Verify** the sentence and numbers (1,789 → 367 …) against `fig8_methods_50_md56.json` cell `stale0_dist25`. |
| E4 | Fig 3E caption states both detection pools (Mouse-Dyad sleap-nn filtered; SLAP-2M ≥5 body keypoints). | Done. **Verify** the caption text. |
| E5 | Fig 3E "as accurately as" stays. Eric: "this is fine, don't worry about the more accurately claim". Greedy being worse in 3 of 4 configs does not need rewording. | Leave as is. Do not add "pooled" unless Eric asks. |
| E6 | Abstract speeds (16,030 fps triangulation, 14,694 fps tracking) were measured by Eric **in the app, v1.0.5, on a 16 GB Apple M1**. Report that provenance **in Methods and Results, not in the abstract**. | A-item A1.3. |
| E7 | Run s-DANNCE (Supp 6G–I) on v1.0.5. | B5 (approved). |
| E8 | Fix Fig 3G/H, the camera-subset rates, and the Supp 6F "best re-tuning" claim ("ok you need to fix all these"). | A2.x, A3.x, B8. The **method** for the 3G/H threading still needs D3. |
| E9 | All timing is redone **uncontaminated** ("run these in an uncontaminated way"). | Phase C. |
| E11 | **Fig 3G/H show the full-session greedy curves** (0.73 / 0.873 at r = 6); the exhaustive rule is labeled on the panels "frames without missing detections only"; the comparisons with exhaustive in the text use matched frames (B8: 1.3 / 0.928, 68x). Eric, 2026-10-15 ~14:40 UTC. | Done on ericmimicc (panel label, fig3b preview, tex). The main box must drop the frame-matched sweep links from run_FINALBUILD.sh (RUN-STATUS 14:45). |
| E10 | Order: finish the report and no-compute fixes first; timing and the tail-free reruns afterwards. | Phase order above. |

### 2b. Open, blocking (ask Eric; record the answer here with the date)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| D1 | **Fig 2F accuracy.** Report held-out-camera error (Anipose marginally better: linear 3.103, optim 3.107, LUC3D refined 3.142, DLT 3.298 px; LUC3D refined worse in 55/56 sessions), or keep in-sample with an explicit caveat? | Report held-out. It is already deposited (`data/fig2/fig2f_per_session.csv` `heldout_p50`), needs no compute, and is the honest metric. Then reword the Fig 2 title, L142, L198 and "lowest in all 56". | A1.5 |
| D2 | **Fig 2E bottom** "dropping the worst view reduces error" is true by construction. Rebuild with a camera held out from both solves (~1–3 h of new code + compute), or drop the claim? | Rebuild if time allows; otherwise drop it from L130 and L299. | B9 / A1.6 |
| D3 | **Fig 3G/H exhaustive line.** Exhaustive has no identity over time; its identities come from our nearest-centroid threading (`fig3_exhaustive.mjs`). (a) Report the grouping agreement (4,845,654 / 4,845,675 frames) and drop the switch/IDF1 comparison (no compute), or (b) give exhaustive LUC3D's temporal mechanism and rescore (new driver code + ~1 h)? | (a) is defensible and fast. (b) keeps the "68×" style claim, but only if the new mechanism is clearly fair. | B8, A2.4 |
| D4 | **The Mouse-Dyad detection pool `det_h5` counts the tail in its filters** (≥8 of 15 visible, mean score, OKS overlap). SLAP-2M counts body nodes only. Disclose it, or rebuild the pool body-only and **rerun every Mouse-Dyad tracking result**? E2 ("every arm tail-free") arguably implies the rebuild. | Ask explicitly. A rebuild touches Fig 3E–H, the camera subsets, Supp 6A/6F and Fig 4D (Mouse-Dyad). | B4 |
| D5 | **SLEAP version.** Mouse-Dyad used sleap-nn 0.3.0 and SLAP-2M used 0.2.0. Re-track both with one version (0.3.0) during the tail fix? | Yes, 0.3.0 for both. Otherwise L407 "same SLEAP settings as 6A" stays false. | B1, B2 |
| D6 | **Fig 2G statistic.** Best-of-5 (current protocol) or median of rounds? DLT best-of-5 spans 1.06–1.98 µs. | Median, or report both. | C1 |
| D7 | **Abstract "keeps identity switches below one per 100,000 camera frames".** This holds only for Mouse-Dyad (0.73). SLAP-2M is 28.4 (all 74 sessions) and 82.4 (multi-animal). Restrict the claim to Mouse-Dyad? | Yes, restrict it. | A1.2 |
| D8 | **Fig 1 letters.** The artwork is a arenas, b pipeline, c re-ID, d 3D, e capability table. The caption is A re-ID, B pipeline, C 3D, D arenas, and has no E. Re-letter the art, or rewrite the caption to match the art? Panel e also needs a caption entry and a citation. | Rewrite the caption to the art (cheaper, no rebuild). | A4.1 |
| D9 | **Supplementary Video 4.** L390 says "8 min 47 s". The deposited `figs/figures/supp_videos/supp_video4_walkthrough.mp4` is draft 10 (6:28, pre-v1.0.5). A v1.0.5 re-record now exists: `figs/figures/drafts/videos/walkthrough_full_draft11_v5.mp4` (11:49, made 2026-10-15, narration in `walkthrough_draft11_v5_narration.md`). Which file is final? Re-record v5 with faster cursor pacing to get closer to v4's 9:38? | Pick the file, then update L390, `supp_videos/README.md` and the deposited copy together. | A4.6 |
| D10 | **Fig 4C** pairs detections to reference animals using all 15 nodes; only the statistics drop the tail. Make the pairing tail-free too? | Yes (minor, cheap). This is not a tracking result, so E2 does not strictly cover it. | B12 |
| D11 | **Fig 5 keypoints (Eric's open question).** Fig 5 (proofread 3D, no tracker) builds every feature from **three nodes only: Nose, Neck, TTI**. Body axis = Nose→TTI, head axis = Nose→Neck, separation = TTI–TTI in body lengths, upright/rearing from those points (`fig5_upright.py` L50/L109–L204, `fig5_rear_coupling.py` L68–L76/L125, `fig5_views.py` L61). The audit's "Fig 5 is tail-free" meant only that no tail node is used. Eric asked: "it should use every…". **Get his exact intent** (e.g., all 11 body nodes for centroid, separation and height?) **before changing anything.** Every Fig 5 number, and L175–L185, would change. | Explain the current definitions to Eric with the code lines above, then follow his answer. | B6 |
| D12 | **Supp 6F "re-tuning".** Run the v1.0.5 corr3d sweep at `{distanceThreshold 25, stale 0}` (~2.5 h at 62 workers), or keep the softened "a re-tuning"? | Keep "a re-tuning" unless Eric wants the sweep. | B10 |

---

## 3. Phase A — no-compute fixes (approved; do these first)

Tick each box with evidence. Where an item's number will change in phase B/C, mark the sentence `% WILL-CHANGE <ID>` in the tex so it cannot ship stale.

### A1. Abstract, Fig 2 and solver text
- [ ] **A1.1 Rerun Fig 2G cleanly (C1) and replace the contaminated numbers from it.** Do not revert (Eric). L142 / L198 / L301 / L303 ("27×", "1.1 µs per keypoint", "77 times slower", "1.40 µs") and the caption "measured on the same 200,010 keypoints" come from sitting **Q2d, which is contaminated**. Mark each sentence `% WILL-CHANGE C1` (a tex comment, not visible) so it cannot ship stale. Schedule C1 on ericmimic2 as soon as its accuracy jobs finish, then replace every number from the C1 deposit. *Evidence:* each sentence's numbers equal fields in the C1 deposit, and no `WILL-CHANGE C1` markers remain.
- [ ] **A1.2 Scope "below one per 100,000"** in the abstract (L103) per D7. Also reconcile it with L409's 0.028%.
- [ ] **A1.3 Abstract speeds provenance (E6).** In Methods and Results, add one sentence: hand-measured in the app, v1.0.5, 16 GB Apple M1, browser and version, which session, how measured. Explain why 14,694 fps exceeds every bench number (fastest bench cell 11,858 fps; Fig 3F 4,093–6,263 fps): different hardware and a different measurement. Ask Eric for the session and method if they are not recorded; do not invent them.
- [ ] **A1.4 L103 "median of 1.2 mm from the proofread reconstruction"** is framed as accuracy, but L128/L305 say it measures the proofreading corrections. Reword it consistently. Also unify 1.21 mm (L128) vs 1.2 mm (L130/L103).
- [ ] **A1.5 Fig 2F accuracy wording per D1** (Fig 2 title, caption F, L142, L198, "lowest error in all 56", "comparable accuracy", L142 "Neither library's non-linear refinement shows a large improvement").
- [ ] **A1.6 Fig 2E bottom per D2** (L130, L299). If dropped, delete the claim and its annotations (−0.346 px, −0.095 px).
- [ ] **A1.7 Fig 2G speed-up excludes undistortion.** LUC3D undistortion costs more than its DLT solve. State it in Results (not only Methods L303), or report both numbers (~11.8× including undistortion). The final numbers come from C1.
- [ ] **A1.8 L130 "roughly a constant over the sine … 13 degrees gives 12.6 mm".** The 13° pair (12.60 vs 6.52 predicted) and pair 0-2 lie outside the ±25% band, and the band is fit and scored on the same 10 pairs. Reword it.
- [ ] **A1.9 L271 "0.13%" stride check** changes the solver and the stride at once. Word it as both differences, or note that B13 recomputes it.
- [ ] **A1.10 L271** "moves less than a millimeter between consecutive frames" has no source: source it or cut it. Also 2G is not a "held-out solver comparison".
- [ ] **A1.11 Fig 2F Anipose optim** drops 8 trailing keypoints per session. State it in one clause.
- [ ] **A1.12 Fig 2B/D** use our own NumPy SVD DLT (`fig2.json`), not LUC3D code. Disclose that in Methods.

### A2. Fig 3 text
- [ ] **A2.1 Fig 3F caption and text** ("E and F use 98 sessions", "on identical detections", L103, L148, L200, L269, L285, "20×", "3.1 vs 0.16 ms", "0.13–0.24 ms", ">5 hours", "4,093–7,614 fps"): mark all `WILL-CHANGE C2`. F is not 98 sessions.
- [ ] **A2.2 Fig 3G/H caption** must say what each arm is scored on. Greedy curves cover ~50.4M camera frames and the exhaustive line ~24.2M clean frames, until B8 makes them identical.
- [ ] **A2.3 Fig 3G/H "previous default" line.** It is v1.0.5 at distanceThreshold 50 / stale 0 with sync on, not the real pre-#210 default (1,905 vs 2,135 switches at r=6). Relabel it "v1.0.5 at the previous settings", or drop it. Also fix the stale settings doc (MD56-B-FIGURE-SETTINGS.md §3 still describes pre-#210).
- [ ] **A2.4 L150 numbers** (528, 0.612, 0.73, 0.873, 0.67, 1.3, 0.928, 68×, 90, 0.657): mark `WILL-CHANGE B8/D3`. Also: r = 0 vs exhaustive and "every non-zero ratio does better" compare different frame sets; L150 vs L329 use two definitions of an identity switch. Unify them.
- [ ] **A2.5 Fig 3G axis label** reads "corr3d / corr2d" (jargon). Use words matching the caption. The same goes for the "greedy (LUC3D)" and "app default r = 6" labels, the unexplained "10⁶×", untitled panel B, and C's legend entry "unresolved detection".
- [ ] **A2.6 Exhaustive vs greedy denominators** use different definitions (frames_computed×5 vs Σ min(GT, det)). Pick one and state it.

### A3. Tracking text (camera subsets, Supp 6, tail statements)
- [ ] **A3.1 Camera subsets (Methods L293, Discussion L204).** Quote **rates per 100k camera frames** (k=2 12.8–18.4, k=3 3.0–4.4, k=4 1.1–2.0, k=5 0.73; a 17–25× drop), not raw totals. Remove "from 2,572 to 3,707" (it reads as a rise). Source: `fig2_cams_identity_md56.json`.
- [ ] **A3.2 False tail statements.** Mark these `WILL-CHANGE B1–B4` and rewrite after B lands: L157 "Tail keypoints were left out of the tracking … throughout"; L275 "In every mouse tracking run … the tail nodes were given zero weight" (false for target creation and for SLEAP); L267 (states tail-free ByteTrack boxes and is silent on SLEAP). Also fix the docstring in `figs/score_notail.py:9`, "The trackers already ignore the tail".
- [ ] **A3.3 Garbled Supp 6F caption sentence (L485)**: "…where stale 0 has no eviction and trade-off between…". Rewrite it.
- [ ] **A3.4 Supp 6F statistics (L415).** "0.754 → 0.917" (a difference of medians) and "improved by 0.091" (a median of paired differences) are mixed in one paragraph. Use one statistic.
- [ ] **A3.5 L409 "Over all 74 sessions the two trackers do not differ".** Sign test P = 0.69, but Wilcoxon P = 0.0014. Absence of significance is not equivalence, so reword it. Also: the single-animal difference called "negligible" is significant (sign P = 0.00098); "about half the identity switches" is a 0.57 ratio; L411 "about 23%" is 22.5% and 23.4%. All are `WILL-CHANGE B1/B2`.
- [ ] **A3.6 L407 "same SLEAP settings as 6A"** is false until D5/B1/B2 make it true.
- [ ] **A3.7 L236 "The benchmark drivers run the unmodified application modules".** The fork cells and s-DANNCE contradict this. Make it true via B5/B11, then keep it, or reword it.
- [ ] **A3.8 L415** "Both arms used synchronous per-frame scoring": true in v1.0.5, but `stale0_dist25` records `method: {}`. Document it.
- [ ] **A3.9 Supp 6 captions**: explain the dotted 1/C line (6A) and the dotted 0.9 line (6B), and say that 6B's y-axis is truncated at 25%. Define the 6E notation (x_t″, X̂_t, X_t(μ), X_c). Use one name for "eviction window N" vs "stale 0…30 / staleness horizon", and for "s-DANNCE" vs "social-DANNCE". Remove the semicolons from the 6B/C captions.
- [ ] **A3.10 L423 / L427 s-DANNCE text.** The controls ran on a 20,000-frame excerpt of one SCN2A session; say so. "One swap" vs 2 recorded switches. 36 switch-free vs 35 at IDF1 1.0 is unexplained. The swap positions (41,298 / 31,312) have no deposit, and "Either end … both within the first 3%" contradicts itself. All are `WILL-CHANGE B5`.
- [ ] **A3.11 L335** "60 frames, which is 2 s for SLAP-2M" is 1 s in the 13 sessions recorded at 60 fps.

### A4. Figures vs captions (no data change)
- [ ] **A4.1 Fig 1 letters per D8.** Caption panel e (capability table) and cite it in the text.
- [ ] **A4.2 Fig 1b "this work" bracket** spans all 7 tiles, including "2D pose / SLEAP or similar", and every tile is green. That contradicts the caption and L111 (LUC3D does not detect keypoints). Fix the art or the caption. Also fix "Hard Fight rig" / "Calibrat3 App" / "DLT, N ≥ 2 views" (N reused). Fig 1 was built Oct 2 (pre-v1.0.5 association output in c).
- [ ] **A4.3 False footer on Figs 2–6.** It reads "Variant figN (FIG_VARIANT=v105|md56): proofread per-camera 2D labels in place of the detector". **It is false.** These builds use detector predictions (Mouse-Dyad sleap-nn re-track; SLAP-2M `lite_pools/bvis5`), not proofread 2D labels; and Fig 4's footer says "md56" (the Mouse-Dyad set name) on a SLAP-2M figure. The fix in `figs/assemble.py` exists but is uncommitted. Verify it, rebuild the art (D1 below), and confirm the footer is gone from every PDF/PNG (`pdftotext` grep).
- [ ] **A4.4 Fig 2G artwork** shows Q2c (24.3×, 1.2 µs, n = 345,000). It is stale and invalid. Rebuild only after C1.
- [ ] **A4.5 Fig 5 captions.** "circular-shift null" vs "shuffled control"; bands undescribed; D/E are box plots, but the caption says "each point is one session"; F's box plot is not covered; axis jargon ("facing-pursuit", "female up before follower", "0.12 BL"). D/E are built from 538 displays, but the text says 539 (session 20250904_140306: 63 vs 64).
- [ ] **A4.6 Supp Video 4 per D9** (L390, README, deposited copy).
- [ ] **A4.7 Fig 4.** In 4C the 80th-percentile line is dotted, but the caption says dashed. 4A: rows 0/2/5 have no units, the rating mapping is not shown, 50 mm scale bars sit on fisheye views, and "the 4-animal session" should be 3. The Fig 4 caption's "~30.9 million" is panel B's count only (C uses 161.9 million 2D observations).
- [ ] **A4.8 Fig 2 minor.** 2A jargon ("id_0", "other 6: weight 0"). 2B legend "nudge/accept" vs caption "corrected/accepted"; the manual line style is undescribed. The caption should say G uses the first 13,334 stride-15 frames.
- [ ] **A4.9 Supp 8.** G has an extra row "and no rejection"; D's axis uses serial numbers; H's frame counts don't say which session. L433 "378" → 379 (median 378.5). 1,799 vs 1,800 frames.
- [ ] **A4.10 Supp 9 (Panopticon).** "100 fps" rig vs "30 fps" tiles; "time (10ms)" axis; "per-camera clock offset" vs caption "clock rate"; the personal path `C:\Users\isaac\…` is visible; semicolons in the caption; L457 "up to 13 ppm, 15 ms" vs the panel's ~12 ppm → 13.7 ms. Sources: B14.
- [ ] **A4.11 Datasheet.** The tex includes the stale Aug 18 copy ("No. Proofreaders ?", sex "Male", no total-animals row); the current copy is from Oct 1. "Mice Species: White, Agouti, Black" lists coat colours, not species; 100.85M vs 100.8M.
- [ ] **A4.12 Fig 1 / Supp 2B / datasheet** show 8 SLAP-2M cameras, while Fig 4A, L103 and Supp 6 use 6. State "6 of 8 cameras proofread" once. L103 "15.6 million video frames" counts 8 cameras.
- [ ] **A4.13 GUI screenshot (`fig7.png`)** is not in the repo, and its legend is one line. Also, repo `figures/fig7/fig7.png` is the calibration figure. Resolve the filename collision before copying anything by name (legacy `figs/out/fig1–7.*` use the old numbering).
- [ ] **A4.14 Tex header L3–4** still says the figures are placeholders.

### A5. Dataset and methods text
- [ ] **A5.1 L243 enrichment taxonomy.** "six levels" describes animal counts, but single-animal sessions exist at obstacle levels 3, 4 and 5. The 1–7 rating = animals + obstacle_rating. Reconcile the two taxonomies. L103/L164/L208 "most enriched sessions" = rating 7, which is 12 two-animal sessions at obstacle 5 plus 1 three-animal session at obstacle 4.
- [ ] **A5.2 L239 vs L243 strains vs coat colours.** CD-1, C57BL/6J and BALB/c include no agouti strain, yet the master sheet has 42 agouti mice. The total of 16 animals has no source. Ask Eric.
- [ ] **A5.3 L239 "5 to 60 minutes".** 10 SLAP-2M sessions are shorter than 5 min (minimum 1.15).
- [ ] **A5.4 L111 Fig 1B "acquired with Panopticon"** vs L254 "SpinView or campy". Panopticon was used for no dataset.
- [ ] **A5.5 L431/L445** "SLAP-2M used to select default parameters": only 1 of 4 recordings was used for tuning.
- [ ] **A5.6 L435 Supp 8H** "each tool running alone on an idle 64-core machine" is unverifiable. Mark `WILL-CHANGE C3`.
- [ ] **A5.7 L449** aniposelib controls were scored on a different transcode (652,540 vs 645,451 observations). Disclose or rerun. **L451** "focal length to 0.05%" is f_x only (f_y 0.15%).
- [ ] **A5.8 L103 "cuts manual placements in half"** (data: 57% fewer) vs L126/L196 "more than halves". Use one phrasing.
- [ ] **A5.9 L164.** Rating 5 median 0.9801 is barely above 0.98; rating 3 has mean 0.914 and minimum 0.763, so "near perfect" fails for 3–4 animals. Also "suggest" → "suggests".
- [ ] **A5.10 L175** "every camera mounted between 58 and 76 degrees" was measured on one frame of one session; the corpus has 3 calibrations.
- [ ] **A5.11 Fig 5 text.** L179 vs L183/L403 use two female-share measures (median 0.83 vs 0.857). L185 "50.2% … 6.2%" are pooled over onsets, while per-session medians are 0.50 and 3.3%; say which. L185 "not observed when further apart" is not tested per direction. L321 pair-level Wilcoxon (P = 9.7e-4) is run but never reported. L323 slot-swap control covers 37 sessions, not "every session". L181/L241/L351 "18 pairings": only 17 are identifiable. All are `WILL-CHANGE B6/D11`.
- [ ] **A5.12 2D model numbers (L439–441)** have no deposit (SLEAP 1.2.8/1.3.3, 9,068 frames, 18,752 instances, 39,644/76,279, thresholds 0.4/0.25, errors 3.0/1.6 px). Source them (B14) or ask Eric.
- [ ] **A5.13 SLAP-2M frame and pose totals** are marked "TRANSCRIBED" in the sheet. Recompute them and record the source.

### A6. Code hygiene and provenance (no compute)
- [ ] **A6.1 Fix the script defaults that silently produce non-paper results**: `panels/fig4_11*.py:120` (a v105 build reads the fork fig9: 0.943 instead of 0.932); `fig6_07` default `FIG6F_NOEVICT=shipped` (fork cell); `fig2g_retime_all.py` default `POSE_DIR`=1d672c12 and node22; `fig5_controls` default 5 (the text uses 6); `fig6_02` counts ties as losses; `fig3_trackers` uses the upper median. Make the paper setting the default, or make each script fail loudly without an explicit setting.
- [ ] **A6.2 Review the uncommitted opt-in switches** left by interrupted agents (AUDIT §7 list: `FIG2G_FRAMES`, `--frame-list`, `F3_TRUE_MEDIAN`, `FIG5G_PERDIR`, `STITCH_DEDUPE`, `SIGN_TIES_EXCLUDED`, `LUCID_SC_ROOT`/`FIG10_*`, …). For each one: read the diff, confirm unset = unchanged, and syntax-check it (`python -m py_compile`, `node --check`).
- [ ] **A6.3 Make runner scripts honest.** Every `run_*.sh` must `set -euo pipefail`, propagate the child's exit code, and print FAILED on failure. Fix `run_Q2d.sh` (edited after it ran: its note says "Q2e", it writes Q2d logs, and its idle wait is a no-op `-ge 0`). Keep the as-run copy as `run_Q2d.as-run.sh` if recoverable; otherwise document that it was edited after the run.
- [ ] **A6.4 Replace `PYTHONPATH`** pointing into another session's `/tmp/.../44adbb8d.../scratchpad/cv2h` (OpenCV 4.13) in `run_Q/T/M/S6SMALL.sh` with a durable env.
- [ ] **A6.5 Make v105 links immutable.** `fig2g_retime_all_md56.json` is rewritten in place by three writers. The usable-ish Q2c data survives only in `md56_logs/…Q2c-200k-vs-345k.json`.
- [ ] **A6.6 Make the v1.0.5 checkout self-contained**, or record the dependency: the untracked `scripts/bench/node_modules` symlink into eric/figs; drivers that live in eric/figs, with `fig3_bench.mjs` now modified (`--frame-list`); no driver hash in any deposit.
- [ ] **A6.7 Track the reproducibility material.** `figs/out/` is gitignored, so no deposit, log or run script is in git. `figs/fig10-bench/` (s-DANNCE) is entirely untracked. Decide with Eric where run scripts, logs and small deposits are committed (e.g., `figs/provenance/`), and commit them.
- [ ] **A6.8 Correct stale docs and claims**: MD56-B-FIGURE-SETTINGS.md ("bit-identical" fork vs v1.0.5 is false: real agreement is 47/56 Mouse-Dyad and 36/74 SLAP-2M; "~98% idle" was ~91%; §3 G/H describes pre-#210), MOUSEDYAD-56-NUMBERS.md (proposes text from invalid Q2b and fork deposits), deposit `claim`/`status` strings (e.g., `fig3_frame_matched_bmimica_md56.json` says "50 sessions"; `fig8_methods_50_md56.json` top-level says `xv_experimental.js`).
- [ ] **A6.9 `md56_check.py` gate** checks names and session counts only. Extend it to assert G1 (commit) and G2 (tail flags) from deposit provenance, and run it on the v105 targets.
- [ ] **A6.10 Supp 8 calibration inputs** sit in deleted /tmp dirs. Recover them or record them as lost (this feeds C3).

---

## 4. Phase B — accuracy reruns (no timing; never run while a phase-C job runs)

**Every B item follows the same five steps.** Copy the block into the item when you start it.

```
Pre-flight (all must be true before launch):
  [ ] blocking decisions answered (list IDs)
  [ ] Eric said go for this batch (date/time)
  [ ] code = 2dc001fe; driver sha256 recorded
  [ ] tail NaN verified IN THE INPUT FILES (print columns 4,7,8,9 of 3 random detections per dataset)
  [ ] flags identical to the comparison arms except the intended change (fill §1 template)
  [ ] output paths are NEW and immutable (no overwrite of *_md56/_v105 deposits)
  [ ] runner propagates exit codes; no job chained after it
  [ ] no phase-C timing job running or scheduled
Run:   command + log path
Verify: completeness (sessions/frames/cameras), invariants (e.g. <=2 tracks), provenance block (G5)
Compare: old vs new table for every number this feeds; show Eric
Update: tex sentences (by quoted text) + number map + figure rebuild list
```

| ID | Job | Depends on | Est. | Feeds |
|---|---|---|---|---|
| **B1** | **SLEAP tail-free re-track, Mouse-Dyad (Supp 6A).** Tail-NaN copies of `retracked/*.slp` with track labels removed. Re-track with sleap-nn (version per D5), the same flags (`--max_tracks 2 --candidates_method local_queues --tracking_clean_instance_count 2` + bench flags), and no `--filter_*`. Verify every output has ≤2 tracks. Score with `SCORE_NOTAIL=1`, then run `fig6_fair_baselines`, `variant_best` and the Fig 6 rebuild. | D5, (D4) | ~140 CPU-h (~5 h at 30 workers) + 1.5 h scoring | L267, L337, L409, L411, Supp 6 caption, abstract if cited |
| **B2** | **SLEAP tail-free re-track, SLAP-2M (Supp 6B–D).** Add tail-NaN in `sleapsrc_job` behind a new variant; use the same sleap-nn version as B1 (D5). Re-track, verify, score and install. | D5 | ~2.1 h at 28 workers + 20 min | L409 (0.991; 14 vs 1; 30/26/18 P=0.69; 29/12/1 P=0.012; 0.066; 5 of 7 P=0.45; 0.10/0.12; 80–84%; FP 0.57%; switches 0.050%) |
| **B3** | **LUC3D target-creation tail check.** `_initializeTargets` → `epipolarErrorMatrix` averages over all 15 nodes and ignores `nodeWeights`. Blank the tail (NaN) in the bench drivers' `instancePoints`, then rerun `sync_stale20_dist25` on 56 Mouse-Dyad + 74 SLAP-2M sessions and compare output digests. **All identical** → add one Methods sentence. **Any differ** → rerun every LUC3D arm with tail-NaN input (Fig 3E/3G-H greedy, camera subsets, Fig 4D, Supp 6A/B–D/F; ~10–12 h), and make tail-NaN input the permanent default in the drivers. *Note: an earlier assistant answer (2026-10-15) said the Fig 3G/H LUC3D arm was fully tail-free. That was true for scoring only; this check settles the input side.* | — | ~1 h (check); 10–12 h if needed | L157, L275, every LUC3D tracking number |
| **B4** | **Mouse-Dyad detection pool body-only rebuild** (only if D4 = rebuild). Rebuild `det_h5` with filters counting the 11 body nodes (as SLAP-2M does), then rerun every Mouse-Dyad tracking result (all arms), followed by B1/B3 on the new pool. | D4 | many hours; plan with Eric | Fig 3E–H, camera subsets, Supp 6A/6F, Fig 4D |
| **B5** | **s-DANNCE on v1.0.5 (Supp 6G–I).** `run_SDV105.sh` (written, not run). Check it really points at 2dc001fe, not `lucid-switch-correct` c9b2a325; record the commit in every cell file; compare with `compare_sdv105.py`. Confirm the rat skeleton has only TailBase (nothing to blank) and that scoring is `gt_perm`. | E7 | ~1 h | abstract "88% switch-free", 35/41, 5/6, 5/6, 26/29, 6 mm, 45 mm, 0.970/0.972/0.792/0.648, 68,560, controls 0.500/0.5/0.513, L423/L427 |
| **B6** | **Fig 5 fixes.** `run_F5FIX.sh` (written, not run): per-direction far line and shuffled null on the same sessions as the near curves (13 and 32 sessions after MIN_ONSETS=20); controls at the text's threshold of 6 (23 sessions), with a deposit. Redraw 5G so each sub-axis shows its own null. **Do D11 first.** If Eric wants more keypoints, the feature definitions change before this runs. | D11 | minutes | L175–L185, Fig 5G "4.7× / 5.2×" (13 sessions) |
| **B7** | **Supp 6 small fixes.** `run_S6SMALL.sh` (written, not run): ByteTrack `STITCH_DEDUPE=1` re-stitch + rescore (IDF1 > 1 in 10 of 444 camera-sessions, max 1.0049), the true median, and sign-test ties excluded. Make the 6C artwork and the text use the same test. | — | ~1 h | Supp 6B–D, L409 |
| **B8** | **[coverage half DONE 2026-10-15 09:17 UTC, ericmimicc: Gate 2 PASS; tex L152-154 + Methods updated; artwork redraw and D3 still open, see RUN-STATUS 09:25]** **Fig 3G/H on identical frames + the threading decision.** `run_G3sfm.sh` / `fig3_sweep_framematched.py` (written, not run, ~80 CPU-h ≈ 2 h at 40 workers) scores the greedy curves on exactly the exhaustive frames. Then apply D3: (a) report grouping agreement only, or (b) implement exhaustive temporal linking equal to LUC3D's and rescore. Report IDF1 at both whole-session (0.419) and clean-frame (0.657) coverage if both are kept. | D3, B3 | ~2 h (+ (b) code) | L150, Fig 3G/H |
| **B9** | **Fig 2E bottom held-out arm** (if D2 = rebuild). New arm in `fig2_solvers_robust_sessions.mjs`: score both arms in a camera held out from both solves. | D2 | 1–3 h | L130, L299, Fig 2E |
| **B10** | **Optional v1.0.5 corr3d sweep without eviction** `{distanceThreshold 25, stale 0}` (if D12). | D12 | ~2.5 h at 62 workers | L415 |
| **B11** | **Remove fork cells from `fig8_methods_50_md56.json`.** Cells `shipped` and `dist25_corr36` are fork results (identical to the fork deposit), and `lucid_root` is None in every cell. Recompute any cell still drawn or cited on v1.0.5, or drop it, and fix the top-level `driver`/`experimental_tracker` fields. | — | ~1 h | Supp 6A/6F |
| **B12** | **Fig 4C pairing tail-free** (if D10 = yes). | D10 | minutes | Fig 4C, caption |
| **B13** | **Optional: `fig2_measure.py --stride 15`** so the L271 stride check changes one thing at a time. | — | short | L271 |
| **B14** | **Source the unsourced numbers.** Supp 9 Panopticon (758,665; 542–2,118×; 9.997 ms; 2.3 µs; 210–223 ppm; 13 ppm; 15 ms; 1.51/0.15 px; 2.1%): build a script and deposit, or get the source from the Panopticon author. An earlier audit recorded different values (1.15 vs 0.48 px; 32,532 observations; 1.3%), so resolve that discrepancy. The 2D model numbers (A5.12), the s-DANNCE swap positions (`swapdiag/` missing), and the Supp 8 frame counts (`fig7s1/s2` CSVs empty) need the same. | — | varies | Supp 9, L263, L457, L459, L439–441, L423, L433 |

**Tail inventory after phase B** (fill this in; it must be all OK before phase D):

| Analysis / arm | Tail in tracker input (file-verified) | Tail in scoring | Status |
|---|---|---|---|
| Fig 2B–G triangulation | yes, by design (E1) | n/a | OK (exception) |
| Fig 3E exhaustive | | | |
| Fig 3E/3F/3G-H greedy (LUC3D) | | | |
| Camera subsets | | | |
| Fig 4D | | | |
| Supp 6A LUC3D / SLEAP / ByteTrack (Mouse-Dyad) | | | |
| Supp 6B–D LUC3D / SLEAP / ByteTrack (SLAP-2M) | | | |
| Supp 6F | | | |
| Supp 6G–I s-DANNCE (rat; TailBase only) | | | |
| Fig 4C pairing | | | |
| Fig 5 (proofread 3D; features per D11) | n/a | n/a | |
| Mouse-Dyad detection-pool filter (D4) | | n/a | |

---

## 5. Phase C — timing (strictly one job at a time, nothing else of ours running)

### C0. Timing protocol (fix the scripts before any sitting)
- [ ] **C0.1 Real idle wait.** Before starting, loop until the 1-min load is < 2 for 5 consecutive minutes. **No `-ge 0` no-ops.** Log the wait.
- [ ] **C0.2 Nothing of ours running.** No agents, no background shells, no rescoring, no file crawls, no ffmpeg/Chrome. A `bfs`/`find /` crawl contaminated today's run, and a headless-Chrome recording job ran on this host earlier today. Check `pgrep -af "node|python|ffmpeg|chrome|bfs|find "` and `ps -eo pcpu,etime,args --sort=-pcpu | head`. Paste the output into the log.
- [ ] **C0.3 Threads pinned and recorded:** `NUMBA/OMP/OPENBLAS/MKL/VECLIB/NUMEXPR_NUM_THREADS=1`, `UV_THREADPOOL_SIZE=1`. Assert the timing process's thread count (`/proc/<pid>/status` Threads) during the run.
- [ ] **C0.4 Load logged every 5 s** for the whole sitting and deposited. Abort and mark the sitting invalid if the 1-min load exceeds an agreed ceiling (propose 3). Host load from other users is recorded, not ignored.
- [ ] **C0.5 Identical inputs across arms:** the same keypoints, frames, sessions and cameras; the same timer scope (state what is inside the timer, e.g., undistortion in or out, eligibility scan in or out); the same statistic (D6).
- [ ] **C0.6 No chaining.** Nothing starts automatically after a timing job. The runner exits with the true status.
- [ ] **C0.7 The result is written to a new immutable file**, with the load log, thread count, host, commit and input hashes in its provenance block.

### C1–C4
- [ ] **C1 Fig 2G.** All solvers (LUC3D DLT, LUC3D refined, Anipose linear, Anipose optim) on **the same 200,010 keypoints** in one clean sitting (~8 min). Statistic per D6. Report the speed-up with and without undistortion (A1.7). Then replace the A1.1 placeholders and rebuild 2G. *Invalid sittings, never cite these:* Q2 (numba-only pinning, crashed companion), Q2b (~190 threads, load 39), Q2c (unequal n: 345k vs 200k), Q2d (contaminated, load 6.5 → 28.5).
- [ ] **C2 Fig 3F.** Greedy and exhaustive on **identical frames, sessions and cameras**: at 4×3, exhaustive used back/mid/top while LUC3D used back/backL/mid, so fix that. Use the same timer scope (exclude the eligibility scan from both, or include it in both), in the same sitting. `fig3_samefr_runtime.py` (bug fixed, not run) handles greedy. Re-time exhaustive's A2 cells alone. Re-measure the A2_C6 per-hypothesis rate on a quiet machine: the ">5 hours" claim has only a 12% margin. Then update A2.1.
- [ ] **C3 Supp 8H calibration timing.** Time Anipose and calibrat3 back to back in one idle sitting, threads pinned equally (Anipose previously ran one process per camera with `opencv_threads` 8/12/3, ~54–64 cores), worker counts recorded, load recorded, inputs kept (A6.10). Then fix L435.
- [ ] **C4 L301 RANSAC "77×".** Time it on the same keypoints as linear, with `undistort=False` in both.

The abstract speeds are not re-timed here: they stay hand-measured per E6 (provenance in A1.3). A scripted in-app harness is optional, and only if Eric asks.

---

## 6. Phase D — rebuild, regenerate, re-audit, commit

- [ ] **D1 Rebuild every affected figure** (Figs 1–6, Supp 6, Supp 8, Supp 9, datasheet) with the footer fix in place. Confirm no footer text in any output (`pdftotext *.pdf - | grep -i "variant fig"` returns nothing).
- [ ] **D2 Regenerate every tex number from the number map** (G6). Diff the tex against the map; every `WILL-CHANGE` marker must be gone.
- [ ] **D3 The tex compiles from the repo.** 9 of 10 `\includegraphics` targets do not exist next to the tex today. Copy or point to the final figures (watch the fig7 collision, A4.13) and include the current datasheet (Oct 1, not Aug 18). Run a clean `latexmk` in a fresh checkout.
- [ ] **D4 Re-run all six audits** (fairness, captions, tex numbers vs data, artwork vs text, provenance, tail inventory) against the final state. Every finding is closed or explicitly accepted by Eric in writing in this file.
- [ ] **D5 Run `md56_check.py`** extended per A6.9, on every deposit the build reads. It must pass.
- [ ] **D6 Commit** tex, figures, scripts, run scripts, logs and small deposits (A6.7). The commit message lists what changed and states only verified facts (unlike 32d40da7's "tracker, solvers and timings on v1.0.5", which was false).
- [ ] **D7 Push only on Eric's explicit go.**

---

## 7. Final sign-off (all must be ticked, with evidence, before the paper goes out)

- [ ] Every §2b decision answered and recorded.
- [ ] Every A item ticked with evidence.
- [ ] Every B item run, verified, compared old vs new, and shown to Eric, or explicitly dropped by Eric.
- [ ] Every C sitting valid under C0, with load logs deposited.
- [ ] The tail inventory (§4) all OK.
- [ ] G1–G8 hold for every number (spot-check 20 random numbers end to end: tex → map → deposit → provenance).
- [ ] The tex compiles from a fresh clone; figures match captions; no `WILL-CHANGE` or `PENDING` markers left.
- [ ] Re-audit (D4) clean.

## C3 update (~15:20 UTC): calibration (Supp Fig 8 = repo fig7) audit returned
- All original recordings exist (slap8 SMB, md10 native H.264, calib18 HEVC). Lost: the slap8 held-out and calib18 H.264 transcodes, all of the calibrat3 /tmp work dirs, and the `deposit.py` that `fig7_calib_deposit_unified.py` imports (the builder cannot run today).
- Not apples-to-apples: H thread budgets (Anipose 54–64 threads vs calibrat3 12 workers), H from separate unlogged sittings, H frame budgets (~1k sampled vs every frame), E/F calib18 = ablation re-solve (n 644,539, not 645,451), controls on a second transcode (652,540; defaults 0.188/1.252), G confounded by detections (0.41 of the gap), I ground truth outside aniposelib's model, `detection_s_cpu` mislabelled single-core.
- Rerun scripts (not run) in `figs/out/md56_logs/calib_b/`; outputs only to fig7b / `fig7_calibration_b.json` / `/root/vast/eric/calib-bench-b/`. ~6–7 h, ~2.5 h must be on a quiet machine (after C1/C2). AWAITING ERIC: rerun vs minimal honest wording.
