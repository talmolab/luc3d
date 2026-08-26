#!/usr/bin/env python3
"""
TRUE raw-detection quality on SLAP-2M, by difficulty — and the test that decides
whether reprojection error is a useful proofreading triage signal.

WHY THIS EXISTS. `figs/fig5_difficulty.py` compares each camera's PROOFREAD 2D labels
against the proofread 3D reprojected into that camera. Both sides come from the
proofread data, because every `{cam}_inference_h5` column in the master sheets points at
a `*.predictions.proofread.slp.analysis.h5` — there is no raw-prediction analysis h5 on
disk. That script therefore measures the reconstruction's own 2D-to-3D residual and its
per-camera label coverage, which is a real thing but is NOT detector performance.

This script uses the actual raw detections: the benchmark's shared pool at
`$BENCH/outputs/keeptrack_h5s/{cam}_predictions.h5`, whose attrs record
`source = "filter-only detections (no tracking)"` — identity-stripped SLEAP output, 5
detections per frame ordered score-descending, with `det_scores`. Session axis is the
row index into `$BENCH/outputs/detections_only_master_sheet.tsv` (74 sessions), the same
indexing `luc3d-bench/scripts/evaluate.py` uses (`f["tracks"][session_idx]`).

TWO MEASUREMENTS
----------------
A. DETECTION QUALITY BY DIFFICULTY (the corrected Fig 6). Match the raw detections to
   the reference animals per frame per camera, then report, per session:
     * detection error   |raw − reference| for matched keypoints, MEAN plus the tail
     * miss rate         reference keypoint present, no matched raw detection covering it
   Reference = the proofread 3D reprojected into that camera, which is identity-
   consistent across cameras by construction.

B. IS REPROJECTION ERROR A USEFUL TRIAGE SIGNAL? (the non-tautological Fig 5 claim.)
   Showing that "ranking by reprojection error finds keypoints with high reprojection
   error" is circular. The claim that matters is that reprojection error — computable
   from raw detections and the calibration alone, with NO ground truth — predicts where
   the human actually had to intervene. So for every keypoint:
     signal   cross-view reprojection residual of the 3D triangulated from the RAW
              detections across cameras. Available at proofreading time.
     target   |raw − proofread reference|, i.e. how far the keypoint actually had to
              move. Needs the answer, so it is what we are trying to predict.
   Then rank by `signal` and measure how much of the total `target` is captured, and
   compare against ranking by the detector's own confidence (`det_scores`), which is
   the obvious alternative a reviewer will propose. Both rankings are scored on the
   identical keypoint set.

   Cross-view identity for the triangulation is taken from the reference match, so this
   assumes association is already correct. That is the right assumption here — it is a
   separate step (Fig 3) that the user has already run before proofreading — and it is
   stated in the output caveats.

Run with the bench env:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig5_detections.py --jobs 12

EVERY FRAME. `--stride` defaults to 1; it was 120 (0.8% of frames, 1,561,915 keypoint
comparisons) until the full-data re-run, and is now 187,134,382 comparisons over the
same 74 sessions. Full density costs 79 s wall on 12 processes and ~2.5 GB in the
largest session, so subsampling bought nothing. Sessions are independent, which is all
`--jobs` exploits; the parallel and serial paths were checked to produce identical JSON.

Writes figs/out/fig6_detections.json.
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import os
import sys

import cv2
import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/bartul")
from build_gt_reproj import load_calibration  # noqa: E402
from fig2_measure import triangulate_batch  # noqa: E402

BENCH = "/root/vast/eric/luc3d-bench"
MASTER = f"{BENCH}/outputs/detections_only_master_sheet.tsv"
POOL = f"{BENCH}/outputs/keeptrack_h5s"
SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
OUT = os.path.join(HERE, "out", "fig6_detections.json")

TAU_PX = 20.0          # the app's own reprojection tolerance (reprojSigma)
MATCH_MAX_PX = 60.0    # a detection further than this from every reference animal is unmatched


def q(a, ps=(50, 90, 95, 99)):
    a = np.asarray(a)
    a = a[np.isfinite(a)]
    if not len(a):
        return None
    out = {"n": int(len(a)), "mean": float(a.mean())}
    out.update({f"p{p}": float(np.percentile(a, p)) for p in ps})
    out["max"] = float(a.max())
    return out


def load_reference(path, stride):
    """(F, T, N, 2) proofread 3D reprojected into one camera."""
    with h5py.File(path, "r") as f:
        arr = f["tracks"][:, :, :, ::stride]      # (T, 2, N, F)
    return np.transpose(arr, (3, 0, 2, 1))


def load_raw(cam, sidx, stride, nframes):
    """(F, D, N, 2) raw detections + (F, D) scores for one camera/session."""
    p = f"{POOL}/{cam}_predictions.h5"
    with h5py.File(p, "r") as f:
        tr = f["tracks"]
        ds = f["det_scores"]
        if sidx >= tr.shape[0]:
            raise IndexError(f"session index {sidx} >= {tr.shape[0]} in {cam}")
        n = min(nframes, tr.shape[1])
        return (tr[sidx, :n:stride], ds[sidx, :n:stride])


def match_frame_wise(raw, ref):
    """
    Assign raw detections to reference animals per frame by mean keypoint distance.

    raw: (F, D, N, 2)   ref: (F, T, N, 2)
    Returns matched (F, T, N, 2) raw coordinates (NaN where unmatched) and the index of
    the detection assigned to each animal (-1 where none).
    """
    F, D, N, _ = raw.shape
    T = ref.shape[1]
    cost = np.full((F, T, D), np.inf)
    for a in range(T):
        for b in range(D):
            with np.errstate(invalid="ignore"):
                cost[:, a, b] = np.nanmean(
                    np.linalg.norm(raw[:, b] - ref[:, a], axis=-1), axis=1)
    cost = np.nan_to_num(cost, nan=np.inf, posinf=np.inf)

    # T and D are small (<=4 and 5); brute-force the assignment
    perms = list(itertools.permutations(range(D), T))
    tot = np.stack([sum(cost[:, a, p[a]] for a in range(T)) for p in perms], 1)
    pick = np.argmin(tot, axis=1)

    out = np.full((F, T, N, 2), np.nan)
    which = np.full((F, T), -1, dtype=np.int64)
    for pi, p in enumerate(perms):
        rows = np.where(pick == pi)[0]
        if not len(rows):
            continue
        for a in range(T):
            ok = cost[rows, a, p[a]] < MATCH_MAX_PX
            sel = rows[ok]
            if len(sel):
                out[sel, a] = raw[sel, p[a]]
                which[sel, a] = p[a]
    return out, which


def measure_session(row, sidx, stride):
    sd = os.path.join(SLAP_ROOT, os.path.dirname(row["points_3D"]))
    calib_p = os.path.join(sd, "calibration.toml")
    if not os.path.exists(calib_p):
        return None
    cams_all = load_calibration(calib_p)
    use = [c for c in CAMS if c in cams_all and (row.get(f"{c}_reproj_h5") or "")]
    if len(use) < 3:
        return None

    ref, matched, scores = {}, {}, {}
    for c in use:
        rp = row[f"{c}_reproj_h5"]
        rp = rp if os.path.isabs(rp) else os.path.join(SLAP_ROOT, rp)
        if not os.path.exists(rp):
            return None
        R = load_reference(rp, stride)
        try:
            raw, sc = load_raw(c, sidx, stride, R.shape[0] * stride)
        except Exception:                                             # noqa: BLE001
            return None
        F = min(R.shape[0], raw.shape[0])
        R = R[:F]
        m, which = match_frame_wise(raw[:F], R)
        ref[c] = R
        matched[c] = m
        # score of whichever detection was assigned to each animal
        sfull = np.full(which.shape, np.nan)
        for a in range(which.shape[1]):
            got = which[:, a] >= 0
            sfull[got, a] = sc[:F][got, which[got, a]]
        scores[c] = sfull

    C = len(use)
    F, T, N, _ = ref[use[0]].shape

    # ---------- A. detection error + miss rate ----------
    err_all, miss_n, tot_n = [], 0, 0
    for c in use:
        have_r = ~np.isnan(ref[c]).any(-1)
        have_m = ~np.isnan(matched[c]).any(-1)
        tot_n += int(have_r.sum())
        miss_n += int((have_r & ~have_m).sum())
        both = have_r & have_m
        if both.any():
            err_all.append(np.linalg.norm(matched[c][both] - ref[c][both], axis=-1))
    if not err_all:
        return None
    err = np.concatenate(err_all)

    # ---------- B. triage signal vs target ----------
    # triangulate the RAW matched detections across cameras (no ground truth used
    # beyond the identity assignment), then measure how far each view's raw detection
    # sits from that consensus -- the signal -- against how far it sits from the
    # proofread reference -- the target.
    Ps = np.stack([cams_all[c]["P"] for c in use], 0)
    uv = np.stack([matched[c].reshape(-1, 2) for c in use], 0)         # (C, M, 2)
    # undistort for triangulation; the pool detections are in native pixels
    und = np.empty_like(uv)
    for i, c in enumerate(use):
        flat = uv[i].copy()
        ok = ~np.isnan(flat).any(1)
        if ok.any():
            u = cv2.undistortPoints(flat[ok].reshape(-1, 1, 2), cams_all[c]["K"],
                                    cams_all[c]["dist"], P=cams_all[c]["K"])
            flat[ok] = u.reshape(-1, 2)
        und[i] = flat
    mask = ~np.isnan(und).any(-1)
    X = triangulate_batch(und, Ps, mask)                              # (M, 3)

    sig, tgt, conf = [], [], []
    for i, c in enumerate(use):
        cam = cams_all[c]
        good = ~np.isnan(X).any(1) & mask[i]
        if not good.any():
            continue
        pp, _ = cv2.projectPoints(X[good].astype(np.float64), cam["rvec"], cam["t"],
                                  cam["K"], cam["dist"])
        proj = pp.reshape(-1, 2)
        raw_i = uv[i][good]
        ref_i = ref[c].reshape(-1, 2)[good]
        s = np.linalg.norm(proj - raw_i, axis=1)          # signal: cross-view residual
        t = np.linalg.norm(raw_i - ref_i, axis=1)         # target: distance to proofread
        cf = np.repeat(scores[c].reshape(-1), N)[good]    # detector confidence
        keep = np.isfinite(s) & np.isfinite(t)
        sig.append(s[keep])
        tgt.append(t[keep])
        conf.append(cf[keep])
    if not sig:
        return None
    sig = np.concatenate(sig)
    tgt = np.concatenate(tgt)
    conf = np.concatenate(conf)

    def capture(rank_desc, payload, fracs=(0.01, 0.05, 0.10, 0.20)):
        """Share of total `payload` captured by reviewing the top `frac` by `rank_desc`."""
        order = np.argsort(-rank_desc, kind="stable")
        cum = np.cumsum(payload[order])
        total = cum[-1] if len(cum) else 0.0
        if total <= 0:
            return {}
        return {str(fr): float(cum[max(0, int(fr * len(order)) - 1)] / total)
                for fr in fracs}

    finite = np.isfinite(conf)
    return dict(
        session=row["session"], session_idx=sidx,
        difficulty=int(row["difficulty"]), bedding=row["bedding"],
        animals=int(row["animals"]), cameras_used=len(use),
        frames_total=int(row["frames"] or 0),
        det_error=q(err), miss_rate=float(miss_n / tot_n) if tot_n else None,
        frac_over_tau=float((err > TAU_PX).mean()),
        n_keypoints=int(len(err)),
        # B
        signal=q(sig), target=q(tgt),
        spearman=float(_spearman(sig, tgt)),
        capture_by_reproj=capture(sig, tgt),
        # confidence is "higher = better", so rank by its NEGATIVE (least confident first)
        capture_by_lowconf=(capture(-conf[finite], tgt[finite]) if finite.any() else {}),
        capture_by_oracle=capture(tgt, tgt),
        n_triage=int(len(sig)),
    )


def _spearman(a, b):
    """Rank correlation without scipy, so this runs in any of the envs here."""
    if len(a) < 3:
        return float("nan")
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    ra -= ra.mean()
    rb -= rb.mean()
    d = np.sqrt((ra ** 2).sum() * (rb ** 2).sum())
    return float((ra * rb).sum() / d) if d else float("nan")


def _one(job):
    """(sidx, row, stride) -> (sidx, session name, result | None, error | None).

    Module-level and picklable so `--jobs` can hand it to a process pool. Sessions
    are independent -- separate files, separate h5 handles, no shared state -- so
    the only thing the pool changes is which order the progress lines print in,
    which is why results are re-sorted by session index before aggregation.
    """
    sidx, row, stride = job
    try:
        return sidx, row["session"], measure_session(row, sidx, stride), None
    except Exception as e:                                            # noqa: BLE001
        return sidx, row["session"], None, f"{type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser()
    #: FRAME STRIDE. 1 = every frame. The default was 120 (0.8% of frames) when this
    #: was written; at stride 1 a median 18k-frame session costs ~5 s and ~0.5 GB, so
    #: the whole 74-session corpus runs in minutes and there is no reason to subsample.
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--max-sessions", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=1,
                    help="processes to spread sessions over (1 = serial)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MASTER), delimiter="\t"))
    print(f"master: {len(rows)} sessions (pool session axis = row index)")
    if args.max_sessions:
        rows = rows[:args.max_sessions]
    jobs = [(sidx, row, args.stride) for sidx, row in enumerate(rows)]

    if args.jobs > 1:
        import concurrent.futures as cf
        with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
            results = list(ex.map(_one, jobs))
    else:
        results = [_one(j) for j in jobs]

    done = []
    for sidx, name, r, err in sorted(results, key=lambda t: t[0]):
        if err is not None:
            print(f"  [{sidx}] {name}: FAIL {err}")
            continue
        if r is None:
            print(f"  [{sidx}] {name}: skip (missing inputs)")
            continue
        done.append(r)
        print(f"  [{sidx}] {r['session']}: diff {r['difficulty']} "
              f"err mean {r['det_error']['mean']:6.2f} p95 {r['det_error']['p95']:6.2f} "
              f"miss {r['miss_rate'] * 100:5.1f}%  "
              f"rho {r['spearman']:.3f}  "
              f"reproj@10% {r['capture_by_reproj'].get('0.1', float('nan')):.3f} "
              f"vs lowconf {r['capture_by_lowconf'].get('0.1', float('nan')):.3f}")

    if not done:
        raise SystemExit("nothing measured")

    def group(key):
        g = {}
        for s in done:
            g.setdefault(str(s[key]), []).append(s)

        def m(v, path):
            vals = []
            for x in v:
                o = x
                for p in path:
                    o = o.get(p) if isinstance(o, dict) else None
                    if o is None:
                        break
                if isinstance(o, (int, float)) and np.isfinite(o):
                    vals.append(o)
            return float(np.mean(vals)) if vals else None

        return {k: dict(
            n_sessions=len(v),
            n_keypoints=int(sum(x["n_keypoints"] for x in v)),
            err_mean=m(v, ["det_error", "mean"]),
            err_p50=m(v, ["det_error", "p50"]),
            err_p95=m(v, ["det_error", "p95"]),
            err_p99=m(v, ["det_error", "p99"]),
            miss_rate=m(v, ["miss_rate"]),
            frac_over_tau=m(v, ["frac_over_tau"]),
            spearman=m(v, ["spearman"]),
            capture_reproj_10=m(v, ["capture_by_reproj", "0.1"]),
            capture_lowconf_10=m(v, ["capture_by_lowconf", "0.1"]),
            capture_oracle_10=m(v, ["capture_by_oracle", "0.1"]),
            err_mean_sd=(float(np.std([x["det_error"]["mean"] for x in v]))
                         if len(v) > 1 else 0.0),
            miss_rate_sd=(float(np.std([x["miss_rate"] for x in v]))
                          if len(v) > 1 else 0.0),
        ) for k, v in sorted(g.items(), key=lambda kv: float(kv[0]))}

    payload = dict(
        generated_by="figs/fig5_detections.py", dataset="SLAP-2M",
        master_sheet=MASTER, detection_pool=POOL, tau_px=TAU_PX,
        stride=args.stride, n_sessions=len(done),
        by_difficulty=group("difficulty"), by_animals=group("animals"),
        sessions=done,
        caveats=[
            "Raw detections come from the benchmark's shared identity-stripped pool "
            "(attrs source='filter-only detections (no tracking)'), 5 detections per "
            "frame ordered score-descending.",
            "The reference is the proofread 3D reprojected into each camera, so the "
            "reference carries its own reconstruction error; detection error is "
            "agreement with the proofread answer, not absolute accuracy.",
            "Detections are assigned to reference animals per frame per camera by mean "
            "keypoint distance, so a long identity swap by the detector appears as "
            "error rather than as a swap.",
            "The triage analysis takes cross-view identity from that reference match, "
            "i.e. it assumes association is already correct -- a separate step the user "
            "runs before proofreading.",
            "Frames are uniformly strided, never selected.",
        ])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)

    print("\nby difficulty (mean across sessions):")
    print(f"  {'diff':>4} {'n':>3} {'err mean':>9} {'err p95':>8} {'miss%':>7} "
          f"{'rho':>6} {'reproj@10%':>11} {'lowconf@10%':>12} {'oracle@10%':>11}")
    for k, v in payload["by_difficulty"].items():
        print(f"  {k:>4} {v['n_sessions']:>3} {v['err_mean']:>9.2f} "
              f"{v['err_p95']:>8.2f} {v['miss_rate'] * 100:>7.1f} "
              f"{v['spearman']:>6.3f} {v['capture_reproj_10']:>11.3f} "
              f"{(v['capture_lowconf_10'] or float('nan')):>12.3f} "
              f"{v['capture_oracle_10']:>11.3f}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
