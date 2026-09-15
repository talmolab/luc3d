"""Where in the image does the error live?

The tail question. aniposelib refines ONE focal length and k1 with the principal point
PINNED at the image centre; calibrat3 refines fx, fy, cx, cy, k1, k2. Every term the
restricted model leaves out -- a principal point that is not at the centre, fy != fx, a
second radial coefficient -- contributes an error that is ZERO at the image centre and
GROWS with distance from it. If that is what drives the heavy tail, then Anipose's error
should climb with radius while calibrat3's stays flat, and the medians should agree near
the centre and diverge at the edge.

    python3 radial.py <dataset_dir> -- <label>=<toml> ...
"""
import sys, os, json, pickle, re

import numpy as np
from aniposelib.cameras import CameraGroup

d = sys.argv[1]
CALIBS = [a.split('=', 1) for a in sys.argv[sys.argv.index('--') + 1:]]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
W, H = spec['size']
B = spec['board']
NPTS = (B['board_x'] - 1) * (B['board_y'] - 1)
CX, CY = (W - 1) / 2.0, (H - 1) / 2.0     # the point aniposelib pins to


def short(n):
    m = [r for r in NAMES if n == r or re.search(rf'(^|[-_ ]){re.escape(r)}([-_ .]|$)', n)]
    return m[0]


ani = pickle.load(open(os.path.join(d, 'anipose_rows.pkl'), 'rb'))
dets = {}
for ci, rows in enumerate(ani['rows']):
    for r in rows:
        dets[(ci, int(r['framenum'][1]))] = dict(zip(r['ids'].ravel().tolist(),
                                                     r['corners'].reshape(-1, 2)))
frames = sorted({f for _, f in dets})
fidx = {f: i for i, f in enumerate(frames)}
imgp = np.full((len(NAMES), len(frames), NPTS, 2), np.nan)
for (ci, f), pts in dets.items():
    for i, p in pts.items():
        imgp[ci, fidx[f], i] = p
imgp = imgp.reshape(len(NAMES), -1, 2)
ok = np.sum(~np.isnan(imgp[..., 0]), axis=0) >= 2
imgp = imgp[:, ok]

# radius of each OBSERVATION from the image centre, as a fraction of the half-diagonal
rad = np.sqrt((imgp[..., 0] - CX) ** 2 + (imgp[..., 1] - CY) ** 2)
rad = rad / np.hypot(CX, CY)


def load_group(path):
    cg = CameraGroup.load(path)
    cams = {}
    for c in cg.cameras:
        s = short(c.get_name()); c.set_name(s); cams[s] = c
    cg.cameras = [cams[r] for r in NAMES]
    return cg


print(f'{os.path.basename(d)}: image {W}x{H}, centre ({CX:.1f}, {CY:.1f})\n')
print('principal point each calibration actually uses, distance from the image centre:')
for label, path in CALIBS:
    cg = load_group(path)
    off = [float(np.hypot(c.get_camera_matrix()[0, 2] - CX,
                          c.get_camera_matrix()[1, 2] - CY)) for c in cg.cameras]
    print(f'   {label:16s} median {np.median(off):6.1f} px, max {max(off):6.1f} px')

EDGES = np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25])
norms = {}
for label, path in CALIBS:
    cg = load_group(path)
    norms[label] = np.linalg.norm(
        cg.reprojection_error(cg.triangulate(imgp), imgp, mean=False), axis=2)

print('\nreprojection error by distance from the image centre'
      ' (r = 1 is the corner of the frame)')
hdr = ' '.join(f'{l[:13]:>15s}' for l, _ in CALIBS)
print(f'{"r bin":12s} {"n":>9s} {hdr}   <- median / p95')
for lo, hi in zip(EDGES[:-1], EDGES[1:]):
    m = (rad >= lo) & (rad < hi) & np.isfinite(norms[CALIBS[0][0]])
    if m.sum() < 500:
        continue
    cells = []
    for label, _ in CALIBS:
        v = norms[label][m & np.isfinite(norms[label])]
        cells.append(f'{np.median(v):6.2f} /{np.percentile(v, 95):6.2f}')
    print(f'{lo:.2f}-{hi:.2f}   {int(m.sum()):9d} ' + ' '.join(f'{c:>15s}' for c in cells))
