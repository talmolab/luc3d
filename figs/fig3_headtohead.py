#!/usr/bin/env python
"""Task 3 — greedy (production tracker) vs exhaustive hypothesis-testing, head to head.

For each config (numAnimals A, cameras C), on IDENTICAL detections:
  - runs figs/fig3-bench/fig3_bench.mjs (the real production greedy tracker, default
    thresholds) over a frame window,
  - runs figs/fig3-bench/fig3_exhaustive.mjs (the paper's exhaustive hypothesis-testing
    method) over the SAME window,
  - compares, frame by frame (only frames exhaustive actually computed — i.e. every
    camera had exactly A clean detections and (A!)^C was under the hypothesis cap),
    whether the two methods picked the SAME PARTITION of detections into identity
    groups (label-invariant — this is the clean, threading-free comparison),
  - scores both against ground truth (figs/fig3_score.py, reusing evaluate.py) over
    the same window, for IDF1/switches.

Configs mirror the handoff's worked examples: 2x5=32, 2x6=64 (substituted for the
requested 2x8 — no 8-camera aggregated detection pool exists on this benchmark, see
caveats), 3x5=7,776 (tractable), 4x6=24^6=~1.9x10^8 (intractable, recorded analytically
only, per the handoff's explicit "do not attempt").

Output: figs/out/fig3_headtohead.json
"""
import json
import math
import subprocess
import sys
import time
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

BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
BM_SESSION = "20250829_124351"
BM_CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]

# Frame windows are overridable from the environment so the cheap configurations can
# be scaled up without editing this file: HH_MAX_A2_C5 / HH_MAX_A2_C6 / HH_MAX_A3_C5.
# The A=2 configs cost 8-15 ms/frame, so their original few-thousand-frame caps were a
# budget choice (from the handoff), not a limit of the method. A=3 costs 2.74 s/frame
# and A=4 is intractable at 1.9e8 hypotheses/frame -- those are real limits.
def _cap(key, default):
    import os as _os
    v = _os.environ.get("HH_MAX_" + key)
    return int(v) if v and v.isdigit() else default


CONFIGS = [
    {
        "key": "A2_C5_bmimica", "animals": 2, "cameras": BM_CAMS,
        "dataset": "BMimica", "session": BM_SESSION,
        "det_dir": str(BM_DET / BM_SESSION), "calibration": None,  # filled below
        "gt_dir": str(BM_GT / BM_SESSION), "gt_paths": None, "det_session_idx": 0,
        "max_frames": _cap("A2_C5", 5000), "note": "worked example 2x5=32 hyps/frame",
    },
    {
        "key": "A2_C6_slap2m", "animals": 2, "cameras": ["back", "backL", "mid", "midL", "top", "topL"],
        "dataset": "SLAP-2M", "session": None, "master_idx": 6,
        "max_frames": _cap("A2_C6", 3000),
        "note": "substituted for the handoff's 2x8 (256 hyps) worked example — no "
                "8-camera aggregated detection pool exists (side/sideL are only "
                "available as raw per-session .slp, not in the shared keeptrack_h5s/"
                "detections_only_h5s pool); 2x6=64 hyps/frame is the largest C we can "
                "run on identical, pool-fed detections.",
    },
    {
        "key": "A3_C5_slap2m", "animals": 3, "cameras": ["back", "backL", "mid", "midL", "top"],
        "dataset": "SLAP-2M", "session": None, "master_idx": 67,
        "max_frames": _cap("A3_C5", 200),
        "note": "worked example 3x5=7,776 hyps/frame (dropped topL to hit C=5 exactly "
                "as in the handoff's example; expensive per frame so window capped at 200 frames)",
    },
    {
        "key": "A4_C6_slap2m_hard", "animals": 4, "cameras": ["back", "backL", "mid", "midL", "top", "topL"],
        "dataset": "SLAP-2M", "session": None, "master_idx": 70,
        "max_frames": 0,
        "note": "the hard reference session (24^6 ~= 1.9e8 hyps/frame) — INTRACTABLE, "
                "per the handoff's explicit instruction. Not attempted; recorded analytically only.",
    },
]


def bm_calib():
    hits = glob(str(BMROOT / BM_SESSION / "calibration" / "*_calibration.toml"))
    return hits[0]


def resolve_slap2m(cfg, master_df):
    row = master_df.iloc[cfg["master_idx"]]
    cfg["session"] = str(row["session"])
    cfg["det_dir"] = str(KEEPTRACK)
    cfg["det_session_idx"] = cfg["master_idx"]
    cfg["calibration"] = row["calibration_toml"]
    cfg["gt_dir"] = None
    cfg["gt_paths"] = {c: row[f"{c}_proofread_h5"] for c in cfg["cameras"]}
    return cfg


def run_driver(cmd, timeout):
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            return None, "exit " + str(r.returncode) + ": " + r.stderr[-800:].replace("\n", " ")
        return time.time() - t0, None
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"


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


def main():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    master_df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)

    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs  # noqa: E402

    configs_out = []
    greedy_totals = {"idf1_within": [], "idf1_cross": [], "switches": 0}
    exh_totals = {"idf1_within": [], "idf1_cross": [], "switches": 0}
    total_frames_compared, total_agree = 0, 0
    blocked = []
    caveats = [
        "Exhaustive is a PURE PER-FRAME procedure (as described in the paper) with no "
        "cross-frame identity mechanism; to make IDF1/switches computable at all for it, "
        "fig3_exhaustive.mjs threads identity across frames via nearest-3D-centroid "
        "Hungarian matching to the previous computed frame. This threading is NOT part "
        "of the association decision and is disclosed here — the clean, threading-free "
        "comparison is agreement_rate (does exhaustive choose the same partition of "
        "detections as greedy, using only the paper's actual per-frame method).",
        "A frame only enters the exhaustive computation if every included camera has "
        "EXACTLY `animals` non-null detections that frame (so 'A! per view' is well "
        "posed); frames with occlusion/misses/extra false positives are skipped and "
        "counted (framesConsidered vs framesClean vs framesComputed per config), not "
        "silently dropped.",
        "The A2_C6 config substitutes for the handoff's suggested A2_C8 — see per-config "
        "note; no 8-camera-synchronized aggregated detection pool exists in this benchmark.",
        "A3_C5's frame window is capped at 200 frames (not thousands) because each frame "
        "costs 7,776 hypotheses x 3 triangulate+reproject calls; this is a real, measured "
        "per-frame cost tradeoff, disclosed rather than hidden.",
    ]

    for cfg in CONFIGS:
        print(f"=== config {cfg['key']} ===", flush=True)
        if cfg["dataset"] == "SLAP-2M":
            resolve_slap2m(cfg, master_df)
        else:
            cfg["calibration"] = bm_calib()

        hyps_per_frame = math.factorial(cfg["animals"]) ** len(cfg["cameras"])
        entry = {
            "cameras": len(cfg["cameras"]), "animals": cfg["animals"],
            "hypotheses": hyps_per_frame, "status": None,
            "seconds_per_frame_exhaustive": None, "dataset": cfg["dataset"],
            "session": cfg["session"], "note": cfg["note"],
        }

        if hyps_per_frame > MAX_HYPOTHESES or cfg["max_frames"] == 0:
            entry["status"] = "intractable"
            configs_out.append(entry)
            print(f"  intractable: {hyps_per_frame:,} hyps/frame > cap {MAX_HYPOTHESES:,} (or max_frames=0)", flush=True)
            continue

        cell_dir = TMP_DIR / cfg["key"]
        cell_dir.mkdir(parents=True, exist_ok=True)
        greedy_out = cell_dir / "greedy.json"
        exh_out = cell_dir / "exhaustive.json"

        greedy_cmd = [
            "node", str(GREEDY_DRIVER),
            "--session-idx", str(cfg["det_session_idx"]), "--num-animals", str(cfg["animals"]),
            "--calibration", cfg["calibration"], "--pred-h5-dir", cfg["det_dir"],
            "--out", str(greedy_out), "--cameras", ",".join(cfg["cameras"]),
            "--max-frames", str(cfg["max_frames"]),
        ]
        exh_cmd = [
            "node", str(EXH_DRIVER),
            "--session-idx", str(cfg["det_session_idx"]), "--num-animals", str(cfg["animals"]),
            "--calibration", cfg["calibration"], "--pred-h5-dir", cfg["det_dir"],
            "--out", str(exh_out), "--cameras", ",".join(cfg["cameras"]),
            "--max-frames", str(cfg["max_frames"]), "--max-hypotheses", str(MAX_HYPOTHESES),
        ]

        t_g, err_g = run_driver(greedy_cmd, timeout=1200)
        if err_g:
            entry["status"] = "failed"
            entry["why"] = "greedy driver: " + err_g
            configs_out.append(entry)
            blocked.append(f"{cfg['key']}: greedy driver failed: {err_g}")
            print(f"  FAILED (greedy): {err_g}", flush=True)
            continue

        t_e, err_e = run_driver(exh_cmd, timeout=3600)
        if err_e:
            entry["status"] = "failed"
            entry["why"] = "exhaustive driver: " + err_e
            configs_out.append(entry)
            blocked.append(f"{cfg['key']}: exhaustive driver failed: {err_e}")
            print(f"  FAILED (exhaustive): {err_e}", flush=True)
            continue

        exh_json = json.loads(exh_out.read_text())
        greedy_json = json.loads(greedy_out.read_text())
        entry["status"] = "ok"
        entry["seconds_per_frame_exhaustive"] = exh_json["secondsPerComputedFrame"]
        entry["frames_considered"] = exh_json["framesConsidered"]
        entry["frames_clean"] = exh_json["framesClean"]
        entry["frames_computed"] = exh_json["framesComputed"]
        configs_out.append(entry)

        n_agree, n_compared = agreement_rate(exh_json, greedy_json)
        total_agree += n_agree
        total_frames_compared += n_compared
        print(f"  agreement {n_agree}/{n_compared} frames "
              f"(considered={exh_json['framesConsidered']} clean={exh_json['framesClean']} "
              f"computed={exh_json['framesComputed']}, {exh_json['secondsPerComputedFrame']:.4f}s/frame)",
              flush=True)

        # Score both against GT, restricted to this config's max_frames window.
        try:
            g_score = fs.score_session(str(greedy_out), cfg["det_dir"], cfg["gt_dir"], cfg["cameras"],
                                        cfg["animals"], max_frames=cfg["max_frames"],
                                        det_session_idx=cfg["det_session_idx"], gt_paths=cfg["gt_paths"])
            e_score = fs.score_session(str(exh_out), cfg["det_dir"], cfg["gt_dir"], cfg["cameras"],
                                        cfg["animals"], max_frames=cfg["max_frames"],
                                        det_session_idx=cfg["det_session_idx"], gt_paths=cfg["gt_paths"])
            greedy_totals["idf1_within"].append(g_score["within_idf1"])
            greedy_totals["idf1_cross"].append(g_score["cross_idf1"])
            greedy_totals["switches"] += g_score["within_switches"]
            exh_totals["idf1_within"].append(e_score["within_idf1"])
            exh_totals["idf1_cross"].append(e_score["cross_idf1"])
            exh_totals["switches"] += e_score["within_switches"]
            print(f"  greedy IDF1 within={g_score['within_idf1']:.3f} cross={g_score['cross_idf1']:.3f} "
                  f"sw={g_score['within_switches']} | exhaustive IDF1 within={e_score['within_idf1']:.3f} "
                  f"cross={e_score['cross_idf1']:.3f} sw={e_score['within_switches']}", flush=True)
        except Exception as e:
            blocked.append(f"{cfg['key']}: scoring failed: {e}")
            print(f"  scoring FAILED: {e}", flush=True)

    def mean_or_none(xs):
        return float(sum(xs) / len(xs)) if xs else None

    out = {
        "generated_by": "figs/fig3_headtohead.py + figs/fig3-bench/fig3_exhaustive.mjs",
        "dataset": "both",
        "detection_pool": f"{BM_DET} (BMimica), {KEEPTRACK} (SLAP-2M)",
        "sessions": [c["session"] for c in CONFIGS if c.get("session")],
        "metric": "IDF1 (motmetrics) + ID-switches",
        "caveats": caveats,
        "blocked": blocked,
        "frames_compared": total_frames_compared,
        "agreement_rate": (total_agree / total_frames_compared) if total_frames_compared else None,
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
        "caps": {"max_hypotheses_per_frame": MAX_HYPOTHESES,
                 "max_frames": {c["key"]: c["max_frames"] for c in CONFIGS}},
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_headtohead.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT_DIR / 'fig3_headtohead.json'}", flush=True)


if __name__ == "__main__":
    main()
