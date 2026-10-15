#!/usr/bin/env bash
# Regenerate bframes-test.mp4 + its ground-truth frame_NNN.png set, for
# tests/e2e/mediabunny-bframe-decode-order.mjs (issue #115, decode order).
#
# A 30-frame H.264 testsrc clip with REAL B-frames (-bf 3 -g 10, so decode order
# != presentation order) and the 0-based frame number drawn large in a black box
# at the centre — the region the test compares. The PNGs are each display-order
# frame, extracted with -vsync 0. ALWAYS regenerate the two together: the PNGs
# must come from this exact video (a different font renders different pixels).
#
#   bash tests/fixtures/bframes-test/make_fixture.sh
set -euo pipefail
cd "$(dirname "$0")"
FONT=""
for f in /System/Library/Fonts/Helvetica.ttc /System/Library/Fonts/Supplemental/Arial.ttf \
         /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf; do
  if [ -f "$f" ]; then FONT="$f"; break; fi
done
[ -n "$FONT" ] || { echo "no font found — edit FONT in $0" >&2; exit 1; }
rm -f frame_*.png bframes-test.mp4
ffmpeg -loglevel error -y -f lavfi -i testsrc=size=320x240:rate=10 \
  -vf "drawtext=fontfile='$FONT':text='%{n}':fontsize=64:fontcolor=white:box=1:boxcolor=black:x=(w-tw)/2:y=(h-th)/2" \
  -frames:v 30 -c:v libx264 -bf 3 -g 10 -pix_fmt yuv420p bframes-test.mp4
ffmpeg -loglevel error -y -i bframes-test.mp4 -vsync 0 frame_%03d.png
echo "frame types: $(ffprobe -v error -select_streams v -show_entries frame=pict_type -of csv=p=0 bframes-test.mp4 | tr -d '\n,')"
