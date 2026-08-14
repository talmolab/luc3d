#!/usr/bin/env python
"""Fig 3's greedy-vs-exhaustive head-to-head (panels 3c/3d/3f), re-run with the
FRESH-ANCHOR tracker — and the two gates that make the re-run trustworthy.

THE QUESTION
------------
`figs/fig3_headtohead.py` and `figs/fig3_quality.py` compare the GREEDY production
tracker against the paper's EXHAUSTIVE hypothesis-testing method on identical
detections: per-frame partition agreement (3f's title), GT-grouping accuracy for both
arms (3d), and the reprojection-error cost gap on the frames where they disagree.

The greedy arm is driven by `figs/fig3-bench/fig3_bench.mjs`, which is the REAL
production tracker — so the fresh anchor (`{sync, stale 20}` + `distanceThreshold 25`,
at the shipped `corr3dWeight` 6) changes that arm. On BMimica that configuration cuts
ID switches 2,071 -> 413 and lifts cross-view IDF1 0.7493 -> 0.8613. If part of the
greedy/exhaustive disagreement is caused by the tracker fusing stale per-view
detections into its 3D anchor, agreement should rise. If agreement does not move, that
is equally informative: it locates the greedy/exhaustive gap in the GROUPING OBJECTIVE
rather than in the tracker's state. A null here is a result, not a failed run.

WHAT IS RE-RUN, AND WHAT IS RE-USED — AND WHY THAT IS TESTED, NOT ASSUMED
------------------------------------------------------------------------
Only the GREEDY arm is re-run. The exhaustive arm (`fig3_exhaustive.mjs`) is a pure
per-frame enumeration that never loads `pose/cross-view-tracker.js` at all, so it has
no tracker state and no anchor; its cached `exhaustive.json` is SYMLINKED into each
variant cell rather than recomputed. That saves the expensive half of the pass (the
cached exhaustive runs cost 97,693 s of CPU: 49,559 s on BMimica, 3,787 s on the 35
two-animal SLAP-2M sessions, 23,495 s at A=3 and 20,853 s at A=4).

Re-using a cache on the strength of an argument is how a figure goes stale, so
`--probe` TESTS the argument: it re-runs chosen exhaustive sessions with the
experimental tracker served over `pose/cross-view-tracker.js` (hooks8's redirect) AND
the method/threshold block forced onto `globalThis.__BENCH`, logs every module URL
loaded, and digest-compares the frames against the cached output. If any probe differs,
this script's `--run` refuses to proceed.

THE REPRODUCTION GATE
---------------------
`--gate` runs the SHIPPED configuration (empty method block, no threshold overrides)
through this new path — the Fig 8 driver + `xv_experimental.js` instead of
`fig3_bench.mjs` + the real module — and
  1. compares the SHA-256 of the tracker's identities+frames payload against the cached
     `greedy.json` fig3_headtohead.py produced, per session, over EVERY session of every
     configuration (92 of them; `fig8_methods.py --verify` only ever covered 8 BMimica
     sessions and no SLAP-2M ones), and
  2. rebuilds both deposits through the same aggregation code and diffs every field
     against `figs/out/fig3_headtohead.json` / `figs/out/fig3_quality.json`.
Nothing here is trustworthy without that gate: it is what makes a difference in the
fresh-anchor run attributable to the method rather than to the harness.

WHAT IS NEVER WRITTEN
---------------------
`figs/out/fig3_trackers.json`, `figs/out/fig3_headtohead.json`,
`figs/out/fig3_quality.json` and `figs/out/fig3_runtime.json` are manuscript deposits
(the last three are what the gate compares against). This script asserts it is not
writing them: the aggregation code in fig3_headtohead.py / fig3_quality.py writes those
NAMES, so their `OUT_DIR` is redirected into a per-tag sandbox and the result is MOVED
to `figs/out/fig3_headtohead__<tag>.json` / `fig3_quality__<tag>.json`, in the style of
`fig3_sweep50__distanceThreshold25-stale20-sync_*.json`.

Re-using their aggregation rather than reimplementing it is deliberate: `fig3_quality.py`
already imports `fig3_headtohead.py` "so the two deposits cannot drift", and a third
copy of the aggregation is a third thing to drift. The only monkeypatches are the cache
root (`hh.TMP_DIR`), the deposit root (`OUT_DIR`) and the driver job (which runs the
greedy arm through the Fig 8 driver with a `--params` block and symlinks the exhaustive
arm). Both modules are read, never edited; no app source is touched.

USAGE (motmetrics + h5py: use the bench interpreter)
----------------------------------------------------
    PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
    $PY figs/fig3_hh_freshanchor.py --dry-run
    $PY figs/fig3_hh_freshanchor.py --probe
    $PY figs/fig3_hh_freshanchor.py --gate                     # shipped, must reproduce
    $PY figs/fig3_hh_freshanchor.py --run                      # the fresh-anchor arm
    $PY figs/fig3_hh_freshanchor.py --divergence               # greedy shipped vs fresh
    $PY figs/fig3_hh_freshanchor.py --run --idf1 --only A2_C6_slap2m,A3_C5_slap2m,A4_C3_slap2m

`--jobs` defaults to 8 (a standing constraint on this machine: <= 8 parallel workers).
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))

#: The Fig 8 driver: fig3_bench.mjs's CLI and output shape, plus a `method` block, and
#: it registers hooks8.mjs so `pose/cross-view-tracker.js` is served from
#: figs/fig8-bench/xv_experimental.js. With an EMPTY method block it reproduces the
#: shipped tracker bit for bit -- which is what --gate re-proves here, on 92 sessions.
DRIVER = REPO / "figs" / "fig8-bench" / "fig8_bench.mjs"
EXPERIMENTAL = REPO / "figs" / "fig8-bench" / "xv_experimental.js"
PROBE_DRIVER = REPO / "figs" / "fig3-bench" / "fig3_exhaustive_probe.mjs"

VAR_ROOT = OUT_DIR / "tmp" / "headtohead_var"

#: The fresh anchor, exactly as Fig 3g / Fig 7's variant / Fig 8's winner state it.
#: corr3dWeight stays at the shipped 6: corr3dWeight 12 is settled as not worth it
#: (moves 11 of 50 sessions, harms two badly, +0.0001 mean IDF1) -- FIX-PLAN-8-13 item 8.
FRESH_METHOD = {"sync": True, "stale": 20}
FRESH_THRESHOLDS = {"distanceThreshold": 25}

#: Deposits this script must never write. Asserted, not merely intended.
FORBIDDEN = {(OUT_DIR / n).resolve() for n in (
    "fig3_trackers.json", "fig3_headtohead.json", "fig3_quality.json",
    "fig3_runtime.json", "fig3_sweep.json", "fig3_scale.json")}


def tag_for(method, thresholds):
    """Cache/deposit tag. `shipped` is the empty case (the gate); anything else carries
    a readable slug PLUS a digest of the canonical block, so two configurations cannot
    collide after the slug is truncated -- the same construction fig3_sweep50.py uses,
    and for the same reason: the greedy arm is cached and served from disk, so a tag
    collision is the one way this script could hand a shipped result to a fresh-anchor
    cell."""
    if not method and not thresholds:
        return "shipped"
    items = sorted(list(method.items()) + list(thresholds.items()))
    slug = "-".join(f"{k}" if v is True else f"no{k}" if v is False else f"{k}{v}"
                    for k, v in items)
    digest = hashlib.sha256(json.dumps({"method": method, "thresholds": thresholds},
                                       sort_keys=True).encode()).hexdigest()
    return f"{slug[:48]}_{digest[:8]}"


def params_for(method, thresholds):
    return {"method": dict(method or {}), "thresholds": dict(thresholds or {})}


def payload_digest(path):
    """SHA-256 of the tracker's OUTPUT only: the `identities` + `frames` block.

    Imported semantics, not a new definition -- this is byte-for-byte
    fig8_param_sweeps.payload_digest(), which excludes the echoed `params` (different
    by construction between the two drivers) and the wall-clock `runtimeSeconds`/`fps`.
    Re-implemented here rather than imported because fig8_param_sweeps imports
    fig3_sweep at module scope, which reads the 8-session corpus off disk.
    """
    b = Path(path).read_bytes()
    i = b.find(b'"identities":')
    j = b.find(b',"framesProcessed"', i)
    if i < 0 or j < 0:
        return None
    return hashlib.sha256(b[i:j]).hexdigest()


# --------------------------------------------------------------------------- #
# The patched driver job: greedy through the Fig 8 driver, exhaustive symlinked #
# --------------------------------------------------------------------------- #

def make_driver_job(params, root, shipped_tmp, force=False):
    """Build the replacement for `fig3_headtohead.driver_job`.

    Same signature and same return shape `(key, session, errs)`, so
    fig3_headtohead.main()'s phase 1 drives it unchanged. Two differences:

      * the GREEDY arm runs through `fig8_bench.mjs` with a `--params` block, and its
        cache is validated against a sidecar that records the params digest -- an
        existing `greedy.json` from a DIFFERENT configuration must never be served
        (the failure mode fig3_sweep50.py's cache tag exists to prevent);
      * the EXHAUSTIVE arm is not run. The cached shipped `exhaustive.json` is
        symlinked in, which `--probe` justifies empirically. A symlink rather than a
        copy so the 2.7 GB cache is not duplicated AND so it is self-evident in `ls`
        that the file is the shipped one.
    """
    pd_want = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()

    def driver_job(cfg, sess):
        key, s = cfg["key"], sess["session"]
        d = root / key / s
        d.mkdir(parents=True, exist_ok=True)
        errs = []

        # --- exhaustive: symlink, never recompute ---
        src = (shipped_tmp / key / s / "exhaustive.json").resolve()
        dst = d / "exhaustive.json"
        if not src.exists():
            errs.append(f"exhaustive: no cached shipped output at {src}")
        elif dst.is_symlink():
            if Path(os.readlink(dst)) != src:
                dst.unlink()
                os.symlink(src, dst)
        elif dst.exists():
            errs.append(f"exhaustive: {dst} is a real file, not the expected symlink "
                        f"to the shipped cache -- refusing to guess what it is")
        else:
            os.symlink(src, dst)
        if errs:
            return key, s, errs

        # --- greedy: re-run through the Fig 8 driver ---
        out = d / "greedy.json"
        meta = d / "greedy.meta.json"
        if not force and out.exists() and out.stat().st_size > 1000 and meta.exists():
            try:
                m = json.loads(meta.read_text())
                if (m.get("params_digest") == pd_want
                        and list(m.get("cameras", [])) == list(cfg["cameras"])
                        and m.get("num_animals") == cfg["animals"]
                        and m.get("max_frames") == sess["max_frames"]):
                    return key, s, []
            except Exception:  # noqa: BLE001
                pass

        params_path = d / "params.json"
        params_path.write_text(json.dumps(params, sort_keys=True))
        cmd = ["node", str(DRIVER),
               "--session-idx", str(sess["det_session_idx"]),
               "--num-animals", str(cfg["animals"]),
               "--calibration", str(sess["calibration"]),
               "--pred-h5-dir", sess["det_dir"],
               "--cameras", ",".join(cfg["cameras"]),
               "--params", str(params_path),
               "--out", str(out)]
        if sess["max_frames"]:
            cmd += ["--max-frames", str(sess["max_frames"])]
        t0 = time.time()
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
        except subprocess.TimeoutExpired:
            return key, s, ["greedy: timed out after 10800s"]
        if r.returncode != 0 or not out.exists():
            return key, s, [f"greedy: exit {r.returncode}: "
                            + r.stderr[-800:].replace("\n", " ")]
        try:
            payload = json.loads(out.read_text())
            fp = payload.get("framesProcessed")
            rt = payload.get("runtimeSeconds")
        except Exception as e:  # noqa: BLE001
            return key, s, [f"greedy: unreadable output: {e}"]
        meta.write_text(json.dumps({
            "params_digest": pd_want, "params": params,
            "cameras": cfg["cameras"], "num_animals": cfg["animals"],
            "max_frames": sess["max_frames"],
            "framesProcessed": fp, "runtimeSeconds": rt,
            "seconds_per_frame_greedy_contended": (rt / fp) if fp else None,
            "wall_seconds": round(time.time() - t0, 2),
            "driver": str(DRIVER), "experimental_tracker": str(EXPERIMENTAL),
        }, indent=2))
        return key, s, []

    return driver_job


# --------------------------------------------------------------------------- #
# Pipeline: reuse fig3_headtohead.main() / fig3_quality.main() verbatim         #
# --------------------------------------------------------------------------- #

def run_pipeline(tag, params, jobs, only, idf1, force_greedy, quality=True):
    """Produce `fig3_headtohead__<tag>.json` and `fig3_quality__<tag>.json`.

    The two deposits are built by the ORIGINAL aggregation code with three module
    globals redirected (cache root, deposit root, driver job). `OUT_DIR` is pointed at
    a sandbox so the hardcoded `fig3_headtohead.json` / `fig3_quality.json` filenames
    cannot land in figs/out/; the files are then MOVED to their tagged names, and the
    move refuses any name in FORBIDDEN.
    """
    root = VAR_ROOT / tag
    sandbox = root / "_deposit"
    root.mkdir(parents=True, exist_ok=True)
    sandbox.mkdir(parents=True, exist_ok=True)

    os.environ["HH_JOBS"] = str(jobs)
    if only:
        os.environ["HH_ONLY"] = only
    if idf1:
        os.environ.pop("HH_SKIP_IDF1", None)
    else:
        os.environ["HH_SKIP_IDF1"] = "1"

    import fig3_headtohead as hh
    shipped_tmp = hh.TMP_DIR                     # capture BEFORE redirecting
    hh.JOBS = jobs
    hh.TMP_DIR = root
    hh.OUT_DIR = sandbox
    hh.driver_job = make_driver_job(params, root, shipped_tmp, force=force_greedy)

    print(f"\n=== [{tag}] head-to-head: greedy re-run + agreement "
          f"(idf1={'on' if idf1 else 'OFF'}) ===", flush=True)
    hh.main()
    dep_hh = move_deposit(sandbox / "fig3_headtohead.json",
                          OUT_DIR / f"fig3_headtohead__{tag}.json")

    dep_q = None
    if quality:
        import fig3_quality as q
        q.JOBS = jobs
        q.OUT_DIR = sandbox
        print(f"\n=== [{tag}] quality: GT grouping accuracy + cost gap ===", flush=True)
        q.main()
        dep_q = move_deposit(sandbox / "fig3_quality.json",
                             OUT_DIR / f"fig3_quality__{tag}.json")

    for dep in (dep_hh, dep_q):
        if dep is None:
            continue
        d = json.loads(dep.read_text())
        d["variant"] = {
            "tag": tag,
            "method": params["method"],
            "thresholds": params["thresholds"],
            "corr3dWeight": "shipped default 6 (NOT 12 -- see FIX-PLAN-8-13 item 8)",
            "driver": str(DRIVER),
            "experimental_tracker": str(EXPERIMENTAL),
            "greedy_arm": "re-run through fig8_bench.mjs + xv_experimental.js",
            "exhaustive_arm": ("SYMLINKED from the shipped cache "
                               f"({shipped_tmp}) -- unchanged, and verified "
                               "anchor-independent by --probe"),
            "idf1_scored": bool(idf1),
            "written_by": "figs/fig3_hh_freshanchor.py",
            "notes": [
                "EXPLORATORY / VARIANT. The manuscript panels 3c/3d/3f describe the "
                "SHIPPED tracker and are built from figs/out/fig3_headtohead.json and "
                "figs/out/fig3_quality.json, which this file does not touch.",
                "Only the GREEDY arm differs from the shipped deposit. The exhaustive "
                "arm is the same bytes, so every exhaustive number here is identical to "
                "the shipped deposit's by construction.",
                ("IDF1/switches are NOT scored in this pass (HH_SKIP_IDF1): no Fig 3 "
                 "panel plots them, the deposit's own caveats call the exhaustive arm's "
                 "IDF1 an artefact of the added identity threading, and scoring 50 "
                 "BMimica sessions x 2 arms costs ~1.7 h at 8 workers. The fresh "
                 "anchor's BMimica IDF1 on this same 50-session corpus is in "
                 "figs/out/fig8_methods_50.json (cell sync_stale20_dist25)."
                 if not idf1 else
                 "IDF1/switches ARE scored in this pass. The exhaustive arm's IDF1 "
                 "must equal the shipped deposit's exactly (same exhaustive.json); "
                 "that equality is itself a check on the harness."),
            ],
        }
        dep.write_text(json.dumps(d, indent=2))
        print(f"[{tag}] wrote {dep}", flush=True)
    return dep_hh, dep_q


def move_deposit(src, dest):
    if not src.exists():
        raise SystemExit(f"expected {src} -- the aggregation did not write it")
    if dest.resolve() in FORBIDDEN:
        raise SystemExit(f"refusing to write {dest}: manuscript deposit")
    shutil.move(str(src), str(dest))
    return dest


# --------------------------------------------------------------------------- #
# Gate 1: payload digests, shipped config, every session                       #
# --------------------------------------------------------------------------- #

def digest_gate(tag, jobs, only):
    """Per-session SHA-256 of the identities+frames payload, mine vs the shipped cache."""
    import fig3_headtohead as hh
    root = VAR_ROOT / tag
    rows, ok = [], True
    keys = set(x for x in (only or "").split(",") if x)
    for cfg in hh.CONFIGS:
        if cfg.get("intractable") or (keys and cfg["key"] not in keys):
            continue
        sess_list, _ = hh.sessions_for(cfg)
        for s in sess_list:
            mine = root / cfg["key"] / s["session"] / "greedy.json"
            theirs = hh.TMP_DIR / cfg["key"] / s["session"] / "greedy.json"
            a = payload_digest(mine) if mine.exists() else None
            b = payload_digest(theirs) if theirs.exists() else None
            same = a is not None and a == b
            ok = ok and same
            rows.append({"config": cfg["key"], "session": s["session"],
                         "new_path_digest": a, "shipped_cache_digest": b,
                         "identical": bool(same)})
    n_same = sum(1 for r in rows if r["identical"])
    print(f"\n[gate] payload digests: {n_same}/{len(rows)} identical", flush=True)
    for r in rows:
        if not r["identical"]:
            print(f"  DIFFERS {r['config']}/{r['session']}: "
                  f"new={str(r['new_path_digest'])[:16]} "
                  f"shipped={str(r['shipped_cache_digest'])[:16]}", flush=True)
    return ok, rows


# --------------------------------------------------------------------------- #
# Gate 2: deposit diff                                                        #
# --------------------------------------------------------------------------- #

#: Fields excluded from the deposit diff, each for a stated reason. Wall-clock only,
#: plus the two IDF1 blocks when the pass did not score them.
_WALL = {"seconds_per_frame_greedy", "frames_processed_greedy_seconds", "seconds",
         "runtime_seconds_greedy", "generated_by", "variant", "detection_pool"}


def _walk(obj, path, out, skip):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in skip:
                continue
            _walk(v, f"{path}.{k}", out, skip)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _walk(v, f"{path}[{i}]", out, skip)
    else:
        out[path] = obj


def deposit_diff(mine_path, theirs_path, skip=()):
    """Flatten both deposits and report every leaf that differs.

    A whole-file diff, not a hand-picked field list: the point of the gate is to catch
    the field nobody thought to check. `skip` names wall-clock and provenance keys
    (see _WALL) and, when IDF1 was not scored, the `scores`/`greedy`/`exhaustive`
    blocks that are null by construction.
    """
    skip = set(_WALL) | set(skip)
    a, b = {}, {}
    _walk(json.loads(Path(mine_path).read_text()), "", a, skip)
    _walk(json.loads(Path(theirs_path).read_text()), "", b, skip)
    only_mine = sorted(set(a) - set(b))
    only_theirs = sorted(set(b) - set(a))
    differ = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    return {"n_leaves_compared": len(set(a) & set(b)),
            "n_differ": len(differ),
            "differ": [{"path": k, "new": a[k], "shipped": b[k]} for k in differ[:60]],
            "only_in_new": only_mine[:60], "only_in_shipped": only_theirs[:60],
            "n_only_in_new": len(only_mine), "n_only_in_shipped": len(only_theirs)}


# --------------------------------------------------------------------------- #
# The exhaustive-independence probe                                           #
# --------------------------------------------------------------------------- #

def frames_digest(path):
    """Digest of an exhaustive.json's DECISIONS: the frames array + the frame counts.

    Not the whole file: `runtimeSeconds`/`scanSeconds`/`enumerationSeconds` and the
    two derived per-frame rates are wall-clock and change between any two runs.
    Everything that is a decision -- which detections were grouped together, the
    winning total reprojection error, and how many frames were considered/clean/
    computed -- is in here.
    """
    d = json.loads(Path(path).read_text())
    core = {k: d[k] for k in ("numAnimals", "cameras", "hypothesesPerFrame", "capped",
                              "framesConsidered", "framesClean", "framesComputed",
                              "cleanSample", "cleanSampleStride", "frames")}
    return hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()


def probe(which, jobs):
    """Re-run chosen exhaustive sessions with the experimental tracker + method live."""
    import fig3_headtohead as hh
    root = VAR_ROOT / "_probe"
    root.mkdir(parents=True, exist_ok=True)
    plan = []
    for cfg in hh.CONFIGS:
        if cfg.get("intractable"):
            continue
        sess_list, _ = hh.sessions_for(cfg)
        by_name = {s["session"]: s for s in sess_list}
        for key, sname in which:
            if key == cfg["key"] and sname in by_name:
                plan.append((cfg, by_name[sname]))
    if len(plan) != len(which):
        raise SystemExit(f"probe: resolved {len(plan)} of {len(which)} requested "
                         f"(config, session) pairs")

    rows = []
    for cfg, sess in plan:
        s = sess["session"]
        cell = root / cfg["key"] / s
        cell.mkdir(parents=True, exist_ok=True)
        out = cell / "exhaustive.json"
        log = cell / "loaded_modules.txt"
        cached = hh.TMP_DIR / cfg["key"] / s / "exhaustive.json"
        if not cached.exists():
            rows.append({"config": cfg["key"], "session": s, "status": "failed",
                         "why": f"no cached shipped exhaustive.json at {cached}"})
            continue
        if not out.exists():
            if log.exists():
                log.unlink()
            cmd = ["node", str(PROBE_DRIVER),
                   "--session-idx", str(sess["det_session_idx"]),
                   "--num-animals", str(cfg["animals"]),
                   "--calibration", str(sess["calibration"]),
                   "--pred-h5-dir", sess["det_dir"],
                   "--cameras", ",".join(cfg["cameras"]),
                   "--out", str(out),
                   "--max-hypotheses", str(hh.MAX_HYPOTHESES)]
            if cfg["clean_sample"]:
                cmd += ["--clean-sample", str(cfg["clean_sample"])]
            if sess["max_frames"]:
                cmd += ["--max-frames", str(sess["max_frames"])]
            env = dict(os.environ)
            env["PROBE_METHOD"] = json.dumps(FRESH_METHOD)
            env["PROBE_THRESHOLDS"] = json.dumps(FRESH_THRESHOLDS)
            env["PROBE_LOADLOG"] = str(log)
            print(f"[probe] {cfg['key']}/{s}: running exhaustive under the "
                  f"experimental hook...", flush=True)
            t0 = time.time()
            r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                               timeout=86400)
            if r.returncode != 0:
                rows.append({"config": cfg["key"], "session": s, "status": "failed",
                             "why": f"exit {r.returncode}: {r.stderr[-600:]}"})
                continue
            print(f"[probe] {cfg['key']}/{s}: {time.time()-t0:.0f}s", flush=True)
        mods = [ln.strip() for ln in log.read_text().splitlines()] if log.exists() else []
        a, b = frames_digest(out), frames_digest(cached)
        rows.append({
            "config": cfg["key"], "session": s,
            "status": "ok",
            "probe_digest": a, "cached_digest": b, "identical": a == b,
            "cross_view_tracker_loaded": any("cross-view-tracker" in m for m in mods),
            "pose_modules_loaded": sorted({m.split("/pose/")[-1] for m in mods
                                           if "/pose/" in m}),
            "n_module_urls_logged": len(mods),
        })
        print(f"[probe] {cfg['key']}/{s}: "
              f"{'IDENTICAL' if a == b else 'DIFFERS'}; pose modules "
              f"{rows[-1]['pose_modules_loaded']}", flush=True)
    ok = all(r.get("identical") for r in rows) and bool(rows)
    dest = OUT_DIR / "fig3_hh_exhaustive_probe.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig3_hh_freshanchor.py --probe",
        "claim": ("figs/fig3-bench/fig3_exhaustive.mjs is independent of the tracker "
                  "and therefore of the tracker's 3D anchor, so the cached "
                  "exhaustive.json files stay valid when only the greedy arm is "
                  "re-run with the fresh-anchor configuration."),
        "how": ("each session below was re-run through "
                "figs/fig3-bench/fig3_exhaustive_probe.mjs, which registers hooks8's "
                "redirect of pose/cross-view-tracker.js to "
                "figs/fig8-bench/xv_experimental.js and FORCES "
                f"method={json.dumps(FRESH_METHOD)} / "
                f"thresholds={json.dumps(FRESH_THRESHOLDS)} onto globalThis.__BENCH "
                "(the driver assigns __BENCH itself, so the probe installs an accessor "
                "that merges the block back in -- a probe that was silently disarmed "
                "would pass regardless). The digest covers the frames array, the "
                "winning per-frame reprojection errors and the considered/clean/"
                "computed counts; wall-clock fields are excluded."),
        "method": FRESH_METHOD, "thresholds": FRESH_THRESHOLDS,
        "all_identical": bool(ok), "sessions": rows,
    }, indent=2))
    print(f"\n[probe] all_identical={ok} -> {dest}", flush=True)
    return 0 if ok else 1


# --------------------------------------------------------------------------- #
# Did the method actually change the tracker? greedy shipped vs greedy fresh    #
# --------------------------------------------------------------------------- #

def _divergence_job(args):
    """Per-session greedy-vs-greedy comparison. Runs in a worker process."""
    key, sess, mine_path, theirs_path = args
    import fig3_headtohead as hh
    try:
        a = json.loads(Path(mine_path).read_text())
        b = json.loads(Path(theirs_path).read_text())
    except Exception as e:  # noqa: BLE001
        return {"config": key, "session": sess, "status": "failed", "why": str(e)}
    bf = {f["frame"]: f for f in b["frames"]}
    n_common = n_part_differ = n_label_differ = 0
    n_only_new = 0
    for fa in a["frames"]:
        fb = bf.get(fa["frame"])
        if fb is None:
            n_only_new += 1
            continue
        n_common += 1
        keys = set(k for k, _ in fa["assignments"]) & set(k for k, _ in fb["assignments"])
        pa = hh.partition_of(fa, keys_filter=keys)
        pb = hh.partition_of(fb, keys_filter=keys)
        if pa != pb:
            n_part_differ += 1
        ma = {k: v for k, v in fa["assignments"] if k in keys}
        mb = {k: v for k, v in fb["assignments"] if k in keys}
        if ma != mb:
            n_label_differ += 1
    return {"config": key, "session": sess, "status": "ok",
            "frames_new": len(a["frames"]), "frames_shipped": len(b["frames"]),
            "frames_common": n_common, "frames_only_in_new": n_only_new,
            "frames_partition_differs": n_part_differ,
            "frames_identity_label_differs": n_label_differ,
            "framesProcessed_new": a.get("framesProcessed"),
            "framesProcessed_shipped": b.get("framesProcessed"),
            "runtime_new": a.get("runtimeSeconds"),
            "runtime_shipped": b.get("runtimeSeconds")}


def divergence(tag, jobs, only):
    """Quantify how much the fresh anchor changed the greedy tracker's own output.

    The internal control for the whole comparison. If agreement with exhaustive does
    not move, there are two explanations -- the method changed nothing the exhaustive
    comparison can see, or the method never took effect -- and only this distinguishes
    them. It is the same label-invariant partition machinery
    (`fig3_headtohead.partition_of`) applied greedy-against-greedy instead of
    greedy-against-exhaustive, plus a strict per-key identity comparison.
    """
    import fig3_headtohead as hh
    root = VAR_ROOT / tag
    keys = set(x for x in (only or "").split(",") if x)
    jobs_list = []
    for cfg in hh.CONFIGS:
        if cfg.get("intractable") or (keys and cfg["key"] not in keys):
            continue
        sess_list, _ = hh.sessions_for(cfg)
        for s in sess_list:
            mine = root / cfg["key"] / s["session"] / "greedy.json"
            theirs = hh.TMP_DIR / cfg["key"] / s["session"] / "greedy.json"
            if mine.exists() and theirs.exists():
                jobs_list.append((cfg["key"], s["session"], str(mine), str(theirs)))
    print(f"[divergence] {len(jobs_list)} sessions, {jobs}-wide", flush=True)
    rows = []
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(_divergence_job, j) for j in jobs_list]
        for f in as_completed(futs):
            r = f.result()
            rows.append(r)
            print(f"  {r['config']}/{r['session']}: "
                  f"{r.get('frames_partition_differs')}/{r.get('frames_common')} frames "
                  f"differ in partition, {r.get('frames_identity_label_differs')} in "
                  f"labels", flush=True)
    by_cfg = {}
    for r in rows:
        if r.get("status") != "ok":
            continue
        c = by_cfg.setdefault(r["config"], {"n_sessions": 0, "frames_common": 0,
                                            "frames_partition_differs": 0,
                                            "frames_identity_label_differs": 0})
        c["n_sessions"] += 1
        for k in ("frames_common", "frames_partition_differs",
                  "frames_identity_label_differs"):
            c[k] += r[k]
    for k, c in by_cfg.items():
        c["partition_differ_rate"] = (c["frames_partition_differs"]
                                      / c["frames_common"] if c["frames_common"] else None)
        c["label_differ_rate"] = (c["frames_identity_label_differs"]
                                  / c["frames_common"] if c["frames_common"] else None)
    dest = OUT_DIR / f"fig3_hh_divergence__{tag}.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig3_hh_freshanchor.py --divergence",
        "what": ("how much the fresh-anchor greedy tracker's OWN per-frame output "
                 "differs from the shipped greedy tracker's, over the frames both "
                 "produced. `frames_partition_differs` is label-invariant (the grouping "
                 "changed); `frames_identity_label_differs` also counts frames where "
                 "only the identity NUMBERING changed, which is the larger number "
                 "because a single swap renames one target for the rest of the session."),
        "tag": tag, "method": FRESH_METHOD, "thresholds": FRESH_THRESHOLDS,
        "by_config": by_cfg,
        "per_session": sorted(rows, key=lambda r: (r["config"], r["session"])),
    }, indent=2))
    print(f"[divergence] -> {dest}", flush=True)
    for k, c in by_cfg.items():
        print(f"  {k}: partition differs on {c['frames_partition_differs']:,}/"
              f"{c['frames_common']:,} ({(c['partition_differ_rate'] or 0):.4%}), "
              f"labels on {c['frames_identity_label_differs']:,}", flush=True)
    return 0


# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# 3f's time axis: LUC3D seconds/frame, both arms, measured the same way         #
# --------------------------------------------------------------------------- #

#: Which session each head-to-head configuration is TIMED on. Chosen to match
#: `fig3_runtime.json`'s own sessions (`fig3_scale_runtime.py`: BMimica
#: 20250827_141755; SLAP-2M master rows 6 / 67 / 70 for A=2 / 3 / 4) so a fresh-anchor
#: rate can be put beside the deposited shipped rate without changing the session as
#: well as the tracker. All four are in their config's session list.
RUNTIME_SESSION = {
    "A2_C5_bmimica": "20250827_141755",
    "A2_C6_slap2m": "10072022131531",
    "A3_C5_slap2m": "10072022142111",
    "A4_C3_slap2m": "10072022145420",
    # The 4x6 configuration IS timed even though its exhaustive arm is intractable:
    # 3f plots a LUC3D point there (the tracker runs fine at 24^6 -- it is the
    # ENUMERATION that cannot), and without this cell a variant 3f would have to fall
    # back to the shipped rate for its largest configuration.
    "A4_C6_slap2m_hard": "10072022145420",
}
#: fig3_scale_runtime.py's window, unchanged: 3,000 leading frames, and
#: seconds_per_frame = the driver's own `runtimeSeconds` (runCrossViewTracker's wall
#: clock, excluding H5 load/slice) / framesProcessed.
RUNTIME_FRAMES = 3000
RUNTIME_REPEATS = 3


def runtime(jobs):
    """Time BOTH arms on the same sessions, same window, same driver, SERIALLY.

    3f plots seconds/frame, and the fresh anchor changes the tracker's inner loop
    (`stale` evicts per-view detections; `sync` freezes the 3D state for a frame), so
    the LUC3D series is not automatically transferable. It cannot be taken from the
    head-to-head runs either: those execute 7-8 wide and their wall clock is contended.
    So this measures both arms here, one process at a time, alternating arms within each
    repeat so a drift in machine load hits both equally, and reports the MINIMUM over
    repeats (the least-contended sample) alongside every sample.
    """
    import fig3_headtohead as hh
    root = VAR_ROOT / "_runtime"
    root.mkdir(parents=True, exist_ok=True)
    arms = [("shipped", params_for({}, {})),
            ("fresh_anchor", params_for(FRESH_METHOD, FRESH_THRESHOLDS))]
    rows = []
    for cfg in hh.CONFIGS:
        want = RUNTIME_SESSION.get(cfg["key"])
        if want is None:
            continue
        sess_list, _ = hh.sessions_for(cfg)
        sess = next((s for s in sess_list if s["session"] == want), None)
        if sess is None:
            raise SystemExit(f"runtime: session {want} not in {cfg['key']}")
        samples = {name: [] for name, _ in arms}
        for rep in range(RUNTIME_REPEATS):
            for name, params in arms:
                d = root / cfg["key"] / f"{name}_rep{rep}"
                d.mkdir(parents=True, exist_ok=True)
                (d / "params.json").write_text(json.dumps(params, sort_keys=True))
                out = d / "result.json"
                cmd = ["node", str(DRIVER),
                       "--session-idx", str(sess["det_session_idx"]),
                       "--num-animals", str(cfg["animals"]),
                       "--calibration", str(sess["calibration"]),
                       "--pred-h5-dir", sess["det_dir"],
                       "--cameras", ",".join(cfg["cameras"]),
                       "--params", str(d / "params.json"),
                       "--max-frames", str(RUNTIME_FRAMES),
                       "--out", str(out)]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                if r.returncode != 0:
                    raise SystemExit(f"runtime: {cfg['key']}/{name}: exit {r.returncode}"
                                     f": {r.stderr[-400:]}")
                res = json.loads(out.read_text())
                spf = res["runtimeSeconds"] / max(1, res["framesProcessed"])
                samples[name].append(spf)
                print(f"  {cfg['key']:<16} {name:<12} rep{rep}: {spf*1000:.4f} ms/frame "
                      f"over {res['framesProcessed']} frames", flush=True)
        rows.append({
            "config": cfg["key"], "animals": cfg["animals"],
            "cameras": len(cfg["cameras"]), "camera_names": cfg["cameras"],
            "dataset": cfg["dataset"], "session": want,
            "frames": RUNTIME_FRAMES,
            "seconds_per_frame_shipped": min(samples["shipped"]),
            "seconds_per_frame_fresh_anchor": min(samples["fresh_anchor"]),
            "samples": samples,
            "ratio_fresh_over_shipped": (min(samples["fresh_anchor"])
                                         / min(samples["shipped"])),
        })
    dest = OUT_DIR / "fig3_hh_runtime.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig3_hh_freshanchor.py --runtime",
        "what": ("runCrossViewTracker seconds/frame for the SHIPPED and the FRESH-ANCHOR "
                 "configurations, on the four head-to-head configurations, measured the "
                 "way figs/fig3_scale_runtime.py measures it (3,000 leading frames, the "
                 "driver's own runtimeSeconds / framesProcessed, H5 IO excluded)."),
        "why": ("figs/out/fig3_runtime.json -- which Fig 3f's LUC3D series is drawn from "
                "-- times the SHIPPED tracker only, and the head-to-head runs cannot "
                "supply a substitute because they run 7-8 wide and their wall clock is "
                "contended. Both arms are therefore re-timed here, serially, "
                "alternating arms inside each repeat."),
        "caveats": [
            f"{RUNTIME_REPEATS} repeats per cell, run serially and alternating arms; "
            "the reported figure is the MINIMUM (least contended) and every sample is "
            "kept in `samples`.",
            "The A4_C3 camera list is back/mid/top (the head-to-head config's own "
            "cameras). fig3_runtime.json's (4 animals, 3 cameras) row is a PROGRESSIVE "
            "SUBSET, back/backL/mid, so it is the same C on different cameras -- a "
            "pre-existing mismatch in Fig 3f, not one introduced here.",
            "seconds_per_frame_shipped here is a re-measurement through fig8_bench.mjs "
            "+ xv_experimental.js with an empty method block, NOT the deposited "
            "fig3_runtime.json value; comparing the two is a check on the harness, and "
            "the shipped/fresh RATIO is the quantity this file exists to supply.",
        ],
        "method": FRESH_METHOD, "thresholds": FRESH_THRESHOLDS,
        "runtime_frames": RUNTIME_FRAMES, "repeats": RUNTIME_REPEATS,
        "cells": rows,
    }, indent=2))
    print(f"[runtime] -> {dest}", flush=True)
    for r in rows:
        print(f"  {r['config']:<16} shipped {r['seconds_per_frame_shipped']*1000:.4f} "
              f"ms/frame  fresh {r['seconds_per_frame_fresh_anchor']*1000:.4f}  "
              f"ratio {r['ratio_fresh_over_shipped']:.3f}", flush=True)
    return 0


def dry_run(jobs):
    """The bill, before it is incurred, from the measured shipped pass."""
    import fig3_headtohead as hh
    dep = json.loads((OUT_DIR / "fig3_headtohead.json").read_text())
    print("[dry-run] fresh-anchor Fig 3 head-to-head\n")
    print(f"  method     : {json.dumps(FRESH_METHOD)}")
    print(f"  thresholds : {json.dumps(FRESH_THRESHOLDS)} "
          f"(corr3dWeight stays at the shipped 6)")
    print(f"  workers    : {jobs}\n")
    tot_g = tot_e = 0
    n_sess = 0
    for c in dep["configs"]:
        if c["status"] != "ok":
            print(f"  {c['key']:<20} {c['status']}")
            continue
        ps = c["per_session"]
        gs = sum((r["seconds_per_frame_greedy"] or 0) * (r["frames_processed_greedy"] or 0)
                 for r in ps)
        es = sum(r["runtime_seconds_exhaustive"] for r in ps)
        tot_g += gs
        tot_e += es
        n_sess += len(ps)
        print(f"  {c['key']:<20} {len(ps):>3} sessions   greedy {gs/3600:6.2f} h CPU   "
              f"exhaustive {es/3600:6.2f} h CPU (RE-USED)")
    print(f"\n  greedy CPU to re-run  : {tot_g/3600:.2f} h over {n_sess} sessions "
          f"=> ~{tot_g/3600/jobs:.2f} h wall at {jobs} workers")
    print(f"  exhaustive CPU avoided: {tot_e/3600:.2f} h "
          f"(~{tot_e/3600/jobs:.2f} h wall) -- symlinked, verified by --probe")
    print(f"  the same greedy pass runs TWICE: once for --gate (shipped config) and "
          f"once for --run (fresh anchor)")
    print(f"  agreement + GT-quality recompute: ~1.5 ms per clean frame per session, "
          f"{sum(c.get('frames_computed', 0) for c in dep['configs']):,} clean frames "
          f"=> ~{sum(c.get('frames_computed', 0) for c in dep['configs'])*1.5e-3/3600/jobs:.2f} h "
          f"wall per pass at {jobs} workers")
    print(f"  IDF1 scoring is OFF by default: ~500 s per BMimica session per arm "
          f"(~1.7 h wall at {jobs}) for numbers no Fig 3 panel plots")
    print(f"\n  probe (exhaustive independence), suggested sessions:")
    for k, s, secs in _probe_plan_with_cost(dep):
        print(f"    {k:<20} {s}  ~{secs/60:.0f} min (1 worker)")
    return 0


def _probe_plan_with_cost(dep):
    """Cheapest session of each A=2 config plus the cheapest A=3 one, with its cost."""
    out = []
    want = {"A2_C5_bmimica": 1, "A2_C6_slap2m": 2, "A3_C5_slap2m": 1}
    for c in dep["configs"]:
        n = want.get(c["key"], 0)
        if not n or c["status"] != "ok":
            continue
        ps = sorted(c["per_session"], key=lambda r: r["frames_computed"])
        picks = ps[:1] + (ps[-1:] if n > 1 else [])
        for r in picks:
            out.append((c["key"], r["session"], r["runtime_seconds_exhaustive"]))
    return out


DEFAULT_PROBE = [
    # (config, session): the cheapest BMimica session (that config is 94.6% of every
    # frame the head-to-head compares), the cheapest AND the most expensive of the 35
    # two-animal SLAP-2M sessions, and the cheapest 3-animal session -- so the probe
    # covers both corpora, both rig sizes and the A>2 regime where the enumeration is
    # thousands of hypotheses per frame rather than 32.
    ("A2_C5_bmimica", "20250829_134647"),
    ("A2_C6_slap2m", "10192022180019"),
    ("A2_C6_slap2m", "10072022173152"),
    ("A3_C5_slap2m", "10072022144215"),
]


def main(a):
    t0 = time.time()
    if a.dry_run:
        return dry_run(a.jobs)
    if a.probe:
        which = ([tuple(x.split("/")) for x in a.probe_sessions.split(",")]
                 if a.probe_sessions else DEFAULT_PROBE)
        return probe(which, a.jobs)
    if a.runtime:
        return runtime(a.jobs)

    if a.gate:
        tag, params = "shipped", params_for({}, {})
    else:
        tag = tag_for(FRESH_METHOD, FRESH_THRESHOLDS)
        params = params_for(FRESH_METHOD, FRESH_THRESHOLDS)

    if a.divergence:
        return divergence(tag_for(FRESH_METHOD, FRESH_THRESHOLDS), a.jobs, a.only)

    if not a.gate and not a.skip_probe_check:
        p = OUT_DIR / "fig3_hh_exhaustive_probe.json"
        if not p.exists() or not json.loads(p.read_text()).get("all_identical"):
            raise SystemExit(
                "refusing to run: figs/out/fig3_hh_exhaustive_probe.json is missing or "
                "not all_identical. The fresh-anchor run RE-USES the cached exhaustive "
                "arm, and --probe is what licenses that. Run --probe first "
                "(or --skip-probe-check, and say so in the report).")

    dep_hh, dep_q = run_pipeline(tag, params, a.jobs, a.only, a.idf1,
                                 a.force_greedy, quality=not a.no_quality)

    if a.gate:
        ok_dig, rows = digest_gate(tag, a.jobs, a.only)
        skip = set()
        if not a.idf1:
            skip |= {"scores", "greedy", "exhaustive", "n_idf1_sessions"}
        d_hh = deposit_diff(dep_hh, OUT_DIR / "fig3_headtohead.json", skip)
        d_q = (deposit_diff(dep_q, OUT_DIR / "fig3_quality.json", skip)
               if dep_q else None)
        gate = {
            "generated_by": "figs/fig3_hh_freshanchor.py --gate",
            "claim": ("the fresh-anchor harness reproduces the SHIPPED numbers exactly "
                      "when run with an empty method block: the greedy arm's "
                      "identities+frames payload is byte-identical to the cached "
                      "fig3_bench.mjs output on every session, and both rebuilt "
                      "deposits diff clean against the manuscript deposits."),
            "digests_all_identical": bool(ok_dig),
            "n_sessions": len(rows),
            "n_identical": sum(1 for r in rows if r["identical"]),
            "idf1_scored": bool(a.idf1),
            "excluded_from_deposit_diff": sorted(_WALL | skip),
            "why_excluded": ("wall-clock and provenance fields only, plus the IDF1 "
                             "blocks when this pass did not score them (they are null "
                             "by construction, not different)."),
            "headtohead_diff": d_hh,
            "quality_diff": d_q,
            "sessions": rows,
        }
        dest = OUT_DIR / "fig3_hh_gate.json"
        dest.write_text(json.dumps(gate, indent=2))
        print(f"\n[gate] digests identical: {gate['n_identical']}/{gate['n_sessions']}")
        print(f"[gate] head-to-head deposit: {d_hh['n_differ']} of "
              f"{d_hh['n_leaves_compared']} leaves differ "
              f"(+{d_hh['n_only_in_new']} new-only, {d_hh['n_only_in_shipped']} "
              f"shipped-only)")
        if d_q:
            print(f"[gate] quality deposit    : {d_q['n_differ']} of "
                  f"{d_q['n_leaves_compared']} leaves differ "
                  f"(+{d_q['n_only_in_new']} new-only, "
                  f"{d_q['n_only_in_shipped']} shipped-only)")
        print(f"[gate] -> {dest}")
        for d, name in ((d_hh, "headtohead"), (d_q, "quality")):
            for row in (d or {}).get("differ", [])[:20]:
                print(f"   DIFF {name}{row['path']}: new={row['new']!r} "
                      f"shipped={row['shipped']!r}")
    print(f"\ndone in {time.time()-t0:.0f}s", flush=True)
    return 0


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="print the cost and exit")
    ap.add_argument("--probe", action="store_true",
                    help="test that the exhaustive arm is anchor-independent")
    ap.add_argument("--probe-sessions", default=None,
                    help="comma-separated CONFIG/SESSION pairs for --probe")
    ap.add_argument("--gate", action="store_true",
                    help="run the SHIPPED configuration through this path and prove it "
                         "reproduces figs/out/fig3_{headtohead,quality}.json exactly")
    ap.add_argument("--run", action="store_true", help="the fresh-anchor measurement")
    ap.add_argument("--runtime", action="store_true",
                    help="time both arms (3f's y axis) serially, 3,000-frame windows")
    ap.add_argument("--divergence", action="store_true",
                    help="compare the fresh-anchor greedy output against the shipped "
                         "greedy output, frame by frame")
    ap.add_argument("--idf1", action="store_true",
                    help="also score IDF1/switches (expensive; no Fig 3 panel uses it)")
    ap.add_argument("--only", default=None,
                    help="comma-separated config keys (HH_ONLY)")
    ap.add_argument("--no-quality", action="store_true",
                    help="skip the fig3_quality pass (agreement only)")
    ap.add_argument("--force-greedy", action="store_true",
                    help="re-run the greedy arm even when a valid cached run exists")
    ap.add_argument("--skip-probe-check", action="store_true",
                    help="run without a passing --probe (must be disclosed)")
    ap.add_argument("--jobs", type=int, default=8,
                    help="parallel workers (default 8, the standing cap here)")
    a = ap.parse_args(argv)
    if not any((a.dry_run, a.probe, a.gate, a.run, a.divergence, a.runtime)):
        ap.error("pick one of --dry-run / --probe / --gate / --run / --divergence "
                 "/ --runtime")
    return a


if __name__ == "__main__":
    raise SystemExit(main(_parse_args()))
