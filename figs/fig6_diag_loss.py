#!/usr/bin/env python
"""Fig 8 diagnostic — DECOMPOSE the shipped tracker's IDF1 loss before trying to fix it.

Fig 8's 1-D sweeps say the shipped default sits at cross-view IDF1 0.735 and that
nine of ten thresholds cannot move it. They do NOT say what the missing 0.265 IS.
Two very different failure modes produce the same IDF1:

  (a) IDENTITY error   — the tracker labelled a detection, and labelled it wrong
                         (a switch, or a whole track carrying the other animal's id).
  (b) COVERAGE error   — the tracker labelled nothing at all, so a real detection
                         that GT matches is a MISS no matter how good the ids are.

Those have disjoint fixes, and picking the wrong one wastes the whole effort. In
particular `commitTrackedFrame` (pose/tracker.js) emits a group ONLY when a target
has >= 2 views in that frame (`if (members.length < 2) continue`), so a frame where
an animal is confidently tracked but visible to one camera contributes NOTHING to
any camera's output. That is a coverage bug, not an identity bug, and no association
threshold in Fig 8 can touch it.

This script measures three IDF1 numbers per (session, camera) off an EXISTING result
JSON (no re-tracking):

  as_is       the tracker's own identities                        = what Fig 8 reports
  oracle_id   every detection the tracker LABELLED, relabelled to
              the id of its best-IoU GT box                       = ceiling for a
                                                                    perfect-identity
                                                                    fix at TODAY'S
                                                                    coverage
  oracle_full every detection with a bbox, relabelled the same way = ceiling if
                                                                    coverage were
                                                                    also perfect
                                                                    (detector limit)

`oracle_id - as_is` is the headroom an association/re-id method can win.
`oracle_full - oracle_id` is the headroom that is locked behind emitting anything
at all for these detections. Reported alongside the raw assignment rate
(labelled detections / detections with a bbox).

    $PY figs/fig8_diag_loss.py --cell default
    $PY figs/fig8_diag_loss.py --cell default --max-frames 30000 --sessions 20250903_141046

Run with the bench interpreter (motmetrics):
/root/vast/eric/luc3d-bench/liezl_env/bin/python
"""
import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig3_score as fs  # noqa: E402
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402

OUT_DIR = REPO / "figs" / "out"


def diag_session(result_json, det_dir, gt_dir, cameras, max_frames=None):
    """Three IDF1s + the assignment rate for one session. See module docstring."""
    with open(result_json) as f:
        luc = json.load(f)

    accs = {k: mm.MOTAccumulator(auto_id=False) for k in ("as_is", "oracle_id", "oracle_full")}
    n_det_bbox = 0        # detections with a valid bbox (the denominator)
    n_det_labelled = 0    # ... of those, ones the tracker gave an identity
    n_gt_bbox = 0
    percam = {k: [] for k in accs}

    for ci, cam in enumerate(cameras):
        with h5py.File(Path(det_dir) / f"{cam}_predictions.h5", "r") as f:
            det = f["tracks"][0][...]
        gt, occ = ev.load_gt(Path(gt_dir) / cam / "proofread.analysis.h5")
        nf = min(gt.shape[0], det.shape[0])
        if max_frames:
            nf = min(nf, max_frames)
        ndet = det.shape[1]
        ids = ev.luc3d_assignments_for_cam(luc, cam, nf, ndet)

        pc = {k: mm.MOTAccumulator(auto_id=False) for k in accs}
        for fi in range(nf):
            gtb, gti = [], []
            for t in range(gt.shape[1]):
                if not occ[fi, t]:
                    continue
                b = ev.bbox_from_kpts(gt[fi, t])
                if b is not None:
                    gtb.append(b)
                    gti.append(int(t))
            prb, pid, labelled = [], [], []
            for a in range(ndet):
                b = ev.bbox_from_kpts(det[fi, a])
                if b is None:
                    continue
                prb.append(b)
                pid.append(int(ids[fi, a]))
                labelled.append(int(ids[fi, a]) >= 0)
            n_det_bbox += len(prb)
            n_det_labelled += sum(labelled)
            n_gt_bbox += len(gtb)

            gtn = np.array(gtb) if gtb else np.empty((0, 4))
            prn = np.array(prb) if prb else np.empty((0, 4))
            dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)

            # oracle id for each detection = GT id of its best-IoU (lowest-dist) GT box;
            # a detection with no GT overlap keeps a private id so it stays a false
            # positive rather than being silently deleted (that would flatter the oracle).
            oracle = []
            for j in range(len(prb)):
                col = dist[:, j] if dist.size else np.array([])
                if col.size and np.isfinite(col).any():
                    oracle.append(gti[int(np.nanargmin(col))])
                else:
                    oracle.append(10_000 + j)

            def push(key, keep, use_ids):
                sel = [j for j in range(len(prb)) if keep(j)]
                d = dist[:, sel] if dist.size and sel else np.empty((len(gtb), len(sel)))
                pc[key].update(gti, [use_ids[j] for j in sel], d, frameid=fi)
                accs[key].update(gti, [use_ids[j] for j in sel], d,
                                 frameid=ci * 10_000_000 + fi)

            push("as_is", lambda j: pid[j] >= 0, pid)
            push("oracle_id", lambda j: pid[j] >= 0, oracle)
            push("oracle_full", lambda j: True, oracle)

        for k in accs:
            s = mm.metrics.create().compute(pc[k], metrics=["idf1", "num_switches"], name="c")
            percam[k].append((float(s["idf1"]["c"]), int(s["num_switches"]["c"])))

    out = {}
    for k in accs:
        s = mm.metrics.create().compute(accs[k], metrics=["idf1", "num_switches"], name="p")
        out[f"cross_idf1_{k}"] = float(s["idf1"]["p"])
        out[f"within_idf1_{k}"] = float(np.mean([v[0] for v in percam[k]]))
        out[f"within_switches_{k}"] = int(sum(v[1] for v in percam[k]))
    out["det_bbox"] = n_det_bbox
    out["det_labelled"] = n_det_labelled
    out["gt_bbox"] = n_gt_bbox
    out["assign_rate"] = n_det_labelled / max(1, n_det_bbox)
    return out


def _job(cell, session, max_frames, root="fig8"):
    p = OUT_DIR / "tmp" / root / cell / f"{session}.json"
    if not p.exists():
        return session, None, f"missing {p}"
    try:
        return session, diag_session(str(p), str(f3.DET / session), str(f3.GT / session),
                                     f3.CAMERAS, max_frames), None
    except Exception as e:  # noqa: BLE001
        return session, None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", default="default")
    ap.add_argument("--root", default="fig8",
                    help="cache tree under figs/out/tmp/ holding <cell>/<session>.json "
                         "-- `fig8` for fig6_param_sweeps.py's threshold cells, `fig8m` "
                         "for fig6_methods.py's method cells")
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--sessions", default=None, help="comma-separated subset")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    sessions = a.sessions.split(",") if a.sessions else f3.SESSIONS
    rows = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, a.cell, s, a.max_frames, a.root) for s in sessions]
        for fut in as_completed(futs):
            s, r, err = fut.result()
            if err:
                print(f"[diag] {s} FAILED: {err}", flush=True)
                continue
            r["session"] = s
            rows.append(r)
            print(f"[diag] {s}: as_is={r['cross_idf1_as_is']:.4f} "
                  f"oracle_id={r['cross_idf1_oracle_id']:.4f} "
                  f"oracle_full={r['cross_idf1_oracle_full']:.4f} "
                  f"assign_rate={r['assign_rate']:.4f} "
                  f"sw={r['within_switches_as_is']}", flush=True)

    rows.sort(key=lambda r: r["session"])
    if rows:
        print()
        print(f"{'session':<18} {'as_is':>7} {'orc_id':>7} {'orc_full':>8} "
              f"{'id_gap':>7} {'cov_gap':>8} {'assign':>7} {'sw':>5}")
        for r in rows:
            print(f"{r['session']:<18} {r['cross_idf1_as_is']:>7.4f} "
                  f"{r['cross_idf1_oracle_id']:>7.4f} {r['cross_idf1_oracle_full']:>8.4f} "
                  f"{r['cross_idf1_oracle_id'] - r['cross_idf1_as_is']:>7.4f} "
                  f"{r['cross_idf1_oracle_full'] - r['cross_idf1_oracle_id']:>8.4f} "
                  f"{r['assign_rate']:>7.4f} {r['within_switches_as_is']:>5d}")
        m = lambda k: float(np.mean([r[k] for r in rows]))  # noqa: E731
        print(f"{'MEAN':<18} {m('cross_idf1_as_is'):>7.4f} "
              f"{m('cross_idf1_oracle_id'):>7.4f} {m('cross_idf1_oracle_full'):>8.4f} "
              f"{m('cross_idf1_oracle_id') - m('cross_idf1_as_is'):>7.4f} "
              f"{m('cross_idf1_oracle_full') - m('cross_idf1_oracle_id'):>8.4f} "
              f"{m('assign_rate'):>7.4f} "
              f"{sum(r['within_switches_as_is'] for r in rows):>5d}")

    dest = Path(a.out) if a.out else OUT_DIR / f"fig8_diag_loss_{a.cell}.json"
    dest.write_text(json.dumps({
        "cell": a.cell, "root": a.root, "max_frames": a.max_frames,
        "sessions": sessions,
        "note": "oracle_id = tracker's coverage + perfect identities; oracle_full = "
                "every bbox detection + perfect identities. id_gap is what an "
                "association/re-id fix can win; cov_gap is locked behind emitting "
                "anything for detections the tracker currently drops.",
        "per_session": rows,
    }, indent=2))
    print(f"\n[diag] wrote {dest}")


if __name__ == "__main__":
    main()
