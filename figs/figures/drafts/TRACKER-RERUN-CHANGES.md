# Fresh-anchor rerun — what changed, and where

**Date:** 2026-08-26 · **File edited:** `figs/figures/drafts/luc3d_newest.tex`
**Backup of the pre-edit file:** kept outside the repo; `git diff` on the commit below is the authoritative record.

Every figure and every number in the manuscript is now on the tracker the
application actually ships — `stale = 20`, `distanceThreshold = 25`, frame-
synchronous association (`main`, PR #210 / commit `a95703d`). Line numbers below
are the line in `luc3d_newest.tex` **at the time each edit was made**; they are
grouped so you can work down the file.

---

## 0. The headline

Three things were wrong before this pass, in descending order of seriousness.

1. **Two figures were drawing the retired tracker.** Figure 5B and Figure 6 B–D
   were measured on the no-eviction configuration while Figure 3E/G/H and
   Figure 6A were on the fresh anchor. The Figure 6 caption said so out loud —
   `(previous default)`. One manuscript, two tracker generations.
2. **The manuscript adopted the wrong staleness window.** Supplementary 5.2 said
   *"We adopt N = 10"*. The application ships **N = 20**.
3. **The branch the figures are built on predated the fix.** `eric/figs` was
   forked before PR #210, so every bench driver in `figs/` was loading the
   pre-fix tracker out of the worktree. That is why the camera-subset
   measurement produced no-eviction numbers. `main` is now merged in.

**Nothing was re-measured that did not have to be.** Both fresh-anchor arms had
been sitting in the deposits since 2026-08-17 (`fig9_slap2m.json` cell
`sync_stale20_dist25`; `fig7_variant_best.json` block `slap2m_fresh_anchor`), so
Figures 5 and 6 were a repoint plus a replot. Only the camera-subset Methods
measurement needed the tracker run again.

---

## 1. Figures rebuilt

| Figure | Panels | What happened |
|---|---|---|
| 1 | C, D | **Re-run** through the app on the shipped tracker. Output is **byte-identical** to the previous deposit — same frame, same 25 detections, same 24 assigned, same 3 identities, same 45/45 keypoints. No text change needed; now verified rather than assumed. |
| 2 | all | Untouched. Triangulation and labeling only; no tracker in the path. |
| 3 | E, G, H | Already fresh anchor (verified, not assumed: E reads `fig3_quality__distanceThreshold25-stale20-sync_*.json`, G/H plot only the `fresh anchor (shipped)` arm). |
| 4 | all | Untouched. Measured on the proofread 3D (`*points3d*.h5`), not on tracker output. |
| 5 | **B** | **Repointed** from cell `shipped` to `sync_stale20_dist25` and replotted. |
| 5 | C–F | Untouched. Detector quality; no tracker. |
| 6 | **B, C, D** | **Repointed** to `slap2m_fresh_anchor` and replotted (the fresh arm is now the default in `panels/fig6_variant_common.flags()`). |
| 6 | A, E, F | Already correct. F legitimately shows the no-eviction control — it *is* the staleness sweep. |

---

## 2. Numbers that moved

### Figure 5B — per-difficulty cross-view IDF1 (42 multi-animal SLAP-2M sessions)

| Difficulty | n | before (retired) | after (shipped) |
|---|---|---|---|
| 2 | 10 | 0.989 | 0.989 |
| 3 | 3 | 0.923 | 0.917 |
| 4 | 10 | 0.969 | 0.969 |
| 5 | 3 | 0.925 | **0.675** |
| 6 | 3 | 0.829 | 0.877 |
| 7 | 13 | 0.649 | 0.654 |
| overall | 42 | median 0.9237 / mean 0.8396 | median 0.9197 / mean 0.8388 |

> **⚠ READ THIS ONE.** On SLAP-2M's cross-view IDF1 the fresh anchor is a **wash,
> not a win**: 15 sessions better, 14 worse, 13 unchanged, and the overall median
> drops slightly. Difficulty 5 falls 0.25 because one of its **three** sessions
> goes 0.925 → 0.604. Ratings 3, 5 and 6 hold n = 3 and cannot rank anything.
> The fresh anchor's real win is on Mouse-Dyad-10M (below) and on SLAP-2M
> *switches* (−57.6%), not on this metric. The figure now tells a less tidy
> story than the old caption did, and that is the honest result.

### Figure 6 — SLAP-2M, 74 sessions

| Quantity | before | after |
|---|---|---|
| LUC3D within-view IDF1, mean | 0.752 | **0.761** |
| sessions at IDF1 ≥ 0.9 | 39 / 74 | **40 / 74** |
| paired vs SLEAP, all 74 | +0.091, 55/74, P = 3.4e-5 | **+0.099, 56/74, P = 1.1e-5** |
| paired vs SLEAP, ≥ 2 animals | +0.052, 30/42, P = 0.008 | **+0.067, 31/42, P = 0.003** |
| medians by animal count (1–4) | +0.142, +0.060, −0.058, −0.066 | **+0.143, +0.068, −0.039, −0.028** |
| wins by animal count | 25/32, 30/35, 0/4, 0/3 | **25/32, 31/35, 0/4, 0/3** |
| ID switches, % of camera-frames | 0.0264 | **0.0112** |
| false positives, % of camera-frames | 0.317 | 0.317 (unchanged) |

Two honest caveats. The within-view **median** is a hair lower (0.92020 →
0.92015, noise at the 5th decimal). False positives are **6 higher** in raw count
(37,126 → 37,132) — so do not claim an FP improvement anywhere. The real result
is switches: 3,094 → 1,312.

### Mouse-Dyad-10M, 50 sessions (unchanged by this pass, quoted for completeness)

Switches 2,071 → 413, within-view IDF1 mean 0.749 → 0.861, median 0.760 → 0.915,
rate 4.60 → 0.92 per 100,000 camera-frames. 41 sessions improve on switches, 1
worsens; 38 improve on cross-view IDF1, 8 worsen.

---

## 3. Edits to `luc3d_newest.tex`, by line

### Deletions — retired-arm content removed outright

| Line | What was deleted | Why |
|---|---|---|
| **L96** | *"The cross-view tracker is also benchmarked on the social-DANNCE dataset with rats using data augmentation…"* | The s-DANNCE figure is not in this manuscript, and Methods §Datasets says flatly that **three** recordings were used. The Introduction was promising a benchmark the paper never delivers. `\citep{Klibaite2025}` survives on its other use. |
| **L143** | *"The previous default, swept over the same sessions and kept in the deposit, holds 2,071 switches at IDF1 0.7493 at the same ratio."* | The only retired-arm sentence in an otherwise clean paragraph. |
| **L324** | *"The previous-default tracker on the same corpus pools to 80.56 per cent (63,422,131 of 78,728,126 matches)…"* | The preceding sentence already gives the shipped tracker's IDA in full. |
| **L368** | *"…, and 0.749 to 0.749 for the previous default kept in the deposit"* | Clause only; the sentence stands as "LUC3D's IDF1 is unchanged, 0.861 within view and 0.861 across." |

### Rewrites — the tracker described in its own right

| Line | Change |
|---|---|
| **L279** | The configuration paragraph no longer presents the shipped tracker as *"the same tracker with three changes"* to an unnamed base. It now states the eviction window and the frame-start snapshot as properties of the tracker, and gives the shipped constants in one place — `corr2d = 1`, `corr3d = 6`, velocityThreshold 10, `distThresh = 25`, timePenalty 0.1, 20-frame eviction. |
| **L328** | *"the shipped comparison"* → *"the comparison as first run"* (it meant the retired arm). |
| **L336** | *"The shipped implementation retains … with no age limit"* → *"The browser port as first written retained …"*, and the reference-implementation defect tensed to the past. The app now evicts, so the present tense was false. |
| **L336** | *"overlays the experimental tracker … and leaves the shipped implementation untouched"* → *"overlays each candidate on the production module through a loader hook"*. Both "experimental" and "leaves the shipped implementation untouched" stopped being true when the fix shipped. |
| **L336** | **Added:** a sentence recording that the evicting configuration measured through the loader hook is the one now merged into `pose/cross-view-tracker.js`, so every measurement in the paper describes the released tracker. |
| **L374** | The failure mechanism tensed to the past and *"the shipped tracker"* → *"the tracker as originally ported"*. |
| **L374** | *"the unmodified tracker"* → *"the unevicted tracker"*. |
| **L154** | Fig 3 caption: *"The shipped fresh-anchor greedy misgroups…"* → *"LUC3D's greedy assignment misgroups…"*. With one tracker in the paper the qualifier only invites the question. |

### Corrections — numbers and panel letters

| Line | Change |
|---|---|
| **L184** | Fig 5B hardest stratum, median IDF1 `.649` → `.654`. |
| **L189** | Fig 5 caption: *"0.989 to 0.923 at ratings 2 to 5, then 0.829 and 0.649"* → *"medians 0.989, 0.917, 0.969, 0.675, 0.877 and 0.654 at ratings 2 to 7"*. The old phrasing described a monotone run that the fresh-anchor data does not have. |
| **L366** | Supplementary 5.1 paired differences updated (see the table above), and the three- and four-animal cells now state that the deficit roughly halves rather than leaving it as a bare negative. |
| **L381** | Fig 6 caption: `≥ 0.9` count 39 → 40; per-animal-count medians, means and wins updated; LUC3D ID-switch share `0.0264%` → `0.0112%`; **`(previous default)` and `(shipped config)` provenance parentheticals deleted**; panel A's *"the shipped fresh-anchor configuration"* → *"stale 20, distThresh 25, synchronous scoring"*. |
| **L374** | Supplementary 5.2: the improve/worsen counts and median now describe the **shipped N = 20** (median 0.760 → 0.915, 38 improved, 8 worsened); N = 10 demoted to a neighbouring point. |
| **L376** | **Reversed the adoption sentence.** It selected `N = 10`; the application ships `N = 20`. Restated from the deposit: 413 switches against 511, mean cross-view IDF1 0.861 against 0.850, median 0.915 against 0.913, 8 rather than 10 sessions worsened, with the single cost that its worst per-session change is deeper (−0.183 against −0.138). |
| **L137** | Fig 3 grouping-accuracy reference `D` → `E`. |
| **L143** | Fig 3 sweep reference `D` → `G and H`; configuration cross-reference `C` → `E`. |
| **L370** | Dropped *"and Figure 6F reports it"* from the fragmentation paragraph — 6F is the staleness sweep. The fragmentation numbers are measured but not drawn on any panel (see open questions). |
| **L370** | Fragmentation numbers updated to the shipped tracker: mean **6.2 → 3.2** fragmentations per camera-session, median **1.3 → 0.9**, and SLEAP fragments less in **72 → 70** of the 74 sessions. The fresh anchor roughly halves the fragmentation cost, so this paragraph now understates rather than overstates the price of the cross-view result. |
| **L145** | Supplementary pointer repaired: stray space in `Supplementary ~\ref`, hard-coded "Section 5.1 and 5.2" → `\ref`, missing terminal period. |

---

## 3b. Provenance audit — every placed panel, mechanically checked

Generated by walking `assemble.LAYOUTS`, resolving each `(figure, letter, slug)`
to the script whose `save()` claims it, and reading that script's `load()` calls.
This is the evidence that nothing is still on the retired arm.

| Panel | Drawn by | Deposit it reads | Tracker in the path |
|---|---|---|---|
| 1a, 1b, 1e | render / pipeline / table | — | none |
| 1c, 1d | `fig1_02_tracking`, `fig1_03_reconstruction` | `fig1.json` | **re-run on the shipped tracker; byte-identical** |
| 2a–2g | protocol / placements / accuracy / angle / solvers | `fig2*.json`, `fig4_by_views.json`, `fig4_robust_sessions.json` | none — triangulation and labeling only |
| 3a, 3c, 3d | schematic + two Blender illustrations | — | none |
| 3e (composite) | `fig3_13_quality`, `fig3_18_head_to_head` | `fig3_quality__distanceThreshold25-stale20-sync_*.json` | **fresh anchor** |
| 3g (composite) | `fig3_17_sweep_split` | `fig3_sweep50__distanceThreshold25-stale20-sync_*.json` | **fresh anchor** (plots the `fresh anchor (shipped)` arm only) |
| 4a–4g | the seven social-rearing panels | `fig5_upright.json`, `fig5_views.json`, `fig5_rear_coupling_2animal.json` | none — measured on the proofread 3D (`*points3d*.h5`) |
| 5a | difficulty grid | — | none |
| 5b | `fig5_11_idf1_by_difficulty` | `fig9_slap2m.json` cell `sync_stale20_dist25` | **fresh anchor** (repointed today) |
| 5c–5f | recovery / animal count / detection quality / strata | `fig6_detections.json`, `fig6_recovery.json` | none — detector only |
| 6a (composite) | `fig6_05_within_vs_cross --variant` + b/c/d | `fig7_variant_best.json` → `slap2m_fresh_anchor` | **fresh anchor** (b/c/d repointed today) |
| 6e | Chen-style anchor diagram | — | none — illustration |
| 6f | `fig6_07_pr_switches` | `fig8_methods_50.json` | **both arms by design** — it is the staleness sweep |

Independently, the rendered PDFs were text-extracted and contain no occurrence of
"previous default", "shipped", "experimental" or "still calls" on any artwork.

---

## 4. Open questions for you

1. **Figure 5B is now a weaker panel.** Under the shipped tracker the
   per-difficulty medians no longer descend cleanly, because ratings 3, 5 and 6
   have n = 3. Options: keep it and describe it as it is (what I have done);
   collapse the ratings into coarser bins; or drop the panel and make the
   difficulty claim from the detection-quality panels alone.
2. **Figures 5B and 6 B–D are measured on different detection pools.** Fig 5B
   reads `fig9_slap2m.json`, whose pool is `keeptrack`; Fig 6 B–D read
   `fig7_variant_best.json`, whose pool is `predictions_h5s` (PAF_3d_kalman).
   Same corpus, different detections, so their IDF1 levels are not comparable to
   one another. This predates today's work. Worth one sentence in Methods, or a
   decision to put both on one pool.
3. **`fig9_slap2m.json` is stamped `EXPLORATORY — not part of the manuscript`**,
   but it backs a manuscript panel. The stamp is stale; it should be corrected so
   nobody later trusts it.
4. **The fragmentation paragraph (L370) has no panel.** Its numbers are real but
   nothing on the artwork shows them. Keep the paragraph, or restore the panel.
5. **`\bibitem{Lever2006}` is never cited.** Cite it or drop it.
6. **The s-DANNCE benchmark is now absent from the paper entirely** (L96
   deleted). If you want that result back it needs its figure restored from git
   history.

---

## 5. Reproducing this

```bash
cd figs
.venv/bin/python make_figures.py 5 6      # panels, syncs, assemble
```

Provenance for every panel — script, deposit, measurement pass, deposited CSV —
is regenerated into `figs/PANEL-SOURCES.md` by `figs/make_docs.py`.
