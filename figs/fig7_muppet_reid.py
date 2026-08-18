#!/usr/bin/env python
"""Fig 7a fairness fix, 3D-MuPPET half -- score the re-ID variant, and gate it against
the faithful port's shipped numbers.

    ############################################################################
    WHY THIS EXISTS. 3D-MuPPET's plotted 0.0112 within / 0.0112 cross is NOT an
    identity score, and it is NOT the max-2-track defect the SLEAP and ByteTrack
    halves fixed (`fig7_sleap_max2_retrack.py`, `fig7_bytetrack_max2.py`). Those two
    baselines lose to LONG-HORIZON FRAGMENTATION -- a median 47 and 85 track ids per
    camera-session against LUC3D's 2 by construction -- so capping them at the animal
    count is the fair comparison.

    3D-MuPPET emits EXACTLY TWO global ids in all 50 sessions (measured here:
    `gids == [0, 1]`, 50/50). There is no fragmentation to cap. Capping it at the
    animal count is a NO-OP and cannot move its score by a single keypoint.

    What it loses is COVERAGE. `scripts/bartul/muppet_run.py` builds
    `global_by_track` (SORT track id -> global id) ONCE at an init frame and freezes
    it, while SORT runs at `max_age = 10`. The first time a camera's tracklet dies,
    its replacement id is in no map and that camera emits nothing for the rest of the
    session. Frames absent from the result JSON are scored as MISSES over the whole
    session, so the denominator is 180,000 frames and the numerator is a few thousand:
    coverage runs 0.17% to 7.22%, median 1.31%, and the emitted frames fill a median
    99.2% of their own [first, last] span -- the tracker DIES, it does not sample
    sparsely. About 98.7% of "0.011" is denominator.

    Upstream discloses the no-re-ID limitation, so the port is faithful and the
    number is not a port bug. It is still not a number a reader can interpret as
    tracking quality, which is what a within-vs-cross IDF1 panel invites.
    ############################################################################

WHAT THE STEELMAN IS. `scripts/bartul/muppet_run_reid.py` (written 2026-07, never run
until now) re-runs 3D-MuPPET's OWN `matching_algorithm` -- the same Huang-2020
cross-view triangulate-and-cluster step it already uses at the init frame -- whenever a
camera has a live SORT track with no global id, instead of only once. A fresh cluster is
folded into an EXISTING identity if any of its members already carries one; a brand-new
id is allocated only when no member has prior evidence AND fewer than `num_animals` ids
have been handed out. Conflicting evidence across cameras is left alone rather than
guessed. A 30-frame cooldown stops an unresolvable track from re-triggering every frame.

So the steelman adds NO information the method does not already use, and it cannot
invent identities: it is the same matching step, run more than once.

WHAT IT MEASURED, over all 50 sessions (2026-08-17, deposit `fig7_muppet_reid.json`):

    arm                       within    cross    coverage (median)
    port (shipped)            0.0112    0.0112     1.31%
    re-ID (ours)              0.3297    0.3296    38.55%      29.4x, better in 50/50
    port + SLEAP 2-track      0.0103    0.0103     1.29%      better in 0/50

THREE FINDINGS, and the third is the one that matters for how this may be drawn.

1. THE 0.011 IS NOT A TRACKING SCORE. Given a re-linking policy, the same method on the
   same detections scores 0.330 -- 29.4x, and higher in every one of the 50 sessions.
   Anything the manuscript says about 3D-MuPPET's IDF1 is a statement about coverage.

2. FEEDING IT SLEAP'S 2 TRACKS DOES NOTHING. Eric's suggestion was reasonable -- the
   4-slot pool carries spurious detections that could steal SORT's IoU matches -- but it
   is not the mechanism: 0.0103 against 0.0112, better in 0 of 50 sessions and worse in
   6, coverage 1.29% against 1.31%. Both arms even share the same 7.22% maximum, i.e.
   the same session dying in the same place. Once a camera's first tracklet dies the
   frozen map silences it for good, and no amount of cleaner input re-links an id that
   has no entry.

3. THE RE-ID ARM IS STILL COVERAGE-LIMITED, so 0.330 is NOT like-for-like against
   LUC3D's 0.861, which predicts on every frame. Coverage reaches >90% in only 10 of 50
   sessions and stays under 10% in 9. IDF1 tracks coverage almost exactly (Pearson
   r = 0.971 over sessions; the port's r = 0.834), and IDF1/coverage has a median of
   0.818 -- so WHERE 3D-MuPPET PREDICTS, ITS IDENTITY IS RIGHT ABOUT 0.8 OF THE TIME,
   and essentially all of its deficit is how much of the session it can predict on at
   all. Its within-view and cross-view scores agree to four decimals in every arm, which
   is the one thing the shipped panel got right for the right reason: its cross-view
   identity is genuine, and that now rests on 38% coverage rather than 1.3%.

So a fair panel treatment states coverage next to the number, whichever arm it draws.

THE GATE. This script scores the faithful port through the SAME code path first and
refuses to report the variant unless the port reproduces the shipped deposit
(`fig3_trackers.json` / `bmimica_crossview_all_eval.csv`: 0.0112 / 0.0112) to
GATE_TOL. Without that, a coverage lift could be an artefact of a differently-built
accumulator rather than of the re-ID. The construction is copied from
`scripts/bartul/bmimica_eval_crossview_all.py`'s `muppet` branch: same GT boxes, same
shared detection pool, same IoU >= 0.5 matching, same per-camera-then-mean for within
view, same single pooled accumulator with GLOBAL ids for cross view (3D-MuPPET has real
cross-view identity, so unlike SLEAP and ByteTrack its ids are NOT camera-scoped).

Run it with LIEZL_ENV, not lp3d_env: motmetrics is installed in liezl_env and
precisiontrack_env only, and `scripts/evaluate.py` imports it at module scope.

    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig7_muppet_reid.py --gate
    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig7_muppet_reid.py \
        --arms port,sleap2 --sessions 4

Writes figs/out/fig7_muppet_reid.json (+ .csv): per session, per arm, within/cross IDF1,
switch counts and coverage.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np

BENCH = "/root/vast/eric/luc3d-bench"
sys.path.insert(0, f"{BENCH}/scripts")
sys.path.insert(0, f"{BENCH}/scripts/bartul")

import evaluate as ev            # noqa: E402  bbox_from_kpts, luc3d_assignments_for_cam
import motmetrics as mm          # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
BM = f"{BENCH}/outputs/bmimica"
GT, DET = f"{BM}/gt", f"{BM}/det_h5"
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]

#: The arms. Each carries its OWN detection source, and that is not bookkeeping: a
#: result JSON's assignment keys are `"<serial>:<slot>"`, where `slot` indexes the
#: array the tracker was RUN on. Scoring the SLEAP-2-track arm against the 4-slot
#: shared pool would read slot 1 of a 2-slot array as slot 1 of a 4-slot one -- a
#: different box, silently, on every frame. `det` therefore travels with `results`.
#:
#: THE CONSEQUENCE FOR COMPARABILITY, stated because it cuts both ways. `port` and
#: `reid` see the shared detection pool, so they are apples-to-apples with LUC3D and
#: ByteTrack. `sleap2` sees SLEAP's own 2-track output, which has SLEAP's misses baked
#: into it: its recall ceiling is not the pool's, so its IDF1 is not on the same axis
#: as the other three series and must not be plotted as though it were.
ARMS = {
    "port":   {"results": f"{BM}/results/muppet",        "det": DET,
               "what": "upstream's frozen init-frame mapping, shared pool "
                       "(the shipped series)"},
    "reid":   {"results": f"{BM}/results/muppet_reid",   "det": DET,
               "what": "re-runs MuPPET's own matching whenever a camera has an "
                       "unlinked live SORT track, shared pool"},
    "sleap2": {"results": f"{BM}/results/muppet_sleap2", "det": f"{BM}/sleap_h5",
               "what": "upstream's frozen mapping, fed SLEAP's own 2-track output "
                       "instead of the 4-slot pool (Eric's fairness suggestion)"},
}
#: the shipped numbers the port arm must reproduce, from
#: figs/out/fig3_trackers.json's 3D-MuPPET series
SHIPPED = {"within": 0.011197556676934053, "cross": 0.011198219537192584}
GATE_TOL = 5e-4


def coverage(res_json, n_frames):
    """(covered frames, share of the session, share of its own first-last span)."""
    fr = [f["frame"] for f in res_json["frames"]]
    if not fr:
        return 0, 0.0, 0.0
    span = fr[-1] - fr[0] + 1
    return len(fr), len(fr) / n_frames, len(fr) / span


def score_session(sid):
    """within/cross IDF1 per arm for one session, built exactly as
    bmimica_eval_crossview_all.py builds the `muppet` branch."""
    gt = {}
    for c in SER:
        gp = f"{GT}/{sid}/{c}/proofread.analysis.h5"
        if not os.path.exists(gp):
            return None
        gt[c] = np.transpose(h5py.File(gp)["tracks"][:], (3, 0, 2, 1))
    row = {"session": sid, "n_frames": int(min(g.shape[0] for g in gt.values()))}

    for arm, spec in ARMS.items():
        p = f"{spec['results']}/{sid}.json"
        dets = {c: f"{spec['det']}/{sid}/{c}_predictions.h5" for c in SER}
        if not os.path.exists(p) or any(not os.path.exists(v) for v in dets.values()):
            continue
        det = {c: h5py.File(v)["tracks"][0] for c, v in dets.items()}
        js = json.load(open(p))
        n_cov, cov_sess, cov_span = coverage(js, row["n_frames"])
        percam, pooled, sw2d = [], mm.MOTAccumulator(auto_id=False), 0
        gids = set()
        for ci, c in enumerate(SER):
            g, dd = gt[c], det[c]
            nf = min(g.shape[0], dd.shape[0])
            ids = ev.luc3d_assignments_for_cam(js, c, nf, dd.shape[1])
            pc = mm.MOTAccumulator(auto_id=False)
            for fi in range(nf):
                gb, gi = [], []
                for t in range(g.shape[1]):
                    b = ev.bbox_from_kpts(g[fi, t])
                    if b is not None:
                        gb.append(b); gi.append(t)
                prb, pl = [], []
                for a in range(dd.shape[1]):
                    b = ev.bbox_from_kpts(dd[fi, a])
                    if b is None:
                        continue
                    gid = int(ids[fi, a])
                    if gid < 0:
                        continue
                    prb.append(b); pl.append(gid); gids.add(gid)
                gn = np.array(gb) if gb else np.empty((0, 4))
                pn = np.array(prb) if prb else np.empty((0, 4))
                dist = mm.distances.iou_matrix(gn, pn, max_iou=0.5)
                pc.update(gi, pl, dist, frameid=fi)
                # GLOBAL ids, not camera-scoped: 3D-MuPPET has cross-view identity
                pooled.update(gi, pl, dist, frameid=ci * 10 ** 7 + fi)
            s = mm.metrics.create().compute(pc, metrics=["idf1", "num_switches"], name="c")
            percam.append(float(s["idf1"]["c"])); sw2d += int(s["num_switches"]["c"])
        sp = mm.metrics.create().compute(pooled, metrics=["idf1", "num_switches"], name="p")
        row.update({
            f"{arm}_within": float(np.mean(percam)), f"{arm}_sw2d": sw2d,
            f"{arm}_cross": float(sp["idf1"]["p"]), f"{arm}_xsw": int(sp["num_switches"]["p"]),
            f"{arm}_frames": n_cov, f"{arm}_coverage": cov_sess,
            f"{arm}_span_fill": cov_span, f"{arm}_n_gids": len(gids),
        })
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sessions", type=int, default=None,
                    help="score only the first N sessions (a smoke run)")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--arms", default=None,
                    help="comma-separated subset of arms to score (default all "
                         "present); the deposit records which ones ran")
    ap.add_argument("--gate", action="store_true",
                    help="require the port arm to reproduce the shipped numbers")
    ap.add_argument("--out", default=str(OUT / "fig7_muppet_reid.json"))
    a = ap.parse_args()
    if a.arms:
        keep = [x.strip() for x in a.arms.split(",")]
        bad = [k for k in keep if k not in ARMS]
        if bad:
            raise SystemExit(f"unknown arm(s) {bad}; have {sorted(ARMS)}")
        for k in list(ARMS):
            if k not in keep:
                del ARMS[k]

    sids = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(f"{GT}/*/"))
    sids = [s for s in sids if os.path.exists(f"{GT}/{s}/{SER[0]}/proofread.analysis.h5")]
    have = {arm: {os.path.basename(p)[:-5]
                  for p in glob.glob(f"{spec['results']}/*.json")}
            for arm, spec in ARMS.items()}
    print(f"{len(sids)} scorable sessions; "
          + ", ".join(f"{arm}: {len(v)} results" for arm, v in have.items()))
    # score the sessions every arm present on disk can be compared on
    common = set.intersection(*[v for v in have.values() if v]) if any(have.values()) else set()
    sids = [s for s in sids if s in common] or sids
    if a.sessions:
        sids = sids[:a.sessions]
    print(f"scoring {len(sids)} with {a.workers} workers", flush=True)

    rows = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for f in as_completed([ex.submit(score_session, s) for s in sids]):
            r = f.result()
            if not r:
                continue
            rows.append(r)
            msg = f"  {r['session']}"
            for arm in ARMS:
                if f"{arm}_within" in r:
                    msg += (f"   {arm}: within {r[f'{arm}_within']:.4f} "
                            f"cross {r[f'{arm}_cross']:.4f} "
                            f"cov {100 * r[f'{arm}_coverage']:.2f}%")
            print(msg, flush=True)
    rows.sort(key=lambda r: r["session"])

    summary = {}
    for arm in ARMS:
        vals = {m: np.array([r[f"{arm}_{m}"] for r in rows if f"{arm}_{m}" in r], float)
                for m in ("within", "cross", "coverage", "span_fill")}
        if not len(vals["within"]):
            continue
        summary[arm] = {
            "n_sessions": int(len(vals["within"])),
            **{f"{m}_mean": float(v.mean()) for m, v in vals.items()},
            **{f"{m}_median": float(np.median(v)) for m, v in vals.items()},
            "coverage_min": float(vals["coverage"].min()),
            "coverage_max": float(vals["coverage"].max()),
            "n_gids_max": int(max(r[f"{arm}_n_gids"] for r in rows if f"{arm}_n_gids" in r)),
            "sw2d_total": int(sum(r[f"{arm}_sw2d"] for r in rows if f"{arm}_sw2d" in r)),
            "xsw_total": int(sum(r[f"{arm}_xsw"] for r in rows if f"{arm}_xsw" in r)),
        }
    for arm, s in summary.items():
        print(f"\n=== {arm} over {s['n_sessions']} sessions ===")
        print(f"  within  mean {s['within_mean']:.4f}  median {s['within_median']:.4f}")
        print(f"  cross   mean {s['cross_mean']:.4f}  median {s['cross_median']:.4f}")
        print(f"  coverage mean {100 * s['coverage_mean']:.2f}%  "
              f"median {100 * s['coverage_median']:.2f}%  "
              f"[{100 * s['coverage_min']:.2f}, {100 * s['coverage_max']:.2f}]")
        print(f"  distinct global ids (max over sessions) {s['n_gids_max']}")

    gate = None
    if "port" in summary:
        d_w = abs(summary["port"]["within_mean"] - SHIPPED["within"])
        d_c = abs(summary["port"]["cross_mean"] - SHIPPED["cross"])
        gate = {"shipped": SHIPPED, "port_within_diff": d_w, "port_cross_diff": d_c,
                "tol": GATE_TOL, "passed": bool(d_w < GATE_TOL and d_c < GATE_TOL),
                "n_sessions": summary["port"]["n_sessions"]}
        print(f"\nGATE vs shipped: |dwithin| {d_w:.2e}  |dcross| {d_c:.2e}  "
              f"-> {'PASS' if gate['passed'] else 'FAIL'}"
              + ("" if gate["n_sessions"] == 50 else
                 f"  (only {gate['n_sessions']} sessions -- means are not comparable "
                 "to the 50-session shipped value)"))
        if a.gate and not gate["passed"] and gate["n_sessions"] == 50:
            raise SystemExit("gate FAILED: the port arm does not reproduce the shipped "
                             "numbers on this code path, so the re-ID arm is not "
                             "comparable to them. Not depositing.")

    dep = {
        "generated_by": "figs/fig7_muppet_reid.py",
        "what": "3D-MuPPET faithful port vs the re-ID steelman, same scoring path",
        "metric": "IDF1 (motmetrics); within = per camera then mean over cameras; "
                  "cross = one pooled accumulator with GLOBAL ids (3D-MuPPET has "
                  "cross-view identity, so its ids are not camera-scoped)",
        "arms": {a: spec["what"] for a, spec in ARMS.items()},
        "sleap2_is_not_on_the_same_axis": "the sleap2 arm's detections are SLEAP's own "
            "2-track output, so SLEAP's misses are in its recall ceiling; its IDF1 is "
            "not comparable to the pool-fed series and must not be plotted with them",
        "max_tracks_cap_is_a_noop": "3D-MuPPET emits exactly 2 global ids in every "
                                    "session, so the SLEAP/ByteTrack max-2 fix has "
                                    "nothing to cap here; the loss is coverage",
        "gate": gate, "summary": summary, "per_session": rows,
        "arms_detail": ARMS,
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(dep))
    print(f"\n[json] {a.out}")
    csv = Path(a.out).with_suffix(".csv")
    cols = ["session", "n_frames"] + [f"{arm}_{m}" for arm in ARMS for m in
            ("within", "cross", "coverage", "span_fill", "sw2d", "xsw", "frames", "n_gids")]
    with open(csv, "w") as fh:
        fh.write(",".join(cols) + "\n")
        for r in rows:
            fh.write(",".join(str(r.get(c, "")) for c in cols) + "\n")
    print(f"[csv]  {csv}")


if __name__ == "__main__":
    main()
