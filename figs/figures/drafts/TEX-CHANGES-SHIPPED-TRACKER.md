# `luc3d_newest.tex` — every line I changed, and what you still need to decide

**Generated 2026-08-27.** Line numbers are the **current** lines in
`figs/figures/drafts/luc3d_newest.tex`, so you can jump straight to them. Every
figure in the manuscript is now measured on the tracker the application ships
(`stale = 20`, `distanceThreshold = 25`, frame-synchronous association — `main`,
PR #210). The file contains **no** remaining mention of the retired
configuration outside the three places that are legitimately about the fix.

---

## 1. What was actually re-measured

| Piece | Status |
|---|---|
| Fig 5B, Fig 6 B–D | **Repointed and replotted.** The shipped-tracker arms were already in the deposits, so no new computation. |
| Camera-subset Methods | **Re-measured.** 500 tracking runs plus a full rescore. Its k = 5 gate reproduces the shipped deposit cell exactly (max abs IDF1 difference **0.0**) — that is also the proof that this worktree's production tracker and the benchmark overlay are the same code path. |
| Fig 3F timings | **Re-measured** on an idle machine. |
| Fig 1 C/D | **Re-run** through the app; output byte-identical, so nothing downstream moved. |
| Figs 2, 4, and 5 C–F | Untouched — verified mechanically to have no tracker in their path (triangulation, proofread 3D, and detector quality respectively). |

## 2. Results that moved, in one place

| Quantity | Before | After |
|---|---|---|
| Fig 5B per-difficulty medians (ratings 2–7) | 0.989, 0.923, 0.969, 0.925, 0.829, 0.649 | **0.989, 0.917, 0.969, 0.675, 0.877, 0.654** |
| Fig 6 paired vs SLEAP, all 74 | +0.091, 55/74 | **+0.099, 56/74** |
| Fig 6 paired vs SLEAP, ≥ 2 animals | +0.052, 30/42 | **+0.067, 31/42** |
| Fig 6 sessions at IDF1 ≥ 0.9 | 39/74 | **40/74** |
| Fig 6 LUC3D ID-switch share | 0.0264% | **0.0112%** |
| Fragmentation cost | mean 6.2, median 1.3, SLEAP ahead 72/74 | **mean 3.2, median 0.9, 70/74** |
| Camera-subset per-k mean IDF1 (k = 2,3,4,5) | 0.68, 0.74, 0.75, 0.75 | **0.67, 0.77, 0.82, 0.86** |
| Fig 3F LUC3D time per frame | 1.1–2.4 ms | **0.4–1.0 ms** |

Two of these change the *shape* of a claim, not just its digits:

- **The camera-subset trend is now monotone.** Under the retired tracker it
  plateaued (0.74, 0.75, 0.75) and a four-camera subset actually beat the full
  rig, which quietly undercut the sentence it was written to support. It now
  rises all the way to the full rig, and switches fall with it.
- **Fig 5B is weaker, and I left it that way.** On SLAP-2M's cross-view IDF1
  the shipped tracker is a wash — 15 sessions better, 14 worse, overall median
  0.9237 -> 0.9197 — and difficulty 5 drops to 0.675 because one of its *three*
  sessions falls 0.925 -> 0.604. Ratings 3, 5 and 6 hold n = 3 and cannot rank
  anything. The tracker's real wins are Mouse-Dyad-10M and SLAP-2M *switches*
  (−57.6%), not this metric.

---

## 3. Line-by-line

`cut` = retired-arm content removed · `number` = value updated · `xref` = wrong
cross-reference · `rewrite` = passage restated · `label` = wording only ·
`structure` = panel lettering · `add` = new sentence · `tidy` = typo or orphan

| Line | Where | Kind | Change |
|---|---|---|---|
| **L96** | Introduction | cut | **DELETED the social-DANNCE benchmark sentence.** Its figure is not in this manuscript and Methods states three recordings were used, so the Introduction was promising a result the paper never delivers. |
| **L104** | Results 2.1 | tidy | `Figure~\ref{fig1} A` -> `Figure~\ref{fig1}A` (stray space). |
| **L106** | Results 2.1 | tidy | Deleted a verbatim repeat of the preceding paragraph's “three stages” sentence. |
| **L122** | Results 2.2 | number | **Fig 2C two-camera 3D error 4.27 -> 4.74 mm.** The deposit gives 4.738; the caption was already right and the body had a transposition. |
| **L129** | Fig 2 caption | structure | **Panel letters ran A B C D _A_ _e_ F G** — a duplicate A, a lowercase e and no capital E. Folded the orphan solver-diagram sentence into a single **E** with Top/Bottom halves, so the caption now runs A–G. |
| **L137** | Results 2.3 | add | **Added the Fig 3E result to the body** (926 vs 1,309 misgroupings, 20.3 vs 28.6 per 100,000). The paragraph asked whether greedy gives up accuracy and never answered; the numbers were caption-only while the Discussion already asserted the conclusion. Panel letter also D -> E. |
| **L139** | Results 2.3 | number | Exhaustive-to-greedy gap **about a million -> about two million**: the shipped tracker is faster, so 1,980.9 s against 1.0 ms. |
| **L143** | Results 2.3 | cut+letters | **DELETED the retired-arm sentence** (“The previous default … 2,071 switches at IDF1 0.7493”) and the aside “a trend the earlier four-session version of this benchmark could not have shown”. Panel letters: sweep D -> **G and H**, configuration cross-reference C -> **E**. |
| **L145** | Results 2.3 | tidy | Repaired the supplementary pointer: stray space, hard-coded section numbers -> `\ref`, missing period. |
| **L154** | Fig 3 caption | label | “The shipped fresh-anchor greedy” -> “LUC3D's greedy assignment”. |
| **L154** | Fig 3 caption | number | **LUC3D per-frame time re-measured: 1.1–2.4 ms -> 0.4–1.0 ms.** Eviction shrinks the retained set the tracker re-triangulates against, so the saving grows with camera count (1.5x at 2 cameras to 2.9x at 6). |
| **L184** | Results 2.6 | number | Fig 5B hardest-stratum median **.649 -> .654**. |
| **L189** | Fig 5 caption | number | Per-difficulty medians restated: was “0.989 to 0.923 at ratings 2 to 5, then 0.829 and 0.649”, now **0.989, 0.917, 0.969, 0.675, 0.877, 0.654** at ratings 2–7. |
| **L207** | Discussion | tidy | Cited `Lever2006`; it sat in the bibliography uncited. |
| **L241** | Methods/Datasets | tidy | Referenced `tab:datasheets`; the datasheet table had a label but no reference. |
| **L243** | Methods/Datasets | xref | Completed the Mouse-Dyad-10M attribution: Fig 3G/H and Fig 6F are this corpus, and Fig 2A is HardFight. |
| **L245** | Methods/Datasets | xref | SLAP-2M list: Figure 6 **“B to F” -> “B to E”** (panel F is Mouse-Dyad-10M). |
| **L265** | Methods/detection pool | xref | **Repointed the whole sampling paragraph from Figure 4 to Figure 2E–G.** Figure 4 is the social-rearing figure and has no by-camera-count pass; as written the paragraph also contradicted itself (Fig 4 “every frame” then “every 15th frame”). |
| **L267** | Methods/detection pool | xref | Same repointing for the stride-verification sentence (Fig 4B -> Fig 2E). |
| **L279** | Methods/association | rewrite | **Rewrote the configuration paragraph.** The tracker is described in its own right — 20-frame eviction, frame-start snapshot, `distThresh = 25` — instead of as “the same tracker with three changes” to an unnamed base. |
| **L289** | Methods/camera subsets | number | **Re-measured on the shipped tracker** (500 tracking runs + rescore; the k = 5 gate reproduces the deposit exactly, max |diff| 0.0). Subset means **0.644–0.688 / 0.750–0.779 / 0.803–0.843 against 0.861** at k = 2/3/4/5, per-k means **0.67, 0.77, 0.82, 0.86**, switches 2,383–3,540 down to 413. Under the retired arm this trend plateaued (0.68, 0.74, 0.75, 0.75) and a 4-camera subset beat the full rig; it is now monotone. Also deleted the draft note “The panel drawn from this measurement is not yet placed on any figure.” |
| **L297** | Methods/triangulation | xref | “Figures 2F and **4G**” -> “Figures 2F and **2G**”; Fig 4G is the rear-onset coupling. |
| **L313** | Methods/behavior | rewrite | **Rewrote the Fig 4F description.** It described a retired version of the panel — a size-matched binomial surrogate and “the bound of $P < 0.0005$ quoted in the caption”, a bound the caption does not contain. The shipped panel draws the two complementary shares with a paired Wilcoxon. |
| **L324** | Methods/tracking metrics | cut | “For the fresh-anchor configuration” -> “For LUC3D”, and **deleted the next sentence**, which gave the retired tracker's IDA (80.56 per cent). |
| **L328** | Methods/baseline | label | “the shipped comparison” -> “the comparison as first run” (it named the retired arm). |
| **L336** | Methods/anchor staleness | rewrite | Dropped “the experimental tracker” and “leaves the shipped implementation untouched”, and **added** that the configuration these runs selected is the one now merged into `pose/cross-view-tracker.js`. |
| **L336** | Methods/anchor staleness | rewrite | Tensed to the past and renamed. The app now evicts, so “The shipped implementation retains … with no age limit” was false in the present tense. |
| **L340** | Methods/statistics | cut | **Deleted the “binomial nulls simulated with 20,000 draws” clause** — it described the same retired surrogate as the Fig 4F passage and disagreed with it (2,000 vs 20,000). |
| **L340** | Methods/statistics | xref | Removed Figure 6F from the bootstrap-CI list; its whiskers are IQR. |
| **L364** | Supp 5.1 | xref | “B to F” -> “B to D”. Panels E and F are not SLAP-2M per-session comparisons. |
| **L366** | Supp 5.1 | number | Paired within-view differences: **+0.091 / 55 of 74 / P = 3.4e-5 -> +0.099 / 56 of 74 / P = 1.1e-5**, and ≥ 2 animals **+0.052 / 30 of 42 / P = 0.008 -> +0.067 / 31 of 42 / P = 0.003**. Also cut “though the deficit roughly halves against the unevicted tracker”. |
| **L368** | Supp 5.1 | cut | Cut “at the fresh-anchor configuration the panel draws” and the clause “and 0.749 to 0.749 for the previous default kept in the deposit”. |
| **L370** | Supp 5.1 | number | Fragmentation cost **mean 6.2 -> 3.2** per camera-session, **median 1.3 -> 0.9**, SLEAP ahead in **72 -> 70** of 74. Also dropped the dead “and Figure 6F reports it” pointer. |
| **L374** | Supp 5.2 | label | “the unmodified tracker” -> “the unevicted tracker”. |
| **L374** | Supp 5.2 | number | Improve/worsen counts and median now describe the **shipped N = 20** (0.760 -> 0.915, 38 improved, 8 worsened); N = 10 demoted to a neighbouring point. |
| **L374** | Supp 5.2 | rewrite | Failure mechanism tensed to the past; “the shipped tracker” -> “the tracker as originally ported”. |
| **L374** | Supp 5.2 | xref | Panel pointer **D -> F**, and the trailing “(See Supplementary Figure 6A–C)” -> **F**. Every number in the sentence comes from panel F. |
| **L376** | Supp 5.2 | **REVERSED** | **The adoption sentence said “We adopt N = 10” while the application ships N = 20.** Restated from the deposit: 413 switches against 511, mean 0.861 against 0.850, median 0.915 against 0.913, 8 rather than 10 sessions worsened, at the cost of a deeper worst single-session change (−0.183 against −0.138). |
| **L381** | Fig 6 caption | cut | **Deleted the `(previous default)` provenance on panels B–D** and the redundant `(shipped config)` on A. |
| **L381** | Fig 6 caption A | label | Dropped the “shipped fresh-anchor configuration” framing; parameters kept. |
| **L381** | Fig 6 caption B | number | Sessions at IDF1 ≥ 0.9: LUC3D **39 -> 40**. |
| **L381** | Fig 6 caption C | number | Per-animal-count medians **+0.142, +0.060, −0.058, −0.066 -> +0.143, +0.068, −0.039, −0.028**, means and win counts likewise; ≥ 2 animals **+0.052 (30/42) -> +0.067 (31/42)**. |
| **L381** | Fig 6 caption D | number | LUC3D ID-switch share **0.0264% -> 0.0112%**. False positives unchanged. |

---

## 4. Where **you** need to go back into the tex

These I deliberately did **not** change, because each needs a decision that is
yours, not a lookup. Line numbers are current.

### Decisions about the science

1. **Fig 5B's weaker story (L184 body, L189 caption).** You said 5B is fine, so I
   left it stated honestly. If you would rather it read cleanly, the options are
   to bin ratings 2–4 against 5–7, or to make the difficulty claim from the
   detection-quality panels alone and drop 5B. Any of the three is defensible;
   what is not defensible is the old caption's tidy monotone summary.

2. **Fig 5B and Fig 6 B–D sit on different detection pools.** Fig 5B reads
   `fig9_slap2m.json`, whose pool is `keeptrack`; Fig 6 B–D read
   `fig7_variant_best.json`, whose pool is `predictions_h5s`. Same corpus,
   different detections, so their IDF1 levels are **not** comparable to each
   other. This predates all of today's work. It deserves one sentence in Methods,
   or a decision to put both on one pool.

3. **The fragmentation paragraph (L370) describes a panel that is not on the
   figure.** Its numbers are real and now current, but nothing on the artwork
   shows them. Keep the paragraph, or restore the panel.

4. **Fig 3C, Fig 3D and Fig 6E are described in captions but never referenced in
   the body** (L154, L381). Fig 6E exists only to set up Fig 6F. Either give each
   a pointer in the text or fold them into a neighbouring panel's description.

### Things I could not verify from the deposits

5. **Three different denominators for the same benchmark** — L154 says
   `4,572,172 clean frames`, the same caption says `4,591,864 ... were clean and
   all were computed`, and L283 says `the 4,591,725 computed frames carrying a
   transferred ground-truth match are scored`. All three are probably right
   (eligible / computed / GT-matched), but as written a reader will read it as an
   error. State the relationship once.

6. **L184 says the hardest stratum's miss rate is 57.7%, L189's panel C says
   57.1% at two cameras** where recovery is zero by construction. I checked: they
   are two different statistics — 57.7% is the session-mean from the
   detection-quality deposit, 57.07% is pooled over keypoint-instances from the
   recovery deposit. Neither is wrong, but the text implies they are the same
   number. One clause fixes it.

7. **L172 says 24 sessions, L313 and the Fig 4F caption say 23.** Also not an
   error: 24 is the family with at least five displays, 23 the family with at
   least six. Worth making explicit, since it reads as a contradiction.

### Housekeeping

8. **Live TODOs** at L253 (mouse strains), L345 (acknowledgments), L348 (data
   availability), L352 (code availability), and the stale corpus name
   `Mouse-Dyad-10M-11M` in the L348 comment.

9. **Prose defects I left alone** because fixing them would have meant rewriting
   your sentences rather than correcting a fact: L94 `"brings together SLEAP's to
   allow for"` (incomplete), L98 `"requires requires"`, L104 `"there is cannot be
   3D reconstruction"`, L120 `"a 2.3 reduction"` (missing "-fold"), L145 has no
   main clause, L149 `"betweem"`, L162 `"no view turns can turn"`, L178
   `"80.\%"` (stray period — and worth confirming it is not a copy of the
   unrelated 80.1% initiation share), L205 `"As a result"` twice in consecutive
   sentences, L293 `"so is more akin"`.

10. **The s-DANNCE benchmark is now absent from the paper** (its Introduction
    sentence deleted at L96, its figure deleted from the repo earlier). If you
    want that result back it needs its figure restored from git history.

---

## 5. The staleness passages are now a parameter study, not a history

The first pass kept a before/after narrative in the two staleness sections on
the grounds that they were "about the fix". Eric's call (2026-08-27): *"why
mention an obsolete tracker at all?"* — and he is right, because `stale` is a
live parameter of the shipped tracker with default 20, where **0 disables
eviction**. So the sweep is a study of a knob the reader can set, and nothing in
the paper needs to refer to a superseded build.

Rewritten accordingly:

- **L334** — Methods subsection retitled *"Anchor staleness and the fresh-anchor
  tracker"* -> *"The staleness horizon of the 3D anchor"*.
- **L336** — the whole passage recast. *"The browser port as first written
  retained … and the browser port reproduced that behavior"* is gone; it now
  defines $N$, states that $N = 0$ is the no-expiry limit, and keeps Chen's
  Eq. 11 attenuation as the principle a finite $N$ approximates. The
  loader-hook/"reproduced the unevicted baseline bit-identically" provenance is
  gone too, and the distance threshold is *"swept at 50 and 25"* rather than
  *"reduced from 50 to 25"*.
- **L374** — *"Because the tracker as originally ported re-triangulated …"* ->
  *"With the staleness horizon disabled ($N = 0$) …"*, and the headline restated
  as a comparison between two settings rather than a change the tracker
  underwent.
- **L376** — *"from no eviction to any eviction"* -> *"from $N = 0$ to any
  finite horizon"*.
- **L381** — Fig 6 caption title *"the fresh-anchor staleness horizon"* -> *"the
  staleness horizon of the 3D anchor"*; the raw totals now read *"at stale 0, 1,
  10, 20 and 30"* instead of singling one out as *"(no eviction)"*.
- **On the artwork**: the Fig 6F key entry *"no eviction"* -> *"stale 0"*
  (`panels/fig6_07_pr_switches.py`), and the panel title *"Fresh anchor
  parameter sweep"* -> *"Staleness horizon sweep"* (`assemble.py`). The key now
  reads as one parameter axis: stale 0, 1, 10, 20, 30.

The file now contains **no** reference to a superseded tracker anywhere — the
only surviving comparisons are between values of $N$.

---

## 6. Reproducing

```bash
cd figs
.venv/bin/python make_figures.py          # all panels, both syncs, assemble 1-6
```

The camera-subset measurement is not part of that build (it is a Methods number,
not a panel):

```bash
.venv/bin/python figs/fig2_cams_identity.py --stage track --workers 12
$LIEZL_PY  figs/fig2_cams_identity.py --stage score --workers 16
```

Its k = 5 gate will fail loudly if the tracker in the worktree ever stops
matching the deposited shipped-configuration result.
