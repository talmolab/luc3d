#!/usr/bin/env python
"""Tasks 2 + 5 — runtime/complexity and accuracy-vs-scale, sharing one real-run grid.

Measures REAL wall-clock seconds/frame of the production tracker
(figs/fig3-bench/fig3_bench.mjs, default thresholds — i.e. what the app ships) as a
function of (cameras C, animals A), on a fixed detection pool (same detections across
cells — this measures association cost, not decoding). The SAME runs are scored against
ground truth (figs/fig3_score.py) for Task 5's IDF1-vs-scale numbers, so the two figures
are numerically consistent with each other rather than independently re-measured.

Camera axis: progressive real subsets of the 6-camera SLAP-2M shared detection pool
(back, backL, mid, midL, top, topL) — see caveats for why C stops at 6, not 8.
Animal axis: BMimica (A=2, its own 5-camera rig) + SLAP-2M sessions with A=2,3,4
(the only animal counts present in the corpus, per sleap_nn_master_sheet.tsv).

Outputs: figs/out/fig3_runtime.json, figs/out/fig3_scale.json
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
DRIVER = REPO / "figs" / "fig3-bench" / "fig3_bench.mjs"
OUT_DIR = REPO / "figs" / "out"
TMP_DIR = OUT_DIR / "tmp" / "scale_runtime"

MASTER = BENCH / "outputs" / "sleap_nn_master_sheet.tsv"
KEEPTRACK = BENCH / "outputs" / "keeptrack_h5s"
BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
BM_SESSION = "20250827_141755"
BM_CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]

MAX_FRAMES = 3000
MAX_HYPOTHESES = 1_000_000
ALL_SLAP_CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
SLAP_SESSIONS_BY_ANIMALS = {2: 6, 3: 67, 4: 70}  # master-sheet row idx


def bm_calib():
    hits = glob(str(BMROOT / BM_SESSION / "calibration" / "*_calibration.toml"))
    return hits[0]


def run_one(cell_key, calib, det_dir, det_session_idx, cameras, num_animals, max_frames):
    cell_dir = TMP_DIR / cell_key
    cell_dir.mkdir(parents=True, exist_ok=True)
    out_path = cell_dir / "result.json"
    cmd = [
        "node", str(DRIVER),
        "--session-idx", str(det_session_idx), "--num-animals", str(num_animals),
        "--calibration", calib, "--pred-h5-dir", det_dir,
        "--out", str(out_path), "--cameras", ",".join(cameras),
        "--max-frames", str(max_frames),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0 or not out_path.exists():
            return None, "driver exit " + str(r.returncode) + ": " + r.stderr[-500:].replace("\n", " ")
        return out_path, None
    except subprocess.TimeoutExpired:
        return None, "driver timed out after 600s"


def main():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    master_df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)

    sys.path.insert(0, str(REPO / "figs"))
    import fig3_score as fs  # noqa: E402

    cells = []
    # BMimica: fixed C=5, A=2 (its own rig; can't subset cameras beyond what exists).
    cells.append({
        "key": "bmimica_A2_C5", "dataset": "BMimica", "animals": 2,
        "cameras": BM_CAMS, "det_dir": str(BM_DET / BM_SESSION), "det_session_idx": 0,
        "calibration": bm_calib(), "gt_dir": str(BM_GT / BM_SESSION), "gt_paths": None,
        "session": BM_SESSION,
    })
    # SLAP-2M: for each animal count, progressive real camera subsets C=2..6.
    for animals, midx in SLAP_SESSIONS_BY_ANIMALS.items():
        row = master_df.iloc[midx]
        for c in range(2, len(ALL_SLAP_CAMS) + 1):
            cams = ALL_SLAP_CAMS[:c]
            cells.append({
                "key": f"slap2m_A{animals}_C{c}", "dataset": "SLAP-2M", "animals": animals,
                "cameras": cams, "det_dir": str(KEEPTRACK), "det_session_idx": midx,
                "calibration": row["calibration_toml"],
                "gt_dir": None, "gt_paths": {cc: row[f"{cc}_proofread_h5"] for cc in cams},
                "session": str(row["session"]),
            })

    measured = []
    points = []
    blocked = [
        "Camera axis capped at C=6 (not the requested C up to 8): SLAP-2M's shared, "
        "pool-fed aggregated detection H5s (outputs/keeptrack_h5s, outputs/"
        "detections_only_h5s) only cover 6 cameras (back/backL/mid/midL/top/topL). "
        "side/sideL exist only as raw per-session .slp files in a separate, "
        "non-overlapping session subset (outputs/side_detections/), not as an "
        "aggregated tracks H5 in the shared pool used by the champion-config "
        "benchmark — converting them would mean scoring on a DIFFERENT detection "
        "pool than every other point in this grid, breaking the 'same detections "
        "everywhere' fairness rule this whole benchmark rests on. C=7,8 are not "
        "measured rather than approximated from a mismatched pool.",
    ]

    for cell in cells:
        print(f"=== {cell['key']} (A={cell['animals']} C={len(cell['cameras'])}) ===", flush=True)
        t0 = time.time()
        out_path, err = run_one(cell["key"], cell["calibration"], cell["det_dir"],
                                 cell["det_session_idx"], cell["cameras"], cell["animals"], MAX_FRAMES)
        if err:
            measured.append({"cameras": len(cell["cameras"]), "animals": cell["animals"],
                              "seconds_per_frame": None, "frames": 0, "session": cell["session"],
                              "status": "failed", "why": err})
            points.append({"cameras": len(cell["cameras"]), "animals": cell["animals"],
                            "idf1_within": None, "idf1_cross": None,
                            "exhaustive_computable": None, "hypotheses": None,
                            "status": "failed", "why": err})
            print(f"  FAILED: {err}", flush=True)
            continue

        result = json.loads(out_path.read_text())
        spf = result["runtimeSeconds"] / max(1, result["framesProcessed"])
        measured.append({
            "cameras": len(cell["cameras"]), "animals": cell["animals"],
            "seconds_per_frame": spf, "frames": result["framesProcessed"],
            "session": cell["session"], "status": "ok",
        })
        print(f"  runtime: {spf*1000:.3f} ms/frame over {result['framesProcessed']} frames "
              f"({time.time()-t0:.1f}s wall)", flush=True)

        hyps = math.factorial(cell["animals"]) ** len(cell["cameras"])
        try:
            score = fs.score_session(str(out_path), cell["det_dir"], cell["gt_dir"], cell["cameras"],
                                      cell["animals"], max_frames=MAX_FRAMES,
                                      det_session_idx=cell["det_session_idx"], gt_paths=cell["gt_paths"])
            points.append({
                "cameras": len(cell["cameras"]), "animals": cell["animals"],
                "idf1_within": score["within_idf1"], "idf1_cross": score["cross_idf1"],
                "exhaustive_computable": hyps <= MAX_HYPOTHESES, "hypotheses": hyps,
                "status": "ok",
            })
            print(f"  IDF1 within={score['within_idf1']:.3f} cross={score['cross_idf1']:.3f} "
                  f"(hyps={hyps:,}, exhaustive_computable={hyps <= MAX_HYPOTHESES})", flush=True)
        except Exception as e:
            points.append({"cameras": len(cell["cameras"]), "animals": cell["animals"],
                            "idf1_within": None, "idf1_cross": None,
                            "exhaustive_computable": hyps <= MAX_HYPOTHESES, "hypotheses": hyps,
                            "status": "failed", "why": f"scoring failed: {e}"})
            print(f"  scoring FAILED: {e}", flush=True)

    # Analytic exhaustive cost table — pure arithmetic, covers the full grid
    # INCLUDING unmeasured C=7,8 (labelled analytic, not a measurement).
    analytic = []
    for animals in [2, 3, 4]:
        for c in range(2, 9):
            analytic.append({"cameras": c, "animals": animals, "hypotheses": math.factorial(animals) ** c})

    runtime_out = {
        "generated_by": "figs/fig3_scale_runtime.py",
        "dataset": "both",
        "detection_pool": f"{KEEPTRACK} (SLAP-2M), {BM_DET} (BMimica)",
        "sessions": sorted(set(c["session"] for c in cells)),
        "metric": "wall-clock seconds/frame (association only, fixed detection pool)",
        "caveats": [
            f"Each cell measured over a fixed leading window of up to {MAX_FRAMES} frames "
            "(>= the handoff's 500-frame minimum); seconds_per_frame is runCrossViewTracker's "
            "own wall-clock, excluding H5 loading/slicing IO, so it isolates association cost "
            "from decoding as instructed.",
            "Detection pool is identical across all camera-subset cells for a given animal "
            "count (progressive real subsets of the same 6-camera pool), so seconds_per_frame "
            "differences reflect C alone, not detector/data differences.",
        ],
        "blocked": blocked,
        "measured": measured,
        "analytic_exhaustive": analytic,
    }
    scale_out = {
        "generated_by": "figs/fig3_scale_runtime.py",
        "dataset": "both",
        "detection_pool": f"{KEEPTRACK} (SLAP-2M), {BM_DET} (BMimica)",
        "sessions": sorted(set(c["session"] for c in cells)),
        "metric": "IDF1 (motmetrics) + ID-switches",
        "caveats": [
            "Reuses Task 2's exact runs (same cells, same detections) so the runtime and "
            "accuracy figures are consistent with each other.",
            "exhaustive_computable uses the same 10^6 hypotheses/frame cap as Task 3 "
            "(fig3_headtohead.json) — it marks whether the exhaustive method COULD be run "
            "at this (C,A), not whether it was.",
            f"Each cell scored over the same leading {MAX_FRAMES}-frame window as Task 2.",
        ] + blocked,
        "blocked": [],
        "points": points,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_runtime.json").write_text(json.dumps(runtime_out, indent=2))
    (OUT_DIR / "fig3_scale.json").write_text(json.dumps(scale_out, indent=2))
    print(f"wrote {OUT_DIR / 'fig3_runtime.json'} and {OUT_DIR / 'fig3_scale.json'}", flush=True)


if __name__ == "__main__":
    main()
