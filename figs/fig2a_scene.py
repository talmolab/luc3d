#!/usr/bin/env python3
"""
Fig 2a, "3D from the 2 anchors" tile: the TWO-ANCHOR pose, measured for Blender.

Eric, 2026-08-25: "lets do a blender style render like we just did for fig 1d
(center) for fig2a2 (bottom)". The tile used to be the app's own three.js canvas
(dark viewport, unlit skeletons); it becomes the same ball-and-stick render as
Fig 1d's centre tile, standing on the movement-fitted arena floor plane.

THE POSE IS THE TWO-ANCHOR SOLVE, NOT AN EIGHT-VIEW SOLVE RELABELLED. The panel's
claim is "3D from the 2 anchors": fig2_protocol.mjs zeroes every other view's
weight through the app's own Camera Views panel, triangulates, and dumps that
per-identity 3D (plus, for the cross-check below, the same frame's all-views
solve) into figs/out/fig2a_pose.json. Nothing is re-triangulated here.

Same session as Fig 1d (figs/session = the trimmed 8-camera HardFight clip), so:

  * ALIGNMENT -- calib-world -> floor z=0, +z up, in mm -- is the SAME cached fit
    every HardFight figure uses (hardfight_common.load_alignment,
    blender-images/renders/hardfight_alignment.json). HardFight ships no
    alignment.toml; that cache is fit_alignment's cloud fit (thin axis = up,
    floor = 2nd percentile of heights).
  * ARENA RULE -- the floor plane's footprint is Fig 1d's movement rule verbatim
    (fig1_hardfight_scene.py, itself Fig 1a's BMimica recipe): the 0.1-99.9
    percentile span of x and y over every triangulated keypoint of all three mice
    across the whole 36,000-frame session, sampled every SAMPLE_STEP frames.
    Recomputed here rather than read out of Fig 1d's deposit so the two figures'
    builds stay independent; the rule (and so the plane) is identical.

CROSS-CHECKS, all fail-loud:
  * two-anchor vs all-views: per animal, the median keypoint distance between the
    two solves in this very dump must be small (same detections, same
    calibration; a two-view DLT differs by a few mm, not body lengths). Catches
    an anchor-weight staging failure, where "the two-anchor solve" silently IS
    the eight-view solve or garbage.
  * scale + floor: each mouse's nose--TTI span must land at real mouse scale and
    its lowest keypoint near the fitted floor.

VIEWPOINT: the deposit also carries the render azimuth/elevation COMPUTED from
the cam 6 sideL anchor's own calibrated forward axis (carried into the aligned
frame), so the Blender tile keeps sitting "under the cam 6 sideL video at that
camera's own viewpoint" -- the same reasoning the old app-viewport shot used
(Eric 2026-08-19: "re render that with the camera in the same camera angle as
sideL"). fig1d_scene.py --mode pose ignores S["cameras"] beyond len(), so the
deposit ships cameras: [] and the viewpoint travels as suggested_azim/elev_deg.

  python3 figs/fig2a_scene.py                    # ~2 min (footprint scan)
  Writes figs/out/fig2a_scene.json; render with
  blender-images/bpyenv/bin/python blender-images/fig1d_scene.py --mode pose \
      --scene figs/out/fig2a_scene.json --azim <suggested_azim_deg> \
      --elev <suggested_elev_deg> --aspect 1.19 \
      --out blender-images/renders/fig2a_pose.png
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "blender-images"))
import hardfight_common as hf  # noqa: E402

OUT_JSON = os.path.join(HERE, "out", "fig2a_scene.json")
POSE_JSON = os.path.join(HERE, "out", "fig2a_pose.json")

#: footprint percentiles + sampling stride, fig1_hardfight_scene.py's values
PCT = (0.1, 99.9)
SAMPLE_STEP = 100
#: the anchor whose viewpoint the tile takes (the video it sits under)
VIEW_ANCHOR = "Camera6_sideL"


def as_pose(groups):
    """deposit groups -> (A, N, 3) float array, None -> NaN."""
    return np.array([[p if p is not None else [np.nan] * 3
                      for p in g["points3d"]] for g in groups], float)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--pose", default=POSE_JSON)
    ap.add_argument("--out", default=OUT_JSON)
    ap.add_argument("--step", type=int, default=SAMPLE_STEP,
                    help="footprint-scan frame stride over the 36,000 frames")
    ap.add_argument("--check-mm", type=float, default=30.0,
                    help="fail if two-anchor vs all-views median keypoint "
                         "distance exceeds this (staging cross-check)")
    args = ap.parse_args()

    with open(args.pose) as f:
        P = json.load(f)
    nodes = P["nodes"]
    assert nodes == hf.cc.NODE_NAMES, "session skeleton != chen_common.NODE_NAMES"

    print(f"loading HardFight predictions + calibration ({len(hf.CAMS)} cameras)")
    cams = hf.load_calibration_all()
    slp = hf.load_all_slp()
    ali = hf.load_alignment(slp, cams)

    # ---- both solves, into the aligned frame ------------------------------------
    pose = np.stack([ali.point(a) for a in as_pose(P["groups"])])       # 2-anchor
    pose_all = np.stack([ali.point(a) for a in as_pose(P["groupsAllViews"])])
    colors = [g["color"] for g in P["groups"]]
    names = [g["name"] for g in P["groups"]]

    # ---- cross-check: the crippled solve against the full one -------------------
    all_by_id = {g["identityId"]: i for i, g in enumerate(P["groupsAllViews"])}
    med = []
    for gi, g in enumerate(P["groups"]):
        b = pose_all[all_by_id[g["identityId"]]]
        d = np.linalg.norm(pose[gi] - b, axis=1)
        med.append(float(np.nanmedian(d)))
    print(f"two-anchor vs all-views median keypoint distance per animal "
          f"{['%.1f' % m for m in med]} mm")
    if not all(m <= args.check_mm for m in med):
        raise SystemExit(f"cross-check failed (> {args.check_mm} mm): the "
                         f"two-anchor solve does not track the all-views solve -- "
                         f"was the anchor staging in fig2_protocol.mjs broken?")

    # ---- sanity: mouse scale + feet on the fitted floor -------------------------
    # Scale is checked along the SPINE PATH (nose -> ... -> TTI, summed segment
    # lengths), not the straight nose--TTI chord: a curled-up mouse (id_2 on this
    # frame sits hunched in the corner) folds the chord to ~31 mm while its spine
    # is still full mouse length.
    spine = ["Nose", "Head", "Neck", "Trunk", "TTI"]
    idx = [nodes.index(n) for n in spine]
    for a, nm in zip(pose, names):
        seg = np.diff(a[idx], axis=0)
        body = float(np.nansum(np.linalg.norm(seg, axis=1)))
        zmin = float(np.nanmin(a[:, 2]))
        print(f"  {nm}: spine path {body:.1f} mm, lowest keypoint z {zmin:.1f} mm")
        if not (60.0 <= body <= 220.0):
            raise SystemExit(f"{nm}: spine path {body:.1f} mm is not mouse scale "
                             f"-- wrong alignment or wrong units")
        if not (-40.0 <= zmin <= 120.0):
            raise SystemExit(f"{nm}: lowest keypoint {zmin:.1f} mm is nowhere "
                             f"near the fitted floor")

    # ---- the movement-fitted footprint (fig1_hardfight_scene's rule) ------------
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
    print(f"arena: {x_span:.1f} x {y_span:.1f} mm footprint, {len(C):,} keypoints")

    # clamp below-floor keypoints ONTO the floor (visualization only, exactly
    # fig1_hardfight_scene.py: the fitted floor is the 2nd percentile of heights,
    # so feet/tails straddle it)
    n_clamp = int((pose[:, :, 2] < 0.5).sum())
    pose[:, :, 2] = np.maximum(pose[:, :, 2], 0.5)
    if n_clamp:
        print(f"clamped {n_clamp} below-floor keypoints onto z = 0.5 mm")

    # ---- the sideL anchor's viewpoint as render azim/elev -----------------------
    # cage_scene.setup_render_camera puts the ortho camera at
    # focus + d*(cos e cos a, cos e sin a, sin e) looking AT focus, so its view
    # direction is MINUS that unit vector; equate it to sideL's aligned forward.
    fwd = ali.direction(cams[VIEW_ANCHOR].R[2])
    fwd = fwd / np.linalg.norm(fwd)
    azim = float(np.degrees(np.arctan2(-fwd[1], -fwd[0])) % 360.0)
    elev = float(np.degrees(np.arcsin(np.clip(-fwd[2], -1, 1))))
    print(f"viewpoint from {VIEW_ANCHOR}: azim {azim:.1f} deg, elev {elev:.1f} deg")

    out = {
        "corpus": "HardFight", "session": "20260605_133431",
        "clip": {"rel": "figs/session", "frame": int(P["frame"])},
        "frame": int(P["frame"]), "fps": hf.FPS, "n_animals": len(pose),
        "anchors": P["anchors"], "nodes": nodes,
        "arena": {
            "x_span_mm": x_span, "y_span_mm": y_span,
            # height is unused by --mode pose (floor plane only); the movement
            # rule's short side is deposited so the key is honest if ever read.
            "height_mm": float(min(x_span, y_span)),
            "centre_xy_mm": centre, "floor_z_mm": 0.0, "pct": list(PCT),
            "n_points": int(len(C)), "sample_step": args.step,
        },
        "cameras": [],                       # pose mode builds none
        "pose_mm": pose.tolist(),            # (A, 15, 3) aligned mm, z up
        "pose_colors": colors,               # the app's identity palette
        "pose_names": names,
        "pose_source": args.pose,
        "crosscheck_two_anchor_vs_all_views_mm": med,
        "suggested_azim_deg": azim, "suggested_elev_deg": elev,
        "view_anchor": VIEW_ANCHOR,
        "alignment": "blender-images/renders/hardfight_alignment.json",
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
