#!/usr/bin/env python3
"""Fig 10 C6 prep: BEDDING per-rat hand keypoint labels -> detection H5s.

The four BEDDING 2024_05_07 sessions carry *_RAT{1,2}_Label3D_dannce.mat with
~27 hand-labeled frames x 23 keypoints x 6 cameras per rat. This builds the
same cam_{i}_predictions.h5 + gt_perm.npy layout as fig10_prep.py but from the
labels' data_2d (1-based px -> 0-based; NaN where unlabeled), slots shuffled
per (frame, view). Labeled frames are ~400 apart, far beyond the tracker's
stale=20 anchor window, so every labeled frame is an independent cross-view
association problem on real human-clicked 2D.

Usage: fig10_prep_labels.py --session DIR --out DIR [--seed N]
"""
import argparse, glob, json, os, re
import numpy as np
import scipy.io as sio
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fig10_prep import write_toml
from fig10_validate import load_cal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()
    S = args.session.rstrip('/')
    os.makedirs(args.out, exist_ok=True)

    rat_files = sorted(glob.glob(os.path.join(S, '*_RAT*_Label3D_dannce.mat')))
    assert rat_files, f'no per-rat Label3D files in {S}'
    A = len(rat_files)

    # per rat: {frame: (ncam, N, 2)}
    per_rat = []
    ncam = None
    N = None
    for rf in rat_files:
        d = sio.loadmat(rf)
        ld = d['labelData']
        ncam = ld.shape[0]
        by_frame = {}
        for ci in range(ncam):
            e = ld[ci, 0]
            d2 = e['data_2d'][0, 0]                    # (nLab, 2N) 1-based px
            frames = e['data_frame'][0, 0].ravel().astype(int)
            N = d2.shape[1] // 2
            for li, fr in enumerate(frames):
                arr = by_frame.setdefault(int(fr), np.full((ncam, N, 2), np.nan))
                arr[ci] = d2[li].reshape(N, 2) - 1.0   # -> 0-based
        per_rat.append(by_frame)

    frames = sorted(set().union(*[set(r.keys()) for r in per_rat]))
    F = max(frames) + 1
    rng = np.random.default_rng(args.seed)

    cal_paths = sorted(glob.glob(os.path.join(S, 'calibration', 'hires_cam*_params.mat')),
                       key=lambda p: int(re.search(r'cam(\d+)', p).group(1)))
    cals = [load_cal(p) for p in cal_paths]
    write_toml(cals, (1920, 1200), os.path.join(args.out, 'calibration.toml'))

    import h5py
    gt_perm = np.full((ncam, F, A), -1, np.int16)
    n_det = 0
    cam_data = np.full((ncam, F, A, N, 2), np.nan, np.float32)
    for f in frames:
        for ci in range(ncam):
            perm = rng.permutation(A)
            for slot, a in enumerate(perm):
                arr = per_rat[a].get(f)
                if arr is None or not np.isfinite(arr[ci]).any():
                    continue
                cam_data[ci, f, slot] = arr[ci]
                gt_perm[ci, f, slot] = a
                n_det += 1
    for ci in range(ncam):
        with h5py.File(os.path.join(args.out, f'cam_{ci+1}_predictions.h5'), 'w') as h:
            h.create_dataset('tracks', data=cam_data[ci][None],
                             chunks=(1, min(4096, F), A, N, 2),
                             compression='gzip', compression_opts=4)
    np.save(os.path.join(args.out, 'gt_perm.npy'), gt_perm)
    meta = dict(session=S, frames=F, labeled_frames=len(frames), animals=A,
                nodes=N, cams=ncam, seed=args.seed, detections=n_det,
                noise_px='human', drop_instance=0, drop_node=0, occl_dist=0,
                occl_prob=0, com_only=False, condition='C6_handlabels')
    json.dump(meta, open(os.path.join(args.out, 'meta.json'), 'w'), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == '__main__':
    main()
