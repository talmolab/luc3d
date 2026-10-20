#!/usr/bin/env python
"""Mouse-Dyad-10M b-series (2026-10-15, exploratory): a LIGHTER detection pool, SLAP-2M's rule.

The paper's Mouse-Dyad pool (`outputs/bmimica/det_h5/`) is built by
`luc3d-bench/scripts/bartul/bmimica_build_inputs.py` from `retracked/`, i.e. after sleap-nn's
filters (instance score >= 0.85, mean node score >= 0.55, >= 8 visible of 15 nodes incl. the
tail, OKS-overlap removal). SLAP-2M's pool (`lite_pools/bvis5`) instead keeps every raw
prediction with >= 5 visible BODY keypoints (tail not counted) and applies no score filters.

This builds the SLAP-2M-rule pool for Mouse-Dyad with the SAME code path as
bmimica_build_inputs.build_cam -- same canonical slot order (`canonical_order.sort_instances`),
same `instance_xy`, same (1, F, 4, 15, 2) layout, same gzip -- and only two differences:
source = the raw `BMimica/<sid>/<cam>/*.slp` predictions, and the body>=5 rule.

    --gate SID   rebuild det_h5 from retracked/ for one session into a scratch dir and require
                 byte-identical arrays with the existing det_h5 (proves this code == the original)
    (default)    build outputs/bmimica/det_h5_bvis5/ (refuses to touch det_h5/)

Run with the env that built det_h5: /root/vast/eric/luc3d-bench/lp3d_env/bin/python
"""
import argparse, glob, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np, h5py, sleap_io as sio

sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/lib")
from canonical_order import sort_instances, instance_xy  # noqa: E402

BM = "/root/vast/eric/luc3d-bench/outputs/bmimica"
RAW = "/root/vast/eric/BMimica"
OUT = f"{BM}/det_h5_bvis5"
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]
N_DETS, N_NODES = 4, 15
TAIL = (4, 7, 8, 9)
BODY = [i for i in range(N_NODES) if i not in TAIL]
BODY_MIN = 5


def build(src, dst, body_min=None):
    L = sio.load_slp(src, open_videos=False)
    F = max((lf.frame_idx for lf in L.labeled_frames), default=-1) + 1
    canon = np.full((F, N_DETS, N_NODES, 2), np.nan)
    kept = dropped = 0
    for lf in L.labeled_frames:
        insts = list(lf.instances)
        if body_min is not None:
            keep = [i for i in insts if np.isfinite(instance_xy(i)[BODY, 0]).sum() >= body_min]
            dropped += len(insts) - len(keep); insts = keep
        for slot, inst in enumerate(sort_instances(insts)):
            if slot >= N_DETS:
                break
            canon[lf.frame_idx, slot] = instance_xy(inst); kept += 1
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".partial"
    with h5py.File(tmp, "w") as f:
        f.create_dataset("tracks", data=canon[None], compression="gzip", compression_opts=1)
    os.rename(tmp, dst)
    return kept, dropped


def job(args):
    sid, cam = args
    dst = f"{OUT}/{sid}/{cam}_predictions.h5"
    if os.path.exists(dst):
        return sid, cam, "skip", 0, 0
    src = sorted(glob.glob(f"{RAW}/{sid}/{cam}/*.slp"))
    if not src:
        return sid, cam, "no_src", 0, 0
    k, d = build(src[0], dst, BODY_MIN)
    return sid, cam, "ok", k, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gate", default=None)
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args()
    if a.gate:
        bad = 0
        for cam in SER:
            tmp = f"/tmp/lite_pool_gate_{os.getpid()}/{cam}.h5"
            build(f"{BM}/retracked/{a.gate}/{cam}.slp", tmp, None)
            x = h5py.File(tmp, "r")["tracks"][:]; y = h5py.File(f"{BM}/det_h5/{a.gate}/{cam}_predictions.h5", "r")["tracks"][:]
            same = x.shape == y.shape and np.array_equal(x, y, equal_nan=True)
            print(f"  gate {a.gate}/{cam}: {'IDENTICAL' if same else 'DIFFERENT'} {x.shape}", flush=True)
            bad += not same
        print("GATE", "PASS" if not bad else "FAIL"); sys.exit(1 if bad else 0)
    assert OUT.rstrip("/") != f"{BM}/det_h5", "refusing to write the paper pool"
    sids = sorted(os.path.basename(d) for d in glob.glob(f"{BM}/det_h5/*") if os.path.isdir(d))
    jobs = [(s, c) for s in sids for c in SER]
    print(f"lite pool: {len(sids)} sessions, {len(jobs)} camera-sessions -> {OUT}", flush=True)
    K = D = n = 0
    with ProcessPoolExecutor(a.workers) as ex:
        for sid, cam, st, k, d in ex.map(job, jobs):
            K += k; D += d; n += st in ("ok", "skip")
            print(f"  {sid}/{cam} {st} kept {k} dropped {d}", flush=True)
    print(f"LITE POOL DONE: {n}/{len(jobs)} files, kept {K:,}, dropped {D:,} (body >= {BODY_MIN})")
    sys.exit(0 if n == len(jobs) else 1)


if __name__ == "__main__":
    main()
