# LUC3D figure set — technical report and adversarial review

*Written in the register of a Nature Neuroscience tool-resource submission (the
Cheese3D model: a measurement tool argued to working neuroscientists on what it
lets them measure, with the tool's limits quantified in the same figures that
carry its claims). Three parts: the **steelman** — the strongest honest version
of the argument the seven figures make; the **adversarial review** — the
concerns a hostile but fair referee should raise; and the **responses**,
one by one, each stating what the figure set already answers, what was changed
in the 2026-08 revision, and what remains genuinely open. Maintained alongside
the figures; update it when they move.*

*Revision note (2026-08): this document postdates the revision that (i) redrew
Fig 1a's pipeline icons as the pipeline's own objects, (ii) redrew Fig 3a as the
correspondence search itself and stripped its caption lines, (iii) replaced the
association-runtime panel with Fig 3d "Grouping accuracy, head to head" (both
methods vs proofread GT), (iv) audited and hardened Fig 3f's intractability
extrapolation, (v) cut the joint-bundle-adjustment card from Fig 4a and the
"Error in an unused camera" panel from Fig 4, (vi) made Fig 5a's reflection
lock-on the panel's explicit subject, (vii) replaced Fig 5d with the
proofreading-workflow comparison, and (viii) put ByteTrack's cloud on Fig 7f and
converted Fig 7e to rates per 100,000 camera-frames.*

*Second pass (same review round): Fig 7e now reads in plain percent of
camera-frames (an ID switch on 0.0316% of LUC3D camera-frames = identity held on
99.97%); Fig 7d draws every individual session as a dot behind its cell, so the
3- and 4-animal strata are seven visible sessions rather than two wide intervals
(part of the M1 response); and the Fig 3 head-to-head is being extended into the
3-4-animal regime (A3_C5 window 200 → 1,000 frames; a new tractable 4-animal
configuration, 4 × 3 cameras = 13,824 hypotheses/frame) — Part III's M2 response
will be updated with the numbers when that measurement lands.*

---

## Part I — The steelman

**The problem is real, current, and blocks a specific community.** Social
behavior is the fastest-growing use of markerless pose estimation, and it is
exactly the case single-camera tools handle worst: animals of the same strain
are visually interchangeable, they occlude each other in every interesting
moment, and the scientific quantity — who did what to whom — is undefined the
moment identity breaks. Multi-camera rigs solve occlusion geometrically, but
they multiply the identity problem by the number of cameras: C videos now carry
C independent, unlinked identities. Every downstream 3D quantity needs the same
animal found in every view, every frame.

**The field's tools split this problem and drop the middle.** Per-camera
trackers (SLEAP, ByteTrack) produce within-view tracks with **no cross-view
correspondence at all** — Fig 7a measures their cross-view IDF1 at 0.046–0.062
against a *structural* ceiling of 1/C = 0.20, versus LUC3D's 0.749, identical to
its within-view score. This is not a tuning gap; a per-camera tracker cannot
exceed 1/C by construction, which the figure states as a ceiling rather than
implying it is chance. The one published method that attacks cross-view
association directly (Maree et al. 2024) is exhaustive: (A!)^C hypotheses per
frame, measured here at 244–347 µs per hypothesis — tractable at 2 animals × 5
cameras, **13–18 hours per frame** at 4 × 6 (Fig 3f), a regime the benchmark
corpus actually contains. That paper's own "Future directions" proposes the
greedy variant; LUC3D implements it.

**The core empirical result: the cheap search loses nothing that the expensive
search was buying.** On the identical detections, for every one of the 137,266
frames the published exhaustive procedure could run at all, greedy chooses the
same grouping on all but 2 (Fig 3f), and — the decisive panel, new in this
revision — **both methods misgroup exactly one frame each against proofread
ground truth, and not the same one** (Fig 3d). On one of the two disagreements
the reprojection-error *optimum is the wrong grouping*: the objective runs out
before the search does, so optimizing it harder than greedy does buys nothing.
That is a stronger statement than "greedy approximates exhaustive well"; it says
the problem, on clean frames, is solved at O(C·A³) per frame — 2.4 ms worst
case, 8× under a 50 fps interactive budget — and Fig 3c/3f price what the
alternative costs.

**The tool claim is annotation and proofreading, not tracker leaderboards, and
the figures argue it as workflow.** Fig 1 shows the pipeline end to end in a
browser with no install, consuming the field's standard formats (.slp in, SLP
2.8/H5 out — readable back in SLEAP). Fig 2 shows reprojection-aided *labeling*:
two anchor views triangulated, reprojected into the rest, accept/nudge — the
mechanism that makes an 8-camera frame labelable in roughly the effort of two.
Fig 5 shows proofreading: the app's own per-view residual identifies which
animal is wrong, and *what is wrong with it*, before a human looks — including,
in the staged frame itself, a detector locked onto an animal's **reflection in
the glass**, a failure that looks plausible in every single view and is exposed
only by the cross-view residual (Fig 5a). Ranking keypoints by that residual
recovers 27% of all needed correction in a 10% review budget — 85% of what an
oracle achieves (Fig 5c). And Fig 5d states the structural difference a
proofreader lives with: SLEAP's repairs are spread over six per-camera timelines
that remain unlinked after every repair is done; LUC3D's land on one cross-view
identity, each repair applying to all six views at once, with the 3D attached.

**The evaluation is unusually honest, and that is a feature to argue, not hide.**
Every tracker is fed identical identity-stripped detections; false negatives —
98.8–99.3% of every tracker's error — are attributed to the shared detector
(Fig 7e/7f) rather than claimed as tracking wins; the pooled IDF1 advantage is
explicitly decomposed to show it is carried by the 1-animal stratum (Fig 7d);
and the tool's measured disadvantage — it fragments more than SLEAP, 72/74
sessions (Fig 7g) — leads a panel rather than a supplementary note. Fig 6
establishes the corpus is hard on purpose (bedding, obstacles, animal counts).
A reviewer can check every number: each panel deposits its plot-ready table,
and captions are recomputed from the deposits.

**Why a neuroscientist should care.** The deliverable is not an IDF1 delta; it
is that a lab with a multi-camera rig and a SLEAP model can, in a browser, go
from per-view detections to *identity-resolved 3D social behavior* — and, when
the automation is wrong, see where, why, and fix it once. That capability
currently does not exist in any released tool (Fig 1d's capability table), and
each figure isolates one reason it now does.

---

## Part II — Adversarial review

*The referee is granted full access to the deposits and captions and is assumed
to be hostile but fair.*

**M1 — The multi-animal advantage evaporates exactly where the paper's story
needs it.** Fig 7d shows the pooled within-view IDF1 advantage (+0.075) is
carried by 1-animal sessions; over ≥2 animals it is +0.024 (P = 0.64), and the
3- and 4-animal cells are negative (0/4, 0/3 wins). A tool whose title is
multi-animal identity should not lose its per-camera comparison at 3–4 animals.

**M2 — The exhaustive head-to-head is a comparison on the easy 69%.** Frames
enter Fig 3d/3f only when every camera holds exactly A detections; 30.8% of
frames — precisely the occluded, hard ones — were skipped, and 89.5% of what
remains is the cheapest configuration (2 × 5). "Same answer as exhaustive" on
clean, almost-entirely-two-animal frames does not establish superiority where
association is actually difficult. Only 161 frames test 3 animals; zero test 4.

**M3 — The proofreading-load comparison (new Fig 5d) can be read against the
tool.** LUC3D's break mass is ~3× SLEAP's (16,189 vs 5,445), and even its lower
bound (5,462) is not smaller than SLEAP's total. The panel's defense is
qualitative ("one repair fixes every view"), not a measured time-to-correct.
A skeptic will say: you replaced a panel with suspicious data with a panel that
shows your tool needs *more* repairs, annotated with a claim about repair
*value* that no experiment in the paper quantifies.

**M4 — The triage result assumes away the hard problem and cannot see its own
blind spot.** Fig 5c/5d's ranking analysis "assumes association is already
correct (Fig 3)". Worse, the caption's own taxonomy says `CROSSVIEW_LOCK` —
an identity locked wrongly in ≥3 cameras, hence geometrically self-consistent —
is 18.2% of all mislabelled frames and is *invisible to the residual*. The 85%-
of-oracle headline quietly conditions on the failure modes the signal can see.

**M5 — The 4 × 6 intractability number is an extrapolation, and the panel's
"1 day" reading invites attack.** No 4 × 6 frame was ever run. A referee who
notices label symmetry ((A!)^(C−1) distinct partitions) or per-group
memoization will ask whether the published method was strawmanned by pricing
its naive form.

**M6 — Ground truth is not independent of the system under test.** The SLAP-2M
"proofread GT" derives from the same SLEAP predictions that populate the shared
detection pool (the deposit says IoU matching is near-saturated for exactly this
reason), and the reflection lock-on in Fig 5a shows the detector family's
systematic errors. GT-agreement claims (Fig 3d) partially inherit whatever the
proofreaders did not fix.

**M7 — Generality.** Two corpora, one species, mostly white mice; the bedding
"invariance" (Fig 7b) is a between-session comparison with different animal
mixes and no deposited per-session values, hence no intervals; the interactive
claims (2.4 ms/frame) are one machine, single-threaded. Nothing shows a rat, a
bird, or a 12-camera rig.

**M8 — The solver figure (Fig 4) now shows a menu item that barely matters.**
The refined solver moves the median residual by ~0.2 px (in-sample, partly
enforced) at 6.9× the cost (Fig 4e), and the one out-of-sample comparison
(34/50 sessions) is small. Why does the app ship it, and why does a figure
spend five panels on solver choice when view count (Fig 4b) is the whole story?

**m1 (minor)** — Fig 7g's fragmentation cost is asserted as "the price of the
same conservatism that buys the cross-view result" without a measurement tying
the two. **m2** — Fig 5a is one frame of one session; its 12 px story is an
anecdote (acknowledged, but a referee will say the word). **m3** — the 1/C
ceiling in Fig 7a is stated for within-view trackers evaluated cross-view;
readers repeatedly mistake it for a chance level, and one label may not be
enough. **m4** — several captions carry method-level detail that belongs in
Methods; the figure set still reads text-heavy by Nature standards.

---

## Part III — Responses, one by one

**M1 (multi-animal advantage).** Conceded as stated — and the figure states it
itself, on the artwork: "carried by the 1-animal stratum, NOT a multi-animal
result." The response is scope, not spin: the paper's claim is **cross-view
identity**, where the comparison is 0.749 vs 0.062/0.046 against a 0.20 ceiling
(Fig 7a) and per-camera trackers cannot compete *by construction*. Within view,
the honest claim is parity (switch rates 31.6 vs 30.8 per 100k camera-frames,
Fig 7e) — the tool does not need to win per-camera tracking to deliver the
thing per-camera trackers cannot produce at all. The negative 3–4-animal cells
are n = 4 and n = 3 and fully confounded with bedding and difficulty (stated in
the caption); we do not claim them, and 7d exists precisely so no pooled number
can claim them silently. *Open:* more 3–4-animal sessions with proofread GT
would settle the stratum; none exist in the benchmark today.

**M2 (easy-69% comparison).** The composition is printed inside Fig 3f
(61,026 skipped as occluded; 89% of the rest 2 × 5; 161 frames of 3 animals) —
the referee's numbers are our numbers. Two substantive points. First, the
restriction is not ours: the *published method is undefined* on frames where a
camera does not hold exactly A detections — "A! per view" has no meaning there.
The comparison is run everywhere the published method exists; its emptiness at
4 animals is the tractability result, not a sampling choice. Second, the hard
frames are not unmeasured — they are measured end-to-end, with occlusions in,
by the full-session tracking of Fig 7 (and Fig 3e's ablation shows the 3D term
is what carries it: switches collapse ~1000× as r rises to the shipped 6).
What is genuinely not shown: a per-frame method-vs-method comparison on
occluded frames, because no per-frame exhaustive answer exists to compare
against there.

**M3 (repair counts read against the tool).** This is why the panel says, in
its own footnote, **"the count is not the argument."** The revision chose to
deposit and draw the unflattering mass (16,189, mostly fragmentations) with
bounds rather than pick a flattering scalar; the alternative — plotting
"distinct events" as if measurable — would be an invented number. What *is*
measured and drawn: SLEAP's exact repair count on six timelines that remain
unlinked after all repairs (cross-view IDF1 0.062; the stitching left over is
Fig 3's problem, priced at (A!)^C in the worst case); LUC3D's bounded event
count on one identity. The claim about repair value is structural, not
empirical: a cross-view identity edit reaches all views because the identity
*is* cross-view — that is an architectural fact about the data model, not a
user study. *Open, and conceded:* a measured time-to-fully-correct-session
(human-in-the-loop) comparison does not exist in this figure set and would be
the definitive version of this panel. m1 folds into this response: 7g's
"price of conservatism" line should stay qualitative or be cut; it is not
load-bearing.

**M4 (triage conditions on visible failures).** The conditioning is disclosed
under the axis of both panels it affects, and the blind spot is not discovered
by the referee — it is *quantified by us*: `CROSSVIEW_LOCK`, 36 episodes, 5.3%
of episodes, 18.2% of mislabelled frames, median 578 frames. The honest reading
of Fig 5c, which its caption now carries: the residual is the right triage for
the (majority) failure mass it can see, recovers 85% of the oracle there, and a
geometrically self-consistent wrong identity needs a different signal —
temporal, not geometric. That is stated as the limit of the method, and it is
also Fig 3e's result in another key: geometry alone (r → ∞) is not optimal
either; the shipped tracker mixes 2D-temporal and 3D-geometric terms because
each covers the other's blind class.

**M5 (extrapolation attack surface).** Addressed head-on in this revision.
The caption now carries both audits, and both make the extrapolation
*conservative*: (i) the per-hypothesis rate can only rise from 3 × 5 to 4 × 6
(each hypothesis triangulates more groups into more cameras; scaling by
(4/3)(6/5) gives ~29 h/frame, above the drawn 13–18 h); (ii) granting the
search the full A!-fold label symmetry the published count does not exploit
still leaves 0.5–0.8 h per frame — one second of 50 fps video per 1–1.7 days.
Memoized per-group caching would beat the per-hypothesis model, but that is a
different algorithm from the published per-frame procedure being priced, and
the panel names its object precisely ("our reimplementation of the published
per-frame procedure"). The arithmetic is deposited (244–347 µs measured over
three configurations spanning 32→7,776 hypotheses/frame, ratio-consistent).

**M6 (GT circularity).** Partially conceded and disclosed in the deposit's own
caveats (the IoU match "mostly transfers proofread identities rather than
stress-testing the matcher"). Three mitigations. The quantity compared in
Fig 3d is *grouping* — which detections belong to the same animal across
cameras — and the proofreading process corrects exactly identity/grouping
errors, so the GT is strongest on the axis being tested; spot-checks confirm
slot-to-animal maps flip across cameras and frames (the comparison is not
vacuous). The BMimica corpus (122,830 of the 137,266 frames) has independent
full proofreading. And the detector-family concern cuts *for* the proofreading
figures: Fig 5a's reflection lock-on is shown precisely as the class of shared
detector error a human plus cross-view residual catches. *Open:* GT from an
independent detector family (or manual-from-scratch labels on a subsample)
would close this fully.

**M7 (generality).** Conceded at the boundary drawn: claims are made over 124
sessions, two rigs, 5–8 cameras, 1–4 mice, and every quantitative statement
names its corpus. Fig 7b's caption states, on the artwork, that it is
between-session, unpaired, with a differing animal mix and no deposited
intervals — it is presented as an absence-of-collapse observation (ByteTrack
Δ0.148 vs LUC3D Δ0.012), not a controlled invariance result. The browser
runtime claim is deliberately understated (worst case 8× under budget,
single-threaded). Species generality is not claimed anywhere; the method's
inputs (detections + calibration) are species-agnostic, and that is as far as
the figures go.

**M8 (why the solver figure).** Because the field's tooling says "bundle
adjustment" and ships something else, and users make decisions on that word —
the figure is a nomenclature correction with measurements attached (its lead
finding is that *view count*, 3.9×, dominates solver choice, ~8%/3%). The
revision sharpened exactly this: the never-wired joint-BA card is gone (the app
should not be illustrated doing something it never does), the held-out-camera
panel the review found unconvincing is gone, and what remains is one schematic,
the view-count result, the worst-view result, one paired accuracy comparison
with its enforcement labeled, and the cost. Five panels → a-e, each earning its
place. Why ship the refined solver at all: 0.2 px median at 43.8 µs/keypoint is
still 23× real-time, and it is lower in 50/50 (in-sample) and 34/50 (held-out)
sessions — a cheap, strictly-not-worse option, honestly priced.

**m2 (anecdote).** Yes — and labeled as such on the artwork and in the caption
("an illustration of the readout, not a corpus statistic"); the corpus versions
are Fig 5c and Fig 6c. The revision strengthened the anecdote's honesty: the
outlier animal is now explained (reflection lock-on), with a 300-frame sweep
(`figs/_probe_fig5a_frames.mjs`) showing it is persistent rather than a chosen
frame. **m3 (ceiling label).** The panel already states "not a chance level —
chance with 2 animals ≈ 0.5"; the caption repeats it. If reviewers still
misread it, the fix is editorial (a caption sentence), and we will take it.
**m4 (text-heavy).** Conceded as direction of travel: this revision removed
caption lines from 3a and both boxes' note rows, cut one panel from Fig 4, and
moved composition notes into deposits; `CAPTIONS.md` is the designated home for
prose and the panels continue to shed words toward the Nature norm (0–4-word
titles, findings in the caption's bolded lead).

---

## Standing punch-list (what would most strengthen the set, in order)

1. **Human-in-the-loop time-to-correct measurement** for Fig 5d's claim — even
   a small-N pilot (3 sessions, 2 annotators, SLEAP GUI vs LUC3D) converts the
   panel's structural argument into the measured one (answers M3, m1).
2. **3–4-animal sessions with proofread GT** — the stratum where both M1 and M2
   say the current evidence is thinnest.
3. **A temporal-consistency triage signal** for `CROSSVIEW_LOCK`, or at least a
   quantified detector of it, closing M4's blind spot with a tool rather than a
   disclosure.
4. **Independent-detector GT subsample** (M6).
5. If any figure must shrink for the format: Fig 4 has the least
   social-behavior-specific payload and its findings compress to two sentences.
