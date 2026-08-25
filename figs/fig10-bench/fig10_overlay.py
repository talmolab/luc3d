#!/usr/bin/env python3
"""Fig 10 P0 gate 1: burn reprojected sDANNCE skeletons into real video frames.

Run with an env that has cv2 (luc3d-bench liezl_env). Writes a 2x3 contact
sheet per requested frame. Colors = animal identity. Also the 10a raw material.

Usage:
  fig10_overlay.py --session <session-dir> --frames 1000,20000,45000 --out-dir DIR
"""
import argparse, glob, os, re, sys
import numpy as np
import scipy.io as sio
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fig10_validate import load_cal, project
from fig10_prep import load_pred_3d

COLORS = [(80, 200, 255), (255, 160, 60), (160, 255, 120), (255, 120, 220)]  # BGR per animal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    ap.add_argument('--frames', default='1000,20000,45000')
    ap.add_argument('--out-dir', required=True)
    args = ap.parse_args()
    S = args.session.rstrip('/')
    frames = [int(f) for f in args.frames.split(',')]
    os.makedirs(args.out_dir, exist_ok=True)

    pred = load_pred_3d(S)                # (F, A, 3, N) verified axis order
    F, A, _, N = pred.shape
    cal_paths = sorted(glob.glob(os.path.join(S, 'calibration', 'hires_cam*_params.mat')),
                       key=lambda p: int(re.search(r'cam(\d+)', p).group(1)))
    cals = [load_cal(p) for p in cal_paths]

    for fr in frames:
        tiles = []
        for ci, cal in enumerate(cals):
            vid = os.path.join(S, 'videos', f'Camera{ci+1}', '0.mp4')
            cap = cv2.VideoCapture(vid)
            cap.set(cv2.CAP_PROP_POS_FRAMES, fr)
            ok, img = cap.read()
            cap.release()
            if not ok:
                raise RuntimeError(f'frame {fr} unreadable in {vid}')
            for a in range(A):
                X = pred[fr, a].T          # (N,3)
                pts, z = project(X, cal)   # 0-based px
                for (x, y), zz in zip(pts, z):
                    if zz > 0 and np.isfinite(x) and np.isfinite(y):
                        cv2.circle(img, (int(round(x)), int(round(y))), 6,
                                   COLORS[a % len(COLORS)], -1, lineType=cv2.LINE_AA)
            cv2.putText(img, f'Camera{ci+1}  frame {fr}', (30, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
            tiles.append(cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2)))
        h, w = tiles[0].shape[:2]
        sheet = np.zeros((2 * h, 3 * w, 3), np.uint8)
        for i, t in enumerate(tiles):
            r, c = divmod(i, 3)
            sheet[r*h:(r+1)*h, c*w:(c+1)*w] = t
        out = os.path.join(args.out_dir,
                           f'{os.path.basename(S)}_f{fr}_overlay.jpg')
        cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
        print('wrote', out)


if __name__ == '__main__':
    main()
