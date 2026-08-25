#!/usr/bin/env python
"""Data prep for the multi-view grouping-hypothesis figure: computes every
real quantity the render + compositor need and writes them to
renders/hyp_fig_data_<variant>.json, plus undistorted+cropped real photos.

    bpyenv/bin/python hyp_fig_prep.py --variant sidetop
    bpyenv/bin/python hyp_fig_prep.py --variant toptop

See hyp_common.py's docstring for the session/frame choice; CAMERA_PAIRS
there defines what each --variant means.
"""
import argparse
import glob
import json
import os
import subprocess

import cv2
import numpy as np

import chen_common as cc
import hyp_common as hc
from hardfight_common import pinhole_camera

HERE = hc.HERE


def undistorted_image_px(cam, px):
    """Distorted (raw) image px -> that feature's position in the
    cv2.undistort-ed image (newCameraMatrix defaults to K): K @ undistort(px).

    The reprojections.h5 pixels are DISTORTED-image coordinates, but
    extract_photo shows the UNDISTORTED frame -- drawing raw coordinates onto
    it shifts every overlay point (median 4 px, up to 40 px on extremities
    for this rig's side camera at the hyp FRAME; far worse on HardFight's
    stronger lenses, where it put whole skeletons off the animals). Convert
    the 2D to undistorted coordinates and hand prep_camera a distortion-free
    `pinhole_camera` copy, so texture, overlays, and quad geometry share one
    convention (Eric: "make sure we deal with the distortions properly ...
    the others from slap2m need to be corrected for distortion too")."""
    xn = cc.undistort_px(np.asarray(px, float), cam.K, cam.dist)
    return np.stack([cam.K[0, 0] * xn[..., 0] + cam.K[0, 2],
                     cam.K[1, 1] * xn[..., 1] + cam.K[1, 2]], axis=-1)


def prep_camera(cam, ali, S_px, standoff_m, quad_scale, margin_px):
    """Everything specific to ONE real camera: undistorted+cropped photo, its
    image-plane quad geometry, and where each animal's full pose + measure
    node land on that quad (aligned-frame 3D, so the compositor can
    re-project them through the shared staging camera later)."""
    w_px, h_px = cam.size
    both_px = S_px.reshape(-1, 2)
    x0, y0 = both_px.min(axis=0) - margin_px
    x1, y1 = both_px.max(axis=0) + margin_px
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(w_px, int(x1)), min(h_px, int(y1))
    crop_w, crop_h = x1 - x0, y1 - y0

    D = standoff_m * 1000
    fx, fy = cam.K[0, 0], cam.K[1, 1]

    def exact_plane_point(px, py):
        xn, yn = cc.undistort_px(np.array([px, py], float), cam.K, cam.dist)
        return cam.C + cam.R.T @ np.array([xn * D, yn * D, D])

    quad_center_raw = exact_plane_point((x0 + x1) / 2, (y0 + y1) / 2)
    quad_center_al = ali.point(quad_center_raw)
    right_al = ali.direction(cam.R_c2w[:, 0])
    down_al = ali.direction(cam.R_c2w[:, 1])
    fwd_al = ali.direction(cam.R_c2w[:, 2])
    half_w_al = D * (crop_w / 2) / fx * quad_scale
    half_h_al = D * (crop_h / 2) / fy * quad_scale

    def quad_point(px_full, py_full):
        u = 2 * (px_full - x0) / crop_w - 1
        v = 2 * (py_full - y0) / crop_h - 1
        return quad_center_al + right_al * (u * half_w_al) + down_al * (v * half_h_al)

    pose_world = np.array([[quad_point(*p) for p in animal] for animal in S_px])  # (3,15,3)
    trunk_world = pose_world[:, hc.MEASURE_IDX]  # (3,3)

    return {
        "C_al": ali.point(cam.C).tolist(), "right_al": right_al.tolist(),
        "down_al": down_al.tolist(), "fwd_al": fwd_al.tolist(),
        "quad_center_al": quad_center_al.tolist(),
        "half_w_al": half_w_al, "half_h_al": half_h_al,
        "pose_world": pose_world.tolist(), "trunk_world": trunk_world.tolist(),
        "crop_box_full_px": [x0, y0, x1, y1],
    }, (x0, y0, x1, y1)


def extract_photo(mp4_glob, frame, fps, out_path, cam, crop_box):
    mp4 = glob.glob(mp4_glob)[0]
    raw_png = os.path.join(HERE, "renders", "_hyp_raw.png")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{frame / fps:.6f}",
         "-i", mp4, "-vframes", "1", raw_png], check=True)
    frame_img = cv2.imread(raw_png)
    assert frame_img is not None
    dist = np.array(cam.dist[:5])
    frame_u = cv2.undistort(frame_img, cam.K, dist)
    x0, y0, x1, y1 = crop_box
    cv2.imwrite(out_path, frame_u[y0:y1, x0:x1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default=hc.DEFAULT_VARIANT, choices=list(hc.CAMERA_PAIRS))
    ap.add_argument("--quad-scale", type=float, default=3.4,
                    help="image-plane size multiplier -- big, but slightly smaller than the "
                         "first bigger-per-Eric pass")
    ap.add_argument("--quad-scale-a-mult", type=float, default=2.3,
                    help="cam_a uses a smaller standoff fraction (to clear the floor, see "
                         "standoff-frac-a's docstring below) which shrinks its quad "
                         "proportionally -- this multiplier compensates so cam_a's photo "
                         "isn't left noticeably smaller than cam_b's")
    ap.add_argument("--standoff-frac-a", type=float, default=0.16)
    ap.add_argument("--standoff-frac-b", type=float, default=0.30)
    args = ap.parse_args()

    cam_a_name, cam_b_name = hc.cam_names(args.variant)
    cams = hc.load_calibration_all()
    cam_a, cam_b = cams[cam_a_name], cams[cam_b_name]
    ali = hc.load_alignment()
    X = hc.load_tracks3d()  # (frames, 3, 15, 3) mm
    # -> undistorted-image coordinates (see undistorted_image_px's docstring);
    # hc.TRACK_ORDER assigns which mouse gets which colour slot.
    Sa = undistorted_image_px(cam_a, hc.load_reprojections(cam_a_name)[hc.FRAME])[hc.TRACK_ORDER]
    Sb = undistorted_image_px(cam_b, hc.load_reprojections(cam_b_name)[hc.FRAME])[hc.TRACK_ORDER]

    X_al = ali.point(X[hc.FRAME].reshape(-1, 3)).reshape(hc.N_ANIMALS, 15, 3)[hc.TRACK_ORDER]

    dist_a = float(np.linalg.norm(X_al.mean((0, 1)) - ali.point(cam_a.C)))
    dist_b = float(np.linalg.norm(X_al.mean((0, 1)) - ali.point(cam_b.C)))
    print(f"[{args.variant}] camera-to-scene distance: {cam_a_name}={dist_a:.0f}mm  "
          f"{cam_b_name}={dist_b:.0f}mm")

    # pinhole_camera: S is in undistorted coordinates now, so the quad
    # machinery must not undistort again.
    info_a, crop_a = prep_camera(pinhole_camera(cam_a), ali, Sa,
                                 standoff_m=dist_a * args.standoff_frac_a / 1000,
                                 quad_scale=args.quad_scale * args.quad_scale_a_mult, margin_px=110)
    info_b, crop_b = prep_camera(pinhole_camera(cam_b), ali, Sb,
                                 standoff_m=dist_b * args.standoff_frac_b / 1000,
                                 quad_scale=args.quad_scale, margin_px=110)

    # schematic sideways separation for camera B's prop+quad only (see
    # hyp_common.schematic_offset_b's docstring) -- a no-op for variants whose
    # real baseline is already big enough to read clearly (sidetop).
    off = hc.schematic_offset_b(args.variant)
    if np.any(off):
        info_b["C_al"] = (np.array(info_b["C_al"]) + off).tolist()
        info_b["quad_center_al"] = (np.array(info_b["quad_center_al"]) + off).tolist()
        info_b["pose_world"] = (np.array(info_b["pose_world"]) + off).tolist()
        info_b["trunk_world"] = (np.array(info_b["trunk_world"]) + off).tolist()

    # camera A's PROP only -- its quad, poses and trunk points stay exactly
    # where the real geometry puts them (see SCHEMATIC_OFFSET_A_PROP_MM).
    off_a = hc.schematic_offset_a_prop(args.variant)
    if np.any(off_a):
        info_a["C_al"] = (np.array(info_a["C_al"]) + off_a).tolist()

    extract_photo(f"{hc.SESSION}/{cam_a_name}/{cam_a_name}-*_h265_CRF12_denoised.mp4",
                  hc.FRAME, 30.0, hc.photo_a_path(args.variant), cam_a, crop_a)
    extract_photo(f"{hc.SESSION}/{cam_b_name}/{cam_b_name}-*_h265_CRF12_denoised.mp4",
                  hc.FRAME, 30.0, hc.photo_b_path(args.variant), cam_b, crop_b)
    print("wrote", hc.photo_a_path(args.variant), hc.photo_b_path(args.variant))

    margin = 45.0
    floor_half = {
        "x0": float(X_al[..., 0].min() - margin), "x1": float(X_al[..., 0].max() + margin),
        "y0": float(X_al[..., 1].min() - margin), "y1": float(X_al[..., 1].max() + margin),
    }
    print(f"floor bounds (mm): x [{floor_half['x0']:.0f}, {floor_half['x1']:.0f}]  "
          f"y [{floor_half['y0']:.0f}, {floor_half['y1']:.0f}]")

    data = {
        "variant": args.variant, "cam_a_name": cam_a_name, "cam_b_name": cam_b_name,
        "X_al": X_al.tolist(),
        "floor_half": floor_half,
        "cam_a": info_a, "cam_b": info_b,
        "measure_idx": hc.MEASURE_IDX, "n_animals": hc.N_ANIMALS,
        "node_names": hc.NODE_NAMES,
    }
    out_json = hc.data_json_path(args.variant)
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w") as f:
        json.dump(data, f, indent=2)
    print("wrote", out_json)


if __name__ == "__main__":
    main()
