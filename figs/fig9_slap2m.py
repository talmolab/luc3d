#!/usr/bin/env python
"""Fig 9 (EXPLORATORY) — the improved cross-view tracker on ALL 74 SLAP-2M sessions.

Fig 8 established, on all 50 proofread BMimica sessions, that the shipped tracker's 3D
anchor is stale (`Target.detsByCam` keeps one detection per camera and never expires it, and
`_retriangulate()` fuses all of them; measured mean detection age 3-50 frames, maxima up to
8,652) and that evicting stale detections is worth a 75-80% cut in ID switches. This asks
whether that survives a DIFFERENT CORPUS — and SLAP-2M is a genuinely different regime, not
a second sample of the same one:

    BMimica    5 cameras, 2 animals, 50 sessions, detector misses 8.7% of GT,
               identity-fix ceiling 0.9527
    SLAP-2M    6 cameras, 1-4 animals, 74 sessions, detector misses 35.4% of GT,
               identity-fix ceiling 0.7704

A third of ground truth having no detection at all caps what ANY identity method can do, so
the honest prior is that `stale` buys less here. That is the point of running it.

WHAT IS REPORTED, and both rates share one measured denominator (the sum over every camera
of every session of min(gt_frames, det_frames) -- exactly the frames the scorer scores):

  ID SWITCHES PER 100,000 camera-frames   motmetrics `num_switches`, summed per camera.
  MISGROUPED PER 100,000                  matched DETECTIONS (not frames -- an instance in
                                          one camera on one frame) whose identity disagrees
                                          with their best-IoU ground-truth box UNDER THE
                                          OPTIMAL id permutation for that camera. This
                                          is the "mislabelled mass" of figs/fig8_diag_loss.py
                                          and it is the quantity that actually matters here:
                                          a switch is an EVENT, mislabelled mass is the
                                          DURATION, and Fig 8c showed a session losing 0.311
                                          IDF1 to only ten switches. Two very different
                                          numbers, so both are reported.

CORPUS SHAPE THAT MUST NOT BE AVERAGED AWAY. 32 of the 74 sessions hold ONE animal, where
there is nothing to associate across views and every tracker scores near-perfectly (Fig 7d
says so explicitly). Pooling them with the multi-animal sessions dilutes any effect by 43%.
Every aggregate here is therefore reported BOTH over all 74 and over the 42 multi-animal
sessions, and the per-session table carries `animals` and `difficulty` (1-7, from the master
sheet) so switches can be read per stratum.

    $PY figs/fig9_slap2m.py --dry-run
    $PY figs/fig9_slap2m.py                       # shipped + the Fig 8 winner
    $PY figs/fig9_slap2m.py --configs shipped

Run with the bench interpreter (motmetrics):
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig9_slap2m.json; per-cell tracker runs cached under
figs/out/tmp/fig9slap/, so the pass is restartable.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))
import fig3_score as fs  # noqa: E402  (also puts $BENCH/scripts on sys.path)
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402

BENCH = Path("/root/vast/eric/luc3d-bench")
MASTER = BENCH / "outputs" / "sleap_nn_master_sheet.tsv"
#: SLAP-2M has TWO detection pools and they are NOT interchangeable. `keeptrack_h5s` is
#: what fig3_headtohead.py drives; `predictions_h5s` is what luc3d-bench's evaluate.py
#: scored into PAF_3d_kalman/_eval_baseline.csv, which is where fig3_trackers.json's
#: SLAP-2M numbers -- and therefore Fig 7 panels b-g -- come from. Adding an arm to those
#: panels requires running on THEIR pool: the same 74 sessions score within-view IDF1
#: 0.899 on keeptrack and 0.736 on the PAF pool, so mixing them would be comparing
#: trackers across different detections. Selected with --pool.
POOLS = {"keeptrack": BENCH / "outputs" / "keeptrack_h5s",
         "predictions": BENCH / "outputs" / "predictions_h5s"}
KEEPTRACK = POOLS["keeptrack"]
DRIVER = REPO / "figs" / "fig8-bench" / "fig8_bench.mjs"
TMP = OUT / "tmp" / "fig9slap"
CAMERAS = ["back", "backL", "mid", "midL", "top", "topL"]

WORKERS = int(os.environ.get("FIG9_WORKERS", "56"))

#: The Fig 8 winner and its control. `stale: 20` had the fewest switches on BMimica's 50
#: sessions (413 against the shipped 2,071) and the highest within/cross IDF1 of the horizon.
CONFIGS = {
    "shipped": {"method": {}, "thresholds": {}},
    "sync_stale20_dist25": {"method": {"sync": True, "stale": 20},
                            "thresholds": {"distanceThreshold": 25}},
    # Fig 3g: with a fresh anchor the corr3d tail is no longer flat -- corr3dWeight 12
    # beat the shipped 6 on all 50 BMimica sessions (371 vs 413 switches). Carried to
    # SLAP-2M so the corpora are compared at the same, best-known setting.
    "sync_stale20_dist25_corr12": {"method": {"sync": True, "stale": 20},
                                   "thresholds": {"distanceThreshold": 25,
                                                  "corr3dWeight": 12}},
}


def sessions():
    """Every SLAP-2M session with detections, proofread GT for all six cameras, and a
    calibration. Checked rather than assumed -- a partially prepared session would
    otherwise silently drop a camera and change the denominator."""
    df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)
    out, skipped = [], []
    for idx, row in df.iterrows():
        gt_paths = {c: row.get(f"{c}_proofread_h5") for c in CAMERAS}
        if not all(isinstance(p, str) and Path(p).exists() for p in gt_paths.values()):
            skipped.append((str(row["session"]), "missing proofread GT"))
            continue
        calib = row["calibration_toml"]
        if not (isinstance(calib, str) and Path(calib).exists()):
            skipped.append((str(row["session"]), "missing calibration"))
            continue
        out.append({
            "session": str(row["session"]), "det_session_idx": int(idx),
            "calibration": calib, "gt_paths": gt_paths,
            "animals": int(row["animals"]),
            "difficulty": int(row["difficulty"]),
            # keeptrack_h5s is ONE pooled array padded to the longest session, so the
            # window must be clipped to this session's real length or every shorter session
            # would score ~100k phantom all-NaN frames.
            "max_frames": int(row["frames"]),
        })
    return out, skipped


def camera_frames(sess_list):
    """The denominator, measured from HDF5 shapes only -- no decoding, no scoring.

    Mirrors fig3_score.score_session's own `nf = min(gt_frames, det_frames)` per camera,
    then the per-session `max_frames` clip that the pooled detection array requires.
    """
    total, by_session = 0, {}
    for s in sess_list:
        per_cam = {}
        for cam in CAMERAS:
            with h5py.File(KEEPTRACK / f"{cam}_predictions.h5", "r") as f:
                det_n = int(f["tracks"].shape[1])
            g, _o = ev.load_gt(Path(s["gt_paths"][cam]))
            nf = min(det_n, int(g.shape[0]), s["max_frames"])
            per_cam[cam] = nf
            total += nf
        by_session[s["session"]] = per_cam
    return total, by_session


def track_one(cell, params, s):
    d = TMP / cell
    d.mkdir(parents=True, exist_ok=True)
    out_path = d / f"{s['session']}.json"
    if out_path.exists() and out_path.stat().st_size > 100:
        return s["session"], "ok", str(out_path)
    pj = d / "params.json"
    pj.write_text(json.dumps(params))
    cmd = ["node", str(DRIVER),
           "--session-idx", str(s["det_session_idx"]),
           "--num-animals", str(s["animals"]),
           "--calibration", str(s["calibration"]),
           "--pred-h5-dir", str(KEEPTRACK),
           "--cameras", ",".join(CAMERAS),
           "--max-frames", str(s["max_frames"]),
           "--out", str(out_path), "--params", str(pj)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
        if r.returncode != 0 or not out_path.exists():
            return (s["session"], "failed",
                    f"exit {r.returncode}: " + r.stderr[-400:].replace("\n", " "))
        return s["session"], "ok", str(out_path)
    except Exception as e:  # noqa: BLE001
        return s["session"], "failed", repr(e)


def score_one(cell, s):
    """Standard scoring PLUS misgrouped-instance mass, in one walk over the session."""
    p = TMP / cell / f"{s['session']}.json"
    if not p.exists():
        return s["session"], None, "no result JSON"
    try:
        base = fs.score_session(str(p), str(KEEPTRACK), None, CAMERAS, s["animals"],
                                max_frames=s["max_frames"],
                                det_session_idx=s["det_session_idx"],
                                gt_paths=s["gt_paths"])
        with open(p) as f:
            luc = json.load(f)
        # MISGROUPED, computed through the OPTIMAL id PERMUTATION.
        #
        # The first version of this compared the tracker's identity id against the GT
        # track index DIRECTLY. Those are unrelated numbering systems -- the tracker
        # allocates global ids as it discovers animals, GT indexes tracks 0..n-1 per
        # session -- so the comparison measured how often two arbitrary labellings happen
        # to coincide. It reported 47.6% of detections misgrouped against a within-view
        # IDF1 of 0.69, which is impossible; with two animals ~50% is exactly what a
        # random permutation produces, and that is all the number was.
        #
        # The fix is the same thing IDF1 does internally: find the mapping from tracker id
        # to GT index that maximises agreement (Hungarian on the co-occurrence table),
        # then count the matched detections that disagree UNDER that mapping. Done per
        # (session, camera), because the within-view convention scores each camera with
        # its own optimal remap.
        from scipy.optimize import linear_sum_assignment
        n_lab = n_mis = n_det = 0
        for cam in CAMERAS:
            with h5py.File(KEEPTRACK / f"{cam}_predictions.h5", "r") as f:
                det = f["tracks"][s["det_session_idx"]][...]
            gt, occ = ev.load_gt(Path(s["gt_paths"][cam]))
            nf = min(gt.shape[0], det.shape[0], s["max_frames"])
            ndet = det.shape[1]
            ids = ev.luc3d_assignments_for_cam(luc, cam, nf, ndet)
            pairs = []                       # (tracker_id, gt_index) for matched dets
            for fi in range(nf):
                gtb, gti = [], []
                for t in range(gt.shape[1]):
                    if not occ[fi, t]:
                        continue
                    b = ev.bbox_from_kpts(gt[fi, t])
                    if b is not None:
                        gtb.append(b)
                        gti.append(int(t))
                prb, pid = [], []
                for a in range(ndet):
                    b = ev.bbox_from_kpts(det[fi, a])
                    if b is None:
                        continue
                    prb.append(b)
                    pid.append(int(ids[fi, a]))
                n_det += len(prb)
                if not prb or not gtb:
                    continue
                dist = mm.distances.iou_matrix(np.array(gtb), np.array(prb), max_iou=0.5)
                for j in range(len(prb)):
                    if pid[j] < 0:
                        continue              # unlabelled: coverage miss, not a misgroup
                    n_lab += 1
                    col = dist[:, j]
                    if not (col.size and np.isfinite(col).any()):
                        continue              # no GT overlap: false positive, not a misgroup
                    pairs.append((pid[j], gti[int(np.nanargmin(col))]))
            if not pairs:
                continue
            tids = sorted({a for a, _b in pairs})
            gids = sorted({b for _a, b in pairs})
            tab = np.zeros((len(tids), len(gids)), dtype=np.int64)
            ti = {v: i for i, v in enumerate(tids)}
            gi = {v: i for i, v in enumerate(gids)}
            for a, b in pairs:
                tab[ti[a], gi[b]] += 1
            r, c = linear_sum_assignment(-tab)          # maximise agreement
            agree = int(tab[r, c].sum())
            n_mis += len(pairs) - agree
        base.update({"det_with_bbox": n_det, "det_labelled": n_lab,
                     "misgrouped": n_mis, "animals": s["animals"],
                     "difficulty": s["difficulty"], "session": s["session"]})
        return s["session"], base, None
    except Exception as e:  # noqa: BLE001
        return s["session"], None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=WORKERS)
    ap.add_argument("--pool", default="keeptrack", choices=sorted(POOLS),
                    help="which SLAP-2M detection pool -- `predictions` is the one Fig 7's "
                         "b-g panels are scored on, `keeptrack` the one fig3_headtohead "
                         "uses. They give different absolute numbers; never mix them.")
    a = ap.parse_args()
    global KEEPTRACK, TMP
    KEEPTRACK = POOLS[a.pool]
    if a.pool != "keeptrack":
        TMP = OUT / "tmp" / f"fig9slap_{a.pool}"

    sess, skipped = sessions()
    cfgs = a.configs.split(",")
    print(f"[fig9] {len(sess)} SLAP-2M sessions "
          f"({sum(1 for s in sess if s['animals'] > 1)} multi-animal), "
          f"{len(cfgs)} configs = {len(sess) * len(cfgs)} tracker + scoring runs",
          flush=True)
    for s, why in skipped:
        print(f"[fig9] SKIP {s}: {why}", flush=True)
    if a.dry_run:
        print(f"[fig9] dry run: would run {len(sess) * len(cfgs)} of each at "
              f"{a.workers} workers")
        return

    t0 = time.time()
    TMP.mkdir(parents=True, exist_ok=True)
    jobs = [(c, s) for c in cfgs for s in sess]
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(track_one, c, CONFIGS[c], s): (c, s["session"])
                for c, s in jobs}
        done = 0
        for f in as_completed(futs):
            _s, st, info = f.result()
            done += 1
            if st != "ok":
                print(f"[fig9] TRACK FAILED {futs[f]}: {info}", flush=True)
            if done % 10 == 0 or done == len(jobs):
                print(f"[fig9] tracked {done}/{len(jobs)} ({time.time()-t0:.0f}s)",
                      flush=True)

    got = {c: {} for c in cfgs}
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(score_one, c, s): (c, s["session"]) for c, s in jobs}
        done = 0
        for f in as_completed(futs):
            c, _sn = futs[f]
            _s, r, err = f.result()
            done += 1
            if err:
                print(f"[fig9] SCORE FAILED {futs[f]}: {err}", flush=True)
            else:
                got[c][r["session"]] = r
            if done % 10 == 0 or done == len(futs):
                print(f"[fig9] scored {done}/{len(futs)} ({time.time()-t0:.0f}s)",
                      flush=True)

    total_cf, cf_by_session = camera_frames(sess)
    print(f"[fig9] total_camera_frames = {total_cf:,}", flush=True)

    def agg(rows, cf):
        if not rows:
            return None
        sw = sum(r["within_switches"] for r in rows)
        mis = sum(r["misgrouped"] for r in rows)
        return {
            "n_sessions": len(rows),
            "idf1_cross": float(np.mean([r["cross_idf1"] for r in rows])),
            "idf1_cross_median": float(np.median([r["cross_idf1"] for r in rows])),
            "idf1_within": float(np.mean([r["within_idf1"] for r in rows])),
            "idp_cross": float(np.mean([r["cross_idp"] for r in rows])),
            "idr_cross": float(np.mean([r["cross_idr"] for r in rows])),
            "switches": sw, "switches_per_100k": sw * 1e5 / cf if cf else None,
            "misgrouped": mis, "misgrouped_per_100k": mis * 1e5 / cf if cf else None,
            "det_labelled": sum(r["det_labelled"] for r in rows),
            "det_with_bbox": sum(r["det_with_bbox"] for r in rows),
            "camera_frames": cf,
        }

    cf_of = lambda s: sum(cf_by_session[s].values())  # noqa: E731
    cells = []
    for c in cfgs:
        rows = list(got[c].values())
        multi = [r for r in rows if r["animals"] > 1]
        by_diff = {}
        for d in sorted({r["difficulty"] for r in rows}):
            sub = [r for r in rows if r["difficulty"] == d]
            by_diff[str(d)] = agg(sub, sum(cf_of(r["session"]) for r in sub))
        by_animals = {}
        for n in sorted({r["animals"] for r in rows}):
            sub = [r for r in rows if r["animals"] == n]
            by_animals[str(n)] = agg(sub, sum(cf_of(r["session"]) for r in sub))
        cells.append({
            "config": c, "params": CONFIGS[c],
            "all_sessions": agg(rows, sum(cf_of(r["session"]) for r in rows)),
            "multi_animal_only": agg(multi, sum(cf_of(r["session"]) for r in multi)),
            "by_difficulty": by_diff, "by_animals": by_animals,
            "per_session": sorted(rows, key=lambda r: r["session"]),
        })
        al, ma = cells[-1]["all_sessions"], cells[-1]["multi_animal_only"]
        if al:
            print(f"[fig9] {c}: ALL n={al['n_sessions']} cross={al['idf1_cross']:.4f} "
                  f"sw/100k={al['switches_per_100k']:.3f} "
                  f"misgrouped/100k={al['misgrouped_per_100k']:.1f}", flush=True)
        if ma:
            print(f"[fig9] {c}: MULTI n={ma['n_sessions']} cross={ma['idf1_cross']:.4f} "
                  f"sw/100k={ma['switches_per_100k']:.3f} "
                  f"misgrouped/100k={ma['misgrouped_per_100k']:.1f}", flush=True)

    dest = OUT / ("fig9_slap2m.json" if a.pool == "keeptrack"
                  else f"fig9_slap2m_{a.pool}.json")
    dest.write_text(json.dumps({
        "generated_by": f"figs/fig9_slap2m.py --pool {a.pool}",
        "detection_pool_name": a.pool,
        "status": "EXPLORATORY -- not part of the manuscript.",
        "dataset": "SLAP-2M", "cameras": CAMERAS,
        "detection_pool": str(KEEPTRACK),
        "total_camera_frames": total_cf,
        "camera_frames_by_session": cf_by_session,
        "caveats": [
            "Rates share one MEASURED denominator: the sum over every camera of every "
            "session of min(gt_frames, det_frames), clipped to that session's real length "
            "because keeptrack_h5s is one pooled array padded to the longest session.",
            "32 of 74 sessions hold ONE animal, where there is nothing to associate across "
            "views and every tracker scores near-perfectly. Pooling them dilutes any "
            "effect by 43%, so `multi_animal_only` is the number to read and "
            "`all_sessions` is reported beside it rather than instead of it.",
            "SLAP-2M's detector misses 35.4% of GT (against BMimica's 8.7%), so the "
            "ceiling for ANY identity-only method here is 0.7704, not 0.9527. A smaller "
            "gain than BMimica's is expected and is not evidence the method failed.",
            "`misgrouped` counts detections that were LABELLED, overlap a GT box at "
            "IoU >= 0.5, and disagree with that box's GT index UNDER THE OPTIMAL "
            "tracker-id -> GT-index MAPPING, solved per (session, camera) by "
            "`linear_sum_assignment` on the co-occurrence table -- the same thing IDF1 "
            "does internally. It IS therefore an absolute label-error count, under the "
            "most charitable naming of the tracker's identities. Unlabelled detections "
            "are coverage misses and non-overlapping ones are false positives; neither "
            "is counted as a misgrouping. SUPERSEDED CAVEAT, kept so older numbers are "
            "not mistaken for these: this field previously compared the tracker's id to "
            "the GT index DIRECTLY, with no permutation, and was described here as a "
            "'RELATIVE rate'. It was not a rate of anything -- with two animals an "
            "arbitrary labelling disagrees about half the time, which is why every "
            "pre-fix value sat near 50% (keeptrack: 4,025,419 = 54.6% of labelled "
            "detections, against 11.5% now) and showed no signal across difficulty "
            "strata. Every `misgrouped` number produced before 2026-08-13 is void, "
            "including the ones that were only ever compared between configurations.",
            "`difficulty` is the master sheet's own 1-7 rating, not derived here.",
        ],
        "cells": cells,
    }, indent=2))
    print(f"[fig9] wrote {dest} ({time.time()-t0:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
