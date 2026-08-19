#!/usr/bin/env python
"""Fig 3 scorer — shared scoring helper for Tasks 1/2/3/5.

Reuses $BENCH/scripts/evaluate.py's helpers (bbox_from_kpts, load_gt,
luc3d_assignments_for_cam) exactly the way scripts/bartul/cross_view_metric.py
and scripts/crossview_hardsession.py already do, rather than re-deriving the
IoU/MOT machinery. Does NOT modify evaluate.py.

Per session: computes
  - within-view IDF1: per-camera MOT IDF1 (camera-local optimal id remap),
    averaged across cameras.
  - within-view switches: SUM of per-camera num_switches (the "2D switches"
    convention used throughout outputs/subgroup_7_7_2026/README.md).
  - cross-view IDF1: ALL cameras of this session pooled into one MOT
    accumulator with the tracker's global identity as the predicted id and the
    GT global animal id as the object id (the construction in
    scripts/bartul/cross_view_metric.py / scripts/crossview_hardsession.py).
  - cross-view switches: num_switches on that pooled accumulator.

score_cell() aggregates several sessions into one grid-cell record by taking
the mean of within/cross IDF1 across sessions and the sum of switches across
sessions (raw counts, per the handoff's "ID-switches (raw count)").
"""
import json
import sys
from pathlib import Path

import h5py
import numpy as np

BENCH = Path("/root/vast/eric/luc3d-bench")
sys.path.insert(0, str(BENCH / "scripts"))
import evaluate as ev  # noqa: E402  (installs the np.asfarray shim + motmetrics)
import motmetrics as mm  # noqa: E402

#: Metrics asked of motmetrics. `idf1` and `num_switches` were the original two and their
#: values are UNAFFECTED by asking for more -- each is computed from the same accumulator,
#: so this is purely additive and no existing Fig 3 or Fig 8 number can move. `idp`/`idr`
#: are the identity precision and recall whose harmonic mean IS idf1, so plotting the pair
#: says which way a tracker is failing: idp down means it is attaching an identity to
#: detections that are not that animal, idr down means it is failing to attach the right
#: identity where it should. IDF1 alone cannot distinguish those and they have different
#: fixes.
#: `recall`/`precision` are DETECTION quantities (did a box match a GT box at all) while
#: idr/idp are IDENTITY ones (did it carry the right name). Fig 7f plots IDF1 against
#: detector recall precisely because those are different axes. num_false_positives,
#: num_misses and num_fragmentations are what Fig 7e and Fig 7g need. Every one is
#: computed from the same accumulator, so asking for them cannot move idf1 or
#: num_switches -- verified by re-scoring a stored session and comparing all 16 digits.
# `idtp` and `num_matches` added 2026-08-13 for ID ACCURACY (IDA) = idtp / num_matches:
# "of the detections that were matched to a real animal, what fraction carry the right
# identity". IDP has the same numerator but keeps unmatched (false-positive) detections
# in its denominator, so IDA >= IDP always, and the two are EQUAL when a pool emits no
# false positives. Purely additive: motmetrics computes these from the same accumulator
# and no existing key changes value.
METRICS = ["idf1", "idp", "idr", "num_switches", "recall", "precision", "idtp",
           "num_matches",
           "num_false_positives", "num_misses", "num_fragmentations",
           "num_objects", "num_detections"]


def score_session(result_json_path, det_dir, gt_dir, cameras, num_animals, max_frames=None,
                   det_session_idx=0, gt_paths=None, frame_subset=None):
    """Score one session's bench_crossview/fig3_bench result JSON against GT.

    det_dir: dir with {cam}_predictions.h5. det_session_idx selects the row in
             that H5's session axis — 0 for BMimica's per-session single-session
             files, or the row in a pooled multi-session H5 (SLAP-2M keeptrack_h5s).
    gt_dir: dir with {cam}/proofread.analysis.h5 (BMimica layout), ignored if
            gt_paths is given.
    gt_paths: optional {cam: absolute proofread .analysis.h5 path} — SLAP-2M's
              master-sheet layout has no common gt_dir, each camera's GT path is
              independent.
    frame_subset: optional set/frozenset of frame indices. When given, ONLY those
              frames enter the accumulators — GT on every other frame is not
              counted as a miss. Default None keeps the full-session behaviour
              byte for byte, so no deposited number can move.

              This exists for ONE comparison: exhaustive enumeration only emits a
              result on frames where every camera holds exactly `animals` clean
              detections (~48% of BMimica), so scoring it over the whole session
              charges it an IDFN for every frame it structurally cannot enter,
              while greedy is scored over all of them. That is a COVERAGE
              difference, not a quality one, and `fig3_headtohead.py`'s own caveat
              list says so ("exhaustive is scored over only the frames it computed
              while greedy is scored over the whole session ... the gap is not a
              quality difference"). Passing the exhaustive arm's computed-frame set
              here for BOTH arms is what makes their IDF1 comparable.
    Returns a dict; raises on missing files (caller decides failed/why).
    """
    with open(result_json_path) as f:
        luc = json.load(f)

    det_all = {}
    gt_all = {}
    for cam in cameras:
        with h5py.File(Path(det_dir) / f"{cam}_predictions.h5", "r") as f:
            det_all[cam] = f["tracks"][det_session_idx][...]
        gt_path = Path(gt_paths[cam]) if gt_paths else Path(gt_dir) / cam / "proofread.analysis.h5"
        gt_all[cam] = ev.load_gt(gt_path)

    within_idtp = 0
    within_matches = 0
    pooled = mm.MOTAccumulator(auto_id=False)
    percam_idf1 = []
    percam_idp = []
    percam_idr = []
    percam_recall = []
    percam_precision = []
    within_sw = within_fp = within_miss = within_frag = within_obj = 0
    for ci, cam in enumerate(cameras):
        det = det_all[cam]
        gt, occ = gt_all[cam]
        nf = min(gt.shape[0], det.shape[0])
        if max_frames:
            nf = min(nf, max_frames)
        ndet = det.shape[1]
        ids = ev.luc3d_assignments_for_cam(luc, cam, nf, ndet)  # (nf, ndet) global id or -1
        pc = mm.MOTAccumulator(auto_id=False)
        for fi in range(nf):
            if frame_subset is not None and fi not in frame_subset:
                continue
            gtb, gti = [], []
            for t in range(gt.shape[1]):
                if not occ[fi, t]:
                    continue
                b = ev.bbox_from_kpts(gt[fi, t])
                if b is not None:
                    gtb.append(b)
                    gti.append(int(t))
            prb, pid_local, pid_global = [], [], []
            for a in range(ndet):
                b = ev.bbox_from_kpts(det[fi, a])
                if b is None:
                    continue
                g = int(ids[fi, a])
                if g < 0:
                    continue
                prb.append(b)
                pid_local.append(g)
                pid_global.append(g)
            gtn = np.array(gtb) if gtb else np.empty((0, 4))
            prn = np.array(prb) if prb else np.empty((0, 4))
            dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)
            pc.update(gti, pid_local, dist, frameid=fi)
            pooled.update(gti, pid_global, dist, frameid=ci * 10_000_000 + fi)
        s = mm.metrics.create().compute(pc, metrics=METRICS, name="c")
        percam_idf1.append(float(s["idf1"]["c"]))
        percam_idp.append(float(s["idp"]["c"]))
        percam_idr.append(float(s["idr"]["c"]))
        percam_recall.append(float(s["recall"]["c"]))
        percam_precision.append(float(s["precision"]["c"]))
        within_sw += int(s["num_switches"]["c"])
        within_fp += int(s["num_false_positives"]["c"])
        within_miss += int(s["num_misses"]["c"])
        within_frag += int(s["num_fragmentations"]["c"])
        within_obj += int(s["num_objects"]["c"])
        within_idtp += int(s["idtp"]["c"])
        within_matches += int(s["num_matches"]["c"])

    sp = mm.metrics.create().compute(pooled, metrics=METRICS, name="p")
    return {
        "within_idf1": float(np.mean(percam_idf1)),
        "within_idp": float(np.mean(percam_idp)),
        "within_idr": float(np.mean(percam_idr)),
        "within_switches": within_sw,
        "cross_idf1": float(sp["idf1"]["p"]),
        "cross_idp": float(sp["idp"]["p"]),
        "cross_idr": float(sp["idr"]["p"]),
        "cross_switches": int(sp["num_switches"]["p"]),
        "within_recall": float(np.mean(percam_recall)),
        "within_precision": float(np.mean(percam_precision)),
        "within_false_positives": within_fp,
        "within_misses": within_miss,
        "within_fragmentations": within_frag,
        "within_objects": within_obj,
        # IDA = idtp / num_matches, summed over cameras (a rate, not a mean of rates).
        "within_idtp": within_idtp,
        "within_matches": within_matches,
        "within_ida": (within_idtp / within_matches) if within_matches else None,
        "cross_idtp": int(sp["idtp"]["p"]),
        "cross_matches": int(sp["num_matches"]["p"]),
        "cross_ida": (float(sp["idtp"]["p"]) / float(sp["num_matches"]["p"])
                      if float(sp["num_matches"]["p"]) else None),
        "per_camera_idf1": percam_idf1,
    }


def score_cell(session_scores):
    """Aggregate several score_session() dicts into one grid-cell record."""
    n = len(session_scores)
    if n == 0:
        return None
    def mean_of(key):
        # `.get` because a cell scored before idp/idr were added has neither, and an
        # older deposit must still aggregate rather than raise.
        vals = [s[key] for s in session_scores if s.get(key) is not None]
        return float(np.mean(vals)) if vals else None

    return {
        "idf1_within": float(np.mean([s["within_idf1"] for s in session_scores])),
        "idf1_cross": float(np.mean([s["cross_idf1"] for s in session_scores])),
        "idp_within": mean_of("within_idp"), "idr_within": mean_of("within_idr"),
        "idp_cross": mean_of("cross_idp"), "idr_cross": mean_of("cross_idr"),
        "switches": int(sum(s["within_switches"] for s in session_scores)),
        "n_sessions": n,
    }


if __name__ == "__main__":
    # Smoke-test CLI: score one session's result JSON against BMimica GT.
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True)
    ap.add_argument("--det-dir", required=True)
    ap.add_argument("--gt-dir", required=True)
    ap.add_argument("--cameras", required=True, help="comma-separated")
    ap.add_argument("--num-animals", type=int, required=True)
    ap.add_argument("--max-frames", type=int, default=None)
    a = ap.parse_args()
    r = score_session(a.result, a.det_dir, a.gt_dir, a.cameras.split(","), a.num_animals, a.max_frames)
    print(json.dumps(r, indent=2))
