#!/usr/bin/env python
"""Re-derive cached LUC3D greedy runs at v1.0.5 and compare (LUC3D-JS plan J12, 2026-10-20).

Several Fig 3 caches (`out/tmp/headtohead_b3`, `out/tmp/headtohead_var_b3_2dc001fe/...`)
record no LUC3D commit. Their v1.0.5 status rested on run-script asserts, and the
SLAP-2M cells were copied from an md56 run whose script did not assert the commit.
This does not trust any log: it reruns `fig3-bench/fig3_bench.mjs` against
LUCID_ROOT (refusing anything but a clean 2dc001fe) with each cache's own echoed
params, cameras, animals and tail flags, and compares the tracker OUTPUT
(`identities` + `frames`, fig3_hh_freshanchor.payload_digest). Nothing in the cache is
written; reruns go to a scratch directory.

    LUCID_ROOT=/root/vast/eric/lucid-main-md56 FIG3_VARIANT=b3 \\
      PATH=/root/vast/eric/node26_env/bin:$PATH $PY figs/provenance_rederive.py \\
      --tree out/tmp/headtohead_b3 --tree out/tmp/headtohead_var_b3_2dc001fe/<cfg> --workers 16

Writes figs/out/provenance_rederive_<variant>.json.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fig3_headtohead as hh  # noqa: E402
from fig3_hh_freshanchor import payload_digest  # noqa: E402

COMMIT = "2dc001fe527c4dbaad17fa171da132cfdfe010e6"


def assert_checkout(root):
    head = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True,
                          text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if head != COMMIT or dirty:
        sys.exit(f"LUCID_ROOT {root} is at {head[:8]}{' (dirty)' if dirty else ''}, "
                 f"not a clean {COMMIT[:8]} -- refusing")
    return head


def sessions_by_key():
    out = {}
    for cfg in hh.CONFIGS:
        if cfg.get("intractable"):
            continue
        for s in hh.sessions_for(cfg)[0]:
            out[(cfg["key"], s["session"])] = (cfg, s)
    return out


def rerun(job, scratch):
    cfg, sess, cached = job
    c = json.loads(cached.read_text())
    out = scratch / cfg["key"] / sess["session"] / cached.parent.parent.name / "greedy.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    pf = out.with_name("params.json")
    pf.write_text(json.dumps(c.get("params") or {}))
    cmd = ["node", str(hh.GREEDY_DRIVER), "--session-idx", str(sess["det_session_idx"]),
           "--num-animals", str(c["numAnimals"]), "--calibration", str(sess["calibration"]),
           "--pred-h5-dir", sess["det_dir"], "--cameras", ",".join(c["cameras"]),
           "--params", str(pf), "--out", str(out)]
    if sess["max_frames"]:
        cmd += ["--max-frames", str(sess["max_frames"])]
    if c.get("excludeTail") is False:
        cmd += ["--no-exclude-tail"]
    if c.get("tailNan"):
        cmd += ["--tail-nan"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return {"cell": str(cached), "status": "error", "stderr": r.stderr[-400:]}
    a, b = payload_digest(cached), payload_digest(out)
    return {"cell": str(cached.relative_to(HERE)), "status": "identical" if a == b else "DIFFERENT",
            "cached_digest": a, "rerun_digest": b}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", action="append", required=True,
                    help="cache tree laid out <tree>/<config key>/<session>/greedy.json")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    root = os.environ.get("LUCID_ROOT") or sys.exit("set LUCID_ROOT")
    head = assert_checkout(root)
    idx = sessions_by_key()
    jobs = []
    for t in a.tree:
        t = (HERE / t) if not Path(t).is_absolute() else Path(t)
        for g in sorted(t.glob("*/*/greedy.json")):
            key, sess = g.parent.parent.name, g.parent.name
            if (key, sess) not in idx:
                sys.exit(f"{g}: no session config for ({key}, {sess})")
            cfg, s = idx[(key, sess)]
            jobs.append((cfg, s, g))
    print(f"[rederive] {len(jobs)} cached greedy runs, LUC3D {head[:8]}", flush=True)
    scratch = Path(tempfile.mkdtemp(prefix="rederive_", dir=os.environ.get("TMPDIR")))
    with ThreadPoolExecutor(a.workers) as ex:
        res = list(ex.map(lambda j: rerun(j, scratch), jobs))
    n = {k: sum(r["status"] == k for r in res) for k in ("identical", "DIFFERENT", "error")}
    out = HERE / "out" / f"provenance_rederive{hh.SUFFIX}.json"
    out.write_text(json.dumps({
        "generated_by": "figs/provenance_rederive.py", "lucid_root": root, "lucid_commit": head,
        "driver": str(hh.GREEDY_DRIVER), "trees": a.tree, "counts": n, "cells": res}, indent=1))
    print(f"[rederive] {n} -> {out.name}")
    sys.exit(0 if n["identical"] == len(res) else 1)


if __name__ == "__main__":
    main()
