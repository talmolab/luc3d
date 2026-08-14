#!/usr/bin/env python
"""Fig 7a fairness fix, ByteTrack half — give the ByteTrack baseline the same
2-identity constraint LUC3D's arm has by construction.

    ############################################################################
    WHY THIS EXISTS, and it is the same defect as the SLEAP half.

    ByteTrack scores within-view IDF1 0.1574 on the 50 BMimica sessions, and the
    audit (`figs/out/ITEM6-BASELINE-AUDIT.md` §1) traced that to LONG-HORIZON
    FRAGMENTATION, not to mislabelling: a median 85 track ids per camera-session
    over 180,200 frames, an arithmetic IDF1 ceiling of 0.1903, and 0.157 is 83% of
    that ceiling. The SAME files score 0.56 on a 20,000-frame window.

    Its configuration is ours: `scripts/bartul/bmimica_bytetrack.py` calls
    `run_bytetrack_bench.run_camera_session(src, 0)` with the DEFAULTS, which are
    "the tuned winner from scripts/sweep_bytetrack.py (2026-05-17)" --
    `lost_track_buffer = 60` FRAMES, i.e. 2 s at 30 fps. On a 180,200-frame session
    any occlusion longer than two seconds retires the track and the animal comes
    back with a new id. That is a parameter chosen on a different corpus, and
    LUC3D's arm on this corpus cannot fragment at all: it is constrained to 2
    global identities by construction. So the comparison charges ByteTrack for a
    horizon we set for it.

    Eric, 2026-08-13: SLEAP re-run with 2 tracks enforced, "and same for bytetrack
    if possible".
    ############################################################################

FOUR ARMS, FROM TWO TRACKING RUNS. `supervision.ByteTrack` has no `max_tracks`, so
the cap is approached from two directions and both are reported:

    B0  shipped                 lost_track_buffer = 60          (on disk already)
    B1  never-retire            lost_track_buffer = n_frames     ByteTrack's OWN knob
    B0s shipped + 2-id stitch   B0 relabelled to 2 identities
    B1s never-retire + stitch   B1 relabelled to 2 identities

`lost_track_buffer = n_frames` means a lost track is never retired, so ByteTrack
itself may re-acquire an animal after an arbitrary gap. Everything else --
`track_activation_threshold` 0.25, `minimum_matching_threshold` 0.9, the
keypoint-derived boxes, the shared detection pool -- is UNCHANGED, and the run goes
through the same `run_camera_session` the shipped arm used, so the only difference
is that one argument.

THE STITCH, AND WHAT IT IS NOT. `stitch_to_2()` is a TRACKLET-LEVEL relabelling: it
keeps every ByteTrack tracklet whole and binds it, for life, to one of two
identity slots -- the slot whose last-seen box is nearest (IoU, then centroid
distance) at the frame the tracklet is born, excluding slots held by a tracklet
alive in that frame. ByteTrack's own association is preserved exactly; only the
NUMBER of identities is capped, which is what `--max_tracks 2` does for sleap-nn.

    It uses NO ground truth. The GT-optimal version of the same operation -- assign
    each tracklet to whichever GT animal it overlaps most -- is a CEILING, not a
    method, and is deliberately NOT implemented here: this script's job is to report
    what a 2-identity ByteTrack actually achieves. If the greedy stitch lands far
    below the shipped arm's own top-2-id ceiling (0.1903, ITEM6 §1) the gap is
    stitching error and belongs in a caveat; it must never be closed by letting the
    method peek at ground truth
    ([[verify-against-gt-never-use-it-in-the-method]]).

THE GATE. This script's scorer is a re-implementation, so before any new number is
reported it re-scores the SHIPPED B0 files and must reproduce
`outputs/bmimica/bmimica_crossview_all_eval.csv`'s `byte_idf1` / `byte_xview_idf1`
per session to 1e-9. Conventions are copied from
`scripts/bartul/bmimica_eval_crossview_all.py` deliberately: per-camera IDF1 on the
camera's own ids, pooled cross-view with the hypothesis id CAMERA-SCOPED as
`ci * 100000 + tid`, IoU matrix capped at 0.5. Camera-scoping is not optional here
-- with 2 enforced identities, UNSCOPED pooling would hand a per-camera tracker
free cross-view identity through shared slot numbering (the 0.469 artefact in
ITEM6 §6), which is precisely the flattering-correction failure mode.

B0 IS A FILE FROM MAY AND B1 IS WRITTEN TODAY, so the library could have moved under
the comparison. Measured, not assumed: re-running `20250829_141847/21241563` at the
SHIPPED parameters under the CURRENT supervision (0.30.0) reproduces the stored array
**cell for cell** -- `identical: True`, max abs diff 0.0 over 4,321,296 cells, 114
distinct ids both ways (`figs/out/tmp/byte_drift_check.log`). So the B0 -> B1 delta is
the `lost_track_buffer` change and nothing else.

    # tracking needs supervision (eks_env), scoring needs motmetrics (liezl_env)
    /root/vast/eric/luc3d-bench/eks_env/bin/python figs/fig7_bytetrack_max2.py \
        --stage track --workers 10
    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig7_bytetrack_max2.py \
        --stage score --workers 16

Output: outputs/bmimica/results/bytetrack_noretire/{session}/{cam}.h5 (B1),
        figs/out/fig7_bytetrack_max2.json (all four arms + the gate).
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
BENCH = Path("/root/vast/eric/luc3d-bench")
BM = BENCH / "outputs" / "bmimica"
DET = BM / "det_h5"
GT = BM / "gt"
B0 = BM / "results" / "bytetrack"                  # shipped
B1 = BM / "results" / "bytetrack_noretire"         # this script's run
REF_CSV = BM / "bmimica_crossview_all_eval.csv"
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]
#: Reproduction tolerance for the shipped arm through this scorer. Not a knob: the two
#: implementations make the same motmetrics calls on the same boxes, so only float
#: summation order should differ.
GATE_TOL = 1e-9


def sessions():
    return sorted(p.name for p in DET.iterdir()
                  if p.is_dir() and (GT / p.name).is_dir())


# ---------------------------------------------------------------- stage: track
def track_job(args):
    sid, cam = args
    sys.path.insert(0, str(BENCH / "scripts"))
    import h5py
    from run_bytetrack_bench import run_camera_session
    src = DET / sid / f"{cam}_predictions.h5"
    dst = B1 / sid / f"{cam}.h5"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 500:
        return (sid, cam, "skip", 0.0)
    if not src.exists():
        return (sid, cam, "no_src", 0.0)
    t0 = time.time()
    try:
        with h5py.File(src, "r") as f:
            n_frames = int(f["tracks"].shape[1])
        # THE ONLY CHANGED ARGUMENT. supervision's ByteTrack sets
        # `max_time_lost = int(frame_rate / 30 * lost_track_buffer)` and the bench calls
        # it with frame_rate=30, so `lost_track_buffer = n_frames` means a lost track is
        # never retired within the session.
        arr = run_camera_session(src, 0, lost_track_buffer=n_frames)
        with h5py.File(dst, "w") as f:
            f.create_dataset("tracks", data=arr, dtype="float64",
                             compression="gzip", compression_opts=4)
            f.attrs["columns"] = "track_id,x1,y1,x2,y2,score"
            f.attrs["lost_track_buffer"] = n_frames
            f.attrs["note"] = ("never-retire arm for Fig 7a's ByteTrack fairness fix; "
                               "all other parameters identical to the shipped run")
        return (sid, cam, "ok", time.time() - t0)
    except Exception as e:  # noqa: BLE001
        return (sid, cam, "ERR:" + repr(e)[:300], time.time() - t0)


# ---------------------------------------------------------------- the stitch
def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
    return inter / ua if ua > 0 else 0.0


def stitch_to_2(arr, n_slots=2):
    """Relabel a `(n_frames, n_animals, 6)` ByteTrack array to at most `n_slots`
    identities, tracklet-whole and without ground truth.

    Each ByteTrack id is bound to one slot at birth and keeps it for life, so the
    tracker's own association is untouched. The slot is the one whose LAST-SEEN box is
    nearest the tracklet's first box -- IoU first, centroid distance as the tie-break
    when no slot overlaps -- among slots not held by a tracklet that is alive in that
    same frame (two ids present in one frame can never collapse into one identity, which
    would manufacture a false match).
    """
    out = arr.copy()
    slot_of = {}                       # bytetrack id -> slot
    last_box = {}                      # slot -> last seen box
    last_frame = {}                    # slot -> last frame seen
    alive_until = {}                   # bytetrack id -> last frame it appeared
    for fi in range(arr.shape[0]):
        rows = [(j, arr[fi, j]) for j in range(arr.shape[1])
                if np.isfinite(arr[fi, j, 0])]
        # ids already present in this frame block their slots
        busy = {slot_of[int(r[0])] for _j, r in rows if int(r[0]) in slot_of}
        for j, r in rows:
            tid = int(r[0])
            box = r[1:5]
            if tid not in slot_of:
                free = [s for s in range(n_slots) if s not in busy]
                if not free:
                    # More concurrent ids than identities: leave this detection on the
                    # slot whose box it overlaps most, accepting the duplicate rather
                    # than inventing a third identity. Rare, and never silent -- the
                    # scorer counts these.
                    cand = list(range(n_slots))
                else:
                    cand = free
                scored = []
                for s in cand:
                    if s not in last_box:
                        scored.append((1.0, 0.0, s))       # never used: take it first
                        continue
                    iou = _iou(box, last_box[s])
                    cx = ((box[0] + box[2]) / 2 - (last_box[s][0] + last_box[s][2]) / 2)
                    cy = ((box[1] + box[3]) / 2 - (last_box[s][1] + last_box[s][3]) / 2)
                    scored.append((iou, -float(np.hypot(cx, cy)), s))
                scored.sort(reverse=True)
                slot_of[tid] = scored[0][2]
                busy.add(scored[0][2])
            s = slot_of[tid]
            out[fi, j, 0] = s
            last_box[s] = box
            last_frame[s] = fi
            alive_until[tid] = fi
    return out


# ---------------------------------------------------------------- stage: score
def score_session(sid, arms):
    """`{arm: (within_idf1, within_sw, cross_idf1_scoped, cross_sw, n_ids)}`.

    Conventions copied from `scripts/bartul/bmimica_eval_crossview_all.py`: per-camera
    accumulator on the camera's own ids; one pooled accumulator with the hypothesis id
    camera-scoped as `ci * 100000 + tid`; `mm.distances.iou_matrix(..., max_iou=0.5)`.
    """
    import h5py
    sys.path.insert(0, str(BENCH / "scripts"))
    import evaluate as ev
    import motmetrics as mm

    res = {}
    gt, arrs = {}, {a: {} for a in arms}
    for c in SER:
        gp = GT / sid / c / "proofread.analysis.h5"
        if not gp.exists():
            return None
        with h5py.File(gp, "r") as f:
            gt[c] = np.transpose(f["tracks"][:], (3, 0, 2, 1))
        for a in arms:
            src = (B0 if a.startswith("B0") else B1) / sid / f"{c}.h5"
            if not src.exists():
                return None
            with h5py.File(src, "r") as f:
                raw = f["tracks"][:]
            arrs[a][c] = stitch_to_2(raw) if a.endswith("s") else raw

    for a in arms:
        percam, sw2d, ids = [], 0, set()
        pooled = mm.MOTAccumulator(auto_id=False)
        for ci, c in enumerate(SER):
            g, b = gt[c], arrs[a][c]
            nf = min(g.shape[0], b.shape[0])
            pc = mm.MOTAccumulator(auto_id=False)
            for fi in range(nf):
                gb, gi = [], []
                for t in range(g.shape[1]):
                    box = ev.bbox_from_kpts(g[fi, t])
                    if box is not None:
                        gb.append(box)
                        gi.append(t)
                prb, pl, pg = [], [], []
                for j in range(b.shape[1]):
                    row = b[fi, j]
                    if not np.isfinite(row[0]):
                        continue
                    tid = int(row[0])
                    prb.append(row[1:5])
                    pl.append(tid)
                    pg.append(ci * 100000 + tid)
                    ids.add((ci, tid))
                gn = np.array(gb) if gb else np.empty((0, 4))
                pn = np.array(prb) if prb else np.empty((0, 4))
                dist = mm.distances.iou_matrix(gn, pn, max_iou=0.5)
                pc.update(gi, pl, dist, frameid=fi)
                pooled.update(gi, pg, dist, frameid=ci * 10 ** 7 + fi)
            s = mm.metrics.create().compute(pc, metrics=["idf1", "num_switches"], name="c")
            percam.append(float(s["idf1"]["c"]))
            sw2d += int(s["num_switches"]["c"])
        sp = mm.metrics.create().compute(pooled, metrics=["idf1", "num_switches"], name="p")
        res[a] = {"within_idf1": float(np.mean(percam)), "within_sw": sw2d,
                  "cross_idf1_scoped": float(sp["idf1"]["p"]),
                  "cross_sw": int(sp["num_switches"]["p"]),
                  "n_ids_total": len(ids),
                  "per_camera_idf1": percam}
    return {"session": sid, **{f"arm_{k}": v for k, v in res.items()}}


def _score_job(sid, arms):
    try:
        return sid, score_session(sid, arms), None
    except Exception as e:  # noqa: BLE001
        return sid, None, repr(e)


def gate(rows):
    """Re-score-or-refuse: the shipped B0 arm through THIS scorer must reproduce the
    bench CSV, or the new arms are measuring something else."""
    import csv
    ref = {}
    with open(REF_CSV) as f:
        for r in csv.DictReader(f):
            if r.get("byte_idf1"):
                ref[r["session"]] = (float(r["byte_idf1"]), float(r["byte_xview_idf1"]))
    have = [r for r in rows if r["session"] in ref]
    if not have:
        raise SystemExit(f"[byte] no session of this run is in {REF_CSV.name} -- gate "
                         f"cannot run and no number here is publishable")
    dw = max(abs(r["arm_B0"]["within_idf1"] - ref[r["session"]][0]) for r in have)
    dc = max(abs(r["arm_B0"]["cross_idf1_scoped"] - ref[r["session"]][1]) for r in have)
    print(f"[byte] GATE vs {REF_CSV.name} over {len(have)} sessions: "
          f"within max |diff| {dw:.3e}, cross max |diff| {dc:.3e}")
    if dw > GATE_TOL or dc > GATE_TOL:
        worst = max(have, key=lambda r: abs(r["arm_B0"]["within_idf1"]
                                            - ref[r["session"]][0]))
        raise SystemExit(
            f"[byte] GATE FAILED -- this scorer does not reproduce the bench's ByteTrack "
            f"numbers, so the never-retire and stitched arms are not comparable to Fig "
            f"7a's. Worst session {worst['session']}: {worst['arm_B0']['within_idf1']!r} "
            f"vs {ref[worst['session']][0]!r}. Do not widen GATE_TOL.")
    return {"reference": REF_CSV.name, "n_sessions": len(have),
            "max_abs_diff_within": dw, "max_abs_diff_cross": dc,
            "tolerance": GATE_TOL, "passed": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["track", "score"], required=True)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--sessions", default=None)
    ap.add_argument("--arms", default="B0,B0s,B1,B1s")
    ap.add_argument("--out", default="fig7_bytetrack_max2.json")
    a = ap.parse_args()
    sess = a.sessions.split(",") if a.sessions else sessions()

    if a.stage == "track":
        jobs = [(s, c) for s in sess for c in SER]
        print(f"[byte] never-retire run: {len(sess)} sessions, {len(jobs)} "
              f"camera-sessions -> {B1}", flush=True)
        B1.mkdir(parents=True, exist_ok=True)
        done = fail = 0
        t0 = time.time()
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            for f in as_completed([ex.submit(track_job, j) for j in jobs]):
                sid, cam, st, dt = f.result()
                done += 1
                if st.startswith(("ERR", "no_src")):
                    fail += 1
                    print(f"  {sid}/{cam}: {st}", flush=True)
                if done % 10 == 0 or st.startswith(("ERR", "no_src")):
                    print(f"[byte] {done}/{len(jobs)} ({time.time() - t0:.0f}s)",
                          flush=True)
        print(f"[byte] track done: {done - fail} ok, {fail} failed, "
              f"{time.time() - t0:.0f}s")
        return

    arms = a.arms.split(",")
    rows = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_score_job, s, arms) for s in sess]
        for i, fut in enumerate(as_completed(futs), 1):
            sid, r, err = fut.result()
            if err:
                print(f"[byte] FAILED {sid}: {err}", flush=True)
                continue
            if r is None:
                continue
            rows.append(r)
            msg = "  ".join(f"{k[4:]} {r[k]['within_idf1']:.4f}/{r[k]['n_ids_total']}ids"
                            for k in r if k.startswith("arm_"))
            print(f"[byte] {sid}: {msg}  ({i}/{len(sess)})", flush=True)
    if not rows:
        sys.exit("[byte] nothing scored")
    rows.sort(key=lambda r: r["session"])
    g = gate(rows) if "B0" in arms else {"passed": False, "reason": "B0 not scored"}

    summary = {}
    for arm in arms:
        k = f"arm_{arm}"
        summary[arm] = {
            "within_idf1_mean": float(np.mean([r[k]["within_idf1"] for r in rows])),
            "within_idf1_median": float(np.median([r[k]["within_idf1"] for r in rows])),
            "cross_idf1_scoped_mean":
                float(np.mean([r[k]["cross_idf1_scoped"] for r in rows])),
            "within_switches_total": int(sum(r[k]["within_sw"] for r in rows)),
            "ids_per_session_median": float(np.median([r[k]["n_ids_total"] for r in rows])),
            "n_sessions": len(rows),
        }
        s = summary[arm]
        print(f"[byte] {arm:4s} within {s['within_idf1_mean']:.4f} "
              f"(median {s['within_idf1_median']:.4f})  cross-scoped "
              f"{s['cross_idf1_scoped_mean']:.4f}  switches "
              f"{s['within_switches_total']:,}  ids/session median "
              f"{s['ids_per_session_median']:.0f}")

    (OUT / a.out).write_text(json.dumps({
        "generated_by": "figs/fig7_bytetrack_max2.py",
        "claim": "ByteTrack on the 50 BMimica sessions under four identity-horizon "
                 "configurations, scored with the bench's own conventions (per-camera "
                 "IDF1; cross-view pooled CAMERA-SCOPED as ci*100000+tid; IoU max 0.5).",
        "why": "The shipped arm's lost_track_buffer of 60 frames (2 s) retires a track on "
               "any longer occlusion, and BMimica sessions are 180,200 frames. LUC3D's arm "
               "is constrained to 2 global identities by construction, so the shipped "
               "comparison charges ByteTrack for a horizon we chose for it.",
        "arms": {
            "B0": "shipped: lost_track_buffer=60, the sweep_bytetrack.py default",
            "B0s": "B0 relabelled to 2 identities by stitch_to_2() (no ground truth)",
            "B1": "never-retire: lost_track_buffer=n_frames, all else identical",
            "B1s": "B1 relabelled to 2 identities by stitch_to_2() (no ground truth)",
        },
        "pooling_convention": "CAMERA-SCOPED. With 2 enforced identities, unscoped "
                              "pooling would give a per-camera tracker free cross-view "
                              "identity through shared slot numbering (ITEM6 §6's 0.469 "
                              "artefact) -- a correction that flatters us.",
        "gate": g,
        "summary": summary,
        "per_session": rows,
    }, indent=1))
    print(f"[byte] wrote {OUT / a.out}  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
