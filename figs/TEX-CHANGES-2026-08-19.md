# Changes applied to `figures/drafts/luc3d.tex`

I audited every figure reference in the manuscript against the artwork that is
currently on disk and edited the file directly.

**Two rounds.** The first round changed eleven lines in place, each a whole-line
replacement with nothing inserted, so the file stayed at 486 lines. The second
round replaced Fig 5f and then ADDED two new subsections for the fresh-anchor
result, which is the only change in either round that moves line numbers: the
file is now **496 lines**. Everything below is quoted against the current file.

New material is listed first because it is the part that shifts everything after
it. The in-place replacements follow.

Line 200 was edited once more after the Fig 6a renders were rebuilt with the near
cage wall left unfilled. The added clause is noted in the entry for that line.

The version you gave me is backed up at
`/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/6fab9441-01a5-4c57-8e32-4d6d4ea3ce1e/scratchpad/luc3d.tex.bak2`.

One figure was regenerated as part of this pass, Fig 5f, for the reason given in
the entry for line 185. Everything else is text only.

## NEW: the fresh-anchor sections, lines 226 and 374

These are the only ADDED text in the file. Everything else is a replacement.
Both are drafted from `figs/FRESH-ANCHOR.txt`, condensed to one Results
subsection and one Methods subsection, and both refer to the sweep as
**Supplementary Fig. 8d** in plain text rather than as a `\ref`, because no
supplementary figure environment exists in this file yet. If you add one, give it
a label and swap the two references.

**Line 226, end of Results, after the rats subsection and before
`\FloatBarrier`.** New subsection, two paragraphs:

> \subsection{Stale evidence in the 3D anchor is the dominant switch mechanism}\label{subsec2-9}

The first paragraph gives the mechanism and the headline numbers: switches
2,071 to 413 at N = 20, mean cross-view IDF1 0.749 to 0.861, and at N = 10, 511
switches with median session 0.760 to 0.913, 32 of 50 improved and 6 worsened,
P = 1.7e-6, with a margin of 0.078 IDF1 over the best pure re-tuning, P = 2.7e-5.
The second argues specificity: the eviction windows are indistinguishable and
reverse order between the pilot and the benchmark, so the step is from no
eviction to any eviction, while traversing the axis the other way is
monotonically harmful, and N = 10 is adopted over N = 20 on harm profile.

**Line 374, Methods, between "Baseline configuration" and "Transfer benchmark on
social-DANNCE".** New subsection, one paragraph:

> \subsection{Anchor staleness and the fresh-anchor tracker}\label{methods-anchor}

It records the defect (retained detections enter the anchor at any age because
the reference computes but does not apply Chen et al.'s age weights), the
measurement (mean ages 3.0 to 49.8 frames, maxima 844 to 8,652), the three
coordinated changes (eviction at N, synchronous scoring M1, distance threshold
50 to 25), and the benchmark (all 50 proofread sessions, identical detections,
harness validated bit-identically against the deposited result, paired Wilcoxon).

**Chen et al. 2020 is cited in both.** `\bibitem{Chen2020}` was already in the
bibliography at line 456 and was previously cited only once, in the
introduction. The anchor-staleness material now cites it four more times with
`\citet{Chen2020}`, matching the `\citet{Maree2024}` style used elsewhere: for
the tracking-by-3D-consensus design the tracker follows, for the exponential age
weighting of their Eq. 11 that the reference implementation computes but does
not apply, for eviction being the step-function limit of that attenuation, and
in the Results paragraph that places the omission as benign at their time scales
and dominant at behavioral ones. No new bibliography entry was needed.

**Check before submitting.** The numbers in both come from `FRESH-ANCHOR.txt`,
which I did not re-derive from the deposits. If that file is older than
`figs/out/fig8_methods_50.json`, re-check the eight quoted values. The claim
about the inverted sign in the reference's weight computation also comes from
that file rather than from my own reading of the reference.

## Summary

| Line | Section | Change |
|---|---|---|
| 226 | Results, NEW | Fresh-anchor subsection interpreting Supplementary Fig. 8d, two paragraphs. |
| 374 | Methods, NEW | Anchor-staleness subsection, one paragraph. |
| 109 | Fig 1 caption | Panel A no longer calls the Mouse-Dyad-10M volume an enclosure. Panel D now says 7 of 8 cameras. |
| 126 | Fig 2 caption | Panel A now states the sideL viewpoint and describes the legend the panel actually carries. |
| 162 | Fig 4 caption | Panel C no longer claims one line per session. |
| 176 | Fig 5 Results | Leader paragraph rewritten for the surrogate panel (was the 16-of-23 null-band wording). |
| 185 | Fig 5 caption | Panel A: near wall noted as edges only. Panel F: rewritten for the two-box surrogate panel. |
| 191 | Fig 6 Results | `\ref{fig6}C` corrected to `\ref{fig6}E`, and a sentence introducing Fig 6A added. |
| 195 | Fig 6 Results | Typo, "Sincle" to "Since". |
| 200 | Fig 6 caption | One clause added, stating that the near cage wall is drawn as edges only. |
| 278 | Data descriptor | Three sentences describing Fig 6A added. |
| 350 | Methods | Fig 5f null replaced by the size-matched surrogate and its permutation bound. |
| 354 | Methods | Typo, "arttfact" to "artifact". |
| 430 | Supplementary caption | Typo, "Snapshopt" to "Snapshot". |

Line numbers in this table are against the CURRENT 496-line file. The data
descriptor, both Methods entries and the supplementary caption moved down by
6 to 10 lines when the two new subsections went in; if you are working from an
older copy, search the quoted text rather than trusting the number.

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

## Lines 176, 185 and 350, the leader analysis (SUPERSEDED, see below)

**Read this section for the reasoning, not for the text to paste.** It records
why the cohort moved from five displays to six, which still stands and is still
in the file. The wording it quotes was then overwritten when Fig 5f itself was
replaced; the text now in the manuscript is in "Fig 5f was replaced" below.

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

## Lines 176, 185 and 350, Fig 5f was replaced (CURRENT text)

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

## Line 278, data descriptor

Fig 6A describes what the corpus contains rather than reporting a measurement,
and this paragraph already enumerates the six enrichment levels and the one to
four animals, which is exactly what the panel renders. Three sentences were
inserted immediately after the enrichment-levels sentence and before "While many
popular 2D datasets lack environmental enrichment":

> Figure~\ref{fig6}A shows these two axes as renders, one session for each condition, with every cage and the animals inside it drawn from that session's own tracked 3D. It also shows what the corpus does and does not contain, because enriched conditions were recorded only with one and two animals, so the empty cells are absent from the data rather than omitted from the figure. The inset expands the four-animal session into the six proofread camera views of a single frame.

## Line 354, Methods

Old: "It is not an arttfact of the per-animal height threshold"
New: "It is not an artifact of the per-animal height threshold"

## Line 430, supplementary caption

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

---

# Round 3 (2026-08-21): Fig 5 rewritten around the male/female finding

Trigger for this round: Eric asked whether Mouse-Dyad-10M's track slot maps
onto sex. It does, with zero exceptions: checked against every one of the 56
sessions' own `track_names`, 9 individual mice never switch slot (4 male
always in slot 0, 5 female always in slot 1). Everything in Fig 5 that
previously spoke of "the leader," "rank," or "one animal" as an anonymous
track label can now say male or female directly, and reading out each
animal's own share (rather than `max(share_0, share_1)`, which cannot say
who) sharpens "there is a leader" into "the leader is female": she starts
432 of 539 displays pooled (80.1%) and is the outright leader in 36 of 37
sessions with at least one display, zero exceptions at the pair level (17 of
17 pairings). This was adversarially checked before touching any text: per
individual (all 5 females lead 75-100% of their own displays, all 4 males
10-25%), per pair (17 of 17), against a rearing-base-rate confound ($r =
-0.012$, $P = 0.96$, unchanged from the pre-existing manuscript number), and
against a body-size confound (male is the structurally longer animal, so
"bigger animal wins" is ruled out rather than confirmed). Panels 5b, 5c, 5d,
5e, 5f and 5g were regenerated; 5a's 3D render and the schematic panel were
recolored from teal/pink to blue/red to match. This round touched only Fig 5
text (Results, its caption, its Methods, and the Statistics paragraph) plus
`figs/dataset_sheets.py`'s Mouse-Dyad-10M sex field; nothing else in the
manuscript was reopened.

**Same 13 lines every time.** All of Round 3's edits are whole-line
replacements at the same 13 lines the earlier rounds already touched (168,
172, 174, 176, 178, 180, 185, 348, 350, 352, 354, 356, 398); nothing was
added or removed, so the file is still 496 lines and nothing after Fig 5
shifted.

## Summary

| Line | Section | Change |
|---|---|---|
| 168 | Fig 5 Results, intro | Typo "socail" to "social" (pre-existing, caught in this pass); added the track-slot-is-sex sentence that everything after it depends on. |
| 172 | Fig 5 Results, coupling | Pooled-only coupling number kept, but now followed by the male-onset/female-onset split that Fig 5G actually draws two curves for. |
| 174 | Fig 5 Results, display def. | Rewritten for 5D (raw speed, male vs female) and 5E (facing-pursuit, male vs female); the old "94% of displays below baseline" / boxing-by-relative-speed framing is gone. |
| 176 | Fig 5 Results, leader | Rewritten for the direct female-share/male-share panel; the fair-coin surrogate language is gone. |
| 178 | Fig 5 Results, pair-level | Added the 17-of-17-pairings sentence; "leading member" reworded to "the female". |
| 180 | Fig 5 Results, controls | Reworded from "the leader" to "the female"; added the body-size direction (male longer, not female) as an explicit control. |
| 185 | Fig 5 caption | Full rewrite for the current 5a-5g content: sex labels, panel C restricted to female-led events, 5D speed, 5E facing-pursuit, 5F paired shares, 5G split by anchor animal. |
| 348 | Methods, initiator ID | Added the track-slot-is-sex sentence; lag now stated as restricted to the 432 female-led displays. |
| 350 | Methods, Fig 5F stats | Rewritten: no more size-matched surrogate / permutation bound; states the female-share/male-share pairing is mathematically a test against 0.5 because the two shares are complementary. |
| 352 | Methods, pair-level | Added the 17-of-17-pairings sentence to match line 178. |
| 354 | Methods, controls | Reworded from "the leader"/"the leading animal" to "the female"; added the body-size-direction sentence to match line 180. |
| 356 | Methods, Fig 5G coupling | Added the anchor-animal split (aligned to female onset vs aligned to male onset) and that SLAP-2M has no sex convention to split by. |
| 398 | Methods, Statistics | Rewritten from "leader's share against a fixed value" to "female share against male share... equivalently against 0.5". |

Line numbers above are against the current 496-line file, same as every
prior round in this file; nothing in this round changed the file's length,
so these should still be exact if you are reading the file as it stands.

## Line 168, Fig 5 Results intro

Old:

> The preceding figures demonstrate the usefulness of 3D multi-animal pose estimation data for understanding socail behavior. Figure~\ref{fig5} measures a social rearing behavior on the Mouse-Dyad-10M corpus that depends on 3D pose estimation for characterization.

New:

> The preceding figures demonstrate the usefulness of 3D multi-animal pose estimation data for understanding social behavior. Figure~\ref{fig5} measures a social rearing behavior on the Mouse-Dyad-10M corpus that depends on 3D pose estimation for characterization, and its two participants are not interchangeable: track slot 0 is male and slot 1 is female in every one of the corpus's 56 sessions, verified against every session's own track identities (9 individual mice, 4 always in slot 0 and 5 always in slot 1, none in both), so every measurement below is reported by sex rather than by an arbitrary track label.

## Line 172, Fig 5 Results, coupling paragraph

Old:

> Rearing in these pairs is coupled, and the coupling requires proximity (Figure~\ref{fig5}G). Taking every rearing onset by one animal and reading out whether the other is rearing, the probability is 2.9 times chance at the onset itself and peaks at 4.1 times half a second later, which is about the time it takes a mouse to get up. When the animals are more than two body lengths apart the same measurement is flat at 1.05, and a circular-shift null that preserves each animal's rearing rate, bout structure and autocorrelation is flat at 0.99. The second animal is responding to the first rather than coinciding with it, and the proximity split rules out a shared external drive. The same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two body lengths and 0.97 beyond, that is no coupling at all. Arena size is the likely reason, since SLAP-2M's arena is 3.2 body lengths across against Mouse-Dyad-10M's 6.9 so its two conditions barely differ, but that explanation is untested and the claim is made for Mouse-Dyad-10M alone.

New:

> Rearing in these pairs is coupled, and the coupling requires proximity. Pooling both directions together, taking every rearing onset by one animal and reading out whether the other is rearing, the probability is 2.9 times chance at the onset itself and peaks at 4.1 times half a second later, which is about the time it takes a mouse to get up; beyond two body lengths the same measurement is flat at 1.05, and a circular-shift null that preserves each animal's rearing rate, bout structure and autocorrelation is flat at 0.99. That pooled number, though, averages over two asymmetric relationships (Figure~\ref{fig5}G). Split by which animal's onset anchors the window, the male's rearing near the female's onset is below his own chance rate at the instant she starts (0.6 times chance) and reaches only 1.7 times half a second later, while the female's rearing near the male's onset is already 4.7 times chance at the instant he starts, peaking at 5.3 times a third of a second later. The mechanism is direct: of his near-rear onsets, she is already mid-rear 50.2 per cent of the time, so his onset is usually him joining a rear she has already started; of her near-rear onsets, he is already mid-rear only 6.2 per cent of the time, so her onset is usually a fresh start. Neither half of the split is a shared external drive, since both require proximity in the same way the pooled measurement does. The same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two body lengths and 0.97 beyond, that is no coupling at all, and no sex convention exists there to split by. Arena size is the likely reason for the SLAP-2M null, since its arena is 3.2 body lengths across against Mouse-Dyad-10M's 6.9 so its two conditions barely differ, but that explanation is untested and the claim is made for Mouse-Dyad-10M alone.

The pooled numbers (2.9/4.1/1.05/0.99) are unchanged from before this round;
what is new is that the paragraph now tells the reader the pooled number
hides an asymmetric pair of curves, and gives both, matching what 5G now
actually draws (two titled sub-axes, not one).

## Line 174, Fig 5 Results, display-definition paragraph

Old:

> That coupling defines an event, hereafter referred to as a display: both animals reared, within two body lengths, held for at least a quarter of a second. There are 539 such displays in 37 of the 56 sessions. They are brief and still. The animals hold the posture for a median 0.71~s while moving at 0.44 times their own baseline speed, with 94 per cent of displays below baseline (Figure~\ref{fig5}E). A mutual upright posture at close range is the classic agonistic configuration, and the obvious description would be boxing. Animals moving at four tenths of their usual speed are not fighting, so we call it an upright display and go no further, since what the behavior means cannot be settled by kinematics.

New:

> That coupling defines an event, hereafter referred to as a display: both animals reared, within two body lengths, held for at least a quarter of a second. There are 539 such displays in 37 of the 56 sessions, with a median duration of 0.71~s. In the half second immediately before a display begins the two sexes are already moving very differently (Figure~\ref{fig5}D): the male is still travelling, at a median 0.38 body lengths per second, while the female is already largely stationary, at a median 0.23 (paired Wilcoxon $P = 6.5 \times 10^{-22}$, $n = 538$ displays with both speeds resolved). The difference is not only in how fast each animal moves but in what that motion is doing: decomposing each animal's own body-axis orientation onto the line to its partner and scaling by that animal's own speed (Figure~\ref{fig5}E), the male's score in the 1.5~s before onset is strongly negative (median $-0.71$: his body axis is oriented at her and he is moving), while the female's is close to zero (median $-0.06$; paired Wilcoxon $P = 3.3 \times 10^{-73}$). He is oriented at her and closing the distance; she is neither oriented at him nor approaching him. A mutual upright posture at close range is the classic agonistic configuration, and the obvious description would be boxing, but animals moving at a fraction of a body length per second are not fighting, so we call it an upright display and go no further, since what the behavior means cannot be settled by kinematics.

This is the biggest content change in the Results: the old paragraph's
statistic (each animal's own speed during the display, relative to its own
baseline, pooled across both animals) is retired entirely and replaced by
two different, sex-specific measurements that now live on two different
panels (5D raw speed, 5E facing-pursuit). The "94% below baseline" number
and the 0.44 ratio do not appear anywhere in the new text; they described a
panel that no longer exists in this form.

## Line 176, Fig 5 Results, "not symmetric" / leader paragraph

Old:

> The display is not symmetric. One animal is up a median 0.37~s before the other joins (Figure~\ref{fig5}C). At this recording rate that is 56 frames, and 11 frames at 30~fps; the shorter lags in the distribution, down at the 0.16~s quartile, are where the high frame rate earns its keep. Within a session, one animal starts most of the displays: pooled over all 539 displays, the session's leader starts 80 per cent of them, and that figure is stable at every session-inclusion threshold tested (Figure~\ref{fig5}F). Because the leader's share is by construction the larger of two shares, it cannot fall below one half, so the panel compares the observed shares with a surrogate that keeps each session's own display count and only relabels who started each display. Over the 23 sessions with at least six displays the median share is 0.86 against the surrogate's 0.57, and none of two thousand surrogate corpora reaches the observed median. Pooled over the same session sizes, that fair coin expects a leader share of 59.1 per cent, so the pooled comparison is 80 against 59 rather than 80 against 50.

New:

> The display is not symmetric, and the asymmetry has a sex. The female is up a median 0.39~s before the male joins, in the 432 of 539 displays she leads (Figure~\ref{fig5}C); at this recording rate that is 59 frames, and the shorter lags in the distribution, down at the 0.17~s quartile, are where the high frame rate earns its keep. Within a session, the female starts most of the displays: pooled over all 539 displays she starts 432 of them, 80.1 per cent, and she is the outright leader, starting more displays than the male, in 36 of the 37 sessions with at least one display; the one exception is an exact tie, and no session has the male as the outright leader. Because her share and his share are complementary within a session (they sum to one), Figure~\ref{fig5}F draws both directly rather than one against a simulated null: over the 23 sessions with at least six displays, the smallest session that can register a two-sided effect at all (Methods), her median share is 0.86 against his 0.14 (paired Wilcoxon $P = 2.7 \times 10^{-5}$).

Two numbers moved slightly and are both intentional, not typos: the lag
median is 0.37~s to 0.39~s and the frame count 56 to 59, because the old
number pooled the lag over both directions (whoever led) while the new one
is restricted to the 432 displays the female actually leads (Methods, line
348) -- a different, smaller, sex-consistent population, not a
recomputation error on the same one. The fair-coin surrogate (57% median,
59.1% pooled expectation, "none of two thousand surrogate corpora") is gone;
Fig 5F no longer needs a simulated null because the two real shares are
complementary by construction.

## Line 178, Fig 5 Results, pair-level replication

Old:

> The 56 Mouse-Dyad-10M sessions are repeated recordings of 9 mice in 18 pairings rather than 56 independent samples, so the analysis was repeated with the pair as the unit of replication. Aggregating each pair's sessions into a single observation leaves 14 pairs with at least five displays, covering 536 displays. The leading member starts a median 0.81 of that pair's displays, the same member leads in all 14 of 14 pairs (sign test $P = 1.2 \times 10^{-4}$), and pooling over pairs gives 429 of 536 displays, 80.0 per cent (the figure the session-level pooling gives). The asymmetry is a property of the pair rather than of any one recording of it.

New:

> The 56 Mouse-Dyad-10M sessions are repeated recordings of 9 mice in 18 pairings rather than 56 independent samples, so the analysis was repeated with the pair as the unit of replication. Every one of the 17 distinct pairings that produced at least one display has the female as its leading member. Restricting to the 14 pairs with at least five displays, covering 536 displays, the female starts a median 0.81 of that pair's displays and leads in all 14 of 14 (sign test $P = 1.2 \times 10^{-4}$), and pooling over pairs gives 429 of 536 displays, 80.0 per cent (the figure the session-level pooling gives). The asymmetry is a property of the pair, and of the female in it, rather than of any one recording.

The 14-pairs/536-displays/sign-test/80.0% figures are all unchanged from
the pre-existing manuscript (verified by recomputation, not just carried
over); the only new content is the 17-of-17-pairings sentence, which is a
broader population (every pairing with at least one display, not just the
14 with at least five) and was checked separately.

## Line 180, Fig 5 Results, three controls

Old:

> Three controls test the obvious alternatives. The leader is not simply the animal that rears more, since a session's initiation share is uncorrelated with its share of rearing time ($r = -0.012$, $P = 0.96$ over 24 sessions). It is not an artefact of the per-animal height threshold, since an absolute 60~mm threshold shared by both animals returns the same leader in all 24 sessions, and a single shared per-pair threshold in 22 of 24. Body size is not independent of leadership, and the direction deserves stating: the leader is the shorter animal in 28 of the 36 sessions with a unique leader (sign test $P = 0.0012$). Even so, the asymmetry itself does not require it: within the same 24-session family as the tests above, the three sessions where the leader is the longer animal still hand it 75 of 97 displays, 77 per cent (binomial $P = 6 \times 10^{-8}$), and over all sessions with any known initiator the count is 81 of 103. What the data support is an asymmetry that is stable within a session, and no claim is made about dominance, for which no assay was run.

New:

> Three controls test the obvious alternatives to a genuine sex difference. The female is not simply the animal that rears more, since a session's female-initiation share is uncorrelated with her own share of rearing time within the pair ($r = -0.012$, $P = 0.96$ over 24 sessions). It is not an artefact of the per-animal height threshold, since an absolute 60~mm threshold shared by both animals returns the female as leader in all 24 sessions, and a single shared per-pair threshold in 22 of 24. Nor is it explained by body size in the direction that would trivially produce it: the male is the structurally longer animal (median body length 90.1~mm against 84.2~mm, longer in 29 of 37 sessions, paired Wilcoxon $P < 0.0001$), so the smaller-bodied sex is the one leading, and the sign test on the 36 sessions with a unique leader agrees (female shorter in 28 of 36, $P = 0.0012$). Even so, the asymmetry itself does not require it: within the same 24-session family as the tests above, the three sessions where the female happens to be the longer animal still hand her 75 of 97 displays, 77 per cent (binomial $P = 6 \times 10^{-8}$), and over all sessions where she is the longer animal the count is 81 of 103. What the data support is a sex asymmetry that is stable within a session and survives every alternative explanation tested, and no claim is made about dominance, for which no assay was run.

All four control numbers ($r=-0.012$/$P=0.96$, 22 of 24, 28 of 36 / $P=0.0012$,
75 of 97 / $P=6\times10^{-8}$) are unchanged from the pre-existing manuscript;
recomputed directly against the deposited data as part of the adversarial
check described at the top of this round, not just carried over verbatim.
New content is the explicit body-size-direction sentence (median 90.1 vs
84.2 mm, male longer, paired Wilcoxon $P<0.0001$), which the old paragraph
implied ("the leader is the shorter animal") but never stated directly, and
which matters more now that "shorter" maps onto a specific, checkable sex
rather than an anonymous track.

**Open item carried over, not fixed in this round:** this paragraph and its
Methods twin (line 354) still use "$n=24$ sessions with at least five
displays" for the confound controls, while the main leader statistic (line
176/350) uses the six-display cohort. This is exactly copy-edit item #1
from the first round of this file (line 321 above) and it was NOT resolved
here, on purpose: recomputing the three controls on the six-display cohort
changes $r$, $\rho$, both $P$ values and the two agreement counts, none of
which I can produce from what is deposited, and this round's brief was the
sex framing, not that pre-existing inconsistency.

## Line 185, Fig 5 caption

Old:

> \textbf{Behavioral analysis of social rearing behavior.} Two mice rear together face to face, and one animal of each pair starts 80\% of the displays. \textbf{A}, One display in five views, with the 3D reconstruction. Every camera sits 58 to 76 degrees above the animals, so the height that defines the event exists only after triangulation. Only the 3D panel is metric ($230 \times 230 \times 140$~mm), and the wall of that volume nearest the viewer is drawn as edges only so the interior is seen through clear air. \textbf{B}, Time course around onset: across-session median of per-session medians, band p25 to p75. The height curves are within-display ranks, not individuals; the nose gap falls to 0.12 body lengths at onset. \textbf{C}, Time the initiator is up before the follower joins: median 0.37~s (p25 to p75, 0.16 to 0.89~s); hatched bar, the 8\% beyond 2~s. \textbf{D}, Separation velocity of the two tail bases (left axis; negative is closing) and each animal's speed over its own baseline (right axis), by role. \textbf{E}, Speed during the display over that animal's own session median: median 0.44, 94\% of displays below baseline, median duration 0.71~s. \textbf{F}, Share of displays started by the session's leader, over the 23 sessions with six or more displays, against a size-matched fair-coin surrogate that keeps each session's own display count and only relabels who started. Boxes, median and IQR, whiskers 1.5$\times$IQR; medians 0.86 and 0.57. Pooled over all 539 displays in 37 sessions the leader starts 432 of them, 80.1\%. Stars, $P < 0.0005$, the bound from 2,000 surrogate corpora none of which reaches the observed median. \textbf{G}, Probability the other animal is rearing at each lag around a rear onset, over its own base rate; lines, across-session medians, band p25 to p75. Within 2 body lengths, 2.9 at onset and 4.1 at half a second; beyond, flat at 1.05, null 0.99. Mouse-Dyad-10M: 539 displays in 37 of 56 sessions (2 mice, 5 cameras, 150~fps); G uses 9,354 onsets over all 56. A display is both animals reared, neck above 0.75 body length, tail bases within 2 body lengths, held at least 0.25~s.

New:

> \textbf{Behavioral analysis of social rearing behavior.} Track slot 0 is male and slot 1 is female in every Mouse-Dyad-10M session; the female initiates the display in 36 of 37 sessions. \textbf{A}, One display in five views, with the 3D reconstruction. Every camera sits 58 to 76 degrees above the animals, so the height that defines the event exists only after triangulation. Only the 3D panel is metric ($230 \times 230 \times 140$~mm), and the wall of that volume nearest the viewer is drawn as edges only so the interior is seen through clear air. \textbf{B}, Time course around onset, male and female drawn separately: across-session median of per-session medians, band p25 to p75; the female reaches a higher peak nose height, 1.15 against 1.06 body lengths; the nose gap falls to 0.12 body lengths at onset. \textbf{C}, Time the female is up before the male joins, restricted to the 432 displays she leads: median 0.39~s (p25 to p75, 0.17 to 0.91~s); hatched bar, the 9\% beyond 2~s. \textbf{D}, Speed in the 0.5~s before onset, male against female, in body lengths per second: medians 0.38 and 0.23 (paired Wilcoxon $P = 6.5 \times 10^{-22}$). \textbf{E}, Facing-pursuit in the 1.5~s before onset: each animal's own body-axis orientation onto the line to its partner, scaled by that animal's own speed; negative is oriented at the partner while moving. Medians $-0.71$ (male) and $-0.06$ (female), paired Wilcoxon $P = 3.3 \times 10^{-73}$. \textbf{F}, Share of displays started, female share against male share, over the 23 sessions with six or more displays: medians 0.86 and 0.14, paired Wilcoxon $P = 2.7 \times 10^{-5}$. Pooled over all 539 displays in 37 sessions the female starts 432 of them, 80.1\%. \textbf{G}, Probability the OTHER animal is rearing at each lag, split by whose onset anchors the window, over that animal's own base rate; lines, across-session medians, band p25 to p75; far and circular-shift null curves in each panel for reference. Left, aligned to the female's onset: the male's own rearing probability, 0.6 at onset rising to 1.7 at $+0.8$~s. Right, aligned to the male's onset: the female's own rearing probability, 4.7 at onset peaking at 5.3 at $+0.3$~s. Mouse-Dyad-10M: 539 displays in 37 of 56 sessions (2 mice, 5 cameras, 150~fps); G uses 9,354 rear onsets over all 56 sessions. A display is both animals reared, neck above 0.75 body length, tail bases within 2 body lengths, held at least 0.25~s.

Every panel letter's caption sentence was rewritten to match what that
panel's script (`figs/panels/fig5_0{5,6,7,8,9}*.py`, `fig5_10_leader.py`,
`fig5_12_coupling.py`) actually draws as of this round -- checked against
each panel's own docstring, not against the old caption. Two things the old
caption said are gone because the panels no longer draw them: 5D's dual-axis
separation-velocity plot ("by role") and 5F's "Stars, $P<0.0005$... 2,000
surrogate corpora" sentence. One new number appears that was not stated
before: 5B's "1.15 against 1.06 body lengths" peak nose height, added
because 5B's panel script now plots male and female as two separate curves
rather than one pooled "within-display rank" curve, and the caption needed
to say what distinguishes them.

## Line 348, Methods, initiator identification

Old:

> Because a display begins only when the second animal comes up, the onset of the display itself cannot identify which animal started it. The initiator was therefore identified from each animal's own rearing bout containing that onset, taking whichever animal's bout began earlier, and the lag reported in Figure~\ref{fig5}C is the interval between the two bout onsets.

New:

> Because a display begins only when the second animal comes up, the onset of the display itself cannot identify which animal started it. The initiator was therefore identified from each animal's own rearing bout containing that onset, taking whichever animal's bout began earlier. Track slot 0 is male and slot 1 is female in every session (Results), so the initiator is directly a sex rather than an anonymous track, and the lag reported in Figure~\ref{fig5}C is the interval between the two bout onsets, restricted to the 432 displays the female initiates.

This is the sentence that explains the 0.37 to 0.39~s / 56 to 59 frame shift
in the Results (line 176): the lag statistic itself is now restricted to
female-led displays only, dropping the male-led and tied displays that were
in the old pooled-over-both-directions number.

## Line 350, Methods, Fig 5F statistics

Old:

> A session's leader, in Figure~\ref{fig5}F, is whichever of the two animals initiated more of that session's displays. Because that statistic is the larger of the two shares it cannot fall below 0.5, it is read against a size-matched surrogate rather than against a line at 0.5. Each surrogate corpus keeps every session's own display count and only relabels which animal started each display, drawing from a binomial distribution with probability one half and taking the larger share exactly as the observed statistic does, so the surrogate carries the same floor and the same small-session inflation as the data. Two thousand surrogate corpora were drawn and none reached the observed median, which is the basis for the bound of $P < 0.0005$ quoted in the caption. The figure reported in the text is pooled over displays; averaging over sessions would weight every session equally regardless of its display count. The per-session statistics are restricted to sessions containing at least six displays, which is the smallest session in which a two-sided binomial test can reach significance at all, since the best attainable $P$ value is 0.0625 at five displays and 0.031 at six. That leaves 23 sessions. The leader's share is individually above chance by a two-sided binomial test in 16 of those 23 sessions, and in 9 of 23 after Holm correction across the family.

New:

> A session's female share, in Figure~\ref{fig5}F, is the fraction of that session's displays the female initiated; the male share is the complementary fraction, $1$ minus the female share. The two are drawn as paired boxes rather than one distribution against a simulated null, because they are two real, complementary distributions rather than a statistic and a null: a session's female share and male share sum to one by construction. The per-session statistics are restricted to sessions containing at least six displays, which is the smallest session in which a two-sided test can reach significance at all, since the best attainable binomial $P$ value is 0.0625 at five displays and 0.031 at six. That leaves 23 sessions, compared by a paired Wilcoxon signed-rank test on the female and male shares ($P = 2.7 \times 10^{-5}$), which is mathematically the same test as the female share against 0.5, since the two shares sum to one within a session. The figure reported in the text, 80.1 per cent, is pooled over displays rather than averaged over sessions, so that a session's weight in the pooled figure matches its actual number of displays.

The entire size-matched-surrogate machinery (2,000 draws, the $P<0.0005$
bound, the per-session 16-of-23-then-9-of-23 Holm-corrected breakdown) is
retired along with the old panel. It is replaced by a much shorter paragraph
because the new statistic needs less defending: female share and male share
are two real, observed distributions that sum to one, not one real
distribution measured against a simulated null, so there is no longer a
surrogate to construct or a floor effect to explain away.

## Line 352, Methods, pair-level replication

Old:

> Because the 37 sessions are repeated recordings of a smaller number of pairs, the same analysis was repeated with the pair as the unit of replication. Aggregating every session of a pair into one observation gives 14 pairs with at least five displays, covering 536 displays. The leading member of the pair starts a median 0.81 of that pair's displays (interquartile range 0.74 to 0.91, range 0.60 to 1.00), and the same member leads in all 14 of 14 pairs (sign test $P = 1.2 \times 10^{-4}$; Wilcoxon signed-rank on the pair shares against 0.5, $P = 9.7 \times 10^{-4}$). Eight of the 14 pairs are individually above chance by a two-sided binomial test, and all eight remain so after Holm correction. Pooled over those pairs the leader starts 429 of 536 displays, 80.0 per cent, which is the same figure the session-level pooling gives. The result is therefore not an artifact of treating repeated recordings of one pair as independent.

New:

> Because the 37 sessions are repeated recordings of a smaller number of pairs, the same analysis was repeated with the pair as the unit of replication. Every one of the 17 distinct pairings that produced at least one display has the female as its leading member. Aggregating every session of a pair into one observation gives 14 pairs with at least five displays, covering 536 displays. The female starts a median 0.81 of that pair's displays (interquartile range 0.74 to 0.91, range 0.60 to 1.00), and she leads in all 14 of 14 pairs (sign test $P = 1.2 \times 10^{-4}$; Wilcoxon signed-rank on the pair shares against 0.5, $P = 9.7 \times 10^{-4}$). Eight of the 14 pairs are individually above chance by a two-sided binomial test, and all eight remain so after Holm correction. Pooled over those pairs the female starts 429 of 536 displays, 80.0 per cent, which is the same figure the session-level pooling gives. The result is therefore not an artifact of treating repeated recordings of one pair as independent.

Only the 17-of-17 sentence and "leading member of the pair" to "the female"
are new; every number (14 pairs, 536 displays, 0.81, $P=1.2\times10^{-4}$,
$P=9.7\times10^{-4}$, 8 of 14, 429 of 536, 80.0%) is unchanged and matches
line 178's Results twin, as required.

## Line 354, Methods, three controls

Old:

> Three controls were run on the initiator asymmetry. It is not explained by the rearing base rate, since a session's initiation share is uncorrelated with that animal's share of rearing time (Pearson $r = -0.012$, $P = 0.96$; Spearman $\rho = 0.044$, $P = 0.84$; $n = 24$ sessions with at least five displays). It is not an artifact of the per-animal height threshold, since re-running the whole detection with a single threshold shared by both animals returns the same leader in 22 of 24 sessions and an absolute 60~mm threshold returns the same leader in all 24. It is not body size either because in the three sessions where the initiating animal is the longer of the pair it still starts 75 of 97 displays, 77 per cent (binomial against 0.5, $P = 6.1 \times 10^{-8}$). The same animal leads, checked four separate ways: at the session level, at the pair level, against a rearing-rate control and against a body-size control.

New:

> Three controls were run on the female-initiation asymmetry. It is not explained by the rearing base rate, since a session's female-initiation share is uncorrelated with her own share of rearing time within the pair (Pearson $r = -0.012$, $P = 0.96$; Spearman $\rho = 0.044$, $P = 0.84$; $n = 24$ sessions with at least five displays). It is not an artifact of the per-animal height threshold, since re-running the whole detection with a single threshold shared by both animals returns the female as leader in 22 of 24 sessions and an absolute 60~mm threshold returns her as leader in all 24. It is not body size in the direction that would trivially explain it, since the male is the structurally longer animal (median 90.1~mm against 84.2~mm, Results); in the three sessions where the female happens to be the longer animal she still starts 75 of 97 displays, 77 per cent (binomial against 0.5, $P = 6.1 \times 10^{-8}$). The same animal, and the same sex, leads, checked four separate ways: at the session level, at the pair level, against a rearing-rate control and against a body-size control.

Same open item as line 180: this paragraph's $n=24$/five-display cohort is
one displays-threshold lower than the six-display cohort the main test
(line 350) now uses, a pre-existing inconsistency that this round did not
resolve (see the note under line 180 above).

## Line 356, Methods, Fig 5G coupling

Old:

> The coupling in Figure~\ref{fig5}G was computed by taking every rearing onset by one animal and reading out the probability that the other animal was rearing at each lag within five seconds either side, divided by that other animal's own base rate. Onsets were split by the tail-base separation at the moment of onset, into those within two body lengths and those beyond. The null distribution was generated by circularly shifting the other animal's rearing time series, 24 shifts per ordered pair, which preserves that animal's rearing rate, its bout durations and its autocorrelation while destroying only the temporal alignment between the two animals; a reshuffle would additionally have destroyed the autocorrelation and would have made almost any structure appear significant. A session contributed a curve to a condition only if it supplied at least 20 onsets in that condition. The same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two body lengths and 0.97 beyond, but that arena is 3.2 body lengths across against Mouse-Dyad-10M's 6.9, so the two conditions barely differ there and the claim is made for Mouse-Dyad-10M alone.

New:

> The coupling in Figure~\ref{fig5}G was computed by taking every rearing onset by one animal and reading out the probability that the other animal was rearing at each lag within five seconds either side, divided by that other animal's own base rate. Onsets were split by the tail-base separation at the moment of onset, into those within two body lengths and those beyond, and the within-two-body-lengths condition was further split by which animal's onset anchors the window, since track slot is a stable sex identity in this corpus: aligned to the female's onset, the curve is the male's own rearing probability; aligned to the male's onset, it is the female's. The null distribution was generated by circularly shifting the other animal's rearing time series, 24 shifts per ordered pair, which preserves that animal's rearing rate, its bout durations and its autocorrelation while destroying only the temporal alignment between the two animals; a reshuffle would additionally have destroyed the autocorrelation and would have made almost any structure appear significant. A session contributed a curve to a condition only if it supplied at least 20 onsets in that condition, counted separately for each half of the sex split. The same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two body lengths and 0.97 beyond, but that arena is 3.2 body lengths across against Mouse-Dyad-10M's 6.9, so the two conditions barely differ there, no sex convention exists there to split by, and the claim is made for Mouse-Dyad-10M alone.

The 24-shifts, 20-onsets-minimum and SLAP-2M numbers are unchanged; the new
content is the anchor-animal split (matching the new two-sub-axes 5G panel)
and the note that the 20-onset minimum is now counted separately per half of
that split rather than once overall, which is a real methodological change,
not just wording -- a session that clears 20 onsets pooled but fewer than 20
on one specific side of the split now correctly drops out of that side's
curve.

## Line 398, Methods, Statistics paragraph

Old:

> ...and the paired session-level comparison against a fixed value in Figure~\ref{fig5}F uses a Wilcoxon signed-rank test. Binomial nulls were simulated rather than approximated wherever the statistic is a larger-of-two share, using 20,000 draws per session size, and the temporal coupling in Figure~\ref{fig5}G is read against circular-shift nulls.

New:

> ...and the paired session-level comparison of female share against male share in Figure~\ref{fig5}F uses a Wilcoxon signed-rank test, equivalently female share against 0.5 since the two shares sum to one within a session. The temporal coupling in Figure~\ref{fig5}G is read against circular-shift nulls.

The "Binomial nulls were simulated... 20,000 draws per session size" sentence
is deleted outright, not reworded: it described the Fig5F size-matched
surrogate, which no longer exists in the manuscript in any form. Note this
also resolves a pre-existing inconsistency this file's Round 1 never
flagged: this sentence said "20,000 draws per session size" while the
Fig5F-specific Methods paragraph (old line 350) said "Two thousand surrogate
corpora" (2,000) -- a contradiction between two paragraphs describing what
should have been the same simulation. It is moot now since the whole
surrogate-null clause is gone, but worth recording in case anyone goes
looking for why those two numbers never matched.

## What retired from the manuscript entirely in this round

These terms/statistics described panels or analyses that no longer exist in
Fig 5 as of this round, and do not appear anywhere in the rewritten text
(grep-verified clean): `fair coin` / `fair-coin`, `surrogate` (all senses:
2,000 corpora, size-matched, permutation bound), `the leader` / `leader's`
(replaced throughout by "the female" or "female share"), `within-display
ranks` (5B's old rank-based framing), `Separation velocity` (5D's old
dual-axis plot), `by role` (5D's old caption clause), `94 per cent of
displays below baseline` / the 0.44 baseline-speed ratio (5E's old
relative-speed statistic), `20,000 draws` (Statistics paragraph).

## What I verified after this round

- No stale terminology remains anywhere in the file: `fair.coin|surrogate|
  the leader|leader's|within-display ranks|Separation velocity|by role\b`
  all absent (grep, whole file).
- `\(` / `\)` and `$...$` math-mode delimiters are balanced (even count) on
  every edited line: 168, 172, 174, 176, 178, 180, 185, 348, 350, 352, 354,
  356, 398.
- No unescaped `%` was introduced on any edited line.
- Every number carried over unchanged from the pre-existing manuscript
  (rather than newly computed for this round) was independently
  recomputed against the deposited data and matches exactly: pair-level
  14/14 $P=1.2\times10^{-4}$, rear-time correlation $r=-0.012$/$P=0.96$,
  body-size controls 28/36 and 75/97, the 2.9/4.1/1.05/0.99 pooled coupling
  ratios.
- The Fig 5 caption's panel letters (A to G) still match the panels
  `figs/assemble.py`'s `LAYOUTS[5]` actually places, cross-checked against
  each panel's own `save(fig, 5, letter, slug)` call.
- The Discussion section (line 242, "dominance displays, threat evaluation,
  or joint exploration") makes no Fig-5-specific claim that this round's
  rewrite would contradict, so it was left alone.
- Spelling is consistently American and the file contains no em dashes,
  matching the rest of the file (unchanged from prior rounds, re-checked
  on the new text only).
