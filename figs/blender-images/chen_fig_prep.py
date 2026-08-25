#!/usr/bin/env python
"""Data prep for the Chen et al. (2020) Fig. 2 -style correspondence figure:
computes every real quantity the render + compositor need and writes them to
renders/chen_fig_data.json, plus an undistorted+cropped real photo from the
"side" camera at frame t.

    bpyenv/bin/python chen_fig_prep.py

See chen_common.py's docstring for the session/camera/frame choices.
"""
import os

import cv2
import numpy as np

import chen_common as cc

HERE = cc.HERE


def main():
    cam = cc.load_calibration()
    ali = cc.load_alignment()
    X = cc.load_tracks3d()          # (frames, 2, 15, 3) mm, calib-world
    S = cc.load_side_reprojections()  # (frames, 2, 15, 2) px

    tp, t = cc.TPRIME, cc.TCUR
    m, o = cc.TRACK_MAIN, cc.TRACK_OTHER

    # --- 3D, aligned frame (floor z~=0, +z up) -----------------------------
    X_tp_al = ali.point(X[tp, m])            # (15,3) illustrated animal @ t'
    X_prev_al = ali.point(X[tp - cc.NWIN, m])
    V_al = (X_tp_al - X_prev_al) / cc.NWIN    # mm / frame, per node
    X_hat_al = X_tp_al + V_al * (t - tp)      # predicted pose @ t
    X_true_al = ali.point(X[t, m])            # ground-truth pose @ t (for the ray)
    X_other_al = ali.point(X[tp, o])          # context animal, held @ t'

    # sanity: aligned transform matches the precomputed aligned_points3d.h5
    import h5py
    with h5py.File(f"{cc.SESSION}/aligned_points3d.h5") as f:
        ref = f["tracks"][tp, m]
    assert np.abs(X_tp_al - ref).max() < 1e-6, "alignment mismatch"

    # --- camera, aligned frame ---------------------------------------------
    C_al = ali.point(cam.C)
    right_raw, down_raw, fwd_raw = cam.R_c2w[:, 0], cam.R_c2w[:, 1], cam.R_c2w[:, 2]
    right_al = ali.direction(right_raw)
    down_al = ali.direction(down_raw)
    fwd_al = ali.direction(fwd_raw)

    # --- 2D, calibration-world (raw) frame ----------------------------------
    reproj_anchor_px = cam.project(X[tp, m, cc.MEASURE_IDX])   # = S[tp, m, MEASURE_IDX], verified below
    current_detection_px = S[t, m, cc.MEASURE_IDX]
    assert np.abs(reproj_anchor_px - S[tp, m, cc.MEASURE_IDX]).max() < 1e-3
    d2d_px = float(np.linalg.norm(reproj_anchor_px - current_detection_px))

    # --- 3D affinity: perpendicular distance from the predicted point to the
    # real back-projected ray through the CURRENT detection ------------------
    ray_dir_raw = cam.ray_dir_world(current_detection_px)
    ray_dir_al = ali.direction(ray_dir_raw)
    ray_dir_al /= np.linalg.norm(ray_dir_al)
    w = X_hat_al[cc.MEASURE_IDX] - C_al
    ray_param = float(np.dot(w, ray_dir_al))
    closest_al = C_al + ray_param * ray_dir_al
    d3d_mm = float(np.linalg.norm(X_hat_al[cc.MEASURE_IDX] - closest_al))
    # the true measured 3D point (X_t(mu)) must sit exactly on this ray
    true_ray_param = float(np.dot(X_true_al[cc.MEASURE_IDX] - C_al, ray_dir_al))
    on_ray_residual_mm = float(np.linalg.norm(
        X_true_al[cc.MEASURE_IDX] - (C_al + true_ray_param * ray_dir_al)))
    assert on_ray_residual_mm < 1e-6

    print(f"2D affinity (reproj anchor vs current detection): {d2d_px:.1f} px")
    print(f"3D affinity (Xhat_t vs back-projected ray):        {d3d_mm:.1f} mm")
    print(f"prediction error vs ground truth:                  "
          f"{np.linalg.norm(X_hat_al[cc.MEASURE_IDX]-X_true_al[cc.MEASURE_IDX]):.1f} mm")
    print(f"true displacement t'->t:                           "
          f"{np.linalg.norm(X_true_al[cc.MEASURE_IDX]-X_tp_al[cc.MEASURE_IDX]):.1f} mm")

    # --- full 2D poses (all 15 nodes) for the image-plane overlay -----------
    # "reprojected anchor" pose: where the retained t' anchor SAYS the main
    # animal's whole pose should be, reprojected into this view (= what a
    # tracker compares against the fresh detection). "current" poses: the
    # real fresh per-camera detections at t, both animals, for context.
    anchor_pose_px = cam.project(X[tp, m])          # (15,2)
    current_pose_main_px = S[t, m]                   # (15,2)
    current_pose_other_px = S[t, o]                  # (15,2)
    assert np.abs(anchor_pose_px - S[tp, m]).max() < 1e-3

    # --- the real photo: extract frame t from the side camera, undistort ---
    # cv2's CAP_PROP_POS_MSEC seek on this h265 stream lands off by many frames
    # (verified: the reared mouse's tracked keypoints fell outside the frame it
    # grabbed). ffmpeg's own `-ss` (before -i) + single-frame decode reproduces
    # the frame that visual inspection confirmed matches the real 2D track --
    # use that instead.
    import subprocess
    w_px, h_px = cam.size
    mp4 = (f"{cc.SESSION}/side/"
           "side-10072022180155-0000_h265_CRF12_denoised.mp4")
    raw_png = os.path.join(HERE, "renders", "_chen_side_raw.png")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t / 30.0:.6f}",
         "-i", mp4, "-vframes", "1", raw_png],
        check=True)
    frame = cv2.imread(raw_png)
    assert frame is not None, "failed to read side camera frame"
    fps = 30.0
    dist = np.array([cam.dist[0], cam.dist[1], cam.dist[2], cam.dist[3], cam.dist[4]])
    frame_u = cv2.undistort(frame, cam.K, dist)

    # crop to a generous box around both animals at t (real detections, this cam).
    # Margin is wide because the tracked NODES (nose/ears/trunk/...) undershoot
    # the visible animal extent when rearing -- a mouse's forepaws reach above
    # its own Head/Nose keypoints -- so a tight node bbox clips the real silhouette.
    both_px = S[t, :, :, :].reshape(-1, 2)
    x0, y0 = both_px.min(axis=0) - 190
    x1, y1 = both_px.max(axis=0) + 90
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(w_px, int(x1)), min(h_px, int(y1))
    crop = frame_u[y0:y1, x0:x1]
    os.makedirs(os.path.join(HERE, "renders"), exist_ok=True)
    cv2.imwrite(cc.PHOTO_UNDISTORTED, crop)
    print(f"wrote {cc.PHOTO_UNDISTORTED}  crop=({x0},{y0},{x1},{y1})  fps={fps:.3f}")

    # --- image-plane quad: sized/centered on the CROP, not the full sensor --
    # BUG (fixed here): the quad used to span the FULL sensor's FOV while the
    # texture on it was the CROPPED photo -- Blender's UV mapping then stretched
    # the crop across the whole full-FOV quad, so annotation points (projected
    # with full-frame pixel coords) landed nowhere near the actual animal in the
    # (stretched) photo. The quad must span exactly the crop's own solid angle.
    # Distance along the camera's own view axis (NOT screen depth, since our
    # staging camera is ORTHOGRAPHIC -- moving along this axis repositions the
    # quad but does not by itself change its apparent size; QUAD_SIZE_SCALE
    # below does that). The animals sit ~400mm along this same axis from the
    # camera (measured from the real data) -- 0.20m puts the quad meaningfully
    # closer to the 3D scene below it (was 0.12m, which left a big gap to the
    # floor) while staying clearly above the animals, not overlapping them.
    standoff_m = 0.20
    D = standoff_m * 1000  # mm, depth along the camera's forward axis
    fx, fy, cx, cy = cam.K[0, 0], cam.K[1, 1], cam.K[0, 2], cam.K[1, 2]
    crop_w, crop_h = x1 - x0, y1 - y0

    def exact_plane_point(px, py):
        """Pixel (full-frame, possibly distorted) -> the 3D point on the plane
        at depth D along the camera's forward axis that pixel's undistorted ray
        passes through (raw calibration-world frame, mm)."""
        xn, yn = cc.undistort_px(np.array([px, py], float), cam.K, cam.dist)
        return cam.C + cam.R.T @ np.array([xn * D, yn * D, D])

    quad_center_raw = exact_plane_point((x0 + x1) / 2, (y0 + y1) / 2)
    quad_center_al = ali.point(quad_center_raw)
    # crop's angular half-extent at depth D, using the (small, off-axis) pixel
    # offset from the crop center -- a flat-plane approximation, good to a
    # fraction of a percent for a crop this size relative to the full sensor.
    # QUAD_SIZE_SCALE enlarges it beyond its true (tiny) angular size purely
    # for legibility (Eric: "make the image plane a bit bigger for vis
    # purposes") -- schematic, like the ghost's exaggeration; scaling here
    # keeps quad_point()'s u/v -> world mapping self-consistent (markers still
    # land in the same RELATIVE spot on the now-bigger quad).
    QUAD_SIZE_SCALE = 2.1
    half_w_al = D * (crop_w / 2) / fx * QUAD_SIZE_SCALE
    half_h_al = D * (crop_h / 2) / fy * QUAD_SIZE_SCALE

    def quad_point(px_full, py_full):
        """Full-frame pixel -> 3D point on the (flat, crop-sized) quad, aligned frame."""
        u = 2 * (px_full - x0) / crop_w - 1
        v = 2 * (py_full - y0) / crop_h - 1
        return quad_center_al + right_al * (u * half_w_al) + down_al * (v * half_h_al)

    reproj_anchor_world = quad_point(*reproj_anchor_px)
    current_detection_world = quad_point(*current_detection_px)
    anchor_pose_world = np.array([quad_point(*p) for p in anchor_pose_px])
    current_pose_main_world = np.array([quad_point(*p) for p in current_pose_main_px])
    current_pose_other_world = np.array([quad_point(*p) for p in current_pose_other_px])

    # sanity: the crop's own 4 corners must map exactly onto the quad's 4 corners
    corner_check = quad_point(x0, y0)
    assert np.abs(corner_check - (quad_center_al - right_al * half_w_al - down_al * half_h_al)).max() < 1e-6

    # --- floor extent: data-driven, not hand-picked -- must contain BOTH
    # animals' FULL skeletons (incl. tails) plus the exaggerated ghost, or the
    # abstract floor plane clips them (Eric: "make sure the plane is big
    # enough to fit both mice and their tails without it being cut off").
    ghost_al = cc.exaggerated_ghost(X_true_al, X_hat_al, ray_dir_al)
    all_pts = np.concatenate([X_true_al, X_other_al, ghost_al], axis=0)
    # generous margin: the ghost sits ABOVE the floor plane (it's a pose, not
    # a flat token), so in this oblique/isometric view its projection reads as
    # spilling past the floor's back edge unless the plane is sized with real
    # slack beyond the raw XY footprint, not just enough to contain it exactly.
    margin = 75.0
    floor_half = {
        "x0": float(all_pts[:, 0].min() - margin), "x1": float(all_pts[:, 0].max() + margin),
        "y0": float(all_pts[:, 1].min() - margin), "y1": float(all_pts[:, 1].max() + margin),
    }
    print(f"floor bounds (mm): x [{floor_half['x0']:.0f}, {floor_half['x1']:.0f}]  "
          f"y [{floor_half['y0']:.0f}, {floor_half['y1']:.0f}]")

    data = {
        "floor_half": floor_half,
        "X_tp_al": X_tp_al.tolist(), "X_hat_al": X_hat_al.tolist(),
        "X_true_al": X_true_al.tolist(), "X_other_al": X_other_al.tolist(),
        "C_al": C_al.tolist(), "right_al": right_al.tolist(),
        "down_al": down_al.tolist(), "fwd_al": fwd_al.tolist(),
        "ray_dir_al": ray_dir_al.tolist(), "ray_param_mm": ray_param,
        "true_ray_param_mm": true_ray_param, "closest_al": closest_al.tolist(),
        "d2d_px": d2d_px, "d3d_mm": d3d_mm,
        "quad_center_al": quad_center_al.tolist(),
        "half_w_al": half_w_al, "half_h_al": half_h_al,
        "reproj_anchor_world": reproj_anchor_world.tolist(),
        "current_detection_world": current_detection_world.tolist(),
        "anchor_pose_world": anchor_pose_world.tolist(),
        "current_pose_main_world": current_pose_main_world.tolist(),
        "current_pose_other_world": current_pose_other_world.tolist(),
        "crop_box_full_px": [x0, y0, x1, y1], "crop_size_px": [crop_w, crop_h],
        "node_names": cc.NODE_NAMES, "measure_idx": cc.MEASURE_IDX,
        "tprime": tp, "tcur": t,
    }
    cc.save_json(data)
    print(f"wrote {cc.DATA_JSON}")


if __name__ == "__main__":
    main()
