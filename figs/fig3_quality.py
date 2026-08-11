#!/usr/bin/env python
"""Fig 3 quality — greedy vs exhaustive partition agreement + GT-grouping accuracy.

Consumes the per-frame head-to-head records already produced by
figs/fig3_headtohead.py (figs/out/tmp/headtohead/<config>/<session>/{greedy,
exhaustive}.json) and, FOR EVERY SESSION of every configuration:

  1. recomputes per-session agreement (partition_of/agreement_rate logic imported
     from fig3_headtohead.py, so the two deposits cannot drift), additionally
     recording WHICH frames disagree;
  2. scores BOTH methods against ground truth threading-free: per frame, each
     camera's detections are IoU-matched (bbox_from_kpts, motmetrics iou_matrix
     max_iou=0.5 + linear_sum_assignment on the finite entries) to the proofread
     GT instances; matched "cam:slot" keys are grouped by GT animal id to form
     the GT partition; each method's partition, restricted to the matched keys,
     is compared label-invariantly (same frozenset-of-frozensets construction);
  3. for the frames where greedy and exhaustive disagree, shells out to
     figs/fig3-bench/fig3_rescore_frames.mjs to score BOTH partitions with the
     exhaustive objective (total reprojection error), quantifying the cost gap.

The configuration and session lists are IMPORTED from fig3_headtohead.py — this
script scores exactly what that one ran, session for session, and each config's
entry carries the per-session breakdown as well as the summed totals.

Reuses $BENCH/scripts/evaluate.py's bbox_from_kpts/load_gt (and its
motmetrics/np.asfarray shim) — no re-derived IoU machinery.

Run with the motmetrics environment:
  /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig3_quality.py

Environment knobs: HH_JOBS (workers, default 16), HH_ONLY / HH_MAX_SESSIONS
(same meaning as in fig3_headtohead.py), Q_FORCE=1 to ignore cached per-session
quality records.

Output: figs/out/fig3_quality.json
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import h5py
import numpy as np
from scipy.optimize import linear_sum_assignment

REPO = Path(__file__).resolve().parent.parent
BENCH = Path("/root/vast/eric/luc3d-bench")
OUT_DIR = REPO / "figs" / "out"
RESCORE_DRIVER = REPO / "figs" / "fig3-bench" / "fig3_rescore_frames.mjs"

sys.path.insert(0, str(REPO / "figs"))
sys.path.insert(0, str(BENCH / "scripts"))
import evaluate as ev  # noqa: E402  (installs the np.asfarray shim + motmetrics)
import motmetrics as mm  # noqa: E402

import fig3_headtohead as hh  # noqa: E402  (single source of configs + sessions)

JOBS = int(os.environ.get("HH_JOBS", "16"))


# --- Task 1: imported from fig3_headtohead.py so the two deposits cannot drift; ---
# --- extended only to also collect the disagreeing frame indices.                ---

partition_of = hh.partition_of


def agreement_rate(exh_json, greedy_json):
    greedy_by_frame = {f["frame"]: f for f in greedy_json["frames"]}
    n_compared, n_agree = 0, 0
    disagree_frames = []
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
        else:
            disagree_frames.append(fi)
    return n_agree, n_compared, disagree_frames


# --- Task 2: GT-grouping accuracy, threading-free ---

def match_frame_to_gt(det_all, gt_all, cameras, fi, exh_keys):
    """IoU-match each camera's detections (restricted to exh_keys' slots) to GT.

    Returns (key2gt, counts) where key2gt maps "cam:slot" -> GT animal id (the
    GT track index, which this benchmark treats as the global animal identity
    across cameras — the same convention fig3_score.py's pooled accumulator
    uses), and counts tallies unmatched keys. Returns None if fi is out of
    range for any camera's det/GT arrays.
    """
    key2gt = {}
    n_no_bbox = 0
    n_no_match = 0
    for cam in cameras:
        det = det_all[cam]
        gt, occ = gt_all[cam]
        if fi >= det.shape[0] or fi >= gt.shape[0]:
            return None, None
        gtb, gti = [], []
        for t in range(gt.shape[1]):
            if not occ[fi, t]:
                continue
            b = ev.bbox_from_kpts(gt[fi, t])
            if b is not None:
                gtb.append(b)
                gti.append(int(t))
        prb, prk = [], []
        for a in range(det.shape[1]):
            key = f"{cam}:{a}"
            if key not in exh_keys:
                continue
            b = ev.bbox_from_kpts(det[fi, a])
            if b is None:
                n_no_bbox += 1
                continue
            prb.append(b)
            prk.append(key)
        if not prk:
            continue
        if not gtb:
            n_no_match += len(prk)
            continue
        gtn = np.asarray(gtb)
        prn = np.asarray(prb)
        dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)  # NaN where iou < 0.5
        finite = np.isfinite(dist)
        cost = np.where(finite, dist, 1e6)
        rows, cols = linear_sum_assignment(cost)
        matched_cols = set()
        for r, c in zip(rows, cols):
            if finite[r, c]:
                key2gt[prk[c]] = gti[r]
                matched_cols.add(c)
        n_no_match += len(prk) - len(matched_cols)
    return key2gt, {"no_bbox": n_no_bbox, "no_match": n_no_match}


def gt_partition_of(key2gt):
    groups = {}
    for key, animal in key2gt.items():
        groups.setdefault(animal, set()).add(key)
    return frozenset(frozenset(v) for v in groups.values())


def pair_fraction(key2gt, method_assign):
    """Fraction of matched-key pairs where (same GT animal) == (same method group).

    method_assign maps key -> identity for keys the method assigned; a pair with
    either key unassigned by the method counts as 'different method group'.
    Returns None if fewer than 2 matched keys (no pairs).
    """
    keys = sorted(key2gt)
    n = len(keys)
    if n < 2:
        return None
    correct = 0
    total = 0
    for i in range(n):
        for j in range(i + 1, n):
            ki, kj = keys[i], keys[j]
            same_gt = key2gt[ki] == key2gt[kj]
            same_m = (ki in method_assign and kj in method_assign
                      and method_assign[ki] == method_assign[kj])
            total += 1
            if same_gt == same_m:
                correct += 1
    return correct / total


def gt_accuracy(exh_json, greedy_json, det_all, gt_all, cameras):
    """Per-method GT-grouping accuracy over the frames exhaustive computed."""
    greedy_by_frame = {f["frame"]: f for f in greedy_json["frames"]}
    stats = {
        m: {"exact": 0, "frames_exact": 0, "pair_sum": 0.0, "pair_n": 0}
        for m in ("greedy", "exhaustive")
    }
    frames_evaluated = 0
    frames_skipped_no_greedy = 0
    frames_skipped_out_of_range = 0
    frames_no_matched_keys = 0
    tot_keys = 0
    tot_matched = 0
    tot_no_bbox = 0
    tot_no_match = 0
    per_frame_exact = {}  # fi -> {"greedy": bool, "exhaustive": bool}
    for ef in exh_json["frames"]:
        fi = ef["frame"]
        gf = greedy_by_frame.get(fi)
        if gf is None:
            frames_skipped_no_greedy += 1
            continue
        exh_keys = set(k for k, _ in ef["assignments"])
        key2gt, counts = match_frame_to_gt(det_all, gt_all, cameras, fi, exh_keys)
        if key2gt is None:
            frames_skipped_out_of_range += 1
            continue
        frames_evaluated += 1
        tot_keys += len(exh_keys)
        tot_matched += len(key2gt)
        tot_no_bbox += counts["no_bbox"]
        tot_no_match += counts["no_match"]
        if not key2gt:
            frames_no_matched_keys += 1
            continue
        gt_part = gt_partition_of(key2gt)
        matched_keys = set(key2gt)
        entries = {"greedy": gf, "exhaustive": ef}
        per_frame_exact[fi] = {}
        for m, entry in entries.items():
            part = partition_of(entry, keys_filter=matched_keys)
            covered = set(k for grp in part for k in grp)
            exact = (covered == matched_keys and part == gt_part)
            stats[m]["frames_exact"] += 1
            if exact:
                stats[m]["exact"] += 1
            per_frame_exact[fi][m] = bool(exact)
            assign = {k: ident for k, ident in entry["assignments"] if k in matched_keys}
            pf = pair_fraction(key2gt, assign)
            if pf is not None:
                # Kept as a running sum + count, not a per-frame list: at 50 sessions
                # x ~150k frames the list itself was the memory cost, and the mean is
                # re-derivable (and aggregatable across sessions) from the two numbers.
                stats[m]["pair_sum"] += pf
                stats[m]["pair_n"] += 1
    out = {}
    for m in ("greedy", "exhaustive"):
        s = stats[m]
        out[m] = {
            "exact_match_frames": s["exact"],
            "frames": s["frames_exact"],
            "exact_match_rate": (s["exact"] / s["frames_exact"]) if s["frames_exact"] else None,
            "pair_accuracy_mean": (s["pair_sum"] / s["pair_n"]) if s["pair_n"] else None,
            "pair_accuracy_sum": s["pair_sum"],
            "frames_with_pairs": s["pair_n"],
        }
    meta = {
        "frames_evaluated": frames_evaluated,
        "frames_skipped_no_greedy": frames_skipped_no_greedy,
        "frames_skipped_out_of_range": frames_skipped_out_of_range,
        "frames_no_matched_keys": frames_no_matched_keys,
        "detection_keys_total": tot_keys,
        "detection_keys_matched": tot_matched,
        "detection_keys_unmatched_no_bbox": tot_no_bbox,
        "detection_keys_unmatched_low_iou": tot_no_match,
    }
    return out, meta, per_frame_exact


# --- Task 3: cost gap on disagreeing frames (Node rescore) ---

def rescore_disagreements(cfg, sess, disagree_frames, cell):
    if not disagree_frames:
        return []
    out_path = cell / "rescore.json"
    cmd = [
        "node", str(RESCORE_DRIVER),
        "--session-idx", str(sess["det_session_idx"]),
        "--calibration", str(sess["calibration"]),
        "--pred-h5-dir", sess["det_dir"],
        "--cameras", ",".join(cfg["cameras"]),
        "--greedy", str(cell / "greedy.json"),
        "--exhaustive", str(cell / "exhaustive.json"),
        "--frames", ",".join(str(f) for f in disagree_frames),
        "--out", str(out_path),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        return {"status": "failed",
                "why": "rescore driver exit %d: %s" % (r.returncode, r.stderr[-800:].replace("\n", " "))}
    return json.loads(out_path.read_text())["frames"]


# --------------------------------------------------------------------------- #

def session_job(args):
    """Agreement + GT accuracy + rescore for one (config, session). Cached."""
    cfg, sess = args
    cell = hh.cell_dir(cfg, sess)
    cache = cell / "quality.json"
    if cache.exists() and not os.environ.get("Q_FORCE"):
        try:
            return json.loads(cache.read_text())
        except Exception:
            pass

    rec = {"session": sess["session"], "status": "ok"}
    try:
        exh_json = json.loads((cell / "exhaustive.json").read_text())
        greedy_json = json.loads((cell / "greedy.json").read_text())
    except Exception as e:
        return {"session": sess["session"], "status": "failed",
                "why": f"could not load head-to-head JSONs: {e}"}

    n_agree, n_compared, disagree_frames = agreement_rate(exh_json, greedy_json)
    rec["n_compared"] = n_compared
    rec["n_agree"] = n_agree
    rec["agreement_rate"] = (n_agree / n_compared) if n_compared else None
    rec["disagree_frames"] = disagree_frames

    try:
        det_all, gt_all = {}, {}
        for cam in cfg["cameras"]:
            with h5py.File(Path(sess["det_dir"]) / f"{cam}_predictions.h5", "r") as f:
                det_all[cam] = f["tracks"][sess["det_session_idx"]][...]
            gt_path = (Path(sess["gt_paths"][cam]) if sess["gt_paths"]
                       else Path(sess["gt_dir"]) / cam / "proofread.analysis.h5")
            gt_all[cam] = ev.load_gt(gt_path)
        gt_out, gt_meta, per_frame_exact = gt_accuracy(
            exh_json, greedy_json, det_all, gt_all, cfg["cameras"])
        rec["gt"] = gt_out
        rec["gt_matching"] = gt_meta
        del det_all, gt_all
    except Exception as e:
        rec["gt"] = {"status": "failed", "why": str(e)}
        rec["status"] = "failed"
        rec["why"] = f"GT scoring failed: {e}"
        per_frame_exact = {}

    detail = []
    rescored = None
    if disagree_frames:
        try:
            rescored = rescore_disagreements(cfg, sess, disagree_frames, cell)
        except Exception as e:
            rescored = {"status": "failed", "why": str(e)}
    exh_by_frame = {f["frame"]: f for f in exh_json["frames"]}
    rescored_by_frame = ({r["frame"]: r for r in rescored}
                         if isinstance(rescored, list) else {})
    for fi in disagree_frames:
        d = {"session": sess["session"], "frame": fi,
             "exhaustive_error": exh_by_frame[fi]["totalError"]}
        r = rescored_by_frame.get(fi)
        if r is not None and r.get("greedy_error") is not None:
            d["greedy_error"] = r["greedy_error"]
            d["greedy_covers_all_exh_keys"] = r.get("greedy_covers_all_exh_keys")
            d["exhaustive_error_recomputed"] = r.get("exhaustive_error_recomputed")
            d["exhaustive_reproduced"] = r.get("exhaustive_reproduced")
        else:
            why = (r or {}).get("greedy_rescore_failed_why") or (
                rescored["why"] if isinstance(rescored, dict) else "no rescore record")
            d["greedy_error"] = {"status": "failed", "why": why}
        pf = per_frame_exact.get(fi)
        if pf is None:
            d["gt_matches"] = "unknown"
        else:
            g, e = pf.get("greedy"), pf.get("exhaustive")
            d["gt_matches"] = ("both" if g and e else "greedy" if g
                               else "exhaustive" if e else "neither")
        detail.append(d)
    rec["disagreement_detail"] = detail

    if rec["status"] == "ok":
        cache.write_text(json.dumps(rec))
    return rec


CAVEATS = [
    "GT matching is IoU-0.5 bounding-box matching (bbox_from_kpts, pad=5, "
    "min_valid=3 keypoints; motmetrics iou_matrix + linear_sum_assignment on "
    "the finite entries) of per-camera detections to proofread GT instances; "
    "detections that fail to match any GT instance (no bbox, or best IoU < 0.5, "
    "or displaced in the one-to-one assignment) are EXCLUDED from the partition "
    "comparison — see per-config gt_matching for honest unmatched counts.",
    "The GT track index is treated as the global animal identity across cameras "
    "of a session — the same convention fig3_score.py's pooled cross-view "
    "accumulator uses for this benchmark's proofread GT.",
    "Comparisons are threading-free and label-invariant: per frame, each method's "
    "grouping is reduced to a partition (frozenset of frozensets) of the matched "
    "'cam:slot' keys, so identity labels/threading play no role.",
    "Only frames exhaustive actually computed enter every comparison (every "
    "camera had exactly A clean detections and (A!)^C was under the hypothesis "
    "cap) — greedy's frame set is a superset and is restricted to match, exactly "
    "as in fig3_headtohead.py.",
    "exact_match_rate counts a frame only if the method's restricted partition "
    "EQUALS the GT partition (and covers every matched key); pair_accuracy_mean "
    "is the per-frame fraction of matched-key pairs where (same GT animal) == "
    "(same method group), averaged over frames with at least 2 matched keys "
    "(pooled across a config's sessions by frame, not by session). A pair with "
    "either key unassigned by the method counts as 'different group'.",
    "greedy_error in disagreement_detail scores the greedy partition restricted "
    "to the exhaustive frame's keys with the identical total-reprojection-error "
    "objective (real pose/triangulation.js triangulateAndReproject), so it is "
    "directly comparable to exhaustive's totalError. Each entry names its session.",
    "A4_C6 (the 24^6 ≈ 1.9e8 hypotheses/frame config) was never computed by "
    "fig3_headtohead.py (intractable) and therefore has no quality entry here.",
    "Every configuration is scored over EVERY session fig3_headtohead.py ran — 50 "
    "BMimica (2x5), 35 SLAP-2M two-animal (2x6), 4 three-animal (3x5) and 3 "
    "four-animal (4x3) — and each config entry carries both the summed totals and "
    "the per-session breakdown in `per_session`.",
    "The 3- and 4-animal configs enumerate only a per-session cap of eligible "
    "frames (fig3_headtohead.json caps.clean_frames_per_session), sampled uniformly "
    "across each session, because one frame costs seconds there. The GT comparison "
    "therefore covers that sample, not every eligible frame; frames_clean in the "
    "head-to-head deposit states how many eligible frames existed.",
    "The proofread GT derives from the same SLEAP predictions as the detection "
    "pool (SLAP-2M GT files are literally *.predictions.proofread.slp.analysis.h5), "
    "so detection-to-GT IoU matching is near-saturated — the IoU step mostly "
    "transfers proofread identities rather than stress-testing the matcher — and "
    "per-config match saturation is in each entry's gt_matching block. Spot-checks "
    "confirm the matching is non-degenerate: slot-to-animal mappings flip across "
    "cameras and frames, so exact partition match is a real cross-view consistency "
    "test.",
    "The GT comparison only sees the frames exhaustive computed — i.e. clean "
    "frames where every camera has exactly A detections. Occlusion-heavy frames "
    "are excluded by construction, which is why grouping accuracy is near-perfect; "
    "these numbers say both methods group CLEAN frames essentially perfectly, not "
    "that either method is perfect overall.",
]


def main():
    only = set(x for x in os.environ.get("HH_ONLY", "").split(",") if x)
    max_sessions = int(os.environ.get("HH_MAX_SESSIONS", "0"))

    plan, blocked = [], []
    for cfg in hh.CONFIGS:
        if cfg.get("intractable"):
            continue
        if only and cfg["key"] not in only:
            continue
        sess_list, skipped = hh.sessions_for(cfg)
        if max_sessions:
            sess_list = sess_list[:max_sessions]
        cfg["sessions"] = sess_list
        plan.append(cfg)
        print(f"{cfg['key']}: {len(sess_list)} sessions", flush=True)

    jobs = [(cfg, s) for cfg in plan for s in cfg["sessions"]]
    results = {cfg["key"]: [] for cfg in plan}
    print(f"\n=== {len(jobs)} session jobs, {JOBS}-wide ===", flush=True)
    with ProcessPoolExecutor(max_workers=JOBS) as ex:
        futs = {ex.submit(session_job, (cfg, s)): (cfg["key"], s["session"])
                for cfg, s in jobs}
        for f in as_completed(futs):
            key, sess = futs[f]
            try:
                rec = f.result()
            except Exception as e:
                rec = {"session": sess, "status": "failed", "why": str(e)}
            if rec.get("status") != "ok":
                blocked.append(f"{key}/{sess}: {rec.get('why')}")
            results[key].append(rec)
            g = (rec.get("gt") or {}).get("greedy") or {}
            e = (rec.get("gt") or {}).get("exhaustive") or {}
            print(f"  {key}/{sess}: agree {rec.get('n_agree')}/{rec.get('n_compared')}; "
                  f"misgrouped greedy {(g.get('frames') or 0) - (g.get('exact_match_frames') or 0)}"
                  f" exhaustive {(e.get('frames') or 0) - (e.get('exact_match_frames') or 0)}"
                  f" of {g.get('frames')}", flush=True)

    configs_out = []
    for cfg in plan:
        per_session = sorted(results[cfg["key"]], key=lambda r: r["session"])
        ok = [r for r in per_session if r.get("status") == "ok" and "gt" in r
              and "greedy" in r["gt"]]
        entry = {
            "key": cfg["key"], "animals": cfg["animals"],
            "cameras": len(cfg["cameras"]), "camera_names": cfg["cameras"],
            "dataset": cfg["dataset"],
            "session": (cfg["sessions"][0]["session"]
                        if len(cfg["sessions"]) == 1 else None),
            "sessions": [s["session"] for s in cfg["sessions"]],
            "n_sessions": len(ok),
            "n_sessions_planned": len(cfg["sessions"]),
        }
        if not ok:
            entry["status"] = "failed"
            entry["why"] = "no session produced a usable quality record"
            entry["per_session"] = per_session
            configs_out.append(entry)
            continue
        entry["n_compared"] = sum(r["n_compared"] for r in ok)
        entry["n_agree"] = sum(r["n_agree"] for r in ok)
        entry["agreement_rate"] = (entry["n_agree"] / entry["n_compared"]
                                   if entry["n_compared"] else None)
        entry["disagree_frames"] = [{"session": r["session"], "frame": fi}
                                    for r in ok for fi in r["disagree_frames"]]
        gt = {}
        for m in ("greedy", "exhaustive"):
            frames = sum(r["gt"][m]["frames"] for r in ok)
            exact = sum(r["gt"][m]["exact_match_frames"] for r in ok)
            pair_n = sum(r["gt"][m]["frames_with_pairs"] for r in ok)
            pair_s = sum(r["gt"][m].get("pair_accuracy_sum", 0.0) for r in ok)
            gt[m] = {
                "exact_match_frames": exact,
                "frames": frames,
                "exact_match_rate": (exact / frames) if frames else None,
                # Pooled over FRAMES across the config's sessions (sum of per-frame
                # pair fractions / number of such frames), not a mean of session
                # means, which would over-weight short sessions.
                "pair_accuracy_mean": (pair_s / pair_n) if pair_n else None,
                "frames_with_pairs": pair_n,
            }
        entry["gt"] = gt
        meta_keys = ["frames_evaluated", "frames_skipped_no_greedy",
                     "frames_skipped_out_of_range", "frames_no_matched_keys",
                     "detection_keys_total", "detection_keys_matched",
                     "detection_keys_unmatched_no_bbox",
                     "detection_keys_unmatched_low_iou"]
        entry["gt_matching"] = {k: sum(r["gt_matching"][k] for r in ok)
                                for k in meta_keys}
        entry["disagreement_detail"] = [d for r in ok for d in r["disagreement_detail"]]
        entry["per_session"] = [
            {"session": r["session"], "n_compared": r["n_compared"],
             "n_agree": r["n_agree"], "agreement_rate": r["agreement_rate"],
             "disagree_frames": r["disagree_frames"],
             "gt": r["gt"], "gt_matching": r["gt_matching"]}
            for r in ok]
        entry["status"] = "ok"
        configs_out.append(entry)

    out = {
        "generated_by": "figs/fig3_quality.py + figs/fig3-bench/fig3_rescore_frames.mjs "
                        "(inputs: figs/out/tmp/headtohead/<config>/<session>/"
                        "{greedy,exhaustive}.json from figs/fig3_headtohead.py)",
        "dataset": "both",
        "detection_pool": f"{hh.BM_DET} (BMimica, per-session), {hh.KEEPTRACK} (SLAP-2M, pooled)",
        "sessions": sorted({s for c in configs_out for s in c.get("sessions", [])}),
        "n_sessions": len({s for c in configs_out for s in c.get("sessions", [])}),
        "metric": "partition agreement + GT-grouping accuracy (IoU 0.5 match)",
        "caveats": CAVEATS,
        "blocked": blocked,
        "configs": configs_out,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_quality.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT_DIR / 'fig3_quality.json'}", flush=True)


if __name__ == "__main__":
    main()
