#!/usr/bin/env bash
# Regenerate barcode-60.mp4 for tests/e2e/html5-step-mid-frame.mjs.
#
# 60 frames of 60 fps H.264 with real B-frames (-bf 3 -g 30), 256x32, each
# frame's 0-based number burned in as a barcode: bit i is the 16 px column
# block [16i, 16i+16), white (235) for 1, black (16) for 0. 60 fps matters: its
# frame times are not whole microseconds, so a <video> seek to a frame's START
# lands on the frame before for some frames (the bug the test's negative
# control must still see); a 10 fps clip lands exactly either way.
#
#   bash tests/fixtures/barcode-60/make_fixture.sh
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -loglevel error -y -f lavfi -i color=c=black:s=256x32:r=60:d=1 \
  -vf "geq=lum='if(mod(floor(N/pow(2,floor(X/16))),2),235,16)':cb=128:cr=128" \
  -c:v libx264 -crf 10 -bf 3 -g 30 -pix_fmt yuv420p barcode-60.mp4
echo "frames: $(ffprobe -v error -select_streams v -count_frames -show_entries stream=nb_read_frames -of csv=p=0 barcode-60.mp4)," \
  "types: $(ffprobe -v error -select_streams v -show_entries frame=pict_type -of csv=p=0 barcode-60.mp4 | tr -d '\n,')"
