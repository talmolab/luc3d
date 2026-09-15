"""Run aniposelib end-to-end on one session; save its detections, its TOML and its timings.

Detection is parallelised one process per camera (aniposelib's own get_rows_videos is
serial), which is the only change from stock aniposelib -- the detector, the board and
the solver are untouched, and the wall-clock figures report BOTH the parallel time and
the summed per-camera CPU time so the comparison against calibrat3's worker pool is
stated honestly.

    python3 anipose_run.py <session.json spec> <outdir>

The spec is {"cameras": [[name, video_path], ...], "board": {...}, "size": [w, h]}.
"""
import sys, os, json, time, pickle
from multiprocessing import Pool

import cv2
import numpy as np
from aniposelib.boards import CharucoBoard
from aniposelib.cameras import CameraGroup

spec_path, out = sys.argv[1], sys.argv[2]
spec = json.load(open(spec_path))
os.makedirs(out, exist_ok=True)
names = [c[0] for c in spec['cameras']]
vids = [c[1] for c in spec['cameras']]
B = spec['board']


def make_board():
    return CharucoBoard(B['board_x'], B['board_y'], B['square_length'], B['marker_length'],
                        marker_bits=B.get('marker_bits', 4), dict_size=B.get('dict_size', 1000))


#: OpenCV threads PER CAMERA PROCESS. cv2 defaults to a thread per core inside EACH of
#: the N processes, so on a 64-core box the pool ran ~250 runnable threads against 64
#: cores -- slower than the serial original it replaced, and the wall clock it reported
#: would have been a statement about the oversubscription rather than about the method.
#: The timing pass sets this to cores/cameras so the pool fills the machine exactly
#: once, which is Anipose's best case on this hardware; the accuracy passes leave it at
#: 1, where it costs nothing that a calibration depends on.
THREADS = int(os.environ.get('OPENCV_THREADS', '1'))


def detect_one(arg):
    cv2.setNumThreads(THREADS)
    i, vid = arg
    t0 = time.time()
    rows = make_board().detect_video(vid, prefix=0, progress=False)
    return i, rows, time.time() - t0


if __name__ == '__main__':
    print(f'cameras {names}', flush=True)
    board = make_board()
    t0 = time.time()
    with Pool(min(len(vids), 20)) as p:
        got = p.map(detect_one, list(enumerate(vids)))
    t_det_wall = time.time() - t0
    got.sort()
    rows = [g[1] for g in got]
    t_det_cpu = sum(g[2] for g in got)
    print(f'detection: {t_det_wall:.0f} s wall / {t_det_cpu:.0f} s summed CPU; '
          f'frames with board per camera: {[len(r) for r in rows]}', flush=True)
    with open(os.path.join(out, 'anipose_rows.pkl'), 'wb') as fh:
        pickle.dump({'names': names, 'rows': rows}, fh)

    cgroup = CameraGroup.from_names(names)
    for c in cgroup.cameras:
        c.set_size(tuple(spec['size']))
    t1 = time.time()
    err = cgroup.calibrate_rows(rows, board, init_intrinsics=True, init_extrinsics=True, verbose=True)
    t_cal = time.time() - t1
    print(f'anipose calibrate_rows error: {err}; time {t_cal:.0f} s', flush=True)
    cgroup.dump(os.path.join(out, 'calibration_anipose.toml'))
    json.dump({'names': names, 'opencv_threads': THREADS,
               'detection_s_wall': t_det_wall, 'detection_s_cpu': t_det_cpu,
               'calibration_s': t_cal, 'error': float(err) if err is not None else None,
               'frames_per_cam': [len(r) for r in rows]},
              open(os.path.join(out, 'anipose_summary.json'), 'w'), indent=1)
    print('done', flush=True)
