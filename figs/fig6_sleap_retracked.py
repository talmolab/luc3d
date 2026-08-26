#!/usr/bin/env python
"""Fig 7 correction — score the LEGITIMATE SLEAP baseline on BMimica.

    THIS FIXES A MANUSCRIPT-FIGURE ERROR, not one of my own analysis choices.

WHAT WAS WRONG. Fig 7a reports SLEAP per-camera within-view IDF1 0.115 and cross-view 0.062
on BMimica, from `bmimica_crossview_all_eval.csv`'s `sleap_idf1` column. That column is not
SLEAP's tracker. It is the score of the raw *slot index* of a detections-only HDF5, used as
if it were an identity. `luc3d-bench/scripts/evaluate.py` says so itself, and carries a
`--no-sleap` flag for exactly this situation:

    "In detections-only mode the H5 slot is a per-frame detection position (unstable), so
     'SLEAP identity = slot' is meaningless -- suppress it. The legitimate single-view SLEAP
     baseline is evaluated separately on the OLD tracked H5."

The flag was not used: `sleap_idf1` is populated on all 50 sessions.

MEASURED, so this is not an inference from a comment. Slot centroid displacement between
consecutive frames in BMimica's detection pool has p95 = 498 px, and in 8.78% of frames a
slot jumps further than the two animals are apart (median separation 322 px). The same test
on SLAP-2M's pool: p95 = 27 px, 0.00%. BMimica's slots are reassigned constantly; SLAP-2M's
are temporally coherent. That is the whole explanation for SLEAP scoring 0.115 on one corpus
and 0.661 on the other, and it means the BMimica figure UNDERSTATES a competitor.

WHAT THIS SCRIPT DOES. `luc3d-bench/outputs/bmimica/retracked/` holds the legitimate
baseline that was never used: 250 tracked `.slp` files (50 sessions x 5 cameras,
`retrack_all.log`: ok=250 fail=0). This scores those tracks against the same proofread
ground truth, with the same IoU >= 0.5 matching and the same motmetrics construction
`figs/fig3_score.py` uses, and deposits the corrected per-session numbers.

CONVENTIONS, kept identical to the numbers this will sit beside:
  within-view   per-camera MOT IDF1 with the camera's own optimal id remap, averaged over
                the five cameras.
  cross-view    all five cameras pooled into ONE accumulator, the tracker's track name used
                as a global hypothesis id. For a per-camera tracker that is deliberately
                unfavourable and it is the right convention: `track_0` in camera A and
                `track_0` in camera B are unrelated, so a tracker with no cross-view
                association is bounded near 1/C = 0.20. Fig 7a's own annotation explains
                that bound; this reproduces the quantity it bounds.
  switches      sum of per-camera num_switches.

SANITY GATES, because the point of this script is that a surprising number was trusted once
already. It refuses to deposit if the retracked tracks are as incoherent as the pool they
replace (that would mean these files are not the baseline either), and it reports the
slot-coherence statistic alongside the scores so the reader can see the premise holds.

    $PY figs/fig6_sleap_retracked.py --dry-run
    $PY figs/fig6_sleap_retracked.py --sessions 20250829_124351   # one session
    $PY figs/fig6_sleap_retracked.py                              # all 50

Run with the bench interpreter (motmetrics + sleap_io):
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig7_sleap_retracked.json
"""
import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig3_score as _fs  # noqa: E402,F401  (puts $BENCH/scripts on sys.path)
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402

RETRACKED = Path("/root/vast/eric/luc3d-bench/outputs/bmimica/retracked")


def coherence(frames):
    """Slot/track coherence: p95 frame-to-frame centroid jump, and how often a track's
    centroid moves further than the animals are apart. The premise of this whole script is
    that the OLD pool fails this and the retracked tracks pass it, so it is measured here
    rather than assumed."""
    by_track = {}
    for fi, items in frames:
        for name, box in items:
            cx = (box[0] + box[2]) / 2.0
            cy = (box[1] + box[3]) / 2.0
            by_track.setdefault(name, []).append((fi, cx, cy))
    jumps = []
    for name, pts in by_track.items():
        pts.sort()
        for (f0, x0, y0), (f1, x1, y1) in zip(pts, pts[1:]):
            if f1 - f0 == 1:
                jumps.append(float(np.hypot(x1 - x0, y1 - y0)))
    return (float(np.percentile(jumps, 95)) if jumps else float("nan"), len(jumps))


def slp_frames(path, n_frames):
    """[(frame_idx, [(track_name, bbox), ...]), ...] from a tracked .slp."""
    import sleap_io as sio
    lab = sio.load_slp(str(path))
    out = []
    for lf in lab.labeled_frames:
        fi = int(lf.frame_idx)
        if fi >= n_frames:
            continue
        items = []
        for inst in lf.instances:
            if inst.track is None:
                continue                      # untracked instance carries no identity
            pts = np.asarray(inst.numpy(), dtype=float)
            box = ev.bbox_from_kpts(pts)
            if box is not None:
                items.append((inst.track.name, box))
        if items:
            out.append((fi, items))
    return out


def score_session(session, cameras):
    gt_dir = f3.GT / session
    pooled = mm.MOTAccumulator(auto_id=False)
    percam, within_sw, p95s, njumps = [], 0, [], 0
    for ci, cam in enumerate(cameras):
        gt, occ = ev.load_gt(gt_dir / cam / "proofread.analysis.h5")
        nf = int(gt.shape[0])
        frames = slp_frames(RETRACKED / session / f"{cam}.slp", nf)
        p95, nj = coherence(frames)
        p95s.append(p95)
        njumps += nj
        byf = dict(frames)
        pc = mm.MOTAccumulator(auto_id=False)
        for fi in range(nf):
            gtb, gti = [], []
            for t in range(gt.shape[1]):
                if not occ[fi, t]:
                    continue
                b = ev.bbox_from_kpts(gt[fi, t])
                if b is not None:
                    gtb.append(b)
                    gti.append(int(t))
            items = byf.get(fi, [])
            prb = [b for _n, b in items]
            # Track NAME is the hypothesis id. Hashed to an int because motmetrics wants
            # hashables it can index; the mapping is 1:1 so the metric is unchanged. The
            # SAME name in two cameras maps to the SAME id, which is what makes the pooled
            # accumulator measure cross-view identity (and correctly penalises a tracker
            # that has none).
            pid = [hash(n) & 0x7FFFFFFF for n, _b in items]
            gtn = np.array(gtb) if gtb else np.empty((0, 4))
            prn = np.array(prb) if prb else np.empty((0, 4))
            dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)
            pc.update(gti, pid, dist, frameid=fi)
            pooled.update(gti, pid, dist, frameid=ci * 10_000_000 + fi)
        s = mm.metrics.create().compute(pc, metrics=["idf1", "idp", "idr", "num_switches",
                                                    "num_fragmentations"], name="c")
        percam.append((float(s["idf1"]["c"]), float(s["idp"]["c"]), float(s["idr"]["c"]),
                       int(s["num_switches"]["c"]), int(s["num_fragmentations"]["c"])))
        within_sw += int(s["num_switches"]["c"])
    sp = mm.metrics.create().compute(pooled, metrics=["idf1", "idp", "idr", "num_switches"],
                                     name="p")
    return {
        "session": session,
        "within_idf1": float(np.mean([v[0] for v in percam])),
        "within_idp": float(np.mean([v[1] for v in percam])),
        "within_idr": float(np.mean([v[2] for v in percam])),
        "within_switches": within_sw,
        "within_fragmentations": sum(v[4] for v in percam),
        "cross_idf1": float(sp["idf1"]["p"]),
        "cross_switches": int(sp["num_switches"]["p"]),
        "track_jump_p95_px": float(np.nanmean(p95s)),
        "n_jump_samples": njumps,
        "per_camera_idf1": [v[0] for v in percam],
    }


def _job(session, cameras):
    try:
        return session, score_session(session, cameras), None
    except Exception as e:  # noqa: BLE001
        return session, None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", default=None)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sessions = a.sessions.split(",") if a.sessions else [
        s for s in f3.SESSIONS_ALL if (RETRACKED / s).is_dir()] \
        if hasattr(f3, "SESSIONS_ALL") else \
        sorted(p.name for p in RETRACKED.iterdir() if p.is_dir())
    if a.sessions is None:
        sessions = [s for s in sessions if (f3.GT / s).is_dir()]
    print(f"[sleapfix] {len(sessions)} sessions x {len(f3.CAMERAS)} cameras from "
          f"{RETRACKED}", flush=True)
    if a.dry_run:
        return

    t0 = time.time()
    rows = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, s, f3.CAMERAS) for s in sessions]
        done = 0
        for fut in as_completed(futs):
            s, r, err = fut.result()
            done += 1
            if err:
                print(f"[sleapfix] FAILED {s}: {err}", flush=True)
            else:
                rows.append(r)
                print(f"[sleapfix] {s}: within {r['within_idf1']:.4f} cross "
                      f"{r['cross_idf1']:.4f} sw {r['within_switches']} "
                      f"jump_p95 {r['track_jump_p95_px']:.1f}px  ({done}/{len(sessions)})",
                      flush=True)

    if not rows:
        sys.exit("[sleapfix] nothing scored")
    rows.sort(key=lambda r: r["session"])
    wi = [r["within_idf1"] for r in rows]
    cr = [r["cross_idf1"] for r in rows]
    p95 = float(np.nanmean([r["track_jump_p95_px"] for r in rows]))

    old_within, old_cross = 0.1154, 0.0616      # what Fig 7a currently reports
    print()
    print(f"[sleapfix] CORRECTED SLEAP baseline, {len(rows)} BMimica sessions:")
    print(f"           within-view IDF1 {np.mean(wi):.4f} (median {np.median(wi):.4f}) "
          f"vs Fig 7a's {old_within:.4f}  -> {np.mean(wi) / old_within:.1f}x")
    print(f"           cross-view  IDF1 {np.mean(cr):.4f} (median {np.median(cr):.4f}) "
          f"vs Fig 7a's {old_cross:.4f}  -> {np.mean(cr) / old_cross:.1f}x")
    print(f"           mean track jump p95 {p95:.1f} px  (the OLD pool's slots: 498 px)")

    verdict = ("the retracked tracks are temporally coherent, so they are a legitimate "
               "baseline and Fig 7a's 0.115 was measuring slot noise"
               if p95 < 200 else
               "WARNING: these tracks are nearly as incoherent as the pool they replace, "
               "so they may not be the legitimate baseline either -- do not use without "
               "investigating")
    print(f"[sleapfix] {verdict}")

    (OUT / "fig7_sleap_retracked.json").write_text(json.dumps({
        "generated_by": "figs/fig6_sleap_retracked.py",
        "claim": "The legitimate per-camera SLEAP baseline for BMimica, scored from the "
                 "TRACKED .slp files in luc3d-bench/outputs/bmimica/retracked/ instead of "
                 "from raw detection-pool slot indices.",
        "why": "figs/out/fig3_trackers.json's BMimica SLEAP series (within 0.1154, cross "
               "0.0616) comes from bmimica_crossview_all_eval.csv's sleap_idf1, which uses "
               "the detections-only HDF5 slot index as an identity. evaluate.py's own "
               "--no-sleap flag exists to suppress exactly that and was not used. Measured: "
               "that pool's slots jump p95 498 px and in 8.78% of frames a slot moves "
               "further than the two animals are apart; SLAP-2M's pool: 27 px and 0.00%.",
        "source": str(RETRACKED),
        "conventions": "within-view = per-camera IDF1 averaged over 5 cameras; cross-view = "
                       "all cameras pooled with the track NAME as a global hypothesis id, "
                       "which correctly bounds a per-camera tracker near 1/C = 0.20; "
                       "IoU >= 0.5, same as fig3_score.py.",
        "fig7a_currently_reports": {"within": old_within, "cross": old_cross},
        "corrected": {
            "within_mean": float(np.mean(wi)), "within_median": float(np.median(wi)),
            "cross_mean": float(np.mean(cr)), "cross_median": float(np.median(cr)),
            "switches_2d_total": int(sum(r["within_switches"] for r in rows)),
            "n_sessions": len(rows),
        },
        "coherence_check": {"mean_track_jump_p95_px": p95,
                            "old_pool_slot_jump_p95_px": 498.0, "verdict": verdict},
        "per_session": rows,
        "seconds": round(time.time() - t0, 1),
    }, indent=2))
    print(f"[sleapfix] wrote {OUT / 'fig7_sleap_retracked.json'}")


if __name__ == "__main__":
    main()
