"""Re-solve aniposelib on ITS OWN detections, restricted to calibrat3's frame indices.

The equal-frame-budget condition. Anipose's default detector covers essentially every
board-visible frame while calibrat3 samples a strided subset, so the two solvers were
fitted from different numbers of frames, with the larger budget Anipose's. This keeps
each tool's own detector and solver and equalises only the set of frame INDICES both
are allowed to fit.

    python3 anipose_same_frames.py <dataset_dir> <calibrat3 session.json> <out.toml>
"""
import sys, os, json, time, pickle, base64

import numpy as np
from aniposelib.boards import CharucoBoard
from aniposelib.cameras import CameraGroup

d, sess_path, out_toml = sys.argv[1:4]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
board = CharucoBoard(B['board_x'], B['board_y'], B['square_length'], B['marker_length'],
                     marker_bits=B.get('marker_bits', 4), dict_size=B.get('dict_size', 1000))

# --- the frames calibrat3 was allowed to fit -----------------------------------------
sess = json.load(open(sess_path))
b64 = lambda s, dt: np.frombuffer(base64.b64decode(s), dtype=dt)
c3_offered = {int(fr['frame']) for fr in sess['detections']['frames']}
c3_withcorners = {int(fr['frame']) for fr in sess['detections']['frames']
                  if any(v and b64(v['ids'], np.int32).size for v in fr['views'])}
print(f'calibrat3 was offered {len(c3_offered)} frames, {len(c3_withcorners)} had corners', flush=True)

# --- Anipose's own detections, restricted to that frame set ---------------------------
a = pickle.load(open(os.path.join(d, 'anipose_rows.pkl'), 'rb'))
assert a['names'] == NAMES, (a['names'], NAMES)
full = [len(r) for r in a['rows']]
rows = [[r for r in cam if int(r['framenum'][1]) in c3_offered] for cam in a['rows']]
kept = [len(r) for r in rows]
print(f'anipose frames/cam before: min/med/max {min(full)}/{sorted(full)[len(full)//2]}/{max(full)}', flush=True)
print(f'anipose frames/cam after : min/med/max {min(kept)}/{sorted(kept)[len(kept)//2]}/{max(kept)}', flush=True)
print(f'total detections {sum(full)} -> {sum(kept)}', flush=True)

cg = CameraGroup.from_names(NAMES)
for c in cg.cameras:
    c.set_size(tuple(spec['size']))
t = time.time()
err = cg.calibrate_rows(rows, board, init_intrinsics=True, init_extrinsics=True, verbose=True)
dt = time.time() - t
print(f'\naniposelib on its own detections, calibrat3 frame set: reported error {err}, {dt:.0f} s', flush=True)
cg.dump(out_toml)
json.dump({'calibration_s': dt, 'error': float(err) if err is not None else None,
           'frames_per_cam_full': full, 'frames_per_cam_restricted': kept,
           'c3_frames_offered': len(c3_offered), 'c3_frames_with_corners': len(c3_withcorners),
           'source_session': sess_path},
          open(out_toml.replace('.toml', '.summary.json'), 'w'), indent=1)
print('wrote', out_toml, flush=True)
