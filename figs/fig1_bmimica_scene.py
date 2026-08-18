#!/usr/bin/env python3
"""
Fig 1a, right half: the BMimica rig, measured out of one session's own data.

WHAT THIS DEPOSITS. Everything `blender-images/bmimica_scene.py` needs to build a
Blender scene that is entirely measurement and contains no hand-placed geometry:

  * `arena` -- the movement-fitted box. Eric asked for the volume to be "as big as
    the whole space covered by their movement ... they are in a square so we should
    fit the cube to their overall movement to approximate the floor". BMimica has no
    cage-corner reconstruction the way SLAP-2M does (`aligned_cage_points3d.h5`), so
    the FOOTPRINT is recovered from where the animals actually went. THE STATISTIC IS
    THE 0.1-99.9 PERCENTILE SPAN of x and y over every finite keypoint of both animals
    across the whole session, and the floor is made SQUARE by taking the larger of
    the two spans -- raw min/max is 15 mm wider per axis and is set by a handful of
    triangulation outliers, while the percentile span reproduces to ~5 mm across
    sessions (649/653 x 653/653 mm on 20250827_141755 / 20250904_131913). Measured
    2026-08-17: 653 mm square, which is a real 65 cm open field, not a unit slip.
    The P-frame floor is already exactly z = 0 (`min(z) == 0.0` in every session), so
    the box sits on z = 0 with no floor fit needed.

    HEIGHT is a CUBE on that footprint (`--height-mode cube`, the default): 653 mm,
    which is 4.2x the animals' own 156 mm vertical extent. The first version of this
    figure drew the box at the movement extent itself and it printed as a shallow
    tray under cameras a metre up -- Eric, 2026-08-17: "the volume of the cube needs
    to be much higher ... 4 or 5 times taller". A cube is the one taller box that is
    not a dialed number: it is the measured footprint, extruded by its own side. It
    also does not overclaim, because it is not a measured wall. What the real arena
    is was checked rather than assumed -- projecting this footprint into the five
    real videos (`z = 0` lands on the visible floor square to within a few px)
    shows a square enclosure whose CLEAR acrylic walls run well above the animals
    and out of every camera's view, so a tall box is the faithful reading and a
    tray was the misleading one. The walls being transparent is also why the height
    is not measured off the videos: there is no opaque rim to find.
    `movement_height_mm` (the full max of z -- a percentile would clip rearing, which
    IS the behaviour) is deposited alongside, and `--height-mode movement` recovers
    the original render.

  * `cameras` -- the five real cameras from the session's own
    `calibration/*_calibration.toml`, brought into the P-frame. NOTHING here is
    hard-coded to a camera count; the list is whatever the TOML holds.

  * `pose` -- both animals' tracked 3D at one chosen frame, P-frame mm.

THE FRAME OF REFERENCE PROBLEM, and why this script exists at all. The proofread 3D
lives in the P-frame (`*points3d_translated_rotated_metric.h5`: metres, floor-
aligned, z = height) and the calibration lives in its own frame (millimetres, origin
at camera 0). To draw the cameras around the animals both have to be in ONE frame, so
this reuses the recipe Fig 2, Fig 4 and Fig 5 already use -- triangulate the raw
per-camera 2D with the calibration, then RANSAC-Procrustes the P-frame points onto
that cloud -- and then INVERTS it to carry the camera centres and axes into the
P-frame, exactly as `fig5_views.py` does. A second, differently-wrong alignment would
put Fig 1's cameras somewhere Fig 5's are not. The fitted scale, inlier fraction and
residual are deposited so the alignment is checkable rather than hidden.

FRAME CHOICE is a stated rule, not a hand-pick, and since 2026-08-17 the rule picks a
MUTUAL UPRIGHT DISPLAY -- Eric: "lets choose a frame where it is more clear what the
mice are doing maybe when they are rearing". The previous rule maximised plan-view
extent, which by construction returned two animals lying flat: the most legible
possible pair of skeletons and the least legible possible BEHAVIOUR, two horizontal
smears on the floor of the box. Rearing is the one configuration that reads as an
action at 50 mm on the page, it is the behaviour Fig 5 is about, and it is what makes
the box's height mean something. So the rule is Fig 5's own event definition
(`fig5_upright.py`: neck above REAR_FRAC of the animal's own body length, tail bases
within NEAR_BL of each other) plus two constraints -- every keypoint of both animals
inside IN_BOX_FRAC of the fitted footprint, since a keypoint outside it would be drawn
poking through the wall of the box, and tail bases at least MIN_SEP_BL apart so the
two skeletons do not fuse into one blob -- and among the survivors it takes the frame
maximising the LOWER of the two animals' heights, i.e. the frame where BOTH are most
clearly up. Nothing is hand-picked; the counts are printed and deposited. `--frame N`
overrides for diagnostics only.

There is NO constraint that the pair be near the middle of the arena, because mice
rear AT WALLS: requiring both animals inside the middle 80% of the footprint leaves 0
candidate frames in 48 of the 50 two-animal BMimica sessions that have a calibration.
Wall-rearing is the behaviour, not an artefact of it.

WHICH SESSION follows from the rule rather than the reverse, and the default MOVED on
2026-08-17 because of it. 20250827_141755, the old default (the first session of the
Fig 3e / Fig 8 eight-session set), has 343 frames with both animals rearing and NOT
ONE of them with the two animals within NEAR_BL of each other -- no mutual display to
draw. 20250827_152238, another session of that same family, has 3,263 both-rearing
frames, 1,945 of them close together, 857 surviving the whole rule. It is also the
session Fig 5a's own upright-display render comes from (`out/fig5_views.json`), so
Fig 1a and Fig 5a now show the same behaviour in the same arena -- a DIFFERENT frame
of it (56,806 here against 93,021 there), so nothing is printed twice.

Needs the bench env for cv2/toml/scipy (as `fig5_views.py` does):

    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig1_bmimica_scene.py

Then render with (from figs/blender-images/):

    bpyenv/bin/python bmimica_scene.py
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

from build_gt_reproj import (SERIALS, load_calibration,             # noqa: E402
                             load_sleap_2d, ransac_align, undistort)
from fig2_measure import triangulate_batch                          # noqa: E402

BMIMICA = "/root/vast/eric/BMimica"
#: a session of the Fig 3e / Fig 8 eight-session set with its own calibration (six of
#: the 56 have an empty `calibration/`) AND a mutual upright display the frame rule can
#: land on -- see the docstring for why this is no longer 20250827_141755. Fig 5a's
#: upright render comes from this same session.
DEFAULT_SESSION = "20250827_152238"

NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = NODES.index("Nose"), NODES.index("TTI"), NODES.index("Neck")

#: the arena-fit percentiles (see the docstring): robust to triangulation outliers,
#: reproducible across sessions to ~5 mm.
PCT_LO, PCT_HI = 0.1, 99.9
#: frame-choice rule -- Fig 5's mutual-upright event definition (fig5_upright.py's
#: REAR_FRAC / NEAR_BL, kept numerically identical so Fig 1 shows the same behaviour
#: Fig 5 measures) plus the two legibility constraints.
REAR_FRAC = 0.75         # neck above this fraction of the animal's own body length
NEAR_BL = 2.0            # tail bases no further apart than this, body lengths
MIN_SEP_BL = 0.5         # ... and no closer, so the skeletons stay separable
IN_BOX_FRAC = 0.98       # every keypoint within this fraction of the footprint's
                         # half-extent, per axis, so nothing pokes through a wall
#: stride for the arena fit -- every 5th frame is 216k samples per session, which
#: moves the fitted span by < 1 mm against every frame and reads in a few seconds.
FIT_STRIDE = 5


def fit_arena(X_mm, height_mode="cube"):
    """(F, A, N, 3) mm -> the movement-fitted box: square floor, floor at z = 0.

    `height_mode` sets the DRAWN height (see the docstring): "cube" extrudes the
    measured footprint by its own side; "movement" is the animals' own vertical
    extent, the original render's shallow tray. Both numbers are always deposited."""
    P = X_mm.reshape(-1, 3)
    P = P[np.isfinite(P).all(1)]
    xr = np.percentile(P[:, 0], [PCT_LO, PCT_HI])
    yr = np.percentile(P[:, 1], [PCT_LO, PCT_HI])
    side = float(max(xr[1] - xr[0], yr[1] - yr[0]))
    move_h = float(P[:, 2].max())
    return {
        "side_mm": side,
        "height_mm": side if height_mode == "cube" else move_h,
        "height_mode": height_mode,
        "movement_height_mm": move_h,
        "height_over_movement": (side if height_mode == "cube" else move_h) / move_h,
        "centre_xy_mm": [float((xr[0] + xr[1]) / 2), float((yr[0] + yr[1]) / 2)],
        "floor_z_mm": float(P[:, 2].min()),
        "pct": [PCT_LO, PCT_HI],
        "x_span_mm": float(xr[1] - xr[0]), "y_span_mm": float(yr[1] - yr[0]),
        "x_span_raw_mm": float(P[:, 0].max() - P[:, 0].min()),
        "y_span_raw_mm": float(P[:, 1].max() - P[:, 1].min()),
        "n_points": int(len(P)),
    }


def pick_frame(X_mm, arena):
    """The stated frame rule -- a mutual upright display (see the docstring).
    Returns (frame, diagnostics)."""
    L = np.nanmedian(np.linalg.norm(X_mm[:, :, NOSE] - X_mm[:, :, TTI], axis=-1),
                     axis=0)
    Lm = float(L.mean())
    tti = X_mm[:, :, TTI, :]
    ctr = np.asarray(arena["centre_xy_mm"], float)
    half = arena["side_mm"] / 2
    sep = np.linalg.norm(tti[:, 0] - tti[:, 1], axis=-1) / Lm
    # every keypoint of both animals inside the footprint, per axis (the arena is
    # square, so a Euclidean radius would reject a legal corner and accept nothing)
    in_box = np.abs(X_mm[:, :, :, :2] - ctr).max(axis=(1, 2, 3)) < IN_BOX_FRAC * half
    # rearing, per animal, in units of that animal's OWN body length -- fig5_upright's
    # definition. The neck, not the nose: a mouse sniffing along the floor extends its
    # nose upward without leaving the ground.
    up = X_mm[:, :, NECK, 2] / L[None, :]
    finite = np.isfinite(X_mm).all(axis=(1, 2, 3))
    rear = (up > REAR_FRAC).all(axis=1)
    ok = rear & (sep > MIN_SEP_BL) & (sep < NEAR_BL) & in_box & finite
    if not ok.any():
        raise SystemExit(
            f"no frame satisfies the mutual-upright frame rule on this session "
            f"({int((rear & finite).sum())} frames have both animals rearing at all, "
            f"{int((rear & finite & (sep > MIN_SEP_BL) & (sep < NEAR_BL)).sum())} of "
            f"them close together) -- see the docstring on choosing a session")
    idx = np.flatnonzero(ok)
    # the frame where BOTH are most clearly up: maximise the lower of the two heights
    k = int(idx[np.argmax(up[idx].min(axis=1))])
    return k, {"body_length_mm": Lm, "n_candidate_frames": int(ok.sum()),
               "n_both_rearing_frames": int((rear & finite).sum()),
               "n_near_rearing_frames":
                   int((rear & finite & (sep > MIN_SEP_BL) & (sep < NEAR_BL)).sum()),
               "sep_body_lengths": float(sep[k]),
               "neck_height_body_lengths": up[k].tolist(),
               "neck_height_mm": X_mm[k, :, NECK, 2].tolist(),
               "nose_height_mm": X_mm[k, :, NOSE, 2].tolist()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--session", default=DEFAULT_SESSION)
    ap.add_argument("--frame", type=int, default=None,
                    help="override the frame rule (diagnostics only)")
    ap.add_argument("--height-mode", choices=("cube", "movement"), default="cube",
                    help="drawn box height: a cube on the measured footprint "
                         "(default), or the animals' own vertical extent (the "
                         "original shallow-tray render)")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "fig1_bmimica_scene.json"))
    args = ap.parse_args()

    sd = os.path.join(BMIMICA, args.session)
    calib = glob.glob(os.path.join(sd, "calibration", "*_calibration.toml"))
    if not calib:
        raise SystemExit(f"{args.session} has no calibration TOML -- six of the 56 "
                         "BMimica sessions have an empty calibration/ directory")
    fp = glob.glob(os.path.join(sd, "*points3d*.h5"))[0]
    with h5py.File(fp) as h:
        X = h["tracks"][:] * 1000.0            # (F, A, N, 3) mm, P-frame
        fps = float(h["recording_frame_rate"][()])
        node_names = [n.decode() if isinstance(n, bytes) else str(n)
                      for n in h["node_names"][:]]
    if node_names != NODES:
        raise SystemExit(f"unexpected node order in {fp}: {node_names}")
    F, A = X.shape[0], X.shape[1]

    arena = fit_arena(X[::FIT_STRIDE], args.height_mode)
    print(f"arena: {arena['side_mm']:.1f} mm square x {arena['height_mm']:.1f} mm tall"
          f" ({arena['height_mode']}, {arena['height_over_movement']:.2f}x the "
          f"{arena['movement_height_mm']:.1f} mm movement extent)"
          f"  (x span {arena['x_span_mm']:.1f}, y span {arena['y_span_mm']:.1f}; "
          f"raw {arena['x_span_raw_mm']:.1f} x {arena['y_span_raw_mm']:.1f})"
          f"  centre ({arena['centre_xy_mm'][0]:.1f}, {arena['centre_xy_mm'][1]:.1f})"
          f"  floor z {arena['floor_z_mm']:.3f}")

    k, diag = pick_frame(X, arena)
    if args.frame is not None:
        k = args.frame
    print(f"frame {k} ({k / fps:.1f} s of {F / fps:.0f} s); "
          f"{diag['n_candidate_frames']} candidates of "
          f"{diag['n_both_rearing_frames']} both-rearing / "
          f"{diag['n_near_rearing_frames']} close-together frames, "
          f"separation {diag['sep_body_lengths']:.2f} body lengths, necks at "
          f"{diag['neck_height_body_lengths'][0]:.2f} / "
          f"{diag['neck_height_body_lengths'][1]:.2f} body lengths "
          f"({diag['neck_height_mm'][0]:.0f} / {diag['neck_height_mm'][1]:.0f} mm)")

    # ---- P-frame -> calibration frame, the Fig 2 / Fig 4 / Fig 5 recipe ----------
    cams_all = load_calibration(calib[0])
    serials = [s for s in SERIALS if s in cams_all]
    if len(serials) != len(cams_all):
        raise SystemExit(f"calibration lists {sorted(cams_all)}, SERIALS {SERIALS}")
    raw = {c: load_sleap_2d(glob.glob(os.path.join(sd, c, "*.analysis.h5"))[0])[:, :2]
           for c in serials}
    C = len(serials)
    Ps = np.stack([cams_all[c]["P"] for c in serials], 0)
    Fm = min(F, min(v.shape[0] for v in raw.values()))
    samp = np.arange(0, Fm, max(1, Fm // 4000))
    und = np.stack([undistort(raw[c][samp], cams_all[c]["K"], cams_all[c]["dist"])
                    for c in serials], 0)
    flat = und.reshape(C, -1, 2)
    Xc = triangulate_batch(flat, Ps, ~np.isnan(flat).any(-1)).reshape(len(samp), A, -1, 3)
    Xp = X / 1000.0                                       # metres, as ransac_align wants
    both = (~np.isnan(Xc).any(-1)) & (~np.isnan(Xp[samp]).any(-1))
    (s_, R_, t_), err_mm, inl = ransac_align(Xp[samp][both], Xc[both], thresh=8.0)
    inlier_frac, resid_mm = float(inl.mean()), float(np.median(err_mm[inl]))
    print(f"alignment: scale {s_:.5f} ({(1.0 / s_) * 1000.0:.3f} mm/unit)  "
          f"inliers {inlier_frac * 100:.1f}%  median residual {resid_mm:.2f} mm")
    if inlier_frac < 0.5:
        raise SystemExit("alignment inlier fraction below 50% -- the per-camera "
                         "track-order assumption does not hold; pick another session")

    def to_p(X_cal):
        """calibration frame -> P-frame mm (the inverse of the fitted alignment)."""
        return ((R_.T @ (np.atleast_2d(X_cal) - t_).T).T / s_) * 1000.0

    cameras = []
    for ci, c in enumerate(serials):
        cam = cams_all[c]
        R = cam["R"]                                  # world->cam, rows = right/down/fwd
        centre_cal = -R.T @ cam["t"]
        cameras.append({
            "name": c, "index": ci,
            "centre_mm": to_p(centre_cal)[0].tolist(),          # P-frame, mm
            # camera axes rotated into the P-frame -- same convention as
            # fig5_views.py, so the two figures place these cameras identically
            "right": (R_.T @ R[0]).tolist(),
            "down": (R_.T @ R[1]).tolist(),
            "forward": (R_.T @ R[2]).tolist(),
        })
    for cm in cameras:
        print(f"  cam {cm['name']}: centre "
              f"({cm['centre_mm'][0]:7.1f}, {cm['centre_mm'][1]:7.1f}, "
              f"{cm['centre_mm'][2]:7.1f}) mm   forward "
              f"({cm['forward'][0]:+.3f}, {cm['forward'][1]:+.3f}, {cm['forward'][2]:+.3f})")

    out = {
        "corpus": "BMimica", "session": args.session, "calibration": calib[0],
        "points3d": fp, "fps": fps, "n_frames": int(F), "n_animals": int(A),
        "nodes": NODES, "frame": k,
        "frame_rule": {"kind": "mutual_upright", "rear_frac": REAR_FRAC,
                       "sep_body_lengths": [MIN_SEP_BL, NEAR_BL],
                       "in_box_frac": IN_BOX_FRAC, **diag},
        "arena": arena,
        "pose_mm": X[k].tolist(),                    # (A, N, 3) P-frame mm, z = height
        "cameras": cameras,
        "alignment": {"scale": float(s_), "mm_per_unit": float((1.0 / s_) * 1000.0),
                      "inlier_frac": inlier_frac, "residual_mm": resid_mm,
                      "n_pairs": int(both.sum())},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
