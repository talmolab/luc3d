#!/usr/bin/env bash
# Re-run the 18-camera calibration controls with BOTH tools on OpenCV 4.13.
#
# Why: the equal-frames and reference-camera controls quoted at L406/L414 of the
# manuscript were measured with aniposelib on OpenCV 5.0.0 (figs/data/fig7/fig7s3_equal_frames.csv,
# n_obs 655,552), while the figure and L404 are on 4.13 (fig7s4_opencv_unified.csv, n_obs 645,451).
# The original bench work folder lived in /tmp and was lost, so the transcode, Anipose's 4.13
# detections and calibrat3's session are rebuilt here, on /root/vast.
#
# Reproducibility gate: the rebuilt DEFAULT arms must reproduce the figure's 4.13 values
# (Anipose 1.280 px, calibrat3 0.212 px, 645,451 observations) before the controls are used.
set -euo pipefail
FIGS=/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs
CAL3=/root/vast/eric/sleap-3d-gui/scratch/repos/calibrat3
BENCH=/root/vast/eric/calib-bench-413
CALIB18=/root/vast/eric/calib18_h264
APY=/root/vast/eric/aniposelib413_env/bin/python
export PATH=/root/vast/eric/node22_env/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/root/vast/eric/pw-browsers
D=$BENCH/calib18
mkdir -p $D

# Hard version gate: aniposelib's dependency pulls in opencv-contrib-python 5.0.0, which is
# how the original controls ended up on OpenCV 5. Refuse to run on anything but 4.13.0.
$APY -c "import cv2,sys; v=cv2.__version__; print('cv2',v); sys.exit(0 if v=='4.13.0' else 'cv2 is '+v+', not 4.13.0 -- REFUSING')"

# spec.json -- identical to figs/fig7_calib_bench.sh
$APY - "$BENCH" "$CALIB18" <<'PY'
import sys, json, glob, os, re
bench, c18 = sys.argv[1:3]
board = dict(board_x=8, board_y=11, square_length=24.0, marker_length=18.75, marker_bits=4, dict_size=1000)
cams = [[os.path.basename(d), f'{d}/calibration_images/calib.mp4']
        for d in sorted(glob.glob(f'{c18}/Camera*'), key=lambda p: int(re.search(r'(\d+)$', p).group(1)))]
json.dump(dict(cameras=cams, board=board, size=[1680, 1200]), open(f'{bench}/calib18/spec.json', 'w'), indent=1)
print('spec:', len(cams), 'cameras')
PY

# 1 -- Anipose end to end on 4.13 (detections = the scoring set every arm is scored on)
if [ ! -s $D/anipose_rows.pkl ]; then
  OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
    $APY "$FIGS/fig7_calib_anipose.py" "$D/spec.json" "$D" 2>&1 | tee "$D/anipose.log"
fi

# 2 -- calibrat3 end to end in headless Chromium (OpenCV.js 4.13.0, vendored)
if [ ! -s $D/calibrat3_800.session.json ]; then
  (cd "$CAL3" && python3 server.py 8080 > $BENCH/logs/calibrat3_server.log 2>&1 &) ; sleep 3
  (cd "$CAL3" && SESSION="$CALIB18" OUT="$D/calibrat3_800" TARGET=800 REF_CAM=Camera6 BASE=http://localhost:8080 \
    node "$FIGS/fig7_calib_calibrat3.mjs") 2>&1 | tee "$D/calibrat3_800.log"
  pkill -f "server.py 8080" || true
fi

# 3 -- the controls (same scripts as commit a522115)
[ -s $D/anipose_equal_frames.toml ] || $APY "$FIGS/fig7_calib_equal_frames.py" "$D" "$D/calibrat3_800.session.json" "$D/anipose_equal_frames.toml" 2>&1 | tee "$D/equal_frames.log"
[ -s $D/anipose_same_ref.toml ] || $APY "$FIGS/fig7_calib_reference_cam.py" "$D" Camera6 "$D/anipose_same_ref.toml" 2>&1 | tee "$D/same_ref.log"
[ -s $D/anipose_equal_same_ref.toml ] || $APY "$FIGS/fig7_calib_reference_cam.py" "$D" Camera6 "$D/anipose_equal_same_ref.toml" --sameframes "$D/calibrat3_800.session.json" 2>&1 | tee "$D/equal_same_ref.log"

# 4 -- score every calibration on the same detections, aniposelib triangulation
$APY "$FIGS/fig7_calib_score.py" "$D" \
    "anipose=$D/anipose_rows.pkl" "calibrat3=$D/calibrat3_800.session.json" -- \
    "calibrat3_default=$D/calibrat3_800.toml" \
    "anipose_default=$D/calibration_anipose.toml" \
    "anipose_equal_frames=$D/anipose_equal_frames.toml" \
    "anipose_same_ref=$D/anipose_same_ref.toml" \
    "anipose_equal_frames_same_ref=$D/anipose_equal_same_ref.toml" 2>&1 | tee "$D/score.log"
echo "DONE $(date)"
