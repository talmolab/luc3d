# Handoff: jobs worth running on another machine

Written 2026-08-11 while three full-data reruns saturate this box (load 80 on 64
cores). Only one job here genuinely needs different hardware; the rest are listed so
that the decision is on the record rather than re-made from scratch later.

Repo commit at time of writing: `ade6367` on branch `eric/figs`.

---

## The short answer

**One job is worth moving: measuring the four-animal, six-camera exhaustive
configuration.** It is the single weakest point in the paper, it is currently not
measured at all, and it is embarrassingly parallel across frames, so it is exactly the
shape of job another machine solves. Everything else either finishes here or is
bottlenecked on something a different machine does not fix.

---

## Job 1: measure the 4-animal, 6-camera exhaustive configuration (HIGH VALUE)

### Why this one matters

The referee's third major objection (`REVIEW-REVIEWER2.md`, item 3) is that the paper's
headline speed claim rests on a configuration that was never run. Figure 3F draws that
point as an open marker at an arithmetic lower bound, because (4!)^6 = 191,102,976
hypotheses per frame exceeds the harness's one-million cap by a factor of 191 and zero
frames were computed. Every other point on that panel is measured.

Running even a handful of frames converts the paper's most contestable number from an
extrapolation into a measurement. That is a bigger gain per compute-hour than anything
else on this list.

### The arithmetic, so the budget is not a guess

Two variants are worth running, and they differ by 55-fold:

| variant | hypotheses per frame | measured rate | cost per frame |
|---|---|---|---|
| as published, no symmetry reduction | 191,102,976 | 565 us | about 30 core-hours |
| with the A!-fold relabelling symmetry removed | 7,962,624 | 244 us | about 0.54 core-hours |

The reduced variant is what the paper's lower bound already assumes, and the published
procedure does not exploit it. Measuring both is the honest thing to do: the reduced
number replaces the plotted bound with a measurement, and the un-reduced number tests
whether the 565 us rate, which was measured at five cameras and two or three animals,
holds at six cameras and four animals. My expectation is that it does not and that the
real rate is higher, which would mean the paper currently understates exhaustive's cost.

Suggested target: **20 frames reduced (about 11 core-hours) and 8 frames un-reduced
(about 240 core-hours)**. On 64 dedicated cores that is roughly 10 minutes and 4 hours
respectively, assuming one frame per process.

### What has to change in the code first

`figs/fig3-bench/fig3_exhaustive.mjs` takes `--max-frames` but has no way to start at
an offset, so frames cannot currently be split across processes. Add a `--start-frame`
option next to it (line 67 area, `o.maxFrames`) and apply it where `frameLimit` is
computed around line 203. That is the only change required; do not touch the geometry
or the scoring.

Also raise the cap on the command line: `--max-hypotheses 200000000`. The cap is a
safety rail, not a result, and leaving it at the default is what makes the run a no-op.

### Data it needs, and how little it is

This is why the job is portable: the four-animal SLAP-2M sessions use the shared
detection pool, not the raw video.

| path | size | needed |
|---|---|---|
| `/root/vast/eric/luc3d-bench/outputs/keeptrack_h5s` | 1.7 GB | yes, the detection pool |
| `/root/talmolab-smb/eric/slap_2m/<date>/<session>/calibration.toml` | a few KB each | yes |
| `figs/fig3-bench/` including `node_modules` | small | yes |
| the 1.1 TB SLAP-2M video tree | 1.1 TB | **no** |
| the 205 GB BMimica tree | 205 GB | **no** |

So the whole job travels in under 2 GB. If the target machine can mount
`pool1.vast.salk.edu:/talmo` and the SMB share, nothing needs copying at all.

The three four-animal sessions, all from 2022-10-07:

```
10072022145420   18,255 frames   difficulty 4   black bedding
10072022150448   19,142 frames   difficulty 4   black bedding
10072022151549   18,200 frames   difficulty 4   black bedding
```

Six proofread cameras: `back,backL,mid,midL,top,topL`.

### Environment

Node 26 (this box runs v26.5.0). No Python needed for this job.

### Run

```bash
# one process per frame; NF frames starting at F0, one session at a time
SESSION=10072022145420
CALIB=/root/talmolab-smb/eric/slap_2m/2022-10-07/$SESSION/calibration.toml
POOL=/root/vast/eric/luc3d-bench/outputs/keeptrack_h5s

for F in $(seq 0 19); do
  node figs/fig3-bench/fig3_exhaustive.mjs \
    --session-idx 0 --num-animals 4 \
    --calibration "$CALIB" --pred-h5-dir "$POOL" \
    --cameras back,backL,mid,midL,top,topL \
    --start-frame $F --max-frames 1 \
    --max-hypotheses 200000000 \
    --out out/a4c6_frame_$F.json &
done
wait
```

Run the reduced variant first: it is 55 times cheaper and tells you whether the harness
works at this scale before you spend the larger budget. If the reduced variant is not
implemented in the driver, run the un-reduced one and note that the reduction is an
arithmetic division rather than a separate run.

### What to send back

The per-frame JSONs. Each carries the frame's hypothesis count, elapsed seconds and the
chosen grouping. What I need from them is: **seconds per frame, seconds per hypothesis,
and whether the chosen grouping matches LUC3D's on those frames.** Drop them in
`figs/out/a4c6/` and tell me; I will fold them into `fig3_headtohead.json`, redraw
Figure 3F with a measured point instead of an open marker, and update
`REVISION-LOG.md`, `METHODS`, `RESULTS` and the legend.

### How to know it worked

A run that reports `capped: true` or computes zero frames means the
`--max-hypotheses` flag did not take. A per-hypothesis rate wildly below 244 us means
the frame was skipped rather than solved; check that every camera in that frame holds
exactly four detections, since the procedure is undefined otherwise and the harness
will silently skip.

---

## Job 2: the aniposelib optim arm at full density (MEDIUM VALUE, MEMORY-BOUND)

`figs/fig4_anipose.py`'s `optim_points` arm is one global least-squares per session, so
both its time and its memory grow with the points per session. At the current stride-60
sampling it is fine; at every frame it is 60 times the points and may not fit. An agent
is measuring exactly this right now and will report the arithmetic.

**A different machine helps here only if it has more RAM per core**, and this box has
500 GB, so probably not. If the agent reports that the arm cannot run at full density
here, the honest options are to report that arm at a stated lower density or to drop the
non-linear pair, not to chase it onto other hardware. Wait for that report before
acting.

Environment note if you do run it: **aniposelib must be 0.7.2**, which lives in
`/root/vast/eric/luc3d-bench/anipose_env`. Two other envs on this box
(`eks_env`, `lp3d_env`) carry 0.8.0, the JAX rewrite, which is a different program with
different performance. `fig4_anipose.py` asserts the version and refuses to run against
a JAX build; do not defeat that check.

---

## Jobs NOT worth moving

**Figure 2 at every frame.** Running here, embarrassingly parallel per session, and will
finish. Another machine would only add coordination overhead.

**Figure 6 at every frame.** Already done: 187,134,382 comparisons in 79 seconds once
parallelised. It never needed more than a `--jobs` flag.

**The 2-animal exhaustive configurations.** Already extended to all available sessions
by the agent running now (35 two-animal SLAP-2M sessions and the BMimica set).

**Anything reading the 205 GB BMimica or 1.1 TB SLAP-2M video trees.** These are on
network mounts (`pool1.vast.salk.edu:/talmo` and `//multilab-na.ad.salk.edu/talmodata`).
Moving compute to a machine without those mounts means moving terabytes, and the jobs
are I/O bound rather than CPU bound, so a faster CPU buys nothing.

---

## If you want a second machine to help right now

The cleanest split is by figure, because the deposits are per-figure files and will not
collide:

- **This box** keeps Figures 2, 3 and 4 (already running, 1.5 hours in; killing them
  wastes that).
- **Other box** takes Job 1 above, which touches only `out/a4c6/` and nothing any
  running job writes.

Do not run two processes that write the same `figs/out/*.json`. The one hazard already
found in this repo is exactly that: `fig6_measure.py` and `fig6_pose.py` share
`out/fig6.json`, and the former used to delete the latter's keys silently. Check for a
shared deposit before parallelising anything new across machines.
