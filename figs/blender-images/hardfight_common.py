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

So this module builds the 3D itself, for the handful of frames a figure
needs:
  - `associate_frame`: cross-view identity at one frame -- pick the reference
    view with the most instances, then greedily match every other view's
    instances to the reference by two-view-triangulation reprojection error.
  - `triangulate`: multi-view DLT on undistorted normalized rays, with
    iterative worst-view rejection (a view is dropped while its reprojection
    error exceeds REPROJ_DROP_PX and >= 2 views remain).
  - `fit_alignment`: the calib-world -> aligned (floor z=0, +z up) transform,
    fitted from the data itself since there is no alignment.toml: triangulate
    a sample of frames, take the pancake-shaped keypoint cloud's thin axis as
    up (sign chosen so the cameras sit above), put z=0 at the 2nd percentile
    of heights (feet/bedding), and align x with the cloud's long axis. The
    result is passed to chen_common.Alignment, so downstream code treats the
    two datasets identically.

Everything is validated by `_diag_hardfight_3d.py`-style checks before use:
triangulated body sizes come out at real mouse scale and reprojection errors
at a few px (see the numbers recorded in the idswitch_common.py comments).
"""
import glob
import json
import os

import h5py
import numpy as np
import toml

import chen_common as cc

HERE = cc.HERE
REPO = os.path.dirname(os.path.dirname(HERE))
SESSION_SLP = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight")
SESSION_VID = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight_reencoded")

CAMS = ["Camera0_mid", "Camera1_topB", "Camera2_topC", "Camera3_sideC",
        "Camera4_topR", "Camera5_topL", "Camera6_sideL", "Camera7_sideR"]

FPS = 60.0
N_NODES = 15
N_ANIMALS = 3

#: instance-score floor for using a detection at all, and per-view
#: reprojection error (px, median over visible nodes) above which a view is
#: dropped from a keypoint's triangulation / an association is refused.
MIN_INSTANCE_SCORE = 0.5
ASSOC_MAX_PX = 25.0
REPROJ_DROP_PX = 12.0


def video_path(cam):
    return glob.glob(f"{SESSION_VID}/{cam}/*.mp4")[0]


def project_pinhole(cam, P):
    """calib-world (mm) -> UNDISTORTED image px: the coordinates of a
    cv2.undistort-ed frame (newCameraMatrix defaults to K). The figure panes
    show undistorted photos, so their overlays must be projected WITHOUT the
    distortion model -- HardFight's k1 is -0.36, strong enough that
    distorted-coordinate overlays land visibly off the animals (Eric: "the
    blue instance isnt even on the animal"). chen_common.project (distorted)
    is only for comparing against the raw detections."""
    Pc = (cam.R @ np.asarray(P, float)[..., None])[..., 0] + cam.t
    xy = Pc[..., :2] / Pc[..., 2:3]
    return np.stack([cam.K[0, 0] * xy[..., 0] + cam.K[0, 2],
                     cam.K[1, 1] * xy[..., 1] + cam.K[1, 2]], axis=-1)


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


def _normalized(cam, pts):
    """(N,2) px -> (N,2) undistorted normalized coords (NaN passthrough)."""
    out = np.full_like(pts, np.nan, dtype=float)
    for i, p in enumerate(pts):
        if not np.isnan(p).any():
            out[i] = cc.undistort_px(p, cam.K, cam.dist)
    return out


def triangulate_point(cams_used, xns):
    """DLT from >=2 views: cams_used list of cc.Camera, xns list of (xn, yn)
    normalized coords. Returns (3,) calib-world point."""
    A = []
    for cam, (xn, yn) in zip(cams_used, xns):
        P = np.hstack([cam.R, cam.t[:, None]])
        A.append(xn * P[2] - P[0])
        A.append(yn * P[2] - P[1])
    A = np.array(A)
    _, _, Vt = np.linalg.svd(A)
    X = Vt[-1]
    return X[:3] / X[3]


def triangulate(views):
    """views: list of (cc.Camera, (15,2) px). Returns (15,3) calib-world with
    NaN where <2 views saw the node, using iterative worst-view rejection."""
    cams = [v[0] for v in views]
    norm = [_normalized(c, p) for c, p in views]
    px = [p for _, p in views]
    X = np.full((N_NODES, 3), np.nan)
    for n in range(N_NODES):
        use = [i for i in range(len(cams)) if not np.isnan(norm[i][n]).any()]
        while len(use) >= 2:
            Xn = triangulate_point([cams[i] for i in use], [norm[i][n] for i in use])
            errs = np.array([np.linalg.norm(cams[i].project(Xn) - px[i][n]) for i in use])
            if errs.max() <= REPROJ_DROP_PX or len(use) == 2:
                if errs.max() <= REPROJ_DROP_PX:
                    X[n] = Xn
                break
            use.pop(int(errs.argmax()))
    return X


def _pair_error(cam_a, inst_a, cam_b, inst_b):
    """Median cross-reprojection error (px) of two-view triangulation over the
    nodes both instances see -- the association cost."""
    common = ~(np.isnan(inst_a["pts"]).any(1) | np.isnan(inst_b["pts"]).any(1))
    idx = np.where(common)[0]
    if len(idx) < 4:
        return np.inf
    na = _normalized(cam_a, inst_a["pts"])
    nb = _normalized(cam_b, inst_b["pts"])
    errs = []
    for n in idx:
        Xn = triangulate_point([cam_a, cam_b], [na[n], nb[n]])
        ea = np.linalg.norm(cam_a.project(Xn) - inst_a["pts"][n])
        eb = np.linalg.norm(cam_b.project(Xn) - inst_b["pts"][n])
        errs.append(max(ea, eb))
    return float(np.median(errs))


def associate_frame(slp, cams, frame):
    """Cross-view identity at one frame. Returns a list of animals, each a
    dict cam_name -> instance dict (subset of views). Reference view: the one
    with the most (score-weighted) instances; every other view's instances
    are greedily matched to reference instances by _pair_error, refused above
    ASSOC_MAX_PX."""
    per_view = {cam: slp[cam].at(frame) for cam in CAMS}
    # prefer a reference view seeing exactly N_ANIMALS (a 4th "instance" is a
    # duplicate/ghost detection that would fabricate a 4th animal), then most
    # instances, then score.
    ref = max(CAMS, key=lambda c: (len(per_view[c]) == N_ANIMALS,
                                   len(per_view[c]),
                                   sum(i["score"] for i in per_view[c])))
    animals = [{ref: inst} for inst in per_view[ref]]
    for cam in CAMS:
        if cam == ref:
            continue
        cost = np.full((len(animals), len(per_view[cam])), np.inf)
        for i, an in enumerate(animals):
            for j, inst in enumerate(per_view[cam]):
                cost[i, j] = _pair_error(cams[ref], an[ref], cams[cam], inst)
        while np.isfinite(cost).any() and cost.min() < ASSOC_MAX_PX:
            i, j = np.unravel_index(np.argmin(cost), cost.shape)
            animals[i][cam] = per_view[cam][j]
            cost[i, :] = np.inf
            cost[:, j] = np.inf
    return animals


def poses_calib(slp, cams, frame):
    """(n_animals, 15, 3) calib-world triangulated poses at `frame` (NaN
    rows where unseen), plus each animal's per-view instances (for 2D
    overlays). Animals in reference-view instance order -- NOT temporally
    stable; callers link identities across frames themselves."""
    animals = associate_frame(slp, cams, frame)
    X = []
    for an in animals:
        views = [(cams[c], inst["pts"]) for c, inst in an.items()]
        X.append(triangulate(views) if len(views) >= 2 else np.full((N_NODES, 3), np.nan))
    return np.array(X), animals


ALIGNMENT_CACHE = os.path.join(HERE, "renders", "hardfight_alignment.json")


def load_alignment(slp=None, cams=None):
    """The fitted alignment, cached at ALIGNMENT_CACHE so every figure script
    (and re-run) uses the exact same transform. First call fits it (~2 min)."""
    if os.path.exists(ALIGNMENT_CACHE):
        return cc.Alignment(json.load(open(ALIGNMENT_CACHE)))
    ali = fit_alignment(slp or load_all_slp(), cams or load_calibration_all())
    os.makedirs(os.path.dirname(ALIGNMENT_CACHE), exist_ok=True)
    with open(ALIGNMENT_CACHE, "w") as f:
        json.dump({"rotation": ali.Ra.tolist(), "translation": ali.ta.tolist()}, f, indent=2)
    return ali


def fit_alignment(slp, cams, sample_step=200, seed_frames=None):
    """calib-world -> aligned (floor z=0, +z up, x = cage long axis) fit from
    the triangulated data itself (HardFight has no alignment.toml). Returns a
    chen_common.Alignment."""
    frames = seed_frames if seed_frames is not None else range(0, 36000, sample_step)
    pts = []
    for f in frames:
        X, _ = poses_calib(slp, cams, f)
        pts.append(X.reshape(-1, 3))
    P = np.concatenate(pts)
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
