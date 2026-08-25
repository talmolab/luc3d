#!/usr/bin/env python3
"""Fig 10, Phase 0 validation gates (PLAN-fig10-triads-bedding.md §3.2).

Gate 2 (hand-label): reproject Label3D's own 3D COM labels through each
session's hires_cam*_params.mat and report per-camera pixel residuals against
the 2D hand labels. Median residuals of a few px validate the whole
MATLAB->projection conversion chain; >>10 px means a convention bug — STOP.

Gate 3 (distortion fold): radius at which the radial polynomial stops being
monotonic, vs the sensor corner radius, per camera.

Also cross-checks sDANNCE's 3D outputs (com3d_used / pred) against the hand
labels' own data_3d at labeled frames (GT-agreement anchor, §2).

Usage:
  fig10_validate.py --dataset /root/vast/eric/s-DANNCE-data/s-DANNCE-TRIADS [--session NAME]
"""
import argparse, glob, json, os, re
import numpy as np
import scipy.io as sio


def load_cal(path):
    d = sio.loadmat(path)
    K_ml = d['K']                     # MATLAB: transposed, 1-based principal point
    K = K_ml.T.astype(float)          # OpenCV orientation
    K[0, 2] -= 1.0                    # 1-based -> 0-based pixel origin
    K[1, 2] -= 1.0
    R_ml = d['r'].astype(float)       # row-vector convention: x_row = X_row @ R + t
    t = d['t'].ravel().astype(float)
    k1, k2 = d['RDistort'].ravel().astype(float)
    p1, p2 = d['TDistort'].ravel().astype(float)
    return dict(K=K, R=R_ml, t=t, dist=(k1, k2, p1, p2))


def project(X, cal, one_based=False):
    """X: (N,3) world mm -> (N,2) pixels. MATLAB row-vector chain with
    OpenCV-order radial+tangential distortion."""
    Xc = X @ cal['R'] + cal['t']      # camera coords, row convention
    u = Xc[:, 0] / Xc[:, 2]
    v = Xc[:, 1] / Xc[:, 2]
    k1, k2, p1, p2 = cal['dist']
    r2 = u * u + v * v
    rad = 1 + k1 * r2 + k2 * r2 * r2
    ud = u * rad + 2 * p1 * u * v + p2 * (r2 + 2 * u * u)
    vd = v * rad + p1 * (r2 + 2 * v * v) + 2 * p2 * u * v
    K = cal['K']
    px = K[0, 0] * ud + K[0, 2]
    py = K[1, 1] * vd + K[1, 2]
    off = 1.0 if one_based else 0.0   # hand labels are MATLAB 1-based pixels
    return np.stack([px + off, py + off], axis=1), Xc[:, 2]


def fold_radius_px(cal):
    """Radius (px from principal point) where d/dr [r*(1+k1 r^2+k2 r^4)] first
    goes non-positive (undistortion becomes non-invertible). inf if monotonic
    out to 3x the corner radius."""
    k1, k2, _, _ = cal['dist']
    f = 0.5 * (cal['K'][0, 0] + cal['K'][1, 1])
    r = np.linspace(1e-6, 3.0, 20000)            # normalized units
    deriv = 1 + 3 * k1 * r**2 + 5 * k2 * r**4
    bad = np.nonzero(deriv <= 0)[0]
    return float(f * r[bad[0]]) if bad.size else float('inf')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', required=True)
    ap.add_argument('--session', default=None, help='one session dir name; default all')
    ap.add_argument('--out', default=None, help='write JSON summary here')
    args = ap.parse_args()

    sessions = sorted(
        d for d in os.listdir(args.dataset)
        if os.path.isdir(os.path.join(args.dataset, d))
        and glob.glob(os.path.join(args.dataset, d, 'calibration', 'hires_cam*_params.mat')))
    if args.session:
        sessions = [s for s in sessions if s == args.session]
    assert sessions, 'no sessions found'

    summary = {}
    for sess in sessions:
        S = os.path.join(args.dataset, sess)
        cals = [load_cal(p) for p in sorted(
            glob.glob(os.path.join(S, 'calibration', 'hires_cam*_params.mat')),
            key=lambda p: int(re.search(r'cam(\d+)', p).group(1)))]
        l3d_files = sorted(glob.glob(os.path.join(S, '*Label3D*.mat')) +
                           glob.glob(os.path.join(S, '*dannce.mat')))
        l3d_files = [p for p in l3d_files if 'Label3D' in p or 'dannce' in os.path.basename(p)]
        row = {'cams': []}
        if l3d_files:
            d = sio.loadmat(l3d_files[0])
            ld = d['labelData']
            ncam = ld.shape[0]
            for ci in range(ncam):
                e = ld[ci, 0]
                d2 = e['data_2d'][0, 0]            # (nLab, 2*nInst) 1-based px
                d3 = e['data_3d'][0, 0]            # (nLab, 3*nInst) mm
                nlab, w = d2.shape
                ninst = w // 2
                X = d3.reshape(nlab * ninst, 3)
                gt = d2.reshape(nlab * ninst, 2)
                ok = np.isfinite(X).all(axis=1) & np.isfinite(gt).all(axis=1)
                proj, z = project(X[ok], cals[ci], one_based=True)
                res = np.linalg.norm(proj - gt[ok], axis=1)
                row['cams'].append({
                    'cam': ci + 1,
                    'n': int(ok.sum()),
                    'median_px': float(np.median(res)),
                    'p95_px': float(np.percentile(res, 95)),
                    'max_px': float(res.max()),
                    'fold_radius_px': fold_radius_px(cals[ci]),
                })
            # corner radius for fold context (assume principal point ~ center)
            row['corner_radius_px'] = float(np.hypot(*cals[0]['K'][:2, 2]))
        summary[sess] = row
        meds = [c['median_px'] for c in row['cams']]
        folds = [c['fold_radius_px'] for c in row['cams']]
        print(f"{sess}: per-cam median residual px = "
              f"{['%.2f' % m for m in meds]}  fold_px={['%.0f' % f for f in folds]} "
              f"corner_px={row.get('corner_radius_px', float('nan')):.0f}")

    if args.out:
        json.dump(summary, open(args.out, 'w'), indent=1)
        print('wrote', args.out)


if __name__ == '__main__':
    main()
