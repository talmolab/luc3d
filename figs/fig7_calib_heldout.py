"""Score every calibration on frames calibrat3 NEVER SAW.

The other half of "why is calibrat3 lower". A richer intrinsic model (fx, fy, cx, cy,
k1, k2 per camera against aniposelib's f, k1 with the principal point pinned) will
always fit its own data better -- that is what more parameters do -- so the in-sample
comparison cannot distinguish a better model from a more flexible one. The test that
can is held-out data.

calibrat3's default samples 800 of the session's frames; Anipose's detector covers
essentially every board-visible frame. So Anipose's detections contain a large set of
frames calibrat3 never used for calibration, and scoring there is:

    OUT of sample for calibrat3, IN sample for Anipose.

That is deliberately the unfair direction. If calibrat3's advantage survives it, the
advantage is not overfitting -- a model that had merely bought its fit with parameters
would lose exactly here.

    python3 heldout.py <dataset_dir> <session.json> -- <label>=<toml> ...
"""
import sys, os, json, pickle, base64, re

import numpy as np
from aniposelib.cameras import CameraGroup

d, sess_path = sys.argv[1], sys.argv[2]
CALIBS = [a.split('=', 1) for a in sys.argv[sys.argv.index('--') + 1:]]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
NPTS = (B['board_x'] - 1) * (B['board_y'] - 1)


def short(name):
    m = [r for r in NAMES if name == r or re.search(rf'(^|[-_ ]){re.escape(r)}([-_ .]|$)', name)]
    if len(m) != 1:
        raise SystemExit(f'camera name {name!r} maps to {m}')
    return m[0]


# --- the frames calibrat3 used ------------------------------------------------------
sess = json.load(open(sess_path))
b64 = lambda s, dt: np.frombuffer(base64.b64decode(s), dtype=dt)
used = set()
for fr in sess['detections']['frames']:
    # a frame only enters calibrat3's calibration if some view actually found corners
    if any(v and b64(v['ids'], np.int32).size for v in fr['views']):
        used.add(int(fr['frame']))
print(f'calibrat3 calibrated from {len(used)} frames with corners')

# --- Anipose's detections, split by whether calibrat3 saw that frame ----------------
ani = pickle.load(open(os.path.join(d, 'anipose_rows.pkl'), 'rb'))
assert ani['names'] == NAMES
dets = {}
for ci, rows in enumerate(ani['rows']):
    for r in rows:
        dets[(ci, int(r['framenum'][1]))] = dict(zip(r['ids'].ravel().tolist(),
                                                     r['corners'].reshape(-1, 2)))
frames = sorted({f for _, f in dets})
seen_flag = np.array([f in used for f in frames])
print(f'Anipose detected in {len(frames)} frames: {int(seen_flag.sum())} also used by '
      f'calibrat3, {int((~seen_flag).sum())} NOT used by calibrat3')

fidx = {f: i for i, f in enumerate(frames)}
imgp = np.full((len(NAMES), len(frames), NPTS, 2), np.nan)
for (ci, f), pts in dets.items():
    for i, p in pts.items():
        imgp[ci, fidx[f], i] = p
# per-point frame membership, before the reshape loses it
point_seen = np.repeat(seen_flag, NPTS)
imgp = imgp.reshape(len(NAMES), -1, 2)
ok = np.sum(~np.isnan(imgp[..., 0]), axis=0) >= 2
imgp, point_seen = imgp[:, ok], point_seen[ok]


def load_group(path):
    cg = CameraGroup.load(path)
    cams = {}
    for c in cg.cameras:
        s = short(c.get_name())
        c.set_name(s)
        cams[s] = c
    cg.cameras = [cams[r] for r in NAMES]
    return cg


norms, keep = {}, np.ones(imgp.shape[1], bool)
for label, path in CALIBS:
    cg = load_group(path)
    n = np.linalg.norm(cg.reprojection_error(cg.triangulate(imgp), imgp, mean=False), axis=2)
    norms[label] = n
    with np.errstate(invalid='ignore'):
        mx = np.nanmax(np.where(np.isfinite(n), n, np.nan), axis=0)
    keep &= np.isfinite(mx) & (mx < 1000)

out = {}
print(f'\n{"calibration":22s} {"frames calibrat3 USED":>24s} {"frames it NEVER SAW":>22s}')
for label, n in norms.items():
    row = {}
    for name, mask in (('used', point_seen & keep), ('heldout', ~point_seen & keep)):
        v = n[:, mask]
        v = v[np.isfinite(v)]
        row[name] = dict(median=float(np.median(v)), mean=float(np.mean(v)),
                         p95=float(np.percentile(v, 95)), n=int(v.size))
    out[label] = row
    print(f'{label:22s} {row["used"]["median"]:10.3f} px (n={row["used"]["n"]:8d}) '
          f'{row["heldout"]["median"]:10.3f} px (n={row["heldout"]["n"]:8d})')

json.dump(dict(frames_used_by_calibrat3=len(used), frames_total=len(frames),
               frames_heldout=int((~seen_flag).sum()), scores=out),
          open(os.path.join(d, 'heldout.json'), 'w'), indent=1)
print(f'\nwrote {d}/heldout.json')
