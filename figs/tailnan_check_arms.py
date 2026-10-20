#!/usr/bin/env python
"""CONSISTENCY-PLAN S2 + X2 (2026-10-19): the tail-NaN check for the LUC3D arms that
tailnan_check.py (B3, default config, full camera set) did not cover.

The bench driver gives the four tail nodes weight 0, but target creation
(`epipolarErrorMatrix`) ignores `nodeWeights`. tailnan_check.py showed weight 0 == tail NaN
for the default config on all 130 sessions. This repeats that test, exactly as
tailnan_check.py does it (same driver plus `--tail-nan`, `payload_digest` of identities +
frames), on the SLAP-2M arms that run with other settings or other camera sets:

  S2  Fig 6c f staleness arms, SLAP-2M, 74 sessions, stale 0 / 1 / 10 / 20 / 30, each with
      the arm's own params.json (stale_ab_slap2m.py, stale_sweep_slap2m.py).
  X2  Fig 3 head-to-head greedy arm, SLAP-2M configs A2_C6 / A3_C5 / A4_C3 (camera subsets),
      FIG3_VARIANT=b3 sessions, against out/tmp/headtohead_b3/<cfg>/<sess>/greedy.json.

All identical -> the existing tracker outputs stand. Any different -> that arm must be
re-tracked with --tail-nan.

    FIG3_VARIANT=b3 SCORE_NOTAIL=1 LUCID_ROOT=/root/vast/eric/lucid-main-md56 \\
      PATH=/root/vast/eric/node26_env/bin:$PATH $PY figs/tailnan_check_arms.py --workers 24

Writes out/tailnan_check_arms_v105.json (new file; refuses to overwrite) and tracker
outputs under out/tmp/tailnan_arms_2dc001fe/.
"""
import argparse, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig3_hh_freshanchor as fa   # noqa: E402  (payload_digest)
import stale_ab_slap2m as ab       # noqa: E402  (DRIVER, POOL, f4 sessions)
import stale_sweep_slap2m as ss    # noqa: E402  (ARMS: name -> (stale, tracker-output dir))
import fig3_headtohead as hh       # noqa: E402  (CONFIGS, sessions_for, cell_dir)

OUT = FIGS / "out" / "tmp" / "tailnan_arms_2dc001fe"
DEPOSIT = FIGS / "out" / "tailnan_check_arms_v105.json"
HH_SLAP = ("A2_C6_slap2m", "A3_C5_slap2m", "A4_C3_slap2m")


def jobs():
    js = []
    sess = ab.f4.sessions()[0]
    for arm, (_, d) in ss.ARMS.items():
        for s in sess:
            args = ["--session-idx", str(s["det_session_idx"]), "--num-animals", str(s["animals"]),
                    "--calibration", str(s["calibration"]), "--pred-h5-dir", str(ab.POOL),
                    "--cameras", ",".join(ab.f4.CAMERAS), "--max-frames", str(s["max_frames"]),
                    "--params", str(d / "params.json")]
            js.append((f"S2/{arm}", s["session"], args, d / f"{s['session']}.json"))
    for cfg in hh.CONFIGS:
        if cfg["key"] not in HH_SLAP:
            continue
        if hh.tail_in_tracking(cfg):
            sys.exit(f"{cfg['key']}: tail is in tracking under {hh.VARIANT}; this check is for tail-free arms")
        for s in hh.sessions_for(cfg)[0]:
            args = ["--session-idx", str(s["det_session_idx"]), "--num-animals", str(cfg["animals"]),
                    "--calibration", str(s["calibration"]), "--pred-h5-dir", s["det_dir"],
                    "--cameras", ",".join(cfg["cameras"])]
            if s["max_frames"]:
                args += ["--max-frames", str(s["max_frames"])]
            js.append((f"X2/{cfg['key']}", s["session"], args, hh.cell_dir(cfg, s) / "greedy.json"))
    return js


def one(job):
    arm, s, args, ref = job
    o = OUT / arm / f"{s}.json"
    o.parent.mkdir(parents=True, exist_ok=True)
    if not (o.exists() and o.stat().st_size > 100):
        r = subprocess.run(["node", str(ab.DRIVER)] + args + ["--tail-nan", "--out", str(o)],
                           capture_output=True, text=True, timeout=10800)
        if r.returncode != 0:
            return arm, s, "FAILED", r.stderr[-300:]
    if not Path(ref).exists():
        return arm, s, "NO_REFERENCE", str(ref)
    if not json.loads(o.read_text()).get("tailNan"):
        return arm, s, "FAILED", "output does not record tailNan=true"
    return arm, s, ("IDENTICAL" if fa.payload_digest(o) == fa.payload_digest(ref) else "DIFFERENT"), ""


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--workers", type=int, default=24); a = ap.parse_args()
    if DEPOSIT.exists():
        sys.exit(f"refusing to overwrite {DEPOSIT}")
    if hh.VARIANT != "b3":
        sys.exit("set FIG3_VARIANT=b3 (the X2 references are the b3 head-to-head cells)")
    root = os.environ.get("LUCID_ROOT") or sys.exit("set LUCID_ROOT to the v1.0.5 checkout")
    commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True,
                            text=True, check=True).stdout.strip()
    if not commit.startswith("2dc001fe"):
        sys.exit(f"LUCID_ROOT is at {commit[:8]}, not v1.0.5 2dc001fe")
    js = jobs()
    arms = sorted({j[0] for j in js})
    print(f"[tailnan-arms] {len(js)} runs over {len(arms)} arms {arms}, {a.workers} workers, "
          f"LUC3D {commit[:8]}", flush=True)
    res = []
    with ProcessPoolExecutor(a.workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(one, j) for j in js]), 1):
            res.append(f.result())
            if res[-1][2] != "IDENTICAL":
                print("  ", res[-1], flush=True)
            if i % 50 == 0:
                print(f"[tailnan-arms] {i}/{len(js)}", flush=True)
    summ = {arm: {k: sum(x[0] == arm and x[2] == k for x in res)
                  for k in ("IDENTICAL", "DIFFERENT", "FAILED", "NO_REFERENCE")} for arm in arms}
    DEPOSIT.write_text(json.dumps({"generated_by": "figs/tailnan_check_arms.py", "lucid_commit": commit,
                                   "driver": str(ab.DRIVER), "variant": hh.VARIANT, "summary": summ,
                                   "per_session": [{"arm": r, "session": s, "result": st, "note": n}
                                                   for r, s, st, n in sorted(res)]}, indent=1))
    print("[tailnan-arms]", json.dumps(summ))
    bad = any(v["FAILED"] or v["NO_REFERENCE"] for v in summ.values())
    diff = any(v["DIFFERENT"] for v in summ.values())
    print("TAILNAN-ARMS DONE" + (" (FAILED)" if bad else "") + (" (DIFFERENCES)" if diff else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
