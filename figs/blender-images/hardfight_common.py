"""HardFight (20260605_133431, 8 cameras, 60 fps, 36,000 frames, 3 mice) data
access + OFFLINE 3D for the illustration figures (idswitch, hyp) -- Eric:
"use the hard fight dataset side views and top views for this example" /
"we should also use the hard fight dataset too [for the hyp sidetop figure]
so we can use the top and side views too, should be similar angles though if
possible."

Unlike the SLAP-2M sessions, HardFight ships NO proofread 3D and NO
alignment: only per-camera SLEAP predictions
(`_bugdata/20260605_133431-HardFight/<cam>/*_selective_unfiltered_preview.slp`,
per-VIEW tracklets, ~3 instances/frame) plus `calibration.toml` (same format
as SLAP-2M -- chen_common.Camera parses it unchanged) and the re-encoded
videos in `_bugdata/20260605_133431-HardFight_reencoded`. The skeleton is the
SAME 15-node mouse skeleton as SLAP-2M, so chen_common's NODE_NAMES /
MOUSE_EDGE_IDXS apply verbatim.

The 3D is LUC3D v1.0.5's (LUC3D-JS plan, 2026-10-20; Eric: "for these
visualizations we should be using luc3d triangulation and tracker").
`figs/hardfight_luc3d.py` runs LUC3D's tracker on every camera's detections and
triangulates each identity's views with LUC3D's DLT (Triangulate All's default),
writing `figs/out/hardfight_luc3d.npz`. This module only reads it:
  - `poses_calib`: one frame's (3, 15, 3) LUC3D poses, in LUC3D identity order
    (stable across frames: the tracker's identities, not a per-frame matching),
    plus each identity's per-view detections (the ones LUC3D grouped).
  - `project_pinhole`: LUC3D's reprojectPoint (undistorted pixels), through
    figs/lucid_geom.mjs.
  - `fit_alignment`: the calib-world -> aligned (floor z=0, +z up) transform for
    the renders, fitted to LUC3D's keypoint cloud since there is no
    alignment.toml: the pancake-shaped cloud's thin axis is up (sign chosen so
    the cameras sit above), z=0 at the 2nd percentile of heights (feet/bedding),
    x along the cloud's long axis. Scene geometry for a render, not a LUC3D
    number. The result is passed to chen_common.Alignment, so downstream code
    treats the two datasets identically.
No triangulation, association or reprojection happens in Python here.
"""
import glob
import json
import os
import sys

import h5py
import numpy as np
import toml

import chen_common as cc

if os.path.dirname(cc.HERE) not in sys.path:   # figs/, for lucid_geom
    sys.path.insert(0, os.path.dirname(cc.HERE))

HERE = cc.HERE
REPO = os.path.dirname(os.path.dirname(HERE))
SESSION_SLP = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight")
SESSION_VID = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight_reencoded")

CAMS = ["Camera0_mid", "Camera1_topB", "Camera2_topC", "Camera3_sideC",
        "Camera4_topR", "Camera5_topL", "Camera6_sideL", "Camera7_sideR"]

FPS = 60.0
N_NODES = 15
N_ANIMALS = 3

#: instance-score floor for using a detection at all. hardfight_luc3d.py fed LUC3D
#: exactly Slp2D.at()'s detections, so its slot indices index at(frame).
MIN_INSTANCE_SCORE = 0.5

LUC3D_NPZ = os.path.join(os.path.dirname(HERE), "out", "hardfight_luc3d.npz")
LUC3D_JSON = os.path.join(os.path.dirname(HERE), "out", "hardfight_luc3d.json")


def video_path(cam):
    return glob.glob(f"{SESSION_VID}/{cam}/*.mp4")[0]


def _lucid_camera(name):
    v = next(v for k, v in toml.load(os.path.join(SESSION_SLP, "calibration.toml")).items()
             if k.startswith("cam_") and v["name"] == name)
    return dict(name=name, matrix=v["matrix"], distortions=v["distortions"],
                rvec=v["rotation"], tvec=v["translation"], size=v["size"])


def project_pinhole(cam, P):
    """calib-world (mm) -> UNDISTORTED image px: the coordinates of a
    cv2.undistort-ed frame. The figure panes show undistorted photos, so their
    overlays are projected WITHOUT the distortion model -- HardFight's k1 is
    -0.36, strong enough that distorted-coordinate overlays land visibly off
    the animals (Eric: "the blue instance isnt even on the animal"). Computed
    by LUC3D v1.0.5's reprojectPoint (figs/lucid_geom.mjs), not in Python."""
    import lucid_geom
    P = np.asarray(P, float)
    uv, _ = lucid_geom.project_pinhole([_lucid_camera(cam.name)], P.reshape(-1, 3))
    return uv[0].reshape(P.shape[:-1] + (2,))


def pinhole_camera(cam):
    """A distortion-free copy of `cam` for the image-plane-quad machinery
    (hyp_fig_prep.prep_camera): with dist = 0 its exact_plane_point/quad_point
    treat their pixel inputs as UNDISTORTED image coordinates, exactly
    matching the undistorted pane texture and project_pinhole overlays."""
    import copy
    c2 = copy.copy(cam)
    c2.dist = np.zeros_like(np.asarray(cam.dist, float))
    return c2


def load_calibration_all():
    cal = toml.load(os.path.join(SESSION_SLP, "calibration.toml"))
    cams = {}
    for key, v in cal.items():
        if key.startswith("cam_"):
            cams[v["name"]] = cc.Camera(v)
    return cams


class Slp2D:
    """One camera's predictions, loaded once into numpy for fast per-frame
    lookup. `at(frame)` -> list of dicts {track, score, pts (15,2) with NaN
    for invisible}."""

    def __init__(self, cam):
        p = glob.glob(f"{SESSION_SLP}/{cam}/*.slp")[0]
        with h5py.File(p) as f:
            fr = f["frames"][:]
            self.inst = f["instances"][:]
            pp = f["pred_points"][:]
            meta = json.loads(f["metadata"].attrs["json"])
        assert [n["name"] for n in meta["nodes"]] == cc.NODE_NAMES
        self.xy = np.stack([pp["x"], pp["y"]], axis=1).astype(float)
        self.xy[~pp["visible"].astype(bool)] = np.nan
        order = np.argsort(fr["frame_idx"])
        self.frame_rows = fr[order]
        self.by_idx = {int(r["frame_idx"]): i for i, r in enumerate(self.frame_rows)}

    def at(self, frame):
        i = self.by_idx.get(int(frame))
        if i is None:
            return []
        r = self.frame_rows[i]
        out = []
        for k in range(int(r["instance_id_start"]), int(r["instance_id_end"])):
            ins = self.inst[k]
            if ins["score"] < MIN_INSTANCE_SCORE:
                continue
            pts = self.xy[int(ins["point_id_start"]):int(ins["point_id_end"])]
            if pts.shape[0] != N_NODES or np.isnan(pts).all():
                continue
            out.append({"track": int(ins["track"]), "score": float(ins["score"]),
                        "pts": pts})
        return out


def load_all_slp():
    return {cam: Slp2D(cam) for cam in CAMS}


_LUC3D = None


def luc3d():
    """hardfight_luc3d.npz: X (F, 3, 15, 3) calib-world mm, NaN where unseen;
    slots (F, 3, 8) each identity's Slp2D.at() index per camera, -1 if none."""
    global _LUC3D
    if _LUC3D is None:
        if not os.path.exists(LUC3D_NPZ):
            raise SystemExit(f"missing {LUC3D_NPZ}: run POSE_DIR=<v1.0.5>/pose figs/hardfight_luc3d.py")
        stamp = json.load(open(LUC3D_JSON))
        if stamp.get("lucid_commit") != "2dc001fe527c4dbaad17fa171da132cfdfe010e6":
            raise SystemExit(f"{LUC3D_JSON} is not LUC3D v1.0.5: {stamp.get('lucid_commit')}")
        z = np.load(LUC3D_NPZ)
        _LUC3D = (z["X"], z["slots"], stamp)
    return _LUC3D


def poses_calib(slp, cams, frame):
    """(3, 15, 3) calib-world LUC3D poses at `frame` (NaN where unseen), in
    LUC3D identity order (the tracker's, stable across frames), plus each
    identity's per-view detections as LUC3D grouped them: a list of dicts
    cam_name -> instance dict. `cams` is unused (kept for the callers)."""
    X, slots, _ = luc3d()
    animals = []
    for a in range(N_ANIMALS):
        an = {}
        for ci, cam in enumerate(CAMS):
            s = int(slots[frame, a, ci])
            if s >= 0:
                an[cam] = slp[cam].at(frame)[s]
        animals.append(an)
    return X[frame].copy(), animals


#: FIG_TAG=b (a figure series) gets its own cache, so a series never refits the main one.
_TAG = os.environ.get("FIG_TAG", "")
ALIGNMENT_CACHE = os.path.join(HERE, "renders", f"hardfight_alignment{'_' + _TAG if _TAG else ''}.json")


def load_alignment(slp=None, cams=None):
    """The fitted alignment, cached at ALIGNMENT_CACHE so every figure script
    (and re-run) uses the exact same transform. The cache records the LUC3D
    deposit it was fitted to and is refitted when that is missing or differs."""
    stamp = luc3d()[2]
    key = {k: stamp.get(k) for k in ("lucid_commit", "finite_keypoints")}
    if os.path.exists(ALIGNMENT_CACHE):
        d = json.load(open(ALIGNMENT_CACHE))
        if d.get("fitted_to") == key:
            return cc.Alignment(d)
    ali = fit_alignment(slp or load_all_slp(), cams or load_calibration_all())
    os.makedirs(os.path.dirname(ALIGNMENT_CACHE), exist_ok=True)
    with open(ALIGNMENT_CACHE, "w") as f:
        json.dump({"rotation": ali.Ra.tolist(), "translation": ali.ta.tolist(),
                   "fitted_to": key, "source": "figs/out/hardfight_luc3d.npz (LUC3D v1.0.5)"},
                  f, indent=2)
    return ali


def fit_alignment(slp, cams, sample_step=200, seed_frames=None):
    """calib-world -> aligned (floor z=0, +z up, x = cage long axis) fit to
    LUC3D's triangulated keypoints (HardFight has no alignment.toml), the same
    every-200th-frame sample as before. Returns a chen_common.Alignment."""
    frames = list(seed_frames if seed_frames is not None else range(0, 36000, sample_step))
    P = luc3d()[0][frames].reshape(-1, 3)
    P = P[~np.isnan(P).any(1)]
    c = P.mean(0)
    _, _, Vt = np.linalg.svd(P - c, full_matrices=False)
    up = Vt[2]
    cam_mean = np.mean([cam.C for cam in cams.values()], axis=0)
    if np.dot(cam_mean - c, up) < 0:
        up = -up
    x_axis = Vt[0] - np.dot(Vt[0], up) * up
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(up, x_axis)
    Ra = np.stack([x_axis, y_axis, up])
    heights = (P - c) @ up
    floor_h = np.percentile(heights, 2.0)
    ta = c + floor_h * up
    return cc.Alignment({"rotation": Ra.tolist(), "translation": ta.tolist()})
