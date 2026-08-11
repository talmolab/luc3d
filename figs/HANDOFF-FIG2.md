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
- The old stride-200 deposit is preserved at `figs/out/fig2.stride200.json`. Do not
  delete it; it is the before value for every number in `REVISION-LOG.md`.

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

```bash
cd <repo>/figs
mkdir -p /scratch/fig2/s1
cp offbox/fig2/shards/*.json /scratch/fig2/s1/        # resume: 25 already done

NPROC=12 MIN_AVAIL_GB=80 STRIDE=1 \
  /path/to/python offbox/fig2/fig2_launch.py
```

The launcher writes one JSON per session into its output directory and logs beside it.
It is safe to stop and restart at any point.

When all 56 shards exist, merge them into the deposit the panels read:

```bash
/path/to/python offbox/fig2/fig2_merge.py            # writes out/fig2.json
/path/to/python offbox/fig2/fig2_report.py           # prints the headline numbers
```

`fig2_merge.py` must reproduce the schema the panels read. Verify against the preserved
stride-200 file before trusting it:

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

## One thing to watch

The referee's point is about the denominator, so whatever comes back, the honest
reporting is the one that states sessions, animals and frames used against available.
BMimica is **9 individual mice in 18 pairings**, not 100-odd animals, and running every
frame does not change that; it removes the frame-sampling objection only. Both facts
belong in the Methods paragraph together.
