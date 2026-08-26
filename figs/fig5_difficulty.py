#!/usr/bin/env python3
"""
Fig 6 — characterise the SLAP-2M corpus BY DIFFICULTY, from real files.

WHAT THIS MEASURES, PRECISELY. Read this before quoting any number from it.

Per session and camera it compares two things, BOTH derived from the proofread data:

  reference  `{cam}_reproj_h5` = the proofread 3D reconstruction PROJECTED into that
             camera. It exists wherever the 3D exists, i.e. wherever at least two
             cameras contributed a proofread label.
  observed   `{cam}_inference_h5` = that camera's PROOFREAD 2D labels. Despite the
             column name, every one of the 252 entries in `_multi_master.tsv` points at
             a `*.predictions.proofread.slp.analysis.h5`. There is NO raw-prediction
             analysis h5 on disk. An earlier version of this script described the
             comparison as "raw predictions versus proofread"; that was WRONG and the
             figure was relabelled.

So the two reported quantities are:

  err       |proofread 2D label − reprojected 3D| in that view. This is the proofread
            reconstruction's OWN 2D-to-3D residual: how well a single 3D object can
            explain the human's per-view labels. Not detector error.
  miss_rate fraction of keypoints where the 3D exists but THIS camera has no proofread
            label. That happens when the annotator did not label that keypoint in that
            view -- typically because the animal was occluded there -- and the 3D was
            supplied by the other views instead. It is per-camera label COVERAGE
            relative to the reconstruction, not a detector miss.

Both are legitimate and on-message: they say that on harder sessions each individual
view explains less of the reconstruction and covers less of it, so the 3D increasingly
depends on whichever views still see the animal. But they must not be presented as
detector performance. For the true raw-detection comparison use the shared detection
pool at $BENCH/outputs/keeptrack_h5s (identity-stripped, with det_scores).

Metadata comes from `$BENCH/outputs/_multi_master.tsv`: `difficulty` (2-7),
`bedding` (black/white), `animals` (2-4), `obstacle_rating` (0-5), and the
white/agouti/black coat counts.

Reported statistics: MEAN is the headline (it is the statistic the outlier tail moves),
with the median alongside so the gap between them is visible, plus p90/p95/p99/max and
the fraction beyond the app's own 20 px tolerance. Sessions are weighted equally within
a stratum and the between-session SD is reported.

Run with the bench env:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig5_difficulty.py

Writes figs/out/fig6_difficulty.json.
"""
from __future__ import annotations

import argparse
import csv
import glob
import itertools
import json
import os

import h5py
import numpy as np

BENCH = "/root/vast/eric/luc3d-bench"
MASTER = f"{BENCH}/outputs/_multi_master.tsv"
SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
CAMS = ["back", "backL", "mid", "midL", "side", "sideL", "top", "topL"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "fig6_difficulty.json")

# The app's own reprojection tolerance (ui/settings.js reprojSigma), used as the
# "needs a human look" threshold so the panel's cut matches the tool's default.
TAU_PX = 20.0


def load_tracks(path, stride):
    """(F, T, N, 2) from a SLEAP analysis h5, read strided so SMB stays tolerable."""
    with h5py.File(path, "r") as f:
        t = f["tracks"]                      # (T, 2, N, F)
        arr = t[:, :, :, ::stride]
    return np.transpose(arr, (3, 0, 2, 1))   # (F, T, N, 2)


def match_and_score(pred, truth):
    """
    Per frame, assign predicted tracks to truth tracks by mean keypoint distance,
    then return per-keypoint errors for matched animals and the miss rate.

    pred, truth: (F, T, N, 2). Truth NaN means the animal/keypoint is not in the
    reconstruction there, so it is not counted either way.
    """
    F = min(pred.shape[0], truth.shape[0])
    pred, truth = pred[:F], truth[:F]
    Tp, Tt, N = pred.shape[1], truth.shape[1], truth.shape[2]

    cost = np.full((F, Tt, Tp), np.inf)
    for a in range(Tt):
        for b in range(Tp):
            with np.errstate(invalid="ignore"):
                cost[:, a, b] = np.nanmean(
                    np.linalg.norm(pred[:, b] - truth[:, a], axis=-1), axis=1)
    cost = np.nan_to_num(cost, nan=np.inf, posinf=np.inf)

    perms = list(itertools.permutations(range(Tp), min(Tt, Tp)))
    if not perms:
        return np.zeros(0), 0, 0
    tot = np.stack([sum(cost[:, a, p[a]] for a in range(len(p))) for p in perms], 1)
    pick = np.argmin(tot, axis=1)

    errs = []
    n_truth = 0
    n_missing = 0
    for pi, p in enumerate(perms):
        rows = np.where(pick == pi)[0]
        if not len(rows):
            continue
        for a in range(len(p)):
            tv = truth[rows, a]              # (R, N, 2)
            pv = pred[rows, p[a]]
            have_t = ~np.isnan(tv).any(-1)
            have_p = ~np.isnan(pv).any(-1)
            n_truth += int(have_t.sum())
            n_missing += int((have_t & ~have_p).sum())
            both = have_t & have_p
            if both.any():
                errs.append(np.linalg.norm(pv[both] - tv[both], axis=-1))
    e = np.concatenate(errs) if errs else np.zeros(0)
    return e, n_truth, n_missing


def contrast_class(row):
    """
    Coat-versus-bedding contrast, derived from the metadata rather than asserted.
    Dark coats (agouti/black) on black bedding is the low-contrast case; light coats
    on black bedding, or dark on white, is high contrast.
    """
    dark = int(row["agouti_mice"] or 0) + int(row["black_mice"] or 0)
    light = int(row["white_mice"] or 0)
    if row["bedding"] == "black":
        return "low (dark coats, black bedding)" if dark and not light else "mixed"
    return "high (black bedding absent)" if dark else "mixed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stride", type=int, default=60,
                    help="frame stride; 60 gives ~300 frames per session")
    ap.add_argument("--max-sessions", type=int, default=0)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MASTER), delimiter="\t"))
    out_sessions = []
    err_by_difficulty = {}
    for i, row in enumerate(rows):
        if args.max_sessions and len(out_sessions) >= args.max_sessions:
            break
        sid = row["session"]
        sp = row.get("session_path") or ""
        rec = dict(session=sid, difficulty=int(row["difficulty"]),
                   bedding=row["bedding"], animals=int(row["animals"]),
                   obstacle_rating=int(row["obstacle_rating"] or 0),
                   white=int(row["white_mice"] or 0),
                   agouti=int(row["agouti_mice"] or 0),
                   black=int(row["black_mice"] or 0),
                   frames_total=int(row["frames"] or 0),
                   duration_min=float(row["duration"] or 0),
                   contrast=contrast_class(row))
        per_cam = {}
        all_err = []
        tot_truth = tot_missing = 0
        for cam in CAMS:
            rp = row.get(f"{cam}_reproj_h5") or ""
            ip = row.get(f"{cam}_inference_h5") or ""
            if not rp or not ip:
                continue
            rpp = rp if os.path.isabs(rp) else os.path.join(SLAP_ROOT, rp)
            ipp = ip if os.path.isabs(ip) else os.path.join(SLAP_ROOT, ip)
            if not (os.path.exists(rpp) and os.path.exists(ipp)):
                continue
            try:
                truth = load_tracks(rpp, args.stride)
                pred = load_tracks(ipp, args.stride)
                e, nt, nm = match_and_score(pred, truth)
            except Exception as ex:                                  # noqa: BLE001
                per_cam[cam] = dict(status="failed", why=f"{type(ex).__name__}: {ex}")
                continue
            if not len(e):
                per_cam[cam] = dict(status="failed", why="no overlapping keypoints")
                continue
            per_cam[cam] = dict(
                status="ok", n=int(len(e)),
                mean=float(e.mean()),
                p50=float(np.median(e)), p90=float(np.percentile(e, 90)),
                p95=float(np.percentile(e, 95)), p99=float(np.percentile(e, 99)),
                frac_over_tau=float((e > TAU_PX).mean()),
                miss_rate=float(nm / nt) if nt else None)
            all_err.append(e)
            tot_truth += nt
            tot_missing += nm
        if not all_err:
            rec["status"] = "failed"
            out_sessions.append(rec)
            print(f"  {sid}: no usable cameras")
            continue
        e = np.concatenate(all_err)
        # keep a subsample per stratum for the triage curve without holding every
        # keypoint from 42 sessions in memory
        sub = e if len(e) <= 60000 else e[np.linspace(0, len(e) - 1, 60000).astype(int)]
        err_by_difficulty.setdefault(rec["difficulty"], []).append(sub)
        rec.update(status="ok", cameras_used=sum(1 for v in per_cam.values()
                                                 if v.get("status") == "ok"),
                   n_keypoints=int(len(e)),
                   err_mean=float(e.mean()),
                   err_p50=float(np.median(e)), err_p75=float(np.percentile(e, 75)),
                   err_p90=float(np.percentile(e, 90)),
                   err_p95=float(np.percentile(e, 95)),
                   err_p99=float(np.percentile(e, 99)),
                   err_max=float(e.max()),
                   frac_over_tau=float((e > TAU_PX).mean()),
                   miss_rate=float(tot_missing / tot_truth) if tot_truth else None,
                   per_camera=per_cam)
        out_sessions.append(rec)
        print(f"  {sid}: diff {rec['difficulty']} {rec['bedding']:<5} "
              f"{rec['animals']}a  err p50 {rec['err_p50']:6.2f} px  "
              f">{TAU_PX:.0f}px {rec['frac_over_tau'] * 100:5.1f}%  "
              f"miss {(rec['miss_rate'] or 0) * 100:5.1f}%  "
              f"({rec['cameras_used']} cams)")

    ok = [s for s in out_sessions if s.get("status") == "ok"]

    # TRIAGE CONCENTRATION, per difficulty stratum. Sort keypoints worst-first and ask
    # what share of the total reprojection error has been seen after reviewing the top
    # x%. This is the quantity that decides whether targeted proofreading beats
    # exhaustive proofreading, and it should sharpen with difficulty: a fatter error
    # tail means a smaller review budget captures more.
    triage = {}
    for k, errs in err_by_difficulty.items():
        if not errs:
            continue
        v = np.sort(np.concatenate(errs))[::-1]
        total = float(v.sum())
        if total <= 0:
            continue
        cum = np.cumsum(v) / total
        fr = (np.arange(len(v)) + 1) / len(v)
        # sample ~50 points along the curve
        sel = np.unique(np.linspace(0, len(v) - 1, 50).astype(int))
        triage[str(k)] = dict(
            n=int(len(v)),
            curve=[dict(reviewed_frac=float(fr[i]), error_frac=float(cum[i]))
                   for i in sel],
            captured={str(f): float(cum[max(0, int(f * len(v)) - 1)])
                      for f in (0.01, 0.05, 0.10, 0.20)})

    def group(key):
        g = {}
        for s in ok:
            g.setdefault(str(s[key]), []).append(s)
        # `m` must take the session list explicitly. Closing over `v` from the dict
        # comprehension below does NOT work: the comprehension has its own scope, so `v`
        # is not a visible free variable inside a function defined out here, and calling
        # it raised `NameError: cannot access free variable 'v'`.
        def m(sessions, key):
            vals = [x[key] for x in sessions if x.get(key) is not None]
            return float(np.mean(vals)) if vals else None

        return {k: dict(
            n_sessions=len(v),
            n_keypoints=int(sum(x["n_keypoints"] for x in v)),
            err_mean=m(v, "err_mean"), err_p50=m(v, "err_p50"), err_p90=m(v, "err_p90"),
            err_p95=m(v, "err_p95"), err_p99=m(v, "err_p99"), err_max=m(v, "err_max"),
            frac_over_tau=m(v, "frac_over_tau"), miss_rate=m(v, "miss_rate"),
            # session-to-session spread, so the figure can show it is not one outlier
            err_mean_sd=(float(np.std([x["err_mean"] for x in v])) if len(v) > 1 else 0.0),
            miss_rate_sd=(float(np.std([x["miss_rate"] for x in v
                                        if x["miss_rate"] is not None]))
                          if len(v) > 1 else 0.0),
            frames=int(sum(x["frames_total"] for x in v)),
        ) for k, v in sorted(g.items(), key=lambda kv: kv[0])}

    payload = dict(
        generated_by="figs/fig5_difficulty.py", dataset="SLAP-2M",
        master_sheet=MASTER, tau_px=TAU_PX, stride=args.stride,
        n_sessions=len(out_sessions), n_ok=len(ok),
        by_difficulty=group("difficulty"), by_bedding=group("bedding"),
        by_animals=group("animals"), by_contrast=group("contrast"),
        triage_by_difficulty=triage,
        sessions=out_sessions,
        caveats=[
            "BOTH sides of the comparison come from the proofread data: the reference "
            "is the proofread 3D reprojected into each camera, and the 'observed' side "
            "is that camera's proofread 2D labels (every _inference_h5 column in the "
            "master sheet points at a *.proofread.slp.analysis.h5). These numbers are "
            "therefore the reconstruction's own 2D-to-3D residual and the per-camera "
            "label coverage -- NOT detector error and NOT detector misses.",
            "Frames are uniformly strided, never selected.",
            "Identity is matched per frame per camera by mean keypoint distance; "
            "a session where the predictor swapped animals for a long stretch will "
            "show that as error rather than as a swap.",
            "`difficulty` is the corpus's own hand-assigned rating, not derived.",
        ])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"\nby difficulty:")
    for k, v in payload["by_difficulty"].items():
        print(f"  {k}: n={v['n_sessions']:2d}  err p50 {v['err_p50']:6.2f} px  "
              f">tau {v['frac_over_tau'] * 100:5.1f}%  miss {v['miss_rate'] * 100:5.1f}%")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
