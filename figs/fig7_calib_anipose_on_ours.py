"""Run aniposelib's OWN solver on calibrat3's detections.

The third arm of the benchmark. calibrat3-vs-anipose end to end confounds two
things: who detects the board better and who solves it better. Feeding aniposelib's
`calibrate_rows` the corners calibrat3 found holds the detector fixed, so the
difference that remains is the solver's.

    python3 anipose_on_ours.py <dataset_dir> <session.json> <out.toml>
"""
import sys, os, json, base64, re, time

import cv2
import numpy as np
from aniposelib.boards import CharucoBoard
from aniposelib.cameras import CameraGroup

cv2.setNumThreads(4)
d, sess_path, out_toml = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
board = CharucoBoard(B['board_x'], B['board_y'], B['square_length'], B['marker_length'],
                     marker_bits=B.get('marker_bits', 4), dict_size=B.get('dict_size', 1000))

sess = json.load(open(sess_path))
vnames = sess['detections']['viewNames']
short = [next(r for r in NAMES if v == r or re.search(rf'(^|[-_ ]){re.escape(r)}([-_ .]|$)', v))
         for v in vnames]
order = [short.index(n) for n in NAMES]
b64 = lambda s, dt: np.frombuffer(base64.b64decode(s), dtype=dt)

OBJP = board.get_object_points().reshape(-1, 3)


def degenerate(ids):
    """True when this view's ChArUco corners lie on ONE LINE of the board.

    aniposelib initialises each camera with `cv2.initCameraMatrix2D`, which fits a
    homography per view, and a homography needs object points spanning two
    dimensions. calibrat3 keeps frames down to 6 corners, so it emits views in which
    every corner sits in a single board row -- fine for the pose solve it uses them
    for, degenerate for a homography, and OpenCV 5 asserts rather than returning a
    bad matrix. aniposelib's own detector never produces such a view, so dropping
    them here is matching its input, not filtering ours to taste. Dropped views are
    counted and reported.
    """
    p = OBJP[ids.ravel()][:, :2]
    if len(p) < 4:
        return True
    sv = np.linalg.svd(p - p.mean(0), compute_uv=False)
    return sv[1] < 1e-6 * sv[0]


rows = [[] for _ in NAMES]
dropped = 0
for fr in sess['detections']['frames']:
    for ci, vi in enumerate(order):
        v = fr['views'][vi]
        if not v:
            continue
        ids = b64(v['ids'], np.int32).astype(np.int32)
        if ids.size == 0:
            continue
        if degenerate(ids):
            dropped += 1
            continue
        corners = b64(v['corners'], np.float32).reshape(-1, 1, 2).astype(np.float64)
        ids = ids.reshape(-1, 1)
        rows[ci].append({'framenum': (0, int(fr['frame'])), 'corners': corners, 'ids': ids,
                         'filled': board.fill_points(corners, ids)})
print(f'calibrat3 detections: frames with a board per camera {[len(r) for r in rows]} '
      f'({dropped} views dropped as collinear -- see degenerate())', flush=True)

cg = CameraGroup.from_names(NAMES)
for c in cg.cameras:
    c.set_size(tuple(spec['size']))
t = time.time()
err = cg.calibrate_rows(rows, board, init_intrinsics=True, init_extrinsics=True, verbose=True)
dt = time.time() - t
print(f'\naniposelib solver on calibrat3 detections: reported error {err}, {dt:.0f} s', flush=True)
cg.dump(out_toml)
json.dump({'calibration_s': dt, 'views_dropped_collinear': dropped, 'error': float(err) if err is not None else None,
           'frames_per_cam': [len(r) for r in rows], 'source_session': sess_path},
          open(out_toml.replace('.toml', '.summary.json'), 'w'), indent=1)
print('wrote', out_toml)
