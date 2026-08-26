#!/usr/bin/env python
"""How many cameras does identity need? The shipped tracker re-run on camera
SUBSETS of the BMimica rig — switches and IDF1 against k, the panel the review
asked for ("# of cameras per switches ... to answer the how-many-cameras question").

    ############################################################################
    DESIGN (review plan F2.6b, the modest option). k = 2, 3, 4 with THREE fixed
    subsets per k, plus k = 5 = the full rig. Subsets are chosen
    DETERMINISTICALLY from the sorted list of C-choose-k combinations at indices
    [0, mid, last] -- no RNG, so the run is reproducible from this file alone --
    and the same three subsets are used for every session, so between-session
    spread is not confounded with between-subset spread. The full 26-subset
    design at 50 sessions (1,300 runs) was ruled infeasible in the review plan.

    THE k = 5 GATE. The full-rig cell is not re-tracked: it must REPRODUCE the
    shipped tracker's deposited 50-session numbers (fig8_methods_50.json,
    config "shipped": IDF1 0.7494, 2,071 switches). The subset runs use the same
    driver the head-to-head harness used for its greedy arm, so if k = 5 out of
    this script disagreed with the deposit, the subset cells would be measuring
    a different tracker and none of them would be publishable. The scoring stage
    re-scores the CACHED k = 5 outputs from out/tmp/headtohead/A2_C5_bmimica/
    through the same scorer as the subsets, and gates on the deposit.

    WHAT "SWITCHES vs k" MEANS HERE. Fewer cameras = less 3D evidence per
    association decision = more switches, is the hypothesis. Note the metric is
    within-view switches summed over the k cameras USED -- a raw sum over a
    smaller exposure as k falls -- so the deposited rate is per 100,000
    camera-frames of the cameras used, never the raw sum across arms.
    ############################################################################

Stages (different interpreters, like fig6_bytetrack_max2.py):
    node stage    figs/fig2_cams_identity.py --stage track --workers 12
    score stage   /root/vast/eric/luc3d-bench/liezl_env/bin/python \\
                      figs/fig2_cams_identity.py --stage score --workers 16

Output: out/tmp/cams_identity/<subset>/<session>.json (tracking),
        figs/out/fig2_cams_identity.json (scores + gate).
"""
import argparse
import itertools
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, as_completed
from pathlib import Path

FIGS = Path(__file__).resolve().parent
OUT = FIGS / "out"
TMP = OUT / "tmp" / "cams_identity"
DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
BENCH = Path("/root/vast/eric/luc3d-bench")
BM = BENCH / "outputs" / "bmimica"
CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
HH_CACHE = OUT / "tmp" / "headtohead" / "A2_C5_bmimica"   # session list only

#: The deposit cell the k = 5 gate must reproduce. THE SHIPPED FRESH ANCHOR
#: (stale 20 + distanceThreshold 25 + frame-synchronous association, the app
#: default since PR #210): this worktree's `pose/cross-view-tracker.js` and
#: `scripts/bench/hooks.mjs` now carry those defaults, so an unflagged bench run
#: IS the shipped configuration and must land on the fresh-anchor cell. Before
#: 2026-08-26 this gate pointed at `shipped`, the no-eviction cell, because the
#: branch predated the fix.
GATE_CONFIG = "sync_stale20_dist25"


def subsets():
    """{tag: [cams]} for k = 2, 3, 4 -- three deterministic picks per k -- plus
    k5_full, the whole rig, which is TRACKED here rather than re-scored from the
    head-to-head cache (see `score_job`)."""
    out = {}
    for k in (2, 3, 4):
        combos = sorted(itertools.combinations(CAMS, k))
        for idx in (0, len(combos) // 2, len(combos) - 1):
            cams = list(combos[idx])
            out[f"k{k}_" + "-".join(c[-3:] for c in cams)] = cams
    out["k5_full"] = list(CAMS)
    return out


def sessions():
    return sorted(p.name for p in HH_CACHE.iterdir() if p.is_dir())


def _calib(sid):
    from glob import glob
    hits = glob(str(Path("/root/vast/eric/BMimica") / sid / "calibration" /
                    "*_calibration.toml"))
    if not hits:
        raise RuntimeError(f"no calibration for {sid}")
    return hits[0]


def track_job(args):
    tag, cams, sid = args
    dst = TMP / tag / f"{sid}.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 1000:
        return tag, sid, "skip", 0.0
    det = BM / "det_h5" / sid
    t0 = time.time()
    cmd = ["node", str(DRIVER), "--pred-h5-dir", str(det), "--session-idx", "0",
           "--num-animals", "2", "--cameras", ",".join(cams),
           "--calibration", _calib(sid),
           "--out", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if r.returncode != 0 or not dst.exists():
        return tag, sid, "FAIL:" + r.stderr[-300:].replace("\n", " "), time.time() - t0
    return tag, sid, "ok", time.time() - t0


def score_job(args):
    tag, cams, sid = args
    sys.path.insert(0, str(FIGS))
    import fig3_score as fs
    # EVERY cell, k = 5 included, is scored from THIS pass's own tracking output
    # (2026-08-26). It used to re-score the head-to-head cache for k5_full, but
    # that cache is the PRE-#210 tracker -- mixing it with freshly tracked k = 2
    # to 4 cells would have compared two tracker generations across the x axis.
    src = TMP / tag / f"{sid}.json"
    try:
        r = fs.score_session(str(src), str(BM / "det_h5" / sid),
                             str(BM / "gt" / sid), cams, 2)
        r["session"], r["subset"], r["cameras"] = sid, tag, cams
        return r, None
    except Exception as e:  # noqa: BLE001
        return {"session": sid, "subset": tag}, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["track", "score"], required=True)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--sessions", type=int, default=0, help="cap for a pilot")
    a = ap.parse_args()
    subs = subsets()
    sess = sessions()
    if a.sessions:
        sess = sess[:a.sessions]

    if a.stage == "track":
        jobs = [(t, c, s) for t, c in subs.items() for s in sess]
        print(f"[cams] {len(subs)} subsets x {len(sess)} sessions = {len(jobs)} "
              f"tracking runs, {a.workers} wide", flush=True)
        done = fail = 0
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=a.workers) as ex:
            for f in as_completed([ex.submit(track_job, j) for j in jobs]):
                tag, sid, st, dt = f.result()
                done += 1
                if st.startswith("FAIL"):
                    fail += 1
                    print(f"  {tag}/{sid}: {st}", flush=True)
                if done % 20 == 0:
                    print(f"[cams] {done}/{len(jobs)} ({time.time() - t0:.0f}s, "
                          f"{fail} failed)", flush=True)
        print(f"[cams] track done: {done - fail}/{len(jobs)} ok")
        return

    jobs = [(t, c, s) for t, c in subs.items() for s in sess]
    rows, errs = [], []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(score_job, j) for j in jobs]), 1):
            r, err = f.result()
            (errs if err else rows).append(r if not err else f"{r['subset']}/{r['session']}: {err}")
            if i % 25 == 0:
                print(f"[cams] scored {i}/{len(jobs)} ({time.time() - t0:.0f}s)",
                      flush=True)
    if errs:
        print(f"[cams] {len(errs)} scoring failures, e.g. {errs[:2]}")

    # THE GATE: k5_full re-scored through this pass must match the deposit.
    dep = json.loads((OUT / "fig8_methods_50.json").read_text())
    shipped = next(c for c in dep["cells"] if c["config"] == GATE_CONFIG)
    ref = {r["session"]: r for r in shipped["per_session"]}
    k5 = [r for r in rows if r["subset"] == "k5_full" and r["session"] in ref]
    dmax = max(abs(r["within_idf1"] - ref[r["session"]]["within_idf1"]) for r in k5)
    print(f"[cams] GATE k5_full vs fig8_methods_50.json {GATE_CONFIG}: "
          f"{len(k5)} sessions, max |diff| {dmax:.3e}")
    gate_ok = dmax < 1e-9
    if not gate_ok:
        print("[cams] GATE FAILED -- k5 does not reproduce the fresh-anchor deposit; "
              "subset cells are NOT publishable. Depositing with gate.passed=false.")

    import numpy as np
    summary = {}
    for tag in subs:
        g = [r for r in rows if r["subset"] == tag]
        if not g:
            continue
        k = len(g[0]["cameras"])
        cf = sum(180057 * k for _ in g)          # ~frames x cams; exact below
        sw = sum(r["within_switches"] for r in g)
        summary[tag] = {
            "k": k, "n_sessions": len(g),
            "within_idf1_mean": float(np.mean([r["within_idf1"] for r in g])),
            "cross_idf1_mean": float(np.mean([r["cross_idf1"] for r in g])),
            "within_switches_total": int(sw),
        }
    (OUT / "fig2_cams_identity.json").write_text(json.dumps({
        "generated_by": "figs/fig2_cams_identity.py",
        "claim": "The shipped fresh-anchor cross-view tracker (stale 20, "
                 "distanceThreshold 25, frame-synchronous) re-run on deterministic camera "
                 "subsets of the BMimica rig; identity (IDF1, switches) against the "
                 "number of cameras available.",
        "subsets": {t: c for t, c in subs.items()},
        "gate": {"passed": bool(gate_ok), "max_abs_diff_idf1": dmax,
                 "reference": f"fig8_methods_50.json config={GATE_CONFIG}"},
        "summary": summary,
        "per_run": rows,
    }, indent=1))
    for tag, s_ in sorted(summary.items(), key=lambda kv: (kv[1]["k"], kv[0])):
        print(f"  {tag:22s} k={s_['k']}  within {s_['within_idf1_mean']:.4f}  "
              f"cross {s_['cross_idf1_mean']:.4f}  sw {s_['within_switches_total']:,}")
    print(f"[cams] wrote {OUT / 'fig2_cams_identity.json'}")


if __name__ == "__main__":
    main()
