#!/usr/bin/env python3
"""Run fig2_measure.measure_session over every session, one process each.

The measurement is untouched; this only replaces main()'s serial session loop.
Concurrency is capped AND gated on free memory, because a stride-1 session peaks
around 16 GB and other jobs share this machine.
"""
import glob
import os
import subprocess
import sys
import time

SP = os.path.dirname(os.path.abspath(__file__))
PY = "/root/vast/eric/luc3d-bench/liezl_env/bin/python"
ONE = os.path.join(SP, "fig2_one.py")
ROOT = "/root/vast/eric/BMimica"

STRIDE = int(os.environ.get("STRIDE", "1"))
NPROC = int(os.environ.get("NPROC", "12"))
MIN_AVAIL_GB = float(os.environ.get("MIN_AVAIL_GB", "80"))
OUTDIR = os.path.join(SP, f"s{STRIDE}")


def avail_gb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024 / 1024
    return 1e9


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    sids = sorted(os.path.basename(p) for p in glob.glob(f"{ROOT}/*")
                  if os.path.isdir(p) and os.path.basename(p)[0].isdigit())
    env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
               MKL_NUM_THREADS="1", NUMEXPR_NUM_THREADS="1")
    pending = [s for s in sids
               if not os.path.exists(os.path.join(OUTDIR, s + ".json"))]
    print(f"[launch] {len(sids)} sessions, {len(pending)} to run, stride={STRIDE}, "
          f"nproc={NPROC}", flush=True)
    running, t0 = {}, time.time()
    done = fail = 0
    while pending or running:
        while pending and len(running) < NPROC and avail_gb() > MIN_AVAIL_GB:
            sid = pending.pop(0)
            log = open(os.path.join(OUTDIR, sid + ".log"), "w")
            p = subprocess.Popen(
                [PY, ONE, sid, str(STRIDE), os.path.join(OUTDIR, sid + ".json")],
                stdout=log, stderr=subprocess.STDOUT, env=env)
            running[p] = (sid, log, time.time())
            print(f"[start {time.time()-t0:7.0f}s] {sid}  "
                  f"({len(running)} running, {len(pending)} queued, "
                  f"{avail_gb():.0f} GB avail)", flush=True)
            time.sleep(5)
        time.sleep(10)
        for p in list(running):
            if p.poll() is None:
                continue
            sid, log, ts = running.pop(p)
            log.close()
            ok = p.returncode == 0
            done += ok
            fail += (not ok)
            with open(os.path.join(OUTDIR, sid + ".log")) as f:
                tail = f.read().strip().splitlines()
            msg = next((l for l in tail if l.startswith(sid)), "")
            print(f"[done  {time.time()-t0:7.0f}s] {sid} rc={p.returncode} "
                  f"{time.time()-ts:.0f}s | {msg}", flush=True)
    print(f"[launch] finished in {(time.time()-t0)/3600:.2f} h  "
          f"ok={done} fail/skip={fail}", flush=True)


if __name__ == "__main__":
    main()
