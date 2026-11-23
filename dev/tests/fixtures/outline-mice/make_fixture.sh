#!/bin/sh
# Two cameras of two bright "mice" (ellipses with a thin tail each) crossing a
# textured dark floor, for tests/e2e/animal-outlines.mjs. cam1 is cam0 mirrored.
# 90 frames, 320x240, 30 fps, a keyframe every 30 frames. Mouse A: centre
# (40 + 2.5 N, 108), tail to its left; mouse B: centre (280 - 2.5 N, 128), tail
# to its right; ellipse radii 26 x 12, so the two touch around N 40-56. A static
# bright square at (290..305, 200..215) belongs to the empty arena.
set -e
cd "$(dirname "$0")"
LUM="if(lt(pow((X-(40+2.5*N))/26\,2)+pow((Y-108)/12\,2)\,1)\,210\,if(lt(pow((X-(280-2.5*N))/26\,2)+pow((Y-128)/12\,2)\,1)\,210\,if(between(Y\,107\,109)*between(X\,(40+2.5*N)-62\,(40+2.5*N)-24)\,200\,if(between(Y\,127\,129)*between(X\,(280-2.5*N)+24\,(280-2.5*N)+62)\,200\,if(between(X\,290\,305)*between(Y\,200\,215)\,180\,30+12*sin(X/9)*cos(Y/11))))))"
ffmpeg -y -loglevel error -f lavfi -i "color=c=black:s=320x240:r=30:d=3,format=yuv420p" \
  -vf "geq=lum='$LUM':cb=128:cr=128" -frames:v 90 -c:v libx264 -preset veryslow -crf 14 -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 -pix_fmt yuv420p -movflags +faststart cam0.mp4
ffmpeg -y -loglevel error -i cam0.mp4 -vf hflip -c:v libx264 -preset veryslow -crf 14 -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 -pix_fmt yuv420p -movflags +faststart cam1.mp4
ls -l cam0.mp4 cam1.mp4
