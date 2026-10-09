#!/usr/bin/env python
"""Pack SLAP-2M's PRE-proofreading per-camera predictions into the keeptrack_h5s layout.

Source: the `*.predictions.slp` beside each camera video -- the detector output the
annotators started from (its `*.predictions.proofread.slp` twin is the proofread set).
Per camera: tracks (74, Fmax, 5, 15, 2) float64 and det_scores (74, Fmax, 5), NaN where
empty, gzip-4 chunked like outputs/keeptrack_h5s, session axis = the master-sheet row;
instances ordered by score (descending), at most 5 per frame, track identity dropped.
`--notail` additionally blanks TailTip and Tail_0-2. Needs sleap-io (lp3d_env).
"""
import argparse, os, sys, h5py, numpy as np, pandas as pd
from concurrent.futures import ProcessPoolExecutor
import sleap_io as sio
BENCH = "/root/vast/eric/luc3d-bench"; SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
HERE = os.path.dirname(os.path.abspath(__file__))
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
FMAX, D, N = 108133, 5, 15
TAIL = [4, 7, 8, 9]


def read_one(args):
    sidx, cam, rel = args
    p = os.path.join(SLAP_ROOT, rel.replace(".reprojections.slp.h5", ".predictions.slp"))
    if not os.path.exists(p):
        return sidx, cam, None, None, f"missing {p}"
    L = sio.load_slp(p)
    F = min(FMAX, max(lf.frame_idx for lf in L.labeled_frames) + 1)
    tr = np.full((F, D, N, 2), np.nan); sc = np.full((F, D), np.nan)
    for lf in L.labeled_frames:
        f = lf.frame_idx
        if f >= F: continue
        inst = sorted(lf.instances, key=lambda i: -(getattr(i, "score", None) or 0.0))[:D]
        for k, i in enumerate(inst):
            tr[f, k] = i.numpy()[:N]; sc[f, k] = getattr(i, "score", None) or 1.0
    return sidx, cam, tr, sc, None


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--notail", action="store_true"); ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args()
    out = os.path.join(HERE, "out", "tmp", "predslp_notail_pool" if a.notail else "predslp_pool"); os.makedirs(out, exist_ok=True)
    ms = pd.read_csv(f"{BENCH}/outputs/detections_only_master_sheet.tsv", sep="\t").reset_index(drop=True)
    jobs = [(i, c, r[f"{c}_reproj_h5"]) for i, r in ms.iterrows() for c in CAMS if isinstance(r.get(f"{c}_reproj_h5"), str)]
    files = {}
    for cam in CAMS:
        g = h5py.File(os.path.join(out, f"{cam}_predictions.h5"), "w")
        g.create_dataset("tracks", (len(ms), FMAX, D, N, 2), dtype="f8", chunks=(1, 4096, D, N, 2), compression="gzip", compression_opts=4, fillvalue=np.nan)
        g.create_dataset("det_scores", (len(ms), FMAX, D), dtype="f8", chunks=(1, 4096, D), compression="gzip", compression_opts=4, fillvalue=np.nan)
        g.attrs.update({"camera": cam, "n_dets": D, "ordering": "score_desc", "source": "pre-proofreading *.predictions.slp" + ("; tail nodes 4,7,8,9 blanked" if a.notail else "")})
        files[cam] = g
    done = 0
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for sidx, cam, tr, sc, err in ex.map(read_one, jobs, chunksize=2):
            done += 1
            if err: print(f"  FAIL [{sidx}] {cam}: {err}", flush=True); continue
            if a.notail: tr[:, :, TAIL, :] = np.nan
            files[cam]["tracks"][sidx, :tr.shape[0]] = tr; files[cam]["det_scores"][sidx, :sc.shape[0]] = sc
            if done % 50 == 0: print(f"  {done}/{len(jobs)}", flush=True)
    for g in files.values(): g.close()
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
