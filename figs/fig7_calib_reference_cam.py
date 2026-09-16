"""Give aniposelib the same reference camera calibrat3 was given.

aniposelib.utils.get_initial_extrinsics hardcodes find_calibration_pairs(graph, source=0),
so the root of its extrinsic chain is always the camera at index 0. The benchmark gave
calibrat3 Camera 6 as its reference on the 18-camera rig, the only camera covisible with
both halves of the ring. This permutes the camera order so the chosen camera is index 0,
solves, and writes a TOML whose camera NAMES are unchanged, so it scores identically.

    python3 anipose_ref.py <dataset_dir> <ref camera name> <out.toml> [--sameframes <session.json>]
"""
import sys, os, json, time, pickle, base64
import numpy as np
from aniposelib.boards import CharucoBoard
from aniposelib.cameras import CameraGroup

d, refname, out_toml = sys.argv[1:4]
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
board = CharucoBoard(B['board_x'], B['board_y'], B['square_length'], B['marker_length'],
                     marker_bits=B.get('marker_bits', 4), dict_size=B.get('dict_size', 1000))
a = pickle.load(open(os.path.join(d, 'anipose_rows.pkl'), 'rb'))
assert a['names'] == NAMES
rows = a['rows']

if '--sameframes' in sys.argv:
    sess = json.load(open(sys.argv[sys.argv.index('--sameframes') + 1]))
    keep = {int(fr['frame']) for fr in sess['detections']['frames']}
    rows = [[r for r in cam if int(r['framenum'][1]) in keep] for cam in rows]
    print(f'restricted to {len(keep)} frame indices', flush=True)

ri = NAMES.index(refname)
order = [ri] + [i for i in range(len(NAMES)) if i != ri]
pnames = [NAMES[i] for i in order]
prows = [rows[i] for i in order]
print(f'reference camera {refname} moved to index 0; order {pnames}', flush=True)

cg = CameraGroup.from_names(pnames)
for c in cg.cameras:
    c.set_size(tuple(spec['size']))
t = time.time()
err = cg.calibrate_rows(prows, board, init_intrinsics=True, init_extrinsics=True, verbose=False)
dt = time.time() - t
print(f'\nreported error {err}, {dt:.0f} s', flush=True)
cg.dump(out_toml)
json.dump({'reference': refname, 'order': pnames, 'error': float(err), 'calibration_s': dt,
           'frames_per_cam': [len(r) for r in prows]},
          open(out_toml.replace('.toml', '.summary.json'), 'w'), indent=1)
print('wrote', out_toml, flush=True)
