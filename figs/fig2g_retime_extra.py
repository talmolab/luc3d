#!/usr/bin/env python
"""Companion to fig2g_retime_all.py: Anipose's undistortion cost and RANSAC path (L304,
L306), timed in the same sitting, best of 5. Scopes as fig2_solvers_anipose.py:
undistortion = cam.undistort_points over all cameras on n = 200,000; RANSAC =
cg.triangulate_ransac on n = 5,000 (as deposited)."""
import json, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent; OUT = HERE / "out"
sys.path.insert(0, str(HERE)); import fig2_solvers_anipose as fsa
meta = json.loads((OUT / "fig4_input.json").read_text()); K, C = meta["keypoints"], meta["n_cameras"]
obs = np.memmap(OUT / meta["bin"], dtype="<f8", mode="r")[:K * C * 2].reshape(K, C, 2)
cg = fsa.build_groups(meta["calibrations"])[0]
def pts(n):
    p = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64); p[~np.isfinite(p)] = np.nan; return p
p200, p5 = pts(200_000), pts(5_000)
cg.triangulate_ransac(p5[:, :200], progress=False)   # numba warm-up
und, ran = [], []
for _ in range(5):
    t0 = time.perf_counter()
    for ci, cam in enumerate(cg.cameras): cam.undistort_points(np.copy(p200[ci]))
    und.append(1e6 * (time.perf_counter() - t0) / 200_000)
    t0 = time.perf_counter(); cg.triangulate_ransac(p5, progress=False); ran.append(1e6 * (time.perf_counter() - t0) / 5_000)
d = json.loads((OUT / "fig2g_retime_all.json").read_text())
d["anipose_undistort_runs"] = und; d["anipose_ransac_runs"] = ran
d["best_us_per_keypoint"]["anipose_undistort"] = min(und); d["best_us_per_keypoint"]["anipose_ransac"] = min(ran)
d["ransac_over_linear"] = min(ran) / d["best_us_per_keypoint"]["anipose_linear"]
(OUT / "fig2g_retime_all.json").write_text(json.dumps(d, indent=1))
print("undistort", [round(x, 3) for x in und], "ransac", [round(x) for x in ran], "ratio", round(d["ransac_over_linear"], 1))
