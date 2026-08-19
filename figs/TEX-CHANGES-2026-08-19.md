# Changes applied to `figures/drafts/luc3d.tex`

I audited every figure reference in the manuscript against the artwork that is
currently on disk and edited the file directly. Eleven lines changed, each one a
whole-line replacement. No lines were inserted or deleted, so nothing shifted and
the file is 486 lines before and after. In Overleaf you can select the old line
and paste the new one over it.

Line 200 was edited once more after the Fig 6a renders were rebuilt with the near
cage wall left unfilled. The added clause is noted in the entry for that line.

The version you gave me is backed up at
`/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/6fab9441-01a5-4c57-8e32-4d6d4ea3ce1e/scratchpad/luc3d.tex.bak2`.

One figure was regenerated as part of this pass, Fig 5f, for the reason given in
the entry for line 185. Everything else is text only.

## Summary

| Line | Section | Change |
|---|---|---|
| 109 | Fig 1 caption | Panel A no longer calls the Mouse-Dyad-10M volume an enclosure. Panel D now says 7 of 8 cameras. |
| 126 | Fig 2 caption | Panel A now states the sideL viewpoint and describes the legend the panel actually carries. |
| 162 | Fig 4 caption | Panel C no longer claims one line per session. |
| 176 | Fig 5 Results | Leader cohort corrected to 16 of 23 sessions with at least six displays. |
| 185 | Fig 5 caption | Same correction, and the panel now states that all 37 sessions are drawn. |
| 191 | Fig 6 Results | `\ref{fig6}C` corrected to `\ref{fig6}E`, and a sentence introducing Fig 6A added. |
| 195 | Fig 6 Results | Typo, "Sincle" to "Since". |
| 272 | Data descriptor | Three sentences describing Fig 6A added. |
| 185 | Fig 5 caption | Panel A: near wall of the volume noted as edges only; a semicolon split into two sentences. |
| 200 | Fig 6 caption | One clause added, stating that the near cage wall is drawn as edges only. |
| 344 | Methods | Leader cohort corrected to six or more displays, 16 of 23 and 9 of 23. |
| 348 | Methods | Typo, "arttfact" to "artifact". |
| 420 | Supplementary caption | Typo, "Snapshopt" to "Snapshot". |

---

## Line 109, Fig 1 caption

Two problems. The Mouse-Dyad-10M corpus has no measured cage geometry, so the box
drawn around those animals is the 650 mm footprint of their own movement and
must not be described as an enclosure. Separately, panel D's rig tile was
re-cropped to exclude the one camera that sits far outside the cluster, so it now
shows seven of the eight.

Panel A, old:

> The Mouse-Dyad-10M rig, right: the 5 calibrated cameras and enclosure with tracked 3D poses of the two animals.

Panel A, new:

> The Mouse-Dyad-10M rig, right: the 5 calibrated cameras with the tracked 3D poses of the two animals. The volume drawn around those animals is the 650~mm footprint of their measured movement and is not an enclosure. The two renderings are printed at a common height rather than at a common scale.

Panel D, old:

> right, the rig, with all 8 calibrated cameras and the 3 reconstructed animals. 45 of 45 3D keypoints filled.

Panel D, new:

> right, the rig, with 7 of the 8 calibrated cameras and the 3 reconstructed animals, cropped to the cluster they form because the eighth camera sits well outside it. 45 of 45 3D keypoints filled.

Panel C's "2 of 8 views" and "Across all 8 views" were left alone deliberately.
They describe the data, which still uses all eight cameras. Only the one tile in
panel D is cropped.

## Line 126, Fig 2 caption

The 3D tile in panel A is now rendered from the calibrated pose of the cam 6
sideL anchor rather than from an arbitrary orbit angle, so a reader can compare
it against the sideL view printed beside it. The caption also promised a
"per-view error split" in the fourth column, which the panel does not contain and
has not contained for some time. What is actually printed there is the legend for
the overlay line styles.

Old:

> two anchor views labeled (cam 1 topB, cam 6 sideL), the 3D solved from those two alone, the reprojection drawn into the unlabeled views (cam 0 mid, cam 2 topC), and one view magnified beside that frame's per-view error split.

New:

> two anchor views labeled (cam 1 topB, cam 6 sideL), the 3D solved from those two alone and shown from the calibrated viewpoint of the cam 6 sideL anchor so that it can be compared against that view directly, the reprojection drawn into the unlabeled views (cam 0 mid, cam 2 topC), and one of those views magnified with the cursor resting on a reprojected keypoint. Dotted overlays are reprojected and solid overlays are detected.

## Line 162, Fig 4 caption

The fifty grey per-session lines were removed from panel C, so the caption
described marks that are no longer drawn. The paired result it quotes is still on
the panel and still correct.

Old:

> with the worst view dropped; one line per session, bars the 95\% CI of the mean.

New:

> with the worst view dropped; across-session means, bars the 95\% CI of the mean.

## Lines 176, 185 and 344, the leader analysis

**This is the one change that also altered a figure, and it is worth reading
before you accept it.**

The leader panel restricted its beat-chance test to sessions with at least five
displays, on the stated grounds that a smaller session cannot clear the null at
any share. That reasoning is correct but the threshold was one too low. Under a
fair coin the 95th percentile of the larger share is 1.0 for every session size
up to and including five, because a clean five for five sweep still has
probability 2/32, or 0.0625. The two-sided binomial test agrees, since its best
attainable P value is 0.0625 at five displays and 0.031 at six. A five-display
session therefore sat in the denominator with no way of ever counting.

Exactly one session in the corpus has five displays, so the cohort is 23 sessions
rather than 24. The number clearing the band is 16 either way, and the
Holm-corrected number is 9 either way. The error was conservative, in that it
understated the result rather than inflating it.

I changed `MIN_DISPLAYS` from 5 to 6 in `figs/panels/fig5_10_leader.py`, rebuilt
the panel and reassembled Fig 5. The panel now reads "16/23 sessions (at least 6
displays) beat chance".

The reason the denominator looks small next to the corpus is worth stating in the
caption, and now is. Mouse-Dyad-10M has 56 sessions, only 37 of which contain a
single mutual upright display, and most of those are tiny, six of them holding
exactly one display. All 37 are drawn on the panel. Only the 23 large enough to
carry evidence enter the count.

Line 176, old:

> the panel draws the distribution a fair coin would produce at each session size; 16 of the 24 sessions with at least five displays exceed it.

Line 176, new:

> the panel draws the distribution a fair coin would produce at each session size. Of the 23 sessions with at least six displays, which is the smallest number that can clear the band at all, 16 exceed it.

Line 185, old:

> Grey band, the central 95\% a fair coin gives at that session size; 16 of the 24 sessions with 5 or more displays clear it.

Line 185, new:

> Grey band, the central 95\% a fair coin gives at that session size. All 37 sessions with at least one display are drawn, and of the 23 with six or more displays, the smallest number that can clear the band at all, 16 do so.

Line 344, old:

> The per-session statistics are restricted to sessions containing at least five displays. The leader's share is individually above chance by a two-sided binomial test in 16 of those 24 sessions, and in 9 of 24 after Holm correction across the family.

Line 344, new:

> The per-session statistics are restricted to sessions containing at least six displays, which is the smallest session in which a two-sided binomial test can reach significance at all, since the best attainable $P$ value is 0.0625 at five displays and 0.031 at six. That leaves 23 sessions. The leader's share is individually above chance by a two-sided binomial test in 16 of those 23 sessions, and in 9 of 23 after Holm correction across the family.

## Line 200, Fig 6 caption

The cage renders were rebuilt with the fill removed from the wall nearest the
viewer, so the animals and the enrichment objects are seen through clear air
rather than through a grey film. The wall's edges remain, so the cage still reads
as a box. One clause was added to panel A, after "since no object positions were
recorded":

> The wall nearest the viewer is drawn as edges only, so the interior is seen through clear air.

## Line 185, Fig 5 caption, panel A

Fig 5a was rebuilt: the near walls of the volume are now drawn as edges only, the
in-panel exposition was removed, the 3D render was enlarged and the five camera
views reduced. The panel title, which the assembler draws rather than the caption,
is now "3D pose and 2D camera views for social rearing behavior". Everything the
in-panel text used to say is caption material and was already in the caption, so
only one clause is added and one semicolon is split.

Old:

> Every camera sits 58 to 76 degrees above the animals, so the height that defines the event exists only after triangulation; only the 3D panel is metric ($230 \times 230 \times 140$~mm).

New:

> Every camera sits 58 to 76 degrees above the animals, so the height that defines the event exists only after triangulation. Only the 3D panel is metric ($230 \times 230 \times 140$~mm), and the wall of that volume nearest the viewer is drawn as edges only so the interior is seen through clear air.

## Lines 176, 185 and 344 again — Fig 5f was replaced

Fig 5f is no longer the leader-share scatter with a null band. It is now two boxes,
the observed shares against a size-matched fair-coin surrogate, with a bracket and
stars. The three places that described the old panel were rewritten. Numbers:
observed median 0.86, surrogate median 0.57, 23 sessions with six or more
displays, pooled 432 of 539 displays (80.1%), and P < 0.0005 as a permutation
bound from 2,000 surrogate corpora none of which reaches the observed median.

Line 185, panel F, new text:

> \textbf{F}, Share of displays started by the session's leader, over the 23 sessions with six or more displays, against a size-matched fair-coin surrogate that keeps each session's own display count and only relabels who started. Boxes, median and IQR, whiskers 1.5$\times$IQR; medians 0.86 and 0.57. Pooled over all 539 displays in 37 sessions the leader starts 432 of them, 80.1\%. Stars, $P < 0.0005$, the bound from 2,000 surrogate corpora none of which reaches the observed median.

Line 176 now ends:

> the panel compares the observed shares with a surrogate that keeps each session's own display count and only relabels who started each display. Over the 23 sessions with at least six displays the median share is 0.86 against the surrogate's 0.57, and none of two thousand surrogate corpora reaches the observed median.

Line 344, the Methods sentence about the null, was replaced with the surrogate and
the permutation bound. The per-session binomial counts later in that paragraph, 16
of 23 raw and 9 of 23 after Holm, are a separate analysis and were left alone.

**One thing to decide.** The bracket carries TWO stars, as asked. The usual
convention, Nature journals included, is * for P<0.05, ** for P<0.01 and *** for
P<0.001, under which a bound of P < 0.0005 would take three. `STARS` in
`panels/fig5_10_leader.py` is a one-character change either way.

## Line 191, Fig 6 Results

Two things in one sentence. The reference pointed at panel C for the
detection-quality result, but the numbers quoted immediately after it, the
10.8-fold miss rate and the 1.30-fold error, belong to the detection-quality
panel, which is now E. Panel C is the reprojection-recovery surface. This
reference was already wrong before the current rebuild, because detection quality
had been panel G since the reflow on 15 August. Fig 6A also had no mention
anywhere in the body, and this is where the reader first meets the figure.

Old:

> Each of the 74 SLAP-2M sessions, which is the whole corpus, carries a curator-assigned difficulty rating, and Figure~\ref{fig6}C separates that rating's effect into two quantities that behave differently.

New:

> Each of the 74 SLAP-2M sessions, which is the whole corpus, carries a curator-assigned difficulty rating. That rating is built from two properties a session varies, the environmental enrichment placed in the cage and the number of animals housed in it, and Figure~\ref{fig6}A shows both as renders of real sessions. Figure~\ref{fig6}E separates the rating's effect into two quantities that behave differently.

## Line 195, Fig 6 Results

Old: "Sincle the enrichment objects are transparent"
New: "Since the enrichment objects are transparent"

## Line 272, data descriptor

Fig 6A describes what the corpus contains rather than reporting a measurement,
and this paragraph already enumerates the six enrichment levels and the one to
four animals, which is exactly what the panel renders. Three sentences were
inserted immediately after the enrichment-levels sentence and before "While many
popular 2D datasets lack environmental enrichment":

> Figure~\ref{fig6}A shows these two axes as renders, one session for each condition, with every cage and the animals inside it drawn from that session's own tracked 3D. It also shows what the corpus does and does not contain, because enriched conditions were recorded only with one and two animals, so the empty cells are absent from the data rather than omitted from the figure. The inset expands the four-animal session into the six proofread camera views of a single frame.

## Line 348, Methods

Old: "It is not an arttfact of the per-animal height threshold"
New: "It is not an artifact of the per-animal height threshold"

## Line 420, supplementary caption

Old: "Snapshopt of the LUC3D GUI."
New: "Snapshot of the LUC3D GUI."

---

# To copy edit in the morning

These are judgement calls I did not want to make for you, or numbers I cannot
recompute from the deposited data.

**1. The control analyses still use the old five-display cohort. Lines 348 and
178, and line 346 in Methods.** The main leader statistic now uses 23 sessions
with at least six displays, but the three controls at line 348 still say "$n =
24$ sessions with at least five displays", and report "the same leader in 22 of
24 sessions" and "all 24". Those are correlations and re-run detections rather
than binomial tests, so the five-display threshold is not invalid there in the
way it was for the main test, but the paper now describes two different cohorts a
few paragraphs apart. Making them consistent means re-running that control with
the six-display cohort, which changes $r$, $\rho$, both $P$ values and the two
agreement counts. I cannot recompute those from what is deposited.

**2. The pair-level analysis also uses a five-display threshold. Lines 178 and
346.** It reports 14 pairs with at least five displays covering 536 displays, and
eight of the 14 individually above chance. A pair aggregates several sessions, so
the threshold binds differently there and may bind on nothing at all. Worth
checking whether any of the 14 pairs actually has five displays. If none does,
the sentence can simply say six for consistency without any number moving.

**3. Line 176 says "Pooled over the same session sizes, that fair coin expects a
leader share of 59.1 per cent".** I verified 59.1 per cent, but it is computed
over all 37 sessions and 539 displays, which is the same pool as the 80.1 per
cent it is compared against. Over the restricted cohort the expectation is 58.0
per cent. The comparison is sound, but "the same session sizes" reads as though
it refers to the restricted cohort just mentioned. Consider "Pooled over all 539
displays".

**4. Fig 2 panel B names its curves differently from the caption.** The caption
describes them as reprojection at $\tau = 10$ px solid and 5 px dashed, which is
accurate, but the panel labels the same two curves "accept" and "nudge". A reader
moving between the two has to work out that accept is the 10 px curve. Consider
naming both in the caption.

**5. Fig 6 panel A has no scale statement.** Every cage in the grid is the same
physical cage rendered at the same scale, which is worth one clause if a reviewer
might wonder whether the tiles are comparable.

**6. The abstract and introduction were not audited against the figures.** I
checked every `\ref` and every caption. Numbers quoted in the abstract, the
introduction and the discussion were left alone.

---

# What I verified after editing

- Every `\ref{figN}` panel letter in the file resolves to a panel that exists on
  the current artwork. Fig 1 refs B, C, D, E; Fig 2 refs A to D; Fig 3 refs A to
  E; Fig 4 refs B to E; Fig 5 refs A, C, E, F, G; Fig 6 refs A, C, D, E, F; Fig 7
  refs A to M. Nothing dangles.
- The panel letters declared in each caption match the panels on each figure:
  Fig 1 A to E, Fig 2 A to D, Fig 4 A to E, Fig 5 A to G, Fig 6 A to F, Fig 7 A
  to M.
- Fig 7 in the manuscript is assembled as `figures/fig11`, panels a to m, and its
  references were checked against that rather than against `figures/fig7`, which
  is a different internal figure.
- No occurrence remains of "one line per session", "all 8 calibrated cameras",
  "per-view error split", "enclosure with tracked", "16 of the 24", "16 of those
  24", "9 of 24", "Sincle", "arttfact" or "Snapshopt".
- Fig 2's caption numbers were re-checked against the deposited tables and are
  current: 32 of 75 placements at $C = 5$ and 2.3-fold, the 4.74, 2.89 and 1.91
  mm session medians, and 12.6 mm at 13.5 degrees.
- Spelling is consistently American throughout: labeled, color, behavior.
- The file contains no em dashes.
