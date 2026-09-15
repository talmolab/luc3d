"""Re-run aniposelib's SOLVER R times on its own saved detections.

aniposelib's `bundle_adjust_iter` is not deterministic: `_initialize_params_bundle`
picks a camera per board pose with an unseeded `np.random.choice`, and
`resample_points` breaks ties with `np.random.random`. So a single Anipose
calibration is one draw from a distribution, and a benchmark that quotes one draw
cannot tell a real gap from a lucky one. Detection is the expensive half and is
reused, so the repeats cost only the solve.

calibrat3 needs no equivalent: its pipeline is deterministic, which the benchmark
checks directly by re-running it and comparing the exported TOML byte for byte.

    python3 anipose_repeats.py <dataset_dir> [R]
"""
import sys, os, json, pickle, time

import cv2
import numpy as np
from aniposelib.boards import CharucoBoard
from aniposelib.cameras import CameraGroup

cv2.setNumThreads(4)
d = sys.argv[1]
R = int(sys.argv[2]) if len(sys.argv) > 2 else 5
spec = json.load(open(os.path.join(d, 'spec.json')))
NAMES = [c[0] for c in spec['cameras']]
B = spec['board']
data = pickle.load(open(os.path.join(d, 'anipose_rows.pkl'), 'rb'))
assert data['names'] == NAMES

out = []
for r in range(R):
    board = CharucoBoard(B['board_x'], B['board_y'], B['square_length'], B['marker_length'],
                         marker_bits=B.get('marker_bits', 4), dict_size=B.get('dict_size', 1000))
    # calibrate_rows MUTATES the rows it is given (estimate_pose_rows writes back into
    # them), so every repeat gets its own deep copy -- otherwise repeat 2 starts from
    # repeat 1's poses and the "spread" would be an artefact of the sharing.
    rows = pickle.loads(pickle.dumps(data['rows']))
    cg = CameraGroup.from_names(NAMES)
    for c in cg.cameras:
        c.set_size(tuple(spec['size']))
    t = time.time()
    err = cg.calibrate_rows(rows, board, init_intrinsics=True, init_extrinsics=True,
                            verbose=False)
    dt = time.time() - t
    p = os.path.join(d, f'calibration_anipose_rep{r}.toml')
    cg.dump(p)
    out.append(dict(repeat=r, reported_error=float(err), seconds=dt, toml=p))
    print(f'repeat {r}: aniposelib reported {err:.4f} px, {dt:.0f} s -> {os.path.basename(p)}',
          flush=True)

json.dump(out, open(os.path.join(d, 'anipose_repeats.json'), 'w'), indent=1)
print('wrote anipose_repeats.json')
