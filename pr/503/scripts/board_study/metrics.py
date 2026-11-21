"""What the study measures. Everything works from a calibration.toml plus cached
detections, whichever engine made the calibration.

- ``reprojection``: triangulate every corner seen by >= 2 cameras, project it back,
  pixel distance to the detected corner (the number calibration tools report).
- ``board_geometry``: the board as a known-size object. Triangulated corners vs the
  printed pattern: lengths between far-apart corners (a "ruler"), one-square spacing,
  and the rigid-fit residual. Scored on recordings the calibration did not use.
- ``repeatability``: spread of intrinsics, camera positions/rotations and of 3D
  points across calibrations of the same, untouched rig.
- ``coverage``: where the board was found (distance, tilt, square size in pixels)
  and where it was in view of a camera but not found there.
"""
from __future__ import annotations

import cv2
import numpy as np

from boards import Board
from camgeom import Calibration, kabsch, rotation_angle_deg, triangulate
from detect import Detections

MIN_CORNERS = 6


def stack(dets: list[Detections], board: Board, frames: np.ndarray | None = None,
          min_corners: int = MIN_CORNERS) -> tuple[np.ndarray, np.ndarray]:
    """(frames, obs) with obs (n_cams, n_frames, n_corners, 2), NaN = not seen; frames
    kept where >= 2 cameras saw >= min_corners corners."""
    if frames is None:
        frames = np.unique(np.concatenate([d.frames_with(min_corners) for d in dets]))
    nc = board.n_corners
    obs = np.full((len(dets), len(frames), nc, 2), np.nan, np.float32)
    for ci, d in enumerate(dets):
        for fi, f in enumerate(frames):
            r = d.at(f)
            if r is not None and len(r[0]) >= min_corners:
                obs[ci, fi, r[0]] = r[1]
    keep = (np.isfinite(obs[..., 0]).sum(2) >= min_corners).sum(0) >= 2
    return frames[keep], obs[:, keep]


def triangulate_frames(cal: Calibration, obs: np.ndarray, chunk: int = 40) -> np.ndarray:
    nf, nc = obs.shape[1], obs.shape[2]
    X = np.full((nf, nc, 3), np.nan)
    for a in range(0, nf, chunk):
        b = min(nf, a + chunk)
        o = [obs[c, a:b].reshape(-1, 2).astype(np.float64) for c in range(obs.shape[0])]
        X[a:b] = triangulate(cal, o).reshape(b - a, nc, 3)
    return X


def _q(v, q):
    return float(np.percentile(v, q)) if len(v) else float("nan")


def reprojection(cal: Calibration, obs: np.ndarray, X: np.ndarray | None = None) -> dict:
    if X is None:
        X = triangulate_frames(cal, obs)
    errs, per = [], {}
    for ci, cam in enumerate(cal.cameras):
        m = np.isfinite(obs[ci, ..., 0]) & np.isfinite(X[..., 0])
        if not m.any():
            per[cam.name] = float("nan")
            continue
        e = np.linalg.norm(cam.project(X[m]) - obs[ci][m], axis=1)
        per[cam.name] = float(np.median(e))
        errs.append(e)
    e = np.concatenate(errs) if errs else np.zeros(0)
    return {"median_px": _q(e, 50), "mean_px": float(e.mean()) if len(e) else float("nan"),
            "p95_px": _q(e, 95), "n_obs": int(len(e)), "per_camera_median_px": per}


def board_geometry(X: np.ndarray, board: Board, min_points: int = 8, long_frac: float = 0.5) -> dict:
    """X (n_frames, n_corners, 3) triangulated corners of a known board."""
    ideal = board.corner_points()
    pairs = board.neighbour_pairs()
    diag = float(np.hypot(*(np.array(board.pattern_mm) - 2 * board.square_length)))
    spacing, fit_rms, scale, long_rel, long_abs, centers = [], [], [], [], [], []
    for x in X:
        v = np.isfinite(x[:, 0])
        if v.sum() < min_points:
            continue
        pv = v[pairs[:, 0]] & v[pairs[:, 1]]
        d = np.linalg.norm(x[pairs[pv, 0]] - x[pairs[pv, 1]], axis=1)
        spacing.append(d - board.square_length)
        R, t, _ = kabsch(ideal[v], x[v])
        fit_rms.append(float(np.sqrt(((ideal[v] @ R.T + t - x[v]) ** 2).sum(1).mean())))
        _, _, s = kabsch(ideal[v], x[v], scale=True)
        scale.append(s - 1)
        # "Rulers": every pair of seen corners at least long_frac of the board diagonal apart.
        idx = np.where(v)[0]
        if len(idx) > 60:
            idx = idx[np.linspace(0, len(idx) - 1, 60).astype(int)]
        a, b = np.triu_indices(len(idx), 1)
        true = np.linalg.norm(ideal[idx[a]] - ideal[idx[b]], axis=1)
        far = true >= long_frac * diag
        if far.any():
            meas = np.linalg.norm(x[idx[a[far]]] - x[idx[b[far]]], axis=1)
            long_rel.append(np.median(np.abs(meas - true[far]) / true[far]))
            long_abs.append(np.median(np.abs(meas - true[far])))
        centers.append(np.nanmean(x[v], 0))
    sp = np.concatenate(spacing) if spacing else np.zeros(0)
    return {"frames": len(fit_rms),
            "long_length_err_pct": 100 * _q(np.asarray(long_rel), 50),
            "long_length_err_p95_pct": 100 * _q(np.asarray(long_rel), 95),
            "long_length_err_mm": _q(np.asarray(long_abs), 50),
            "spacing_mae_mm": _q(np.abs(sp), 50), "spacing_p95_mm": _q(np.abs(sp), 95),
            "scale_bias_pct": 100 * float(np.median(scale)) if scale else float("nan"),
            "fit_rms_mm": _q(np.asarray(fit_rms), 50), "fit_rms_p95_mm": _q(np.asarray(fit_rms), 95)}


def board_poses(X: np.ndarray, board: Board, min_points: int = 8):
    """Rigid board pose per frame from triangulated corners: list of (fi, R, t)."""
    ideal = board.corner_points()
    out = []
    for fi, x in enumerate(X):
        v = np.isfinite(x[:, 0])
        if v.sum() >= min_points:
            R, t, _ = kabsch(ideal[v], x[v])
            out.append((fi, R, t))
    return out


def coverage(cal: Calibration, dets: list[Detections], board: Board, obs: np.ndarray, frames: np.ndarray,
             X: np.ndarray | None = None) -> dict:
    """Per camera: detection rate, and for every frame where the board's pose is known
    from the other cameras and it is fully inside this camera's image facing it, the
    board's square size in pixels, tilt and distance, and whether it was found."""
    if X is None:
        X = triangulate_frames(cal, obs)
    ideal = board.corner_points()
    cpts = ideal.mean(0)
    rows = []  # camera, square_px, tilt_deg, distance_mm, found
    poses = board_poses(X, board)
    for ci, cam in enumerate(cal.cameras):
        W, H = cam.size
        Rc, tc = cam.R, np.asarray(cam.tvec, np.float64)
        f = 0.5 * (cam.K[0, 0] + cam.K[1, 1])
        for fi, R, t in poses:
            others = [cj for cj in range(len(cal.cameras)) if cj != ci and np.isfinite(obs[cj, fi, :, 0]).sum() >= MIN_CORNERS]
            if len(others) < 2 and np.isfinite(obs[ci, fi, :, 0]).sum() >= MIN_CORNERS:
                continue  # pose would rest on this camera's own detection
            P = ideal @ R.T + t
            Pc = P @ Rc.T + tc
            if (Pc[:, 2] <= 0).any():
                continue
            uv = cam.project(P)
            inside = (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
            if inside.mean() < 0.95:
                continue
            center = R @ cpts + t
            ray = center - cam.center
            dist = float(np.linalg.norm(ray))
            normal = R[:, 2]
            tilt = float(np.degrees(np.arccos(abs(normal @ ray) / dist)))
            sq_px = f * board.square_length / float((Rc @ center + tc)[2])
            found = np.isfinite(obs[ci, fi, :, 0]).sum() >= MIN_CORNERS or (dets[ci].at(frames[fi]) is not None and len(dets[ci].at(frames[fi])[0]) >= MIN_CORNERS)
            rows.append((ci, sq_px, tilt, dist, bool(found)))
    rows = np.array(rows, dtype=float).reshape(-1, 5)
    out = {"per_camera": {}, "rows": rows}
    for ci, (cam, d) in enumerate(zip(cal.cameras, dets)):
        r = rows[rows[:, 0] == ci]
        hit = r[r[:, 4] == 1]
        out["per_camera"][cam.name] = {
            "sampled_frames": int(len(d.frames)),
            "frames_found": int((d.count >= MIN_CORNERS).sum()),
            "found_pct": 100 * float((d.count >= MIN_CORNERS).mean()) if len(d.frames) else float("nan"),
            "corners_per_find": float(np.median(d.count[d.count >= MIN_CORNERS])) if (d.count >= MIN_CORNERS).any() else float("nan"),
            "in_view_found_pct": 100 * float(r[:, 4].mean()) if len(r) else float("nan"),
            "in_view_frames": int(len(r)),
            "min_square_px_found": _q(hit[:, 1], 5), "max_tilt_found_deg": _q(hit[:, 2], 95),
            "max_distance_found_mm": _q(hit[:, 3], 95),
            "brightness": float(np.median(d.brightness)) if len(d.brightness) else float("nan"),
        }
    return out


def detection_curve(rows: np.ndarray, col: int, edges: np.ndarray) -> list[tuple[float, float, int]]:
    """Fraction found per bin of rows[:, col] (1 = square px, 2 = tilt, 3 = distance)."""
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (rows[:, col] >= a) & (rows[:, col] < b)
        out.append((0.5 * (a + b), float(rows[m, 4].mean()) if m.sum() >= 5 else float("nan"), int(m.sum())))
    return out


def procrustes_cameras(cals: list[Calibration], iters: int = 5):
    """Align every calibration's cameras to their consensus (rigid, no scale), by
    camera centres. Returns aligned centres (k, n, 3) and rotations (k, n, 3, 3)."""
    C = np.array([[c.center for c in cal.cameras] for cal in cals])
    Rs = np.array([[c.R for c in cal.cameras] for cal in cals])
    ref = C[0].copy()
    for _ in range(iters):
        out_c, out_r = [], []
        for k in range(len(cals)):
            R, t, _ = kabsch(C[k], ref)
            out_c.append(C[k] @ R.T + t)
            out_r.append(Rs[k] @ R.T)  # world->cam rotations, world rotated by R
        out_c, out_r = np.array(out_c), np.array(out_r)
        ref = out_c.mean(0)
    return out_c, out_r


def repeatability(cals: list[Calibration], X_test: list[np.ndarray] | None = None) -> dict:
    """Spread across calibrations of the same rig with the same camera names."""
    n = len(cals)
    names = cals[0].names
    intr = {}
    for key, get in {"fx": lambda c: c.K[0, 0], "fy": lambda c: c.K[1, 1], "cx": lambda c: c.K[0, 2],
                     "cy": lambda c: c.K[1, 2], "k1": lambda c: c.dist[0], "k2": lambda c: c.dist[1]}.items():
        v = np.array([[get(cal.by_name(nm)) for nm in names] for cal in cals])
        intr[key] = v.std(0, ddof=1) if n > 1 else np.zeros(len(names))
    fx = np.array([[cal.by_name(nm).K[0, 0] for nm in names] for cal in cals])
    out = {"n": n, "fx_sd_pct": float(np.median(100 * intr["fx"] / fx.mean(0))),
           "cx_sd_px": float(np.median(intr["cx"])), "cy_sd_px": float(np.median(intr["cy"])),
           "k1_sd": float(np.median(intr["k1"])), "k2_sd": float(np.median(intr["k2"]))}
    if n < 2:
        return out
    if len(names) >= 3:
        Cc, Rr = procrustes_cameras(cals)
        pos = np.linalg.norm(Cc - Cc.mean(0), axis=2)          # (k, n)
        rot = np.array([[rotation_angle_deg(Rr[k, j], Rr[0, j]) for j in range(len(names))] for k in range(n)])
        out["camera_pos_sd_mm"] = float(np.median(np.sqrt((pos ** 2).sum(0) / (n - 1))))
        out["camera_pos_sd_max_mm"] = float(np.sqrt((pos ** 2).sum(0) / (n - 1)).max())
        out["camera_rot_sd_deg"] = float(np.median(np.sqrt((rot[1:] ** 2).mean(0))))
    C = np.array([[c.center for c in cal.cameras] for cal in cals])
    i, j = np.triu_indices(len(names), 1)
    dists = np.linalg.norm(C[:, i] - C[:, j], axis=2)
    out["pair_distance_sd_mm"] = float(np.median(dists.std(0, ddof=1)))
    if X_test:
        # The same held-out corners triangulated with every calibration; each point
        # cloud aligned to the first (rigid), spread of each point across calibrations.
        P = np.array([x.reshape(-1, 3) for x in X_test])
        ok = np.isfinite(P[..., 0]).all(0)
        P = P[:, ok]
        if len(P[0]) > 20000:
            P = P[:, np.linspace(0, len(P[0]) - 1, 20000).astype(int)]
        if len(P[0]) >= 10:
            ref = P[0]
            al = []
            for k in range(n):
                R, t, _ = kabsch(P[k], ref)
                al.append(P[k] @ R.T + t)
            al = np.array(al)
            spread = np.sqrt(((al - al.mean(0)) ** 2).sum(2).sum(0) / (n - 1))
            out["points3d_sd_mm"] = float(np.median(spread))
            out["points3d_sd_p95_mm"] = float(np.percentile(spread, 95))
    return out


def board_pose_in_camera(cam, ids, xy, board: Board):
    """solvePnP of one detection: (distance mm, tilt deg) in that camera."""
    obj = board.corner_points()[ids]
    ok, rvec, tvec = cv2.solvePnP(obj, xy.astype(np.float64), cam.K, cam.dist)
    if not ok:
        return np.nan, np.nan
    R = cv2.Rodrigues(rvec)[0]
    c = R @ board.corner_points().mean(0) + tvec.ravel()
    return float(np.linalg.norm(c)), float(np.degrees(np.arccos(abs(R[:, 2] @ c) / np.linalg.norm(c))))
