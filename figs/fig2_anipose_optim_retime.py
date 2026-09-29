#!/usr/bin/env python
"""Re-time Anipose's non-linear triangulator (`optim_points`) with and without its
temporal smoothing term, on the Fig 2G inputs.

WHY. Fig 2G's Anipose-optim bar (228.8 us/keypoint) came from
`fig2_solvers_anipose.time_anipose_optim`, which calls `cg.optim_points(...)` with
aniposelib's DEFAULTS -- `scale_smooth=4`, i.e. smoothing ON -- and one run per size.
The accuracy comparison (Fig 2F) and the Methods (L304: "The temporal smoothing term
in the non-linear path was disabled") use smoothing OFF (`scale_smooth=0`,
`fig2_solvers_anipose.OPTIM_VARIANTS["optim_nosmooth"]`), and LUC3D's refinement has
no smoothing term. So the timed Anipose path was not the one compared for accuracy,
and it was not best-of-three as L306 states.

This times BOTH variants on the SAME inputs (`out/fig4_input.json`, stride 15, the
same calibration group), the same sweep, best of 3 per size, single-threaded, and
with aniposelib 0.7.2 (the version `fig2_solvers_anipose.py` asserts).

    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 \
      /root/vast/eric/luc3d-bench/anipose_env/bin/python figs/fig2_anipose_optim_retime.py

Output: figs/out/fig4_anipose_optim_retime.json
"""
import json, sys, time
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
sys.path.insert(0, str(HERE))
import fig2_solvers_anipose as fsa  # noqa: E402  (build_groups, OPTIM_VARIANTS)

SWEEP = [1000, 2000, 4000, 8000, 16000, 23000]    # the deposited sweep
JOINTS = 15
REPEATS = 3
VARIANTS = {"default (smoothing on, as published)": {},
            "no smoothing (as in the accuracy comparison)": dict(fsa.OPTIM_VARIANTS)["optim_nosmooth"]}


def main():
    import aniposelib
    print("aniposelib", getattr(aniposelib, "__version__", "?"), flush=True)
    meta = json.loads((OUT / "fig4_input.json").read_text())
    K, C = meta["keypoints"], meta["n_cameras"]
    obs = np.memmap(OUT / meta["bin"], dtype="<f8", mode="r")[:K * C * 2].reshape(K, C, 2)
    cg = fsa.build_groups(meta["calibrations"])[0]
    cap = meta["blocks"][0]["count"]
    res = {v: [] for v in VARIANTS}
    for nf in SWEEP:
        n = nf * JOINTS
        if n > cap:
            continue
        pts = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64)
        pts[~np.isfinite(pts)] = np.nan
        X = cg.triangulate(pts, progress=False)
        for v, kw in VARIANTS.items():
            ts = []
            for _ in range(REPEATS):
                t0 = time.perf_counter()
                cg.optim_points(pts.reshape(len(cg.cameras), nf, JOINTS, 2),
                                X.reshape(nf, JOINTS, 3), **kw)
                ts.append(time.perf_counter() - t0)
            best = min(ts)
            res[v].append({"n_frames": nf, "n": n, "wall_s_runs": ts,
                           "us_per_keypoint_best": 1e6 * best / n})
            print(f"  {v:46s} nf={nf:6d}  best {1e6 * best / n:8.1f} us/kp  runs "
                  f"{', '.join(f'{t:.1f}' for t in ts)} s", flush=True)
    out = {"generated_by": "figs/fig2_anipose_optim_retime.py",
           "aniposelib": getattr(aniposelib, "__version__", "?"),
           "inputs": "out/fig4_input.json (the Fig 2G inputs)", "repeats": REPEATS,
           "variants": {v: {"kwargs": kw, "sweep": res[v],
                            "us_per_keypoint_at_largest": res[v][-1]["us_per_keypoint_best"],
                            "at_n": res[v][-1]["n"]} for v, kw in VARIANTS.items()}}
    (OUT / "fig4_anipose_optim_retime.json").write_text(json.dumps(out, indent=1))
    for v in VARIANTS:
        print(f"{v}: {out['variants'][v]['us_per_keypoint_at_largest']:.1f} us/kp at n={out['variants'][v]['at_n']}")


if __name__ == "__main__":
    main()
