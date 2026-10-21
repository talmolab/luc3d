#!/usr/bin/env python
"""Eviction A/B on SLAP-2M (2026-10-18): LUC3D v1.0.5 at stale 0 vs stale 20 on the
body>=5 pool (lite_bvis5), scored tail-free exactly like Fig 4D / 6b-d.

Eric: "we need to see if staleness hurts both datasets now that we are using the <5 node
filter". The Mouse-Dyad half already exists on the filtered pool (fig8_methods_50_b3*.json:
stale0_dist25 110 switches / 0.9855 vs stale20 144 / 0.9676). This is the SLAP-2M half.

Tracking runs the PINNED v1.0.5 tracker (fig3_bench.mjs + LUCID_ROOT, as fig4_main_check.py
does), not fig6_bench.mjs's xv_experimental fork, which matches v1.0.5 on only 36/74 SLAP-2M
sessions. The only override is thresholds.stale; every other value is the hooks default
(distanceThreshold 25, corr3dWeight 6, matchGate 0, sync always on). The stale-20 arm is
re-tracked too and digest-checked against out/tmp/fig9slap_lite_bvis5_main2dc001fe/.

    export PATH=/root/vast/eric/node26_env/bin:$PATH
    LUCID_ROOT=/root/vast/eric/lucid-main-md56 SCORE_NOTAIL=1 \
      /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/stale_ab_slap2m.py --workers 32

Output: figs/out/stale_ab_slap2m.json; tracker runs under figs/out/tmp/stale_ab_slap2m/.
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
import fig4_slap2m as f4                 # noqa: E402  (sessions(), score_one, POOLS)
import fig3_hh_freshanchor as fa         # noqa: E402  (payload_digest)

DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
POOL = f4.POOLS["lite_bvis5"]
TMP = FIGS / "out" / "tmp" / "stale_ab_slap2m"
REF20 = FIGS / "out" / "tmp" / "fig9slap_lite_bvis5_main2dc001fe" / "sync_stale20_dist25"
ARMS = {"stale0": 0, "stale20": 20}


def track(arm, s):
    d = TMP / arm
    o = d / f"{s['session']}.json"
    if o.exists() and o.stat().st_size > 100:
        return arm, s["session"], None
    pj = d / "params.json"
    cmd = ["node", str(DRIVER), "--session-idx", str(s["det_session_idx"]),
           "--num-animals", str(s["animals"]), "--calibration", str(s["calibration"]),
           "--pred-h5-dir", str(POOL), "--cameras", ",".join(f4.CAMERAS),
           "--max-frames", str(s["max_frames"]), "--out", str(o), "--params", str(pj)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
    if r.returncode != 0 or not o.exists():
        return arm, s["session"], f"exit {r.returncode}: {r.stderr[-300:]}"
    return arm, s["session"], None


def score(arm, s):
    f4.TMP, f4.KEEPTRACK = TMP, POOL
    return (arm,) + f4.score_one(arm, s)


def summarise(rows):
    def agg(rs):
        if not rs:
            return None
        cx = np.array([r["cross_idf1"] for r in rs])
        wi = np.array([r["within_idf1"] for r in rs])
        return {"n_sessions": len(rs),
                "cross_switches": int(sum(r["cross_switches"] for r in rs)),
                "within_switches": int(sum(r["within_switches"] for r in rs)),
                "misgrouped": int(sum(r["misgrouped"] for r in rs)),
                "cross_idf1_mean": float(cx.mean()), "cross_idf1_median": float(np.median(cx)),
                "within_idf1_mean": float(wi.mean()), "within_idf1_median": float(np.median(wi))}
    return {"all": agg(rows), "multi_animal": agg([r for r in rows if r["animals"] > 1])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned v1.0.5 checkout")
    if os.environ.get("SCORE_NOTAIL") != "1":
        sys.exit("set SCORE_NOTAIL=1 (Fig 4D / 6b-d score tail-free)")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    # R4 (LUC3D-JS plan J12, 2026-10-20): refuse anything but a clean v1.0.5 checkout.
    dirty = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "status", "--porcelain",
                            "--untracked-files=no"], capture_output=True, text=True,
                           check=True).stdout.strip()
    if commit != "2dc001fe527c4dbaad17fa171da132cfdfe010e6" or dirty:
        sys.exit(f"LUCID_ROOT is at {commit[:8]}{' (dirty)' if dirty else ''}, not a clean "
                 "2dc001fe -- refusing")
    for arm, st in ARMS.items():
        (TMP / arm).mkdir(parents=True, exist_ok=True)
        (TMP / arm / "params.json").write_text(json.dumps({"thresholds": {"stale": st}}))
    sess, _ = f4.sessions()
    print(f"[stale_ab] {len(sess)} sessions x {len(ARMS)} arms, v1.0.5 {commit[:8]}", flush=True)

    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(track, arm, s) for arm in ARMS for s in sess]
        fails = [f.result() for f in as_completed(futs) if f.result()[2]]
    if fails:
        for x in fails:
            print("[stale_ab] TRACK FAILED", x)
        sys.exit(1)
    same = sum(fa.payload_digest(TMP / "stale20" / f"{s['session']}.json")
               == fa.payload_digest(REF20 / f"{s['session']}.json") for s in sess)
    print(f"[stale_ab] stale20 arm digest-identical to the paper's v1.0.5 cache on "
          f"{same}/{len(sess)} sessions", flush=True)

    per = {arm: [] for arm in ARMS}
    with ProcessPoolExecutor(a.workers) as ex:
        futs = [ex.submit(score, arm, s) for arm in ARMS for s in sess]
        for f in as_completed(futs):
            arm, sid, res, err = f.result()
            if err:
                sys.exit(f"[stale_ab] SCORE FAILED {arm} {sid}: {err}")
            per[arm].append(res)

    from scipy.stats import wilcoxon
    out = {"generated_by": "figs/stale_ab_slap2m.py", "lucid_root": os.environ["LUCID_ROOT"],
           "commit": commit, "pool": str(POOL), "score_notail": True,
           "stale20_digest_identical": f"{same}/{len(sess)}", "arms": {}, "paired": {}}
    for arm in ARMS:
        out["arms"][arm] = summarise(per[arm])
        out["arms"][arm]["per_session"] = sorted(per[arm], key=lambda r: r["session"])
    for subset, keep in (("all", lambda r: True), ("multi_animal", lambda r: r["animals"] > 1)):
        b = {r["session"]: r for r in per["stale20"] if keep(r)}
        z = {r["session"]: r for r in per["stale0"] if keep(r)}
        d = np.array([z[k]["cross_idf1"] - b[k]["cross_idf1"] for k in sorted(b)])
        nz = d[d != 0]
        out["paired"][subset] = {
            "cross_idf1_stale0_minus_stale20_mean": float(d.mean()),
            "stale0_better": int((d > 0).sum()), "stale20_better": int((d < 0).sum()),
            "tied": int((d == 0).sum()),
            "wilcoxon_p": float(wilcoxon(nz).pvalue) if len(nz) else None}
    (FIGS / "out" / "stale_ab_slap2m.json").write_text(json.dumps(out, indent=1))
    for arm in ARMS:
        for k, v in out["arms"][arm].items():
            if k != "per_session":
                print(f"[stale_ab] {arm:8s} {k:13s} {v}")
    print("[stale_ab] paired", json.dumps(out["paired"], indent=1))


if __name__ == "__main__":
    main()
