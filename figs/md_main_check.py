#!/usr/bin/env python
"""Mouse-Dyad-10M on origin/main (md56, 2026-10-14): re-track all 56 sessions with the pinned
main checkout's REAL tracker (fig3_bench.mjs + LUCID_ROOT; main's shipped defaults) and
digest-compare with the md56 cache of the current-tracker cell the paper reports
(out/tmp/fig8m50/sync_stale20_dist25/, fig6_bench.mjs + xv_experimental.js).
    LUCID_ROOT=/root/vast/eric/lucid-main-md56 $PY figs/md_main_check.py --workers 24
"""
import argparse, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig3_hh_freshanchor as fa              # noqa: E402
DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
BM = Path("/root/vast/eric/luc3d-bench/outputs/bmimica")
CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
REF = FIGS / "out" / "tmp" / "fig8m50" / "sync_stale20_dist25"
OUT = FIGS / "out" / "tmp" / "md_main2dc001fe"


def one(s):
    o = OUT / f"{s}.json"
    if not (o.exists() and o.stat().st_size > 100):
        cal = next((Path("/root/vast/eric/BMimica") / s / "calibration").glob("*_calibration.toml"))
        cmd = ["node", str(DRIVER), "--session-idx", "0", "--num-animals", "2",
               "--calibration", str(cal), "--pred-h5-dir", str(BM / "det_h5" / s),
               "--cameras", ",".join(CAMS), "--out", str(o)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
        if r.returncode != 0:
            return s, "FAILED", r.stderr[-300:]
    return s, ("IDENTICAL" if fa.payload_digest(o) == fa.payload_digest(REF / f"{s}.json") else "DIFFERENT"), ""


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--workers", type=int, default=24); a = ap.parse_args()
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    OUT.mkdir(parents=True, exist_ok=True)
    sess = sorted(p.stem for p in REF.glob("2025*.json"))
    with ProcessPoolExecutor(a.workers) as ex:
        res = [f.result() for f in as_completed([ex.submit(one, s) for s in sess])]
    n_id = sum(r[1] == "IDENTICAL" for r in res)
    for r in sorted(res):
        if r[1] != "IDENTICAL": print(r)
    (FIGS / "out" / "md_main_check_md56.json").write_text(json.dumps(
        {"generated_by": "figs/md_main_check.py", "commit": commit, "reference": str(REF),
         "n_sessions": len(res), "n_identical": n_id, "per_session": {r[0]: r[1] for r in res}}, indent=1))
    print(f"[mdmain] {n_id}/{len(res)} Mouse-Dyad sessions IDENTICAL to sync_stale20_dist25 (main {commit[:8]})")


if __name__ == "__main__":
    main()
