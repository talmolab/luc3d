#!/usr/bin/env python
"""Fig 3e's corr2dWeight x corr3dWeight grid, on ALL 50 proofread BMimica sessions —
optionally on top of an improved tracker.

WHAT IT MEASURES
----------------
The same grid Fig 3e plots: `corr3dWeight` x `corr2dWeight`, every other
CrossViewTracker threshold held at its shipped default, scored with
`figs/fig3_score.py` (per-camera within-view IDF1 + within-view ID switches, and a
cross-view IDF1 under one global identity per animal pooled over all five cameras).
Full sessions, every frame, no window — `--max-frames` exists ONLY as a smoke-test
knob and routes its output to a separate deposit so a capped run can never be read
as the measurement (see "WHAT MUST NOT BE MIXED").

Two things differ from `fig3_sweep.py`:

  1. **The corpus is all 50 proofread BMimica sessions, not Fig 3e's eight.** The
     eight-session subset is what makes Fig 3e comparable to Fig 8a-8d, and it is
     also its weakness: this repo's own history records that Fig 4 over all 50
     sessions REVERSED a conclusion drawn from a subset. Fig 3e's claim is that the
     shipped default sits on a plateau, and a plateau found on 16% of the corpus is
     a hypothesis, not a result. Session discovery is delegated to
     `fig8_methods.use_all_bmimica_sessions()` so the corpus cannot drift from the
     one Fig 8's 50-session pass used — a session qualifies only when it has
     detections, proofread GT AND a calibration for all five cameras.

  2. **There is an optional `method` block**, so the grid can be re-run on top of an
     experimental tracker rather than only the shipped one. That is the question
     Fig 8 leaves open: Fig 8 found `sync` + `stale: 10` + `distanceThreshold` 25
     at 511 switches / cross-view IDF1 0.8498 against the shipped 2,071 / 0.7493
     over these same 50 sessions — but it found that at ONE point of the 2D/3D
     balance. The 2D/3D balance is the axis Fig 3e swept, and a tracker whose 3D
     anchor is now fresh has no reason to want the same balance a tracker fusing
     8,000-frame-old detections wanted. This runs Fig 3e's grid on top of it and
     finds out. Hence the driver here is `figs/fig6-bench/fig6_bench.mjs` (which
     serves `figs/fig6-bench/xv_experimental.js` in place of
     pose/cross-view-tracker.js through an ESM loader hook) and NOT
     `figs/fig3-bench/fig3_bench.mjs` — with an EMPTY method block the two are
     byte-identical on all 8 full sessions, which `fig6_methods.py --verify` proves
     by SHA-256 of the identities+frames payload. No app source is modified.

WHY IT IS A SEPARATE FILE
-------------------------
`fig3_sweep.py` is the deposit Fig 3e is drawn from and it is NOT modified and NOT
overwritten here. Its 8-session cells, its `tmp/sweep_full/` cache and its
7,205,370-camera-frame denominator stay exactly as they are; `fig6_param_sweeps.py`
reuses that cache by symlink and Fig 8's whole comparison rests on it. This script
imports `fig3_sweep` for the corpus constants, the scorer wiring and
`camera_frames()`, and touches nothing it owns.

WHAT MUST NOT BE MIXED
----------------------
`switches` is a RAW SUM over every camera of every session, so it means nothing
without the exposure it accumulated over, and that exposure is different here:
7,205,370 camera-frames over Fig 3e's eight sessions versus 45,021,960 over these
fifty. A switch count from this file placed beside one from `fig3_sweep.json` is
not a comparison — it is a corpus-size difference wearing a metric's name. So:

  * Every deposit records `total_camera_frames` and `camera_frames_by_session`,
    measured (not assumed) by calling `fig3_sweep.camera_frames()` itself — the same
    `min(gt_frames, det_frames)` per camera that `fig3_score.score_session()` scores
    over, read from HDF5 *shapes* only. Rates are switches per camera-frame; the raw
    sums are retained. `f3.CF_CAVEAT` is copied into every deposit so a reader of
    the JSON alone knows what the rate is over.
  * Shipped and experimental tracker configurations get DIFFERENT cache directories
    and DIFFERENT deposits, keyed by a digest of the method+thresholds block. Cells
    are cached and `run_one()` early-returns on an existing result JSON — that is
    what makes an hours-long grid restartable, and it is also the one way this could
    silently lie, by handing a shipped-tracker result to an experimental cell. The
    digest in the path is what makes that impossible.
  * A `--max-frames` run and a subsetted-session run are tagged in both the cache
    path and the deposit filename, for the same reason `fig3_sweep.py` keeps
    `tmp/sweep/` apart from `tmp/sweep_full/`: a full-session pass must not be able
    to pick up a capped run's leftovers.

COST — READ THIS BEFORE LAUNCHING
---------------------------------
The full 8x3 grid at 50 full sessions is 1,200 tracker runs plus 1,200 motmetrics
scorings, and scoring is the expensive half (~8 min per session-cell, five cameras
x ~180k frames). That is many hours and tens of GB of cached result JSON. `--dry-run`
prints the exact run counts, the cached fraction, a wall-clock estimate at a given
worker count and a disk estimate, so the bill is visible first. `--grid-corr3d` /
`--grid-corr2d` reduce the grid; a reduced grid on one corr2d row is the sensible
first pass.

    $PY figs/fig3_sweep50.py --dry-run
    $PY figs/fig3_sweep50.py --dry-run --grid-corr3d 0,1,4,12 --grid-corr2d 1 --workers 24
    $PY figs/fig3_sweep50.py --grid-corr3d 0,1,4,12 --grid-corr2d 1 \
        --method '{"sync":true,"stale":10}' --thresholds '{"distanceThreshold":25}'

Scoring needs motmetrics, so run it with the bench interpreter:
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig3_sweep50.json (shipped tracker, full grid, full sessions), or
figs/out/fig3_sweep50__<tag>.json when a method/threshold block or a smoke-test
restriction is in play. Per-cell tracker results cache under
figs/out/tmp/sweep50/<tag>/c2_<corr2d>_c3_<corr3d>/, so the run is restartable.
NEVER writes figs/out/fig3_sweep.json.
"""
import argparse
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

# Corpus, detection pool, driver conventions, scorer wiring and the camera-frame
# denominator all come from fig3_sweep, so this cannot drift from Fig 3e's
# measurement. fig8_methods supplies the 50-session discovery and the --params
# normaliser. Neither module is modified; neither of their deposits is written.
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig6_methods as f8m  # noqa: E402
import fig6_param_sweeps as f8  # noqa: E402  (vslug)

#: The Fig 8 driver, not the Fig 3 one — this is the only one that honours a `method`
#: block. With an empty method block it reproduces pose/cross-view-tracker.js bit for
#: bit (figs/out/fig8_methods_verify.json).
DRIVER = REPO / "figs" / "fig6-bench" / "fig6_bench.mjs"

TMP_ROOT = OUT_DIR / "tmp" / "sweep50"

#: Fig 3e's grid, imported rather than restated so the two cannot disagree about
#: what the full grid is.
CORR3D_GRID = list(f3.CORR3D_GRID)
CORR2D_GRID = list(f3.CORR2D_GRID)

WORKERS = int(os.environ.get("FIG3_SWEEP50_WORKERS", "16"))

#: Measured cost constants for --dry-run, from the 50-session Fig 8 pass
#: (figs/out/tmp/fig8m_all50.log, 200 driver runs + 200 scorings at 32 workers):
#: driver runs finished at 1,293 s => 1293*32/200 ~ 207 s of one worker's time per
#: run; scoring finished at 4,401 s => (4401-1293)*32/200 ~ 497 s per scoring. The
#: tracker half varies with the configuration (shipped tracker 228 s of tracking per
#: session, `sync`+`stale:10` 83 s), so 260 s is used as the conservative figure.
#: MEDIAN_FRAMES is the median session length in that pass, used to scale a
#: --max-frames estimate; both halves are near-linear in frame count.
EST_TRACK_SEC = 260.0
EST_SCORE_SEC = 500.0
MEDIAN_FRAMES = 180030
#: One cell of 50 full-session result JSONs measured 1.6 GB in tmp/fig8m50/.
EST_CELL_GB = 1.6

#: Never write Fig 3e's deposit. Asserted rather than merely intended.
FORBIDDEN = {(OUT_DIR / "fig3_sweep.json").resolve(),
             (OUT_DIR / "fig8_methods.json").resolve(),
             (OUT_DIR / "fig8_methods_50.json").resolve(),
             (OUT_DIR / "fig8_param_sweeps.json").resolve()}


def discover_sessions():
    """Every proofread BMimica session, via fig8_methods' own discovery.

    Delegated on purpose: `use_all_bmimica_sessions()` is the predicate Fig 8's
    50-session pass used (detections + proofread GT + calibration for all five
    cameras, checked rather than assumed), and re-deriving it here would let the two
    corpora drift apart while both files claimed "all 50 sessions". It sets
    `f3.SESSIONS`, which is what `f3.camera_frames()` reads.

    It also re-points fig8_methods' OWN cache and deposit at its 50-session pair and
    says so on stdout; that is about fig8_methods, not about this script, and nothing
    here writes either. The cross-check against `fig8_methods_50.json` is what
    licenses comparing a cell from this file against a Fig 8 50-session row.
    """
    sessions = f8m.use_all_bmimica_sessions()
    prev = OUT_DIR / "fig8_methods_50.json"
    if prev.exists():
        try:
            was = json.loads(prev.read_text()).get("sessions") or []
        except Exception:  # noqa: BLE001
            was = []
        if was and sorted(was) != sorted(sessions):
            print(f"[sweep50] WARNING: corpus differs from fig8_methods_50.json "
                  f"({len(was)} sessions there, {len(sessions)} here) -- switch counts "
                  f"across the two files are NOT comparable", flush=True)
        elif was:
            print(f"[sweep50] corpus matches fig8_methods_50.json ({len(was)} sessions)",
                  flush=True)
    return sessions


def base_params(method, thresholds):
    """The method/threshold block every cell of this grid sits on top of.

    Normalised through `fig8_methods._as_params()` so the file the driver reads is
    the same shape Fig 8's cells wrote, and a cell of this grid with
    `{"sync":true,"stale":10}` / `{"distanceThreshold":25}` at corr2d 1 / corr3d 6 is
    byte-for-byte the params of Fig 8's `sync_stale10_dist25` cell.
    """
    return f8m._as_params({"method": dict(method or {}),
                           "thresholds": dict(thresholds or {})})


def cell_params(base, corr2d, corr3d):
    """`base` with this cell's two swept weights layered on. Does not mutate `base`."""
    th = dict(base["thresholds"])
    th["corr2dWeight"] = corr2d
    th["corr3dWeight"] = corr3d
    return {"method": dict(base["method"]), "thresholds": th}


def _slug_kv(k, v):
    """One method/threshold entry as a filesystem-safe token (readability only)."""
    if isinstance(v, bool):
        return k if v else f"no{k}"
    if isinstance(v, (int, float)):
        return f"{k}{f8.vslug(v)}"
    return f"{k}{str(v)[:8]}"


def tag_for(base, max_frames, n_sessions, all_sessions):
    """Cache/deposit tag: what this pass is, in one filesystem-safe token.

    Everything that changes what a cached result JSON MEANS goes in here, because
    `run_one()` early-returns on an existing file and a tag collision is the one way
    this script could silently hand a shipped-tracker cell to an experimental one:
    the method block, the extra thresholds, the frame cap and any session
    restriction. `shipped` is the empty case, so the default full pass lands in
    `tmp/sweep50/shipped/` + `fig3_sweep50.json` with no decoration.
    """
    parts = []
    if base["method"] or base["thresholds"]:
        # Readable slug for a human reading `ls`, PLUS a digest of the canonical JSON
        # so two configurations can never collide after the slug is truncated. The
        # digest is the part that carries the correctness guarantee.
        items = sorted(list(base["method"].items()) + list(base["thresholds"].items()))
        slug = "-".join(_slug_kv(k, v) for k, v in items) or "cfg"
        digest = hashlib.sha256(json.dumps(base, sort_keys=True).encode()).hexdigest()
        parts.append(f"{slug[:48]}_{digest[:8]}")
    else:
        parts.append("shipped")
    if max_frames:
        parts.append(f"f{max_frames}")
    if not all_sessions:
        parts.append(f"s{n_sessions}")
    return "__".join(parts)


def deposit_for(tag):
    path = OUT_DIR / ("fig3_sweep50.json" if tag == "shipped"
                      else f"fig3_sweep50__{tag}.json")
    if path.resolve() in FORBIDDEN:
        raise SystemExit(f"refusing to write {path} -- that deposit belongs to "
                         f"another script")
    return path


def camera_frames(sessions, max_frames):
    """The denominator for `switches`, measured exactly as Fig 3e measures it.

    Calls `fig3_sweep.camera_frames()` itself rather than reimplementing the
    expression, with `f3.SESSIONS` / `f3.FRAMES_PER_SESSION` pointed at this pass's
    corpus and cap for the duration. Reimplementing it is how two files end up
    reporting rates over subtly different exposures; this way there is one
    expression, `sum over cameras of min(gt_frames, det_frames)` capped by
    `max_frames`, and it is the one `fig3_score.score_session()` scores over. Costs a
    few HDF5 `.shape` reads, no arrays materialised.

    Restores both globals, so nothing later in this process sees a mutated
    fig3_sweep.
    """
    old_s, old_f = f3.SESSIONS, f3.FRAMES_PER_SESSION
    try:
        f3.SESSIONS = list(sessions)
        f3.FRAMES_PER_SESSION = max_frames
        return f3.camera_frames()
    finally:
        f3.SESSIONS, f3.FRAMES_PER_SESSION = old_s, old_f


def run_one(cell_dir, params, session, max_frames):
    """Track one (cell, session) through the Fig 8 driver. Restartable.

    Early-returns on an existing result JSON, which is what lets a 1,200-run grid be
    interrupted and resumed. `cell_dir` is passed explicitly (rather than derived from
    a module global) so a worker process cannot compute a different path than the
    parent did.
    """
    cell_dir = Path(cell_dir)
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
    params_path.write_text(json.dumps(params, sort_keys=True))

    cmd = [
        "node", str(DRIVER),
        "--session-idx", "0", "--num-animals", str(f3.NUM_ANIMALS),
        "--calibration", calib,
        "--pred-h5-dir", str(det_dir),
        "--out", str(out_path),
        "--cameras", ",".join(f3.CAMERAS),
        "--params", str(params_path),
    ]
    # Omitted entirely for a full-session run; the driver guards on truthiness.
    if max_frames:
        cmd += ["--max-frames", str(max_frames)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=(900 if max_frames else 7200))
        if r.returncode != 0 or not out_path.exists():
            return (session, "failed",
                    f"driver exit {r.returncode}: " + r.stderr[-500:].replace("\n", " "))
        return (session, "ok", str(out_path))
    except subprocess.TimeoutExpired:
        return (session, "failed", "driver timed out")
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e))


def score_one(cell_dir, session, max_frames):
    """Score one (cell, session) against proofread GT. The expensive half."""
    result_path = Path(cell_dir) / f"{session}.json"
    if not result_path.exists():
        return (session, "failed", "no result JSON (driver run failed)")
    import fig3_score as fs  # noqa: E402
    try:
        s = fs.score_session(str(result_path), str(f3.DET / session),
                             str(f3.GT / session), f3.CAMERAS, f3.NUM_ANIMALS,
                             max_frames=max_frames)
        return (session, "ok", s)
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e))


def dry_run(cells_grid, sessions, tag, max_frames, workers):
    """Print the bill before it is incurred: runs, cached fraction, wall clock, disk.

    The estimate is deliberately built from the measured 50-session Fig 8 pass rather
    than from a guess (see EST_TRACK_SEC / EST_SCORE_SEC), and it counts CACHED cells
    as free, because they are — `run_one` early-returns on them. Both phases are
    embarrassingly parallel and run one after the other, so the model is
    `todo * per_run / workers` summed over the two phases.
    """
    root = TMP_ROOT / tag
    n_cells, n_sess = len(cells_grid), len(sessions)
    total = n_cells * n_sess
    cached = 0
    for (c2, c3) in cells_grid:
        d = root / f"c2_{c2}_c3_{c3}"
        for s in sessions:
            p = d / f"{s}.json"
            if p.exists() and p.stat().st_size > 100:
                cached += 1
    todo = total - cached
    scale = min(1.0, max_frames / MEDIAN_FRAMES) if max_frames else 1.0
    track_s = todo * EST_TRACK_SEC * scale / max(1, workers)
    score_s = total * EST_SCORE_SEC * scale / max(1, workers)
    disk_gb = n_cells * EST_CELL_GB * (n_sess / 50.0) * scale

    print(f"[sweep50] --dry-run")
    print(f"  corr3d grid          : {[c for c in sorted({c3 for _c2, c3 in cells_grid})]}")
    print(f"  corr2d grid          : {[c for c in sorted({c2 for c2, _c3 in cells_grid})]}")
    print(f"  cells                : {n_cells}")
    print(f"  sessions             : {n_sess}")
    print(f"  frame cap            : {max_frames if max_frames else 'none (full sessions)'}")
    print(f"  cache tag            : {tag}")
    print(f"  cache dir            : {root}")
    print(f"  deposit              : {deposit_for(tag)}")
    print(f"  TRACKER RUNS         : {total}  ({cached} already cached, {todo} to run)")
    print(f"  SCORING RUNS         : {total}  (never cached; motmetrics re-runs every pass)")
    print(f"  workers              : {workers}")
    print(f"  est. tracking        : {track_s/3600:.2f} h  "
          f"({todo} x {EST_TRACK_SEC*scale:.0f}s / {workers})")
    print(f"  est. scoring         : {score_s/3600:.2f} h  "
          f"({total} x {EST_SCORE_SEC*scale:.0f}s / {workers})")
    print(f"  EST. TOTAL WALL CLOCK: {(track_s+score_s)/3600:.2f} h")
    print(f"  est. cache disk      : {disk_gb:.1f} GB")
    print(f"  NOTE: estimates come from the measured 50-session Fig 8 pass "
          f"(tmp/fig8m_all50.log); the tracker half is faster for fresh-anchor "
          f"methods (83s vs 228s per session) so tracking is an upper bound.")
    return 0


def main(a):
    t0 = time.time()
    sessions = discover_sessions()
    all_sessions = list(sessions)
    if a.sessions:
        want = [s.strip() for s in a.sessions.split(",") if s.strip()]
        unknown = [s for s in want if s not in sessions]
        if unknown:
            raise SystemExit(f"unknown session(s): {unknown}")
        sessions = want
    if a.max_sessions:
        sessions = sessions[:a.max_sessions]

    g3 = ([float(x) if "." in x else int(x) for x in a.grid_corr3d.split(",")]
          if a.grid_corr3d else CORR3D_GRID)
    g2 = ([float(x) if "." in x else int(x) for x in a.grid_corr2d.split(",")]
          if a.grid_corr2d else CORR2D_GRID)
    cells_grid = [(c2, c3) for c3 in g3 for c2 in g2]

    method = json.loads(a.method) if a.method else {}
    thresholds = json.loads(a.thresholds) if a.thresholds else {}
    clash = {"corr2dWeight", "corr3dWeight"} & set(thresholds)
    if clash:
        raise SystemExit(f"--thresholds must not set {sorted(clash)} -- those two ARE "
                         f"the swept axes; use --grid-corr2d/--grid-corr3d")
    base = base_params(method, thresholds)
    tag = tag_for(base, a.max_frames, len(sessions), len(sessions) == len(all_sessions))
    deposit = deposit_for(tag)
    root = TMP_ROOT / tag
    workers = a.workers or WORKERS

    if a.dry_run:
        return dry_run(cells_grid, sessions, tag, a.max_frames, workers)

    root.mkdir(parents=True, exist_ok=True)
    dirs = {(c2, c3): root / f"c2_{c2}_c3_{c3}" for (c2, c3) in cells_grid}
    print(f"[sweep50] {len(cells_grid)} cells x {len(sessions)} sessions = "
          f"{len(cells_grid)*len(sessions)} driver runs + as many scorings, "
          f"{workers} workers", flush=True)
    print(f"[sweep50] method={json.dumps(base['method'])} "
          f"base thresholds={json.dumps(base['thresholds'])} tag={tag}", flush=True)
    print(f"[sweep50] cache {root}\n[sweep50] deposit {deposit}", flush=True)

    jobs = [(c2, c3, s) for (c2, c3) in cells_grid for s in sessions]

    # --- phase 1: track ---
    run_status = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(run_one, str(dirs[(c2, c3)]),
                          cell_params(base, c2, c3), s, a.max_frames): (c2, c3, s)
                for (c2, c3, s) in jobs}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            run_status[key] = (status, info)
            done += 1
            if done % 10 == 0 or done == len(jobs):
                print(f"[sweep50] driver runs {done}/{len(jobs)} "
                      f"({time.time()-t0:.0f}s)", flush=True)
            if status != "ok":
                print(f"[sweep50] FAILED c2={key[0]} c3={key[1]} session={session}: "
                      f"{info}", flush=True)

    # --- phase 2: score ---
    score_status = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(score_one, str(dirs[(c2, c3)]), s, a.max_frames): (c2, c3, s)
                for (c2, c3, s) in jobs if run_status[(c2, c3, s)][0] == "ok"}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            score_status[key] = (status, info)
            done += 1
            if done % 10 == 0 or done == len(futs):
                print(f"[sweep50] scored {done}/{len(futs)} ({time.time()-t0:.0f}s)",
                      flush=True)
            if status != "ok":
                print(f"[sweep50] SCORE-FAILED c2={key[0]} c3={key[1]} "
                      f"session={session}: {info}", flush=True)

    # --- phase 3: aggregate, per cell AND per session ---
    import fig3_score as fs  # noqa: E402

    total_cf, cf_by_session = camera_frames(sessions, a.max_frames)
    print(f"[sweep50] total_camera_frames = {total_cf:,}", flush=True)

    cells_out = []
    for (c2, c3) in cells_grid:
        per, whyfail, ok_sessions = [], [], []
        for s in sessions:
            rst, rinfo = run_status[(c2, c3, s)]
            if rst != "ok":
                whyfail.append(f"{s}: driver failed: {rinfo}")
                continue
            sst, sinfo = score_status.get((c2, c3, s), ("failed", "not scored"))
            if sst != "ok":
                whyfail.append(f"{s}: scoring failed: {sinfo}")
                continue
            per.append(sinfo)
            ok_sessions.append(s)
        agg = fs.score_cell(per) if per else None
        cell = {
            "corr2d": c2, "corr3d": c3,
            "params": cell_params(base, c2, c3),
            "status": "ok" if agg else "failed",
            "why": (f"{len(whyfail)}/{len(sessions)} sessions failed: "
                    + "; ".join(whyfail)) if whyfail else "",
            # Per-session, not just the aggregate: a pooled mean over 50 sessions can
            # be carried by one bad session, and this repo has been burned by exactly
            # that. The per-session rows are what a "does it harm the clean sessions"
            # question is answered from.
            "per_session": [
                {"session": s,
                 "within_switches": i["within_switches"],
                 "cross_switches": i["cross_switches"],
                 "within_idf1": i["within_idf1"],
                 "cross_idf1": i["cross_idf1"],
                 # idp/idr were added to fig3_score.score_session() after this file
                 # was written; `.get` so an older scorer (or an older cached score)
                 # still aggregates instead of raising.
                 "within_idp": i.get("within_idp"), "within_idr": i.get("within_idr"),
                 "cross_idp": i.get("cross_idp"), "cross_idr": i.get("cross_idr"),
                 "per_camera_idf1": i["per_camera_idf1"],
                 "camera_frames": sum(cf_by_session[s].values())}
                for s, i in zip(ok_sessions, per)
            ],
        }
        cell.update(agg or {"idf1_within": None, "idf1_cross": None,
                            "switches": None, "n_sessions": 0})
        if cell["switches"] is not None and total_cf:
            cell["switches_per_100k_camera_frames"] = \
                cell["switches"] * 100_000 / total_cf
        cells_out.append(cell)
        print(f"[sweep50] cell corr2d={c2} corr3d={c3}: {cell['status']} "
              f"n={cell['n_sessions']} within={cell.get('idf1_within')} "
              f"cross={cell.get('idf1_cross')} switches={cell.get('switches')}",
              flush=True)

    out = {
        "generated_by": "figs/fig3_sweep50.py",
        "status": ("Fig 3e's corr2d x corr3d grid on ALL proofread BMimica sessions"
                   + (", on top of an EXPERIMENTAL tracker configuration"
                      if (base["method"] or base["thresholds"]) else
                      ", shipped tracker")),
        "dataset": "BMimica",
        "detection_pool": str(f3.DET),
        "sessions": sessions,
        "cameras": f3.CAMERAS,
        "num_animals": f3.NUM_ANIMALS,
        "grid_corr3d": g3,
        "grid_corr2d": g2,
        "base_method": base["method"],
        "base_thresholds": base["thresholds"],
        "cache_tag": tag,
        "cache_dir": str(root),
        "max_frames": a.max_frames,
        "driver": str(DRIVER),
        "experimental_tracker": str(REPO / "figs" / "fig6-bench" / "xv_experimental.js"),
        "metric": "IDF1 (motmetrics) + ID-switches",
        "total_camera_frames": total_cf,
        "camera_frames_by_session": cf_by_session,
        "seconds": round(time.time() - t0, 1),
        "caveats": [
            (f"SMOKE TEST / NOT A MEASUREMENT: every cell/session is capped at the "
             f"leading {a.max_frames} frames of a ~180k-frame session. This deposit "
             f"exists to prove the pipeline runs; do not read numbers off it."
             if a.max_frames else
             "Every cell/session is tracked and scored on the FULL session -- every "
             "frame, no window -- exactly as fig3_sweep.py and fig6_methods.py were."),
            (f"The corpus is all {len(sessions)} proofread BMimica sessions, NOT Fig "
             f"3e's eight. `switches` is a raw sum, so a switch count here is NOT "
             f"comparable to one in figs/out/fig3_sweep.json (8 sessions, 7,205,370 "
             f"camera-frames) -- compare the per-100k rates, or nothing."
             if len(sessions) == len(all_sessions) else
             f"SESSION SUBSET: {len(sessions)} of {len(all_sessions)} sessions. Not a "
             f"corpus-level measurement."),
            f3.CF_CAVEAT,
            "idf1_within is the mean of per-camera within-view IDF1 across all "
            "cameras and sessions; idf1_cross is IDF1 under one global identity per "
            "animal pooled over all cameras of a session; switches is the SUM of "
            "per-camera within-view ('2D') ID switches over all cameras and sessions "
            "in the cell. The corr3d=0 cell is the 'no 3D term at all' control.",
            "The driver is figs/fig6-bench/fig6_bench.mjs, which serves "
            "figs/fig6-bench/xv_experimental.js in place of "
            "pose/cross-view-tracker.js through an ESM loader hook. With an EMPTY "
            "method block it is byte-identical to the shipped tracker on all 8 full "
            "sessions (figs/out/fig8_methods_verify.json, SHA-256 of the "
            "identities+frames payload), which is what makes a shipped-tracker row "
            "here a measurement of the shipped tracker. No app source is modified.",
            "Cells are cached under a tag that digests the method+threshold block, "
            "the frame cap and any session restriction, because run_one() "
            "early-returns on an existing result JSON: without the tag a restart "
            "could hand a shipped-tracker result to an experimental cell.",
            "IDF1's cell-to-cell noise on Fig 3e's 8-session grid is about 0.05. "
            "Read per_session before reading a cell-to-cell ranking.",
        ],
        "cells": cells_out,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    deposit.write_text(json.dumps(out, indent=2))
    print(f"[sweep50] wrote {deposit} ({time.time()-t0:.0f}s total)", flush=True)
    return 0


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Fig 3e's corr2d x corr3d grid on all 50 proofread BMimica "
                    "sessions, optionally on top of an experimental tracker.")
    ap.add_argument("--method", default=None,
                    help='JSON method block for xv_experimental.js, e.g. '
                         '\'{"sync":true,"stale":10}\'. Default empty = shipped '
                         'tracker.')
    ap.add_argument("--thresholds", default=None,
                    help='JSON extra CrossViewTracker thresholds every cell sits on, '
                         'e.g. \'{"distanceThreshold":25}\'. May NOT contain '
                         'corr2dWeight/corr3dWeight -- those are the swept axes.')
    ap.add_argument("--grid-corr3d", default=None,
                    help=f"comma-separated corr3dWeight values (default {CORR3D_GRID})")
    ap.add_argument("--grid-corr2d", default=None,
                    help=f"comma-separated corr2dWeight values (default {CORR2D_GRID})")
    ap.add_argument("--sessions", default=None,
                    help="comma-separated session names instead of all 50 "
                         "(smoke-testing only; tags the deposit as a subset)")
    ap.add_argument("--max-sessions", type=int, default=None,
                    help="use only the first N discovered sessions (smoke-testing "
                         "only; tags the deposit as a subset)")
    ap.add_argument("--max-frames", type=int, default=None,
                    help="cap every session to its leading N frames. SMOKE TEST "
                         "ONLY -- routes to its own cache and deposit so a capped "
                         "run can never be mistaken for, or reused by, the "
                         "full-session measurement.")
    ap.add_argument("--workers", type=int, default=None,
                    help=f"pool size (default $FIG3_SWEEP50_WORKERS or 16; "
                         f"currently {WORKERS})")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the run counts, cached fraction, wall-clock estimate "
                         "and disk estimate for this grid, and exit")
    return ap.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main(_parse_args()))
