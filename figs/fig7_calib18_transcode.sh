#!/usr/bin/env bash
# 18-camera HEVC -> H.264 for headless Chromium (no HEVC decoder). Recorded so the next run is reproducible.
set -euo pipefail
FF=/root/vast/eric/luc3d-bench/liezl_env/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2
SRC="/root/vast/eric/calibration_test/2024-12-06_19-12-39calibration"
DST=/root/vast/eric/calib18_h264
for d in "$SRC"/Camera*; do
  c=$(basename "$d"); mkdir -p "$DST/$c/calibration_images"
  in=$(ls "$d"/calibration_images/*.mp4 | head -1)
  "$FF" -y -loglevel error -i "$in" -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p -g 20 -bf 0 -movflags +faststart "$DST/$c/calibration_images/calib.mp4" &
done
wait
