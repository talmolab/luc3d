#!/usr/bin/env python3
"""Fig 10 prep: sDANNCE 3D tracks -> per-camera 2D detection H5s + GT sidecar.

Reprojects a session's sDANNCE 3D keypoints (or COM centroids) through the
session's MATLAB calibration into all 6 views, injects controlled difficulty
(pixel noise / instance dropout / occlusion-correlated dropout / node dropout),
anonymizes identity by permuting instance slots independently per (frame, view),
and writes:

  <out>/calibration.toml          anipose-style, parseable by the bench driver
  <out>/cam_{1..6}_predictions.h5 'tracks' [1, F, A, N, 2] float32, NaN=missing
  <out>/gt_perm.npy               int16 (nCams, F, A): slot -> source animal, -1=dropped
  <out>/meta.json                 all parameters + seed + counts

The projection chain is validated bit-exact against Label3D's own stored 2D
(fig10_validate.py; residuals ~1e-13 px on all TRIADS sessions/cameras).

Conditions (PLAN-fig10-triads-bedding.md §4):
  --noise-px S       iid Gaussian px noise per node per view        (C1)
  --drop-instance P  whole-instance-per-view Bernoulli dropout      (C2)
  --drop-node R      iid per-node per-view dropout                  (C2)
  --occl-dist D --occl-prob Q  drop instance in a view with prob Q
                     when another animal's COM is within D mm       (C3)
  --com-only         1-node detections from COM/predict* instance files (C4)

Usage:
  fig10_prep.py --session <dir> --out <dir> [--seed N] [conditions...]
"""
import argparse, glob, json, os, re, sys
import numpy as np
import scipy.io as sio
import h5py

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fig10_validate import load_cal, project


def load_pred_3d(S):
    """-> (F, A, 3, N) float64. Handles both layouts:
    TRIADS: SDANNCE/predict00/save_data_AVG*.mat, pred already (F, A, 3, N).
    SCN2A:  SDANNCE/bsl0.5_FM_rat{1,2}/save_data_AVG.mat, one rat per file."""
    joint = sorted(glob.glob(os.path.join(S, 'SDANNCE', 'predict*', 'save_data_AVG*.mat')))
    if joint:
        pred = sio.loadmat(joint[0])['pred']
        assert pred.ndim == 4, f'expected 4D joint pred, got {pred.shape}'
        return pred.astype(np.float64)
    per_rat = sorted(glob.glob(os.path.join(S, 'SDANNCE', '*rat*', 'save_data_AVG.mat')))
    assert per_rat, f'no save_data_AVG under {S}/SDANNCE'
    rats = []
    for p in per_rat:
        pr = sio.loadmat(p)['pred']
        if pr.ndim == 4:            # (F,1,3,N)
            assert pr.shape[1] == 1, pr.shape
            pr = pr[:, 0]
        assert pr.ndim == 3, pr.shape   # (F,3,N)
        rats.append(pr)
    F = min(r.shape[0] for r in rats)
    return np.stack([r[:F] for r in rats], axis=1).astype(np.float64)


def load_com_3d(S):
    """-> (F, A, 3, 1) from COM/predict*/instance{i}com3d.mat (real net outputs).
    BEDDING ships no COM/ dir; fall back to SDANNCE/*/com3d_used.mat, whose
    `com` is (F, 3, A) — the COMs the sDANNCE pass actually consumed."""
    files = sorted(glob.glob(os.path.join(S, 'COM', 'predict*', 'instance*com3d.mat')))
    if files:
        coms = [sio.loadmat(p)['com'] for p in files]     # each (F,3)
        F = min(c.shape[0] for c in coms)
        arr = np.stack([c[:F] for c in coms], axis=1)     # (F,A,3)
        return arr[:, :, :, None]
    used = sorted(glob.glob(os.path.join(S, 'SDANNCE', '*', 'com3d_used.mat')))
    assert used, f'no instance com3d under {S}/COM and no com3d_used under {S}/SDANNCE'
    com = sio.loadmat(used[0])['com']
    assert com.ndim == 3 and com.shape[1] == 3, com.shape  # (F, xyz, A) verified
    return com.transpose(0, 2, 1)[:, :, :, None]


def load_com_used_3d(S):
    """-> (F, A, 3, 1) from SDANNCE/*/com3d_used.mat — the COMs the sDANNCE
    pass actually consumed, i.e. the SAME identity provenance as the keypoint
    arm (load_pred_3d). Used by --com-source used (C4u like-for-like cells).
    TRIADS/BEDDING: one file, `com` (F, 3, A).
    SCN2A: one file per rat (SDANNCE/bsl0.5_FM_rat{1,2}/), `com` (F, 3);
    stacked in sorted (= rat-number) order, matching load_pred_3d's per-rat
    sorted order so GT animal indices line up with the keypoint arm."""
    used = sorted(glob.glob(os.path.join(S, 'SDANNCE', '*', 'com3d_used.mat')))
    assert used, f'no com3d_used under {S}/SDANNCE'
    coms = [sio.loadmat(p)['com'] for p in used]
    if len(coms) == 1 and coms[0].ndim == 3:
        com = coms[0]
        assert com.shape[1] == 3, com.shape                # (F, xyz, A)
        return com.transpose(0, 2, 1)[:, :, :, None].astype(np.float64)
    assert all(c.ndim == 2 and c.shape[1] == 3 for c in coms), \
        [c.shape for c in coms]
    F = min(c.shape[0] for c in coms)
    arr = np.stack([c[:F] for c in coms], axis=1)          # (F, A, 3)
    return arr[:, :, :, None].astype(np.float64)


def write_toml(cals, size, path):
    lines = []
    for i, c in enumerate(cals):
        lines.append(f'[cam_{i+1}]')
        lines.append(f'name = "cam_{i+1}"')
        lines.append('matrix = ' + json.dumps(c['K'].tolist()))
        # R passed as 3x3 (Camera.rotationMatrix accepts a matrix directly).
        # Transposed: LUCID projects column-vector style x = R@X + t, our load_cal
        # keeps MATLAB's row-vector R (x = X@R + t); R_cv = R_ml^T.
        lines.append('rotation = ' + json.dumps(c['R'].T.tolist()))
        lines.append('translation = ' + json.dumps(list(c['t'])))
        k1, k2, p1, p2 = c['dist']
        lines.append('distortions = ' + json.dumps([k1, k2, p1, p2, 0.0]))
        lines.append(f'size = [{size[0]}, {size[1]}]')
        lines.append('')
    open(path, 'w').write('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--noise-px', type=float, default=0.0)
    ap.add_argument('--drop-instance', type=float, default=0.0)
    ap.add_argument('--drop-node', type=float, default=0.0)
    ap.add_argument('--occl-dist', type=float, default=0.0, help='mm; 0 = off')
    ap.add_argument('--occl-prob', type=float, default=0.0)
    ap.add_argument('--com-only', action='store_true')
    ap.add_argument('--com-source', default='auto', choices=['auto', 'used'],
                    help="COM source for --com-only: 'auto' = COM/predict* "
                         "instance files with com3d_used fallback (existing C4 "
                         "cells, byte-identical default); 'used' = force SDANNCE "
                         "com3d_used.mat, same GT provenance as keypoints (C4u)")
    ap.add_argument('--max-frames', type=int, default=0)
    ap.add_argument('--size', default='1920,1200')
    args = ap.parse_args()
    S = args.session.rstrip('/')
    os.makedirs(args.out, exist_ok=True)
    W, H = [int(v) for v in args.size.split(',')]

    if args.com_only:
        X = load_com_used_3d(S) if args.com_source == 'used' else load_com_3d(S)
    else:
        X = load_pred_3d(S)                                    # (F,A,3,N)
    if args.max_frames:
        X = X[:args.max_frames]
    F, A, _, N = X.shape

    cal_paths = sorted(glob.glob(os.path.join(S, 'calibration', 'hires_cam*_params.mat')),
                       key=lambda p: int(re.search(r'cam(\d+)', p).group(1)))
    cals = [load_cal(p) for p in cal_paths]
    C = len(cals)
    write_toml(cals, (W, H), os.path.join(args.out, 'calibration.toml'))

    rng = np.random.default_rng(args.seed)
    # COM per animal for occlusion test (mm), from keypoint mean
    com = np.nanmean(X, axis=3)                                  # (F,A,3)
    # pairwise min distance to any *other* animal, per frame per animal
    d = np.linalg.norm(com[:, :, None, :] - com[:, None, :, :], axis=3)  # (F,A,A)
    d[:, np.arange(A), np.arange(A)] = np.inf
    min_other = d.min(axis=2)                                    # (F,A)

    gt_perm = np.full((C, F, A), -1, np.int16)
    counts = {'projected': 0, 'oob': 0, 'dropped_instance': 0, 'dropped_occl': 0,
              'dropped_node': 0}
    Xr = X.transpose(0, 1, 3, 2).reshape(F * A * N, 3)           # (F*A*N, 3)

    for ci, cal in enumerate(cals):
        pts, z = project(Xr, cal)                                # 0-based px
        pts = pts.reshape(F, A, N, 2)
        z = z.reshape(F, A, N)
        # behind-camera or out-of-sensor -> missing node
        oob = (z <= 0) | (pts[..., 0] < 0) | (pts[..., 0] >= W) \
              | (pts[..., 1] < 0) | (pts[..., 1] >= H) | ~np.isfinite(pts).all(axis=3)
        counts['oob'] += int(oob.sum())
        if args.noise_px > 0:
            pts = pts + rng.normal(0, args.noise_px, pts.shape)
        if args.drop_node > 0:
            dropn = rng.random((F, A, N)) < args.drop_node
            counts['dropped_node'] += int((dropn & ~oob).sum())
            oob |= dropn
        drop_inst = np.zeros((F, A), bool)
        if args.drop_instance > 0:
            drop_inst |= rng.random((F, A)) < args.drop_instance
        if args.occl_dist > 0 and args.occl_prob > 0:
            occl = (min_other < args.occl_dist) & (rng.random((F, A)) < args.occl_prob)
            counts['dropped_occl'] += int((occl & ~drop_inst).sum())
            drop_inst |= occl
        counts['dropped_instance'] += int(drop_inst.sum())
        pts[oob] = np.nan
        pts[drop_inst] = np.nan
        # all-NaN instances are "no detection" for the driver
        present = np.isfinite(pts).all(axis=3).any(axis=2)       # (F,A)
        counts['projected'] += int(present.sum())

        # permute slots per frame; record slot -> source animal
        out = np.full((F, A, N, 2), np.nan, np.float32)
        perms = np.argsort(rng.random((F, A)), axis=1)           # (F,A) slot->animal
        for fr in range(F):
            p = perms[fr]
            out[fr] = pts[fr, p]
            for slot in range(A):
                a = p[slot]
                gt_perm[ci, fr, slot] = a if present[fr, a] else -1
        with h5py.File(os.path.join(args.out, f'cam_{ci+1}_predictions.h5'), 'w') as f:
            f.create_dataset('tracks', data=out[None],           # [1,F,A,N,2]
                             chunks=(1, min(4096, F), A, N, 2),
                             compression='gzip', compression_opts=4)

    np.save(os.path.join(args.out, 'gt_perm.npy'), gt_perm)
    meta = dict(session=S, frames=F, animals=A, nodes=N, cams=C, seed=args.seed,
                noise_px=args.noise_px, drop_instance=args.drop_instance,
                drop_node=args.drop_node, occl_dist=args.occl_dist,
                occl_prob=args.occl_prob, com_only=args.com_only,
                com_source=args.com_source,
                size=[W, H], counts=counts)
    json.dump(meta, open(os.path.join(args.out, 'meta.json'), 'w'), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()
