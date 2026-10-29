"""anipose calibration.toml I/O, projection, DLT triangulation, rigid fits.

Same camera model as LUC3D / aniposelib / calibrat3: x_cam = R X + t (R from the
Rodrigues ``rotation``), OpenCV pinhole + ``distortions`` = [k1, k2, p1, p2, k3].
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Camera:
    name: str
    size: tuple[int, int]
    K: np.ndarray
    dist: np.ndarray
    rvec: np.ndarray
    tvec: np.ndarray

    @property
    def R(self) -> np.ndarray:
        return cv2.Rodrigues(np.asarray(self.rvec, np.float64).reshape(3, 1))[0]

    @property
    def center(self) -> np.ndarray:
        return -self.R.T @ np.asarray(self.tvec, np.float64)

    def project(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, np.float64).reshape(-1, 3)
        if not len(X):
            return np.zeros((0, 2))
        p, _ = cv2.projectPoints(X, np.asarray(self.rvec, np.float64), np.asarray(self.tvec, np.float64),
                                 self.K, self.dist)
        return p.reshape(-1, 2)

    def normalize(self, uv: np.ndarray) -> np.ndarray:
        uv = np.asarray(uv, np.float64).reshape(-1, 1, 2)
        if not len(uv):
            return np.zeros((0, 2))
        return cv2.undistortPoints(uv, self.K, self.dist).reshape(-1, 2)

    def depth(self, X: np.ndarray) -> np.ndarray:
        return (np.asarray(X).reshape(-1, 3) @ self.R.T + self.tvec)[:, 2]


@dataclass
class Calibration:
    cameras: list[Camera]
    meta: dict = field(default_factory=dict)

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.cameras]

    def by_name(self, name: str) -> Camera | None:
        return next((c for c in self.cameras if c.name == name), None)

    def subset(self, names: list[str]) -> "Calibration":
        return Calibration([self.by_name(n) for n in names], dict(self.meta))


def read_calibration(path: str | Path) -> Calibration:
    d = tomllib.loads(Path(path).read_text())
    cams = []
    for k in sorted((k for k in d if k.startswith("cam_")), key=lambda s: int(s[4:])):
        c = d[k]
        dist = np.zeros(5)
        dv = np.asarray(c.get("distortions", [0] * 5), np.float64).ravel()
        dist[:min(5, len(dv))] = dv[:5]
        cams.append(Camera(str(c.get("name", k)), tuple(int(v) for v in c["size"]),
                           np.asarray(c["matrix"], np.float64), dist,
                           np.asarray(c["rotation"], np.float64), np.asarray(c["translation"], np.float64)))
    return Calibration(cams, d.get("metadata", {}))


def write_calibration(cal: Calibration, path: str | Path, comment: str = "") -> None:
    def lst(v):
        return "[" + ", ".join(f"{float(x):.10g}" for x in np.ravel(v)) + "]"
    out = [f"# {line}" for line in comment.splitlines()] + ([""] if comment else [])
    for i, c in enumerate(cal.cameras):
        K = c.K
        out += [f"[cam_{i}]", f'name = "{c.name}"', f"size = [{int(c.size[0])}, {int(c.size[1])}]",
                f"matrix = [{lst(K[0])}, {lst(K[1])}, {lst(K[2])}]",
                f"distortions = {lst(c.dist[:5])}", f"rotation = {lst(c.rvec)}",
                f"translation = {lst(c.tvec)}", ""]
    out += ["[metadata]"]
    for k, v in cal.meta.items():
        out.append(f'{k} = "{v}"' if isinstance(v, str) else f"{k} = {v}")
    Path(path).write_text("\n".join(out) + "\n")


def triangulate(cal: Calibration, obs: list[np.ndarray | None]) -> np.ndarray:
    """DLT on undistorted normalized coordinates (as aniposelib / calibrat3).

    ``obs[c]`` is (n_points, 2) pixels with NaN where camera c did not see the point
    (or None). Returns (n_points, 3); NaN where fewer than two cameras saw it.
    """
    n = next(len(o) for o in obs if o is not None)
    A = np.zeros((n, 2 * len(cal.cameras), 4))
    seen = np.zeros(n, int)
    for ci, (cam, o) in enumerate(zip(cal.cameras, obs)):
        if o is None:
            continue
        ok = np.isfinite(o).all(1)
        if not ok.any():
            continue
        xy = np.full((n, 2), np.nan)
        xy[ok] = cam.normalize(o[ok])
        P = np.hstack([cam.R, np.asarray(cam.tvec, np.float64).reshape(3, 1)])
        r1 = xy[:, :1] * P[2] - P[0]
        r2 = xy[:, 1:] * P[2] - P[1]
        r1[~ok] = 0
        r2[~ok] = 0
        A[:, 2 * ci] = r1
        A[:, 2 * ci + 1] = r2
        seen += ok
    X = np.full((n, 3), np.nan)
    m = seen >= 2
    if m.any():
        _, _, vt = np.linalg.svd(A[m])
        h = vt[:, -1]
        X[m] = h[:, :3] / h[:, 3:]
    return X


def kabsch(P: np.ndarray, Q: np.ndarray, scale: bool = False):
    """R, t, s minimizing |s R P + t - Q| over rows."""
    mp, mq = P.mean(0), Q.mean(0)
    P0, Q0 = P - mp, Q - mq
    U, S, Vt = np.linalg.svd(P0.T @ Q0)
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T
    s = (S * np.diag(D)).sum() / (P0 ** 2).sum() if scale else 1.0
    t = mq - s * R @ mp
    return R, t, s


def rotation_angle_deg(Ra: np.ndarray, Rb: np.ndarray) -> float:
    c = (np.trace(Ra @ Rb.T) - 1) / 2
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))))
