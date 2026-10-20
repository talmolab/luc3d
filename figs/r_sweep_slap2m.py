#!/usr/bin/env python
"""3D-correspondence ratio sweep on SLAP-2M (2026-10-18): LUC3D v1.0.5 at a fixed stale over
r = corr3dWeight / corr2dWeight, on the body>=5 pool (lite_bvis5), scored tail-free exactly
like stale_ab_slap2m.py / Fig 4D.

Eric: pick a new default r with staleness off, from both Mouse-Dyad (b3 sweeps already exist)
and SLAP-2M (no r sweep on this pool / tracker before this). corr2dWeight stays 1; the only
overrides are thresholds.stale (--stale, default 0) and thresholds.corr3dWeight = r. Everything else is the
hooks default (distanceThreshold 25, matchGate 0, sync always on).

Gate: the r = 6 arm is the matching arm of stale_ab_slap2m.py (stale 0 or 20) and must be
digest-identical to out/tmp/stale_ab_slap2m/stale<N>/.
Eric 2026-10-18: eviction stays (it helps SLAP-2M), so the r pick is made at --stale 20.

    export PATH=/root/vast/eric/node26_env/bin:$PATH
    LUCID_ROOT=/root/vast/eric/lucid-main-md56 SCORE_NOTAIL=1 \
      /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/r_sweep_slap2m.py --workers 32 --stale 20

Output: figs/out/r_sweep_slap2m_stale<N>.json; tracker runs under figs/out/tmp/r_sweep_slap2m/
(stale 0, the first run) or figs/out/tmp/r_sweep_slap2m_stale<N>/ (any other stale).
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
import fig3_hh_freshanchor as fa         # noqa: E402
import stale_ab_slap2m as ab             # noqa: E402  (summarise, DRIVER, POOL)

TMP = FIGS / "out" / "tmp" / "r_sweep_slap2m"
GRID = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24]


def arm_name(r):
    return f"r{r:g}"


def track(arm, s):
    d = TMP / arm
    o = d / f"{s['session']}.json"
    if o.exists() and o.stat().st_size > 100:
        return arm, s["session"], None
    cmd = ["node", str(ab.DRIVER), "--session-idx", str(s["det_session_idx"]),
           "--num-animals", str(s["animals"]), "--calibration", str(s["calibration"]),
           "--pred-h5-dir", str(ab.POOL), "--cameras", ",".join(f4.CAMERAS),
           "--max-frames", str(s["max_frames"]), "--out", str(o),
           "--params", str(d / "params.json")]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
    if r.returncode != 0 or not o.exists():
        return arm, s["session"], f"exit {r.returncode}: {r.stderr[-300:]}"
    return arm, s["session"], None


def score(arm, s):
    f4.TMP, f4.KEEPTRACK = TMP, ab.POOL
    return (arm,) + f4.score_one(arm, s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--stale", type=int, default=0)
    a = ap.parse_args()
    global TMP
    if a.stale != 0:
        TMP = FIGS / "out" / "tmp" / f"r_sweep_slap2m_stale{a.stale}"
    ref6 = FIGS / "out" / "tmp" / "stale_ab_slap2m" / f"stale{a.stale}"
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned v1.0.5 checkout")
    if os.environ.get("SCORE_NOTAIL") != "1":
        sys.exit("set SCORE_NOTAIL=1 (Fig 4D / 6b-d score tail-free)")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    arms = {arm_name(r): r for r in GRID}
    for arm, r in arms.items():
        (TMP / arm).mkdir(parents=True, exist_ok=True)
        (TMP / arm / "params.json").write_text(
            json.dumps({"thresholds": {"stale": a.stale, "corr3dWeight": r}}))
    sess, _ = f4.sessions()
    print(f"[r_sweep] {len(sess)} sessions x {len(arms)} r values, stale {a.stale}, v1.0.5 {commit[:8]}",
          flush=True)

    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(track, arm, s) for arm in arms for s in sess]
        fails = [f.result() for f in as_completed(futs) if f.result()[2]]
    if fails:
        for x in fails:
            print("[r_sweep] TRACK FAILED", x)
        sys.exit(1)
    same = None
    if ref6.is_dir():
        same = sum(fa.payload_digest(TMP / "r6" / f"{s['session']}.json")
                   == fa.payload_digest(ref6 / f"{s['session']}.json") for s in sess)
        print(f"[r_sweep] r6 arm digest-identical to stale_ab_slap2m stale{a.stale} on "
              f"{same}/{len(sess)} sessions", flush=True)

    per = {arm: [] for arm in arms}
    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(score, arm, s) for arm in arms for s in sess]
        for f in as_completed(futs):
            arm, sid, res, err = f.result()
            if err:
                sys.exit(f"[r_sweep] SCORE FAILED {arm} {sid}: {err}")
            per[arm].append(res)

    out = {"generated_by": "figs/r_sweep_slap2m.py", "lucid_root": os.environ["LUCID_ROOT"],
           "commit": commit, "pool": str(ab.POOL), "score_notail": True, "stale": a.stale,
           "corr2dWeight": 1, "grid_r": GRID,
           f"r6_digest_identical_to_stale_ab_stale{a.stale}": f"{same}/{len(sess)}" if same is not None else None,
           "arms": {}}
    for arm, r in arms.items():
        out["arms"][arm] = {"r": r, **ab.summarise(per[arm]),
                            "per_session": sorted(per[arm], key=lambda x: x["session"])}
    (FIGS / "out" / f"r_sweep_slap2m_stale{a.stale}.json").write_text(json.dumps(out, indent=1))
    for arm in arms:
        al, ma = out["arms"][arm]["all"], out["arms"][arm]["multi_animal"]
        print(f"[r_sweep] {arm:6s} all cross {al['cross_idf1_mean']:.4f}/"
              f"{al['cross_idf1_median']:.4f} sw {al['within_switches']:5d} | multi cross "
              f"{ma['cross_idf1_mean']:.4f}/{ma['cross_idf1_median']:.4f} "
              f"sw {ma['within_switches']:5d}", flush=True)


if __name__ == "__main__":
    main()
