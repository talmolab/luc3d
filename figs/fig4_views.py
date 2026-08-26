#!/usr/bin/env python3
"""
The same mutual upright display, as each of the five real cameras sees it.

WHAT THIS IS FOR, AND WHAT IT IS NOT. `fig5_ambiguity.py` tested the obvious claim --
that a single view cannot separate the two animals -- and it is FALSE on this rig: in
the worst of the five views the tail bases are still 83.5 px apart, and in 535
displays the worst view never fell below 20 px. The cameras are placed well enough
that no viewing direction runs along the line joining the animals. So this panel does
NOT claim ambiguity, and the caption must not either.

What it claims is the weaker and more defensible thing: the display is a VERTICAL
configuration, and no single image plane carries the vertical. Each camera sees a
foreshortened projection whose apparent height depends on where that camera happens
to sit; "both animals reached 1.1 body lengths above the floor and their noses closed
to 11 mm" is recoverable from the five together and from none of them alone. The
figure shows the five projections floating at their own cameras around the one 3D
reconstruction, so the reader can see the same instant five ways plus the answer.

GETTING THE POSE INTO THE CAMERAS' FRAME. The 3D lives in the P-frame
(`*points3d_translated_rotated_metric.h5`, metres) and the calibration in its own
frame, so the pose has to be aligned before it can be projected. This reuses the
pipeline Fig 2 and Fig 4 already use -- triangulate the per-camera 2D with the
calibration, then RANSAC-Procrustes the P-frame points onto that -- rather than a
second, differently-wrong alignment. As in `fig4_export.py`, the triangulation for
the ALIGNMENT step assumes the per-camera track order corresponds; RANSAC is what
makes that safe, and the fitted inlier fraction is deposited so the assumption is
checkable rather than hidden.

Deposits `figs/out/fig5_views.json`: the chosen pose in the calibration frame, each
camera's centre and axes, the projected 2D of both animals per camera, and the
alignment residual.

Needs the bench env for cv2/toml/scipy:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig4_views.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/bartul")

import cv2                                                        # noqa: E402
from build_gt_reproj import (SERIALS, load_calibration,            # noqa: E402
                             load_sleap_2d, ransac_align, undistort)
from fig2_measure import triangulate_batch                         # noqa: E402

BMIMICA = "/root/vast/eric/BMimica"
NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = 0, 3, 14
EDGES = [[3, 5], [3, 7], [3, 8], [3, 9], [3, 12], [3, 13], [3, 6], [5, 0],
         [5, 14], [5, 10], [5, 11], [5, 1], [5, 2], [3, 4]]
REAR_FRAC, NEAR_BL = 0.75, 2.0
MIN_EVENT_S, MERGE_GAP_S = 0.25, 0.15


def runs(mask, min_len, merge_gap):
    m = np.asarray(mask, bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    s, e = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    out = []
    for a, b in zip(s, e):
        if out and a - out[-1][1] <= merge_gap:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out if b - a >= max(1, min_len)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default=None,
                    help="session id; default = the one with the longest display")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "fig5_views.json"))
    args = ap.parse_args()

    sess = args.session
    if sess is None:
        # the same rule the pose panel uses: the longest display in the corpus
        up = json.load(open(os.path.join(HERE, "out", "fig5_upright.json")))
        best = max((e for e in up["examples"]), key=lambda e: e["dur_s"])
        sess, want_frame = best["session"], best["frame"]
        print(f"chosen from fig5_upright.json examples: {sess} frame {want_frame} "
              f"({best['dur_s']:.2f} s)")
    else:
        want_frame = None

    sd = os.path.join(BMIMICA, sess)
    fp = glob.glob(os.path.join(sd, "*points3d*.h5"))[0]
    with h5py.File(fp) as h:
        Xp = h["tracks"][:]                       # (F, A, N, 3) metres, P-frame
        fps = float(h["recording_frame_rate"][()])
    F, A = Xp.shape[0], Xp.shape[1]

    cams_all = load_calibration(glob.glob(f"{sd}/calibration/*_calibration.toml")[0])
    raw = {c: load_sleap_2d(glob.glob(f"{sd}/{c}/*.analysis.h5")[0])[:, :2]
           for c in SERIALS}
    C = len(SERIALS)
    Ps = np.stack([cams_all[c]["P"] for c in SERIALS], 0)

    # --- P-frame -> calibration frame, the Fig 2 / Fig 4 recipe ---------------
    Fm = min(F, min(v.shape[0] for v in raw.values()))
    samp = np.arange(0, Fm, max(1, Fm // 4000))
    und = np.stack([undistort(raw[c][samp], cams_all[c]["K"], cams_all[c]["dist"])
                    for c in SERIALS], 0)                     # (C, S, T, N, 2)
    S = len(samp)
    flat = und.reshape(C, -1, 2)
    Xc = triangulate_batch(flat, Ps, ~np.isnan(flat).any(-1)).reshape(S, A, -1, 3)
    both = (~np.isnan(Xc).any(-1)) & (~np.isnan(Xp[samp]).any(-1))
    # ransac_align returns (s, R, t), RESIDUALS, INLIER MASK -- in that order. An
    # earlier version took the second return for the inlier mask and reported a
    # 1.958 mm residual as "195.8% inliers", which also meant the guard below was
    # testing the residual against 0.5 and would have passed a hopeless alignment.
    (s_, R_, t_), err_mm, inl = ransac_align(Xp[samp][both], Xc[both], thresh=8.0)
    mm_per_unit = (1.0 / s_) * 1000.0
    inlier_frac = float(np.mean(inl))
    resid_mm = float(np.median(err_mm[inl]))
    print(f"alignment: scale {s_:.5f}  ({mm_per_unit:.3f} mm/unit)  "
          f"inliers {inlier_frac * 100:.1f}%  median residual {resid_mm:.2f} mm")
    if inlier_frac < 0.5:
        raise SystemExit("alignment inlier fraction below 50% -- the track-order "
                         "assumption does not hold on this session; pick another")

    def to_cal(X):
        """P-frame -> calibration frame."""
        sh = X.shape
        return (s_ * (R_ @ X.reshape(-1, 3).T).T + t_).reshape(sh)

    # --- pick the frame ------------------------------------------------------
    nose, tti, neck = Xp[:, :, NOSE, :], Xp[:, :, TTI, :], Xp[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    Lm = float(np.mean(L)) * 1000.0
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / np.mean(L)
    rear = np.stack([neck[:, a, 2] / L[a] > REAR_FRAC for a in range(A)], axis=1)
    ev = runs(rear[:, 0] & rear[:, 1] & np.isfinite(sep) & (sep <= NEAR_BL),
              int(round(MIN_EVENT_S * fps)), int(round(MERGE_GAP_S * fps)))
    if want_frame is not None and any(a <= want_frame < b for a, b in ev):
        k = want_frame
    else:
        s0, e0 = max(ev, key=lambda ab: ab[1] - ab[0])
        nx = np.linalg.norm(nose[:, 0, :2] - nose[:, 1, :2], axis=-1)
        k = int(s0 + np.nanargmin(nx[s0:e0]))
    print(f"frame {k}  ({k / fps:.2f} s)")

    pose_cal = to_cal(Xp[k]) * 1.0            # (A, N, 3), calibration units
    pose_cal_mm = pose_cal * mm_per_unit

    # THE PANEL RENDERS IN THE P-FRAME, NOT THE CALIBRATION FRAME. In the calibration
    # frame z is DEPTH FROM CAMERA 0 (the pose sits at z ~ 900-1050 mm and the cameras
    # near the origin), so "height above the floor" is not a coordinate there and a 3D
    # plot of it would put the vertical along a diagonal. The P-frame
    # (`*_translated_rotated_metric`) is already floor-aligned -- z IS height -- so the
    # pose is drawn there and the CAMERAS are brought into it by inverting the
    # alignment: X_p = R^T (X_cal - t) / s.
    pose_p_mm = Xp[k] * 1000.0
    floor_mm = float(np.nanpercentile(Xp[:, :, TTI, 2] * 1000.0, 1))

    def to_p(X_cal):
        return ((R_.T @ (np.atleast_2d(X_cal) - t_).T).T / s_) * 1000.0

    out = {"session": sess, "frame": k, "fps": fps, "n_animals": int(A),
           "nodes": NODES, "edges": EDGES,
           "body_length_mm": Lm, "mm_per_unit": mm_per_unit,
           "alignment_inlier_frac": inlier_frac,
           "alignment_residual_mm": resid_mm,
           "floor_mm": floor_mm,
           "pose_mm": pose_p_mm.tolist(),          # P-frame, z = height above floor
           "pose_cal_mm": pose_cal_mm.tolist(),    # calibration frame, for reference
           "cameras": []}

    for ci, c in enumerate(SERIALS):
        cam = cams_all[c]
        R, t, K, dist = cam["R"], cam["t"], cam["K"], cam["dist"]
        centre_cal = (-R.T @ t)                                 # calibration units
        centre = to_p(centre_cal)[0]                            # P-frame mm
        # rows of R are the camera's right / down / forward axes in world coords
        proj, _ = cv2.projectPoints(pose_cal.reshape(-1, 3).astype(np.float64),
                                    cam["rvec"], t, K, dist)
        proj = proj.reshape(A, -1, 2)
        out["cameras"].append({
            "name": c, "index": ci,
            "centre_mm": centre.tolist(),               # P-frame, mm
            "centre_cal_mm": (centre_cal * mm_per_unit).tolist(),
            # camera axes rotated into the P-frame, so the panel can orient an image
            # plane correctly in the frame it is drawing
            "right": (R_.T @ R[0]).tolist(),
            "down": (R_.T @ R[1]).tolist(),
            "forward": (R_.T @ R[2]).tolist(),
            "size": [1280, 1024],
            "proj_px": proj.tolist(),
            # how far this camera is from the line joining the two animals: the
            # quantity that WOULD have produced ambiguity had it been small
            "tti_gap_px": float(np.hypot(*(proj[0, TTI] - proj[1, TTI]))),
            "nose_gap_px": float(np.hypot(*(proj[0, NOSE] - proj[1, NOSE]))),
        })
    gaps = [c["tti_gap_px"] for c in out["cameras"]]
    out["tti_gap_px_worst"] = float(min(gaps))
    out["tti_gap_px_best"] = float(max(gaps))
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"floor at z = {floor_mm:.1f} mm (P-frame); pose z "
          f"{pose_p_mm[:, :, 2].min():.0f}-{pose_p_mm[:, :, 2].max():.0f} mm")
    print("per-camera tail-base gap (px): " +
          "  ".join(f"{c['name']}:{c['tti_gap_px']:.0f}" for c in out["cameras"]))
    print(f"worst {out['tti_gap_px_worst']:.0f} px, best {out['tti_gap_px_best']:.0f} px"
          f"  -- 3D separation {sep[k]:.2f} body lengths")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
