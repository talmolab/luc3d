#!/usr/bin/env python
"""Companion to fig2g_retime_all.py: Anipose's undistortion cost and RANSAC path (L304,
L306), timed in the same sitting, best of 5. Scopes as fig2_solvers_anipose.py:
undistortion = cam.undistort_points over all cameras on n = 200,000; RANSAC =
cg.triangulate_ransac on n = 5,000 (as deposited)."""
import json, os, sys, time
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent; OUT = HERE / "out"
# FIG2_SUFFIX=<v> (md56, 2026-10-14): read fig4_input_<v> and update fig2g_retime_all_<v>.
_SFX = ("_" + os.environ["FIG2_SUFFIX"]) if os.environ.get("FIG2_SUFFIX") else ""
sys.path.insert(0, str(HERE)); import fig2_solvers_anipose as fsa
meta = json.loads((OUT / f"fig4_input{_SFX}.json").read_text()); K, C = meta["keypoints"], meta["n_cameras"]
obs = np.memmap(OUT / meta["bin"], dtype="<f8", mode="r")[:K * C * 2].reshape(K, C, 2)
cg = fsa.build_groups(meta["calibrations"])[0]
def pts(n):
    p = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64); p[~np.isfinite(p)] = np.nan; return p
N_UND = int(os.environ["FIG2G_FRAMES"]) * 15 if os.environ.get("FIG2G_FRAMES") else 200_000   # same keypoints as fig2g_retime_all
SAME_N = bool(os.environ.get("FIG2G_FRAMES"))
p200, p5 = pts(N_UND), pts(5_000)
cg.triangulate_ransac(p5[:, :200], progress=False)   # numba warm-up
und, ran = [], []
for _ in range(5):
    t0 = time.perf_counter()
    for ci, cam in enumerate(cg.cameras): cam.undistort_points(np.copy(p200[ci]))
    und.append(1e6 * (time.perf_counter() - t0) / N_UND)
    # J16b (2026-10-20): FIG2G_PASSES-1 more back-to-back passes (one pass is ~0.08 s), every
    # one recorded, so the median is not one short window's luck. Unset = unchanged.
    for _p in range(int(os.environ.get('FIG2G_PASSES', 1)) - 1):
        t0 = time.perf_counter()
        for ci, cam in enumerate(cg.cameras): cam.undistort_points(np.copy(p200[ci]))
        und.append(1e6 * (time.perf_counter() - t0) / N_UND)
    if not SAME_N:
        t0 = time.perf_counter(); cg.triangulate_ransac(p5, progress=False); ran.append(1e6 * (time.perf_counter() - t0) / 5_000)
#: FIG2G_FRAMES set (2026-10-15, C4): RANSAC on the SAME keypoints as every other bar, on the
#: pre-undistorted points with undistort=False (undistortion outside the timer, as for linear).
#: 3 rounds, best kept (one round is ~7 min at ~2.2 ms/keypoint).
if SAME_N:
    und_pts = np.empty_like(p200)
    for ci, cam in enumerate(cg.cameras): und_pts[ci] = cam.undistort_points(np.copy(p200[ci]))
    cg.triangulate_ransac(und_pts[:, :200], undistort=False, progress=False)   # numba warm-up
    for _ in range(3):
        t0 = time.perf_counter(); cg.triangulate_ransac(und_pts, undistort=False, progress=False)
        ran.append(1e6 * (time.perf_counter() - t0) / N_UND)
d = json.loads((OUT / f"fig2g_retime_all{_SFX}.json").read_text())
d["n_undistort"] = N_UND; d["n_ransac"] = N_UND if SAME_N else 5_000; d["ransac_scope"] = "pre-undistorted, undistort=False, same keypoints as linear" if SAME_N else "5,000 keypoints, undistortion inside"; d["anipose_undistort_runs"] = und; d["anipose_ransac_runs"] = ran
d["best_us_per_keypoint"]["anipose_undistort"] = min(und); d["best_us_per_keypoint"]["anipose_ransac"] = min(ran)
d["ransac_over_linear"] = min(ran) / d["best_us_per_keypoint"]["anipose_linear"]
if "median_us_per_keypoint" in d:   # J16b: medians alongside, and the ratio from medians
    d["median_us_per_keypoint"]["anipose_undistort"] = float(np.median(und))
    d["median_us_per_keypoint"]["anipose_ransac"] = float(np.median(ran))
    for k, v in (("anipose_undistort", und), ("anipose_ransac", ran)):
        d["spread_us_per_keypoint"][k] = {"p25": float(np.percentile(v, 25)), "p75": float(np.percentile(v, 75)),
                                         "min": min(v), "max": max(v), "n": len(v)}
    if d.get("passes", 1) > 1:
        d["ransac_over_linear"] = float(np.median(ran)) / d["median_us_per_keypoint"]["anipose_linear"]
(OUT / f"fig2g_retime_all{_SFX}.json").write_text(json.dumps(d, indent=1))
print("undistort", [round(x, 3) for x in und], "ransac", [round(x) for x in ran], "ratio", round(d["ransac_over_linear"], 1))
