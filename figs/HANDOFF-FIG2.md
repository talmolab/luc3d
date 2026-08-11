# Handoff: Figure 2 re-measured at every frame

This is the job that was bogging down the box: 14 worker processes holding **138.6 GB
of RAM**, about 10 GB each, 85 per cent of everything running. It was stopped here on
2026-08-11 at 22:35 UTC with **25 of 56 sessions finished**, and it is resumable, so
another machine can pick up the remaining 31 without redoing any of it.

Repo commit: `6063985` on branch `eric/figs`.

---

## What the job is and why it is being re-run

`figs/fig2_measure.py` produces `figs/out/fig2.json`, which is the whole of Figure 2:
the reprojection error in views that were not labelled, the manual-placement saving, and
the anchor-pair geometry. It has always been run at `--stride 200`, that is 901 of the
180,199 frames in each session, and a referee objected that the paper's corpus-scale
claims rest on 0.5 per cent of the data (`REVIEW-REVIEWER2.md`, item 1). This run is the
same measurement at **stride 1, every frame**.

A convergence check already suggests the answer will not move much: at stride 20 on
three sessions, every reported quantity shifted by under 1 per cent (median held-out
error by 0.31 per cent, the 3D error at four anchors by 0.77 per cent). Finishing the
full run turns that from an indication into the actual number, which is what the referee
asked for.

## State as of the handoff

- **25 sessions complete.** Their per-session results are committed at
  `figs/offbox/fig2/shards/<session>.json`, one file per session, about 20 KB each.
- **31 sessions remaining**, roughly 8 to 30 minutes each at 12-way parallelism on a
  loaded 64-core box, so expect a few hours.
- The launcher **skips any session that already has a shard**, so restarting is safe and
  idempotent. Copy the existing shards into the output directory first and it will only
  run what is missing.
- **31 directories remain, of which 25 are runnable**; the other six
  (`20250908_152229`, `154926`, `161812`, `164528`, `171240`, `173928`) skipped at
  stride 200 for missing inputs and will skip again. The published figure is 50
  sessions, not 56.
- The old stride-200 deposit ships with this handoff at
  `figs/offbox/fig2/fig2.stride200.json`. It is the before value for every number in
  `REVISION-LOG.md` **and** `fig2_merge.py`'s schema check reads it, so it has to
  travel; the copy in `figs/out/` is gitignored and will not be in a fresh clone.

## What travels

Per session the measurement reads the proofread 3D, the five per-camera analysis files
and the calibration, which is **about 438 MB per session, roughly 22 GB for all 56**.
The 205 GB BMimica tree does not need to move.

```
/root/vast/eric/BMimica/<session>/*points3d*.h5              124 MB
/root/vast/eric/BMimica/<session>/<serial>/*.analysis.h5     58 MB x 5 cameras
/root/vast/eric/BMimica/<session>/calibration/*.toml         a few KB
```

If the target machine can mount `pool1.vast.salk.edu:/talmo`, nothing needs copying.
The five camera serials are `21241563 21369048 21372315 21372316 22085397`.

## Environment

`fig2_measure.py` needs **OpenCV**, which the figs venv does not have. On this box the
working interpreter is:

```
/root/vast/eric/luc3d-bench/liezl_env/bin/python     # cv2 4.13.0, h5py, numpy
```

Elsewhere: Python 3.10+ with `opencv-python`, `h5py`, `numpy`, `scipy`. No GPU. No Node.

## Memory, which is the reason this is being moved

A stride-1 session peaks near **16 GB** in a single process. The launcher caps
concurrency and gates on free memory (`MIN_AVAIL_GB`, default 80) so it cannot drive a
shared machine into swap. Size `NPROC` against the target box: at 16 GB per worker,
12 workers wants roughly 200 GB of headroom. If the machine has less, lower `NPROC`
rather than the stride.

## Run

Every path the scripts need is overridable by an environment variable, so nothing has to
be edited. The defaults are this box's paths; if vastlrn mounts the same VAST share at
the same locations, the defaults already work and you can set none of them.

| variable | what it is | default |
|---|---|---|
| `FIGS_DIR` | the repo's `figs/` directory, which holds `fig2_measure.py` | this box's path |
| `FIG2_PY` | interpreter with OpenCV, h5py, numpy | `luc3d-bench/liezl_env/bin/python` |
| `BMIMICA_ROOT` | the corpus; read by the launcher AND by the measurement | `/root/vast/eric/BMimica` |
| `LUC3D_BENCH_SCRIPTS` | bench helpers the measurement imports | `luc3d-bench/scripts/bartul` |
| `OUTDIR` | where per-session shards land, and what makes it resumable | `<script dir>/s1` |
| `NPROC` | concurrent sessions | 12 |
| `MIN_AVAIL_GB` | refuses to launch below this much free memory | 80 |

**Check the machine first.** `DRY_RUN=1` prints the resolved paths, says whether each
exists, and lists what it would run, then exits without launching anything:

```bash
cd <repo>/figs/offbox/fig2
mkdir -p s1 && cp shards/*.json s1/          # resume: 25 already done

DRY_RUN=1 OUTDIR=$PWD/s1 python fig2_launch.py
```

Expect it to report `56 sessions found, 25 already done, 31 pending`. If it says 56
pending, the shards were not copied into `OUTDIR` and you are about to redo three hours
of finished work. If it says 0 sessions found, `BMIMICA_ROOT` is wrong.

Then run it for real by dropping `DRY_RUN`:

```bash
OUTDIR=$PWD/s1 NPROC=12 MIN_AVAIL_GB=80 python fig2_launch.py
```

The launcher writes one JSON per session into `OUTDIR` with a log beside it, and is safe
to stop and restart at any point.

When all 56 shards exist, merge them into the deposit the panels read:

```bash
/path/to/python offbox/fig2/fig2_merge.py            # writes out/fig2.json
/path/to/python offbox/fig2/fig2_report.py           # prints the headline numbers
```

**`fig2_merge.py` has been tested** against the 25 shards: a recursive key and type diff
against the stride-200 deposit came back `missing=0 extra=0 differ=0`, and the exact
computations of all three fig2 panels were run over the merged file and resolved. What is
untested is only the 50-session case, which differs from 25 by list length alone.

Run it with the **bench interpreter, not `figs/.venv`**: it imports `fig2_measure`, which
imports `cv2`. Verify anyway before trusting it:

```bash
python -c "
import json
a=json.load(open('out/fig2.stride200.json')); b=json.load(open('out/fig2.json'))
assert set(a)==set(b), set(a)^set(b)
assert set(a['per_session'][0])==set(b['per_session'][0])
print('schema matches;', len(b['per_session']), 'sessions')"
```

## What to send back

`out/fig2.json` (about 1 MB) and the shard directory. Then, on the figure box:

```bash
.venv/bin/python panels/fig2_02_placements_vs_rig.py
.venv/bin/python panels/fig2_03_reprojection_accuracy.py
.venv/bin/python panels/fig2_04_baseline_angle.py
.venv/bin/python assemble.py 2
.venv/bin/python lint_text.py 2      # must end at 0 issues
```

## The numbers I need for the manuscript

Old value then new, so `REVISION-LOG.md` and the Methods, Results and legend text can be
updated in one pass:

- sessions, frames used per session and in total, total keypoints
- held-out reprojection median in px, and the fractions at or below 5, 10 and 20 px
- the fraction outside the 10 px tolerance (the paper currently says 5.4 per cent)
- the placements saving (currently 2.3-fold, 75 to 32) and the depth constant k
  (currently 1.52 mm) and the all-five-view floor (currently 1.2 mm)
- counts of two-anchor solves and held-out view measurements

## What the partial run already shows

Comparing the same 25 sessions at stride 200 against stride 1, that is 632,924 keypoints
against 126,370,428, a 200-fold increase, **nothing moves**:

| quantity | stride 200 | stride 1 |
|---|---|---|
| held-out median | 3.3685 px | 3.3719 px |
| at or below 10 px | 96.330% | 96.303% |
| outside the 10 px tolerance | 3.670% | 3.697% |
| placements saving at C = 5 | 2.370x | 2.369x |
| depth constant k | 1.4314 mm | 1.4145 mm |
| all-five-view floor | 1.2159 mm | 1.1880 mm |

Every headline agrees to under 1 per cent, the largest movement anywhere being the floor
at 2.3 per cent. These absolute values are a 25-session subset and are not the
manuscript's numbers; the stride-200 column is the like-for-like control. The full run is
therefore expected to confirm rather than revise, which is itself the answer to the
referee: the 0.5 per cent sample was unbiased.

Measured cost, from a session run alone on an idle box: 13.0 s at stride 200, 91.3 s at
stride 20, 359.4 s at stride 5, linear in frames, extrapolating to about 1,780 s and
15.7 GB at stride 1. Observed at 12-way: median 38 min per session, 10.4 to 12.6 GB per
worker, no failures in 25 sessions.

One session is anomalous and it is pre-existing, not a stride artefact: `20250904_140306`
retains only 18 per cent of its keypoints because few match in all five views, at both
strides (0.179 and 0.180), with the same held-out median. It is in the published 50
either way.

## One thing to watch

The referee's point is about the denominator, so whatever comes back, the honest
reporting is the one that states sessions, animals and frames used against available.
BMimica is **9 individual mice in 18 pairings**, not 100-odd animals, and running every
frame does not change that; it removes the frame-sampling objection only. Both facts
belong in the Methods paragraph together.
