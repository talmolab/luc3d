"""Python side of figs/lucid_geom.mjs: LUC3D v1.0.5 geometry for Python scripts.

Python in figs/ does not triangulate, undistort or reproject for LUC3D (LUC3D-JS plan
R2). These wrappers hand a batch to the app's own code and return its answer, plus the
stamp (lucid_root, lucid_commit, pose_dir, driver) the caller must record.

`cameras` is a list of {name, matrix, distortions, rvec, tvec, size}, the arguments of
LUC3D's `Camera` constructor, as fig2_solvers_export.py writes them.
"""
import json
import os
import subprocess
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.environ.get("NODE", "/root/vast/eric/node26_env/bin/node")


def _run(mode, cameras, arr):
    with tempfile.TemporaryDirectory() as td:
        fin, fout, freq = (os.path.join(td, n) for n in ("in.bin", "out.bin", "req.json"))
        np.ascontiguousarray(arr, dtype=np.float64).tofile(fin)
        with open(freq, "w") as f:
            json.dump({"mode": mode, "cameras": cameras, "in": fin, "out": fout}, f)
        subprocess.run([NODE, os.path.join(HERE, "lucid_geom.mjs"), freq], check=True,
                       env={**os.environ, "PATH": os.path.dirname(NODE) + ":" + os.environ.get("PATH", "")})
        out = np.fromfile(fout, dtype=np.float64)
        with open(fout + ".json") as f:
            stamp = json.load(f)
    return out, stamp


def triangulate(cameras, raw_uv):
    """raw_uv (C, M, 2) DISTORTED pixels, NaN = missing -> ((M, 3), stamp)."""
    C, M, _ = raw_uv.shape
    out, stamp = _run("triangulate", cameras, np.transpose(raw_uv, (1, 0, 2)))
    return out.reshape(M, 3), stamp


def project(cameras, X):
    """X (M, 3) calibration-frame points -> ((C, M, 2) distorted pixels, stamp)."""
    M = X.shape[0]
    out, stamp = _run("project", cameras, X)
    return out.reshape(len(cameras), M, 2), stamp
