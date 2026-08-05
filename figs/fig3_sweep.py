#!/usr/bin/env python
"""Task 1 — corr2d x corr3d grid sweep for Fig 3.

Sweeps corr3dWeight x [0, 0.5, 1, 2, 4, 6, 8, 12] and corr2dWeight x [0.5, 1, 2]
(24 cells), holding all other CrossViewTracker thresholds at their defaults, on
a fixed set of 8 BMimica sessions (2 animals x 5 cameras each). For each cell,
runs the REAL production tracker (figs/fig3-bench/fig3_bench.mjs, which loads
the unmodified pose/tracker.js + pose/cross-view-tracker.js) per session, then
scores every session against ground truth via figs/fig3_score.py (which reuses
$BENCH/scripts/evaluate.py's IoU/MOT machinery).

Frame cap: FRAMES_PER_SESSION below (see the caveat this writes into the output
JSON) — full BMimica sessions are ~180k frames each; 24 cells x 8 sessions x
full length is not tractable in a benchmarking pass, so each cell is scored on
the same fixed leading window of frames per session. All cells and all
sessions use IDENTICAL frame windows and detections, so the comparison across
cells is apples-to-apples even though it is not full-session.

Output: figs/out/fig3_sweep.json (schema per the handoff).
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from glob import glob
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BENCH = Path("/root/vast/eric/luc3d-bench")
BMROOT = Path("/root/vast/eric/BMimica")
DET = BENCH / "outputs" / "bmimica" / "det_h5"
GT = BENCH / "outputs" / "bmimica" / "gt"
DRIVER = REPO / "figs" / "fig3-bench" / "fig3_bench.mjs"
OUT_DIR = REPO / "figs" / "out"
PY = "/root/vast/eric/luc3d-bench/liezl_env/bin/python"  # has motmetrics; handoff's lp3d_env did NOT (verified empirically)

CAMERAS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
NUM_ANIMALS = 2
# FULL sessions. This was 6000 (a fixed leading window) purely for tractability, and it
# was the wrong call: a 6000-frame window is 3.3% of a ~180k-frame session, and a sweep
# whose whole purpose is to show the shipped default sits on a plateau cannot rest on a
# 3% sample of each session. `fig3_bench.mjs` guards with `if (opts.maxFrames)`, so
# passing None omits the flag entirely and runs every frame.
# Cost: 6000 frames is ~7s of tracking, so a full session is ~210s; 24 cells x 8 sessions
# = 192 runs over WORKERS processes. The 600s driver timeout was sized for the window and
# is raised below.
FRAMES_PER_SESSION = None

# Separate cache per mode: run_one() early-returns on an existing result JSON, so a
# full-session run MUST NOT be able to pick up the 6000-frame leftovers.
TMP_DIR = OUT_DIR / "tmp" / ("sweep" if FRAMES_PER_SESSION else "sweep_full")

SESSIONS = [
    "20250827_141755", "20250829_124351", "20250829_155407", "20250903_141046",
    "20250904_131913", "20250904_181215", "20250905_165151", "20250907_143021",
]

CORR3D_GRID = [0, 0.5, 1, 2, 4, 6, 8, 12]
CORR2D_GRID = [0.5, 1, 2]

WORKERS = int(os.environ.get("FIG3_WORKERS", "16"))


def calib_for(session):
    hits = glob(str(BMROOT / session / "calibration" / "*_calibration.toml"))
    return hits[0] if hits else None


def run_one(corr2d, corr3d, session):
    """Run the tracker for one (corr2d, corr3d, session) cell. Returns (session, status, path_or_reason)."""
    cell_dir = TMP_DIR / f"c2_{corr2d}_c3_{corr3d}"
    cell_dir.mkdir(parents=True, exist_ok=True)
    out_path = cell_dir / f"{session}.json"
    if out_path.exists() and out_path.stat().st_size > 100:
        return (session, "ok", str(out_path))

    calib = calib_for(session)
    if not calib:
        return (session, "failed", f"no calibration.toml under {BMROOT / session / 'calibration'}")
    det_dir = DET / session
    if not det_dir.exists():
        return (session, "failed", f"no det_h5 dir {det_dir}")

    params_path = cell_dir / "params.json"
    if not params_path.exists():
        params_path.write_text(json.dumps({"thresholds": {"corr2dWeight": corr2d, "corr3dWeight": corr3d}}))

    cmd = [
        "node", str(DRIVER),
        "--session-idx", "0", "--num-animals", str(NUM_ANIMALS),
        "--calibration", calib,
        "--pred-h5-dir", str(det_dir),
        "--out", str(out_path),
        "--cameras", ",".join(CAMERAS),
        "--params", str(params_path),
    ]
    # omit --max-frames entirely for a full-session run; the driver guards on truthiness
    if FRAMES_PER_SESSION:
        cmd[-2:-2] = ["--max-frames", str(FRAMES_PER_SESSION)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=(600 if FRAMES_PER_SESSION else 5400))
        if r.returncode != 0 or not out_path.exists():
            return (session, "failed", "driver exit " + str(r.returncode) + ": " + r.stderr[-500:].replace("\n", " "))
        return (session, "ok", str(out_path))
    except subprocess.TimeoutExpired:
        return (session, "failed", "driver timed out")
    except Exception as e:
        return (session, "failed", str(e))


def score_one(corr2d, corr3d, session):
    """Score one session's result JSON against GT. Returns (session, status, result_or_reason)."""
    result_path = TMP_DIR / f"c2_{corr2d}_c3_{corr3d}" / f"{session}.json"
    if not result_path.exists():
        return (session, "failed", "no result JSON (driver run failed)")
    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs  # noqa: E402
    try:
        s = fs.score_session(str(result_path), str(DET / session), str(GT / session),
                              CAMERAS, NUM_ANIMALS, max_frames=FRAMES_PER_SESSION)
        return (session, "ok", s)
    except Exception as e:
        return (session, "failed", str(e))


def main():
    t0 = time.time()
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    cells_grid = [(c2, c3) for c3 in CORR3D_GRID for c2 in CORR2D_GRID]
    print(f"[sweep] {len(cells_grid)} cells x {len(SESSIONS)} sessions = "
          f"{len(cells_grid) * len(SESSIONS)} driver runs, {WORKERS} workers", flush=True)

    # --- phase 1: run the tracker for every (cell, session) ---
    jobs = [(c2, c3, s) for (c2, c3) in cells_grid for s in SESSIONS]
    run_status = {}  # (c2,c3,session) -> (status, info)
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(run_one, c2, c3, s): (c2, c3, s) for (c2, c3, s) in jobs}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            run_status[key] = (status, info)
            done += 1
            if done % 20 == 0 or done == len(jobs):
                print(f"[sweep] driver runs {done}/{len(jobs)} ({time.time()-t0:.0f}s)", flush=True)
            if status != "ok":
                print(f"[sweep] FAILED c2={key[0]} c3={key[1]} session={session}: {info}", flush=True)

    # --- phase 2: score every session that ran successfully ---
    score_status = {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {}
        for (c2, c3, s) in jobs:
            if run_status[(c2, c3, s)][0] == "ok":
                futs[ex.submit(score_one, c2, c3, s)] = (c2, c3, s)
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            score_status[key] = (status, info)
            done += 1
            if done % 20 == 0 or done == len(futs):
                print(f"[sweep] scored {done}/{len(futs)} ({time.time()-t0:.0f}s)", flush=True)
            if status != "ok":
                print(f"[sweep] SCORE-FAILED c2={key[0]} c3={key[1]} session={session}: {info}", flush=True)

    # --- phase 3: aggregate per cell ---
    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs  # noqa: E402

    cells_out = []
    caveats = [
        (f"Each cell/session is scored on a fixed leading window of {FRAMES_PER_SESSION} "
         f"frames (not the full ~180k-frame session), identical across every cell and session."
         if FRAMES_PER_SESSION else
         "Every cell/session is scored on the FULL session -- every frame, no window."),
        "idf1_within is the mean of per-camera within-view IDF1 across all cameras and sessions; "
        "idf1_cross is IDF1 under one global identity per animal pooled over all cameras; switches is the "
        "SUM of per-camera within-view ('2D') ID switches across all cameras and sessions in the "
        "cell. The corr3d=0 cell is the 'no 3D term at all' control requested by the handoff.",
    ]
    blocked = []
    for (c2, c3) in cells_grid:
        sess_scores = []
        n_failed = 0
        why_parts = []
        for s in SESSIONS:
            rst, rinfo = run_status[(c2, c3, s)]
            if rst != "ok":
                n_failed += 1
                why_parts.append(f"{s}: driver failed: {rinfo}")
                continue
            sst, sinfo = score_status.get((c2, c3, s), ("failed", "not scored"))
            if sst != "ok":
                n_failed += 1
                why_parts.append(f"{s}: scoring failed: {sinfo}")
                continue
            sess_scores.append(sinfo)
        if sess_scores:
            agg = fs.score_cell(sess_scores)
            cell = {"corr2d": c2, "corr3d": c3, "idf1_within": agg["idf1_within"],
                    "idf1_cross": agg["idf1_cross"], "switches": agg["switches"],
                    "n_sessions": agg["n_sessions"], "status": "ok", "why": ""}
            if n_failed:
                cell["why"] = f"{n_failed}/{len(SESSIONS)} sessions failed: " + "; ".join(why_parts)
        else:
            cell = {"corr2d": c2, "corr3d": c3, "idf1_within": None, "idf1_cross": None,
                    "switches": None, "n_sessions": 0, "status": "failed",
                    "why": "all sessions failed: " + "; ".join(why_parts)}
        cells_out.append(cell)
        print(f"[sweep] cell corr2d={c2} corr3d={c3}: {cell['status']} "
              f"n={cell['n_sessions']} within={cell.get('idf1_within')} cross={cell.get('idf1_cross')} "
              f"switches={cell.get('switches')}", flush=True)

    out = {
        "generated_by": "figs/fig3_sweep.py",
        "dataset": "BMimica",
        "detection_pool": str(DET),
        "sessions": SESSIONS,
        "metric": "IDF1 (motmetrics) + ID-switches",
        "caveats": caveats,
        "blocked": blocked,
        "cells": cells_out,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_sweep.json").write_text(json.dumps(out, indent=2))
    print(f"[sweep] wrote {OUT_DIR / 'fig3_sweep.json'} ({time.time()-t0:.0f}s total)", flush=True)


if __name__ == "__main__":
    main()
