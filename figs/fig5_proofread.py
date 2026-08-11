#!/usr/bin/env python3
"""
Deposit figs/out/fig5_proofread.json: manual identity-proofreading load on SLAP-2M,
SLEAP's C independent per-camera timelines vs LUC3D's one global cross-view identity.

Nothing is recomputed from raw video. The one input is the shipped-baseline
per-camera-session evaluation that fig3_trackers.py already pins (see its PROVENANCE
block for why this file and only this file):

  /root/vast/eric/luc3d-bench/outputs/PAF_3d_kalman/_eval_baseline.csv

"Break" = motmetrics num_switches + num_fragmentations against proofread GT, on the
shared identity-stripped detection pool. A proofreader repairing a tracker's output
must visit every identity break, so per session:

  breaks_sum      sum over the 6 cameras of (num_switches + num_fragmentations).
                  For a PER-CAMERA tracker (SLEAP) each camera is an independent
                  timeline, so this IS the repair count under the model that each
                  camera is proofread independently.
  breaks_max_cam  max over the 6 cameras of the same quantity. For a tracker whose
                  identity is GLOBAL (LUC3D) every global break event registers in
                  every camera where the animals are detected, so the number of
                  DISTINCT global break events is at least the worst single camera's
                  count and at most the sum: bounded in [breaks_max_cam, breaks_sum].
                  Both bounds are deposited; nothing in between is claimed.

Usage: python3 figs/fig5_proofread.py
"""
from __future__ import annotations

import csv
import json
import os
from collections import defaultdict

BENCH = "/root/vast/eric/luc3d-bench/outputs"
SLAP2M = f"{BENCH}/PAF_3d_kalman/_eval_baseline.csv"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "fig5_proofread.json")

TRACKERS = ("sleap", "luc3d")


def main():
    with open(SLAP2M) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit(f"missing input: {SLAP2M}")

    # (tracker, session) -> camera -> row. Also per-session frames/animals,
    # asserted (not assumed) consistent across cameras and trackers.
    per = defaultdict(dict)
    frames = {}
    animals = {}
    cameras = sorted({r["camera"] for r in rows})
    for r in rows:
        if r["tracker"] not in TRACKERS:
            continue
        k = (r["tracker"], r["session"])
        assert r["camera"] not in per[k], f"duplicate row {k} {r['camera']}"
        per[k][r["camera"]] = r
        nf = int(float(r["num_frames"]))
        assert frames.setdefault(r["session"], nf) == nf, \
            f"num_frames varies within session {r['session']}"
        na = int(r["animals"])
        assert animals.setdefault(r["session"], na) == na, \
            f"animals varies within session {r['session']}"

    sessions = sorted({s for _t, s in per})
    for t in TRACKERS:
        for s in sessions:
            assert sorted(per[(t, s)]) == cameras, f"camera set differs: {t} {s}"

    def tracker_block(t, s):
        # camera order is the top-level `cameras` list, identical for all sessions
        sw = [int(float(per[(t, s)][c]["num_switches"])) for c in cameras]
        fr = [int(float(per[(t, s)][c]["num_fragmentations"])) for c in cameras]
        breaks = [a + b for a, b in zip(sw, fr)]
        return dict(breaks_sum=sum(breaks), breaks_max_cam=max(breaks),
                    switches_sum=sum(sw), frags_sum=sum(fr),
                    switches_per_cam=sw, frags_per_cam=fr)

    sess_out = [dict(session=s, animals=animals[s], frames=frames[s],
                     **{t: tracker_block(t, s) for t in TRACKERS})
                for s in sessions]

    totals = {t: {k: sum(e[t][k] for e in sess_out)
                  for k in ("breaks_sum", "breaks_max_cam",
                            "switches_sum", "frags_sum")}
              for t in TRACKERS}

    payload = dict(
        generated_by="figs/fig5_proofread.py",
        dataset=(f"SLAP-2M shipped-baseline evaluation: {len(sessions)} sessions x "
                 f"{len(cameras)} cameras, shared identity-stripped detection pool "
                 "(same rows fig3_trackers.py aggregates; see its PROVENANCE block)"),
        source=SLAP2M,
        metric=("breaks = motmetrics num_switches + num_fragmentations vs proofread "
                "GT, per camera-session; summed and maxed over cameras per session"),
        cameras=cameras,
        n_sessions=len(sessions),
        n_camera_sessions=len(sessions) * len(cameras),
        total_video_frames=sum(frames.values()),
        total_camera_frames=sum(frames.values()) * len(cameras),
        sessions=sess_out,
        totals=totals,
        caveats=[
            "'Breaks' are motmetrics num_switches + num_fragmentations against "
            "proofread GT, computed on the shared identity-stripped detection pool "
            "(both trackers receive identical per-frame detections), from "
            "PAF_3d_kalman/_eval_baseline.csv -- the shipped-baseline run, see the "
            "PROVENANCE block in figs/fig3_trackers.py.",
            "For SLEAP the per-camera sum (breaks_sum) IS the repair count only "
            "under the model that each of the C cameras is proofread as an "
            "independent timeline -- and after all of those repairs the C views are "
            "STILL not linked to each other, because SLEAP produces no cross-view "
            "identity. The cross-view linking work is additional and is not counted "
            "here.",
            "For LUC3D the number of DISTINCT global break events is bounded "
            "between breaks_max_cam and breaks_sum: a global identity break "
            "registers in every camera where the animals are detected, so the "
            "per-camera counts overlap. Both bounds are deposited; nothing in "
            "between is claimed.",
            f"The only file read is {SLAP2M} (columns num_switches, "
            "num_fragmentations, num_frames, animals; trackers sleap and luc3d).",
        ],
        blocked=[])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=1)

    print(f"n = {len(sessions)} sessions, {len(sessions) * len(cameras)} "
          f"camera-sessions, {sum(frames.values()):,} video frames")
    for t in TRACKERS:
        v = totals[t]
        print(f"  {t:<6} breaks_sum {v['breaks_sum']:>7,}  "
              f"breaks_max_cam {v['breaks_max_cam']:>7,}  "
              f"(switches {v['switches_sum']:,} + frags {v['frags_sum']:,})")
    print(f"[json] {OUT}")


if __name__ == "__main__":
    main()
