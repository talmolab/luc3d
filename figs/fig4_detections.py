#!/usr/bin/env python3
"""
TRUE raw-detection quality on SLAP-2M, by difficulty.

WHY THIS EXISTS. `figs/fig4_difficulty.py` compares each camera's PROOFREAD 2D labels
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

THE MEASUREMENT
---------------
DETECTION QUALITY BY DIFFICULTY (the corrected Fig 6). Match the raw detections to
   the reference animals per frame per camera, then report, per session:
     * detection error   |raw − reference| for matched keypoints, MEAN plus the tail
     * miss rate         reference keypoint present, no matched raw detection covering it
   Reference = the proofread 3D reprojected into that camera, which is identity-
   consistent across cameras by construction.

PART B REMOVED (2026-10-21, LUC3D-JS plan J9). This script also had a "triage" analysis
that triangulated the raw detections with fig2_measure.py's NumPy DLT + OpenCV and
reprojected them. That is a Python reimplementation of LUC3D's geometry, no panel or tex
sentence used it, and it is gone. Its fields (signal, target, spearman, capture_*) are not
in deposits written after this date. The last version with it:
out/md56_logs/fig4_detections.before_partB_removal_2026-10-21.py.

Run with the bench env:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig4_detections.py --jobs 12

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

import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/bartul")
from build_gt_reproj import load_calibration  # noqa: E402

BENCH = "/root/vast/eric/luc3d-bench"
MASTER = f"{BENCH}/outputs/detections_only_master_sheet.tsv"
POOL = f"{BENCH}/outputs/keeptrack_h5s"
SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
NODE_NAMES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0", "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left", "Haunch_right", "Neck"]
OUT = os.path.join(HERE, "out", "fig6_detections.json")

TAU_PX = 20.0          # the app's own reprojection tolerance (reprojSigma)
MATCH_MAX_PX = 60.0    # a detection further than this from every reference animal is unmatched


def q(a, ps=(50, 75, 80, 90, 95, 98, 99)):
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


#: --detections proofread swaps the raw pool for the PROOFREAD per-camera 2D labels
#: (the `{cam}_inference_h5` analysis files, which the 3D was triangulated from) so the
#: same measurement reports what the proofreaders could see -- the occlusion floor,
#: not detector quality (2026-10-06, the Fig 4 proofread variant).
DETECTIONS = os.environ.get("FIG4_DETECTIONS", "raw")
_ROW_FOR_SIDX = {}


def load_proofread(cam, sidx, stride, nframes):
    """(F, D, N, 2) proofread 2D labels + (F, D) unit scores, in the raw-pool shape."""
    rp = _ROW_FOR_SIDX[sidx][f"{cam}_inference_h5"]
    rp = rp if os.path.isabs(rp) else os.path.join(SLAP_ROOT, rp)
    with h5py.File(rp, "r") as f:
        a = np.transpose(f["tracks"][:], (3, 0, 2, 1))              # (F, T, N, 2)
    a = a[:nframes:stride]
    sc = np.where(np.isfinite(a[..., 0]).any(-1), 1.0, np.nan)        # (F, T)
    return a, sc


def load_raw(cam, sidx, stride, nframes):
    """(F, D, N, 2) raw detections + (F, D) scores for one camera/session."""
    if DETECTIONS == "proofread":
        return load_proofread(cam, sidx, stride, nframes)
    # FIG4_POOL: another detection pool in the keeptrack layout (e.g. the pre-proofreading
    # *.predictions.slp packed by figs/build_predslp_pool.py, 2026-10-06)
    p = f"{os.environ.get('FIG4_POOL', POOL)}/{cam}_predictions.h5"
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

    ref, matched = {}, {}
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
        # --exclude-nodes: drop the listed skeleton nodes from both sides before
        # anything is counted (the no-tail variant of Fig 4, 2026-10-06)
        _ex = [n for n in os.environ.get("FIG4_EXCLUDE_NODES", "").split(",") if n]
        if _ex:
            _keep = [i for i, n in enumerate(NODE_NAMES) if n not in _ex]
            R = R[:, :, _keep]
            m = m[:, :, _keep]
        ref[c] = R
        matched[c] = m

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

    out = dict(
        session=row["session"], session_idx=sidx,
        difficulty=int(row["difficulty"]), bedding=row["bedding"],
        animals=int(row["animals"]), cameras_used=len(use),
        frames_total=int(row["frames"] or 0),
        det_error=q(err), miss_rate=float(miss_n / tot_n) if tot_n else None,
        frac_over_tau=float((err > TAU_PX).mean()),
        n_keypoints=int(len(err)),
    )
    return out


def _one(job):
    """(sidx, row, stride) -> (sidx, session name, result | None, error | None).

    Module-level and picklable so `--jobs` can hand it to a process pool. Sessions
    are independent -- separate files, separate h5 handles, no shared state -- so
    the only thing the pool changes is which order the progress lines print in,
    which is why results are re-sorted by session index before aggregation.
    """
    sidx, row, stride = job
    _ROW_FOR_SIDX[sidx] = row
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
    ap.add_argument("--detections", default="raw", choices=["raw", "proofread"])
    ap.add_argument("--exclude-nodes", default="",
                    help="comma-separated node names dropped from every measurement, "
                         "e.g. TailTip,Tail_0,Tail_1,Tail_2 for the no-tail variant")
    args = ap.parse_args()
    global DETECTIONS
    DETECTIONS = args.detections
    os.environ["FIG4_DETECTIONS"] = args.detections
    os.environ["FIG4_EXCLUDE_NODES"] = args.exclude_nodes

    rows = list(csv.DictReader(open(MASTER), delimiter="\t"))
    print(f"master: {len(rows)} sessions (pool session axis = row index)")
    if args.max_sessions:
        rows = rows[:args.max_sessions]
    jobs = [(sidx, row, args.stride) for sidx, row in enumerate(rows)]
    _ROW_FOR_SIDX.update({sidx: row for sidx, row in enumerate(rows)})

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
              f"miss {r['miss_rate'] * 100:5.1f}%")

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
            err_p75=m(v, ["det_error", "p75"]),
            err_p80=m(v, ["det_error", "p80"]),
            err_p95=m(v, ["det_error", "p95"]),
            err_p98=m(v, ["det_error", "p98"]),
            err_p99=m(v, ["det_error", "p99"]),
            miss_rate=m(v, ["miss_rate"]),
            frac_over_tau=m(v, ["frac_over_tau"]),
            err_mean_sd=(float(np.std([x["det_error"]["mean"] for x in v]))
                         if len(v) > 1 else 0.0),
            miss_rate_sd=(float(np.std([x["miss_rate"] for x in v]))
                          if len(v) > 1 else 0.0),
        ) for k, v in sorted(g.items(), key=lambda kv: float(kv[0]))}

    payload = dict(
        generated_by="figs/fig4_detections.py", dataset="SLAP-2M",
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
            "Frames are uniformly strided, never selected.",
        ])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)

    print("\nby difficulty (mean across sessions):")
    print(f"  {'diff':>4} {'n':>3} {'err mean':>9} {'err p95':>8} {'miss%':>7}")
    for k, v in payload["by_difficulty"].items():
        print(f"  {k:>4} {v['n_sessions']:>3} {v['err_mean']:>9.2f} "
              f"{v['err_p95']:>8.2f} {v['miss_rate'] * 100:>7.1f}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
