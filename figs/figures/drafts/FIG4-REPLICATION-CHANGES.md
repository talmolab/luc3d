# Figure 4 revision: unit of replication, slot control, tempered claims

**Date:** 2026-09-20
**Files:** `figs/figures/drafts/latex_newest.tex`, `figs/figures/fig4/`, `figs/panels/fig4_*.py`, `figs/fig4_*.py`, `figs/data/fig4/`
**Responds to:** Reviewer 3 majors 1 to 4 and the panel D/E minors in `AI-REVIEW-NatNeuro.md`

Line numbers refer to `latex_newest.tex` after the edits. Every number below was recomputed from the
regenerated `figs/out/fig5_upright.json` and checked in the deposited CSVs named in section 4.

---

## 1. What was wrong

**Pseudoreplication in Figure 4D and 4E.** Both panels drew their boxes over 538 displays and ran a
paired Wilcoxon test with n = 538. The displays come from 37 sessions of nine mice (four males, five
females) in 18 pairings, and one female takes part in 305 of the 539. Treating displays as independent
reported P = 6.5e-22 and P = 3.3e-73 from nine animals. The Statistics section already stated that the
session is the unit of analysis, and panel F already tested at that level, so D and E contradicted both.

**A slot asymmetry in the event detector.** The male occupies track slot 0 and the female slot 1 in
every session, so sex and slot are confounded. Re-running the detector with the two slots exchanged
showed that the output was identical with the roles reversed for 535 of 539 displays. The four
exceptions were displays in which both animals' rear bouts begin on the same frame: the rule
`init_a = 0 if onsets[0] < onsets[1] else 1` credited a tie to slot 1, the female, in the direction of
the claim. These four displays now have no initiator and drop out of every initiation count.

**Controls with no script behind them.** The four control analyses in Results (rearing base rate,
absolute 60 mm threshold, shared threshold, body size) had no code or deposit in the repository. They
are now reproduced by `figs/fig4_controls.py` under the corrected tie rule.

**Claims wider than the n.** "Sexually dimorphic", "sex-specific asymmetry" and "courtship" appeared in
Results and Discussion. With four males and five females the asymmetry cannot be separated from
individual identity for the speed measure (Mann-Whitney P = 0.19 across animals), and nothing in the
data establishes a reproductive context.

## 2. What changed in the figure

Panels **D** and **E** keep the box-and-whisker form. The data inside each box are now one value per
session (the median over that session's displays), 37 values per box, with the y axis set to the
whiskers. The significance bracket is from the session-level paired Wilcoxon. No per-session dots are
drawn. Panel **C** and panel **F** re-rendered because the tie rule changed their counts (432 to 428
female-led displays, median lag 0.39 to 0.40 s, session median share 0.857 to 0.826). Panels A, B and
G are unchanged in content. The panel d title now reads "traveling" (American spelling).

Composite: `figs/figures/fig4/fig4.pdf` and `fig4.png`, 180 by 181 mm, seven panels, rebuilt with
`python3 assemble.py 4`.

## 3. Numbers before and after

| Quantity | Before | After | Where |
|---|---|---|---|
| D, test | paired Wilcoxon, n = 538 displays, P = 6.5e-22 | paired Wilcoxon, n = 37 sessions, male faster in 28 of 37, P = 4.6e-4 | L169, L182 |
| D, medians | 0.382 and 0.231 (displays) | 0.36 and 0.20 (session medians) | L169, L182 |
| E, test | n = 538, P = 3.3e-73 | n = 37, male more negative in 37 of 37, P = 1.5e-11 | L169, L182 |
| E, medians | -0.708 and -0.058 | -0.89 and -0.07 | L169, L182 |
| D and E, pair level | not reported | 13 of 14 and 14 of 14 pairs, P = 2.4e-4 and 1.2e-4 | L169, L324 |
| D and E, animal level | not reported | speed P = 0.19, pursuit P = 0.016, four males and five females | L169, L324 |
| Female-led displays | 432 of 539 (80.1%) | 428 of 535 with an initiator (80.0%), four ties | L171, L182 |
| Lag, female-led | median 0.39 s, IQR 0.17 to 0.90 | median 0.40 s, IQR 0.17 to 0.92 | L171, L182 |
| F, session median share | 0.86 (0.857) and 0.143 | 0.83 (0.826) and 0.14 | L171, L182 |
| F, P | 2.7e-5 | 2.7e-5 (unchanged) | L171, L182 |
| Pair pooling | 429 of 536 (80.0%) | 425 of 532 with an initiator (79.9%) | L173 |
| Base-rate correlation | r = -0.012, P = 0.96 | r = -0.009, P = 0.97 | L175 |
| Shared threshold | consistent in 22 of 24 | consistent in 21 of 24 | L175 |
| Female-longer sessions | 75 of 97 (77%), P = 6e-8 | 74 of 96 (77%), P = 9e-8 | L175 |
| 60 mm threshold, body length, shorter-leader | unchanged | 24 of 24, 29 of 37, 28 of 36 | L175 |

## 4. Code and data

**New**
- `figs/fig4_replication.py`: per-session, per-pair and per-animal reduction and tests shared by the
  two panels, with the reasoning in its docstring.
- `figs/fig4_slot_swap_control.py`: re-runs every session with the two track slots exchanged and
  checks frames, initiator and every per-animal feature. Deposits `data/fig4/fig4s_slot_swap_control.csv`.
  Result after the tie fix: 37 sessions, 539 displays, swap-invariant, maximum difference 0.0.
- `figs/fig4_controls.py`: the four controls, with the height-threshold variants run through the
  detector. Deposits `data/fig4/fig4s_controls.csv` (one row per session under each of three rules).
- `data/fig4/fig4d_speed_by_session.csv`, `data/fig4/fig4e_pursuit_by_session.csv`: the 37 session
  values each box is drawn from, followed by `TEST_*` summary rows for each unit of replication.

**Modified**
- `figs/fig4_upright.py`: exact ties have no initiator (comment dated 2026-09-20 at the initiator
  block). `REAR_MODE` and `REAR_ABS_MM` hooks for the threshold controls, default behavior unchanged.
  Before the tie change the script reproduced the deposited JSON exactly (539 events, every field
  equal), so the regenerated `figs/out/fig5_upright.json` differs only where the tie rule applies.
- `figs/panels/fig4_09_upright_velocity.py`, `figs/panels/fig4_07_upright_stats.py`: session-level
  boxes and tests. The display-level deposits `fig4d_upright_velocity.csv` and `fig4e_upright_stats.csv`
  are kept and now carry `session`, `male_id`, `female_id`.
- `figs/assemble.py`: panel (4, d) title spelling.
- `data/fig4/fig4c_initiator_lag.csv`, `fig4f_leader_by_session.csv`: regenerated under the tie rule.

## 5. Manuscript changes, by line

- **L165** "may be related to courtship" removed from the opening sentence of the subsection. Now "The
  behavior shows a leader and follower structure."
- **L169** Panel D and E statistics rewritten at the session level, with the pair-level counts and the
  animal-level tests added. The speed result is explicitly stated not to separate from individual
  identity at this number of animals.
- **L171** "sexually dimorphic" replaced with "in this cohort the female is the leader". Tie displays
  disclosed. 432 of 539 changed to 428 of 535, 0.39 s to 0.40 s, 0.86 to 0.83. A semicolon in the
  parenthetical replaced with a comma.
- **L173** "9 mice" expanded to "nine mice (four males and five females)" and the display imbalance
  stated (one to 305 per female). Pair pooling updated to 425 of 532.
- **L175** Opener changed from "alternatives to a sex difference" to "alternatives to a female-led
  asymmetry". Correlation, shared-threshold and female-longer numbers updated. Closing sentence no longer
  says "sex-based" and now lists track slot among the alternatives ruled out. The hedged courtship
  sentence at the end of the paragraph is kept as written.
- **L182** (Figure 4 legend) C, D, E and F updated to the numbers above. D no longer says "over each
  animal's own session baseline", which described a different measure than the panel draws (the panel
  uses body lengths per second). "1.5x" and "1.7x" set as `$\times$`, "grey" to "gray". Footer now
  states nine mice, four males and five females, 18 pairings, one value per session for D and E, and the
  four excluded tie displays. Six semicolons in D, E and F replaced with periods.
- **L211** (Discussion) "may be related to courtship or more generally joint exploration" and
  "sex-specific asymmetry" removed. "Resembles a potential courtship interaction" removed. A sentence
  added stating that four males and five females cannot settle whether the asymmetry is a sex difference,
  and that courtship would need independent measures. "critical for its characterization" changed to
  "necessary to characterize it". "stable directional social dynamic" now qualified with "in this cohort".
- **L318** Methods subsection title "Behavioral analysis of social rearing courtship behavior." changed
  to "Behavioral analysis of social rearing" (also removes the trailing period).
- **L322** Tie rule stated: a display in which both bouts begin on the same frame has no leader, four of
  539.
- **L324** Panel D definition corrected (median over 0.5 s, not "relative to own baseline"). New
  sentences define the unit of replication for D and E, the pair-level and animal-level repeats, and the
  display counts per animal.
- **L326** Panel F test restated as what the code does (paired Wilcoxon of the two shares across
  sessions). The "sum to one" sentence removed, since it no longer holds in sessions with a tie.
- **L330** Dangling "to control." fixed. Slot confound and slot-swap control described.
- **L360** (Statistics) "9 mice" to "nine mice (four males and five females)". Figure 4 sentence now
  covers D to F at the session level with pointers to the pair- and animal-level repeats.

## 6. Reviewer items addressed

- **R3 major 1** (four males, five females never foregrounded): stated in Results L173, the legend
  footer L182, Methods L324, Statistics L360. Claims scoped to the cohort at L171 and L211.
- **R3 major 2** (pseudoreplication in D and E): fixed at the figure, legend, Results and Methods level.
- **R3 major 3** (sex confounded with track slot): slot-swap control run, the one asymmetry found and
  removed, control described at L330 and listed at L175.
- **R3 major 4** ("courtship" in the Discussion): removed from L165 and L211. Kept once, hedged, at
  the end of L175.
- **R3 minor** (show the n behind the boxes): boxes are now over 37 session values and the legend says
  so. Per-session dots were tried and removed at the author's request.
- Also caught: the legend and Methods described panel D as baseline-normalized speed while the panel
  draws body lengths per second. Both now match the code.

## 6b. The "50 proofread sessions" phrase (2026-09-20, later the same day)

A fresh read of the manuscript took "the 50 proofread Mouse-Dyad-10M sessions" (five occurrences) to
mean that the other six sessions were not proofread, while the behavioral analysis uses all 56. Checked
and found to be a wording problem. All 56 sessions have NaN-free proofread 3D reconstructions, the
datasheet lists 56 sessions with three proofreaders, and commit f1bfe3e records that the six sessions
recorded on 2025-09-08 were skipped at the 200-frame stride for too little cross-camera overlap and
joined Figure 2 once every frame was used. The tracking benchmarks (Figures 3 and 6) still use the
earlier 50-session list.

- **L136, L276, L356, L431 (two)** "50 proofread sessions" changed to "the 50 sessions of the tracking
  benchmarks" or "the 50 benchmark sessions".
- **L247** (Methods, Datasets) Four sentences added: all 56 sessions were proofread in 3D, which figures
  use the 50 and why, which figures use all 56, and that the social rearing result is unchanged on the
  50 alone (80.0% female-led in both sets, 32 of 32 sessions).
  Confirmed by Eric on 2026-09-20: all 56 sessions were proofread. The sentence stands as written.
- **New** `figs/fig4_benchmark_subset.py` and `data/fig4/fig4s_benchmark50_subset.csv`: every statistic
  in the social rearing Results on all 56, on the 50, and on the six alone. On the 50: 483 displays in 32
  sessions, female-led 384 of 480 (80.0%), 32 of 32 sessions, share median 0.857 (P = 8.7e-5), pairs 12
  of 12, speed 24 of 32 (P = 2.8e-3), pursuit 32 of 32 (P = 4.7e-10). On the six alone: 44 of 55 (80.0%).

## 7. Still open

- **Mixed-effects model** (`value ~ sex + (1 | animal) + (1 | session)`). Not fitted, `statsmodels` is
  not in the figure environment. The session-, pair- and animal-level tests are the standard answer
  and are reported. Fit the model if a reviewer asks.
- **Panel titles** for D and E ("Female is still; male is traveling", "Male is pursuing female") state
  conclusions. Left as they were. Descriptive alternatives are a one-line change in `assemble.py`.
- **R3 majors 5 and 6** (behavioral context, positioning in the rearing literature) are text the
  authors need to supply.
- **Copydesk items outside this scope** on the edited lines: L182 keeps four semicolons in the panel B
  and G text, and "(0.6×; the male has not yet reared)" keeps its semicolon. Not touched.
- **figures-luc3d** has not been re-pushed. The new and modified files under `figs/` are ready.

## 8. Verification

- `fig4_upright.py` rerun before the code change reproduced `out/fig5_upright.json` exactly.
- `fig4_slot_swap_control.py` after the tie fix: swap-invariant, maximum difference 0.0.
- `fig4_controls.py` reproduces the 60 mm, body-length and shorter-leader results unchanged.
- All seven Fig 4 panels rerun, `assemble.py 4` rebuilt the composite, `assemble.stale(4)` empty.
- Every edited manuscript line checked for balanced braces, math delimiters and parentheses, and
  for semicolons, "against", "rather than", British spellings and ASCII multiplication signs.
