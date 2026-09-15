"""Compare recovered calibrations against KNOWN ground truth.

The test the real-data benchmark cannot do. On real rigs the only available metric is
reprojection error -- which is the solver's own objective, and which a richer intrinsic
model can lower by absorbing board non-planarity and detector bias rather than by
describing the lens better. On a synthetic session the board is exactly planar, the
renderer applies the exact distortion model both tools assume, and the true intrinsics
and camera poses are known, so "did it recover the camera" can be asked directly.

The synthetic ground truth is built to contain precisely what aniposelib's model cannot
express (scripts/make_synthetic_session.py): a principal point offset up to 20 px from
the image centre, fy != fx by up to a few percent, and k2 = 0.05. If calibrat3's extra
parameters are modelling the lens, they recover those; if they are soaking up nuisance
error, they will not -- and there is no board error here to soak up.

3D geometry is compared up to a similarity transform, because a calibration is only
determined up to global rotation, translation and scale: camera centres are aligned to
ground truth by Umeyama and what is reported is the residual, plus the SCALE FACTOR
itself (a calibration can reproject perfectly and still be the wrong size, which is the
error reprojection cannot see).

    python3 gt_compare.py <gt.toml> -- <label>=<toml> ...
"""
import sys, re

import numpy as np

sys.path.insert(0, '/root/vast/eric/sleap-3d-gui/scratch/repos/calibrat3')


def parse_toml(path):
    """Minimal sleap-anipose calibration reader (no toml dependency)."""
    cams, cur = {}, None
    for line in open(path):
        line = line.strip()
        m = re.match(r'^\[(cam_\w+|.+)\]$', line)
        if m:
            cur = {}
            cams[m.group(1)] = cur
            continue
        if cur is None or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k, v = k.strip(), v.strip()
        if k == 'name':
            cur['name'] = v.strip('"')
        elif k in ('matrix', 'distortions', 'rotation', 'translation', 'size'):
            cur[k] = [float(x) for x in re.findall(r'-?\d+\.?\d*(?:[eE][-+]?\d+)?', v)]
    out = {}
    for c in cams.values():
        if 'name' not in c or 'matrix' not in c:
            continue
        K = np.array(c['matrix'], float).reshape(3, 3)
        out[c['name']] = dict(K=K, dist=np.array(c.get('distortions', [0] * 5), float),
                              rvec=np.array(c['rotation'], float),
                              tvec=np.array(c['translation'], float),
                              size=c.get('size'))
    return out


def rodrigues(r):
    import cv2
    R, _ = cv2.Rodrigues(np.asarray(r, float).reshape(3, 1))
    return R


def centres(cal, names):
    return np.array([-rodrigues(cal[n]['rvec']).T @ cal[n]['tvec'] for n in names])


def umeyama(X, Y):
    """Similarity transform taking X onto Y; returns (scale, rotation, translation)."""
    mx, my = X.mean(0), Y.mean(0)
    Xc, Yc = X - mx, Y - my
    U, S, Vt = np.linalg.svd(Xc.T @ Yc / len(X))
    d = np.sign(np.linalg.det(U @ Vt))
    D = np.diag([1, 1, d])
    R = (U @ D @ Vt).T
    s = float(np.trace(np.diag(S) @ D) / (Xc ** 2).sum() * len(X))
    return s, R, my - s * R @ mx


gt_path = sys.argv[1]
CALIBS = [a.split('=', 1) for a in sys.argv[sys.argv.index('--') + 1:]]
gt = parse_toml(gt_path)
names = list(gt)
W, H = gt[names[0]]['size'] or (0, 0)
print(f'ground truth: {len(names)} cameras, {W}x{H}\n')
print('TRUE principal-point offsets from the image centre (what aniposelib pins to 0):')
off = [np.hypot(gt[n]['K'][0, 2] - (W - 1) / 2, gt[n]['K'][1, 2] - (H - 1) / 2) for n in names]
print(f'   median {np.median(off):.1f} px, max {max(off):.1f} px')
fy_fx = [gt[n]['K'][1, 1] / gt[n]['K'][0, 0] - 1 for n in names]
print(f'TRUE fy/fx - 1: median {np.median(fy_fx) * 100:+.2f} %, max {max(fy_fx) * 100:+.2f} %')
print(f'TRUE k2: {gt[names[0]]["dist"][1]:+.4f}\n')

hdr = (f'{"calibration":18s} {"|Δcx,cy|":>10s} {"Δfx %":>8s} {"Δfy %":>8s} '
       f'{"Δk1":>8s} {"Δk2":>8s} {"cam centre":>11s} {"scale err":>10s} {"centre %":>9s}')
print(hdr)
print('-' * len(hdr))
for label, path in CALIBS:
    cal = parse_toml(path)
    miss = [n for n in names if n not in cal]
    if miss:
        print(f'{label:18s} MISSING {miss}')
        continue
    dpp, dfx, dfy, dk1, dk2 = [], [], [], [], []
    for n in names:
        Kg, Kc = gt[n]['K'], cal[n]['K']
        dpp.append(np.hypot(Kc[0, 2] - Kg[0, 2], Kc[1, 2] - Kg[1, 2]))
        dfx.append(abs(Kc[0, 0] / Kg[0, 0] - 1) * 100)
        dfy.append(abs(Kc[1, 1] / Kg[1, 1] - 1) * 100)
        dk1.append(abs(cal[n]['dist'][0] - gt[n]['dist'][0]))
        dk2.append(abs(cal[n]['dist'][1] - gt[n]['dist'][1]))
    s, R, t = umeyama(centres(cal, names), centres(gt, names))
    resid = np.linalg.norm((s * (R @ centres(cal, names).T).T + t) - centres(gt, names), axis=1)
    # ALSO AS A FRACTION OF THE RIG, so the camera-centre error can share a single
    # dimensionless axis with the focal-length and scale errors instead of forcing one
    # plot to carry millimetres and per-cent at once. The denominator is the median
    # distance between camera pairs in the TRUE rig.
    C = centres(gt, names)
    pairs = [np.linalg.norm(C[i] - C[j]) for i in range(len(C)) for j in range(i + 1, len(C))]
    centre_pct = np.median(resid) / np.median(pairs) * 100
    print(f'{label:18s} {np.median(dpp):9.2f}p {np.median(dfx):7.2f}% {np.median(dfy):7.2f}% '
          f'{np.median(dk1):8.4f} {np.median(dk2):8.4f} {np.median(resid):9.2f}mm '
          f'{(s - 1) * 100:+9.3f}% {centre_pct:8.4f}%')
print('\n(medians over cameras; camera centre = residual after a similarity fit to '
      'ground truth;\n scale err = how much the calibration would have to be resized to '
      'match the true rig)')
