#!/usr/bin/env bash
# Regenerate fragmented-60.mp4 for tests/e2e/fragmented-mp4-load.mjs.
#
# 1,200 frames (20 s) of 60 fps H.264, 176x16, written as a FRAGMENTED MP4 with
# campy's muxer flags (its default fragmentedVideo: empty moov, one fragment per
# keyframe, -g 30 = campy's keyframeInterval 0.5 s). Each frame's 0-based number
# is burned in as an 11-bit barcode: bit i is the 16 px column block
# [16i, 16i+16), white (235) for 1, black (16) for 0.
#
#   bash tests/fixtures/fragmented-60/make_fixture.sh
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -loglevel error -y -f lavfi -i color=c=black:s=176x16:r=60:d=20 \
  -vf "geq=lum='if(mod(floor(N/pow(2,floor(X/16))),2),235,16)':cb=128:cr=128" \
  -c:v libx264 -crf 10 -bf 3 -g 30 -pix_fmt yuv420p \
  -movflags +frag_keyframe+empty_moov+delay_moov+default_base_moof -frag_duration 1000000 \
  fragmented-60.mp4
echo "frames: $(ffprobe -v error -select_streams v -count_frames -show_entries stream=nb_read_frames -of csv=p=0 fragmented-60.mp4)," \
  "fps: $(ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 fragmented-60.mp4)"
