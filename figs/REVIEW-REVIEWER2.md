# Referee report

**Manuscript:** LUC3D: 3D annotation and proofreading GUI for pose estimation and
multi-animal tracking
**Journal:** Nature Neuroscience, Technical Report
**Reviewer:** #2
**Recommendation:** Major revision

---

## Summary

The authors present a browser-based graphical tool for annotating, triangulating and
proofreading multi-camera pose data, together with a greedy cross-view association
procedure, benchmarks against an exhaustive alternative and against two per-camera
trackers, a triangulation comparison against aniposelib, and a behavioural analysis of
mutual rearing in mice. They also announce two multi-animal datasets.

The software addresses a real gap. Cross-view identity at annotation time is genuinely
unserved by existing tools, the browser deployment lowers a real barrier, and I want
this tool to exist. The manuscript's presentation is also unusually candid: it reports
unfavourable results (Figures 4D, 7D, 7G) that many authors would bury, and it flags
several of its own weaknesses. I commend that and I have tried to review the paper the
authors actually wrote rather than the one the abstract advertises.

My central problem is that the two do not match. The abstract and introduction promise
comprehensive datasets and a validated multi-animal tool; the benchmarks that carry the
central claims rest on a handful of sessions, in some cases a single session, and in
one case on a configuration that was never run. The manuscript reports the numerators
prominently and the denominators only in Methods, if at all. Below I set out what I
believe is required before this can be assessed on its merits.

---

## Major concerns

### 1. The benchmarks do not use the datasets the paper advertises, and the sampling is not disclosed where the reader needs it

This is my principal concern and it recurs in every figure. The manuscript foregrounds
very large numbers (12,039,174 frames; 1,277,424 keypoints; 55,298,204 solves;
137,671 frames) while the effective sample behind each claim is small and, in the
critical case, is a single recording session. Working through the Methods:

- **Figure 3D and 3F, the central head-to-head, use four sessions, one per
  configuration.** Of the 137,671 frames, 122,830 (89 per cent) come from one
  two-mouse BMimica session. The two-animal, six-camera cell is one SLAP-2M session
  (14,275 frames). The three-animal cell is **200 frames** from one session. The
  four-animal, three-camera cell is **366 frames** from one session. The four-animal,
  six-camera cell contributed **zero frames**. The manuscript's phrasing, "on all
  137,671 frames where exhaustive enumeration could be run at all", is literally true
  and, I think, materially misleading: a reader will take it as corpus-scale evidence
  when the multi-animal evidence is 566 frames from two sessions.
- **Figure 3E** uses 8 of 56 BMimica sessions. The selection criterion is not stated.
- **Figure 2** uses 50 of 56 sessions and every 200th frame, that is 901 of 180,199
  frames per session, or 0.5 per cent.
- **Figure 6** uses 74 of 84 sessions and every 120th frame, roughly 0.8 per cent.
- **Figure 4** uses 50 sessions at every 60th or every 240th frame.
- **Figure 5** uses 37 of 56 sessions.
- **Figure 1 and Figure 2A** are a 300-frame window of a single session that belongs to
  neither announced dataset.

Only Figures 3 and 7 are described as using complete sessions, and Figure 3's
completeness refers to the frames within those four sessions rather than to the corpus.

The subsampling itself I can accept. The Methods argue it is uniform, never selective,
and report a cross-check between two independently sampled estimates agreeing to within
0.1 to 0.7 per cent, which is the right sort of evidence. What I cannot accept is that
the reader must reconstruct the denominators from three separate Methods paragraphs
while the Results quote only the numerators.

**Requested:**
(a) A table, in the main text or as a first supplementary table, giving for every panel
the number of sessions used and available, the number of animals, the number of frames
used and available, and the sampling stride. (b) Figure 3 rerun across all sessions of
each configuration, or an explicit statement of why only one session per configuration
was used and what that costs the claim. (c) The selection rule for Figure 3E's eight
sessions. (d) A stated convergence check for each strided measurement, of the kind the
Methods already provide for the cross-check, showing the estimate is stable at a higher
sampling density.

### 2. The number of animals is never reported, and the sessions are not independent

Nature Neuroscience requires the number of animals for every experiment. I could not
find it anywhere in the manuscript. From the description of BMimica (56 sessions, two
mice each) a reader will infer something in the region of 112 animals. That inference
is almost certainly wrong: the pairing structure of a 56-session, two-mouse corpus
recorded over a few weeks is normally a small set of animals recorded repeatedly.

This matters most for Figure 5, which is presented as a behavioural result with n = 37
sessions and treats sessions as the unit of analysis for a Wilcoxon test. If those 37
sessions are repeated recordings of a much smaller number of pairs, the test is
pseudo-replicated and the confidence interval is too narrow. The same question applies
to Figures 2, 4 and 7A, where "n = 50 sessions" is used as though it were 50
independent observations.

**Requested:** the number of distinct animals and distinct pairs in each corpus; for
Figure 5, an analysis with animal or pair as the unit of replication, or a mixed model
with pair as a random effect; and a statement of how many sessions each pair
contributes.

### 3. The headline speed claim rests on a configuration that was never run

The abstract-level claim of a millionfold saving comes from the four-animal,
six-camera cell of Figure 3F, and the Methods state plainly that no frames of it were
computed. Its cost is an arithmetic construction: a hypothesis count, reduced by a
symmetry argument, multiplied by a per-hypothesis rate measured in a different
configuration on a different corpus. Three compounding weaknesses follow.

First, the per-hypothesis rate was measured at five cameras and applied to six, and at
two or three animals and applied to four, where each hypothesis must triangulate more
groups and reproject into more views. Second, the reference implementation is the
authors' own single-threaded JavaScript reimplementation of another group's method. A
comparison against one's own reimplementation of a competitor, in a language chosen for
the browser rather than for throughput, is weak evidence about that competitor's cost.
Third, and most concretely, I note from the deposited tables that the exhaustive timing
for the two-animal, five-camera cell comes from session 20250829_124351 while the LUC3D
timing for that same cell comes from session 20250827_141755. The two methods are
therefore timed on different recordings, which for a per-frame cost comparison is not
acceptable.

**Requested:** time both methods on identical sessions and identical frames;
report the extrapolated point separately from the measured ones, ideally in a
supplementary panel rather than on the main figure; and either implement the comparison
method at parity (compiled, or at minimum with the same memoisation opportunities the
authors note are available) or restrict the claim to "intractable in our
implementation" and drop the specific factor.

### 4. The central usability claim was never tested on users

The paper's contribution is a graphical tool, and its most quotable result is that
labelling two views instead of all views reduces manual placements 2.3-fold. That
number is a model, not a measurement: the Methods state that only one rig size was
measured, and Figure 2B's curve is the expression 2N + (C - 2)Np evaluated at N = 15
with p taken from detector outputs. No human annotator appears anywhere in this
manuscript. There is no measured labelling time, no comparison against the same
annotators using a conventional tool, no inter-annotator agreement, and no measurement
of how often an annotator actually accepts a reprojection that the model assumes is
accepted.

For a Technical Report describing an annotation interface, this is the missing
experiment. A modest study, say five annotators labelling matched frame sets in LUC3D
and in a conventional per-view tool, with time to completion and resulting accuracy
against the proofread reference, would convert the paper's central claim from a model
into a result.

Relatedly, Figure 2C scores the reprojection against the held-out view's **own
detection**, that is against a network's output rather than against a human label. The
manuscript should be explicit that "94.6 per cent within 10 px" measures agreement with
a detector, and that whether an annotator would accept those reprojections is a
separate and untested question.

### 5. The comparison in Figure 7 is partly definitional, and the fair comparison is null

The framing result, that only LUC3D's identities survive pooling across cameras, is
close to a tautology and the manuscript says so: a method that labels each camera
independently can be matched to the truth in at most one camera, so 1/C is a ceiling.
Penalising SLEAP and ByteTrack on a metric for a capability they do not claim tells the
reader little. I would not object if the paper leaned on it lightly, but it is the
abstract's implicit selling point.

The comparison that is not definitional is Figure 7D, within-view IDF1 on multi-animal
sessions, and there the result is null: +0.024 over 42 sessions, 23 of 42, P = 0.64,
and negative in both the three-animal and four-animal cells. Figure 7G adds that LUC3D
fragments more in 72 of 74 sessions. The Results state all of this. The abstract and
introduction do not.

**Requested:** revise the abstract and introduction so that the claimed advantage is
the one the data support, namely cross-view identity as a capability rather than
tracking quality as a benchmark win; and state the null multi-animal within-view result
and the fragmentation cost in the abstract, not only in the Results.

I would also like to see the 3D-MuPPET comparison justified. An IDF1 of 0.011 is close
to complete failure, and a reader is entitled to wonder whether that method was run in
a configuration its authors would recognise.

### 6. Figure 4 shows the competitor is more accurate, and the framing works around it

Anipose's solvers are lower in reprojection error in both algorithm-class pairs, in 50
of 50 and 49 of 50 sessions, on a metric that no solver optimises. The paper reports
this and then argues that the solver does not matter because geometry dominates. That
argument is reasonable but it does not answer the obvious question: if the solver does
not matter and the alternative is slightly better, why does the tool ship its own?

**Requested:** either adopt the better-performing solve, or state the engineering
reason for the current one (I assume it is that a WebAssembly or JavaScript
implementation is required for a browser tool with no server, which is a perfectly good
reason and should be given), and move the timing comparison's framing accordingly. As
it stands, the timing result compares JavaScript under Node against Python and NumPy,
which is a language and runtime comparison as much as an algorithmic one, and that
should be acknowledged.

### 7. The novelty claim for the association algorithm is not supported by the Methods

The abstract announces "a novel cross-view ReID tracking algorithm". The Methods
describe a per-camera Hungarian assignment against a set of 3D targets, with a cost
combining a reprojection distance and a point-to-ray distance and an age decay. Each of
those components is standard in the multi-view tracking literature, and the manuscript
itself attributes the surrounding framework to Maree et al. (2024). The contribution as
I read it is a well-engineered, interactive, browser-resident implementation with
exposed parameters, which is a legitimate Technical Report contribution and does not
need to be dressed as algorithmic novelty.

**Requested:** reframe the claim, and add a paragraph situating the cost function
against prior multi-view association work.

### 8. Figure 3E does not support the shipped parameter

The sweep shows identity switches falling monotonically with the weight ratio, reaching
their minimum at the largest ratios tested, and IDF1 highest at r = 12. The shipped
default of r = 6 is worse than r = 12 on both metrics. The manuscript's own text
concedes the sweep did not select the default. A reader will reasonably ask why the
software ships a value the paper's own ablation does not favour.

**Requested:** either change the default and rerun the affected benchmarks, or explain
what other consideration (stability, sensitivity to calibration error, behaviour at
higher animal counts) motivates 6. I would find a supplementary panel showing the
ratio's effect at three and four animals persuasive; the current sweep is two-animal
sessions only, which is also worth stating.

### 9. The manuscript is incomplete as a submission

- **The Discussion is an empty heading.** I cannot assess how the authors position
  their work, what they consider its limits, or what they propose next.
- **There is no reference list**, and the text cites only three works. Label3D, JARVIS,
  DeepLabCut, Anipose, DANNCE and SDANNCE, Lightning Pose, ByteTrack, 3D-MuPPET,
  motmetrics and the IDF1 metric itself are all used or compared against and none is
  cited.
- **No data availability statement**, no repository, no accession, no licence, despite
  the abstract announcing two datasets as a contribution.
- **No code availability statement**, no version or commit identifier, no URL for the
  deployed application in the manuscript body.
- **No ethics statement.** "No animal procedures were performed for this work" is not
  sufficient for previously acquired recordings; the protocol numbers and approving
  institutions for the original acquisitions are required.
- **No author contributions, competing interests or funding statements.**

### 10. The datasets are announced but not characterised or released

The abstract names "the BMimica-11M two-mouse data repository", the Methods describe a
corpus called BMimica with 10,084,734 frames, and the Results and figures use a third
name. If the 11M refers to frames, it does not match the Methods. More importantly, a
paper that presents datasets as a contribution needs a dataset section: acquisition,
housing, strain, sex, age, arena, enrichment, annotation protocol, who proofread and to
what criterion, inter-proofreader agreement, licence and access. At present the reader
learns the camera count, frame rate and node count and nothing about the animals or the
labelling procedure.

The claim in the introduction that enrichment distinguishes these datasets from existing
ones is asserted rather than shown. If enrichment is the selling point, quantify it, and
show a result that depends on it.

### 11. Scope of the generality claims

Every result is mice, a 15-node skeleton, and one of two camera rigs, from two
laboratories. The tool is presented as general-purpose. I do not require new species,
but the claims should be scoped, and the two places where the corpora disagree should
be discussed rather than relegated: the rearing coupling reproduces at 2.9-fold on
BMimica and 1.08-fold on SLAP-2M, and the manuscript attributes this to arena size
without testing that explanation.

---

## Concerns about Figure 5 specifically

I am unsure this figure belongs in this paper, and if it stays it needs the most work.

As a demonstration that the tool enables a measurement no single camera supports, panels
A, B and G are convincing and the circular-shift null in G is exactly the right control.
The proximity split is a good design and rules out the shared-drive explanation cleanly.

The leader analysis in F is where I hesitate. The statistic is the larger of two shares
and therefore cannot fall below one half, which the authors handle correctly with a
simulated null. But 16 of 24 sessions clearing that null is a modest result, the unit of
analysis is the session in a corpus where sessions are not independent (concern 2), and
the three controls, while sensible, are reported as bare fractions without tests or
intervals. The paper is careful to disclaim dominance, which I appreciate. I would
either promote this to a companion paper with the analysis it deserves, including
animal-level replication and a dominance assay, or reduce it here to the coupling result
in G, which is solid, and the demonstration that the measurement requires 3D.

I would also ask for the negative result to be stated in the Results rather than only in
Methods: the same coupling measurement on SLAP-2M gives 1.08-fold, and a reader deserves
that in the main text.

---

## Minor points

1. The Results section reads as a sequence of expanded figure legends. Several
   paragraphs are near-verbatim duplicates of the corresponding legend. The Results
   should carry an argument across figures.
2. The abstract has grammatical errors: "Innovation in 2D pose estimation methods have
   increased"; "these myriad of problems"; three consecutive sentences beginning "In
   addition", "Also".
3. Figure 7 is headed "Supplemental" but is presented as a main figure.
4. Figure 6 is headed "Multi-animal mouse social behavior datasets" but its panels are
   about detection quality against difficulty.
5. Figures 2, 3 and 4 legends have no lead sentence, while 1, 5, 6 and 7 do.
6. Figure 1D's legend states the capabilities were read from documentation but no longer
   gives the date on which they were read, and no cell is cited. A competitive
   capability table needs both.
7. The HardFight recording is used for Figures 1 and 2A but is introduced only in
   Methods, and is a third dataset not mentioned in the abstract.
8. "1.9 hundred million" should be 1.9 x 10^8.
9. Figure 7B's legend contains "no Intervals" with a stray capital.
10. Cross-view IDF1 should be defined at first use in the Results, not only in Methods.
11. "Requires no installation" sits oddly beside a local deployment that needs a static
    file server. State the two deployment paths.
12. Statistical reporting is uneven. Figure 6C's fold-changes, Figure 4's solver spread
    and the three controls in Figure 5 carry no tests, intervals or n. Exact P values
    and test statistics should be given throughout, and where a test is not appropriate
    the manuscript should say so.
13. The Methods state that the panels draw "the more favourable" of two measured Anipose
    variants. The wording invites suspicion of a choice made on the result. Give the
    principle first (temporal smoothing is invalid on strided input) and the outcome
    second.
14. Several claims are made in units of "body lengths" normalised per animal. Since the
    animals differ in size and the normalisation affects the rearing threshold, please
    show that the display detection is not sensitive to it. (I note the Methods report
    exactly this control for the initiator analysis; extend it to the event definition.)

---

## What would change my assessment

I would support publication if the authors:

1. Report, per panel, sessions and animals used against available, and either extend the
   Figure 3 benchmark beyond one session per configuration or scope the claim to what
   four sessions can support.
2. Report the number of animals and pairs, and repeat the Figure 5 statistics with the
   animal or pair as the unit of replication.
3. Measure the labelling saving with human annotators, or remove the 2.3-fold claim from
   the abstract and present it explicitly as a model.
4. Time both association methods on identical sessions and frames, and separate the
   extrapolated configuration from the measured ones.
5. Rewrite the abstract so that the multi-animal within-view null result and the
   fragmentation cost are visible there, and reframe the algorithmic novelty claim.
6. Supply the Discussion, references, data and code availability, ethics and author
   statements, and a proper dataset characterisation.

The underlying work looks sound and the software looks useful. My objections are about
what is claimed relative to what was measured, and most of them can be addressed by
reporting more completely rather than by new experiments. The two exceptions, the
annotator study and the Figure 3 session count, are the ones I consider necessary.
