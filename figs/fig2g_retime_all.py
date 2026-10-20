#!/usr/bin/env python
"""Re-time all four Fig 2G bars in ONE sitting, interleaved, same protocol.

WHY. The published Fig 2G mixes protocols: the two LUC3D bars are a single pass over
~17M keypoints (fig4.json), Anipose linear is best-of-3 at n = 200,000, and the Anipose
non-linear bar (228.8 us/kp) is ONE run per size with aniposelib's defaults. Re-timing
on an idle-looking box (2026-09-29) gave the non-linear path 142.5 us/kp at the same
n = 345,000. The published sweep was 1.6-2x slower at every size, consistent with
machine load at the time (this job shares a physical host). So every bar is re-timed
here, interleaved in rounds so any external load hits all four equally, best of all
rounds kept per bar.

Bars (identical scopes to the published ones):
  anipose linear   CameraGroup.triangulate(undistort=False) on pre-undistorted points,
                   n = 200,000 (fig2_solvers_anipose.time_anipose's `solve` scope)
  anipose optim    CameraGroup.optim_points, n = 23,000 frames x 15 joints = 345,000,
                   smoothing OFF (scale_smooth=0), the variant used for accuracy (L304)
                   -- and smoothing ON (library default) reported beside it
  luc3d dlt / ba   figs/fig2_solvers_time_luc3d.mjs --n 200000, POSE_DIR = origin/main

    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMBA_NUM_THREADS=1 \
      /root/vast/eric/luc3d-bench/anipose_env/bin/python figs/fig2g_retime_all.py --rounds 3

Output: figs/out/fig2g_retime_all.json
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
#: FIG2_SUFFIX=<v> (2026-10-14, md56 rerun) reads/writes out/fig4*_<v>.* instead of the base
#: deposits, so a variant run never overwrites what the base figure reads.
_SFX = ("_" + os.environ["FIG2_SUFFIX"]) if os.environ.get("FIG2_SUFFIX") else ""
sys.path.insert(0, str(HERE))
import fig2_solvers_anipose as fsa  # noqa: E402

NODE = os.environ.get("NODE", "/root/vast/eric/node22_env/bin/node")
# LUC3D-JS plan R1/R4 (2026-10-20): POSE_DIR is required and must be the clean v1.0.5 checkout.
# The old default (lucid-main-timing) is gone.
from lucid_v105 import lucid_pose  # noqa: E402
_POSE, LUCID = lucid_pose()
POSE_DIR = str(_POSE)
N_LIN = 200_000
OPT_FRAMES, JOINTS = 23_000, 15
#: FIG2G_FRAMES=<f> (2026-10-15): time EVERY solver on the same first f frames x 15 joints, so all
#: bars share one keypoint set (f = 13,334 gives 200,010). Unset = the old 200,000 / 345,000 split.
if os.environ.get("FIG2G_FRAMES"):
    OPT_FRAMES = int(os.environ["FIG2G_FRAMES"]); N_LIN = OPT_FRAMES * JOINTS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=3)
    # J16b (2026-10-20): LUC3D DLT / undistort passes per round (each ~0.2 s); every pass is
    # recorded and every arm is reported as the MEDIAN of its timed passes.
    ap.add_argument("--passes", type=int, default=1)
    a = ap.parse_args()
    import aniposelib, numba
    meta = json.loads((OUT / f"fig4_input{_SFX}.json").read_text())
    K, C = meta["keypoints"], meta["n_cameras"]
    obs = np.memmap(OUT / meta["bin"], dtype="<f8", mode="r")[:K * C * 2].reshape(K, C, 2)
    cg = fsa.build_groups(meta["calibrations"])[0]

    # linear inputs, and a warm-up so numba compiles triangulate_simple outside timing
    pl = np.ascontiguousarray(obs[:N_LIN].transpose(1, 0, 2)).astype(np.float64)
    pl[~np.isfinite(pl)] = np.nan
    und = np.empty_like(pl)
    for ci, cam in enumerate(cg.cameras):
        und[ci] = cam.undistort_points(np.copy(pl[ci]))
    cg.triangulate(und[:, :512], undistort=False, progress=False)
    # optim inputs, and a warm-up call (numba compiles _error_fun_triangulation once)
    n_opt = OPT_FRAMES * JOINTS
    po = np.ascontiguousarray(obs[:n_opt].transpose(1, 0, 2)).astype(np.float64)
    po[~np.isfinite(po)] = np.nan
    Xo = cg.triangulate(po, progress=False)
    small = 500 * JOINTS
    cg.optim_points(po[:, :small].reshape(C, 500, JOINTS, 2), Xo[:small].reshape(500, JOINTS, 3),
                    scale_smooth=0, n_deriv_smooth=1)
    cg.optim_points(po[:, :small].reshape(C, 500, JOINTS, 2), Xo[:small].reshape(500, JOINTS, 3))

    runs = {k: [] for k in ("anipose_linear", "anipose_optim_nosmooth", "anipose_optim_default",
                            "luc3d_dlt", "luc3d_refined", "luc3d_undistort")}
    for r in range(a.rounds):
        t0 = time.perf_counter(); cg.triangulate(und, undistort=False, progress=False)
        runs["anipose_linear"].append(1e6 * (time.perf_counter() - t0) / N_LIN)
        t0 = time.perf_counter()
        cg.optim_points(po.reshape(C, OPT_FRAMES, JOINTS, 2), Xo.reshape(OPT_FRAMES, JOINTS, 3),
                        scale_smooth=0, n_deriv_smooth=1)
        runs["anipose_optim_nosmooth"].append(1e6 * (time.perf_counter() - t0) / n_opt)
        p = subprocess.run([NODE, str(HERE / "fig2_solvers_time_luc3d.mjs"), "--n", str(N_LIN),
                            "--repeats", "1", "--passes", str(a.passes), "--warm-full"],
                           capture_output=True, text=True,
                           cwd=str(HERE.parent), env={**os.environ, "POSE_DIR": POSE_DIR})
        if p.returncode != 0:
            raise SystemExit("luc3d timer failed:\n" + p.stderr[-2000:])
        j = json.loads(p.stdout)
        if j.get("lucid_commit") != LUCID["lucid_commit"]:
            raise SystemExit(f"luc3d timer ran {j.get('lucid_commit')}, not {LUCID['lucid_commit']}")
        pp = j["pass_us_per_keypoint"]
        runs["luc3d_dlt"].extend(pp["dlt"])
        runs["luc3d_refined"].extend(pp["ba"])
        runs["luc3d_undistort"].extend(pp["undistort"])
        t0 = time.perf_counter()
        cg.optim_points(po.reshape(C, OPT_FRAMES, JOINTS, 2), Xo.reshape(OPT_FRAMES, JOINTS, 3))
        runs["anipose_optim_default"].append(1e6 * (time.perf_counter() - t0) / n_opt)
        print(f"round {r + 1}: " + "  ".join(f"{k} {np.median(v):.3f}" for k, v in runs.items()), flush=True)

    best = {k: min(v) for k, v in runs.items()}
    q = lambda v, p: float(np.percentile(v, p))
    med = {k: q(v, 50) for k, v in runs.items()}
    spread = {k: {"p25": q(v, 25), "p75": q(v, 75), "min": min(v), "max": max(v), "n": len(v)}
              for k, v in runs.items()}
    out = {"generated_by": "figs/fig2g_retime_all.py", "rounds": a.rounds,
           "aniposelib": getattr(aniposelib, "__version__", "?"),
           "opencv": __import__("cv2").__version__,   # recorded since 2026-10-14 (md56)
           "numba_threads": numba.config.NUMBA_NUM_THREADS,
           "pose_dir": POSE_DIR, **LUCID, "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
           "n_linear": N_LIN, "n_optim": n_opt, "runs_us_per_keypoint": runs,
           "statistic": ("median of every timed pass" if a.passes > 1 else "best round"),
           "passes": a.passes, "median_us_per_keypoint": med, "spread_us_per_keypoint": spread,
           "best_us_per_keypoint": best,
           "speedup_dlt_vs_anipose_linear": (med if a.passes > 1 else best)["anipose_linear"] / (med if a.passes > 1 else best)["luc3d_dlt"],
           "speedup_refined_vs_anipose_optim_nosmooth": (med if a.passes > 1 else best)["anipose_optim_nosmooth"] / (med if a.passes > 1 else best)["luc3d_refined"],
           "speedup_refined_vs_anipose_optim_default": (med if a.passes > 1 else best)["anipose_optim_default"] / (med if a.passes > 1 else best)["luc3d_refined"],
           "speedup_range_dlt_vs_anipose_linear": [spread["anipose_linear"]["p25"] / spread["luc3d_dlt"]["p75"], spread["anipose_linear"]["p75"] / spread["luc3d_dlt"]["p25"]],
           "published": {"anipose_linear": 29.03, "anipose_optim": 228.77, "luc3d_dlt": 6.316,
                         "luc3d_refined": 43.997, "speedups": [4.60, 5.20]}}
    (OUT / f"fig2g_retime_all{_SFX}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: round(v, 3) for k, v in med.items()}, indent=1))
    print(f"speed-ups: DLT {out['speedup_dlt_vs_anipose_linear']:.2f}x, refined vs optim "
          f"(no smoothing) {out['speedup_refined_vs_anipose_optim_nosmooth']:.2f}x, "
          f"(default) {out['speedup_refined_vs_anipose_optim_default']:.2f}x")


if __name__ == "__main__":
    main()
