"""Real annotated poses as a check: proofread 2D poses from several cameras of the
same session, grouped across cameras by track name (tracks must be named
consistently across cameras, as in the SLAP 2022-10-19 proofread files: global_0, ...).

For each calibration: triangulate every node seen by >= 2 cameras, then
- reprojection: pixel distance from each label to its triangulated point's projection;
- leave one camera out: triangulate from the other cameras only (>= 2) and project
  into the left-out camera. Label noise is in both; differences between calibrations
  of the same rig are what matters.

study.toml::

    [[poses]]
    id = "slap-10192022180019"
    rig = "slap"
    session = "2022-10-19"
    every = 5                     # use every 5th labelled frame
    [poses.views]
    back = "/path/back/...proofread.slp"
    mid = "/path/mid/...proofread.slp"

A held-out ruler: a rigid bar with two marks a measured distance apart, filmed still
at several places, the two marks labelled as a 2-node skeleton (first node = one end)
in every camera that sees them (tracks optional)::

    [[ruler]]
    id = "ruler-start"
    rig = "chronicrecord"
    session = "2026-11-03"
    length_mm = 300.0
    [ruler.views]
    Camera0 = "/path/Camera0/ruler.slp"
    Camera1 = "/path/Camera1/ruler.slp"
"""
from __future__ import annotations

import numpy as np

from camgeom import Calibration, triangulate


def load(views: dict[str, str], every: int = 5, max_frames: int = 3000, untracked: str | None = None):
    """-> (camera names, tracks, nodes, X2d) with X2d (n_cams, n_samples, n_nodes, 2),
    one sample per (frame, track); NaN = not labelled."""
    import sleap_io as sio
    per = {}
    nodes = None
    for cam, path in views.items():
        L = sio.load_slp(path)
        sk = L.skeletons[0]
        names = [n.name for n in sk.nodes]
        if nodes is None:
            nodes = names
        idx = [names.index(n) if n in names else None for n in nodes]
        for lf in L.labeled_frames:
            if lf.frame_idx % every:
                continue
            for inst in lf.instances:
                if inst.track is None and untracked is None:
                    continue
                tname = inst.track.name if inst.track is not None else untracked
                pts = inst.numpy()
                arr = np.full((len(nodes), 2), np.nan)
                for k, j in enumerate(idx):
                    if j is not None:
                        arr[k] = pts[j, :2]
                per.setdefault((lf.frame_idx, tname), {})[cam] = arr
    keys = sorted(k for k, v in per.items() if len(v) >= 2)
    if len(keys) > max_frames:
        keys = [keys[i] for i in np.linspace(0, len(keys) - 1, max_frames).astype(int)]
    cams = list(views)
    X = np.full((len(cams), len(keys), len(nodes), 2), np.nan)
    for s, k in enumerate(keys):
        for c, cam in enumerate(cams):
            if cam in per[k]:
                X[c, s] = per[k][cam]
    return cams, keys, nodes, X


def errors(cal: Calibration, cams: list[str], X: np.ndarray) -> dict:
    cal = cal.subset(cams)
    n_c, n_s, n_n, _ = X.shape
    flat = [X[c].reshape(-1, 2) for c in range(n_c)]
    P = triangulate(cal, flat)
    rep, loo = [], []
    for c, cam in enumerate(cal.cameras):
        lab = flat[c]
        m = np.isfinite(lab[:, 0]) & np.isfinite(P[:, 0])
        if m.any():
            rep.append(np.linalg.norm(cam.project(P[m]) - lab[m], axis=1))
        others = [o if j != c else np.full_like(o, np.nan) for j, o in enumerate(flat)]
        Q = triangulate(cal, others)
        m = np.isfinite(lab[:, 0]) & np.isfinite(Q[:, 0])
        if m.any():
            loo.append(np.linalg.norm(cam.project(Q[m]) - lab[m], axis=1))
    rep = np.concatenate(rep) if rep else np.zeros(0)
    loo = np.concatenate(loo) if loo else np.zeros(0)
    q = lambda v, p: float(np.percentile(v, p)) if len(v) else float("nan")  # noqa: E731
    return {"reprojection_median_px": q(rep, 50), "reprojection_p95_px": q(rep, 95),
            "leave_one_camera_out_median_px": q(loo, 50), "leave_one_camera_out_p95_px": q(loo, 95),
            "labels": int(len(rep))}


def ruler_errors(cal: Calibration, cams: list[str], X: np.ndarray, length_mm: float) -> dict:
    """A rigid bar of known length, its two ends labelled (nodes 0 and 1) in >= 2 cameras
    per frame: triangulated length vs the measured one."""
    cal = cal.subset(cams)
    a = triangulate(cal, [X[c, :, 0] for c in range(len(cams))])
    b = triangulate(cal, [X[c, :, 1] for c in range(len(cams))])
    d = np.linalg.norm(a - b, axis=1)
    d = d[np.isfinite(d)]
    if not len(d):
        return {"frames": 0}
    e = d - length_mm
    return {"frames": int(len(d)), "median_error_mm": float(np.median(e)),
            "median_abs_error_mm": float(np.median(np.abs(e))), "median_abs_error_pct": float(100 * np.median(np.abs(e)) / length_mm),
            "p95_abs_error_mm": float(np.percentile(np.abs(e), 95))}
