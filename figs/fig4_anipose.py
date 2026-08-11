#!/usr/bin/env python3
"""
Fig 4d/4e — the third arm: Anipose's shipped triangulator, on the same keypoints.

WHAT IS BEING COMPARED, AND WHY IT IS THE RIGHT THING
-----------------------------------------------------
Fig 4 compares LUC3D's linear DLT against LUC3D's non-linear refinement. Both are
ours, so the figure could not say whether either is competitive with the field's
standard tool. This script adds `aniposelib.CameraGroup.triangulate` -- the
triangulation Anipose (Karashchuk et al. 2021, `lambdaloop/anipose`) actually runs
-- scored on the SAME detections, the SAME 50 sessions, the SAME three
calibrations, with the SAME error definition.

    aniposelib==0.7.2, the LAST release before the JAX rewrite, and the newest
    one `anipose` itself accepts (its `Requires-Dist: aniposelib >=0.7.0`).

THE VERSION PIN IS THE POINT AND MUST NOT DRIFT. aniposelib 0.8.0 replaced
`triangulate_simple` with a `jax.vmap`/`jnp.linalg.svd` kernel and made
`CameraGroup.triangulate` a batched JAX call. That is a different program with
different performance: it would be timed against LUC3D as though it were Anipose's
pipeline, when it is a GPU-era rewrite most Anipose users have never run. 0.7.2 is
the original OpenCV/NumPy pipeline: `cv2.undistortPoints` per camera, then a
per-point `numpy.linalg.svd` DLT in a Python loop (numba-jitted inner kernel).
`--assert-no-jax` refuses to run against a JAX build; do not remove it.

    /root/vast/eric/luc3d-bench/anipose_env/bin/python figs/fig4_anipose.py

Inputs: figs/out/fig4_input.json + fig4_input.bin, written by figs/fig4_export.py
and read unchanged by figs/fig4_measure.mjs -- so the anipose arm is not merely
"the same corpus", it is the same float64 detections in the same order.

Output: figs/out/fig4_anipose.json, read by
    figs/panels/fig4_05_per_session.py       (panel d, reprojection error)
    figs/panels/fig4_06_time_per_keypoint.py (panel e, solve time)

TWO MEASUREMENTS, AND THEY HAVE DIFFERENT HAZARDS
-------------------------------------------------
1. ACCURACY (panel d). No hazard beyond getting the error definition identical,
   which is why `native_error` below is a transcription of `nativeError` in
   fig4_measure.mjs: mean Euclidean residual in each camera's NATIVE (still
   distorted) pixels, over exactly the views that carry a detection. Both groups
   the panel draws are computed here:
     reproj_p50   scored in the cameras the solve used
     heldout_p50  leave-one-camera-out -- solve from the rest, project into the
                  held-out camera, score against its raw detection
   Anipose and LUC3D's DLT are both linear DLT, so agreement here is the
   EXPECTED result and is worth having: it is an independent implementation
   cross-check of our solver on 4.25 M real keypoints. A large gap would mean one
   of the two is wrong, not that one is better.

2. TIME (panel e). This is where a careless comparison lies, in two ways.

   SCOPE. fig4_measure.mjs times the solve only; undistortion happens outside the
   timed region. `CameraGroup.triangulate` undistorts INSIDE the call. Charging
   anipose for that and not LUC3D would be an artefact of where the stopwatch
   went. Both are reported: `us_per_keypoint` (solve only, `undistort=False` on
   pre-undistorted points -- the like-for-like number the panel plots) and
   `us_per_keypoint_with_undistort` (the whole call, what a user pays).

   BATCHING. LUC3D solves one keypoint per call because that is what the app does.
   Anipose is handed the whole array -- but 0.7.2's default path then loops over it
   in Python one point at a time, so the two are in the same regime and the
   comparison is real. The vectorised part is undistortion, which is why the two
   scopes above are reported separately rather than blended.

   And the LUC3D bars are re-timed HERE, in the same sitting, by
   fig4_time_luc3d.mjs -- see `--check-luc3d`. The panel still quotes
   fig4.json's whole-corpus numbers, but this script asserts the two agree within
   `--tol` first, so "6.3 vs 41 vs N" cannot silently become a comparison of two
   machine loads.
"""
from __future__ import annotations

import argparse
import inspect
import json
import multiprocessing
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

#: Populated per worker process by `_init`, so the memmap and the CameraGroups are
#: built once per process rather than pickled per block.
_G: dict = {}


# ------------------------------------------------------------------ helpers --
def build_groups(cals):
    """One aniposelib CameraGroup per calibration, in `calibrations` order."""
    from aniposelib.cameras import Camera, CameraGroup
    groups = []
    for cal in cals:
        cams = [Camera(matrix=np.array(c["matrix"], dtype=np.float64),
                       dist=np.array(c["distortions"], dtype=np.float64),
                       rvec=np.array(c["rvec"], dtype=np.float64),
                       tvec=np.array(c["tvec"], dtype=np.float64),
                       name=str(c["name"]), size=tuple(c["size"])) for c in cal]
        groups.append(CameraGroup(cams))
    return groups


def native_error(cg, X, pts):
    """Mean Euclidean reprojection error per keypoint, in NATIVE pixels.

    A transcription of `nativeError` in fig4_measure.mjs, and it must stay one:
    project into every camera that carries a detection (cv2.projectPoints applies
    the distortion model, so this is the camera's real pixel grid, not the ideal
    pinhole one), take the Euclidean residual, average over those cameras.

    NOT `cg.reprojection_error(..., mean=True)`, which drops any keypoint seen in
    fewer than two cameras. That rule is right for triangulation and wrong for
    scoring: after a leave-one-camera-out solve the error is scored in ONE camera,
    and aniposelib's version would return NaN for every such point.

    X: (n, 3), may contain NaN. pts: (C, n, 2), NaN where a view has no detection.
    """
    n = X.shape[0]
    tot = np.zeros(n)
    cnt = np.zeros(n)
    solved = np.isfinite(X).all(axis=1)
    for ci, cam in enumerate(cg.cameras):
        obs = pts[ci]
        use = solved & np.isfinite(obs).all(axis=1)
        if not use.any():
            continue
        proj = cam.project(X[use].astype(np.float64)).reshape(-1, 2)
        d = np.hypot(proj[:, 0] - obs[use, 0], proj[:, 1] - obs[use, 1])
        ok = np.isfinite(d)
        idx = np.flatnonzero(use)[ok]
        tot[idx] += d[ok]
        cnt[idx] += 1
    out = np.full(n, np.nan)
    nz = cnt > 0
    out[nz] = tot[nz] / cnt[nz]
    return out


def _init(meta_path, bin_path):
    d = json.loads(Path(meta_path).read_text())
    K, C = d["keypoints"], d["n_cameras"]
    buf = np.memmap(bin_path, dtype="<f8", mode="r")
    _G["meta"] = d
    _G["obs"] = buf[:K * C * 2].reshape(K, C, 2)
    _G["groups"] = build_groups(d["calibrations"] if d.get("calibrations")
                                else [d["cameras"]])
    _G["C"] = C


def _block(args):
    """Per-session measurement. Returns the session's row plus its raw errors."""
    bi, stride = args
    d, C = _G["meta"], _G["C"]
    b = d["blocks"][bi]
    cg = _G["groups"][b.get("calibration", 0)]
    lo = b["offset"]
    hi = lo + b["count"]
    sl = np.ascontiguousarray(_G["obs"][lo:hi:stride]).astype(np.float64)
    pts = np.ascontiguousarray(sl.transpose(1, 0, 2))       # (C, n, 2)
    # aniposelib keys "no detection" off NaN; fig4_input marks it with any
    # non-finite value. Normalise, or an inf would sail into the SVD.
    pts[~np.isfinite(pts)] = np.nan

    X = cg.triangulate(pts, progress=False)
    err = native_error(cg, X, pts)

    # --- leave-one-camera-out, the same protocol as fig4_measure.mjs ---------
    ho = []
    seen = np.isfinite(pts[:, :, 0])                        # (C, n)
    nviews = seen.sum(axis=0)
    for h in range(C):
        # a keypoint qualifies iff camera h saw it AND >=2 others also did
        use = seen[h] & ((nviews - 1) >= 2)
        if not use.any():
            continue
        sub = pts[:, use, :].copy()
        held = sub[h].copy()
        sub[h] = np.nan
        Xh = cg.triangulate(sub, progress=False)
        ok = np.isfinite(Xh).all(axis=1)
        if not ok.any():
            continue
        proj = cg.cameras[h].project(Xh[ok].astype(np.float64)).reshape(-1, 2)
        d_h = np.hypot(proj[:, 0] - held[ok, 0], proj[:, 1] - held[ok, 1])
        ho.append(d_h[np.isfinite(d_h)])
    ho = np.concatenate(ho) if ho else np.zeros(0)

    e = err[np.isfinite(err)]
    return {
        "session": b["session"],
        "calibration": b.get("calibration", 0),
        "n_keypoints": int(hi - lo),
        "n_scored": int(e.size),
        "reproj_p50": float(np.median(e)) if e.size else None,
        "heldout_p50": float(np.median(ho)) if ho.size else None,
        "heldout_n": int(ho.size),
        # pooled percentiles need the whole corpus, so hand back a bounded sample
        # rather than 85k floats per block: a 20k random draw per session is
        # 1 M values over the corpus, plenty for a p50/p95 and cheap to ship.
        "_err_sample": _sample(e),
        "_ho_sample": _sample(ho),
    }


#: The `optim_points` accuracy variants. `scale_smooth=0` is the one that makes the
#: comparison against LUC3D's refinement fair, and it is not a tweak for our
#: convenience -- see the docstring of `_block_optim`.
OPTIM_VARIANTS = [
    ("optim", {}),
    ("optim_nosmooth", {"scale_smooth": 0, "n_deriv_smooth": 1}),
]


def _block_optim(args):
    """Accuracy for anipose LINEAR vs anipose OPTIM, on a matched subsample.

    WHY A SUBSAMPLE, AND WHY MATCHED. `optim_points` is one global least_squares per
    session, so scoring it over all 4.25 M keypoints x 6 solves (all-view plus five
    leave-one-camera-out) is not the same order of cost as the linear path. This
    takes the first `nf * joints` keypoints of each session and scores ALL THREE
    variants on exactly those, so the optim-minus-linear difference is paired. It is
    NOT comparable to the full-corpus per-session medians in `per_session`; those
    stay the numbers panel d draws, and the bridge between the two is the linear
    arm, which appears in both.

    TWO OPTIM VARIANTS, AND THE SECOND IS THE HONEST ONE.
      `optim`          aniposelib's defaults: soft-L1 reprojection PLUS a temporal
                       smoothing term (`scale_smooth=4`, `n_deriv_smooth=1`).
                       fig4_input is sampled at stride 60 and then filtered to
                       keypoints complete in all five views, so "consecutive"
                       entries are 60+ frames apart and not on a fixed grid. The
                       smoothing term is therefore penalising real motion as though
                       it were noise. Any accuracy number from this variant is a
                       measurement of OUR SAMPLING, not of Anipose, and it must
                       never be quoted as Anipose's accuracy.
      `optim_nosmooth` smoothing off. What remains is soft-L1 reprojection error
                       with the cameras held fixed -- which is precisely what
                       LUC3D's refinement is. THIS is the like-for-like arm.

    Both are reported so the reader can see the size of the artefact rather than
    take our word that there is one.
    """
    bi, nf, joints = args
    d, C = _G["meta"], _G["C"]
    b = d["blocks"][bi]
    cg = _G["groups"][b.get("calibration", 0)]
    # nf <= 0 means THE WHOLE SESSION, which is what panel d needs: a column drawn
    # from a 9,000-keypoint subsample cannot sit beside three columns drawn from
    # 85,000 without the reader silently comparing different keypoint sets.
    n = b["count"] if nf <= 0 else min(nf * joints, b["count"])
    nf = n // joints                     # truncate to a whole number of "frames"
    n = nf * joints
    if nf < 20:
        return None
    lo = b["offset"]
    sl = np.ascontiguousarray(_G["obs"][lo:lo + n]).astype(np.float64)
    pts = np.ascontiguousarray(sl.transpose(1, 0, 2))
    pts[~np.isfinite(pts)] = np.nan

    def solve(p, variant, kw):
        """3D for one variant on 2D array `p` (C, n, 2)."""
        X = cg.triangulate(p, progress=False)
        if variant == "linear":
            return X
        # optim_points cannot start from NaN; seed the gaps with the mean so the
        # solve is defined, then re-mask afterwards. Leaving NaN in makes
        # least_squares return NaN for every point, not just the missing ones.
        bad = ~np.isfinite(X).all(axis=1)
        X2 = X.copy()
        if bad.any():
            if bad.all():
                return X
            X2[bad] = np.nanmean(X[~bad], axis=0)
        out = cg.optim_points(p.reshape(C, nf, joints, 2),
                              X2.reshape(nf, joints, 3), **kw).reshape(-1, 3)
        out[bad] = np.nan
        return out

    variants = [("linear", {})] + OPTIM_VARIANTS
    row = {"session": b["session"], "calibration": b.get("calibration", 0),
           "n_frames": int(nf), "n_joints": int(joints), "n": int(n)}
    seen = np.isfinite(pts[:, :, 0])
    nviews = seen.sum(axis=0)
    for name, kw in variants:
        X = solve(pts, name, kw)
        e = native_error(cg, X, pts)
        e = e[np.isfinite(e)]
        # leave-one-camera-out, same protocol as the linear pass
        ho = []
        for h in range(C):
            use = seen[h] & ((nviews - 1) >= 2)
            if not use.all():
                # optim_points needs the (frames, joints) grid intact, so a partial
                # mask cannot be compacted away as the linear path does. Every
                # keypoint here is complete in all 5 views by construction
                # (fig4_export's `complete` filter), so this should not fire --
                # refuse rather than quietly score a different keypoint set.
                if use.any():
                    raise RuntimeError(
                        f"session {b['session']}: held-out keypoint set is not the "
                        f"whole slice; the optim grid cannot be masked per keypoint")
                continue
            sub = pts.copy()
            held = sub[h].copy()
            sub[h] = np.nan
            Xh = solve(sub, name, kw)
            ok = np.isfinite(Xh).all(axis=1)
            if not ok.any():
                continue
            proj = cg.cameras[h].project(Xh[ok].astype(np.float64)).reshape(-1, 2)
            dh = np.hypot(proj[:, 0] - held[ok, 0], proj[:, 1] - held[ok, 1])
            ho.append(dh[np.isfinite(dh)])
        ho = np.concatenate(ho) if ho else np.zeros(0)
        row[f"{name}_reproj_p50"] = float(np.median(e)) if e.size else None
        row[f"{name}_heldout_p50"] = float(np.median(ho)) if ho.size else None
        row[f"{name}_heldout_n"] = int(ho.size)
    return row


def _sample(a, k=20000, seed=0):
    if a.size <= k:
        return a.astype(np.float32).tolist()
    rng = np.random.default_rng(seed)
    return a[rng.choice(a.size, k, replace=False)].astype(np.float32).tolist()


def pct(a):
    if not len(a):
        return None
    v = np.asarray(a, dtype=np.float64)
    return {"n": int(v.size), "mean": float(v.mean()),
            **{f"p{p}": float(np.percentile(v, p))
               for p in (5, 25, 50, 75, 90, 95, 99)}}


# -------------------------------------------------------------------- timing --
def time_anipose(meta, obs, groups, n, repeats):
    """Solve time per keypoint, both scopes. Best of `repeats`, single-threaded.

    `undistort=False` on pre-undistorted points isolates the DLT, which is the
    scope fig4_measure.mjs times for LUC3D. The full call is timed too.
    """
    b0 = meta["blocks"][0]
    assert b0["offset"] == 0 and b0.get("calibration", 0) == 0, \
        "block 0 must be calibration 0 at offset 0 for the timing slice"
    n = min(n, b0["count"])
    cg = groups[0]
    pts = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64)
    pts[~np.isfinite(pts)] = np.nan

    # numba compiles `triangulate_simple` on first call; a cold run would be timing
    # the compiler.
    cg.triangulate(pts[:, :512], progress=False)

    und = np.empty_like(pts)
    for ci, cam in enumerate(cg.cameras):
        und[ci] = cam.undistort_points(np.copy(pts[ci]))

    best_full = best_solve = np.inf
    for _ in range(repeats):
        t0 = time.perf_counter()
        cg.triangulate(pts, progress=False)
        best_full = min(best_full, time.perf_counter() - t0)
        t0 = time.perf_counter()
        cg.triangulate(und, undistort=False, progress=False)
        best_solve = min(best_solve, time.perf_counter() - t0)

    # ONE CALL PER KEYPOINT, the control that reconciles this number with the
    # earlier bench. Nobody uses aniposelib this way, but the earlier run did, and
    # a per-call figure ~50x the batched one is what made "anipose is much slower"
    # and "anipose is 28 us" look like a contradiction. Both are true; they are
    # different questions.
    m = min(n, 2000)
    t0 = time.perf_counter()
    for i in range(m):
        cg.triangulate(pts[:, i:i + 1], progress=False)
    per_call = 1e6 * (time.perf_counter() - t0) / m

    return {
        "n": int(n), "repeats": repeats,
        "us_per_keypoint": 1e6 * best_solve / n,
        "us_per_keypoint_with_undistort": 1e6 * best_full / n,
        "undistort_us_per_keypoint": 1e6 * (best_full - best_solve) / n,
        "us_per_keypoint_one_call_each": per_call, "n_one_call_each": int(m),
    }


def time_anipose_optim(meta, obs, groups, sweep, joints, ransac_n):
    """The `optim: true` and `ransac: true` paths -- Anipose's OTHER triangulators.

    WHY THESE ARE HERE AT ALL. `CameraGroup.triangulate` is what `anipose
    triangulate` runs with its shipped defaults (`optim: False, ransac: False`,
    verified in `anipose/anipose.py`), so it is the right default bar. But it is
    also the CHEAPEST of Anipose's paths by two orders of magnitude, and pairing it
    against LUC3D's non-linear refinement compares a closed-form SVD against an
    iterative robust solve -- a category error that happens to flatter nobody
    consistently. `optim_points` is the real counterpart: non-linear, soft-L1,
    cameras fixed, which is exactly what LUC3D's refinement is.

    `optim_points` IS NOT A PER-KEYPOINT SOLVE, and that is why this sweeps rather
    than reporting one number. It is a single global `scipy.least_squares` over a
    whole session with temporal-smoothing and bone-length terms, so its cost per
    keypoint falls steeply as fixed costs amortise -- 1555 us/kp at 200 frames
    against ~130 at 8,000. A single measurement at a convenient size would be a
    number the panel could not defend; the sweep is deposited and the panel quotes
    the largest run plus the range.

    THE TEMPORAL STRUCTURE IS NOT REAL, and the caption must say so. fig4_input is
    sampled at stride 60 and then filtered to keypoints complete in all 5 views, so
    consecutive entries are neither consecutive frames nor a fixed grid. Reshaping
    them into (frames, joints) gives `optim_points` the right ARRAY SHAPE, which is
    what its cost is driven by, but not a smooth trajectory -- so the iteration
    count, and hence the cost, could differ on genuinely contiguous data. This
    measures the shape of the computation, not a run of Anipose's method on data it
    would recognise. Scoring accuracy this way would be indefensible, which is why
    panel d has no optim arm.
    """
    cg = groups[0]
    cap = meta["blocks"][0]["count"]
    rows = []
    for nf in sweep:
        n = nf * joints
        if n > cap:
            continue
        pts = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64)
        pts[~np.isfinite(pts)] = np.nan
        X = cg.triangulate(pts, progress=False)
        t0 = time.perf_counter()
        cg.optim_points(pts.reshape(len(cg.cameras), nf, joints, 2),
                        X.reshape(nf, joints, 3))
        dt = time.perf_counter() - t0
        rows.append({"n_frames": nf, "n_joints": joints, "n": int(n),
                     "wall_s": dt, "us_per_keypoint": 1e6 * dt / n})
        print(f"  optim_points nf={nf:6d} n={n:7d}  "
              f"{1e6 * dt / n:8.1f} us/kp  (wall {dt:6.1f}s)", flush=True)

    # `ransac: true`. C-choose-subsets per point, and it shows.
    n = min(ransac_n, cap)
    pts = np.ascontiguousarray(obs[:n].transpose(1, 0, 2)).astype(np.float64)
    pts[~np.isfinite(pts)] = np.nan
    t0 = time.perf_counter()
    cg.triangulate_ransac(pts, progress=False)
    ransac = 1e6 * (time.perf_counter() - t0) / n

    per_kp = [r["us_per_keypoint"] for r in rows]
    return {
        "optim": {
            "sweep": rows,
            # The largest run is the one the panel draws: it is the only size at
            # which the fixed costs have amortised enough to be a session-scale
            # number rather than a start-up cost.
            "us_per_keypoint": rows[-1]["us_per_keypoint"] if rows else None,
            "us_per_keypoint_min": min(per_kp) if per_kp else None,
            "us_per_keypoint_max": max(per_kp) if per_kp else None,
            "at_n": rows[-1]["n"] if rows else None,
            "note": ("aniposelib CameraGroup.optim_points, the `optim: true` path. "
                     "NOT a per-keypoint solve -- one global least_squares per "
                     "session, so us/keypoint falls with session length; the sweep "
                     "is the evidence. Temporal structure is NOT real here (stride "
                     "60 + completeness filter), so this is the cost shape, not a "
                     "run on data Anipose would recognise."),
        },
        "ransac": {
            "n": int(n), "us_per_keypoint": ransac,
            "note": ("aniposelib CameraGroup.triangulate_ransac, the `ransac: true` "
                     "path. Reported for the caption; not plotted."),
        },
    }


# ---------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stride", type=int, default=1,
                    help="keypoint stride WITHIN each session (1 = every keypoint "
                         "fig4_measure.mjs saw)")
    ap.add_argument("--jobs", type=int, default=16)
    ap.add_argument("--time-n", type=int, default=200000)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--optim-sweep", type=int, nargs="*",
                    default=[1000, 2000, 4000, 8000],
                    help="frame counts for the optim_points cost sweep")
    ap.add_argument("--optim-joints", type=int, default=15,
                    help="joints per frame for the optim (frames, joints) reshape")
    ap.add_argument("--optim-score-frames", type=int, default=0,
                    help="frames per session for the optim ACCURACY pass; "
                         "0 = the whole session, which is what panel d needs")
    ap.add_argument("--optim-jobs", type=int, default=12,
                    help="workers for the optim accuracy pass; lower than --jobs "
                         "because each least_squares holds a sparse Jacobian over "
                         "the whole session")
    ap.add_argument("--ransac-n", type=int, default=5000)
    ap.add_argument("--no-optim", action="store_true",
                    help="skip the optim/ransac arms (they cost minutes)")
    ap.add_argument("--tol", type=float, default=0.35,
                    help="max fractional disagreement between fig4.json's LUC3D "
                         "timings and this sitting's re-timing before refusing")
    ap.add_argument("--no-check-luc3d", action="store_true")
    ap.add_argument("--assert-no-jax", action="store_true", default=True)
    ap.add_argument("--out", type=Path, default=OUT / "fig4_anipose.json")
    args = ap.parse_args()

    import aniposelib
    from aniposelib import cameras as apl_cameras
    ver = getattr(aniposelib, "__version__", "?")
    src = inspect.getsource(apl_cameras)
    if args.assert_no_jax and "jax" in src:
        raise SystemExit(
            f"aniposelib {ver} is a JAX build. Fig 4 compares against Anipose's "
            f"OpenCV/NumPy pipeline (aniposelib 0.7.2, the last release before the "
            f"JAX rewrite and the newest `anipose` accepts). Install 0.7.2.")
    print(f"aniposelib {ver} (OpenCV/NumPy pipeline, no JAX)")

    meta_path, bin_path = OUT / "fig4_input.json", None
    meta = json.loads(meta_path.read_text())
    bin_path = OUT / meta["bin"]
    K, C = meta["keypoints"], meta["n_cameras"]
    print(f"{K} keypoints x {C} cameras, {len(meta['blocks'])} sessions, "
          f"{len(meta['calibrations'])} calibrations, stride {meta['stride']}")

    obs = np.memmap(bin_path, dtype="<f8", mode="r")[:K * C * 2].reshape(K, C, 2)
    groups = build_groups(meta["calibrations"])

    # --- timing first: it wants a quiet machine, before the pool starts -------
    t_anipose = time_anipose(meta, obs, groups, args.time_n, args.repeats)
    print(f"anipose  solve {t_anipose['us_per_keypoint']:.2f} us/kp  "
          f"(+undistort {t_anipose['us_per_keypoint_with_undistort']:.2f}, "
          f"one-call-each {t_anipose['us_per_keypoint_one_call_each']:.0f})")

    t_other = None
    if not args.no_optim:
        t_other = time_anipose_optim(meta, obs, groups, args.optim_sweep,
                                     args.optim_joints, args.ransac_n)
        o, r = t_other["optim"], t_other["ransac"]
        print(f"anipose  optim  {o['us_per_keypoint']:.1f} us/kp at n={o['at_n']} "
              f"(range {o['us_per_keypoint_min']:.1f}-{o['us_per_keypoint_max']:.1f} "
              f"over the sweep)")
        print(f"anipose  ransac {r['us_per_keypoint']:.0f} us/kp")

    t_luc3d = None
    if not args.no_check_luc3d:
        p = subprocess.run(
            ["node", str(HERE / "fig4_time_luc3d.mjs"),
             "--n", str(min(args.time_n, meta["blocks"][0]["count"])),
             "--repeats", str(args.repeats)],
            capture_output=True, text=True, cwd=str(HERE.parent))
        if p.returncode != 0:
            raise SystemExit("fig4_time_luc3d.mjs failed:\n" + p.stderr[-3000:])
        t_luc3d = json.loads(p.stdout)
        print(f"luc3d    dlt {t_luc3d['dlt_us_per_keypoint']:.2f}  "
              f"ba {t_luc3d['ba_us_per_keypoint']:.2f} us/kp "
              f"(undistort {t_luc3d['undistort_us_per_keypoint']:.2f})")

    # --- accuracy, one process per session -----------------------------------
    t0 = time.perf_counter()
    # SPAWN, NOT FORK. numba and cv2 have both initialised OpenMP by this point
    # (the timing pass above ran the numba kernel), and libgomp aborts the child
    # outright -- "fork() called from a process already using GNU OpenMP" -- so the
    # default fork context takes the whole pool down.
    with ProcessPoolExecutor(max_workers=args.jobs, initializer=_init,
                             mp_context=multiprocessing.get_context("spawn"),
                             initargs=(str(meta_path), str(bin_path))) as ex:
        rows = list(ex.map(_block,
                           [(i, args.stride) for i in range(len(meta["blocks"]))]))
    print(f"accuracy: {len(rows)} sessions in {time.perf_counter() - t0:.1f}s")

    # --- and the optim accuracy pass, on its own matched subsample ------------
    optim_rows = []
    if not args.no_optim:
        t0 = time.perf_counter()
        with ProcessPoolExecutor(max_workers=args.optim_jobs, initializer=_init,
                                 mp_context=multiprocessing.get_context("spawn"),
                                 initargs=(str(meta_path), str(bin_path))) as ex:
            optim_rows = [r for r in ex.map(
                _block_optim,
                [(i, args.optim_score_frames, args.optim_joints)
                 for i in range(len(meta["blocks"]))]) if r]
        print(f"optim accuracy: {len(optim_rows)} sessions in "
              f"{time.perf_counter() - t0:.1f}s")

    err_pool, ho_pool = [], []
    for r in rows:
        err_pool += r.pop("_err_sample")
        ho_pool += r.pop("_ho_sample")

    out = {
        "aniposelib_version": ver,
        "pipeline": "OpenCV undistortPoints + per-point numpy SVD DLT (no JAX)",
        "python": sys.executable,
        "input": {"keypoints": K, "cameras": C, "stride_export": meta["stride"],
                  "stride_within_session": args.stride,
                  "n_sessions": len(rows), "n_calibrations": len(meta["calibrations"])},
        "timing": {"anipose": t_anipose, "luc3d_recheck": t_luc3d,
                   "anipose_optim": (t_other or {}).get("optim"),
                   "anipose_ransac": (t_other or {}).get("ransac"),
                   "note": ("anipose `us_per_keypoint` is the DLT alone on "
                            "pre-undistorted points, the same scope "
                            "fig4_measure.mjs times for LUC3D; the _with_undistort "
                            "figure is the whole CameraGroup.triangulate call. "
                            "anipose_optim/anipose_ransac are the `optim: true` and "
                            "`ransac: true` config paths -- see their own notes.")},
        "reproj_px": pct(err_pool),
        "heldout_reproj_px": pct(ho_pool),
        "pooled_note": ("percentiles over a <=20k-per-session random sample "
                        "(~1 M values), not all 4.25 M -- per-session medians in "
                        "`per_session` are exact"),
        "per_session": rows,
        "per_session_optim": optim_rows,
        "per_session_optim_note": (
            "linear vs optim vs optim_nosmooth, PAIRED per session on the same "
            "keypoints. With --optim-score-frames 0 (the default) that is the whole "
            "session, truncated to a multiple of optim_joints, so these columns are "
            "directly comparable to `per_session` and to fig4.json's LUC3D columns. "
            "`optim` carries aniposelib's default temporal smoothing, which "
            "fig4_input's stride-60 sampling makes meaningless -- quote "
            "`optim_nosmooth` for the like-for-like against LUC3D's refinement, and "
            "`optim` only to show the size of that artefact."),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1))

    # --- the agreement gate ---------------------------------------------------
    if t_luc3d:
        ref = json.loads((OUT / "fig4.json").read_text())["methods"]
        bad = []
        for key, meas in (("dlt", "dlt_us_per_keypoint"), ("ba", "ba_us_per_keypoint")):
            a, b = ref[key]["us_per_keypoint"], t_luc3d[meas]
            rel = abs(a - b) / a
            flag = "OK " if rel <= args.tol else "OFF"
            print(f"  [{flag}] luc3d {key}: fig4.json {a:.2f} vs this sitting "
                  f"{b:.2f} us/kp ({rel * 100:.0f}%)")
            if rel > args.tol:
                bad.append(key)
        if bad:
            print(f"\nWARNING: {', '.join(bad)} disagree by more than "
                  f"{args.tol * 100:.0f}%. The three bars in panel e are then not "
                  f"one comparison -- re-run fig4_measure.mjs before plotting.")

    r = out["reproj_px"]
    h = out["heldout_reproj_px"]
    print(f"\nanipose reproj p50 {r['p50']:.3f} px (mean {r['mean']:.3f}, n {r['n']})")
    print(f"anipose held-out   p50 {h['p50']:.3f} px (mean {h['mean']:.3f}, n {h['n']})")
    if optim_rows:
        print(f"\nmatched subsample, {len(optim_rows)} sessions "
              f"({optim_rows[0]['n']} keypoints each) -- median of session medians:")
        for name, _ in [("linear", 0)] + OPTIM_VARIANTS:
            u = [x[f"{name}_reproj_p50"] for x in optim_rows
                 if x.get(f"{name}_reproj_p50") is not None]
            o = [x[f"{name}_heldout_p50"] for x in optim_rows
                 if x.get(f"{name}_heldout_p50") is not None]
            print(f"  {name:15} used {np.median(u):.3f} px   "
                  f"held-out {np.median(o):.3f} px   (n={len(u)} sessions)")
        base = np.array([x["linear_heldout_p50"] for x in optim_rows])
        for name, _ in OPTIM_VARIANTS:
            v = np.array([x[f"{name}_heldout_p50"] for x in optim_rows])
            print(f"  {name} beats linear out of sample in "
                  f"{int((v < base).sum())}/{len(v)} sessions")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("NUMBA_NUM_THREADS", "1")
    main()
