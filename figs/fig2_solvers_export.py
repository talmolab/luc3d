#!/usr/bin/env python3
"""
Export REAL multi-camera observations for Fig 4's DLT-vs-BA measurement.

Fig 4 compares triangulation methods, so it must run them on real detections with
real lens distortion against a real reference 3D -- not on synthetic points, where
the distortion model used to synthesise is the same one being solved and the
comparison is partly circular.

Reuses figs/fig2_measure.py's pipeline (calibration load, P-frame -> calibration
alignment, per-view identity matching against the proofread 3D) and writes, for one
BMimica session:

  cameras[]   name / matrix / distortions / rvec / tvec / size, i.e. exactly the
              arguments LUCID's `Camera` constructor takes.
  keypoints[] obs: the RAW (still distorted) 2D detection in each of the 5 cameras,
              null where that view has no matched detection;
              gt3d: the proofread 3D for that keypoint, in the CALIBRATION frame.
  mm_per_unit scale factor, so 3D errors can be reported in millimetres.

Only keypoints matched in every camera are exported, so DLT and BA see identical
inputs and the comparison isolates the solver.

Run with the bench env:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig4_export.py
"""
from __future__ import annotations

import argparse
import glob
import itertools
import json
import os
import sys

import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/bartul")

from build_gt_reproj import (load_calibration, load_sleap_2d, undistort,  # noqa: E402
                             ransac_align, SERIALS)
from fig2_measure import (triangulate_batch, project, ROOT, MATCH_MAX_PX)  # noqa: E402

OUT = os.path.join(HERE, "out", "fig4_input.json")


def main():
    ap = argparse.ArgumentParser()
    # DEFAULTS ARE THE WHOLE CORPUS, deliberately. They used to be --sessions 1
    # --stride 900 --max-keypoints 8000, i.e. 8,000 keypoints from sorted(sessions)[0].
    # That is pseudo-replication -- correlated keypoints from one recording on one of
    # the rig's three calibrations -- and it materially changed Fig 4's conclusion: on
    # that one session the non-linear refinement was WORSE on a held-out view, and over
    # all 50 it is slightly better. That session is also the corpus extreme on both of
    # the figure's headline metrics (see figs/captions/fig4.md). So the default now
    # reproduces the figure, and a subset has to be asked for explicitly.
    ap.add_argument("--session", default=None)
    ap.add_argument("--sessions", type=int, default=0,
                    help="how many BMimica sessions to export; 0 = ALL "
                         "(ignored if --session)")
    ap.add_argument("--stride", type=int, default=60,
                    help="frame subsample; smaller = more keypoints")
    ap.add_argument("--max-keypoints", type=int, default=0,
                    help="cap PER SESSION; 0 = no cap")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    sids = sorted(os.path.basename(p) for p in glob.glob(f"{ROOT}/*")
                  if os.path.isdir(p) and os.path.basename(p)[:1].isdigit())
    if args.session:
        todo = [args.session]
    elif args.sessions and args.sessions > 0:
        todo = sids[:args.sessions]
    else:
        todo = sids

    # BINARY interchange. At the scale Fig 4b wants (hundreds of thousands of
    # keypoints across sessions) a JSON array of coordinate pairs is hundreds of MB of
    # text to serialise and parse. Observations and reference points go into a flat
    # float64 .bin instead; the .json keeps only the header the reader needs.
    bin_path = os.path.splitext(args.out)[0] + ".bin"
    blocks = []
    obs_chunks, gt_chunks = [], []
    total = 0
    for sid in todo:
        try:
            res = export_session(sid, args.stride, args.max_keypoints)
        except Exception as e:                                       # noqa: BLE001
            print(f"  {sid}: FAIL {type(e).__name__}: {e}")
            continue
        if res is None:
            print(f"  {sid}: skip")
            continue
        obs, gt, cams, mm, cal_idx = res
        blocks.append(dict(session=sid, offset=total, count=obs.shape[0],
                           mm_per_unit=mm, calibration=cal_idx))
        obs_chunks.append(obs.astype(np.float64, copy=False))
        gt_chunks.append(gt.astype(np.float64, copy=False))
        total += obs.shape[0]
        print(f"  {sid}: {obs.shape[0]} keypoints (running {total})")
    if not blocks:
        raise SystemExit("nothing exported")

    OBS = np.concatenate(obs_chunks, 0)      # (K, C, 2)
    GT = np.concatenate(gt_chunks, 0)        # (K, 3)
    with open(bin_path, "wb") as f:
        f.write(OBS.tobytes(order="C"))
        f.write(GT.tobytes(order="C"))

    payload = dict(
        format="bin-v1", bin=os.path.basename(bin_path),
        keypoints=int(total), n_cameras=int(OBS.shape[1]),
        cameras=CAMERAS_OUT, calibrations=CALIBRATIONS, blocks=blocks,
        stride=int(args.stride), sessions=[b["session"] for b in blocks],
        skipped=SKIPPED,
        note=("obs are RAW distorted detections matched to the proofread animal in "
              "every view; gt3d is the proofread 3D in that session's calibration "
              "frame. Layout: float64 obs (K,C,2) then float64 gt3d (K,3), C order. "
              "mm_per_unit AND calibration are PER BLOCK: BMimica spans several "
              "recording dates and the rig was recalibrated between them, so `blocks[i]"
              ".calibration` indexes `calibrations`. `cameras` is calibrations[0], kept "
              "for readers that only handle a single rig."))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f)
    print(f"\n[bin]  {bin_path}  {os.path.getsize(bin_path)/1e6:.1f} MB")
    print(f"[json] {args.out}  {total} keypoints across {len(blocks)} sessions")
    for sk in SKIPPED:
        print(f"  skipped {sk['session']}: {sk['why']}")


CAMERAS_OUT = []
CALIBRATIONS = []
SKIPPED = []


def export_session(sid, stride, max_keypoints):
    global CAMERAS_OUT
    sd = f"{ROOT}/{sid}"

    cams_all = load_calibration(glob.glob(f"{sd}/calibration/*_calibration.toml")[0])
    with h5py.File(glob.glob(f"{sd}/*points3d*.h5")[0]) as f:
        Xp = f["tracks"][:]
    raw = {c: load_sleap_2d(glob.glob(f"{sd}/{c}/*.analysis.h5")[0])[:, :2]
           for c in SERIALS}
    F = min(Xp.shape[0], min(v.shape[0] for v in raw.values()))
    A, N, C = Xp.shape[1], Xp.shape[2], len(SERIALS)
    Ps = np.stack([cams_all[c]["P"] for c in SERIALS], 0)

    # P-frame -> calibration frame, same recipe as fig2_measure
    samp = np.arange(0, F, max(1, F // 4000))
    und_s = np.stack([undistort(raw[c][samp], cams_all[c]["K"], cams_all[c]["dist"])
                      for c in SERIALS], 0)
    S = len(samp)
    Xc = triangulate_batch(und_s.reshape(C, -1, 2),
                          Ps, ~np.isnan(und_s.reshape(C, -1, 2)).any(-1)
                          ).reshape(S, A, N, 3)
    both = (~np.isnan(Xc).any(-1)) & (~np.isnan(Xp[samp]).any(-1))
    (s, R, t), _, _ = ransac_align(Xp[samp][both], Xc[both], thresh=8.0)
    mm_per_unit = (1.0 / s) * 1000.0

    fidx = np.arange(0, F, stride)
    Fm = len(fidx)
    Xg = Xp[fidx].reshape(-1, 3)
    good = ~np.isnan(Xg).any(1)
    Xcal = np.full_like(Xg, np.nan)
    Xcal[good] = (s * (R @ Xg[good].T).T + t)
    gt2d = np.stack([project(Xcal, cams_all[c]) for c in SERIALS], 0)

    # per-view identity matching against the proofread reprojection
    M = Xcal.shape[0]
    obs = np.full((C, M, 2), np.nan)
    for ci, c in enumerate(SERIALS):
        r = raw[c][fidx]
        T = r.shape[1]
        gt = gt2d[ci].reshape(Fm, A, N, 2)
        cost = np.full((Fm, A, T), np.inf)
        for a in range(A):
            for tt in range(T):
                with np.errstate(invalid="ignore"):
                    cost[:, a, tt] = np.nanmean(
                        np.linalg.norm(r[:, tt] - gt[:, a], axis=-1), axis=1)
        cost = np.nan_to_num(cost, nan=np.inf, posinf=np.inf)
        perms = list(itertools.permutations(range(T), min(A, T)))
        tot = np.stack([sum(cost[:, a, p[a]] for a in range(len(p))) for p in perms], 1)
        pick = np.argmin(tot, axis=1)
        best = np.full((Fm, A), -1, dtype=np.int64)
        for pi, p in enumerate(perms):
            rows = np.where(pick == pi)[0]
            for a in range(len(p)):
                best[rows, a] = p[a]
        take = np.full((Fm, A, N, 2), np.nan)
        for a in range(A):
            for tt in range(T):
                rows = np.where(best[:, a] == tt)[0]
                if len(rows):
                    ok = cost[rows, a, tt] < MATCH_MAX_PX
                    take[rows[ok], a] = r[rows[ok], tt]
        obs[ci] = take.reshape(-1, 2)

    complete = (~np.isnan(obs).any(-1)).all(0) & ~np.isnan(Xcal).any(1)
    idx = np.where(complete)[0]
    if max_keypoints and max_keypoints > 0:      # 0 = keep every complete keypoint
        idx = idx[:max_keypoints]
    if len(idx) < 200:
        return None

    cameras = []
    for c in SERIALS:
        cc = cams_all[c]
        cameras.append(dict(
            name=c,
            matrix=[[float(v) for v in row] for row in cc["K"]],
            distortions=[float(v) for v in np.asarray(cc["dist"]).ravel()[:5]],
            rvec=[float(v) for v in np.asarray(cc["rvec"]).ravel()],
            tvec=[float(v) for v in np.asarray(cc["t"]).ravel()],
            size=[1280, 1024],
        ))
    # Every BMimica session shares one rig, so the camera block is written once. If a
    # session ever disagreed the reader would silently use the wrong intrinsics, so
    # assert instead of assuming.
    # Register this session's calibration and reuse an identical one, so the reader can
    # key intrinsics per block. Sessions on different calibrations are now KEPT.
    cal_idx = None
    for i, cal in enumerate(CALIBRATIONS):
        if all(a["name"] == b["name"] and a["matrix"] == b["matrix"]
               and a["rvec"] == b["rvec"] and a["tvec"] == b["tvec"]
               and a["distortions"] == b["distortions"]
               for a, b in zip(cal, cameras)):
            cal_idx = i
            break
    if cal_idx is None:
        CALIBRATIONS.append(cameras)
        cal_idx = len(CALIBRATIONS) - 1
    if not CAMERAS_OUT:
        CAMERAS_OUT = cameras

    # (K, C, 2) raw observations, and (K, 3) reference 3D
    OBS = np.transpose(obs[:, idx, :], (1, 0, 2))
    return OBS, Xcal[idx], cameras, float(mm_per_unit), cal_idx


if __name__ == "__main__":
    main()
