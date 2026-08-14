#!/usr/bin/env python
"""Fig 8 — a genuine identity PRECISION-RECALL CURVE (with an AUC) per parameter set.

WHAT IS SWEPT, AND WHY IT HAS TO BE THIS. A precision-recall curve needs a knob to trace:
a score you threshold, giving up recall to buy precision. LUCID's tracker output has no such
score — `{cam}_predictions.h5` for BMimica holds a `tracks` dataset of keypoint coordinates
and nothing else, no per-instance confidence. That is not a guess; it is the same fact that
made `filterMinInstanceScore` UNINFORMATIVE in Fig 8b (its filter gates on `inst.score !=
null`, and every value in this pool is null, so 0 and 0.85 gave byte-identical output).

So the sweep is the **IoU matching threshold** — how much a predicted box must overlap a
ground-truth box to count as the same object. This is the axis COCO-style PR curves sweep,
and it is meaningful here: at a loose threshold nearly every detection finds a GT partner
and identity errors dominate; at a strict one only well-localised detections match, so
precision rises and recall falls. Each parameter set therefore traces a curve, and the area
under it summarises the whole trade-off in one number instead of the single operating point
(IoU 0.5) that the rest of Fig 8 reports.

WHAT IS ON THE AXES. Identity precision (IDP) and identity recall (IDR) from motmetrics,
pooled across all five cameras of a session with the tracker's global identity as the
hypothesis id — i.e. the CROSS-VIEW construction the rest of Fig 8 uses. IDF1 is their
harmonic mean, so a point's IDF1 is readable from its position, and IDP/IDR separate the two
failure modes IDF1 cannot: identities attached to the wrong animal (precision) versus the
right identity missing where it belongs (recall).

WHY ONE PASS AND NOT N PASSES. The expensive parts of scoring are reading the HDF5 and
building the IoU matrix per frame; those do not depend on the threshold. So every threshold's
accumulator is fed from the SAME per-frame IoU matrix in a single walk over the session. N
thresholds cost N assignment solves, not N full re-scores.

    $PY figs/fig8_pr_curve.py                       # all 50 sessions, default configs
    $PY figs/fig8_pr_curve.py --max-frames 3000 --sessions 20250827_141755   # smoke

Run with the bench interpreter (motmetrics):
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig8_pr_curve.json
"""
import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig3_score as _fs  # noqa: E402,F401  (puts $BENCH/scripts on sys.path for `evaluate`)
import fig8_methods as f8m  # noqa: E402
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402

#: IoU thresholds swept. Spans loose to strict; 0.5 is included because it is the operating
#: point every other Fig 8 number is reported at, so the curve passes through them.
IOUS = [0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]

#: The parameter sets drawn. Same set and same names as panel 8d.
CONFIGS = ["shipped", "sync_stale1_dist25", "sync_stale10_dist25",
           "sync_stale20_dist25", "sync_stale30_dist25"]


def pr_for_session(result_json, det_dir, gt_dir, cameras, ious, max_frames=None):
    """IDP/IDR at every IoU threshold, cross-view pooled, in ONE walk over the session."""
    with open(result_json) as f:
        luc = json.load(f)
    pooled = {t: mm.MOTAccumulator(auto_id=False) for t in ious}

    for ci, cam in enumerate(cameras):
        with h5py.File(Path(det_dir) / f"{cam}_predictions.h5", "r") as f:
            det = f["tracks"][0][...]
        gt, occ = ev.load_gt(Path(gt_dir) / cam / "proofread.analysis.h5")
        nf = min(gt.shape[0], det.shape[0])
        if max_frames:
            nf = min(nf, max_frames)
        ndet = det.shape[1]
        ids = ev.luc3d_assignments_for_cam(luc, cam, nf, ndet)

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
                g = int(ids[fi, a])
                if g < 0:
                    continue
                prb.append(b)
                pid.append(g)
            gtn = np.array(gtb) if gtb else np.empty((0, 4))
            prn = np.array(prb) if prb else np.empty((0, 4))
            # ONE IoU matrix, reused for every threshold. `iou_matrix(max_iou=t)` masks
            # pairs whose IoU is below t, so the strictest threshold is a mask of the
            # loosest -- computed once at the loosest and re-masked, avoiding N matrix
            # builds per frame.
            base = mm.distances.iou_matrix(gtn, prn, max_iou=1.0)
            for t in ious:
                d = base.copy()
                if d.size:
                    # iou_matrix returns 1 - IoU; "IoU >= t" is "d <= 1 - t"
                    d[d > 1.0 - t] = np.nan
                pooled[t].update(gti, pid, d, frameid=ci * 10_000_000 + fi)

    out = {}
    for t in ious:
        s = mm.metrics.create().compute(pooled[t], metrics=["idf1", "idp", "idr"], name="p")
        out[f"{t:g}"] = {"idp": float(s["idp"]["p"]), "idr": float(s["idr"]["p"]),
                         "idf1": float(s["idf1"]["p"])}
    return out


def _job(cfg, session, ious, max_frames):
    p = f8m.TMP_DIR / cfg / f"{session}.json"
    if not p.exists():
        return cfg, session, None, f"missing {p}"
    try:
        return cfg, session, pr_for_session(
            str(p), str(f3.DET / session), str(f3.GT / session), f3.CAMERAS, ious,
            max_frames), None
    except Exception as e:  # noqa: BLE001
        return cfg, session, None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--sessions", default=None)
    ap.add_argument("--ious", default=",".join(f"{t:g}" for t in IOUS))
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--workers", type=int, default=56)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    f8m.use_all_bmimica_sessions()          # points f3.SESSIONS + f8m.TMP_DIR at the 50
    sessions = a.sessions.split(",") if a.sessions else f3.SESSIONS
    cfgs = a.configs.split(",")
    ious = [float(x) for x in a.ious.split(",")]
    jobs = [(c, s) for c in cfgs for s in sessions]
    print(f"[pr] {len(cfgs)} configs x {len(sessions)} sessions x {len(ious)} IoU "
          f"thresholds = {len(jobs)} scoring runs, {a.workers} workers", flush=True)

    t0 = time.time()
    got = {c: {} for c in cfgs}
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, c, s, ious, a.max_frames) for c, s in jobs]
        done = 0
        for fut in as_completed(futs):
            c, s, r, err = fut.result()
            done += 1
            if err:
                print(f"[pr] FAILED {c} {s}: {err}", flush=True)
            else:
                got[c][s] = r
            if done % 10 == 0 or done == len(jobs):
                print(f"[pr] {done}/{len(jobs)} ({time.time()-t0:.0f}s)", flush=True)

    # Mean IDP/IDR across sessions at each threshold -- the curve -- plus its AUC.
    curves = {}
    for c in cfgs:
        per = got[c]
        if not per:
            continue
        pts = []
        for t in ious:
            k = f"{t:g}"
            idp = [per[s][k]["idp"] for s in per if k in per[s]]
            idr = [per[s][k]["idr"] for s in per if k in per[s]]
            idf = [per[s][k]["idf1"] for s in per if k in per[s]]
            if not idp:
                continue
            pts.append({"iou": t, "idp": float(np.mean(idp)), "idr": float(np.mean(idr)),
                        "idf1": float(np.mean(idf)), "n_sessions": len(idp)})
        pts.sort(key=lambda q: q["idr"])
        # trapezoid over recall. Reported as measured -- the curve spans only the recall
        # range the IoU sweep reaches, so this is NOT comparable to a full-range AUC and
        # the deposit says so.
        auc = float(np.trapezoid([q["idp"] for q in pts], [q["idr"] for q in pts])) if len(pts) > 1 else None
        span = (pts[-1]["idr"] - pts[0]["idr"]) if len(pts) > 1 else None
        curves[c] = {"points": pts, "auc_trapezoid": auc, "recall_span": span,
                     "auc_normalised": (auc / span) if auc and span else None,
                     "per_session": per}

    dest = Path(a.out) if a.out else OUT / "fig8_pr_curve.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig8_pr_curve.py",
        "swept": "IoU matching threshold",
        "why_iou": "The detection pool has no per-instance confidence to threshold "
                   "({cam}_predictions.h5 holds only a `tracks` coordinate dataset), which "
                   "is the same fact that made filterMinInstanceScore byte-identical at 0 "
                   "and 0.85 in Fig 8b. The IoU matching threshold is the sweepable axis.",
        "metric": "cross-view identity precision/recall (motmetrics idp/idr), pooled over "
                  "all five cameras of a session with the tracker's global identity as the "
                  "hypothesis id; averaged over sessions at each threshold",
        "ious": ious, "sessions": sessions, "max_frames": a.max_frames,
        "caveats": [
            "auc_trapezoid is the area under the traced curve only, over the recall range "
            "the IoU sweep actually reaches -- it is NOT a full-range [0,1] AUC and must "
            "not be compared to one. auc_normalised divides by that span so the parameter "
            "sets are comparable to each other.",
            "Sweeping IoU changes which detections are MATCHABLE, so the curve mixes "
            "localisation quality with identity quality. It is a fair comparison BETWEEN "
            "parameter sets (identical detections, identical GT, identical thresholds) and "
            "not an absolute statement about identity alone.",
            "IoU 0.5 is the operating point every other Fig 8 number is reported at.",
        ],
        "curves": curves,
        "seconds": round(time.time() - t0, 1),
    }, indent=2))
    print(f"[pr] wrote {dest} ({time.time()-t0:.0f}s)")
    for c in cfgs:
        if c in curves and curves[c]["auc_normalised"] is not None:
            print(f"[pr]   {c:<24} normalised AUC {curves[c]['auc_normalised']:.4f} "
                  f"over recall span {curves[c]['recall_span']:.3f}")


if __name__ == "__main__":
    main()
