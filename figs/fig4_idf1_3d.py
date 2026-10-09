#!/usr/bin/env python
"""Cross-view IDF1 scored in 3D instead of on per-camera 2D boxes (2026-10-07, Eric:
"what would this idf1 metric look like if done on the 3D pose rather than the matched
reprojections to 2d?").

THE 2D SCORE (fig3_score.score_session, what Fig 4b d draws) gives every detection the
tracker's identity, matches it to a proofread 2D box by IoU >= 0.5 per camera, and
pools all cameras into one motmetrics accumulator under ONE id mapping -- so it
rewards identities that agree across views, but it never checks that the detections
grouped under one identity are the SAME animal in 3D.

THIS SCORE builds the tracker's 3D animals and scores them against the proofread 3D:
  1. per frame, per tracker identity, take the detection it was assigned in each
     camera (the same `assignments` the 2D score reads);
  2. undistort and DLT-triangulate each keypoint from every camera that has it
     (>= 2 views; `fig2_measure.triangulate_batch`, the figures' shared DLT) -- no
     RANSAC, no outlier rejection, so a detection of the WRONG animal grouped into an
     identity drags that identity's 3D pose away from both animals;
  3. match identities to proofread 3D animals (`points3d.h5`) by MEAN 3D distance over
     the non-tail keypoints both carry, gated at --thresh-mm;
  4. one motmetrics accumulator per session over frames -> IDF1 / IDP / IDR.
Tail nodes are excluded throughout, as the tracker itself excludes them.

Units are mm. At the default 30 mm gate, animals' 3D centroids are closer than the
gate in < 1% of frames (the 1st percentile of inter-animal centroid distance is ~46 mm
on a 2-animal d7 session), so the gate does not let one animal stand in for another.
--thresh-mm takes several values; each is scored from the same triangulation.

    PYTHONPATH=<headless cv2> $LIEZL figs/fig4_idf1_3d.py --pool predslp --workers 24

Output: figs/out/fig4_idf1_3d_<pool>.json
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/bartul")
import fig4_slap2m as f9  # noqa: E402  (sessions(), POOLS, CAMERAS; puts evaluate on path)
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402
from build_gt_reproj import load_calibration, undistort  # noqa: E402
from fig2_measure import triangulate_batch  # noqa: E402

OUT = FIGS / "out"
CONFIG = "sync_stale20_dist25"
TAIL = [4, 7, 8, 9]
CHUNK = 20000


def tracker_dir(pool):
    return OUT / "tmp" / ("fig9slap" if pool == "keeptrack" else f"fig9slap_{pool}") / CONFIG


def score_session(s, pool, threshes):
    luc = json.loads((tracker_dir(pool) / f"{s['session']}.json").read_text())
    cams_all = load_calibration(s["calibration"])
    cams = [c for c in f9.CAMERAS if c in cams_all]
    with h5py.File(os.path.join(f9.SLAP_ROOT if hasattr(f9, "SLAP_ROOT") else
                                "/root/talmolab-smb/eric/slap_2m",
                                s["points3d"]), "r") as f:
        gt3 = f["tracks"][:]                                   # (F, T, N, 3)
    body = [n for n in range(gt3.shape[2]) if n not in TAIL]
    gt3 = gt3[:, :, body]

    det, ids = {}, {}
    nf = min(s["max_frames"], gt3.shape[0])
    for c in cams:
        with h5py.File(f9.POOLS[pool] / f"{c}_predictions.h5", "r") as f:
            d = f["tracks"][s["det_session_idx"], :nf][:, :, body]   # (F, D, Nb, 2)
        nf = min(nf, d.shape[0])
        det[c] = d
    for c in cams:
        det[c] = det[c][:nf]
        ids[c] = ev.luc3d_assignments_for_cam(luc, c, nf, det[c].shape[1])
        # undistort once per camera
        det[c] = undistort(det[c], cams_all[c]["K"], cams_all[c]["dist"])
    idents = sorted({i["id"] for i in luc["identities"]})
    I, Nb, C = len(idents), len(body), len(cams)
    Ps = np.stack([cams_all[c]["P"] for c in cams])

    accs = {t: mm.MOTAccumulator(auto_id=False) for t in threshes}
    n_hyp = 0
    for f0 in range(0, nf, CHUNK):
        f1 = min(nf, f0 + CHUNK)
        Fc = f1 - f0
        uv = np.full((C, Fc, I, Nb, 2), np.nan)
        for ci, c in enumerate(cams):
            a = ids[c][f0:f1]                                  # (Fc, D)
            for ii, ident in enumerate(idents):
                fr, dj = np.nonzero(a == ident)
                uv[ci, fr, ii] = det[c][f0 + fr, dj]
        mask = np.isfinite(uv[..., 0])                         # (C, Fc, I, Nb)
        X = triangulate_batch(uv.reshape(C, -1, 2), Ps, mask.reshape(C, -1))
        X = X.reshape(Fc, I, Nb, 3)
        G = gt3[f0:f1]                                         # (Fc, T, Nb, 3)
        # mean distance over keypoints both carry: (Fc, T, I)
        diff = np.linalg.norm(G[:, :, None] - X[:, None], axis=-1)   # (Fc, T, I, Nb)
        with np.errstate(invalid="ignore"):
            D = np.nanmean(diff, axis=-1)
        hyp_ok = np.isfinite(X[..., 0]).any(-1)               # (Fc, I)
        gt_ok = np.isfinite(G[..., 0]).any(-1)                 # (Fc, T)
        n_hyp += int(hyp_ok.sum())
        for k in range(Fc):
            gi = np.nonzero(gt_ok[k])[0]
            hi = np.nonzero(hyp_ok[k])[0]
            d = D[k][np.ix_(gi, hi)]
            for t, acc in accs.items():
                dd = np.where(d <= t, d, np.nan)
                acc.update(gi.tolist(), [idents[h] for h in hi], dd, frameid=f0 + k)
    out = {"session": s["session"], "difficulty": s["difficulty"],
           "animals": s["animals"], "frames": nf, "hypotheses": n_hyp}
    mh = mm.metrics.create()
    for t, acc in accs.items():
        r = mh.compute(acc, metrics=["idf1", "idp", "idr", "num_switches"], name="x")
        out[f"t{t:g}"] = {k: float(r[k]["x"]) for k in ("idf1", "idp", "idr",
                                                         "num_switches")}
    return out


def _job(args):
    s, pool, threshes = args
    try:
        return s["session"], score_session(s, pool, threshes), None
    except Exception as e:  # noqa: BLE001
        import traceback
        return s["session"], None, traceback.format_exc()[-1500:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default="predslp", choices=["keeptrack", "predslp"])
    ap.add_argument("--thresh-mm", default="15,30,50")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--max-sessions", type=int, default=0)
    ap.add_argument("--multi-only", action="store_true")
    a = ap.parse_args()
    threshes = [float(x) for x in a.thresh_mm.split(",")]
    f9.KEEPTRACK = f9.POOLS[a.pool]
    import pandas as pd
    ms = pd.read_csv(f9.MASTER, sep="\t", index_col=0).reset_index(drop=True)
    p3 = {str(r["session"]): r["points_3D"] for _, r in ms.iterrows()}
    sess, _sk = f9.sessions()
    for s in sess:
        s["points3d"] = p3[s["session"]]
    if a.multi_only:
        sess = [s for s in sess if s["animals"] > 1]
    if a.max_sessions:
        sess = sess[:a.max_sessions]
    print(f"[3d] {len(sess)} sessions, pool {a.pool}, gates {threshes} mm", flush=True)
    t0 = time.time()
    res, errs = [], []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, (s, a.pool, threshes)) for s in sess]
        for i, f in enumerate(as_completed(futs), 1):
            sid, r, err = f.result()
            if err:
                errs.append(f"{sid}: {err}")
                print(f"[3d] FAILED {sid}: {err}", flush=True)
            else:
                res.append(r)
            if i % 10 == 0 or i == len(futs):
                print(f"[3d] {i}/{len(futs)} ({time.time()-t0:.0f}s)", flush=True)
    dest = OUT / (f"fig4_idf1_3d_{a.pool}" + ("_pilot" if a.max_sessions else "") + ".json")
    dest.write_text(json.dumps({"generated_by": "figs/fig4_idf1_3d.py", "pool": a.pool,
                                "config": CONFIG, "gates_mm": threshes,
                                "per_session": res, "failures": errs}, indent=1))
    print(f"[3d] wrote {dest} ({len(res)} ok, {len(errs)} failed)")


if __name__ == "__main__":
    main()
