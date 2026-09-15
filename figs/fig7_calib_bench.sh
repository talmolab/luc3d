#!/usr/bin/env bash
# Fig 7's whole measurement pass, in the order it has to run.
#
# This is the expensive half of the figure: it decodes ~80 camera-hours of ChArUco
# video twice (once with OpenCV in Python, once with WebCodecs in a browser), solves
# five calibrations, and scores every one of them on two detection sets. Budget ~1 h
# on a 64-core box. The cheap half -- `panels/fig7_*.py` + `assemble.py 7` -- reads
# only `out/fig7_calibration.json` and runs in seconds.
#
# WHAT EACH STEP CONTRIBUTES, and why none of them can be skipped:
#
#   1  fig7_calib_anipose.py        Anipose end to end: its detector, its solver.
#                                   Also deposits its RAW DETECTIONS, which are the
#                                   scoring set every panel reads (`MAIN_DETSET`).
#   2  fig7_calib_calibrat3.mjs     calibrat3 end to end in a real headless browser,
#                                   twice per session: at its default sampling and on
#                                   every frame (panel f). Deposits the exported TOML
#                                   AND the saved session, so its corners can be
#                                   scored by someone else's code.
#   3  fig7_calib_anipose_on_ours.py  aniposelib's solver on calibrat3's corners --
#                                   the arm that separates "detects better" from
#                                   "solves better".
#   4  fig7_calib_score.py          The only step that produces a number on the
#                                   artwork: aniposelib triangulates and reprojects
#                                   EVERY calibration on EACH detection set, with the
#                                   same observations for every arm.
#   5  fig7_calib_deposit.py        Compacts 10^7 errors into out/fig7_calibration.json.
#
# THE TWO SESSIONS. cal_test2 is 8 cameras x 2701 frames at 1280x1024; the 18-camera
# rig is 18 x 1800 at 1680x1200, H.264-transcoded from HEVC because headless Chromium
# has no HEVC decoder -- BOTH tools read that same transcode, so it is not a
# difference between the arms. Camera6 is the 18-camera rig's reference ("bridge")
# camera: it is the one with covisibility to both halves of the ring.
#
#   BENCH=/path/to/workdir SESSIONS=... bash figs/fig7_calib_bench.sh
set -euo pipefail

FIGS="$(cd "$(dirname "$0")" && pwd)"
BENCH="${BENCH:?set BENCH to a scratch directory}"
CALIBRAT3="${CALIBRAT3:?set CALIBRAT3 to the calibrat3 repo}"
CAL_TEST2="${CAL_TEST2:?set CAL_TEST2 to the 8-camera session folder}"
CALIB18="${CALIB18:?set CALIB18 to the 18-camera H.264 transcode folder}"
BASE="${BASE:-http://localhost:8080}"

# spec.json per session: the camera names, the videos, the board, the image size.
python3 - "$BENCH" "$CAL_TEST2" "$CALIB18" <<'PY'
import sys, json, glob, os, re
bench, cal2, c18 = sys.argv[1:4]
board = dict(board_x=8, board_y=11, square_length=24.0, marker_length=18.75,
             marker_bits=4, dict_size=1000)
os.makedirs(f'{bench}/cal_test2', exist_ok=True); os.makedirs(f'{bench}/calib18', exist_ok=True)
cams = [[os.path.basename(v).split('-')[1], v] for v in sorted(glob.glob(f'{cal2}/*.mp4'))]
json.dump(dict(cameras=cams, board=board, size=[1280, 1024]), open(f'{bench}/cal_test2/spec.json', 'w'), indent=1)
cams = [[os.path.basename(d), f'{d}/calibration_images/calib.mp4']
        for d in sorted(glob.glob(f'{c18}/Camera*'), key=lambda p: int(re.search(r'(\d+)$', p).group(1)))]
json.dump(dict(cameras=cams, board=board, size=[1680, 1200]), open(f'{bench}/calib18/spec.json', 'w'), indent=1)
PY

# 1 -- Anipose end to end. OMP/BLAS pinned to one thread: the pool already uses one
# process per camera, and cv2's own thread-per-core inside each of them oversubscribes
# the box by 4x and makes the wall clock a statement about contention.
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
for s in cal_test2 calib18; do
    python3 "$FIGS/fig7_calib_anipose.py" "$BENCH/$s/spec.json" "$BENCH/$s" 2>&1 | tee "$BENCH/$s/anipose.log"
done
unset OMP_NUM_THREADS OPENBLAS_NUM_THREADS MKL_NUM_THREADS

# 2 -- calibrat3 end to end, in a browser. Needs `python3 server.py 8080` in the
# calibrat3 repo and playwright resolvable from $BENCH (a node_modules symlink).
cd "$CALIBRAT3"
SESSION="$CAL_TEST2" OUT="$BENCH/cal_test2/calibrat3_800" TARGET=800 BASE="$BASE" \
    node "$FIGS/fig7_calib_calibrat3.mjs" 2>&1 | tee "$BENCH/cal_test2/calibrat3_800.log"
SESSION="$CAL_TEST2" OUT="$BENCH/cal_test2/calibrat3_all" ALL_FRAMES=1 BASE="$BASE" \
    node "$FIGS/fig7_calib_calibrat3.mjs" 2>&1 | tee "$BENCH/cal_test2/calibrat3_all.log"
SESSION="$CALIB18" OUT="$BENCH/calib18/calibrat3_800" TARGET=800 REF_CAM=Camera6 BASE="$BASE" \
    node "$FIGS/fig7_calib_calibrat3.mjs" 2>&1 | tee "$BENCH/calib18/calibrat3_800.log"
SESSION="$CALIB18" OUT="$BENCH/calib18/calibrat3_all" ALL_FRAMES=1 REF_CAM=Camera6 BASE="$BASE" \
    node "$FIGS/fig7_calib_calibrat3.mjs" 2>&1 | tee "$BENCH/calib18/calibrat3_all.log"

# 3 -- aniposelib's solver on calibrat3's corners, from the DEFAULT-sampling run (the
# arm every other panel scores), so the three arms differ in one thing at a time.
for s in cal_test2 calib18; do
    python3 "$FIGS/fig7_calib_anipose_on_ours.py" "$BENCH/$s" \
        "$BENCH/$s/calibrat3_800.session.json" "$BENCH/$s/calibration_anipose_on_ours.toml" \
        2>&1 | tee "$BENCH/$s/anipose_on_ours.log"
done

# 4 -- score every calibration on both detection sets, with aniposelib's triangulation.
for s in cal_test2 calib18; do
    python3 "$FIGS/fig7_calib_score.py" "$BENCH/$s" \
        "anipose=$BENCH/$s/anipose_rows.pkl" \
        "calibrat3=$BENCH/$s/calibrat3_800.session.json" \
        -- \
        "calibrat3_800=$BENCH/$s/calibrat3_800.toml" \
        "calibrat3_all=$BENCH/$s/calibrat3_all.toml" \
        "anipose=$BENCH/$s/calibration_anipose.toml" \
        "anipose_on_ours=$BENCH/$s/calibration_anipose_on_ours.toml" \
        2>&1 | tee "$BENCH/$s/score.log"
done

# 5 -- deposit.
mkdir -p "$FIGS/out"
python3 "$FIGS/fig7_calib_deposit.py" "$FIGS/out/fig7_calibration.json" \
    "$BENCH/cal_test2" "$BENCH/calib18"

echo "measurement complete -- now: python3 $FIGS/panels/fig7_00_error_cdf.py (etc) && python3 $FIGS/assemble.py 7"
