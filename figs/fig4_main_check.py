#!/usr/bin/env python
"""Fig 4D on origin/main (md56, 2026-10-14): re-track every SLAP-2M session with the pinned
main checkout's REAL tracker (figs/fig3-bench/fig3_bench.mjs + LUCID_ROOT, so main's pose/ and
its scripts/bench/hooks.mjs defaults: distanceThreshold 25, stale 20, corr3dWeight 6,
matchGate 0, sync always on; no params file at all, so no shared-params race), and
digest-compare each session's identities+frames with the Fig 4D md56 cache
(out/tmp/fig9slap_lite_bvis5_md56/sync_stale20_dist25/, fig6_bench.mjs + xv_experimental.js).
Identical digests on every session = Fig 4D describes main exactly.
    LUCID_ROOT=/root/vast/eric/lucid-main-md56 $PY figs/fig4_main_check.py --workers 24
"""
import argparse, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig4_slap2m as f4                       # noqa: E402  (sessions(), POOLS, CAMERAS)
import fig3_hh_freshanchor as fa              # noqa: E402  (payload_digest)
DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
POOL = f4.POOLS["lite_bvis5"]
REF = FIGS / "out" / "tmp" / "fig9slap_lite_bvis5_md56" / "sync_stale20_dist25"
OUT = FIGS / "out" / "tmp" / "fig9slap_lite_bvis5_main2dc001fe"


def one(s):
    o = OUT / f"{s['session']}.json"
    if not (o.exists() and o.stat().st_size > 100):
        cmd = ["node", str(DRIVER), "--session-idx", str(s["det_session_idx"]),
               "--num-animals", str(s["animals"]), "--calibration", str(s["calibration"]),
               "--pred-h5-dir", str(POOL), "--cameras", ",".join(f4.CAMERAS),
               "--max-frames", str(s["max_frames"]), "--out", str(o)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
        if r.returncode != 0:
            return s["session"], "FAILED", r.stderr[-300:]
    ref = REF / f"{s['session']}.json"
    a, b = fa.payload_digest(o), fa.payload_digest(ref)
    return s["session"], "IDENTICAL" if a == b else "DIFFERENT", f"{a[:12]} vs {b[:12]}"


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--workers", type=int, default=24); a = ap.parse_args()
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned main checkout")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    OUT.mkdir(parents=True, exist_ok=True)
    sess, _ = f4.sessions()
    res = []
    with ProcessPoolExecutor(a.workers) as ex:
        for f in as_completed([ex.submit(one, s) for s in sess]):
            res.append(f.result())
    n_id = sum(r[1] == "IDENTICAL" for r in res)
    for r in sorted(res):
        if r[1] != "IDENTICAL":
            print(r)
    out = {"generated_by": "figs/fig4_main_check.py", "lucid_root": os.environ["LUCID_ROOT"],
           "commit": commit, "driver": str(DRIVER), "pool": str(POOL), "reference": str(REF),
           "n_sessions": len(res), "n_identical": n_id,
           "per_session": {r[0]: r[1] for r in res}}
    (FIGS / "out" / "fig4_main_check_md56.json").write_text(json.dumps(out, indent=1))
    print(f"[f4main] {n_id}/{len(res)} sessions IDENTICAL to the Fig 4D md56 cache (main {commit[:8]})")
    return 0 if n_id == len(res) else 1


if __name__ == "__main__":
    sys.exit(main())
