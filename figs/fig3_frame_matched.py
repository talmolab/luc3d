#!/usr/bin/env python
"""Exhaustive vs greedy IDF1/switches on THE SAME FRAMES -- the fair basis for Fig 3d.

    ############################################################################
    WHY THIS DEPOSIT EXISTS. Fig 3d drew exhaustive enumeration as a flat rule at
    cross-view IDF1 0.400 against the greedy r-sweep's 0.44-0.86, and that gap is
    not a quality difference. Both arms were scored by ONE call to
    `fig3_score.score_session` over the WHOLE session (`fig3_headtohead.py:361`),
    but exhaustive only emits a result on frames where every camera holds exactly
    `animals` clean detections -- 4,324,469 of 9,004,392 BMimica frames, 48%. On the
    other 52% it emits nothing, so every ground-truth animal there is charged to it
    as an identity miss, while greedy is scored on all of them.

    `fig3_headtohead.py`'s own caveat list says exactly this ("exhaustive is scored
    over only the frames it computed while greedy is scored over the whole session,
    so the two coverages differ by construction and the gap is not a quality
    difference ... IDF1/switches are reported for completeness only: no figure panel
    plots them") -- and then a panel plotted them. Eric, 2026-08-18: "is the idf1
    score just so low because we didnt try it on the frames with missing detections?"
    and then "can we get a fair estimate for 3d also?"

    Evidence that the answer was yes, before this ran: across the 50 sessions,
    corr(coverage, exhaustive IDF1) = 0.86, and perfect association on covered
    frames with silence elsewhere caps IDF1 at ~0.64 at this coverage -- below
    greedy's 0.86 before a single mistake.

    WHAT THIS DOES. For each of the 50 BMimica sessions it re-scores BOTH arms over
    exactly the frame set exhaustive computed (`exhaustive.json`'s `frames[].frame`),
    via `score_session(frame_subset=...)`. No new tracking: the same stored
    `greedy.json` / `exhaustive.json` outputs the published deposit already scored,
    the same GT, the same scorer. Only the frame set moves, and it moves for BOTH
    arms.

    WHAT IT DOES NOT FIX. Exhaustive is a pure per-frame method; its identities exist
    only through `fig3_exhaustive.mjs`'s nearest-3D-centroid threading to the
    previous COMPUTED frame, which is our scaffolding and not Maree et al.'s method.
    Frame-matching removes the coverage confound; the threading confound stays, and
    it is the reason a frame-matched IDF1 near chance for two animals means "our
    threading cannot bridge the gaps", not "the published method cannot associate".
    The threading-free comparison remains `agreement_rate`: on these same frames the
    two methods pick the SAME partition on 4,324,311 of 4,324,469 (99.996%).

    THE GREEDY ARM HERE IS THE HEAD-TO-HEAD ARM, not the sweep's. `greedy.json` is
    `fig3_bench.mjs` at DEFAULT thresholds, which is what the head-to-head ran; the
    Fig 3d curve sweeps the fresh-anchor configuration over r. Both are the
    production greedy tracker, but they are not the same operating point, and the
    panel must not present this number as a point on that curve.
    ############################################################################

    FM_JOBS=24  concurrent workers (default min(24, nproc-4))
    FM_LIMIT=N  only the first N sessions (smoke test)
    FM_FORCE=1  ignore the per-session cache

    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig3_frame_matched.py

Output: figs/out/fig3_frame_matched_bmimica.json
Per-session cache: out/tmp/headtohead/A2_C5_bmimica/<session>/score_framematched_<arm>.json
"""
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

FIGS = Path(__file__).resolve().parent
BENCH = Path("/root/vast/eric/luc3d-bench")
CACHE = FIGS / "out" / "tmp" / "headtohead" / "A2_C5_bmimica"
BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
OUT = FIGS / "out" / "fig3_frame_matched_bmimica.json"
ARMS = ("exhaustive", "greedy")
N_CAMERAS = 5


def score_one(args):
    """One (session, arm) on the frames exhaustive computed. Cached per task."""
    sess, arm = args
    sdir = CACHE / sess
    cache = sdir / f"score_framematched_{arm}.json"
    if cache.exists() and not os.environ.get("FM_FORCE"):
        try:
            return sess, arm, json.loads(cache.read_text())
        except Exception:
            pass
    sys.path.insert(0, str(FIGS))
    import fig3_score as fs

    exh = json.loads((sdir / "exhaustive.json").read_text())
    computed = frozenset(f["frame"] for f in exh["frames"])
    t0 = time.time()
    s = fs.score_session(str(sdir / f"{arm}.json"), str(BM_DET / sess),
                         str(BM_GT / sess), exh["cameras"], exh["numAnimals"],
                         frame_subset=computed)
    rec = {"session": sess, "arm": arm,
           "frames_scored": len(computed),
           "frames_considered": exh["framesConsidered"],
           "camera_frames_scored": len(computed) * len(exh["cameras"]),
           "idf1_within": s["within_idf1"], "idf1_cross": s["cross_idf1"],
           "idr_within": s["within_idr"], "idp_within": s["within_idp"],
           "switches": s["within_switches"], "cross_switches": s["cross_switches"],
           "seconds": round(time.time() - t0, 1)}
    cache.write_text(json.dumps(rec, indent=2))
    return sess, arm, rec


def main():
    sessions = sorted(p.name for p in CACHE.iterdir()
                      if p.is_dir() and (p / "exhaustive.json").exists()
                      and (p / "greedy.json").exists())
    if lim := os.environ.get("FM_LIMIT"):
        sessions = sessions[:int(lim)]
    jobs = int(os.environ.get("FM_JOBS") or min(24, max(1, os.cpu_count() - 4)))
    tasks = [(s, a) for s in sessions for a in ARMS]
    print(f"[fm] {len(sessions)} sessions x {len(ARMS)} arms = {len(tasks)} tasks, "
          f"{jobs} workers")

    got = {}
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(score_one, t): t for t in tasks}
        for i, f in enumerate(as_completed(futs), 1):
            sess, arm, rec = f.result()
            got[(sess, arm)] = rec
            print(f"[fm] {i}/{len(tasks)} {sess} {arm:<11} "
                  f"cross {rec['idf1_cross']:.4f} within {rec['idf1_within']:.4f} "
                  f"sw {rec['switches']} ({rec['seconds']}s)", flush=True)

    missing = [t for t in tasks if t not in got]
    if missing:
        raise SystemExit(f"[fm] {len(missing)} tasks produced nothing: {missing}")

    out = {
        "generated_by": "figs/fig3_frame_matched.py",
        "claim": "Cross-view and within-view IDF1 and switch counts for exhaustive "
                 "enumeration AND the head-to-head greedy arm, scored over exactly "
                 "the frames exhaustive computed (every camera holding exactly 2 "
                 "clean detections), on the 50 BMimica sessions. No new tracking and "
                 "no new scorer: the stored per-session driver outputs, the same GT, "
                 "the same fig3_score.score_session, with frame_subset set to the "
                 "exhaustive arm's own computed frames for BOTH arms.",
        "basis": "frames exhaustive computed (clean frames), identical for both arms",
        "greedy_arm": "fig3_bench.mjs at default thresholds -- the head-to-head arm, "
                      "NOT the fresh-anchor operating point the Fig 3d curve sweeps",
        "caveat_threading": "Exhaustive is purely per-frame; its identities come from "
                            "fig3_exhaustive.mjs's nearest-3D-centroid threading to "
                            "the previous COMPUTED frame -- our scaffolding, not the "
                            "published method. Frame-matching removes the coverage "
                            "confound, not this one.",
        "n_sessions": len(sessions),
        "arms": {},
        "per_session": [],
        "seconds": round(time.time() - t0, 1),
    }
    for arm in ARMS:
        recs = [got[(s, arm)] for s in sessions]
        w = np.array([r["idf1_within"] for r in recs])
        c = np.array([r["idf1_cross"] for r in recs])
        sw = sum(r["switches"] for r in recs)
        csw = sum(r["cross_switches"] for r in recs)
        camf = sum(r["camera_frames_scored"] for r in recs)
        out["arms"][arm] = {
            "idf1_within_mean": float(w.mean()),
            "idf1_within_median": float(np.median(w)),
            "idf1_cross_mean": float(c.mean()),
            "idf1_cross_median": float(np.median(c)),
            "switches_total": int(sw), "cross_switches_total": int(csw),
            "camera_frames_scored": int(camf),
            "switches_per_100k_camera_frames": float(sw / camf * 1e5),
            "cross_switches_per_100k_camera_frames": float(csw / camf * 1e5),
        }
    for s in sessions:
        row = {"session": s,
               "frames_scored": got[(s, ARMS[0])]["frames_scored"],
               "frames_considered": got[(s, ARMS[0])]["frames_considered"]}
        row["coverage"] = row["frames_scored"] / row["frames_considered"]
        for arm in ARMS:
            r = got[(s, arm)]
            row[f"{arm}_idf1_cross"] = r["idf1_cross"]
            row[f"{arm}_idf1_within"] = r["idf1_within"]
            row[f"{arm}_switches"] = r["switches"]
        out["per_session"].append(row)

    # The frame set must be identical between the arms, session by session -- the
    # whole point of the deposit. Asserted rather than assumed.
    for s in sessions:
        a, b = got[(s, "exhaustive")], got[(s, "greedy")]
        if a["frames_scored"] != b["frames_scored"]:
            raise SystemExit(f"[fm] {s}: arms scored different frame counts "
                             f"({a['frames_scored']} vs {b['frames_scored']})")

    OUT.write_text(json.dumps(out, indent=2))
    print(f"\n[fm] wrote {OUT.relative_to(FIGS)}  ({out['seconds']}s)")
    for arm in ARMS:
        A = out["arms"][arm]
        print(f"  {arm:<11} cross IDF1 mean {A['idf1_cross_mean']:.4f}  "
              f"within {A['idf1_within_mean']:.4f}  "
              f"switches {A['switches_total']:,} "
              f"({A['switches_per_100k_camera_frames']:.2f} /100k)")


if __name__ == "__main__":
    main()
