#!/usr/bin/env python3
"""
Measure the quantities Fig 2 reports, from REAL proofread multi-camera data.

Run with the bench env (it has cv2/toml):
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig2_measure.py

Dataset: /root/vast/eric/BMimica/<session>/ -- 5 calibrated cameras, 2 mice,
15-node skeleton, ~180k frames, with
  * a PROOFREAD 3D reconstruction  (<session>/*points3d*.h5, metric, no NaNs)
  * the RAW per-camera SLEAP 2D    (<session>/<serial>/*.analysis.h5)
  * the rig calibration            (<session>/calibration/*_calibration.toml)

These are the two things Fig 2 needs to contrast, and both are real:
  "independent per-view 2D"  = the raw per-camera estimates. Each view is
                               produced without any knowledge of the others, so
                               nothing forces them onto a common 3D point --
                               the same situation as a human labelling each view
                               on its own.
  "3D-consistent"            = the proofread 3D. One 3D object per animal per
                               frame, so every view agrees by construction.

WHAT IS MEASURED
----------------
A. Anchor-pair sufficiency (Fig 2b). Triangulate each keypoint from only TWO
   views' independent 2D, reproject into the views that were NOT used, and
   measure the distance to where that keypoint actually is. That is exactly the
   correction a labeller would have to make after LUC3D draws the reprojection.
   Swept over all C(5,2)=10 anchor pairs and over anchor counts k=2..5, so the
   "2 anchors are enough" claim is measured rather than assumed.
   -> manual placements per frame vs number of cameras, measured at C=2..5 by
      using real camera subsets, for traditional vs reprojection-aided labelling.

B. Cross-view geometric consistency (Fig 2c). For every keypoint, the multi-view
   reprojection residual of the 3D triangulated from independent per-view 2D --
   i.e. how badly the views disagree about where the keypoint is. Independent
   labelling has no mechanism to keep this small; reprojection-aided labelling
   bounds it by the tolerance the labeller accepts. Also bone lengths under both
   conditions, and the correlation between residual and bone-length error, which
   is the mechanism: views that disagree produce anatomically impossible
   skeletons.

HONEST NOTES (carried into fig2.py so they reach the caption)
-------------------------------------------------------------
  * The independent per-view 2D is a NETWORK's per-view estimate, not a human's.
    The mechanism under test -- per-view estimates with no cross-view constraint
    -- is the same, but this is not a human-labelling study, and the figure says so.
  * The proofread 3D is 3D-consistent AND human-corrected. Where it is compared
    against raw independent 2D, those two factors are not separable; the panel
    that isolates geometry alone is the reprojection-residual one, which uses the
    identical 2D observations under both protocols.
  * Frames are uniformly subsampled (--stride) for tractability, never selected.
  * Identity: raw per-camera tracks are matched to proofread animals per frame
    per view by nearest reprojected GT (2x2 assignment). Only keypoints matched
    in ALL cameras are used, so every condition sees the same observations; the
    retained fraction is reported.
"""
from __future__ import annotations

import argparse
import glob
import itertools
import json
import os
import sys

import cv2
import h5py
import numpy as np

#: Overridable so this can run off-box; see figs/HANDOFF-FIG2.md. The launcher
#: reads the same variables, so enumeration and measurement cannot disagree.
BENCH = os.environ.get("LUC3D_BENCH_SCRIPTS",
                       "/root/vast/eric/luc3d-bench/scripts/bartul")
sys.path.insert(0, BENCH)
from build_gt_reproj import (load_calibration, load_sleap_2d, undistort,  # noqa: E402
                            procrustes_scale, ransac_align, SERIALS)

ROOT = os.environ.get("BMIMICA_ROOT", "/root/vast/eric/BMimica")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "fig2.json")

# The app's own default reprojection tolerance (ui/settings.js: reprojSigma = 20 px)
# is the headline "accept without correcting" threshold; the CDF is reported in
# full so any other choice can be read off the figure.
TAU_PX = [2.0, 5.0, 10.0, 20.0, 40.0]
TAU_MAIN = 20.0
MATCH_MAX_PX = 60.0     # a raw track further than this from every GT animal is unmatched


# --------------------------------------------------------------------- geometry ---
def triangulate_batch(uv, Ps, mask):
    """
    Vectorised DLT.

    uv    (C, M, 2) undistorted pixels
    Ps    (C, 3, 4)
    mask  (C, M) bool -- which views contribute to each point
    returns (M, 3), NaN where fewer than 2 views.
    """
    C, M, _ = uv.shape
    out = np.full((M, 3), np.nan)
    n = mask.sum(0)
    # Group points by which views they use, so each group is one batched SVD with a
    # fixed row count. With few cameras the number of distinct patterns is small.
    key = np.zeros(M, dtype=np.int64)
    for c in range(C):
        key |= (mask[c].astype(np.int64) << c)
    for k in np.unique(key):
        if k == 0:
            continue
        views = [c for c in range(C) if (k >> c) & 1]
        if len(views) < 2:
            continue
        sel = np.where(key == k)[0]
        A = np.empty((len(sel), 2 * len(views), 4))
        for i, c in enumerate(views):
            u = uv[c, sel, 0][:, None]
            v = uv[c, sel, 1][:, None]
            A[:, 2 * i] = u * Ps[c, 2] - Ps[c, 0]
            A[:, 2 * i + 1] = v * Ps[c, 2] - Ps[c, 1]
        # right singular vector of the smallest singular value
        _, _, Vt = np.linalg.svd(A, full_matrices=False)
        X = Vt[:, -1, :]
        w = X[:, 3:4]
        good = np.abs(w[:, 0]) > 1e-12
        res = np.full((len(sel), 3), np.nan)
        res[good] = X[good, :3] / w[good]
        out[sel] = res
    out[n < 2] = np.nan
    return out


def project(X, cam):
    """(M,3) -> (M,2) distorted pixels, NaN-safe."""
    out = np.full((X.shape[0], 2), np.nan)
    g = ~np.isnan(X).any(1)
    if g.any():
        pp, _ = cv2.projectPoints(X[g].astype(np.float64), cam["rvec"], cam["t"],
                                  cam["K"], cam["dist"])
        out[g] = pp.reshape(-1, 2)
    return out


def skeleton_edges(slp_path):
    """(name, [(i,j), ...]) from a .slp's skeleton, in node-index space."""
    with h5py.File(slp_path) as f:
        md = json.loads(f["metadata"].attrs["json"])
    nodes = [n["name"] for n in md["nodes"]]
    sk = md["skeletons"][0]
    # `links` source/target are indices into the skeleton's own node list, which is
    # the same order as `nodes` for SLEAP-written files.
    edges = sorted({(min(l["source"], l["target"]), max(l["source"], l["target"]))
                    for l in sk["links"]})
    return nodes, [e for e in edges if e[0] != e[1]]


# ------------------------------------------------------------------ per session ---
def measure_session(sid, stride, verbose=True):
    sd = f"{ROOT}/{sid}"
    calib = glob.glob(f"{sd}/calibration/*_calibration.toml")
    p3 = glob.glob(f"{sd}/*points3d*.h5")
    if not calib or not p3:
        return None
    cams_all = load_calibration(calib[0])
    if any(c not in cams_all for c in SERIALS):
        return None
    slps = {c: glob.glob(f"{sd}/{c}/*.analysis.h5") for c in SERIALS}
    if any(not v for v in slps.values()):
        return None

    with h5py.File(p3[0]) as f:
        Xp = f["tracks"][:]                      # (F3, A, N, 3) proofread, P-frame
        node_names = [n.decode() if isinstance(n, bytes) else str(n)
                      for n in f["node_names"][:]]
    raw = {c: load_sleap_2d(slps[c][0])[:, :2] for c in SERIALS}   # (F,T<=2,N,2)
    F = min(Xp.shape[0], min(v.shape[0] for v in raw.values()))
    A, N = Xp.shape[1], Xp.shape[2]
    C = len(SERIALS)
    Ps = np.stack([cams_all[c]["P"] for c in SERIALS], 0)

    # ---- P-frame -> calibration frame (same recipe the bench GT uses) ----
    samp = np.arange(0, F, max(1, F // 4000))
    und_s = np.stack([undistort(raw[c][samp], cams_all[c]["K"], cams_all[c]["dist"])
                      for c in SERIALS], 0)                     # (C,S,T,N,2)
    S = len(samp)
    uv = und_s.reshape(C, -1, 2)
    m = ~np.isnan(uv).any(-1)
    Xc = triangulate_batch(uv, Ps, m).reshape(S, A, N, 3)
    both = (~np.isnan(Xc).any(-1)) & (~np.isnan(Xp[samp]).any(-1))
    if both.sum() < 200:
        return None
    (s, R, t), aerr, inl = ransac_align(Xp[samp][both], Xc[both], thresh=8.0)
    align = dict(scale=float(s), inlier_frac=float(inl.mean()),
                 resid_med=float(np.median(aerr[inl])))

    # ---- analysis frames ----
    fidx = np.arange(0, F, stride)
    Fm = len(fidx)
    Xg = Xp[fidx].reshape(-1, 3)                    # proofread, P-frame
    g = ~np.isnan(Xg).any(1)
    Xcal = np.full_like(Xg, np.nan)
    Xcal[g] = (s * (R @ Xg[g].T).T + t)             # proofread in calibration frame
    M = Xcal.shape[0]                               # Fm*A*N

    # GT 2D per camera = the 3D-consistent label in that view
    gt2d = np.stack([project(Xcal, cams_all[c]) for c in SERIALS], 0)   # (C,M,2)

    # ---- match raw per-camera tracks to proofread animals (per frame, per view) ----
    obs = np.full((C, M, 2), np.nan)
    for ci, c in enumerate(SERIALS):
        r = raw[c][fidx]                                    # (Fm,T,N,2)
        T = r.shape[1]
        gt = gt2d[ci].reshape(Fm, A, N, 2)
        # cost = mean over visible nodes of |raw_t - gt_a|
        cost = np.full((Fm, A, T), np.inf)
        for a in range(A):
            for tt in range(T):
                d = np.linalg.norm(r[:, tt] - gt[:, a], axis=-1)   # (Fm,N)
                with np.errstate(invalid="ignore"):
                    cost[:, a, tt] = np.nanmean(d, axis=1)
        cost = np.nan_to_num(cost, nan=np.inf, posinf=np.inf)
        # 2x2 (or Ax T) assignment by brute force over permutations -- A,T <= 2
        best = np.zeros((Fm, A), dtype=np.int64) - 1
        perms = [p for p in itertools.permutations(range(T), min(A, T))]
        tot = np.stack([sum(cost[:, a, p[a]] for a in range(len(p))) for p in perms], 1)
        pick = np.argmin(tot, axis=1)
        for pi, p in enumerate(perms):
            rows = np.where(pick == pi)[0]
            for a in range(len(p)):
                best[rows, a] = p[a]
        take = np.full((Fm, A, N, 2), np.nan)
        for a in range(A):
            for tt in range(T):
                rows = np.where(best[:, a] == tt)[0]
                if len(rows):
                    ok = cost[rows, a, tt] < MATCH_MAX_PX
                    take[rows[ok], a] = r[rows[ok], tt]
        obs[ci] = take.reshape(-1, 2)

    have = ~np.isnan(obs).any(-1)                   # (C,M)
    complete = have.all(0) & ~np.isnan(Xcal).any(1)  # keypoints observed in every view
    retained = float(complete.mean())
    idx = np.where(complete)[0]
    if len(idx) < 500:
        return None

    obs_u = np.stack([undistort(obs[ci][idx], cams_all[SERIALS[ci]]["K"],
                                cams_all[SERIALS[ci]]["dist"]) for ci in range(C)], 0)
    gtk = gt2d[:, idx]                                  # (C,K,2) 3D-consistent target
    obk = obs[:, idx]                                   # (C,K,2) independent per-view
    K = len(idx)
    full_mask = np.ones((C, K), bool)

    # ---- rig geometry: where the cameras are, and how wide each pair's baseline is.
    # Baseline angle is the angle the two cameras subtend AT THE ANIMALS, which is what
    # actually conditions a two-view solve: a narrow pair resolves depth badly however
    # good its 2D is. The vertex is the mean proofread 3D point, i.e. the real animals,
    # not a guess at the arena centre.
    campos = {}
    for c in SERIALS:
        cc = cams_all[c]
        campos[c] = (-cc["R"].T @ np.asarray(cc["t"]).reshape(3))
    vertex = np.nanmean(Xcal[idx], axis=0)
    baseline = {}
    for i, j in itertools.combinations(range(C), 2):
        va = campos[SERIALS[i]] - vertex
        vb = campos[SERIALS[j]] - vertex
        cosang = float(va @ vb / (np.linalg.norm(va) * np.linalg.norm(vb)))
        baseline[f"{i}-{j}"] = float(np.degrees(np.arccos(np.clip(cosang, -1, 1))))

    # =========================== A. anchor-pair sufficiency ======================
    # residual, in the views NOT used as anchors, between the reprojection of the
    # 2-anchor triangulation and where the keypoint actually is.
    pair_res = {}
    held_all = []
    for i, j in itertools.combinations(range(C), 2):
        mk = np.zeros((C, K), bool)
        mk[i] = mk[j] = True
        Xh = triangulate_batch(obs_u, Ps, mk)
        rs = []
        for c in range(C):
            if c in (i, j):
                continue
            p = project(Xh, cams_all[SERIALS[c]])
            rs.append(np.linalg.norm(p - gtk[c], axis=1))
        r = np.concatenate(rs)
        r = r[np.isfinite(r)]
        pair_res[f"{i}-{j}"] = r
        held_all.append(r)
    held_all = np.concatenate(held_all)

    # Same thing measured against the held-out view's OWN independent 2D observation
    # rather than the reprojected proofread 3D. The proofread 3D was built from all
    # five views, so it is not independent of the anchors; this variant is, and it
    # bounds how much of the residual is "2 anchors are not enough" versus shared noise.
    held_obs = []
    for i, j in itertools.combinations(range(C), 2):
        mk = np.zeros((C, K), bool)
        mk[i] = mk[j] = True
        Xh = triangulate_batch(obs_u, Ps, mk)
        for c in range(C):
            if c in (i, j):
                continue
            p = project(Xh, cams_all[SERIALS[c]])
            held_obs.append(np.linalg.norm(p - obk[c], axis=1))
    held_obs = np.concatenate(held_obs)
    held_obs = held_obs[np.isfinite(held_obs)]

    # anchor-count sweep k = 2..C (all combinations at each k), in pixels AND in mm.
    # The mm number is the accuracy a labeller gives up by accepting a reprojection
    # instead of placing the keypoint in every view: 3D distance from the k-anchor
    # triangulation to the fully-informed proofread 3D. `mm_per_unit` converts the
    # calibration frame to millimetres via the recovered metric scale.
    mm_per_unit = (1.0 / s) * 1000.0
    Xpf = Xcal[idx]
    by_k, err3d = {}, {}
    for k in range(2, C + 1):
        rs, es = [], []
        for combo in itertools.combinations(range(C), k):
            mk = np.zeros((C, K), bool)
            for c in combo:
                mk[c] = True
            Xh = triangulate_batch(obs_u, Ps, mk)
            es.append(np.linalg.norm(Xh - Xpf, axis=1) * mm_per_unit)
            for c in range(C):
                if c in combo:
                    continue
                p = project(Xh, cams_all[SERIALS[c]])
                rs.append(np.linalg.norm(p - gtk[c], axis=1))
        if rs:
            r = np.concatenate(rs)
            by_k[k] = r[np.isfinite(r)]
        if es:
            e = np.concatenate(es)
            err3d[k] = e[np.isfinite(e)]

    # Per-PAIR 3D error. The pooled k=2 number averages over every pair including the
    # badly conditioned ones; a labeller picks a pair, so the per-pair breakdown is the
    # number that actually tells them what to do.
    mm_per_unit_ = (1.0 / s) * 1000.0
    pair3d = {}
    for i, j in itertools.combinations(range(C), 2):
        mk = np.zeros((C, K), bool)
        mk[i] = mk[j] = True
        Xh = triangulate_batch(obs_u, Ps, mk)
        e = np.linalg.norm(Xh - Xcal[idx], axis=1) * mm_per_unit_
        e = e[np.isfinite(e)]
        if len(e):
            pair3d[f"{i}-{j}"] = dict(
                n=int(len(e)), baseline_deg=baseline[f"{i}-{j}"],
                p25=float(np.percentile(e, 25)), p50=float(np.median(e)),
                p75=float(np.percentile(e, 75)), p90=float(np.percentile(e, 90)))

    # =================== B. cross-view geometric consistency =====================
    # 3D from ALL views' independent 2D, and how badly those views then disagree.
    Xind = triangulate_batch(obs_u, Ps, full_mask)
    resid = np.full((C, K), np.nan)
    for c in range(C):
        p = project(Xind, cams_all[SERIALS[c]])
        resid[c] = np.linalg.norm(p - obk[c], axis=1)
    with np.errstate(invalid="ignore"):
        rms_ind = np.sqrt(np.nanmean(resid ** 2, axis=0))     # per keypoint, px

    # bone lengths under both conditions, on the identical keypoint set
    slp0 = glob.glob(f"{sd}/{SERIALS[0]}/*.slp")
    edges = skeleton_edges(slp0[0])[1] if slp0 else []
    lab = np.full(M, -1, dtype=np.int64)
    lab[idx] = np.arange(K)
    lab = lab.reshape(Fm, A, N)
    bones = {}
    for (ni, nj) in edges:
        ii, jj = lab[:, :, ni].ravel(), lab[:, :, nj].ravel()
        ok = (ii >= 0) & (jj >= 0)
        if ok.sum() < 200:
            continue
        d_ind = np.linalg.norm(Xind[ii[ok]] - Xind[jj[ok]], axis=1)
        d_pf = np.linalg.norm(Xcal.reshape(Fm, A, N, 3)[:, :, ni].reshape(-1, 3)[ok]
                              - Xcal.reshape(Fm, A, N, 3)[:, :, nj].reshape(-1, 3)[ok],
                              axis=1)
        r_pair = np.sqrt((rms_ind[ii[ok]] ** 2 + rms_ind[jj[ok]] ** 2) / 2.0)
        f_ind, f_pf = np.isfinite(d_ind), np.isfinite(d_pf)
        if f_ind.sum() < 200 or f_pf.sum() < 200:
            continue
        name = f"{node_names[ni]}-{node_names[nj]}" if ni < len(node_names) else f"{ni}-{nj}"
        bones[name] = dict(
            n=int(ok.sum()),
            ind_med=float(np.median(d_ind[f_ind])),
            ind_cv=float(np.std(d_ind[f_ind]) / np.mean(d_ind[f_ind])),
            ind_iqr=float(np.subtract(*np.percentile(d_ind[f_ind], [75, 25]))),
            pf_med=float(np.median(d_pf[f_pf])),
            pf_cv=float(np.std(d_pf[f_pf]) / np.mean(d_pf[f_pf])),
            pf_iqr=float(np.subtract(*np.percentile(d_pf[f_pf], [75, 25]))),
            # mechanism: bone-length deviation vs how much the views disagreed
            resid_vs_devn=_binned_dev(r_pair, d_ind, f_ind),
        )

    def q(a, ps=(5, 25, 50, 75, 90, 95, 99)):
        a = a[np.isfinite(a)]
        return {f"p{p}": float(np.percentile(a, p)) for p in ps} if len(a) else {}

    return dict(
        session=sid, frames_total=int(F), frames_used=int(Fm), stride=int(stride),
        cameras=len(SERIALS), animals=int(A), nodes=int(N),
        keypoints_used=int(K), retained_frac=retained, align=align,
        scale_m_per_unit=float(1.0 / s) if s else None,
        anchor_pairs={k: dict(q(v), n=int(len(v)),
                              **{f"acc{int(t)}": float((v <= t).mean()) for t in TAU_PX})
                      for k, v in pair_res.items()},
        held_out=dict(q(held_all), n=int(len(held_all)),
                      **{f"acc{int(t)}": float((held_all <= t).mean()) for t in TAU_PX}),
        held_out_vs_observation=dict(q(held_obs), n=int(len(held_obs)),
                                     **{f"acc{int(t)}": float((held_obs <= t).mean())
                                        for t in TAU_PX}),
        by_anchor_count={str(k): dict(q(v), n=int(len(v)),
                                      **{f"acc{int(t)}": float((v <= t).mean())
                                         for t in TAU_PX})
                         for k, v in by_k.items()},
        err3d_mm_by_anchor_count={str(k): dict(q(v), n=int(len(v)), mean=float(v.mean()))
                                  for k, v in err3d.items()},
        mm_per_unit=float(mm_per_unit),
        crossview_resid=dict(q(rms_ind), n=int(np.isfinite(rms_ind).sum()),
                             **{f"acc{int(t)}": float((rms_ind[np.isfinite(rms_ind)] <= t).mean())
                                for t in TAU_PX}),
        bones=bones,
        cameras_xyz={c: [float(v) for v in campos[c]] for c in SERIALS},
        baseline_deg=baseline,
        err3d_mm_by_pair=pair3d,
    )


def _binned_dev(resid, length, finite):
    """Median |length - median(length)| in bins of cross-view residual (the mechanism)."""
    r, d = resid[finite], length[finite]
    ok = np.isfinite(r) & np.isfinite(d)
    r, d = r[ok], d[ok]
    if len(r) < 200:
        return []
    med = np.median(d)
    bins = [0, 2, 5, 10, 20, 40, np.inf]
    out = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        s = (r >= lo) & (r < hi)
        if s.sum() >= 30:
            out.append(dict(lo=float(lo), hi=(None if hi == np.inf else float(hi)),
                            n=int(s.sum()), dev=float(np.median(np.abs(d[s] - med)))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=6,
                    help="how many sessions to measure (0 = all runnable)")
    ap.add_argument("--stride", type=int, default=200,
                    help="frame subsample stride (uniform, not selective)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    sids = sorted(os.path.basename(p) for p in glob.glob(f"{ROOT}/*")
                  if os.path.isdir(p) and os.path.basename(p)[0].isdigit())
    results, used = [], []
    for sid in sids:
        if args.sessions and len(results) >= args.sessions:
            break
        try:
            r = measure_session(sid, args.stride)
        except Exception as e:                                    # noqa: BLE001
            print(f"  {sid}: FAIL {type(e).__name__}: {e}")
            continue
        if r is None:
            print(f"  {sid}: skip (missing inputs / too little overlap)")
            continue
        results.append(r)
        used.append(sid)
        print(f"  {sid}: K={r['keypoints_used']} retained={r['retained_frac']:.2f} "
              f"held-out median={r['held_out'].get('p50', float('nan')):.2f} px  "
              f"acc@{int(TAU_MAIN)}={r['held_out'].get(f'acc{int(TAU_MAIN)}', float('nan')):.3f}  "
              f"xview p50={r['crossview_resid'].get('p50', float('nan')):.2f} px")

    if not results:
        raise SystemExit("no sessions measured")

    payload = dict(
        dataset="BMimica (5 calibrated cameras, 2 mice, 15-node skeleton)",
        root=ROOT, sessions=used, n_sessions=len(results),
        tau_px=TAU_PX, tau_main=TAU_MAIN,
        app_reproj_sigma_px=20.0,
        per_session=results,
    )
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"\n[json] {args.out}  {os.path.getsize(args.out)/1024:.0f} KB  "
          f"{len(results)} sessions")


if __name__ == "__main__":
    main()
