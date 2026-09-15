"""Score every calibration on IDENTICAL detections, with code neither tool wrote.

The whole benchmark rests on this file, so it does one thing only: given a set of
2D detections and a set of calibration TOMLs, it triangulates with aniposelib and
reports the per-observation reprojection error of each calibration. Nothing here
comes from calibrat3 -- the triangulation, the distortion model and the error
definition are aniposelib's, which is the point: the app's own numbers are not
evidence about the app.

Two detection sets are built the SAME way from both tools' raw corners (no
aniposelib merge_rows/extract_points, whose rtvec checks would differ between the
two), so a calibration's score changes only with the calibration.

    python3 score.py <dataset_dir> <detset>=<source> ... -- <label>=<toml> ...

Writes <dataset_dir>/scores_<detset>.npz  (per-camera error arrays, per calibration)
   and <dataset_dir>/scores.json          (summary: median/mean/p95/n, overall and per camera)
"""
import sys, os, json, pickle, base64, re

import numpy as np
from aniposelib.cameras import CameraGroup

d = sys.argv[1]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
NPTS = (B['board_x'] - 1) * (B['board_y'] - 1)
args = sys.argv[2:]
cut = args.index('--')
DETSETS = [a.split('=', 1) for a in args[:cut]]
CALIBS = [a.split('=', 1) for a in args[cut + 1:]]


def short(name):
    """Map a calibration's camera name onto the benchmark's camera name."""
    m = [r for r in NAMES if name == r or re.search(rf'(^|[-_ ]){re.escape(r)}([-_ .]|$)', name)]
    if len(m) != 1:
        raise SystemExit(f'camera name {name!r} maps to {m} of {NAMES}')
    return m[0]


def imgp_from_dets(dets):
    """dets: {(cam_index, frame): {corner_id: (x, y)}} -> (C, N, 2) with NaN for unseen,
    keeping only points at least two cameras saw (a point in one view is not a
    triangulation and would silently score as a perfect fit)."""
    frames = sorted({f for _, f in dets})
    fidx = {f: i for i, f in enumerate(frames)}
    imgp = np.full((len(NAMES), len(frames), NPTS, 2), np.nan)
    for (ci, f), pts in dets.items():
        for i, p in pts.items():
            imgp[ci, fidx[f], i] = p
    imgp = imgp.reshape(len(NAMES), -1, 2)
    seen = np.sum(~np.isnan(imgp[..., 0]), axis=0)
    return imgp[:, seen >= 2], len(frames)


def load_anipose(path):
    a = pickle.load(open(path, 'rb'))
    assert a['names'] == NAMES, (a['names'], NAMES)
    dets = {}
    for ci, rows in enumerate(a['rows']):
        for r in rows:
            ids = r['ids'].ravel().tolist()
            dets[(ci, int(r['framenum'][1]))] = dict(zip(ids, r['corners'].reshape(-1, 2)))
    return dets


def load_calibrat3(path):
    sess = json.load(open(path))
    vnames = sess['detections']['viewNames']
    order = [[short(v) for v in vnames].index(n) for n in NAMES]   # our view index per camera
    b64 = lambda s, dt: np.frombuffer(base64.b64decode(s), dtype=dt)
    dets = {}
    for fr in sess['detections']['frames']:
        for ci, vi in enumerate(order):
            v = fr['views'][vi]
            if not v:
                continue
            ids = b64(v['ids'], np.int32).tolist()
            dets[(ci, int(fr['frame']))] = dict(zip(ids, b64(v['corners'], np.float32).reshape(-1, 2)))
    return dets


def load_group(path):
    cg = CameraGroup.load(path)
    cams = {}
    for c in cg.cameras:
        s = short(c.get_name())
        c.set_name(s)
        cams[s] = c
    cg.cameras = [cams[r] for r in NAMES]
    return cg


summary = {}
for detset, src in DETSETS:
    dets = load_anipose(src) if src.endswith('.pkl') else load_calibrat3(src)
    imgp, nframes = imgp_from_dets(dets)
    print(f'\n### detections "{detset}": {imgp.shape[1]} points seen by >=2 cameras, '
          f'from {nframes} frames, {int(np.sum(~np.isnan(imgp[..., 0])))} observations', flush=True)

    # Every calibration is scored on the SAME observations: a point that fails to
    # triangulate under one calibration is dropped for ALL of them, so no arm is
    # flattered by silently scoring on an easier subset.
    norms, keep = {}, np.ones(imgp.shape[1], bool)
    for label, path in CALIBS:
        cg = load_group(path)
        err = cg.reprojection_error(cg.triangulate(imgp), imgp, mean=False)   # C x N x 2
        n = np.linalg.norm(err, axis=2)
        norms[label] = n
        # a "triangulation" that reprojects a kilometre away is a failure, not a datum
        keep &= np.isfinite(np.nanmax(np.where(np.isfinite(n), n, np.nan), axis=0)) & \
                (np.nanmax(np.where(np.isfinite(n), n, -np.inf), axis=0) < 1000)
    print(f'    common valid points: {int(keep.sum())} / {keep.size} '
          f'({keep.size - int(keep.sum())} dropped as failed triangulations)')

    out, s = {}, {}
    for label, n in norms.items():
        n = n[:, keep]
        good = np.isfinite(n)
        allv = n[good]
        s[label] = dict(overall=dict(median=float(np.median(allv)), mean=float(np.mean(allv)),
                                     p95=float(np.percentile(allv, 95)), n=int(allv.size)),
                        cameras={})
        for i, cam in enumerate(NAMES):
            e = n[i, good[i]]
            out[f'{label}|{cam}'] = e.astype(np.float32)
            s[label]['cameras'][cam] = dict(n=int(e.size), median=float(np.median(e)),
                                            mean=float(np.mean(e)), p95=float(np.percentile(e, 95)))
        print(f'    {label:28s} median {s[label]["overall"]["median"]:7.3f}  '
              f'mean {s[label]["overall"]["mean"]:7.3f}  p95 {s[label]["overall"]["p95"]:7.2f}  '
              f'n={s[label]["overall"]["n"]}', flush=True)
    np.savez_compressed(os.path.join(d, f'scores_{detset}.npz'), **out)
    s['_meta'] = dict(points=int(keep.sum()), points_before_drop=int(keep.size),
                      frames=nframes, cameras=NAMES)
    summary[detset] = s

json.dump(summary, open(os.path.join(d, 'scores.json'), 'w'), indent=1)
print(f'\nwrote {d}/scores.json and scores_*.npz')
