#!/usr/bin/env python
"""Data prep for the identity-switch illustration: computes the real 3D comet
trail for the two crossing animals (2-animal session) and the two real
cameras' image-plane geometry + undistorted/cropped photos at the "could this
be swapped?" instant, and writes renders/idswitch_fig_data.json.

Reuses hyp_fig_prep.py's `prep_camera`/`extract_photo` (imported as a module,
not touched) -- session-agnostic, so it works unchanged against the 2-animal
session's cameras/tracks.

    bpyenv/bin/python idswitch_fig_prep.py
"""
import json
import os

import numpy as np

import hyp_fig_prep as hfp
import idswitch_common as ic

HERE = ic.HERE


def mirror_quad_if_back_side(info, stg, tag):
    """OFF by default (ic.MIRROR_BACKSIDE_QUADS -- see its comment): when
    enabled, and the staging eye is on the OPPOSITE side of this image-plane
    quad from its own real camera, the quad's photo would render MIRRORED in
    the staging view (a texture viewed from behind), so this reflects the
    quad's texture AND its overlay points TOGETHER about the quad's own
    vertical centre plane, making the photo read pixel-for-pixel like the raw
    camera image from the staging side. The camera PROP keeps the true
    right_al basis; only the quad build uses the (possibly flipped)
    quad_right_al written here."""
    qc = np.array(info["quad_center_al"])
    n = np.array(info["fwd_al"])
    cam_side = np.dot(np.array(info["C_al"]) - qc, n)
    eye_side = np.dot(np.array(stg.eye) / ic.MM - qc, n)
    if not ic.MIRROR_BACKSIDE_QUADS or cam_side * eye_side > 0:
        info["quad_right_al"] = info["right_al"]
        return
    r = np.array(info["right_al"])
    rhat = r / np.linalg.norm(r)

    def refl(p):
        p = np.asarray(p, float)
        return p - 2 * np.dot(p - qc, rhat) * rhat

    info["pose_world"] = [[refl(pt).tolist() for pt in animal]
                          for animal in info["pose_world"]]
    info["trunk_world"] = [refl(p).tolist() for p in info["trunk_world"]]
    info["quad_right_al"] = (-r).tolist()
    print(f"{tag}: staging eye is behind this quad -- mirrored its texture+overlay")


def main():
    # dataset-independent (IDSWITCH_DATASET): per-animal aligned trails with
    # their anchor indices, anchor-frame 2D per camera, alignment, calibration
    # -- see idswitch_common.load_figure_data.
    fd = ic.load_figure_data()
    ali, cams = fd["ali"], fd["cams"]
    cam_a, cam_b = cams[ic.CAM_A_NAME], cams[ic.CAM_B_NAME]

    trail_al = fd["trail_al"]  # [A (Ta,15,3), B (Tb,15,3)] -- real poses at real positions

    all_pts = np.concatenate([np.asarray(a).reshape(-1, 3) for a in trail_al])
    margin = 55.0
    floor_half = {
        "x0": float(all_pts[:, 0].min() - margin), "x1": float(all_pts[:, 0].max() + margin),
        "y0": float(all_pts[:, 1].min() - margin), "y1": float(all_pts[:, 1].max() + margin),
    }
    print(f"floor bounds (mm): x [{floor_half['x0']:.0f}, {floor_half['x1']:.0f}]  "
          f"y [{floor_half['y0']:.0f}, {floor_half['y1']:.0f}]")

    # 2D reprojections at IMAGE_FRAME, both animals, both cameras.
    Sa = fd["S_by_cam"][ic.CAM_A_NAME]  # (2,15,2)
    Sb = fd["S_by_cam"][ic.CAM_B_NAME]

    X_al_image = np.stack([trail_al[k][fd["anchor_index"][k]] for k in range(2)])  # (2,15,3)
    dist_a = float(np.linalg.norm(X_al_image.mean((0, 1)) - ali.point(cam_a.C)))
    dist_b = float(np.linalg.norm(X_al_image.mean((0, 1)) - ali.point(cam_b.C)))

    # ic.quad_camera: distortion-free copies on hardfight (undistorted pane
    # textures need pinhole quad geometry); the real cameras on slap2m.
    info_a, crop_a = hfp.prep_camera(ic.quad_camera(cam_a), ali, Sa,
                                     standoff_m=dist_a * ic.QUAD_STANDOFF_FRAC_A / 1000,
                                     quad_scale=ic.QUAD_SCALE_A, margin_px=ic.QUAD_MARGIN_PX)
    info_b, crop_b = hfp.prep_camera(ic.quad_camera(cam_b), ali, Sb,
                                     standoff_m=dist_b * ic.QUAD_STANDOFF_FRAC_B / 1000,
                                     quad_scale=ic.QUAD_SCALE_B, margin_px=ic.QUAD_MARGIN_PX)

    stg = ic.staging_camera(trail_al)
    mirror_quad_if_back_side(info_a, stg, ic.CAM_A_NAME)
    mirror_quad_if_back_side(info_b, stg, ic.CAM_B_NAME)

    hfp.extract_photo(ic.video_glob(ic.CAM_A_NAME), ic.IMAGE_FRAME, ic.FPS,
                      ic.photo_path(ic.CAM_A_NAME), cam_a, crop_a)
    hfp.extract_photo(ic.video_glob(ic.CAM_B_NAME), ic.IMAGE_FRAME, ic.FPS,
                      ic.photo_path(ic.CAM_B_NAME), cam_b, crop_b)
    print("wrote", ic.photo_path(ic.CAM_A_NAME), ic.photo_path(ic.CAM_B_NAME))

    data = {
        "trail_al_a": np.asarray(trail_al[0]).tolist(),
        "trail_al_b": np.asarray(trail_al[1]).tolist(),
        "trail_frames_a": fd["trail_frames"][0], "trail_frames_b": fd["trail_frames"][1],
        "anchor_index_a": fd["anchor_index"][0], "anchor_index_b": fd["anchor_index"][1],
        "floor_half": floor_half,
        "cam_a": info_a, "cam_b": info_b,
        "cam_a_name": ic.CAM_A_NAME, "cam_b_name": ic.CAM_B_NAME,
        "cam_a_label": ic.CAM_A_LABEL, "cam_b_label": ic.CAM_B_LABEL,
        "node_names": ic.NODE_NAMES,
    }
    os.makedirs(os.path.dirname(ic.DATA_JSON), exist_ok=True)
    with open(ic.DATA_JSON, "w") as f:
        json.dump(data, f, indent=2)
    print("wrote", ic.DATA_JSON)


if __name__ == "__main__":
    main()
