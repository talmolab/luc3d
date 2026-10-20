#!/usr/bin/env python
"""Staleness-horizon sweep on SLAP-2M (2026-10-18, exploratory, "for the fun of it"):
the old Supp Fig 6F sweep (stale 0, 1, 10, 20, 30) redone on SLAP-2M instead of
Mouse-Dyad-10M. LUC3D v1.0.5, r = 6, body>=5 pool (lite_bvis5), scored tail-free --
the same arms as stale_ab_slap2m.py with three more stale values.

stale 0 and stale 20 are NOT re-tracked: they are stale_ab_slap2m.py's tracker outputs,
read in place. stale 1/10/30 are tracked under figs/out/tmp/stale_sweep_slap2m/.

Writes figs/out/stale_sweep_slap2m.json in fig8_methods_50.json's schema (cells keyed by
the config names panels/fig6_07_pr_switches.py draws), so the old panel renders it with

    FIG_TAG=slapstale FIG6F_NOEVICT=stale0_dist25 \
      .venv/bin/python figs/panels/fig6_07_pr_switches.py --deposit stale_sweep_slap2m.json

    export PATH=/root/vast/eric/node26_env/bin:$PATH
    LUCID_ROOT=/root/vast/eric/lucid-main-md56 SCORE_NOTAIL=1 \
      /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/stale_sweep_slap2m.py --workers 24
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig4_slap2m as f4                 # noqa: E402
import stale_ab_slap2m as ab             # noqa: E402

TMP = FIGS / "out" / "tmp" / "stale_sweep_slap2m"
AB = FIGS / "out" / "tmp" / "stale_ab_slap2m"
#: config name (as fig6_07 draws it) -> (stale, tracker-output dir)
ARMS = {"stale0_dist25": (0, AB / "stale0"),
        "sync_stale1_dist25": (1, TMP / "stale1"),
        "sync_stale10_dist25": (10, TMP / "stale10"),
        "sync_stale20_dist25": (20, AB / "stale20"),
        "sync_stale30_dist25": (30, TMP / "stale30")}


def track(cfg, s):
    d = ARMS[cfg][1]
    o = d / f"{s['session']}.json"
    if o.exists() and o.stat().st_size > 100:
        return cfg, s["session"], None
    cmd = ["node", str(ab.DRIVER), "--session-idx", str(s["det_session_idx"]),
           "--num-animals", str(s["animals"]), "--calibration", str(s["calibration"]),
           "--pred-h5-dir", str(ab.POOL), "--cameras", ",".join(f4.CAMERAS),
           "--max-frames", str(s["max_frames"]), "--out", str(o),
           "--params", str(d / "params.json")]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
    if r.returncode != 0 or not o.exists():
        return cfg, s["session"], f"exit {r.returncode}: {r.stderr[-300:]}"
    return cfg, s["session"], None


def score(cfg, s):
    d = ARMS[cfg][1]
    f4.TMP, f4.KEEPTRACK = d.parent, ab.POOL
    return (cfg,) + f4.score_one(d.name, s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned v1.0.5 checkout")
    if os.environ.get("SCORE_NOTAIL") != "1":
        sys.exit("set SCORE_NOTAIL=1 (Fig 4D / 6b-d score tail-free)")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    sess, _ = f4.sessions()
    for cfg, (st, d) in ARMS.items():
        if d.parent == TMP:
            d.mkdir(parents=True, exist_ok=True)
            (d / "params.json").write_text(json.dumps({"thresholds": {"stale": st}}))
        elif sum((d / f"{s['session']}.json").exists() for s in sess) != len(sess):
            sys.exit(f"{d} is incomplete -- run stale_ab_slap2m.py first")
    print(f"[stale_sweep] {len(sess)} sessions x {len(ARMS)} stale values, "
          f"v1.0.5 {commit[:8]}", flush=True)

    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(track, cfg, s) for cfg in ARMS for s in sess]
        fails = [f.result() for f in as_completed(futs) if f.result()[2]]
    if fails:
        for x in fails:
            print("[stale_sweep] TRACK FAILED", x)
        sys.exit(1)

    per = {cfg: [] for cfg in ARMS}
    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(score, cfg, s) for cfg in ARMS for s in sess]
        for f in as_completed(futs):
            cfg, sid, res, err = f.result()
            if err:
                sys.exit(f"[stale_sweep] SCORE FAILED {cfg} {sid}: {err}")
            per[cfg].append(res)

    cam_frames = int(sum(s["max_frames"] * len(f4.CAMERAS) for s in sess))
    cells = []
    for cfg, (st, d) in ARMS.items():
        ps = sorted(per[cfg], key=lambda r: r["session"])
        sw = int(sum(r["within_switches"] for r in ps))
        cells.append({
            "config": cfg, "params": {"thresholds": {"stale": st}}, "status": "ok",
            "tracker_dir": str(d), "per_session": ps, "n_sessions": len(ps),
            "idf1_cross": float(np.mean([r["cross_idf1"] for r in ps])),
            "idp_cross": float(np.mean([r["cross_idp"] for r in ps])),
            "idr_cross": float(np.mean([r["cross_idr"] for r in ps])),
            "switches": sw, "switches_per_100k_camera_frames": sw * 1e5 / cam_frames})
    out = {"generated_by": "figs/stale_sweep_slap2m.py", "dataset": "SLAP-2M",
           "lucid_root": os.environ["LUCID_ROOT"], "commit": commit,
           "detection_pool": str(ab.POOL), "score_notail": True, "corr3dWeight": 6,
           "sessions": [s["session"] for s in sess], "cameras": f4.CAMERAS,
           "total_camera_frames": cam_frames,
           "caveats": ["max_frames per session x 6 cameras is the camera-frame "
                       "denominator; switches are within-view sums as in "
                       "fig8_methods_50.json"],
           "cells": cells}
    (FIGS / "out" / "stale_sweep_slap2m.json").write_text(json.dumps(out, indent=1))
    for c in cells:
        x = [r["cross_idf1"] for r in c["per_session"]]
        print(f"[stale_sweep] {c['config']:22s} cross IDF1 {np.mean(x):.4f}/"
              f"{np.median(x):.4f} within sw {c['switches']}", flush=True)


if __name__ == "__main__":
    main()
