#!/usr/bin/env python
"""Does the SHIPPED tracker reproduce the deposited fresh-anchor benchmark runs?

Every Supplementary Figure 1F / Supplementary Section 5.2 number (413 switches, IDF1
0.861, ...) was measured through `figs/fig6-bench/fig6_bench.mjs`, which serves
`pose/cross-view-tracker.js` from the EXPERIMENTAL overlay
`figs/fig6-bench/xv_experimental.js` with method {sync: true, stale: 20} and
thresholds {distanceThreshold: 25}. The manuscript (L336) says that configuration is
the one merged into `pose/cross-view-tracker.js` (PR #210, a95703d), "so every
measurement in the paper describes the released tracker". `fig8_methods.py --verify`
proved the overlay reproduces the PRE-fix shipped tracker with no flags set; nothing
deposited proves the POST-fix direction. This does.

It runs the REAL module through `figs/fig3-bench/fig3_bench.mjs` (base hooks, no
redirect) with the same thresholds file the deposit used, and compares the SHA-256 of
the tracker's identities+frames payload (the project's own `payload_digest`
convention) against `figs/out/tmp/fig8m50/sync_stale20_dist25/<session>.json`.

    NODE=/root/vast/eric/node22_env/bin/node figs/.venv/bin/python \
        figs/verify_shipped_tracker.py --sessions 3 --workers 3

Output: figs/out/verify_shipped_tracker.json
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fig3_sweep as f3  # noqa: E402  (DET, CAMERAS, NUM_ANIMALS, calib_for)

REF = HERE / "out" / "tmp" / "fig8m50" / "sync_stale20_dist25"
DRIVER = HERE / "fig3-bench" / "fig3_bench.mjs"
WORK = HERE / "out" / "tmp" / "verify_shipped"
NODE = os.environ.get("NODE", "node")


def payload_digest(path):
    """Same definition as fig3_hh_freshanchor.payload_digest / fig8_param_sweeps."""
    b = Path(path).read_bytes()
    i = b.find(b'"identities":')
    j = b.find(b',"framesProcessed"', i)
    return hashlib.sha256(b[i:j]).hexdigest() if i >= 0 and j >= 0 else None


def run(session):
    params = WORK / "params.json"
    out = WORK / f"{session}.json"
    if not (out.exists() and out.stat().st_size > 100):
        cmd = [NODE, str(DRIVER), "--session-idx", "0", "--num-animals",
               str(f3.NUM_ANIMALS), "--calibration", f3.calib_for(session),
               "--pred-h5-dir", str(f3.DET / session), "--out", str(out),
               "--cameras", ",".join(f3.CAMERAS), "--params", str(params)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if r.returncode != 0:
            return session, None, None, r.stderr[-600:]
    return session, payload_digest(out), payload_digest(REF / f"{session}.json"), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=3)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    # the reference params carry a `method` block for the overlay; the shipped driver
    # takes thresholds only, and the shipped module's defaults ARE sync + stale 20.
    p = json.loads((REF / "params.json").read_text())
    p.pop("method", None)
    (WORK / "params.json").write_text(json.dumps(p))
    sess = sorted(q.stem for q in REF.glob("*.json") if q.stem != "params")[: a.sessions]
    rows = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for f in as_completed([ex.submit(run, s) for s in sess]):
            s, mine, ref, err = f.result()
            same = mine is not None and mine == ref
            rows.append({"session": s, "shipped": mine, "deposit": ref,
                         "identical": same, "error": err})
            print(f"{s}: {'IDENTICAL' if same else 'DIFFERENT'}"
                  f"{'  ERR ' + err if err else ''}", flush=True)
    rows.sort(key=lambda r: r["session"])
    n_same = sum(r["identical"] for r in rows)
    (HERE / "out" / "verify_shipped_tracker.json").write_text(json.dumps({
        "generated_by": "figs/verify_shipped_tracker.py",
        "reference": str(REF.relative_to(HERE)),
        "driver": "figs/fig3-bench/fig3_bench.mjs (real pose/cross-view-tracker.js)",
        "n_sessions": len(rows), "n_identical": n_same, "rows": rows}, indent=1))
    print(f"{n_same}/{len(rows)} sessions byte-identical")


if __name__ == "__main__":
    main()
