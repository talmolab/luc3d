# Handoff: Fig 3 benchmarking for the LUC3D paper

You are producing **measurements only** — five JSON files. Someone else is drawing the
figure and will read your JSON. Stick to the schemas at the bottom exactly; a renamed
key silently breaks the figure.

## Hard rules

1. **Do not modify any application source.** Not `pose/`, `ui/`, `loading/`,
   `import-export/`, `lib/`. You may add files under `figs/` and
   `scratch/` only. If a measurement seems to need an app change, write the reason into
   your output JSON under `blocked` and move on.
2. **Do not touch other git branches or worktrees.** `eric/bundle-adj` and
   `eric/id-switch-timeline` are other people's in-flight work. Read-only at most.
3. **Never invent a number.** If a run fails or is too slow, emit
   `{"status": "failed", "why": "..."}` for that cell. A missing cell is fine; a
   plausible-looking fabricated one is not. The figure prints `n` and marks gaps.
4. **Report honestly in your final message**: which tasks completed, which partially,
   which not at all, and every caveat a reviewer would raise.
5. Commit nothing. Leave changes uncommitted for review.

## Environment

```bash
REPO=/root/vast/eric/sleap-3d-gui/scratch/repos/lucid       # branch eric/figs
BENCH=/root/vast/eric/luc3d-bench
PY=$BENCH/lp3d_env/bin/python        # has cv2, h5py, numpy, scipy, toml, motmetrics
# Node: playwright is installed GLOBALLY and Node's ESM resolver ignores NODE_PATH.
# A node_modules/playwright symlink already exists at scratch/repos/ (an ancestor
# dir), so `import 'playwright'` resolves from inside $REPO. Do not add node_modules
# to the repo.
```

Write all outputs to `$REPO/figs/out/`. That directory is gitignored.

## Background you need

LUC3D is a browser-based multi-camera 3D pose annotation/proofreading GUI. Fig 3 argues
that its **cross-view association is both tractable and accurate**, and that it answers
an open question posed by:

> Maree, Afshar, Oline, Leonardis, Falkner & Pereira (2024). *Multi-view
> triangulation-enabled annotation for multi-animal 3D pose in SLEAP.* Proceedings of
> Measuring Behavior 2024 (13th Intl. Conf. on Methods and Techniques in Behavioral
> Research), Aberdeen, 217–224.

That paper solves multi-view instance association by **exhaustive hypothesis testing**:
enumerate every assignment of the instances in each view into identity groups,
triangulate and reproject each whole-frame hypothesis, and keep the one with the lowest
reprojection error. Its cost, from the paper's own Figs 4–6:

- per view: `A!` hypotheses for `A` animals;
- per frame: `(A!)^C` for `C` cameras — **factorial in animals, exponential in cameras**.

Its "Future directions ▸ Faster multi-view association" proposes a **greedy** variant
that hard-commits each view's assignment as it goes. LUC3D implements exactly that, as
one **Hungarian assignment per camera per frame**, each mutating the shared target list
before the next camera — cost `O(C · A³)`.

Careful, two different components share a name: `pose/cross-view-tracker.js` is a port
of Maree's *temporal* `CrossViewTracker` from `talmolab/sleap-3d`. The method under
comparison here is the *annotation-time association* from the 2024 paper. Credit Maree
for both the exhaustive method and the greedy idea; the contribution being measured is
that greedy is sufficient.

The association cost LUC3D minimises (`_adjacency2d` + `_adjacency3d` in
`pose/cross-view-tracker.js`), for target *t*, detection *d*, node *k* with weight
*w<sub>k</sub>*:

- 2D: `w_k · corr2d · (1 − ‖d_k − π(t_k)‖ / (velThresh·(1+Δt))) · e^(−timePenalty·Δt)`
- 3D: `w_k · corr3d · (1 − dist(t_k, ray(d_k)) / distThresh)`

in **normalised** camera coordinates (`K⁻¹` applied, undistorted), with the bare
extrinsic `[R|t]` as projection matrix. Cost = −adjacency. Defaults `corr2dWeight = 1`,
`corr3dWeight = 6`, `velocityThreshold = 10`, `distanceThreshold = 50`,
`timePenalty = 0.1`. Thresholds are **soft** (they drive the term negative), not gates.
`velocityThreshold` is in normalised image units, so the 2D term largely saturates and
`corr3dWeight` is the meaningful knob — which is why 6 matters and is worth a panel.

**Metric: IDF1 + ID-switches, not HOTA.** Nothing in luc3d-bench computes HOTA and the
`corr3dWeight = 6` champion claim was established on IDF1. Do not switch metric. Use
the existing evaluator; do not write a new one.

## Existing machinery — read before writing anything

- `$REPO/scripts/bench/bench_crossview.mjs` — headless driver for the real tracker on
  one session. Loads the actual `pose/` modules with UI stubbed via
  `scripts/bench/hooks.mjs`, drives `runCrossViewTracker()` as `trackAll()` does, and
  emits JSON in luc3d-bench's `luc3d_results` format including `runtimeSeconds`,
  `framesProcessed`, `fps`. Flags: `--session-idx --num-animals --calibration
  --pred-h5-dir --out --cameras --num-animals --max-frames --no-exclude-tail`.
  **Note:** its sibling on the `eric/bundle-adj` branch is broken (missing
  `getDefaultTriangulationMethod` in the stub). On `eric/figs` it should be fine —
  verify with one smoke run before launching a sweep.
- `$BENCH/scripts/evaluate.py` — scores a results dir against GT (IDF1, switches).
- `$BENCH/scripts/bartul/cross_view_metric.py` and
  `$BENCH/scripts/crossview_hardsession.py` — the pooled cross-view IDF1 construction.
  Reuse, don't reinvent.
- `$BENCH/outputs/_multi_master.tsv` — 42 SLAP-2M sessions with columns
  `session, session_path, white_mice, agouti_mice, black_mice, animals,
  obstacle_rating, bedding, frames, duration, difficulty, points_3D`, plus per-camera
  `{cam}_inference_h5 / {cam}_reproj_h5 / {cam}_video` for
  `back backL mid midL side sideL top topL`. `difficulty` is 2–7.
- `$BENCH/outputs/keeptrack_h5s`, `$BENCH/outputs/detections_only_h5s` — shared
  detection pools. **Every tracker must be fed the identical detections**; that is the
  benchmark's fairness rule.
- `$BENCH/outputs/bmimica/gt/{session}/{serial}/proofread.analysis.h5` — BMimica GT.
- `$BENCH/outputs/subgroup_7_7_2026/README.md` — **read this first.** It documents the
  existing benchmark design, the two IDF1 variants, the structural 1/C ceiling for
  per-camera trackers, and the "what a reviewer will ask" caveats. Your work must be
  consistent with it.

Reference numbers already established (SLAP-2M hardest session, 4 animals, 6 cameras):
LUC3D within-view IDF1 0.709 / cross-view 0.707, 154 switches; SLEAP 0.391/0.103;
ByteTrack 0.187/0.044; 3D-MuPPET 0.069/0.069. On 50 BMimica sessions LUC3D is
0.749/0.749 with 2,071 switches. If your runs disagree materially with these, say so
loudly rather than quietly overwriting the story.

---

# Task 1 — `corr2d` × `corr3d` grid (highest priority)

Substantiates "6 was the benchmark champion". Sweep `corr3dWeight` over
`[0, 0.5, 1, 2, 4, 6, 8, 12]` × `corr2dWeight` over `[0.5, 1, 2]` (24 cells), holding
everything else at defaults, on a **fixed set of sessions** (start with 6–8 BMimica
sessions; add SLAP-2M if time allows). For each cell record within-view IDF1,
cross-view IDF1, and total ID-switches.

Run `corr3d = 0` — it is the "no 3D term at all" control and the panel needs it.

Use `bench_crossview.mjs` with the threshold override mechanism its hooks already
expose (`globalThis.__BENCH.thresholds`, populated from `--params`; read the driver to
confirm the exact flag). Score with `$BENCH/scripts/evaluate.py`.

→ `figs/out/fig3_sweep.json`

# Task 2 — runtime and complexity

Measure real LUC3D wall-clock per frame as a function of `(C, A)`:

- `C` from 2 to 8 by taking real camera subsets (SLAP-2M has 8: `back backL mid midL
  side sideL top topL`).
- `A` from the sessions available (BMimica 2; SLAP-2M 2, 3, 4).

At least 500 frames per cell; report `seconds_per_frame` and the frame count. Keep the
detection pool fixed across cells so you are measuring association, not decoding.

Also compute the analytic exhaustive cost `(A!)^C` for the same grid — that is exact
arithmetic from the paper, not a measurement, and must be labelled `analytic` in the
output.

→ `figs/out/fig3_runtime.json`

# Task 3 — greedy vs exhaustive, head to head (the panel that answers the paper)

Implement exhaustive hypothesis testing **exactly as the paper describes**, in
`figs/fig3_exhaustive.mjs` (new file; do not touch `pose/`):

1. For a frame, for each view, enumerate all `A!` assignments of that view's instances
   into the `A` identity groups.
2. Enumerate all `(A!)^C` whole-frame combinations of per-view hypotheses.
3. For each combination: triangulate every group (reuse the app's
   `triangulatePoints`/`triangulateAndReproject` from `pose/triangulation.js` —
   import it, do not copy it) and sum the reprojection error over all views.
4. Pick the minimum-error combination.

Then compare, on **identical detections**, per frame: does greedy pick the same
grouping as exhaustive? Report agreement rate, and IDF1/switches for both.

Feasible where `(A!)^C` is small: 2 animals × 5 cameras = 2⁵ = **32**; 2 × 8 = 256;
3 × 5 = 6⁵ = 7,776. Intractable at 4 × 6 = 24⁶ ≈ 1.9 × 10⁸ — **do not attempt it**;
record it as `intractable` with the computed hypothesis count. That contrast is the
point of the panel.

Cap total hypotheses per frame at 10⁶ and frames at a few thousand; report what you
capped.

→ `figs/out/fig3_headtohead.json`

# Task 4 — identity continuity over full sessions

From real LUC3D runs on full-length sessions: distribution of continuous track
lengths (frames), the fraction of frames on which each GT animal's identity is
sustained correctly, and where switches cluster. For the clustering, report switch rate
against inter-animal distance (proximity is a proxy for occlusion-heavy interaction) —
compute inter-animal distance from the proofread 3D. Do **not** label behaviours;
there are no behaviour annotations.

→ `figs/out/fig3_continuity.json`

# Task 5 — accuracy vs scale

IDF1 (within and cross-view) as animal count and camera count increase, marking which
configurations exhaustive could not compute. Reuse Task 2's grid and Task 3's
tractability boundary.

→ `figs/out/fig3_scale.json`

---

# Output schemas

Every file must include this envelope:

```json
{
  "generated_by": "<script path>",
  "dataset": "BMimica | SLAP-2M | both",
  "detection_pool": "<path to the shared pool used>",
  "sessions": ["<id>", "..."],
  "metric": "IDF1 (motmetrics) + ID-switches",
  "caveats": ["free text, one per honest limitation"],
  "blocked": ["anything you could not do, and why"]
}
```

plus a payload:

**fig3_sweep.json** — `"cells": [{ "corr2d": 1, "corr3d": 6, "idf1_within": 0.0,
"idf1_cross": 0.0, "switches": 0, "n_sessions": 0, "status": "ok|failed", "why": "" }]`

**fig3_runtime.json** — `"measured": [{ "cameras": 5, "animals": 2,
"seconds_per_frame": 0.0, "frames": 0, "session": "", "status": "ok|failed" }]`,
`"analytic_exhaustive": [{ "cameras": 5, "animals": 2, "hypotheses": 32 }]`

**fig3_headtohead.json** — `"frames_compared": 0`, `"agreement_rate": 0.0`,
`"greedy": {"idf1_within":0,"idf1_cross":0,"switches":0}`, `"exhaustive": {...}`,
`"configs": [{ "cameras": 5, "animals": 2, "hypotheses": 32,
"status": "ok|intractable", "seconds_per_frame_exhaustive": 0.0 }]`,
`"caps": {"max_hypotheses_per_frame": 1000000, "max_frames": 0}`

**fig3_continuity.json** — `"track_lengths_frames": [ ... ]` (or a histogram
`[{"lo":0,"hi":10,"count":0}]` if the raw list is huge),
`"sustained_identity_fraction": [{"session":"","animal":0,"fraction":0.0}]`,
`"switch_rate_by_distance": [{"lo_mm":0,"hi_mm":50,"switches":0,"frames":0}]`

**fig3_scale.json** — `"points": [{ "cameras": 5, "animals": 2, "idf1_within": 0.0,
"idf1_cross": 0.0, "exhaustive_computable": true, "hypotheses": 32 }]`

## Priority if you run short on time

1, 3, 2, 5, 4. Task 1 substantiates a claim already in the paper; Task 3 is the novel
result. Partial coverage with honest `n` beats broad coverage with invented cells.

## Finally

In your closing message: what ran, what didn't, every caveat, and any place where your
numbers contradict the reference numbers above. Do not smooth over disagreements —
they are more useful than agreement.
