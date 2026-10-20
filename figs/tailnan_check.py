#!/usr/bin/env python
"""B3 (2026-10-15): does the tail reach LUC3D's tracker through target creation?

The bench driver gives the four tail nodes weight 0, but `_initializeTargets` pairs two
cameras' leftover detections with `epipolarErrorMatrix`, which averages over every
non-null node and ignores `nodeWeights`. This re-tracks every session with the tail set
to null in the INPUT (`fig3_bench.mjs --tail-nan`), otherwise exactly as the v1.0.5
reference runs (same driver, same LUCID_ROOT defaults = sync, stale 20, distanceThreshold
25, corr3d 6, matchGate 0; same pools, calibrations, cameras, max-frames), and compares
`payload_digest` (identities + frames only) with the reference outputs:

  Mouse-Dyad-10M  56 sessions  reference out/tmp/md_main2dc001fe/<sid>.json        (md_main_check.py)
  SLAP-2M         74 sessions  reference out/tmp/fig9slap_lite_bvis5_main2dc001fe/  (fig4_main_check.py)

All identical -> the tail never reached the tracker; one Methods sentence.
Any different -> every LUC3D arm must be re-tracked with --tail-nan.

    LUCID_ROOT=/root/vast/eric/lucid-main-md56 PATH=/root/vast/eric/node26_env/bin:$PATH \
      $PY figs/tailnan_check.py --workers 24
Writes out/tailnan_check_v105.json (new file; refuses to overwrite).
"""
import argparse, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig3_hh_freshanchor as fa  # noqa: E402
import fig4_main_check as f4m     # noqa: E402  (SLAP-2M session specs + reference dir)

DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
BM = Path("/root/vast/eric/luc3d-bench/outputs/bmimica")
MD_CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
MD_REF = FIGS / "out" / "tmp" / "md_main2dc001fe"
OUT = FIGS / "out" / "tmp" / "tailnan_2dc001fe"
DEPOSIT = FIGS / "out" / "tailnan_check_v105.json"


def jobs():
    js = []
    for ref in sorted(MD_REF.glob("2025*.json")):
        s = ref.stem
        cal = next((Path("/root/vast/eric/BMimica") / s / "calibration").glob("*_calibration.toml"))
        cmd = ["--session-idx", "0", "--num-animals", "2", "--calibration", str(cal),
               "--pred-h5-dir", str(BM / "det_h5" / s), "--cameras", ",".join(MD_CAMS)]
        js.append(("Mouse-Dyad-10M", s, cmd, ref))
    sess, _ = f4m.f4.sessions()
    for s in sess:
        ref = f4m.OUT / f"{s['session']}.json"
        if not ref.exists():
            ref = f4m.OUT / "sync_stale20_dist25" / f"{s['session']}.json"
        cmd = ["--session-idx", str(s["det_session_idx"]), "--num-animals", str(s["animals"]),
               "--calibration", str(s["calibration"]), "--pred-h5-dir", str(f4m.POOL),
               "--cameras", ",".join(f4m.f4.CAMERAS), "--max-frames", str(s["max_frames"])]
        js.append(("SLAP-2M", s["session"], cmd, ref))
    return js


def one(job):
    ds, s, args, ref = job
    o = OUT / ds / f"{s}.json"
    o.parent.mkdir(parents=True, exist_ok=True)
    if not (o.exists() and o.stat().st_size > 100):
        r = subprocess.run(["node", str(DRIVER)] + args + ["--tail-nan", "--out", str(o)],
                           capture_output=True, text=True, timeout=10800)
        if r.returncode != 0:
            return ds, s, "FAILED", r.stderr[-300:]
    if not Path(ref).exists():
        return ds, s, "NO_REFERENCE", str(ref)
    if not json.loads(o.read_text()).get("tailNan"):
        return ds, s, "FAILED", "output does not record tailNan=true"
    return ds, s, ("IDENTICAL" if fa.payload_digest(o) == fa.payload_digest(ref) else "DIFFERENT"), ""


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--workers", type=int, default=24); a = ap.parse_args()
    if DEPOSIT.exists():
        sys.exit(f"refusing to overwrite {DEPOSIT}")
    root = os.environ.get("LUCID_ROOT") or sys.exit("set LUCID_ROOT to the v1.0.5 checkout")
    commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True,
                            text=True, check=True).stdout.strip()
    if not commit.startswith("2dc001fe"):
        sys.exit(f"LUCID_ROOT is at {commit[:8]}, not v1.0.5 2dc001fe")
    js = jobs()
    print(f"[tailnan] {len(js)} sessions ({sum(j[0] == 'Mouse-Dyad-10M' for j in js)} Mouse-Dyad, "
          f"{sum(j[0] == 'SLAP-2M' for j in js)} SLAP-2M), {a.workers} workers, LUC3D {commit[:8]}", flush=True)
    res = []
    with ProcessPoolExecutor(a.workers) as ex:
        for f in as_completed([ex.submit(one, j) for j in js]):
            res.append(f.result())
            if res[-1][2] != "IDENTICAL":
                print("  ", res[-1], flush=True)
    summ = {}
    for ds in ("Mouse-Dyad-10M", "SLAP-2M"):
        r = [x for x in res if x[0] == ds]
        summ[ds] = {k: sum(x[2] == k for x in r) for k in ("IDENTICAL", "DIFFERENT", "FAILED", "NO_REFERENCE")}
    DEPOSIT.write_text(json.dumps({"generated_by": "figs/tailnan_check.py", "lucid_commit": commit,
                                   "driver": str(DRIVER), "summary": summ,
                                   "per_session": [{"dataset": d, "session": s, "result": st, "note": n}
                                                   for d, s, st, n in sorted(res)]}, indent=1))
    print("[tailnan]", json.dumps(summ))
    bad = any(v["FAILED"] or v["NO_REFERENCE"] for v in summ.values())
    print("TAILNAN DONE" + (" (FAILED)" if bad else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
