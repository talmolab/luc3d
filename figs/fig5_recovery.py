#!/usr/bin/env python
"""The difficulty x cameras x missing-keypoints surface (review F6.1, design fixed by
Eric 2026-08-15: "keypoints missing on z, difficulty rating on x, and # of cameras on
y ... how many points are recovered by the number of cameras included").

    ############################################################################
    WHAT "RECOVERED" MEANS HERE, exactly. A keypoint the detector MISSES in one
    view is recovered by reprojection when the animal's same keypoint is detected
    in >= 2 OTHER cameras of the rig you have -- then it can be triangulated and
    reprojected into the view that missed it. That is a property of the DETECTION
    PATTERN alone, so it needs no tracking, no tolerance and no new tracking runs:
    per keypoint-instance (frame, animal, node) we count g = views with proofread
    GT and m = views whose MATCHED detection carries the node, and every question
    "at rig size k" is then a closed-form expectation over all C(6, k) camera
    subsets (hypergeometric: a missing view v is in the subset; of the other
    k - 1 slots, how many land on the m detecting views; recovery = P(>= 2)).
    EXACT over all subsets -- no sampling, no per-subset re-runs.

    The matching is fig5_detections.py's own `match_frame_wise` (mean-keypoint-
    distance Hungarian against the proofread reference, MATCH_MAX_PX gate), at
    stride 1, so "missing" here is the SAME notion Fig 6c already plots.
    ############################################################################

Per session this deposits the (g, m) histogram -- 7 x 7 integers -- which is the
whole measurement; the surface for any k is arithmetic on it. Difficulty ratings
ride along from the master sheet.

    $PY figs/fig5_recovery.py --pilot          # one session
    $PY figs/fig5_recovery.py --workers 12     # all 74

Output: figs/out/fig6_recovery.json
"""
import argparse
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
# fig6_detections needs cv2, which only the bench interpreter has. Imported INSIDE
# the measurement functions so `surface_from_hist` -- pure arithmetic on deposited
# histograms -- stays importable from the figs venv the panels use.
f6 = None


def _f6():
    global f6
    if f6 is None:
        import fig5_detections
        f6 = fig5_detections
    return f6

OUT = FIGS / "out"


def comb(n, r):
    return math.comb(n, r) if 0 <= r <= n else 0


def session_histogram(row, sidx):
    f6 = _f6()
    """(g, m) histogram over every keypoint-instance of one session.

    g = number of cameras whose proofread reference carries the keypoint;
    m = number of those cameras whose MATCHED detection carries it too.
    Loading and matching mirror fig5_detections.measure_session exactly (same
    master-sheet columns, same load_reference/load_raw/match_frame_wise, stride 1),
    so "missing" is byte-for-byte Fig 6c's notion.
    """
    import os
    sd = os.path.join(f6.SLAP_ROOT, os.path.dirname(row["points_3D"]))
    calib_p = os.path.join(sd, "calibration.toml")
    if not os.path.exists(calib_p):
        return None, "no calibration"
    cams_all = f6.load_calibration(calib_p)
    use = [c for c in f6.CAMS if c in cams_all and (row.get(f"{c}_reproj_h5") or "")]
    if len(use) < 3:
        return None, f"only {len(use)} usable cameras"
    gt_mask, det_mask, F_min = [], [], None
    for c in use:
        rp = row[f"{c}_reproj_h5"]
        rp = rp if os.path.isabs(rp) else os.path.join(f6.SLAP_ROOT, rp)
        if not os.path.exists(rp):
            return None, f"missing reproj h5 for {c}"
        R = f6.load_reference(rp, 1)
        raw, _sc = f6.load_raw(c, sidx, 1, R.shape[0])
        F = min(R.shape[0], raw.shape[0])
        m, _which = f6.match_frame_wise(raw[:F], R[:F])
        gt_mask.append(np.isfinite(R[:F, :, :, 0]))
        det_mask.append(np.isfinite(m[..., 0]))
        F_min = F if F_min is None else min(F_min, F)
    G = np.stack([g[:F_min] for g in gt_mask], axis=-1)     # (F, T, N, C)
    D = np.stack([d[:F_min] for d in det_mask], axis=-1) & G
    nC = G.shape[-1]
    hist = np.zeros((7, 7), dtype=np.int64)
    g = G.sum(axis=-1).ravel()
    m = D.sum(axis=-1).ravel()
    np.add.at(hist, (g, m), 1)
    return {"hist": hist.tolist(), "n_cameras": nC}, None


def surface_from_hist(hist, ks=(2, 3, 4, 5, 6)):
    """{k: (miss_per_view_pct, recovered_pct_of_missing, residual_missing_pct)}.

    All three are EXACT expectations over every C(6, k) camera subset. For one
    keypoint-instance with (g, m): a view v of the g GT views misses it when v is
    not among the m; conditioned on v in the subset, the other k - 1 slots draw
    from the remaining g - 1 GT views (assume g = 6 dominates; g < 6 handled by
    drawing from g - 1), of which m detect. Recovery needs >= 2 detecting among
    them (triangulate elsewhere, reproject into v).
    """
    out = {}
    for k in ks:
        miss_w = rec_w = tot_w = 0.0
        for g in range(2, 7):
            for m in range(0, g + 1):
                n = int(hist[g, m])
                if n == 0:
                    continue
                # views in the subset expected to carry GT ~ average over subsets;
                # weight per (instance, view-slot): each of the g GT views is in a
                # k-subset with prob k/6 (uniform over subsets of the 6 cameras).
                tot = n * g * (k / 6.0)
                # a GT view is a MISS if it is one of the g - m undetected ones
                miss = n * (g - m) * (k / 6.0)
                # P(>= 2 detecting among the k-1 other slots), drawing k-1 from
                # the other 5 cameras of which m detect (hypergeometric)
                denom = comb(5, k - 1)
                p_lt2 = (comb(m, 0) * comb(5 - m, k - 1)
                         + comb(m, 1) * comb(5 - m, k - 2)) / denom if denom else 1.0
                rec = miss * (1.0 - p_lt2)
                miss_w += miss
                rec_w += rec
                tot_w += tot
        out[k] = {
            "miss_per_view_pct": 100.0 * miss_w / tot_w if tot_w else None,
            "recovered_pct_of_missing": 100.0 * rec_w / miss_w if miss_w else None,
            "residual_missing_pct": 100.0 * (miss_w - rec_w) / tot_w if tot_w else None,
        }
    return out


def _job(args):
    row, sidx = args
    try:
        h, err = session_histogram(row, sidx)
        if err:
            return row["session"], None, err
        return row["session"], h, None
    except Exception as e:  # noqa: BLE001
        return row["session"], None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--pilot", action="store_true")
    a = ap.parse_args()
    import pandas as pd
    df = pd.read_csv(_f6().MASTER, sep="\t").reset_index(drop=True)
    jobs = [(r, i) for i, r in df.iterrows()]
    if a.pilot:
        jobs = jobs[:1]
    print(f"[rec] {len(jobs)} sessions, {a.workers} workers", flush=True)
    t0 = time.time()
    res, errs = {}, []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(_job, j) for j in jobs]), 1):
            sid, h, err = f.result()
            if err:
                errs.append(f"{sid}: {err}")
                print(f"[rec] FAILED {sid}: {err}", flush=True)
            else:
                res[sid] = h
                print(f"[rec] {sid} ok ({i}/{len(jobs)}, {time.time()-t0:.0f}s)",
                      flush=True)
    if errs and not res:
        sys.exit("[rec] nothing measured")
    # difficulty ratings from the detections deposit (same master sheet)
    det = json.loads((OUT / "fig5_detections.json").read_text())
    diff = {s["session"]: s.get("difficulty") for s in det["sessions"]}
    (OUT / "fig6_recovery.json").write_text(json.dumps({
        "generated_by": "figs/fig5_recovery.py",
        "claim": "Per-session (g, m) histograms of GT-view count vs detected-view "
                 "count per keypoint-instance, matched by fig6_detections' own "
                 "convention at stride 1; every rig-size-k recovery expectation is "
                 "exact arithmetic on them (see surface_from_hist).",
        "histograms": res,
        "difficulty": diff,
        "failures": errs,
    }))
    # print the corpus surface as a sanity check
    H = np.zeros((7, 7), dtype=np.int64)
    for h in res.values():
        H += np.array(h["hist"], dtype=np.int64)
    for k, v in surface_from_hist(H).items():
        print(f"  k={k}: miss/view {v['miss_per_view_pct']:.1f}%  recovered "
              f"{v['recovered_pct_of_missing']:.1f}% of misses  residual "
              f"{v['residual_missing_pct']:.1f}%")
    print(f"[rec] wrote {OUT / 'fig6_recovery.json'} ({len(res)} sessions, "
          f"{len(errs)} failures)")


if __name__ == "__main__":
    main()
