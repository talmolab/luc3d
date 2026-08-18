# The nine figures, in plain English

Written 2026-08-13 to be talked from in a meeting. One section per figure: **what it
says**, **what made it**, and **what to watch out for if someone pushes back**. Exact
numbers, sample sizes and statistics live in `figs/FIGURE-LEGENDS.md` (Figs 1–7) and
`figs/README.md`; this file is the spoken version, not a replacement.

There's a decoder for the configuration names at the bottom — including
**`M1 + stale 20 + distThresh 25`**, which is the one that keeps coming up — and a
glossary of the metrics. If you only read two sections, read those two.

---

## The 30-second version

LUC3D is a browser tool for labelling and proofreading 3D animal pose from several
cameras at once. The figures make five arguments, in this order:

1. **It exists and it's usable in a browser** (Fig 1).
2. **It saves you labelling work** — label 2 views, accept the reprojection in the
   rest (Fig 2).
3. **Its cheap greedy identity solver matches the expensive exhaustive one** (Fig 3),
   and its triangulation is fast and accurate, with the caveats in Fig 4.
4. **It gives each animal one identity in every camera**, which per-camera trackers
   can't (Fig 7) — and that unlocks a behavioural result you can't see in 2D (Fig 5).
5. **The corpus is hard in a specific, measurable way** (Fig 6), and we swept our own
   parameters honestly (Figs 8, 9).

Two corpora do all the work. **Mouse-Dyad-10M** — 56 sessions, 5 cameras, 2 mice, 150 fps,
~180,000 frames each, human-proofread 3D. **SLAP-2M** — 74 sessions, 6 proofread
cameras, 1 to 4 animals. Fig 7a and Figs 2/4/5/8 are Mouse-Dyad-10M; Figs 3, 6, 7b–g and 9
are mostly SLAP-2M. **They are not interchangeable and the same metric has different
values on each** — that confusion is a defect we already had to fix once.

---

## Fig 1 — "here's the tool"

**What it says.** You can do multi-camera 3D pose annotation in a browser with no
install, and every animal gets one identity in every view.

**What made it.** Screenshots of the real app plus one comparison table, opened by a
Blender render. Panel A is the SLAP-2M rig — cage, 8 cameras and 2 animals — rendered
from one session's own calibration and tracked poses, nothing hand-posed. Panel C is one
frame of an 8-camera, 3-mouse recording: on the left the per-camera tracks that came
in, on the right the same views after cross-view re-identification. The number to quote
is that this frame holds **24 detections carrying 20 different track names, which
resolve to 3 identities** — one per animal, in every view. Panel D is that same frame
triangulated, 45 of 45 3D keypoints filled, shown next to the calibrated rig. Panel E
compares capabilities against 7 other tools, read off each tool's own documentation on
4 August 2026.

**Watch out.** Panel E is a documentation review, not a benchmark — we did not run
those tools. A dash means "not documented". Say that out loud if anyone reads it as a
head-to-head.

---

## Fig 2 — "labelling two views is enough"

**What it says.** Label 2 anchor views, solve the 3D from those two, and let the tool
reproject into the remaining cameras. That cuts manual keypoint placements **2.3-fold**
on a 5-camera rig, and it works because only **5.5%** of those reprojections land
outside a 10 px tolerance.

**What made it.** All 56 Mouse-Dyad-10M sessions, every frame, **286 million keypoints**.
Panel C is the honest core: the distribution of reprojection error in views that were
*not* labelled — median **4.32 px**, 94.6% within 10 px. Panel D explains when the
trick fails: a two-camera solve is only as good as the angle between the two cameras,
and it follows a depth-uncertainty law (error ≈ 1.52 mm / sin θ), bottoming out at the
all-five-view floor of ~1.2 mm. So pick anchor views that are far apart.

**Watch out.** Panel B (the 2.3× saving) is a **model** — `aided = 2N + (C−2)Np`
against `traditional = CN` — with exactly one measured point on it, the 5-camera rig.
The curves for other rig sizes are arithmetic, not data. It's marked on the figure, and
you should say it.

---

## Fig 3 — "the cheap solver is as good as the expensive one"

**What it says.** The hard problem is deciding which detection in camera 3 is the same
animal as which detection in camera 1. The literature's approach (Maree et al., 2024)
enumerates *every* possible grouping — `(A!)^C` per frame — and keeps the one with the
lowest reprojection error. LUC3D instead does one Hungarian assignment per camera,
committing each camera before moving to the next: `O(C·A³)`. **The two pick the same
grouping on 4,571,669 of 4,572,311 frames**, at about a **million-fold** lower cost in
the configuration where enumeration stops being possible at all.

**What made it.** 92 sessions with both detections and proofread 3D (50 Mouse-Dyad-10M + 42
SLAP-2M), scored against the human-proofread grouping, on **identical detections** for
both methods. Panel D is the money panel: pooled, greedy misgroups **1,052** frames,
exhaustive **1,309**. On the 642 frames where they disagree, the human agrees with
greedy on **449** and with exhaustive on **192**.

**Watch out.** Two things. First, the agreement degrades with animal count — 99.996% at
2 animals in 5 cameras down to **99.000%** at 4 animals in 3 cameras — so the headline
is a 2-animal-dominated average (94.6% of the frames are 2×5). Second, the two
expensive configurations are **capped and sampled** (2,000 and 1,000 frames per
session, spread across the session, not the first N).

---

## Fig 4 — "triangulation: views matter, solver doesn't"

**What it says.** How accurate your 3D is depends on **how many cameras contribute** and
**whether you throw out a view that disagrees** — not on which solver you use. Error in
a camera the solve never saw goes 4.32 → 3.34 px as you go from 2 to 4 cameras, and
dropping one badly-fitting view moves the 3D point by a median **7.2 mm**.

**What made it.** 50 Mouse-Dyad-10M sessions, every C-choose-k camera subset, **885 million
solves**. Four solvers compared, paired by algorithm class: our linear DLT vs Anipose
linear, our non-linear refinement vs Anipose's optimiser. We are **4.6× and 5.2×
faster**.

**Watch out — this is the one to be careful about.** Scored *in the cameras the solve
used*, our refinement is lowest — **by construction**, because that's the quantity it
minimises. Scored in a camera **no solve ever saw**, which is the fair test,
**Anipose is lower in both pairs** (3.11 vs 3.34 px linear, 3.11 vs 3.15 px non-linear;
50 of 50 and 49 of 50 sessions). That's in the deposited table and in the legend. The
paper's claim is speed and "solver choice doesn't matter much", **not** accuracy
superiority. If someone asks "so is your triangulation better?", the answer is "no,
it's equivalent and much faster, and Anipose is slightly better out of sample".

---

## Fig 5 — "what the 3D buys you: mice rear up together"

**What it says.** Two mice rear up face to face, and in each pair **one animal starts
80% of the displays**. You cannot see this in 2D: every camera sits 58–76° above the
animals, so the *height* that defines the event only exists after triangulation.

**What made it.** 539 displays from 37 of 56 sessions. A display is defined
mechanically: both animals reared (neck above 0.75 of that animal's own body length),
tail bases within 2 body lengths, held ≥ 0.25 s. Panel F is the statistical core —
each session's leader share against the **band a fair coin would give at that session
size**; 16 of the 24 sessions with ≥ 5 displays clear the band. Panel G shows the
coupling: after one animal rears, the other's rearing probability peaks at **4.1×** its
own base rate half a second later, and only when they're within 2 body lengths.

**Watch out.** The claim is **per session** (or per pair), never per animal — the corpus
is 9 mice in 18 pairings, so the same animals recur and "animal X leads" is not a thing
the data supports. Repeating it with the pair as the unit gives the same answer (14 of
14 pairs, same member leading), which is the version to quote if challenged.

---

## Fig 6 — "the corpus is hard, and here's exactly how"

**What it says.** Harder sessions don't make the pose predictions *sloppier*, they make
keypoints **go missing**. Across difficulty strata the per-view miss rate rises
**10.8-fold** (5.3% → 57.7%) while the error of the keypoints that do fire rises only
**1.30-fold** (3.65 → 4.74 px).

**What made it.** SLAP-2M, all 74 sessions, every frame, 187 million keypoint
comparisons, plus rig and per-camera renders from the app.

**Watch out.** Panel E's 130-session / 12-million-frame total describes **the corpora as
a whole and is not the sample behind any panel** — Mouse-Dyad-10M carries 84% of that frame
count and doesn't enter panels C, D or F. That's stated on the figure.

---

## Fig 7 — "one identity in every camera" (the tracking figure)

**What it says.** Given the *same* detections, LUC3D is the only method whose identities
survive being pooled across cameras: its IDF1 is **unchanged** from within-view to
cross-view scoring (0.749 → 0.749), while per-camera trackers lose half to three
quarters of theirs. That within→cross **ratio** is the claim; the absolute levels are
secondary.

**What made it.** Panel a: 4 trackers over 50 Mouse-Dyad-10M sessions. Panels c–g: 74 SLAP-2M
sessions — c is the distribution of within-view IDF1 as a survival curve, d is the
paired LUC3D-minus-SLEAP difference split by animal count, e is the error budget
(false positives vs ID switches as a % of camera-frames), f is IDF1 against the shared
detector's recall, g is fragmentation, which is the one clean result that goes
**against** us.

**Watch out — this figure is mid-repair, in three ways.**

- **c, d, e, f, g were fixed today.** They used to plot a *retired* tracker (a
  bench-only per-frame matcher from 15 May); the shipped cross-view tracker landed 6
  July, seven weeks later. They now plot the shipped one. Within-view IDF1 went
  0.736 → **0.752**, fragmentation +24.0 → **+6.2**, and the old note "LUC3D does not
  win on switches" is gone — it does now (3,094 vs SLEAP's 3,608). But false positives
  got **worse** (+8.4%), and that's on the same panel, deliberately.
- **7d is where we lose.** At 3 and 4 animals the shipped tracker emits **3.6× and 2.0×
  more** ID switches than the retired one and scores lower. Sample sizes are 4 and 3
  sessions — weak, reproducible, and printed on the panel rather than averaged away.
- **7b still plots the old tracker** (it wasn't in today's instruction), so right now
  one figure labels two tracker generations "LUC3D". One-line fix, waiting on a
  decision.
- **7a's baselines are being re-run tonight** — see "what's in flight" below. Expect its
  within-view numbers for SLEAP and ByteTrack to go **up a lot**, which makes our
  within-view lead much smaller. The cross-view ratio should be untouched.

---

## Fig 8 — "we swept our own parameters" (exploratory, not in the manuscript)

**What it says.** On all 50 Mouse-Dyad-10M sessions, what do the tracker's knobs and the
candidate algorithmic fixes actually buy? It's now a **single panel** (8d): identity
precision, identity recall and cross-view IDF1 as survival curves over the 50 sessions,
plus the % of camera-frames carrying an ID switch, one line per parameter set.

**What made it.** A forked copy of the shipped tracker (`figs/fig8-bench/`) served over
the real module by a loader hook, so no app source was modified. The fork is **proved
equivalent**: with an empty method block it is byte-identical to the shipped tracker on
all 8 full sessions.

**Watch out — and this is a genuinely useful story for a meeting.** Panels 8a/8b/8c were
**removed** because 8e contradicted them. A threshold recommendation that looked like
**+0.084 IDF1 on 8 sessions** was **+0.012 mean / −0.001 median on 50** — 14 sessions
better, 11 worse, one damaged by 0.275. Same subset-reversal we'd already been bitten by
in Fig 4. The lesson to tell: *we stopped reporting a result of our own because the full
corpus didn't support it.*

---

## Fig 9 — "identity on the multi-animal SLAP-2M sessions"

**What it says.** Three rows over the 42 multi-animal SLAP-2M sessions: 9a the
distribution of identity precision, identity recall and cross-view IDF1; 9b the two
failure rates (ID switches, and mislabelled detections) per 100,000 camera-frames with
raw totals beside them; 9c where those failures live, by difficulty rating and animal
count.

**What made it.** Same harness as Fig 3, scored with motmetrics against proofread
ground truth.

**Watch out.** The "misgrouped detections" metric was **broken and has been fixed** —
it used to compare tracker IDs to ground-truth indices with no permutation, so about
48% of what it reported was a random-relabelling artefact. Every misgrouped number from
before that fix is retracted (they're crossed out in the notes). They are also
**detections, not frames**. And the two SLAP-2M detection pools disagree about this
metric, so never merge them: on the `predictions` pool the fresh anchor cuts mislabelled
mass 59%; on `keeptrack` the same change is flat-to-slightly-worse while switches still
fall 30%.

---

## Decoder: what `M1 + stale 20 + distThresh 25` means

This is the **best configuration we found**, and it's also called **"the fresh anchor"**
in the notes. It's three changes to the cross-view tracker. First, how the tracker
works normally:

> Each animal is a **3D target**. For each new frame the tracker goes camera by camera
> and matches that camera's detections to the existing targets by Hungarian assignment.
> The cost has two parts: a **2D term** (how far the detection is from where the target
> reprojects into that view, decayed by how old the target's information is) and a
> **3D term** (how far the target's 3D points are from the ray back-projected through
> the detection). Then it re-triangulates the targets from their matched detections.

### M1 — `sync` — "let all five cameras vote on the same evidence"

The tracker handles cameras **one at a time inside a single frame**
(`pose/cross-view-tracker.js:169`), and here is the problem: it builds the matching cost
from a target's 3D *as it stands right now* (`:191`), and the moment it matches a
detection it re-triangulates that target, changing the 3D (`:199`). So **camera 2 is
scored against a 3D that already contains camera 1's decision from the same frame.**

Two mice, A and B, close together, cameras processed `mid, topB, topC, sideL, sideR`:

1. `mid` gets it wrong and hands target A the detection that is really mouse B.
2. Target A re-triangulates immediately, so its 3D **jerks toward mouse B**.
3. `topB` is scored next — and target A now reprojects near mouse B, so `topB` picks B
   too, and it looks like a *good* match, because the evidence it is scored against is
   already corrupted.
4. By `sideR` the target has been dragged fully onto the wrong animal. One bad camera
   became five.

`sync` takes a **snapshot of every target's 3D at frame start**, scores all five cameras
against that frozen snapshot, and re-triangulates **once** at the end. In the same
scenario `mid` is still wrong, but the other four are scored against the pre-frame 3D
where A was still A, so they pick correctly — and the end-of-frame triangulation gets
four good rays and one bad one, which the DLT largely absorbs. **Four correct views
outvote one wrong one instead of following it.**

Say it as Gauss-Seidel vs Jacobi if the room is mathematical, or as five people voting:
in the shipped version each person hears the previous votes and updates their belief
(so if the first is wrong the rest follow); with `sync` everyone votes on the same
original evidence and you tally afterwards. It also removes an unpleasant property —
the shipped result depends on **camera order**, since the first camera always decides
against clean state and the last against the most-contaminated state.

One line per view, no new parameters. Worth about +0.027 IDF1 and −28 switches on its
own — real but small. Its value is mostly that it makes the other two changes work.

### `stale 20` — "stop fusing camera evidence from minutes ago"

This is the big one, and the mechanism is worth knowing exactly, because "the tracker
remembers old detections" sounds like a cache and it is not.

Each target holds **one slot per camera** — `detsByCam`, a map from camera name to a
single detection (`pose/cross-view-tracker.js:89`). A slot is written only when that
camera matches that target again (`:101`), and every match re-triangulates the target
from **whatever is in all of the slots** (`:106`, `:120`).

**Nothing ever deletes a slot.** There is no age check in that code path at all. So if
camera `sideL` loses the mouse at frame 1,000 and does not re-acquire it until frame
9,652, then for those 8,652 frames every re-triangulation fuses "where the mouse is
*now*, according to `mid`" with "where the mouse was at frame 1,000, according to
`sideL`". The DLT is handed rays that contradict each other and puts the point
somewhere in between — so the target's 3D anchor is a blend of the present and several
minutes ago, and every identity decision is scored against that blend. 8,652 frames is
a measured worst case in our data, not a hypothetical.

There is a second-order effect too. `frameIdxMean` averages the frame index of *every*
slot (`:94`), and that feeds the age decay of the 2D term via
`dt = det.frameIdx - target.frameIdxMean()` (`:215`). A stale slot drags the mean
backwards, so `dt` is larger than the target's real age and the 2D term gets decayed as
though the target were much older than it is.

`stale 20` is simply: **delete any slot older than 20 frames** before scoring and before
re-triangulating. On its own this cuts ID switches by about **75%** across all 50
sessions (p = 1.7 × 10⁻⁶). It is also why the change is not in the shipped app yet —
it alters how long a target keeps per-camera detections, which is real behaviour in a
shipped code path, not a threshold.

### `distThresh 25` — "require twice as much 3D agreement"
`distanceThreshold` is the **normaliser for the 3D term, in millimetres** — the app
default is **50 mm**. The term is `corr3d × (1 − d / distanceThreshold)`, so a detection
whose ray passes within the threshold scores positively and one beyond it scores
negatively. Halving it to 25 mm means a detection has to agree with the target within
25 mm instead of 50 to count as support. Stricter gate, fewer wrong matches.
*(Note: a Fig 3D legend line called this "25 px" — wrong unit, it's millimetres in world
space. Fixed today.)*

**What the three together buy:**

| corpus | switches | cross-view IDF1 |
|---|---|---|
| Mouse-Dyad-10M 50 sessions, shipped | 2,071 | 0.7493 |
| Mouse-Dyad-10M, **M1 + stale 20 + distThresh 25** | **413** | **0.8613** |
| SLAP-2M 42 multi-animal, shipped | 3,094 | 0.7040 |
| SLAP-2M, same configuration | **1,312** | 0.7212 |

**Two honest caveats.** (1) **It is not in the shipped app.** `stale` is a change to how
long a target keeps per-camera detections — real code in a shipped path — and the Track
All button can't express it today. Anything showing it is labelled EXPERIMENTAL. (2)
**6 of 50 sessions get worse** under the aggressive variant, the worst going 0.717 →
0.579, even though its switch count falls. Quote the per-session table, not just the
mean.

**Other names you'll hear.** `corr2d` / `corr3d` are the weights on the two cost terms,
and only their **ratio r = corr3d/corr2d** matters; the shipped default is **r = 6**. We
tested **r = 12** and **rejected** it: a 10% switch reduction on Mouse-Dyad-10M only, no IDF1
gain anywhere, and it badly harms two individual sessions. "M2, M3, M4…" are the other
candidate methods we tried and mostly discarded — cross-view bundling was 70× worse,
and skeletal re-identification was at chance because the mice are the same strain and
between-animal body differences (~2 mm) are smaller than our triangulation noise.

---

## Glossary of the metrics

- **IDF1** — the standard multi-object-tracking identity score, 0 to 1. It measures
  whether the *same animal keeps the same label over time*, not whether boxes overlap.
  It punishes both mislabelling and breaking a track into pieces.
- **IDP / IDR** — the precision and recall halves of IDF1. Useful when you want to know
  whether a change fixed labels (precision) or coverage (recall).
- **ID switch** — the tracker swaps two animals' labels. On our data these are mostly
  **permanent**: 98.6% of the identity loss is a swap that never gets undone, so ten
  switches can cost 0.311 IDF1.
- **Fragmentation** — the track breaks and later resumes with a *new* label. Not a
  swap. Costly for proofreading, because a human has to bridge every gap.
- **Within-view vs cross-view** — within-view scores each camera separately and averages;
  cross-view pools all cameras into one accumulator and asks whether identity is
  consistent *across* them. The gap between them is the whole point of Fig 7.
- **Camera-scoped pooling** — when pooling cameras, a per-camera tracker's `track_0` in
  camera A is treated as a **different** identity from `track_0` in camera B, because it
  did nothing to earn the link. Scoring them as the same identity inflates baselines
  through shared numbering alone, and we caught ourselves nearly publishing a 1.4×
  "correction" that was entirely this convention change.
- **Detection pool** — every tracker in these comparisons is fed the *same*
  identity-stripped detections, so the comparison is about association, not detection.
  SLAP-2M has two such pools (`predictions` and `keeptrack`) that give different
  absolute numbers (0.74 vs 0.90 within view) — never mix them in one claim.

---

## What's in flight tonight (as of 2026-08-13 ~21:00 UTC)

We found that **both** per-camera baselines on Mouse-Dyad-10M were run in configurations that
guarantee the fragmentation they were then penalised for, while LUC3D's arm is
constrained to 2 identities by construction. That's our defect, not theirs, so both are
being re-run:

- **SLEAP.** The old run passed `--tracking_target_instance_count 2`, which caps
  instances **per frame**, not the number of tracks — so it produced a median of **47.5
  tracks** per camera-session over 180,000 frames. The real cap is `--max_tracks`, and
  it only works with `--candidates_method local_queues`. Re-running with the cap
  enforced; verified 2 tracks exactly on the pilot. Results ~02:30–03:00 UTC.
- **ByteTrack — DONE, all 50 sessions.** Its buffer was set to retire a lost track after
  **60 frames (2 s)** on three-hour sessions. Final:

  | arm | within view | across cameras | retention | ID switches |
  |---|---|---|---|---|
  | as shipped | 0.157 | 0.046 | 0.29 | 27,813 |
  | its own never-retire knob | 0.272 | 0.079 | 0.29 | 11,330 |
  | + a 2-identity constraint | **0.676** | **0.157** | **0.23** | 5,809 |
  | LUC3D, for comparison | 0.749 | 0.749 | **1.00** | 2,071 |

  Corroborated independently: the audit had already found the same files score 0.56 on a
  20,000-frame window. Two different routes to ~0.6.

**This is the sentence to lead with, and it is better than the one we had.** Configured
fairly, ByteTrack is *nearly as good as us within a single camera* — the gap falls from
4.8× to **1.11×**. But across cameras it is still **4.8×** behind, and its
within→cross **retention gets slightly worse** (0.29 → 0.23), because a better
within-view score has further to fall when you pool the cameras. LUC3D keeps 100% of its
score.

So the contribution is not "we track better in each camera" — we barely do, once the
baseline isn't handicapped. It is **"one animal, one identity, in every camera, and no
per-camera tracker can do that however good its within-view number is."** That claim got
*stronger* by fixing the baseline, which is the best possible outcome of an audit like
this.

One labelling rule: the 0.272 arm is **ByteTrack** (its own knob). The 0.676 arm is
**ByteTrack plus a 2-identity constraint we wrote** — no ground truth, but our
post-processing improving a competitor. Say both. The constraint is trivial, and that is
exactly why it matters that 0.157 was ever published as ByteTrack's identity capability.
