#!/usr/bin/env bash
# Regenerate the HEVC fixtures for tests/test-hev1-retag.mjs and
# tests/e2e/hev1-retag.mjs (loading/hev1-retag.js).
#
# 2 s of 15 fps HEVC (libx265), 128x72, tagged `hev1` as ffmpeg tags HEVC by
# default, plus each one's lossless `-c copy -tag:v hvc1` twin — the re-tag
# LUCID does in memory must equal it in the sample entries (for these files
# the twin differs from its source in the 4 fourcc bytes only):
#   hev1.mp4       moov AFTER mdat (ffmpeg's default; camera recordings too)
#   hvc1.mp4       its hvc1 twin
#   hev1-frag.mp4  fragmented (empty moov first, then moof/mdat pairs)
#   hvc1-frag.mp4  its hvc1 twin
#
#   bash tests/fixtures/hev1-retag/make_fixture.sh
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=s=128x72:r=15:d=2 \
  -c:v libx265 -x265-params log-level=error:keyint=15 -crf 34 -pix_fmt yuv420p -tag:v hev1 hev1.mp4
ffmpeg -loglevel error -y -i hev1.mp4 -c copy -tag:v hvc1 hvc1.mp4
FRAG="+frag_keyframe+empty_moov+default_base_moof"
ffmpeg -loglevel error -y -i hev1.mp4 -c copy -tag:v hev1 -movflags "$FRAG" hev1-frag.mp4
ffmpeg -loglevel error -y -i hev1-frag.mp4 -c copy -tag:v hvc1 -movflags "$FRAG" hvc1-frag.mp4
for f in hev1.mp4 hvc1.mp4 hev1-frag.mp4 hvc1-frag.mp4; do
  echo "$f: $(stat -c %s "$f" 2>/dev/null || stat -f %z "$f") bytes," \
    "tag $(ffprobe -v error -select_streams v -show_entries stream=codec_tag_string -of csv=p=0 "$f")," \
    "frames $(ffprobe -v error -select_streams v -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$f")"
done
