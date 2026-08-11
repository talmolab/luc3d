#!/usr/bin/env python
"""Task 3 — greedy (production tracker) vs exhaustive hypothesis-testing, head to head.

For each config (numAnimals A, cameras C), on IDENTICAL detections, over EVERY
session in the corpora that has both a detection pool entry and proofread ground
truth:
  - runs figs/fig3-bench/fig3_bench.mjs (the real production greedy tracker, default
    thresholds) over the session,
  - runs figs/fig3-bench/fig3_exhaustive.mjs (the paper's exhaustive hypothesis-testing
    method) over the SAME session,
  - compares, frame by frame (only frames exhaustive actually computed — i.e. every
    camera had exactly A clean detections and (A!)^C was under the hypothesis cap),
    whether the two methods picked the SAME PARTITION of detections into identity
    groups (label-invariant — this is the clean, threading-free comparison),
  - scores both against ground truth (figs/fig3_score.py, reusing evaluate.py) over
    the same session, for IDF1/switches.

SESSIONS, NOT ONE SESSION. An earlier version of this deposit ran exactly one session
per configuration, so "137,671 frames" was really four recordings and the entire
multi-animal evidence was 566 frames from two of them. Sessions are the unit of
replication, so every configuration now runs every session the corpora can supply:

  A2_C5  BMimica  — all 50 sessions with detections + proofread GT, full length.
  A2_C6  SLAP-2M  — all 35 two-animal sessions, full length.
  A3_C5  SLAP-2M  — all 4 three-animal sessions, eligible frames capped per session.
  A4_C3  SLAP-2M  — all 3 four-animal sessions, eligible frames capped per session.
  A4_C6  SLAP-2M  — (4!)^6 = 191,102,976 hypotheses/frame: still not run, still
                    recorded analytically only.

The A=3 and A=4 caps are a real cost limit, not a choice: one A3_C5 frame costs ~3.9 s
and one A4_C3 frame ~7.8 s of triangulate+reproject, versus ~8 ms at A=2. The cap is
applied by fig3_exhaustive.mjs's --clean-sample, which scans the WHOLE session for
eligibility (so frames_considered / frames_clean stay full-session, honest numbers)
and then enumerates a UNIFORM sample of the eligible frames — never a head-of-session
prefix. Per-config `clean_sample_cap` and per-session `frames_clean` vs
`frames_computed` record exactly what was capped.

Output: figs/out/fig3_headtohead.json (aggregate + per-session breakdown)
Per-session intermediates: figs/out/tmp/headtohead/<config>/<session>/*.json

Run with the motmetrics environment:
  /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig3_headtohead.py

Environment knobs:
  HH_JOBS=16            concurrent worker processes (default 16)
  HH_CLEAN_A3=2000      per-session eligible-frame cap for the 3-animal config
  HH_CLEAN_A4=1000      per-session eligible-frame cap for the 4-animal config
  HH_ONLY=A3_C5_slap2m  restrict to one config key (repeatable, comma separated)
  HH_MAX_SESSIONS=N     use only the first N sessions of each config (smoke testing)
  HH_FORCE_RERUN=1      ignore cached per-session driver outputs
  HH_SKIP_IDF1=1        skip the (expensive, panel-unused) IDF1 scoring pass
"""
import json
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from glob import glob
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
BENCH = Path("/root/vast/eric/luc3d-bench")
BMROOT = Path("/root/vast/eric/BMimica")
GREEDY_DRIVER = REPO / "figs" / "fig3-bench" / "fig3_bench.mjs"
EXH_DRIVER = REPO / "figs" / "fig3-bench" / "fig3_exhaustive.mjs"
OUT_DIR = REPO / "figs" / "out"
TMP_DIR = OUT_DIR / "tmp" / "headtohead"

MAX_HYPOTHESES = 1_000_000

MASTER = BENCH / "outputs" / "sleap_nn_master_sheet.tsv"
KEEPTRACK = BENCH / "outputs" / "keeptrack_h5s"

BM_MASTER = BENCH / "outputs" / "bmimica" / "bmimica_master.tsv"
BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
BM_CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]

JOBS = int(os.environ.get("HH_JOBS", "16"))
#: Per-session cap on ENUMERATED eligible frames for the expensive configs. Chosen
#: from the measured per-frame costs (A3_C5 ~3.9 s, A4_C3 ~7.8 s) so that one session
#: fits in ~2 h and all sessions of a config can run concurrently. Eligibility is
#: still scanned over the whole session, so only `frames_computed` is capped.
CLEAN_A3 = int(os.environ.get("HH_CLEAN_A3", "2000"))
CLEAN_A4 = int(os.environ.get("HH_CLEAN_A4", "1000"))

CONFIGS = [
    {
        "key": "A2_C5_bmimica", "animals": 2, "cameras": BM_CAMS,
        "dataset": "BMimica", "corpus": "bmimica", "clean_sample": None,
        "note": "worked example 2x5=32 hyps/frame; ALL 50 BMimica sessions that have "
                "both a shared-pool detection file and proofread GT, at full session "
                "length (no frame cap).",
    },
    {
        "key": "A2_C6_slap2m", "animals": 2,
        "cameras": ["back", "backL", "mid", "midL", "top", "topL"],
        "dataset": "SLAP-2M", "corpus": "slap2m", "animals_filter": 2,
        "clean_sample": None,
        "note": "substituted for the handoff's 2x8 (256 hyps) worked example — no "
                "8-camera aggregated detection pool exists (side/sideL are only "
                "available as raw per-session .slp, not in the shared keeptrack_h5s/"
                "detections_only_h5s pool); 2x6=64 hyps/frame is the largest C we can "
                "run on identical, pool-fed detections. ALL 35 two-animal SLAP-2M "
                "sessions, at full session length (no frame cap).",
    },
    {
        "key": "A3_C5_slap2m", "animals": 3,
        "cameras": ["back", "backL", "mid", "midL", "top"],
        "dataset": "SLAP-2M", "corpus": "slap2m", "animals_filter": 3,
        "clean_sample": CLEAN_A3,
        "note": "worked example 3x5=7,776 hyps/frame (dropped topL to hit C=5 exactly "
                "as in the handoff's example). ALL 4 three-animal SLAP-2M sessions. "
                f"Eligibility is scanned over each full session; at ~3.9 s/frame only "
                f"a uniform sample of {CLEAN_A3} eligible frames per session is "
                "enumerated (frames_clean vs frames_computed states the gap).",
    },
    {
        "key": "A4_C3_slap2m", "animals": 4, "cameras": ["back", "mid", "top"],
        "dataset": "SLAP-2M", "corpus": "slap2m", "animals_filter": 4,
        "clean_sample": CLEAN_A4,
        "note": "4-animal regime made tractable by dropping to C=3: (4!)^3 = 13,824 "
                "hyps/frame, well under the 10^6 cap. Cameras back/mid/top (one fixed "
                "pick per height pair from the 6-camera pool). ALL 3 four-animal "
                "SLAP-2M sessions. 4-mouse frames are occlusion-heavy, so the eligible "
                "fraction (every camera holding exactly 4 detections) is low — the "
                "considered/clean/computed counts state it rather than hide it. At "
                f"~7.8 s/frame only a uniform sample of {CLEAN_A4} eligible frames per "
                "session is enumerated.",
    },
    {
        "key": "A4_C6_slap2m_hard", "animals": 4,
        "cameras": ["back", "backL", "mid", "midL", "top", "topL"],
        "dataset": "SLAP-2M", "corpus": "slap2m", "animals_filter": 4,
        "clean_sample": None, "intractable": True,
        "note": "all 3 four-animal sessions at the full 6-camera rig (24^6 ~= 1.9e8 "
                "hyps/frame) — INTRACTABLE, per the handoff's explicit instruction. "
                "Not attempted; recorded analytically only.",
    },
]


# --------------------------------------------------------------------------- #
# Session enumeration — the real constraint is the shared detection pool + GT,  #
# not the corpus, so every session is checked for both before it is used.       #
# --------------------------------------------------------------------------- #

def bm_sessions(cameras):
    df = pd.read_csv(BM_MASTER, sep="\t", index_col=0).reset_index(drop=True)
    out, skipped = [], []
    for _, row in df.iterrows():
        sess = str(row["session"])
        det_dir = BM_DET / sess
        if not all((det_dir / f"{c}_predictions.h5").exists() for c in cameras):
            skipped.append((sess, "missing detections"))
            continue
        gt_paths = {c: str(BM_GT / sess / c / "proofread.analysis.h5") for c in cameras}
        if not all(Path(p).exists() for p in gt_paths.values()):
            skipped.append((sess, "missing proofread GT"))
            continue
        calib = row["calibration_toml"]
        if not (isinstance(calib, str) and Path(calib).exists()):
            hits = glob(str(BMROOT / sess / "calibration" / "*_calibration.toml"))
            if not hits:
                skipped.append((sess, "missing calibration"))
                continue
            calib = hits[0]
        out.append({
            "session": sess, "det_dir": str(det_dir), "det_session_idx": 0,
            "calibration": calib, "gt_dir": str(BM_GT / sess), "gt_paths": None,
            "max_frames": None,   # BMimica H5s are per-session, so nFrames is honest
        })
    return out, skipped


def slap2m_sessions(cameras, animals):
    df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)
    out, skipped = [], []
    for idx, row in df.iterrows():
        if int(row["animals"]) != animals:
            continue
        sess = str(row["session"])
        gt_paths = {c: row[f"{c}_proofread_h5"] for c in cameras}
        if not all(isinstance(p, str) and Path(p).exists() for p in gt_paths.values()):
            skipped.append((sess, "missing proofread GT"))
            continue
        calib = row["calibration_toml"]
        if not (isinstance(calib, str) and Path(calib).exists()):
            skipped.append((sess, "missing calibration"))
            continue
        out.append({
            "session": sess, "det_dir": str(KEEPTRACK), "det_session_idx": int(idx),
            "calibration": calib, "gt_dir": None, "gt_paths": gt_paths,
            # keeptrack_h5s is one pooled array padded to the LONGEST session, so the
            # window must be clipped to this session's real length or every shorter
            # session would "consider" ~108k phantom all-NaN frames.
            "max_frames": int(row["frames"]),
        })
    return out, skipped


def sessions_for(cfg):
    if cfg["corpus"] == "bmimica":
        return bm_sessions(cfg["cameras"])
    return slap2m_sessions(cfg["cameras"], cfg["animals_filter"])


# --------------------------------------------------------------------------- #
# Drivers                                                                      #
# --------------------------------------------------------------------------- #

def cell_dir(cfg, sess):
    return TMP_DIR / cfg["key"] / sess["session"]


def _run(cmd, timeout):
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    if r.returncode != 0:
        return None, f"exit {r.returncode}: {r.stderr[-800:]}".replace("\n", " ")
    return time.time() - t0, None


def driver_job(cfg, sess):
    """Run both drivers for one (config, session). Cached per session."""
    d = cell_dir(cfg, sess)
    d.mkdir(parents=True, exist_ok=True)
    greedy_out, exh_out = d / "greedy.json", d / "exhaustive.json"
    force = bool(os.environ.get("HH_FORCE_RERUN"))

    def usable(path, want_sample):
        if force or not path.exists():
            return False
        try:
            p = json.loads(path.read_text())
        except Exception:
            return False
        if p.get("numAnimals") != cfg["animals"]:
            return False
        if list(p.get("cameras", [])) != list(cfg["cameras"]):
            return False
        # A cached run is only reusable if it SCANNED the whole window this run asks
        # for. Without this, a cached 1,000-frame prefix from the old one-session
        # deposit would silently satisfy a full-session request.
        if sess["max_frames"] and p.get("framesConsidered", 0) < sess["max_frames"]:
            return False
        if want_sample is not None:
            # ...and enumerated at least as many eligible frames as asked for.
            if p.get("framesComputed", 0) < min(want_sample, p.get("framesClean", 0)):
                return False
        return True

    base = ["--session-idx", str(sess["det_session_idx"]),
            "--num-animals", str(cfg["animals"]),
            "--calibration", str(sess["calibration"]),
            "--pred-h5-dir", sess["det_dir"],
            "--cameras", ",".join(cfg["cameras"])]
    if sess["max_frames"]:
        base += ["--max-frames", str(sess["max_frames"])]

    errs = []
    if not usable(greedy_out, None):
        _, e = _run(["node", str(GREEDY_DRIVER)] + base + ["--out", str(greedy_out)],
                    timeout=7200)
        if e:
            errs.append(f"greedy: {e}")
    if not errs and not usable(exh_out, cfg["clean_sample"]):
        cmd = ["node", str(EXH_DRIVER)] + base + [
            "--out", str(exh_out), "--max-hypotheses", str(MAX_HYPOTHESES)]
        if cfg["clean_sample"]:
            cmd += ["--clean-sample", str(cfg["clean_sample"])]
        _, e = _run(cmd, timeout=86400)
        if e:
            errs.append(f"exhaustive: {e}")
    return cfg["key"], sess["session"], errs


# --------------------------------------------------------------------------- #
# Agreement (label-invariant, threading-free)                                  #
# --------------------------------------------------------------------------- #

def partition_of(frame_entry, keys_filter=None):
    """{identity: frozenset(keys)} restricted to keys_filter if given."""
    groups = {}
    for key, ident in frame_entry["assignments"]:
        if keys_filter is not None and key not in keys_filter:
            continue
        groups.setdefault(ident, set()).add(key)
    return frozenset(frozenset(v) for v in groups.values())


def agreement_rate(exh_json, greedy_json):
    greedy_by_frame = {f["frame"]: f for f in greedy_json["frames"]}
    n_compared, n_agree = 0, 0
    for ef in exh_json["frames"]:
        fi = ef["frame"]
        exh_keys = set(k for k, _ in ef["assignments"])
        gf = greedy_by_frame.get(fi)
        if gf is None:
            continue  # greedy produced nothing this frame — not comparable
        exh_part = partition_of(ef)
        greedy_part = partition_of(gf, keys_filter=exh_keys)
        greedy_keys = set(k for grp in greedy_part for k in grp)
        n_compared += 1
        if greedy_keys == exh_keys and exh_part == greedy_part:
            n_agree += 1
    return n_agree, n_compared


def summarise_job(args):
    """Per-session agreement + counts + (optionally) IDF1. Runs in a worker process."""
    cfg, sess = args
    d = cell_dir(cfg, sess)
    rec = {"session": sess["session"], "status": "ok"}
    try:
        exh = json.loads((d / "exhaustive.json").read_text())
        greedy = json.loads((d / "greedy.json").read_text())
    except Exception as e:
        return {"session": sess["session"], "status": "failed",
                "why": f"missing driver output: {e}"}

    rec["frames_considered"] = exh["framesConsidered"]
    rec["frames_clean"] = exh["framesClean"]
    rec["frames_computed"] = exh["framesComputed"]
    rec["runtime_seconds_exhaustive"] = exh["runtimeSeconds"]
    rec["seconds_per_frame_exhaustive"] = exh["secondsPerComputedFrame"]
    rec["seconds_per_frame_exhaustive_enum"] = exh.get("secondsPerComputedFrameEnum")
    rec["clean_sample_stride"] = exh.get("cleanSampleStride", 1)
    rec["frames_processed_greedy"] = greedy.get("framesProcessed")
    rec["seconds_per_frame_greedy"] = (
        greedy["runtimeSeconds"] / greedy["framesProcessed"]
        if greedy.get("framesProcessed") else None)

    n_agree, n_compared = agreement_rate(exh, greedy)
    rec["n_agree"] = n_agree
    rec["n_compared"] = n_compared
    rec["agreement_rate"] = (n_agree / n_compared) if n_compared else None

    if os.environ.get("HH_SKIP_IDF1"):
        return rec

    score_path = d / "score.json"
    if score_path.exists() and not os.environ.get("HH_FORCE_RERUN"):
        try:
            rec["scores"] = json.loads(score_path.read_text())
            return rec
        except Exception:
            pass
    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs
    scores = {}
    try:
        for name, path in (("greedy", d / "greedy.json"), ("exhaustive", d / "exhaustive.json")):
            s = fs.score_session(str(path), sess["det_dir"], sess["gt_dir"],
                                 cfg["cameras"], cfg["animals"],
                                 max_frames=sess["max_frames"],
                                 det_session_idx=sess["det_session_idx"],
                                 gt_paths=sess["gt_paths"])
            scores[name] = {"idf1_within": s["within_idf1"],
                            "idf1_cross": s["cross_idf1"],
                            "switches": s["within_switches"],
                            "cross_switches": s["cross_switches"]}
        score_path.write_text(json.dumps(scores, indent=2))
        rec["scores"] = scores
    except Exception as e:
        rec["scores"] = {"status": "failed", "why": str(e)}
    return rec


# --------------------------------------------------------------------------- #

CAVEATS = [
    "Exhaustive is a PURE PER-FRAME procedure (as described in the paper) with no "
    "cross-frame identity mechanism; to make IDF1/switches computable at all for it, "
    "fig3_exhaustive.mjs threads identity across frames via nearest-3D-centroid "
    "Hungarian matching to the previous computed frame. This threading is NOT part "
    "of the association decision and is disclosed here — the clean, threading-free "
    "comparison is agreement_rate (does exhaustive choose the same partition of "
    "detections as greedy, using only the paper's actual per-frame method).",
    "A frame only enters the exhaustive computation if every included camera has "
    "EXACTLY `animals` non-null detections that frame (so 'A! per view' is well "
    "posed); frames with occlusion/misses/extra false positives are counted as "
    "considered-but-ineligible (frames_considered vs frames_clean vs frames_computed, "
    "per config AND per session), never silently dropped.",
    "Every configuration now runs EVERY session the shared detection pool and the "
    "proofread GT can jointly supply: 50 BMimica sessions (2 animals x 5 cameras), "
    "35 two-animal / 4 three-animal / 3 four-animal SLAP-2M sessions. The per-session "
    "breakdown is in each config's `per_session`; config-level counts are sums and "
    "config-level agreement is pooled over frames (not a mean of per-session rates).",
    "The A2_C6 config substitutes for the handoff's suggested A2_C8 — see per-config "
    "note; no 8-camera-synchronized aggregated detection pool exists in this benchmark.",
    "The A=3 and A=4 configs cap how many ELIGIBLE frames per session are enumerated "
    "(config `clean_sample_cap`), because one frame costs ~3.9 s (A3_C5, 7,776 "
    "hyps/frame) and ~7.8 s (A4_C3, 13,824 hyps/frame) against ~8 ms at A=2. The cap "
    "does NOT change what is counted: eligibility is scanned over the whole session, "
    "so frames_considered and frames_clean are full-session numbers, and the "
    "enumerated frames are a UNIFORM sample across the session (stride = "
    "frames_clean / cap, recorded per session as clean_sample_stride), not a "
    "head-of-session prefix.",
    "A4_C3 uses cameras back/mid/top (one fixed pick per height pair). Its eligible "
    "fraction is low because 4-mouse frames are occlusion-heavy — a frame needs "
    "exactly 4 detections in ALL THREE views to enter the exhaustive computation.",
    "IDF1/switches are aggregated as the MEAN across sessions (within a config, then "
    "across configs) and the SUM of switches, and are reported for completeness only: "
    "no figure panel plots them. Besides the threading caveat above, exhaustive is "
    "scored over only the frames it computed while greedy is scored over the whole "
    "session, so the two coverages differ by construction and the gap is not a "
    "quality difference. agreement_rate is the comparison that is like-for-like.",
]


def main():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    only = set(x for x in os.environ.get("HH_ONLY", "").split(",") if x)
    max_sessions = int(os.environ.get("HH_MAX_SESSIONS", "0"))

    plan, blocked = [], []
    for cfg in CONFIGS:
        if only and cfg["key"] not in only:
            continue
        sess_list, skipped = sessions_for(cfg)
        for s, why in skipped:
            blocked.append(f"{cfg['key']}: session {s} excluded ({why})")
        if max_sessions:
            sess_list = sess_list[:max_sessions]
        cfg["sessions"] = sess_list
        plan.append(cfg)
        print(f"{cfg['key']}: {len(sess_list)} sessions, "
              f"{sum(s['max_frames'] or 0 for s in sess_list) or '(full length)'} frames"
              f"{' [INTRACTABLE — not run]' if cfg.get('intractable') else ''}", flush=True)

    # --- Phase 1: drivers, 16-wide. Subprocesses, so threads are the right pool. ---
    # LONGEST FIRST. A ThreadPoolExecutor starts jobs in submission order, and the
    # 3-/4-animal jobs cost ~2 h each against ~25 min for a BMimica session: submitted
    # in config order they would start last and leave 9 of 16 workers idle for the
    # final two hours. Ordering by animals descending overlaps them with the cheap
    # ones instead.
    jobs = sorted([(cfg, s) for cfg in plan if not cfg.get("intractable")
                   for s in cfg["sessions"]],
                  key=lambda t: -t[0]["animals"])
    print(f"\n=== phase 1: {len(jobs)} driver jobs, {JOBS}-wide ===", flush=True)
    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        futs = [ex.submit(driver_job, cfg, s) for cfg, s in jobs]
        for f in as_completed(futs):
            key, sess, errs = f.result()
            done += 1
            for e in errs:
                blocked.append(f"{key}/{sess}: driver failed: {e}")
            print(f"  [{done}/{len(jobs)}] {key}/{sess} "
                  f"{'FAILED ' + '; '.join(errs) if errs else 'ok'} "
                  f"({time.time() - t0:.0f}s elapsed)", flush=True)

    # --- Phase 2: per-session agreement + IDF1, 16-wide (CPU-bound Python). ---
    print(f"\n=== phase 2: per-session summaries, {JOBS}-wide ===", flush=True)
    results = {cfg["key"]: [] for cfg in plan}
    with ProcessPoolExecutor(max_workers=JOBS) as ex:
        futs = {ex.submit(summarise_job, (cfg, s)): (cfg["key"], s["session"])
                for cfg, s in jobs}
        for f in as_completed(futs):
            key, sess = futs[f]
            try:
                rec = f.result()
            except Exception as e:
                rec = {"session": sess, "status": "failed", "why": str(e)}
            if rec.get("status") != "ok":
                blocked.append(f"{key}/{sess}: summary failed: {rec.get('why')}")
            results[key].append(rec)
            print(f"  {key}/{sess}: {rec.get('n_agree')}/{rec.get('n_compared')} agree, "
                  f"clean {rec.get('frames_clean')}/{rec.get('frames_considered')}, "
                  f"computed {rec.get('frames_computed')}", flush=True)

    # --- Phase 3: aggregate ---
    configs_out = []
    greedy_totals = {"idf1_within": [], "idf1_cross": [], "switches": 0}
    exh_totals = {"idf1_within": [], "idf1_cross": [], "switches": 0}
    total_frames_compared, total_agree = 0, 0
    all_sessions = []

    for cfg in plan:
        hyps = math.factorial(cfg["animals"]) ** len(cfg["cameras"])
        per_session = sorted([r for r in results[cfg["key"]]],
                             key=lambda r: r["session"])
        sess_ids = [s["session"] for s in cfg["sessions"]]
        all_sessions += sess_ids
        entry = {
            "key": cfg["key"],
            "cameras": len(cfg["cameras"]), "animals": cfg["animals"],
            "hypotheses": hyps, "status": None,
            "seconds_per_frame_exhaustive": None, "dataset": cfg["dataset"],
            "session": sess_ids[0] if len(sess_ids) == 1 else None,
            "n_sessions": len(sess_ids), "sessions": sess_ids,
            "clean_sample_cap": cfg["clean_sample"],
            "note": cfg["note"],
        }
        if cfg.get("intractable") or hyps > MAX_HYPOTHESES:
            # Sessions EXIST for this configuration; none were run, so `sessions` is
            # empty and the available ones are named separately rather than implying
            # coverage that does not exist.
            entry["status"] = "intractable"
            entry["sessions_available"] = sess_ids
            entry["sessions"] = []
            entry["n_sessions"] = 0
            entry["frames_considered"] = 0
            entry["frames_clean"] = 0
            entry["frames_computed"] = 0
            entry["per_session"] = []
            configs_out.append(entry)
            continue

        ok = [r for r in per_session if r.get("status") == "ok"]
        if not ok:
            entry["status"] = "failed"
            entry["why"] = "no session produced usable driver output"
            entry["per_session"] = per_session
            configs_out.append(entry)
            continue

        entry["status"] = "ok"
        entry["frames_considered"] = sum(r["frames_considered"] for r in ok)
        entry["frames_clean"] = sum(r["frames_clean"] for r in ok)
        entry["frames_computed"] = sum(r["frames_computed"] for r in ok)
        runtime = sum(r["runtime_seconds_exhaustive"] for r in ok)
        # Frame-weighted, i.e. total exhaustive wall time / total frames enumerated —
        # not a mean of per-session rates, which would over-weight short sessions.
        entry["seconds_per_frame_exhaustive"] = (
            runtime / entry["frames_computed"] if entry["frames_computed"] else None)
        entry["exhaustive_wall_seconds"] = runtime
        n_agree = sum(r["n_agree"] for r in ok)
        n_comp = sum(r["n_compared"] for r in ok)
        entry["n_agree"] = n_agree
        entry["n_compared"] = n_comp
        entry["agreement_rate"] = (n_agree / n_comp) if n_comp else None
        entry["per_session"] = per_session
        total_agree += n_agree
        total_frames_compared += n_comp

        for r in ok:
            sc = r.get("scores")
            if not isinstance(sc, dict) or "greedy" not in sc:
                continue
            greedy_totals["idf1_within"].append(sc["greedy"]["idf1_within"])
            greedy_totals["idf1_cross"].append(sc["greedy"]["idf1_cross"])
            greedy_totals["switches"] += sc["greedy"]["switches"]
            exh_totals["idf1_within"].append(sc["exhaustive"]["idf1_within"])
            exh_totals["idf1_cross"].append(sc["exhaustive"]["idf1_cross"])
            exh_totals["switches"] += sc["exhaustive"]["switches"]
        configs_out.append(entry)

    def mean_or_none(xs):
        return float(sum(xs) / len(xs)) if xs else None

    out = {
        "generated_by": "figs/fig3_headtohead.py + figs/fig3-bench/fig3_exhaustive.mjs",
        "dataset": "both",
        "detection_pool": f"{BM_DET} (BMimica, per-session), {KEEPTRACK} (SLAP-2M, pooled)",
        "sessions": list(dict.fromkeys(all_sessions)),
        "n_sessions": len(set(all_sessions)),
        "metric": "IDF1 (motmetrics) + ID-switches",
        "caveats": CAVEATS,
        "blocked": blocked,
        "frames_compared": total_frames_compared,
        "agreement_rate": (total_agree / total_frames_compared) if total_frames_compared else None,
        "frames_agree": total_agree,
        "n_idf1_sessions": len(greedy_totals["idf1_within"]),
        "greedy": {
            "idf1_within": mean_or_none(greedy_totals["idf1_within"]),
            "idf1_cross": mean_or_none(greedy_totals["idf1_cross"]),
            "switches": greedy_totals["switches"],
        },
        "exhaustive": {
            "idf1_within": mean_or_none(exh_totals["idf1_within"]),
            "idf1_cross": mean_or_none(exh_totals["idf1_cross"]),
            "switches": exh_totals["switches"],
        },
        "configs": configs_out,
        "caps": {
            "max_hypotheses_per_frame": MAX_HYPOTHESES,
            # Per-session cap on ENUMERATED eligible frames (null = uncapped, whole
            # session enumerated). Frames considered/clean are never capped.
            "clean_frames_per_session": {c["key"]: c["clean_sample"] for c in CONFIGS},
            # Retained key: the per-config frame window actually scanned (summed over
            # that config's sessions).
            "max_frames": {e["key"]: e.get("frames_considered", 0) for e in configs_out},
        },
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_headtohead.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {OUT_DIR / 'fig3_headtohead.json'}", flush=True)
    print(f"total: {total_agree:,}/{total_frames_compared:,} frames agree "
          f"({(total_agree / total_frames_compared if total_frames_compared else 0):.6%})",
          flush=True)


if __name__ == "__main__":
    main()
