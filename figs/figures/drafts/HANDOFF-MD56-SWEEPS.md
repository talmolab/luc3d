# Handoff: the Fig 3G/H sweeps on all 56 Mouse-Dyad-10M sessions (md56)

Written 2026-10-14 for a Claude session on Eric's `ericmimicc` interactive job. The main
box is running the rest of the md56 rerun (plan: `MOUSEDYAD-56-RERUN-PLAN.md` in this
folder). **This job runs ONE thing:** the two arms of the corr3d/corr2d sweep behind Fig 3G/H,
over all 56 sessions. It is accuracy only, with no timing, so the machine it runs on does not
matter.

## What it does

`figs/fig3_sweep50.py` tracks each session at 12 values of r = corr3d/corr2d, then scores it
tail-free against proofread ground truth. There are two arms, which run side by side:

- **fresh**: `{"sync":true,"stale":20}` + `distanceThreshold 25`. This is the current tracker.
- **shipped**: the pre-#210 "previous default". It is pinned to `distanceThreshold 50` inside
  `fig3_sweep50.py`; do not change that.

Tracker outputs are cached per session in `figs/out/tmp/sweep50/<tag>/`. The 50 old sessions
are already cached, so only the 6 new 2025-09-08 sessions are tracked (144 runs). All 56 are
re-scored, and the scoring is most of the time. Outputs:

- `figs/out/fig3_sweep50_md56.json` (shipped arm)
- `figs/out/fig3_sweep50__distanceThreshold25-stale20-sync_e508a7ab_md56.json` (fresh arm)

## 0. Check the shared mount

Every path is absolute under `/root/vast` (the VAST NFS share `pool1.vast.salk.edu:/talmo`).

```bash
ls /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs/fig3_sweep50.py \
   /root/vast/eric/luc3d-bench/outputs/bmimica/det_h5 \
   /root/vast/eric/node26_env/bin/node
```

If VAST is mounted somewhere else on this node, make `/root/vast` a symlink to it. The
scripts hard-code `/root/vast/...` and will not work otherwise.

## 1. Build the Python env (fresh install, pinned to the main box's versions)

The main box's `luc3d-bench/liezl_env` points at a local `/root/miniforge3`, so it cannot be
used here. Build a new env with **CPython 3.12** and **exactly** these versions. They are the
ones that scored the 50 sessions already in the paper:

```bash
E=$HOME/md56_sweep_env            # local disk, not VAST
uv venv -p 3.12 $E || python3.12 -m venv $E
$E/bin/python -m pip install --upgrade pip   # skip if uv
uv pip install -p $E/bin/python \
  numpy==2.4.6 h5py==3.16.0 motmetrics==1.4.0 pandas==2.3.3 scipy==1.17.1 \
  toml==0.10.2 xmltodict==1.0.4
$E/bin/python -c "import numpy, h5py, motmetrics, pandas, scipy; \
  print(numpy.__version__, h5py.__version__, pandas.__version__, scipy.__version__)"
# expect: 2.4.6 3.16.0 2.3.3 1.17.1
```

If there is no `uv`, plain `pip install` with the same pins works too. Do not upgrade any of
them.

Node is used straight from VAST: `/root/vast/eric/node26_env/bin/node --version` should print
v26.10.0. If it fails to run because of glibc, **stop and tell Eric**. Do not install another
Node.

## 2. Run

```bash
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
PY=$HOME/md56_sweep_env/bin/python WORKERS=<cores minus 2> \
  nohup figs/out/md56_logs/run_S.sh > figs/out/md56_logs/run_S.out 2>&1 &
```

`run_S.sh` waits on its own until the main box has built the detections for the 6 new
sessions. It checks for `U4 inputs exit=0` in `figs/out/md56_logs/run_phaseU.out`, expected
around 06:45 UTC. It aborts if `det_h5` does not hold 56 sessions. Then it runs both arms in
parallel and finishes by printing `PHASE S DONE` in `run_S.out`. The main box waits for that
line. Expect roughly 3–5 h, depending on core count. On the main box each arm took 2.5–3 h at
28 workers.

Progress: `tail -f figs/out/md56_logs/S_sweep_fresh.log S_sweep_shipped.log`.

## 3. Acceptance check (run after `PHASE S DONE`)

The 50 old sessions' tracker outputs were not recomputed, and scoring is deterministic. So
each arm's per-session scores for those 50 must equal the current tail-free deposits
(`*_bvis5nt.json`) exactly. If they do, this env reproduces the main box.

```bash
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs/out
$HOME/md56_sweep_env/bin/python - <<'EOF'
import json, glob
pairs = [("fig3_sweep50_bvis5nt.json", "fig3_sweep50_md56.json"),
         ("fig3_sweep50__distanceThreshold25-stale20-sync_e508a7ab_bvis5nt.json",
          "fig3_sweep50__distanceThreshold25-stale20-sync_e508a7ab_md56.json")]
for old, new in pairs:
    a, b = json.load(open(old)), json.load(open(new))
    print(new, "sessions:", len(b["sessions"]), "total_camera_frames:", b["total_camera_frames"])
    # Rows keyed by (corr2d, corr3d, session). Not by params: the shipped arm's new cells
    # record the explicit distanceThreshold 50 pin, the old cells an empty block.
    rows = lambda d: {(c["corr2d"], c["corr3d"], r["session"]): r
                      for c in d["cells"] for r in c["per_session"]}
    ra, rb = rows(a), rows(b)
    common = set(ra) & set(rb)
    bad = [k for k in common if ra[k] != rb[k]]
    print("  per-session rows compared:", len(common), "mismatched:", len(bad), sorted(bad)[:5])
EOF
```

Expected: each arm reports 56 sessions, 600 rows compared (50 sessions × 12 cells) and
**0 mismatched**. If the deposit layout differs from what this snippet assumes, adapt the row
key, but keep the test: old sessions identical, plus 6 new ones. Anything mismatched means the
env differs. **Stop and report it to Eric.** Do not "fix" it.

## Rules

- Do not touch anything else in the repo. In particular, never write `fig3_sweep50.json` or
  any `*_bvis5nt.json`; the script refuses to without `SWEEP50_SUFFIX`, and `run_S.sh` sets it.
- Do not run a second copy of the sweep. The main box no longer runs it. Two writers on one
  cache folder would race.
- Do not edit `fig3_sweep50.py`. The previous-default pin (distanceThreshold 50) is
  deliberate and was gated bit-identical against the cached cells.
- When done, report to Eric:
  - the `PHASE S DONE` timestamps
  - both deposits' `n_sessions`
  - the acceptance-check output
