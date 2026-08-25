#!/usr/bin/env python3
"""
Fig 1d, 3D tiles: the HardFight pose + rig, measured out of the session's own data.

Eric, 2026-08-25: "for the 3d views in fig1d lets do nice blender renders of the
pose (center) and the camera rig (right) more like our other blender rigs with the
arena floor plane shown for the Hard Fight dataset inferred from the trajectories,
it is also a rectangular prism or cube like volume, it should be shown with the
cameras like we have been visualizing the other arenas in the fig3 and fig1a."

So this is `fig1_bmimica_scene.py` for the OTHER Fig 1 dataset: everything
`blender-images/fig1d_scene.py` needs to build a Blender scene that is entirely
measurement and contains no hand-placed geometry.

  * `arena` -- the movement-fitted box, exactly Fig 1a's BMimica recipe: HardFight
    ships no arena reconstruction (`hardfight_common.py`: no alignment.toml, no
    cage points), so the FOOTPRINT is the 0.1-99.9 percentile span of x and y over
    every triangulated keypoint of all three mice across the whole 36,000-frame
    session, in the same fitted floor-z=0 frame every HardFight figure uses
    (`hardfight_common.load_alignment`, cached in
    blender-images/renders/hardfight_alignment.json). UNLIKE BMimica the footprint
    is NOT squared up -- Eric: "it is also a rectangular prism or cube like
    volume" -- the measured x/y spans are kept as the box's sides, and HEIGHT
    defaults to extruding by the footprint's SHORTER side (the in-code comment at
    the height rule says why that beats Fig 1a's cube-on-the-larger-side here;
    `--height-mode cube|movement` recover the alternatives, and
    `movement_height_mm` is deposited alongside).

  * `cameras` -- the eight real cameras from the session's `calibration.toml`,
    carried into the aligned frame by the SAME cached alignment (centres via
    Alignment.point, axes via Alignment.direction), so Fig 1d's cameras sit
    exactly where the hyp/idswitch illustration figures put them.

  * `pose` -- the APP'S OWN reconstruction at the panel's frame, read from
    figs/out/fig1d_pose.json (written by `node figs/fig1d_pose_export.mjs`: the
    same trackAll + triangulateAll run the video tile's overlays come from, with
    each animal carrying its identity COLOUR). Nothing is re-triangulated here,
    so the Blender mice agree with the video tile's overlay colours by
    construction. The 3D arrives in calib-world mm and is carried into the
    aligned frame; tail keypoints a few mm below the fitted floor are clamped to
    it (visualization only, same as fig5a_scene.load_pose).

FRAME-OFFSET CROSS-CHECK. figs/session is a 300-frame trim of the full session
starting at build_fig_session.py's default S=24551, but the trim records no
offset. Rather than trust the default, this script triangulates absolute frame
CLIP_START + frame offline (hardfight_common.poses_calib) and matches each app
animal to the nearest offline animal by median keypoint distance: at the right
offset the same mice are within a few mm (the two pipelines share detections and
calibration and differ only in association/rejection rules); at a wrong offset
they are body lengths apart. The check FAILS LOUDLY above --check-mm (25 mm).

  python3 figs/fig1_hardfight_scene.py                  # ~2 min (footprint scan)
  Writes figs/out/fig1_hardfight_scene.json; render with
  blender-images/bpyenv/bin/python blender-images/fig1d_scene.py
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "blender-images"))
import hardfight_common as hf  # noqa: E402

OUT_JSON = os.path.join(HERE, "out", "fig1_hardfight_scene.json")
POSE_JSON = os.path.join(HERE, "out", "fig1d_pose.json")

#: build_fig_session.py's default trim start (the trim itself records nothing;
#: verified against the data by the frame-offset cross-check below).
CLIP_START = 24551
#: footprint percentiles + sampling stride, Fig 1a's BMimica values
PCT = (0.1, 99.9)
SAMPLE_STEP = 100


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--pose", default=POSE_JSON)
    ap.add_argument("--out", default=OUT_JSON)
    ap.add_argument("--step", type=int, default=SAMPLE_STEP,
                    help="footprint-scan frame stride over the 36,000 frames")
    ap.add_argument("--height-mode", choices=["short-side", "cube", "movement"],
                    default="short-side",
                    help="box height: the footprint's SHORTER side (default), the "
                         "larger side (Fig 1a's cube rule), or the movement extent")
    ap.add_argument("--check-mm", type=float, default=25.0,
                    help="fail if the app pose vs offline pose median keypoint "
                         "distance exceeds this (frame-offset cross-check)")
    args = ap.parse_args()

    with open(args.pose) as f:
        P = json.load(f)
    frame_clip = int(P["frame"])
    frame_abs = CLIP_START + frame_clip
    nodes = P["nodes"]
    assert nodes == hf.cc.NODE_NAMES, "session skeleton != chen_common.NODE_NAMES"

    print(f"loading HardFight predictions + calibration ({len(hf.CAMS)} cameras)")
    cams = hf.load_calibration_all()
    slp = hf.load_all_slp()
    ali = hf.load_alignment(slp, cams)

    # ---- the app's pose, into the aligned frame --------------------------------
    pose_cal = np.array([[p if p is not None else [np.nan] * 3
                          for p in g["points3d"]] for g in P["groups"]], float)
    pose = np.stack([ali.point(a) for a in pose_cal])          # (A, 15, 3) mm, z up
    colors = [g["color"] for g in P["groups"]]
    names = [g["name"] for g in P["groups"]]

    # ---- frame-offset cross-check (see docstring) ------------------------------
    X_off, _ = hf.poses_calib(slp, cams, frame_abs)
    X_off = np.stack([ali.point(a) for a in X_off]) if len(X_off) else X_off
    med = []
    for a in pose:
        best = np.inf
        for b in X_off:
            d = np.linalg.norm(a - b, axis=1)
            if np.isfinite(d).any():
                best = min(best, float(np.nanmedian(d)))
        med.append(best)
    print(f"frame-offset check: clip frame {frame_clip} = absolute {frame_abs}, "
          f"app-vs-offline median keypoint distance per animal "
          f"{['%.1f' % m for m in med]} mm")
    if not all(m <= args.check_mm for m in med):
        raise SystemExit(f"cross-check failed (> {args.check_mm} mm): the clip "
                         f"offset {CLIP_START} does not reproduce the app's pose")

    # ---- the movement-fitted footprint -----------------------------------------
    print(f"footprint scan: every {args.step}th frame of 36,000 ...")
    pts = []
    for fr in range(0, 36000, args.step):
        X, _ = hf.poses_calib(slp, cams, fr)
        for a in X:
            pts.append(ali.point(a))
    C = np.concatenate(pts)
    C = C[~np.isnan(C).any(1)]
    lo, hi = np.percentile(C[:, 0], PCT), np.percentile(C[:, 1], PCT)
    x_span, y_span = float(lo[1] - lo[0]), float(hi[1] - hi[0])
    centre = [float((lo[0] + lo[1]) / 2), float((hi[0] + hi[1]) / 2)]
    movement_height = float(np.nanmax(C[:, 2]))
    # SHORT-SIDE, not Fig 1a's cube-on-the-larger-side: the footprint is a
    # RECTANGLE here (496 x 321), so "extrude by its own side" has two readings,
    # and the larger one (496) runs the box rim into the measured overhead camera
    # ring (lowest overhead z = 523 mm -- 27 mm of clearance; the rendered rim
    # visibly collides with the hanging bodies). The shorter side is the same
    # kind of non-dialed number, is still 2.3x the animals' own 138 mm vertical
    # extent, and leaves the real camera positions reading as a ring ABOVE an
    # open-top volume, which is what they are.
    height = {"short-side": min(x_span, y_span),
              "cube": max(x_span, y_span),
              "movement": movement_height}[args.height_mode]
    raw_x = float(C[:, 0].max() - C[:, 0].min())
    raw_y = float(C[:, 1].max() - C[:, 1].min())
    print(f"arena: {x_span:.1f} x {y_span:.1f} mm footprint "
          f"(raw {raw_x:.1f} x {raw_y:.1f}), height {height:.1f} mm "
          f"({args.height_mode}; movement {movement_height:.1f} mm), "
          f"{len(C):,} keypoints")

    # clamp below-floor keypoints ONTO the floor (visualization only; the fitted
    # floor is the 2nd percentile of heights, so feet/tails straddle it)
    n_clamp = int((pose[:, :, 2] < 0.5).sum())
    pose[:, :, 2] = np.maximum(pose[:, :, 2], 0.5)
    if n_clamp:
        print(f"clamped {n_clamp} below-floor keypoints onto z = 0.5 mm")

    # ---- the eight real cameras, into the aligned frame ------------------------
    cameras = []
    for ci, cname in enumerate(hf.CAMS):
        cam = cams[cname]
        cameras.append({
            "name": cname, "index": ci,
            "centre_mm": ali.point(cam.C).tolist(),
            "right": ali.direction(cam.R[0]).tolist(),
            "down": ali.direction(cam.R[1]).tolist(),
            "forward": ali.direction(cam.R[2]).tolist(),
        })
        cm = cameras[-1]
        print(f"  cam {cname}: centre ({cm['centre_mm'][0]:7.1f}, "
              f"{cm['centre_mm'][1]:7.1f}, {cm['centre_mm'][2]:7.1f}) mm   "
              f"forward ({cm['forward'][0]:+.3f}, {cm['forward'][1]:+.3f}, "
              f"{cm['forward'][2]:+.3f})")

    out = {
        "corpus": "HardFight", "session": "20260605_133431",
        "clip": {"rel": "figs/session", "start": CLIP_START, "frame": frame_clip},
        "frame": frame_abs, "fps": hf.FPS, "n_animals": len(pose),
        "nodes": nodes,
        "arena": {
            "x_span_mm": x_span, "y_span_mm": y_span, "height_mm": float(height),
            "height_mode": args.height_mode,
            "movement_height_mm": movement_height,
            "centre_xy_mm": centre, "floor_z_mm": 0.0, "pct": list(PCT),
            "x_span_raw_mm": raw_x, "y_span_raw_mm": raw_y,
            "n_points": int(len(C)), "sample_step": args.step,
        },
        "cameras": cameras,
        "pose_mm": pose.tolist(),            # (A, 15, 3) aligned mm, z = height
        "pose_colors": colors,               # the app's identity palette, per animal
        "pose_names": names,
        "pose_source": args.pose,
        "offset_check_mm": med,
        "alignment": "blender-images/renders/hardfight_alignment.json",
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
