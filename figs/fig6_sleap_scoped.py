#!/usr/bin/env python
"""Fig 7 correction, part 2 — the SLEAP baseline's cross-view number under BOTH pooling
conventions, plus the track statistic whose absence let the original defect survive.

WHY THIS EXISTS. `figs/fig6_sleap_retracked.py` fixed the real defect in Fig 7a's SLEAP
series: `scripts/bartul/bmimica_build_sleap_ref.py` builds `outputs/bmimica/sleap_h5/` from
the retracked `.slp` files but TRUNCATES to SLEAP's first two tracks (`N_ANIMALS = 2`;
`if ti is not None and ti < N_ANIMALS`), and the retracked files hold a median of 47 tracks
per camera-session. It scores the 250 `.slp` files directly instead, every track, so the
fixed-width array never exists. Its within-view result stands as measured: session-mean
IDF1 0.1154 -> 0.2062.

Its CROSS-VIEW result does not, and this script is why. That script pools the five cameras
with the track NAME as the hypothesis id, UNSCOPED: `track_3` in camera A and `track_3` in
camera B count as one identity. Every other number on Fig 7a comes from
`scripts/bartul/bmimica_eval_crossview_all.py`, which CAMERA-SCOPES its per-camera baselines
(`ci * 10 + slot` for SLEAP, `ci * 100000 + tid` for ByteTrack) and uses global ids only for
LUC3D and 3D-MuPPET, which actually have cross-view identity. The two are not comparable,
and the asymmetry has a direction: unscoped pooling can only ADD cross-view matches that a
scoped pooling would refuse, never remove one, so the unscoped 0.0836 is an UPPER BOUND on
the camera-scoped quantity Fig 7a's 0.0616 belongs to. Publishing a "1.4x cross-view
correction" of which part is a convention change would be a correction that flatters us --
a worse defect than the one being fixed.

So this scores BOTH conventions in ONE pass and deposits both. Whichever is plotted, the
other is on disk beside it and the artwork names the convention.

    unscoped   hypothesis id = track name                (fig6_sleap_retracked.py's)
    scoped     hypothesis id = (camera, track name)      (the deposit's, for baselines)

THE GATE, and it is the reason both conventions are measured together rather than the new
one alone. `within_idf1` and the unscoped `cross_idf1` MUST reproduce
`figs/out/fig7_sleap_retracked.json` per session to 1e-12. That is what proves this pass
differs from that one in the pooling id and in nothing else -- the frame extraction here is
a re-implementation (it also reports each instance's track INDEX, which that script does not
expose), and an unnoticed divergence in it would make the scoped number incomparable to the
within-view number it sits beside. If the reproduction fails this script REFUSES to deposit.
Do not widen the tolerance: a real difference means the extraction diverged and the scoped
number is measuring something else.

THE TRACK STATISTIC, deposited because its absence is the whole story. Nothing on disk
recorded how many tracks the retracked files hold, so a reference truncated to two of a
median 47 looked like a reference. This deposits, per camera-session: the number of distinct
tracks, the number of scored instances, and the fraction of them that survive the builder's
`ti < 2` cut. A future series claiming to be "SLEAP per camera" can be checked against it in
one line.

    $PY figs/fig6_sleap_scoped.py --sessions 20250829_124351   # one session
    $PY figs/fig6_sleap_scoped.py                              # all 50

Run with the bench interpreter (motmetrics + sleap_io):
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig7_sleap_scoped.json
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
# Reused rather than re-derived: the session list, the camera list and the GT root all come
# from the same modules the first pass used, so the two passes cannot silently disagree
# about WHICH sessions or cameras are being scored.
import fig3_sweep as f3  # noqa: E402
import fig3_score as _fs  # noqa: E402,F401  (puts $BENCH/scripts on sys.path)
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402

RETRACKED = Path("/root/vast/eric/luc3d-bench/outputs/bmimica/retracked")
#: `--retracked` repoints this at another tracking run of the SAME 250 camera-sessions --
#: the `--max_tracks 2` re-run (`figs/fig6_sleap_max2_retrack.py`) writes
#: `retracked_max2/`. It is a module global rather than a threaded parameter because
#: `score_session` runs in a process pool and the workers inherit it at fork; `main()`
#: sets it BEFORE the pool is created. Anything that repoints it must also change
#: `--out`, or a re-run would overwrite the shipped baseline's deposit.
SCORED_DIR = RETRACKED
#: The builder's cut, reproduced here as the statistic it should always have reported.
#: `scripts/bartul/bmimica_build_sleap_ref.py`: N_ANIMALS = 2.
BUILDER_N_ANIMALS = 2
#: The first pass, whose within-view and unscoped cross-view numbers this must reproduce.
REF = "fig7_sleap_retracked.json"
#: Reproduction tolerance. NOT a knob -- see the docstring. Both quantities are computed
#: from the same frames by the same motmetrics calls, so the only expected difference is
#: float summation order, which is nowhere near this.
GATE_TOL = 1e-12


def frames_and_track_stats(path, n_frames):
    """`[(frame_idx, [(track_name, track_index, bbox), ...]), ...]` plus track statistics.

    The frame extraction is deliberately IDENTICAL to `fig7_sleap_retracked.slp_frames`:
    same iteration over `labeled_frames`, same `fi >= n_frames` skip, same "no track means
    no identity" skip, same `ev.bbox_from_kpts`, same "drop frames with no usable instance".
    It differs only in also carrying each instance's index in `labels.tracks`, which is what
    the builder's `ti < N_ANIMALS` cut is applied to and which the first pass does not
    expose. The gate on the reproduced numbers is what checks that "identical" is true.
    """
    import sleap_io as sio
    lab = sio.load_slp(str(path))
    track_index = {t: i for i, t in enumerate(lab.tracks)}
    out = []
    n_inst = n_first2 = 0
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
            if box is None:
                continue
            ti = track_index[inst.track]
            items.append((inst.track.name, ti, box))
            n_inst += 1
            if ti < BUILDER_N_ANIMALS:
                n_first2 += 1
        if items:
            out.append((fi, items))
    return out, {"n_tracks": len(lab.tracks), "n_scored_instances": n_inst,
                 "n_in_first_2_tracks": n_first2,
                 "frac_surviving_builder_cut": (n_first2 / n_inst) if n_inst else None}


class Ids:
    """Deterministic name -> small-int mapping, replacing the first pass's `hash(name)`.

    Python's string `hash` is per-process randomised, so the ids it produces are not
    reproducible across runs. It does not change any metric -- motmetrics only needs
    hashables and the mapping is 1:1 either way -- but a deposit that cannot be reproduced
    bit-for-bit is a deposit that cannot be checked, and this pass exists to be checked.
    The gate confirms the substitution is metric-neutral.
    """

    def __init__(self):
        self._m = {}

    def __call__(self, key):
        return self._m.setdefault(key, len(self._m))


def score_session(session, cameras):
    gt_dir = f3.GT / session
    # TWO pooled accumulators over the SAME detections and the SAME distances. The only
    # difference is the hypothesis id: scoped keys on (camera, name), unscoped on name.
    pooled_scoped, pooled_unscoped = (mm.MOTAccumulator(auto_id=False),
                                      mm.MOTAccumulator(auto_id=False))
    id_scoped, id_unscoped = Ids(), Ids()
    percam, within_sw, within_frag, p95s, njumps, tstats = [], 0, 0, [], 0, []
    for ci, cam in enumerate(cameras):
        gt, occ = ev.load_gt(gt_dir / cam / "proofread.analysis.h5")
        nf = int(gt.shape[0])
        frames, st = frames_and_track_stats(SCORED_DIR / session / f"{cam}.slp", nf)
        st["camera"] = cam
        tstats.append(st)
        # Coherence, on the same definition the first pass used: p95 of the per-track
        # frame-to-frame centroid jump. Kept so this deposit stands alone.
        by_track = {}
        for fi, items in frames:
            for name, _ti, box in items:
                by_track.setdefault(name, []).append(
                    (fi, (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0))
        jumps = []
        for pts in by_track.values():
            pts.sort()
            for (f0, x0, y0), (f1, x1, y1) in zip(pts, pts[1:]):
                if f1 - f0 == 1:
                    jumps.append(float(np.hypot(x1 - x0, y1 - y0)))
        p95s.append(float(np.percentile(jumps, 95)) if jumps else float("nan"))
        njumps += len(jumps)

        byf = dict(frames)
        pc = mm.MOTAccumulator(auto_id=False)
        id_within = Ids()          # per-camera ids: the within-view metric is per camera
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
            prb = [b for _n, _ti, b in items]
            gtn = np.array(gtb) if gtb else np.empty((0, 4))
            prn = np.array(prb) if prb else np.empty((0, 4))
            dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)
            pc.update(gti, [id_within(n) for n, _ti, _b in items], dist, frameid=fi)
            # SCOPED: `track_0` in camera A and `track_0` in camera B are different
            # hypotheses, which is what `ci * 10 + slot` does in the deposit's own scorer.
            pooled_scoped.update(gti, [id_scoped((ci, n)) for n, _ti, _b in items], dist,
                                 frameid=ci * 10_000_000 + fi)
            # UNSCOPED: the first pass's convention, reproduced so the gate can check it.
            pooled_unscoped.update(gti, [id_unscoped(n) for n, _ti, _b in items], dist,
                                   frameid=ci * 10_000_000 + fi)
        s = mm.metrics.create().compute(pc, metrics=["idf1", "idp", "idr", "num_switches",
                                                    "num_fragmentations"], name="c")
        percam.append((float(s["idf1"]["c"]), float(s["idp"]["c"]), float(s["idr"]["c"]),
                       int(s["num_switches"]["c"]), int(s["num_fragmentations"]["c"])))
        within_sw += int(s["num_switches"]["c"])
        within_frag += int(s["num_fragmentations"]["c"])
    mets = ["idf1", "idp", "idr", "num_switches"]
    ss = mm.metrics.create().compute(pooled_scoped, metrics=mets, name="p")
    su = mm.metrics.create().compute(pooled_unscoped, metrics=mets, name="p")
    return {
        "session": session,
        "within_idf1": float(np.mean([v[0] for v in percam])),
        "within_idp": float(np.mean([v[1] for v in percam])),
        "within_idr": float(np.mean([v[2] for v in percam])),
        "within_switches": within_sw,
        "within_fragmentations": within_frag,
        "cross_idf1_scoped": float(ss["idf1"]["p"]),
        "cross_idp_scoped": float(ss["idp"]["p"]),
        "cross_idr_scoped": float(ss["idr"]["p"]),
        "cross_switches_scoped": int(ss["num_switches"]["p"]),
        "cross_idf1_unscoped": float(su["idf1"]["p"]),
        "cross_switches_unscoped": int(su["num_switches"]["p"]),
        "track_jump_p95_px": float(np.nanmean(p95s)),
        "n_jump_samples": njumps,
        "per_camera_idf1": [v[0] for v in percam],
        "per_camera_tracks": tstats,
    }


def _job(session, cameras):
    try:
        return session, score_session(session, cameras), None
    except Exception as e:  # noqa: BLE001
        return session, None, repr(e)


def cap_gate(rows, cap):
    """THE GATE FOR A CAPPED RE-RUN, and it replaces the reproduction gate rather than
    removing it.

    A `--max_tracks 2` run that silently failed to cap anything looks exactly like one
    that worked -- same files, same shape, a plausible IDF1 -- and the whole point of the
    re-run is the cap. So when scoring a non-default directory this asserts the property
    the run was made for: every camera-session holds at most `cap` tracks. It cannot use
    `gate()` because that compares against `fig7_sleap_retracked.json`, which is the
    UNCAPPED run: reproducing it would mean the cap did nothing.
    """
    over = [(t["camera"], r["session"], t["n_tracks"])
            for r in rows for t in r["per_camera_tracks"] if t["n_tracks"] > cap]
    n = sum(len(r["per_camera_tracks"]) for r in rows)
    print(f"[scoped] CAP GATE: {n - len(over)}/{n} camera-sessions at <= {cap} tracks")
    if over:
        raise SystemExit(
            f"[scoped] CAP GATE FAILED. {len(over)} of {n} camera-sessions hold more than "
            f"{cap} tracks, e.g. {over[:3]} -- the cap did not take, so this is not a "
            f"{cap}-track baseline and its IDF1 must not be reported as one. Check that "
            f"the run passed --max_tracks AND --candidates_method local_queues "
            f"(fixed_window silently ignores max_tracks).")
    return {"cap": cap, "n_camera_sessions": n, "all_within_cap": True,
            "reference_gate": "SKIPPED -- see cap_gate(); this run is not expected to "
                              "reproduce the uncapped fig7_sleap_retracked.json"}


def gate(rows):
    """Reproduce-or-refuse. See the docstring: this is what makes the scoped number
    comparable to the within-view number it will be plotted beside."""
    p = OUT / REF
    if not p.exists():
        raise SystemExit(f"[scoped] {p} missing -- the gate cannot run, and the scoped "
                         f"number is not publishable without it")
    ref = {q["session"]: q for q in json.loads(p.read_text())["per_session"]}
    miss = [r["session"] for r in rows if r["session"] not in ref]
    if miss:
        raise SystemExit(f"[scoped] {len(miss)} sessions are not in {REF}: {miss[:3]}")
    dw = max(abs(r["within_idf1"] - ref[r["session"]]["within_idf1"]) for r in rows)
    dc = max(abs(r["cross_idf1_unscoped"] - ref[r["session"]]["cross_idf1"]) for r in rows)
    dsw = max(abs(r["within_switches"] - ref[r["session"]]["within_switches"]) for r in rows)
    print(f"[scoped] GATE vs {REF} over {len(rows)} sessions:")
    print(f"         within-view IDF1        max |diff| {dw:.3e}")
    print(f"         cross-view IDF1 (unsc.) max |diff| {dc:.3e}")
    print(f"         within-view switches    max |diff| {dsw}")
    if dw > GATE_TOL or dc > GATE_TOL or dsw != 0:
        worst = max(rows, key=lambda r: abs(r["cross_idf1_unscoped"]
                                            - ref[r["session"]]["cross_idf1"]))
        raise SystemExit(
            f"[scoped] GATE FAILED. This pass does not reproduce {REF}, so its frame "
            f"extraction differs from the pass whose within-view number is being kept and "
            f"the scoped cross-view number is measuring something else. Worst session "
            f"{worst['session']}: unscoped {worst['cross_idf1_unscoped']!r} vs "
            f"{ref[worst['session']]['cross_idf1']!r}. Do NOT widen GATE_TOL -- find the "
            f"divergence.")
    print("[scoped] gate PASSED -- identical except for the pooling id")
    return {"reference": REF, "n_sessions": len(rows),
            "max_abs_diff_within_idf1": dw, "max_abs_diff_cross_idf1_unscoped": dc,
            "max_abs_diff_within_switches": dsw, "tolerance": GATE_TOL, "passed": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", default=None)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retracked", default=str(RETRACKED),
                    help="tracking run to score; a non-default dir REQUIRES --out and is "
                         "gated on the track cap instead of on reproducing the uncapped run")
    ap.add_argument("--out", default="fig7_sleap_scoped.json",
                    help="deposit name under figs/out/")
    ap.add_argument("--cap", type=int, default=2,
                    help="expected max tracks per camera-session for a non-default dir")
    a = ap.parse_args()
    global SCORED_DIR
    SCORED_DIR = Path(a.retracked)
    if not SCORED_DIR.is_dir():
        sys.exit(f"[scoped] {SCORED_DIR} is not a directory")
    default_run = SCORED_DIR.resolve() == RETRACKED.resolve()
    # REFUSE to write the shipped baseline's deposit from another tracking run. The two
    # numbers differ by design here, so an overwrite would silently replace a manuscript
    # figure's provenance with an experiment's.
    if not default_run and a.out == "fig7_sleap_scoped.json":
        sys.exit(f"[scoped] scoring {SCORED_DIR.name} but --out is the shipped baseline's "
                 f"deposit (fig7_sleap_scoped.json). Pass --out fig7_sleap_max2.json (or "
                 f"another name) -- this pass must not overwrite the uncapped run's file.")
    sessions = (a.sessions.split(",") if a.sessions else
                sorted(p.name for p in SCORED_DIR.iterdir()
                       if p.is_dir() and (f3.GT / p.name).is_dir()))
    print(f"[scoped] {len(sessions)} sessions x {len(f3.CAMERAS)} cameras from "
          f"{SCORED_DIR}" + ("" if default_run else "  (CAPPED RE-RUN)"), flush=True)
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
                print(f"[scoped] FAILED {s}: {err}", flush=True)
            else:
                rows.append(r)
                tr = [t["n_tracks"] for t in r["per_camera_tracks"]]
                print(f"[scoped] {s}: within {r['within_idf1']:.4f} cross_scoped "
                      f"{r['cross_idf1_scoped']:.4f} cross_unscoped "
                      f"{r['cross_idf1_unscoped']:.4f} tracks {min(tr)}-{max(tr)} "
                      f"survive_cut "
                      f"{np.mean([t['frac_surviving_builder_cut'] or 0 for t in r['per_camera_tracks']]):.3f}"
                      f"  ({done}/{len(sessions)})", flush=True)

    if not rows:
        sys.exit("[scoped] nothing scored")
    rows.sort(key=lambda r: r["session"])
    g = gate(rows) if default_run else cap_gate(rows, a.cap)

    wi = [r["within_idf1"] for r in rows]
    cs = [r["cross_idf1_scoped"] for r in rows]
    cu = [r["cross_idf1_unscoped"] for r in rows]
    tracks = [t["n_tracks"] for r in rows for t in r["per_camera_tracks"]]
    surv = [t["frac_surviving_builder_cut"] for r in rows for t in r["per_camera_tracks"]
            if t["frac_surviving_builder_cut"] is not None]
    old_within, old_cross = 0.1154, 0.0616      # what Fig 7a reports
    print()
    print(f"[scoped] CORRECTED SLEAP baseline, {len(rows)} BMimica sessions:")
    print(f"         within-view IDF1        {np.mean(wi):.4f} "
          f"(median {np.median(wi):.4f})  vs Fig 7a's {old_within:.4f}  "
          f"-> {np.mean(wi) / old_within:.2f}x")
    print(f"         cross-view, CAMERA-SCOPED (the deposit's convention) "
          f"{np.mean(cs):.4f} (median {np.median(cs):.4f})  vs Fig 7a's {old_cross:.4f}  "
          f"-> {np.mean(cs) / old_cross:.2f}x")
    print(f"         cross-view, unscoped (upper bound)               "
          f"{np.mean(cu):.4f} (median {np.median(cu):.4f})")
    print(f"[scoped] tracks per camera-session: median {int(np.median(tracks))}, "
          f"range {min(tracks)}-{max(tracks)}; instances surviving the builder's "
          f"`ti < {BUILDER_N_ANIMALS}` cut: median {np.median(surv):.3f}, "
          f"mean {np.mean(surv):.3f}")

    (OUT / a.out).write_text(json.dumps({
        "generated_by": "figs/fig6_sleap_scoped.py",
        # The DIRECTORY is interpolated, not typed: this script now scores either the
        # shipped uncapped run or a `--max_tracks` re-run, and a deposit that names the
        # wrong one is the same class of defect as the truncation it exists to correct.
        "claim": "The per-camera SLEAP baseline for BMimica scored from the TRACKED .slp "
                 f"files in {SCORED_DIR}, every track, under BOTH "
                 "cross-view pooling conventions; plus the per-camera-session track counts "
                 "and the fraction of instances that survive the reference builder's "
                 "two-track cut.",
        "tracking_run": str(SCORED_DIR),
        "is_shipped_uncapped_run": default_run,
        "why": "Fig 7a's SLEAP series is scored from outputs/bmimica/sleap_h5/, which "
               "scripts/bartul/bmimica_build_sleap_ref.py builds from these same .slp files "
               "but truncates to SLEAP's first two tracks (N_ANIMALS = 2; `if ti is not "
               "None and ti < N_ANIMALS`). The files hold a median "
               f"{int(np.median(tracks))} tracks per camera-session, and a median "
               f"{np.median(surv):.1%} of scored instances survive that cut, so the "
               "plotted series was a top-two-track fragment of SLEAP scored as all of it.",
        "conventions": {
            "within": "per-camera MOT IDF1 with the camera's own optimal id remap, "
                      "averaged over the 5 cameras. Convention-free: no pooling.",
            "cross_scoped": "all 5 cameras pooled into ONE accumulator with the hypothesis "
                            "id keyed on (camera, track name). This is the convention "
                            "scripts/bartul/bmimica_eval_crossview_all.py uses for every "
                            "per-camera baseline in fig3_trackers.json (`ci * 10 + slot` "
                            "for SLEAP, `ci * 100000 + tid` for ByteTrack), and it is the "
                            "one comparable to that deposit's numbers.",
            "cross_unscoped": "the same pooling with the hypothesis id keyed on the track "
                              "NAME alone, so the same name in two cameras is one "
                              "identity. This is what figs/fig6_sleap_retracked.py "
                              "measured. It can only ADD cross-view matches a scoped "
                              "pooling would refuse, so it is an UPPER BOUND on "
                              "cross_scoped and is NOT comparable to fig3_trackers.json.",
            "matching": "IoU >= 0.5, as fig3_score.py and the bench scorer both use."},
        "fig7a_currently_reports": {"within": old_within, "cross": old_cross,
                                    "cross_convention": "camera-scoped, on the truncated "
                                                        "two-track reference"},
        "corrected": {
            "within_mean": float(np.mean(wi)), "within_median": float(np.median(wi)),
            "cross_scoped_mean": float(np.mean(cs)),
            "cross_scoped_median": float(np.median(cs)),
            "cross_unscoped_mean": float(np.mean(cu)),
            "cross_unscoped_median": float(np.median(cu)),
            "switches_2d_total": int(sum(r["within_switches"] for r in rows)),
            "fragmentations_2d_total": int(sum(r["within_fragmentations"] for r in rows)),
            "n_sessions": len(rows)},
        "truncation_evidence": {
            "builder": "luc3d-bench/scripts/bartul/bmimica_build_sleap_ref.py",
            "builder_n_animals": BUILDER_N_ANIMALS,
            "tracks_per_camera_session": {
                "median": float(np.median(tracks)), "mean": float(np.mean(tracks)),
                "min": int(min(tracks)), "max": int(max(tracks)),
                "n_camera_sessions": len(tracks)},
            "frac_instances_surviving_cut": {
                "median": float(np.median(surv)), "mean": float(np.mean(surv)),
                "min": float(min(surv)), "max": float(max(surv))}},
        "coherence_check": {
            "mean_track_jump_p95_px": float(np.nanmean([r["track_jump_p95_px"]
                                                        for r in rows])),
            "note": "The retracked tracks are temporally coherent and always were. This is "
                    "NOT the defect being corrected -- the truncation is. The 498 px figure "
                    "quoted by the first diagnosis was measured on the DETECTION pool, "
                    "which is not what this series is scored from."},
        "gate": g,
        "per_session": rows,
        "seconds": round(time.time() - t0, 1),
    }, indent=2))
    # `a.out`, not the hardcoded name: with --out this line named a file the run had
    # not written, which on the capped re-run read as if it had just overwritten the
    # shipped baseline's deposit. It had not -- but a log that says so is a defect.
    print(f"[scoped] wrote {OUT / a.out}")


if __name__ == "__main__":
    main()
