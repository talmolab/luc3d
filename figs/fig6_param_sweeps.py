#!/usr/bin/env python
"""Fig 8 (EXPLORATORY, NOT IN THE MANUSCRIPT) — one-dimensional sweeps of every
remaining CrossViewTracker threshold, holding all others at their shipped default.

Fig 3e swept corr2dWeight x corr3dWeight and held every OTHER tracker parameter at
its default. This script sweeps the rest, ONE AT A TIME (a 1-D sweep per parameter,
not a grid), on exactly Fig 3e's measurement: the same 8 BMimica sessions, full
sessions with no frame cap, the same shared detection pool, the same
`figs/fig3_score.py` scoring path, and the same camera-frame denominator, so every
rate here is directly comparable to Fig 3e's.

It reuses `fig3_sweep.py`'s machinery rather than reimplementing it — same driver
(`figs/fig3-bench/fig3_bench.mjs`, which loads the unmodified pose/tracker.js),
same `--params` file shape ({"thresholds": {"<id>": value}}), same scorer, same
aggregation (`fig3_score.score_cell`). `fig3_sweep.py` is NOT modified and
`out/fig3_sweep.json` is NOT overwritten; this deposits `out/fig8_param_sweeps.json`.

THE DEFAULT CELL IS MEASURED ONCE. Every parameter's default value is the SAME
configuration — the shipped default — and that configuration is already the
`corr2d = 1, corr3d = 6` cell of the Fig 3e sweep, tracked over these same 8 full
sessions. `_link_default_cell()` symlinks those 8 result JSONs into this script's
own cache rather than re-running them, so the default is one measurement shared by
all ten sub-plots instead of ten identical re-runs. (fig3's params.json for that
cell is {"corr2dWeight": 1, "corr3dWeight": 6}, which is byte-for-byte the shipped
default, so the reuse is exact and not an approximation.)

    HALF THESE PARAMETERS CANNOT AFFECT THE RESULT, AND THAT IS THE FINDING.

`runCrossViewTracker` — the function `trackAll()` calls, and the one this driver
drives — reads exactly SEVEN thresholds:

    crossViewHyperparams()    corr2dWeight corr3dWeight velocityThreshold
                              distanceThreshold timePenalty
    buildTrackerDetections()  filterMinVisibleNodes filterMinInstanceScore

The other five swept here — track3dWeight, prevIdentityBonus, minMatchScore,
reprojSigma, epipolarDecay — are read ONLY inside `matchFrameInstances` and its
helpers (`epipolarScore`, `reprojectionScore`, `matchPairwise`,
`reorderGroupsByPrevTargets`), i.e. the LEGACY bench-only matcher. Nothing in the
app calls `matchFrameInstances`; its only call sites in the repo are
`scripts/bench/bench_driver.mjs`, `scripts/bench/speed_test.mjs` and
`tests/test-tracker-luc3d.mjs`. So on the shipped path they are inert at every
value.

That is asserted from the CODE above, but it is also MEASURED here, which is the
point of running them anyway: `payload_digest()` hashes the tracker's actual output
(the `identities` + `frames` block, excluding the echoed `params` and the
nondeterministic `runtimeSeconds`/`fps`), and the deposit records, per cell, whether
that digest equals the default cell's on all 8 sessions. A byte-identical output
across 8 full sessions is a far stronger statement than "the two scores came out
close", and it is falsifiable: if any of these five turns out to move a single
assignment, the digest says so and the flat curve stops being an argument.

    python3 figs/fig6_param_sweeps.py             # full pass (tracker + scoring)
    FIG8_WORKERS=24 python3 figs/fig6_param_sweeps.py

Scoring imports motmetrics, so run it with the bench interpreter:
/root/vast/eric/luc3d-bench/liezl_env/bin/python.

Output: figs/out/fig8_param_sweeps.json. Per-cell tracker results are cached under
figs/out/tmp/fig8/, so the run is restartable — an existing per-session result JSON
is reused rather than re-tracked.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "figs" / "out"

# Everything about the corpus, the driver, the detection pool and the scorer comes
# from fig3_sweep so this cannot drift from Fig 3e's measurement.
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402

TMP_DIR = OUT_DIR / "tmp" / "fig8"

#: The Fig 3e cache cell that IS the shipped default (corr2d 1, corr3d 6).
DEFAULT_SRC = OUT_DIR / "tmp" / "sweep_full" / "c2_1_c3_6"
DEFAULT_CELL = "default"

WORKERS = int(os.environ.get("FIG8_WORKERS", "16"))

#: (threshold id, shipped default, values to sweep). Every id is a key of
#: `scripts/bench/hooks.mjs` THRESHOLD_DEFAULTS and flows through the driver's
#: --params file. `corr3dWeight` is here only to extend Fig 3e's tail past its
#: swept range (r = 18 and r = 36 at corr2d = 1), testing whether the flat tail
#: continues; its other values live in Fig 3e.
PARAMS = [
    ("track3dWeight",          1,    [0, 1, 2, 4, 6, 8, 12]),
    ("prevIdentityBonus",      0.3,  [0, 0.1, 0.3, 0.6, 1.0]),
    ("velocityThreshold",      10,   [2, 5, 10, 20, 40]),
    ("distanceThreshold",      50,   [10, 25, 50, 100, 200]),
    ("filterMinVisibleNodes",  0,    [0, 4, 8, 12]),
    ("filterMinInstanceScore", 0,    [0, 0.5, 0.85]),
    ("minMatchScore",          0.05, [0, 0.05, 0.15, 0.3]),
    ("reprojSigma",            20,   [5, 10, 20, 40]),
    ("epipolarDecay",          10,   [2, 5, 10, 20]),
    ("corr3dWeight",           6,    [6, 18, 36]),
]

#: Thresholds `runCrossViewTracker` actually reads — read off pose/tracker.js
#: `crossViewHyperparams()` (l.840) and `buildTrackerDetections()` (l.853-855).
#: Recorded in the deposit so a reader of the JSON alone knows which sub-plots
#: can move at all.
LIVE_ON_SHIPPED_PATH = [
    "corr2dWeight", "corr3dWeight", "velocityThreshold", "distanceThreshold",
    "timePenalty", "filterMinVisibleNodes", "filterMinInstanceScore",
]


def vslug(v):
    """Filesystem-safe rendering of a parameter value ('0.85' -> '0p85')."""
    return f"{v:g}".replace(".", "p").replace("-", "m")


def cell_id(param, value, default):
    return DEFAULT_CELL if value == default else f"{param}__{vslug(value)}"


def cells():
    """Every (cell_id, overrides) to measure, default deduplicated to one entry."""
    seen = {}
    order = []
    for param, default, values in PARAMS:
        for v in values:
            cid = cell_id(param, v, default)
            if cid in seen:
                continue
            seen[cid] = {} if cid == DEFAULT_CELL else {param: v}
            order.append(cid)
    return [(cid, seen[cid]) for cid in order]


def _link_default_cell():
    """Point this script's default cell at Fig 3e's already-measured corr2d=1/corr3d=6.

    Symlinks, not copies: 8 x ~34 MB, and the originals must stay exactly where
    fig3_sweep.py expects them. Nothing is written into fig3's cache.
    """
    d = TMP_DIR / DEFAULT_CELL
    d.mkdir(parents=True, exist_ok=True)
    linked = 0
    for s in f3.SESSIONS:
        src = DEFAULT_SRC / f"{s}.json"
        dst = d / f"{s}.json"
        if dst.exists() or dst.is_symlink():
            continue
        if not src.exists():
            print(f"[fig8] default cell: {src} missing -- it will be tracked fresh")
            continue
        dst.symlink_to(src)
        linked += 1
    print(f"[fig8] default cell: linked {linked} session results from {DEFAULT_SRC}")


def run_one(cid, overrides, session):
    """Track one (cell, session). Mirrors fig3_sweep.run_one, keyed by cell id."""
    cell_dir = TMP_DIR / cid
    cell_dir.mkdir(parents=True, exist_ok=True)
    out_path = cell_dir / f"{session}.json"
    if out_path.exists() and out_path.stat().st_size > 100:
        return (session, "ok", str(out_path))

    calib = f3.calib_for(session)
    if not calib:
        return (session, "failed", f"no calibration.toml for {session}")
    det_dir = f3.DET / session
    if not det_dir.exists():
        return (session, "failed", f"no det_h5 dir {det_dir}")

    params_path = cell_dir / "params.json"
    if not params_path.exists():
        params_path.write_text(json.dumps({"thresholds": overrides}))

    cmd = [
        "node", str(f3.DRIVER),
        "--session-idx", "0", "--num-animals", str(f3.NUM_ANIMALS),
        "--calibration", calib,
        "--pred-h5-dir", str(det_dir),
        "--out", str(out_path),
        "--cameras", ",".join(f3.CAMERAS),
        "--params", str(params_path),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if r.returncode != 0 or not out_path.exists():
            return (session, "failed",
                    f"driver exit {r.returncode}: " + r.stderr[-500:].replace("\n", " "))
        return (session, "ok", str(out_path))
    except subprocess.TimeoutExpired:
        return (session, "failed", "driver timed out")
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e))


def payload_digest(path):
    """SHA-256 of the tracker's OUTPUT, excluding what is not the tracker's output.

    The driver writes `{... params, identities, frames, framesProcessed ...}` in that
    fixed key order. `params` is the echoed override (different by construction in
    every cell) and `runtimeSeconds`/`fps` are wall-clock, so all three are excluded;
    what remains -- `identities` + `frames`, i.e. every per-camera, per-frame identity
    assignment the tracker made -- is the thing two cells are being compared on.
    Sliced out of the raw bytes rather than re-serialised, so this costs one read.
    """
    b = Path(path).read_bytes()
    i = b.find(b'"identities":')
    j = b.find(b',"framesProcessed"', i)
    if i < 0 or j < 0:
        return None
    return hashlib.sha256(b[i:j]).hexdigest()


def score_one(cid, session):
    """Score one (cell, session) and digest its payload. Mirrors fig3_sweep.score_one."""
    result_path = TMP_DIR / cid / f"{session}.json"
    if not result_path.exists():
        return (session, "failed", "no result JSON (driver run failed)", None)
    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs  # noqa: E402
    try:
        s = fs.score_session(str(result_path), str(f3.DET / session),
                             str(f3.GT / session), f3.CAMERAS, f3.NUM_ANIMALS,
                             max_frames=None)
        return (session, "ok", s, payload_digest(result_path))
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e), None)


def main():
    t0 = time.time()
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    _link_default_cell()

    cell_list = cells()
    jobs = [(cid, ov, s) for (cid, ov) in cell_list for s in f3.SESSIONS]
    print(f"[fig8] {len(cell_list)} cells x {len(f3.SESSIONS)} sessions = {len(jobs)} "
          f"driver runs, {WORKERS} workers", flush=True)

    # --- phase 1: track ---
    run_status = {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(run_one, cid, ov, s): (cid, s) for (cid, ov, s) in jobs}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            run_status[key] = (status, info)
            done += 1
            if done % 10 == 0 or done == len(jobs):
                print(f"[fig8] driver runs {done}/{len(jobs)} ({time.time()-t0:.0f}s)",
                      flush=True)
            if status != "ok":
                print(f"[fig8] FAILED cell={key[0]} session={session}: {info}", flush=True)

    # --- phase 2: score ---
    score_status = {}
    digests = {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(score_one, cid, s): (cid, s)
                for (cid, ov, s) in jobs if run_status[(cid, s)][0] == "ok"}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info, dig = fut.result()
            score_status[key] = (status, info)
            digests[key] = dig
            done += 1
            if done % 10 == 0 or done == len(futs):
                print(f"[fig8] scored {done}/{len(futs)} ({time.time()-t0:.0f}s)",
                      flush=True)
            if status != "ok":
                print(f"[fig8] SCORE-FAILED cell={key[0]} session={session}: {info}",
                      flush=True)

    # --- phase 3: aggregate per cell ---
    import fig3_score as fs  # noqa: E402

    agg_by_cell = {}
    for (cid, _ov) in cell_list:
        sess_scores, why = [], []
        for s in f3.SESSIONS:
            if run_status[(cid, s)][0] != "ok":
                why.append(f"{s}: driver failed: {run_status[(cid, s)][1]}")
                continue
            st, info = score_status.get((cid, s), ("failed", "not scored"))
            if st != "ok":
                why.append(f"{s}: scoring failed: {info}")
                continue
            sess_scores.append(info)
        agg_by_cell[cid] = (fs.score_cell(sess_scores) if sess_scores else None, why)

    default_dig = [digests.get((DEFAULT_CELL, s)) for s in f3.SESSIONS]

    rows = []
    for param, default, values in PARAMS:
        for v in values:
            cid = cell_id(param, v, default)
            agg, why = agg_by_cell[cid]
            dig = [digests.get((cid, s)) for s in f3.SESSIONS]
            same = (all(d is not None for d in dig)
                    and all(d is not None for d in default_dig)
                    and dig == default_dig)
            row = {
                "param": param, "value": v, "is_default": v == default,
                "cell_id": cid, "overrides": {} if v == default else {param: v},
                "reaches_shipped_tracker": param in LIVE_ON_SHIPPED_PATH,
                "identical_to_default": bool(same),
                "status": "ok" if agg else "failed",
                "why": "; ".join(why),
            }
            row.update(agg or {"idf1_within": None, "idf1_cross": None,
                               "switches": None, "n_sessions": 0})
            rows.append(row)
            print(f"[fig8] {param}={v:g}{' (default)' if v == default else ''}: "
                  f"switches={row['switches']} cross={row['idf1_cross']} "
                  f"identical_to_default={row['identical_to_default']}", flush=True)

    total_cf, cf_by_session = f3.camera_frames()
    print(f"[fig8] total_camera_frames = {total_cf:,}", flush=True)

    out = {
        "generated_by": "figs/fig6_param_sweeps.py",
        "status": "EXPLORATORY -- not part of the manuscript, not placed in any figure "
                  "that goes to the journal.",
        "dataset": "BMimica",
        "detection_pool": str(f3.DET),
        "sessions": f3.SESSIONS,
        "cameras": f3.CAMERAS,
        "num_animals": f3.NUM_ANIMALS,
        "metric": "IDF1 (motmetrics) + ID-switches",
        "total_camera_frames": total_cf,
        "camera_frames_by_session": cf_by_session,
        "live_on_shipped_path": LIVE_ON_SHIPPED_PATH,
        "shipped_defaults": {p: d for (p, d, _v) in PARAMS},
        "caveats": [
            "Every cell/session is tracked and scored on the FULL session -- every "
            "frame, no window -- exactly as fig3_sweep.py's full pass was.",
            f3.CF_CAVEAT,
            "One-dimensional sweeps: each cell varies ONE threshold and leaves every "
            "other at its shipped default. There is no interaction term here; a "
            "parameter that is flat alone could still matter jointly with another.",
            "The default cell is the SAME configuration for all ten parameters and is "
            "measured once -- it is Fig 3e's corr2d=1/corr3d=6 cell, reused by symlink.",
            "idf1_within is the mean of per-camera within-view IDF1 over all cameras "
            "and sessions; idf1_cross is IDF1 under one global identity per animal "
            "pooled over all cameras; switches is the SUM of per-camera within-view "
            "ID switches over all cameras and sessions in the cell.",
            "reaches_shipped_tracker is read off pose/tracker.js: runCrossViewTracker "
            "-> createTrackerRun -> crossViewHyperparams()/buildTrackerDetections() "
            "reads only corr2dWeight, corr3dWeight, velocityThreshold, "
            "distanceThreshold, timePenalty, filterMinVisibleNodes and "
            "filterMinInstanceScore. track3dWeight, prevIdentityBonus, minMatchScore, "
            "reprojSigma and epipolarDecay are read only inside matchFrameInstances, "
            "the legacy bench-only matcher, which no app path calls.",
            "identical_to_default is MEASURED, not inferred: the SHA-256 of the "
            "tracker's identities+frames payload (params/runtimeSeconds/fps excluded) "
            "equals the default cell's on all 8 full sessions.",
            "IDF1's cell-to-cell noise on this grid is about 0.05 (adjacent Fig 3e "
            "cells that differ in no meaningful way still move by that much), so no "
            "IDF1 difference below ~0.05 should be read as a ranking.",
        ],
        "cells": rows,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig8_param_sweeps.json").write_text(json.dumps(out, indent=2))
    print(f"[fig8] wrote {OUT_DIR / 'fig8_param_sweeps.json'} "
          f"({time.time()-t0:.0f}s total)", flush=True)


def per_session():
    """Re-score the cells that actually DIFFER, keeping each session's own numbers.

    The main pass aggregates: a mean IDF1 and a summed switch count over 8 sessions.
    That is the right unit for the figure and the wrong unit for the only decision
    this measurement feeds -- whether to move a shipped default. A pooled sum can be
    carried by one session, and this repo has been burned by exactly that twice (see
    README, "Fig 4 over all 50 sessions REVERSED the held-out conclusion", and the
    n = 1 pilot rule). What licenses a default change is a per-session count: better
    in k of 8, not better on average.

    Only the cells whose tracker output is NOT byte-identical to the default's are
    re-scored -- for the rest, per-session equality is already established at the
    byte level and re-running motmetrics on them would just reproduce the default's
    numbers at 8 sessions x 5 cameras x ~180k frames apiece. That is ~8 cells rather
    than 35, i.e. minutes rather than the two hours the full scoring pass takes.

    Merges `per_session` into the matching cells of the existing deposit; the run
    that produced `cells` is not repeated and the tracker is not re-run.
    """
    path = OUT_DIR / "fig8_param_sweeps.json"
    out = json.loads(path.read_text())
    want = [c for c in out["cells"]
            if c["is_default"] or not c.get("identical_to_default")]
    # Dedup: the default cell appears once per parameter but is one measurement.
    cids, seen = [], set()
    for c in want:
        if c["cell_id"] not in seen:
            seen.add(c["cell_id"])
            cids.append(c["cell_id"])
    print(f"[fig8] per-session: re-scoring {len(cids)} distinct cells x "
          f"{len(f3.SESSIONS)} sessions", flush=True)

    got = {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(score_one, cid, s): (cid, s)
                for cid in cids for s in f3.SESSIONS}
        done = 0
        for fut in as_completed(futs):
            cid, s = futs[fut]
            session, status, info, _dig = fut.result()
            done += 1
            if status != "ok":
                print(f"[fig8] per-session FAILED {cid} {s}: {info}", flush=True)
                continue
            got[(cid, s)] = {"session": s, "within_idf1": info["within_idf1"],
                             "cross_idf1": info["cross_idf1"],
                             "within_switches": info["within_switches"],
                             "cross_switches": info["cross_switches"]}
            if done % 10 == 0 or done == len(futs):
                print(f"[fig8] per-session {done}/{len(futs)}", flush=True)

    for c in out["cells"]:
        rows = [got[(c["cell_id"], s)] for s in f3.SESSIONS if (c["cell_id"], s) in got]
        if rows:
            c["per_session"] = rows

    # Per-session comparison against the default, which is the form the decision
    # needs: how many of the 8 sessions each candidate actually beats.
    dflt = {r["session"]: r for r in
            next(c for c in out["cells"] if c["cell_id"] == DEFAULT_CELL)["per_session"]}
    for c in out["cells"]:
        if c["cell_id"] == DEFAULT_CELL or "per_session" not in c:
            continue
        rows = c["per_session"]
        c["sessions_fewer_switches"] = sum(
            1 for r in rows if r["within_switches"] < dflt[r["session"]]["within_switches"])
        c["sessions_more_switches"] = sum(
            1 for r in rows if r["within_switches"] > dflt[r["session"]]["within_switches"])
        c["sessions_higher_cross_idf1"] = sum(
            1 for r in rows if r["cross_idf1"] > dflt[r["session"]]["cross_idf1"])
        c["n_sessions_compared"] = len(rows)

    out.setdefault("caveats", []).append(
        "per_session is present only on the default cell and on cells whose tracker "
        "output differs from it; every other cell is byte-identical to the default, "
        "so its per-session numbers ARE the default's. sessions_fewer_switches / "
        "sessions_higher_cross_idf1 count how many of the 8 sessions that cell beats "
        "the shipped default on -- the unit a default change has to be argued in, "
        "since a pooled sum can be carried by one session.")
    path.write_text(json.dumps(out, indent=2))
    print(f"[fig8] merged per-session detail into {path}", flush=True)


#: The one 2-D question the 1-D sweeps cannot answer, and the only reason a grid
#: appears in this script at all. `distanceThreshold` and `corr3dWeight` are the two
#: knobs on the SAME term of the cost function -- `w_k * corr3d * (1 - dist/distThresh)`
#: -- so halving distThresh and raising corr3d both steepen the 3D penalty. They are
#: the two best 1-D candidates (262 and 272 switches against the default's 324) and
#: they improve the SAME sessions, which is what a shared mechanism looks like. A
#: recommendation to move distanceThreshold is only worth making if it buys something
#: the corr3d knob does not already buy, and one cell each settles it.
INTERACTION = [
    {"distanceThreshold": 25, "corr3dWeight": 12},
    {"distanceThreshold": 25, "corr3dWeight": 36},
]


def interaction():
    """Run the distanceThreshold x corr3dWeight combos and merge them under their own key.

    Deposited as `interaction_check`, NOT into `cells`: Fig 8's panels are ten 1-D
    sweeps and a 2-D cell has no place on them. This is decision support, not artwork.
    """
    path = OUT_DIR / "fig8_param_sweeps.json"
    out = json.loads(path.read_text())
    combos = [("x__" + "__".join(f"{k}_{vslug(v)}" for k, v in sorted(ov.items())), ov)
              for ov in INTERACTION]
    jobs = [(cid, ov, s) for (cid, ov) in combos for s in f3.SESSIONS]
    print(f"[fig8] interaction: {len(combos)} cells x {len(f3.SESSIONS)} sessions",
          flush=True)

    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(run_one, cid, ov, s): (cid, s) for (cid, ov, s) in jobs}
        for fut in as_completed(futs):
            cid, s = futs[fut]
            _sess, status, info = fut.result()
            if status != "ok":
                print(f"[fig8] interaction FAILED {cid} {s}: {info}", flush=True)
    print("[fig8] interaction: tracked, scoring", flush=True)

    import fig3_score as fs  # noqa: E402
    rows = []
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(score_one, cid, s): (cid, s) for (cid, _ov, s) in jobs}
        got = {}
        for fut in as_completed(futs):
            cid, s = futs[fut]
            _sess, status, info, _d = fut.result()
            if status == "ok":
                got.setdefault(cid, []).append((s, info))
            else:
                print(f"[fig8] interaction SCORE-FAILED {cid} {s}: {info}", flush=True)
    for cid, ov in combos:
        got.setdefault(cid, []).sort()
        per = [dict(session=s, within_switches=i["within_switches"],
                    cross_idf1=i["cross_idf1"], within_idf1=i["within_idf1"])
               for s, i in got.get(cid, [])]
        agg = fs.score_cell([i for _s, i in got.get(cid, [])])
        row = {"cell_id": cid, "overrides": ov, "per_session": per}
        row.update(agg or {})
        rows.append(row)
        print(f"[fig8] interaction {ov}: switches={row.get('switches')} "
              f"cross={row.get('idf1_cross')}", flush=True)

    out["interaction_check"] = {
        "why": "distanceThreshold and corr3dWeight are two knobs on the SAME 3D term "
               "of the cross-view cost, w*corr3d*(1 - dist/distThresh). Both are 1-D "
               "winners and both improve the same sessions, so the 1-D sweeps cannot "
               "say whether lowering distanceThreshold buys anything on top of raising "
               "corr3dWeight. Not plotted in Fig 8 -- that figure is 1-D sweeps.",
        "cells": rows,
    }
    path.write_text(json.dumps(out, indent=2))
    print(f"[fig8] merged interaction_check into {path}", flush=True)


if __name__ == "__main__":
    if "--per-session" in sys.argv:
        per_session()
    elif "--interaction" in sys.argv:
        interaction()
    else:
        main()
