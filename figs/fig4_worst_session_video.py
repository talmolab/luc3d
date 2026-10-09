#!/usr/bin/env python
"""Diagnostic video for one SLAP-2M session: every camera with pose overlays, plus 3D.

Grid: the six proofread cameras (3 x 2 tiles, 640 x 512 each) and a 3D panel
(640 x 1024) on the right. In each camera tile:
  * thin WHITE skeleton  = the proofread reference (3D reprojected into that camera),
    i.e. what Fig 4C counts as "should be there";
  * solid COLORED skeleton = the detector's matched instance (orange animal 0, cyan
    animal 1), i.e. what Fig 4C counts as detected; nodes the reference has but the
    detection lacks are the misses;
  * thin MAGENTA skeleton = raw detections that matched no reference animal.
The 3D panel shows the aligned proofread 3D poses with the cage points.

Picks the window of --seconds with the most missing keypoints unless --start is
given. Run with the bench interpreter (cv2/h5py) and the conda libGL:

    LD_LIBRARY_PATH=/root/vast/eric/luc3d-bench/video_env/lib \
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig4_worst_session_video.py \
        --session 10302022035936 --seconds 20 --out figs/figures/drafts/videos/worst_session.mp4
"""
import argparse
import io
import os
import subprocess
import sys

import cv2
import h5py
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fig4_detections as f6  # noqa: E402

FFMPEG = "/root/vast/eric/luc3d-bench/video_env/bin/ffmpeg"
TW, TH = 640, 512                      # camera tile (half resolution)
COLORS = [(255, 150, 40), (60, 220, 255), (120, 255, 120), (255, 120, 220)]   # RGB per animal
EDGES = [[3, 5], [3, 7], [3, 8], [3, 9], [3, 12], [3, 13], [3, 6], [5, 0], [5, 14], [5, 10], [5, 11], [5, 1], [5, 2], [3, 4]]


def draw_pose(img, pts, color, thick, radius, scale=0.5, hollow=False):
    p = pts * scale
    ok = np.isfinite(p[:, 0])
    for a, b in EDGES:
        if ok[a] and ok[b]:
            cv2.line(img, tuple(np.round(p[a]).astype(int)), tuple(np.round(p[b]).astype(int)), color, thick, cv2.LINE_AA)
    for i in np.where(ok)[0]:
        c = tuple(np.round(p[i]).astype(int))
        cv2.circle(img, c, radius, color, 1 if hollow else -1, cv2.LINE_AA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default="10302022035936")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--start", type=int, default=None, help="first frame (default: worst window)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    ms = pd.read_csv(f6.MASTER, sep="\t")
    ms["session"] = ms["session"].astype(str)
    row = ms[ms.session == a.session].iloc[0]
    sidx = int(ms.index[ms.session == a.session][0])
    sd = os.path.join(f6.SLAP_ROOT, os.path.dirname(row["points_3D"]))
    cams = [c for c in f6.CAMS if isinstance(row.get(f"{c}_reproj_h5"), str)]
    fps = 30.0
    ref, det, raw_all, F = {}, {}, {}, None
    for c in cams:
        rp = row[f"{c}_reproj_h5"]
        rp = rp if os.path.isabs(rp) else os.path.join(f6.SLAP_ROOT, rp)
        R = f6.load_reference(rp, 1)
        raw, _ = f6.load_raw(c, sidx, 1, R.shape[0])
        n = min(R.shape[0], raw.shape[0])
        m, which = f6.match_frame_wise(raw[:n], R[:n])
        ref[c], det[c], raw_all[c] = R[:n], m, (raw[:n], which)
        F = n if F is None else min(F, n)
    L = int(round(a.seconds * fps))
    if a.start is None:
        miss = np.zeros(F)
        for c in cams:
            gt = np.isfinite(ref[c][:F, :, :, 0]); dt = np.isfinite(det[c][:F, :, :, 0]) & gt
            miss += (gt & ~dt).sum(axis=(1, 2))
        cs = np.concatenate([[0], np.cumsum(miss)])
        wins = cs[L:] - cs[:-L]
        start = int(np.argmax(wins))
        print(f"worst {L}-frame window: {start}..{start + L - 1}, {wins[start] / L:.1f} missing keypoints per frame "
              f"(session mean {miss.mean():.1f})")
    else:
        start = a.start
    end = min(start + L, F)

    with h5py.File(os.path.join(sd, "aligned_points3d.h5")) as f:
        P3 = f["tracks"][start:end]                                 # (L, T, N, 3)
    with h5py.File(os.path.join(sd, "aligned_cage_points3d.h5")) as f:
        cage = f["tracks"][0, 0]                                    # (24, 3)

    # 3D renderer
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure(figsize=(TW / 100, 2 * TH / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1], projection="3d")
    lo, hi = np.nanmin(cage, 0) - 20, np.nanmax(cage, 0) + 20

    def render3d(k):
        ax.cla()
        ax.scatter(cage[:, 0], cage[:, 1], cage[:, 2], s=6, c="0.55", depthshade=False)
        for t in range(P3.shape[1]):
            p = P3[k, t]
            col = np.array(COLORS[t % len(COLORS)]) / 255
            for e in EDGES:
                q = p[e]
                if np.isfinite(q).all():
                    ax.plot(q[:, 0], q[:, 1], q[:, 2], color=col, lw=2)
            okp = np.isfinite(p[:, 0])
            ax.scatter(p[okp, 0], p[okp, 1], p[okp, 2], s=14, color=col, depthshade=False)
        ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(lo[2], hi[2])
        ax.set_box_aspect((hi - lo))
        ax.view_init(elev=28, azim=-55)
        ax.set_axis_off()
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        return cv2.resize(buf, (TW, 2 * TH))

    # one decoder pipe per camera, scaled to the tile
    pipes = {}
    for c in cams:
        v = row[f"{c}_video"]
        v = v if os.path.isabs(v) else os.path.join(f6.SLAP_ROOT, v)
        pipes[c] = subprocess.Popen([FFMPEG, "-v", "error", "-ss", f"{start / fps:.4f}", "-i", v, "-frames:v", str(end - start),
                                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{TW}x{TH}", "-"], stdout=subprocess.PIPE)
    W = 3 * TW + TW
    H = 2 * TH
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", a.out], stdin=subprocess.PIPE)
    nb = TW * TH * 3
    font = cv2.FONT_HERSHEY_SIMPLEX
    for k in range(end - start):
        f = start + k
        canvas = np.zeros((H, W, 3), np.uint8)
        for ci, c in enumerate(cams):
            buf = pipes[c].stdout.read(nb)
            tile = np.frombuffer(buf, np.uint8).reshape(TH, TW, 3).copy() if len(buf) == nb else np.zeros((TH, TW, 3), np.uint8)
            raw, which = raw_all[c]
            matched_idx = set(int(x) for x in which[f].ravel() if np.isfinite(x)) if which is not None else set()
            for d in range(raw.shape[1]):                     # unmatched raw detections
                if d not in matched_idx and np.isfinite(raw[f, d, :, 0]).any():
                    draw_pose(tile, raw[f, d], (255, 60, 255), 1, 2)
            for t in range(ref[c].shape[1]):
                draw_pose(tile, ref[c][f, t], (235, 235, 235), 1, 3, hollow=True)
            for t in range(det[c].shape[1]):
                draw_pose(tile, det[c][f, t], COLORS[t % len(COLORS)], 2, 3)
            ndet = [int(np.isfinite(det[c][f, t, :, 0]).sum()) for t in range(det[c].shape[1])]
            nref = [int(np.isfinite(ref[c][f, t, :, 0]).sum()) for t in range(ref[c].shape[1])]
            cv2.putText(tile, c, (10, 26), font, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
            for t in range(len(ndet)):
                cv2.putText(tile, f"animal {t}: {ndet[t]}/{nref[t]} nodes", (10, 54 + 24 * t), font, 0.6, COLORS[t % len(COLORS)], 2, cv2.LINE_AA)
            r_, c_ = divmod(ci, 3)
            canvas[r_ * TH:(r_ + 1) * TH, c_ * TW:(c_ + 1) * TW] = tile
        canvas[:, 3 * TW:] = render3d(k)
        cv2.putText(canvas, f"SLAP-2M {a.session}  frame {f}  difficulty 7  (white = proofread reference, color = detector)", (10, H - 14), font, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(canvas, "3D (proofread)", (3 * TW + 10, 26), font, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
        enc.stdin.write(canvas.tobytes())
        if k % 100 == 0:
            print(f"frame {k}/{end - start}", flush=True)
    enc.stdin.close(); enc.wait()
    for p in pipes.values():
        p.stdout.close(); p.wait()
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
