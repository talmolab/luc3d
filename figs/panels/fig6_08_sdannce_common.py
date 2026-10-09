#!/usr/bin/env python3
"""
Shared loader for Fig 6's social-DANNCE panels (g, h, i).

The benchmark itself is `figs/fig10-bench/` (restored 2026-10-03 from commit
852588f, where it was deleted in the 2026-08-26 renumbering). Its per-session
results are `results/agg/summary.csv` (one row per session per condition cell)
and `results/agg/panel_10f_merge.json` (per-session proximity at sigma = 0).

ONLY NOISE-FREE CELLS ARE READ HERE. The benchmark also ran pixel-noise and
dropout cells; Fig 6 shows the geometry-only result (Talmo, 2026-10-02), so
those cells stay in the deposit and out of the artwork.

SCN2A is two deposit families, soc1 and soc3 (SOC2 publishes no files
upstream). They are pooled as one dataset here, as in the old Fig 10.
"""
import csv
import json
from pathlib import Path

FIGS = Path(__file__).resolve().parent.parent
AGG = FIGS / "fig10-bench" / "results" / "agg"

#: deposit family -> printed dataset name
FAMILY = {"triads": "TRIADS", "bedding": "BEDDING", "soc1": "SCN2A", "soc3": "SCN2A"}
DATASETS = ["TRIADS", "BEDDING", "SCN2A"]
ANIMALS = {"TRIADS": 3, "BEDDING": 2, "SCN2A": 2}

#: full rig, no noise, no dropout
FULL_RIG = "C1_sigma0"
#: camera-count cells at no noise; the full 6-camera rig is FULL_RIG
CAMERA_CELLS = {2: "C7c_cams2_sigma0", 3: "C7c_cams3_sigma0",
                4: "C7c_cams4_sigma0", 5: "C7c_cams5_sigma0", 6: FULL_RIG}

#: A session counts as perfect at this IDF1. Not 1.0 exactly: one session
#: scores 0.999998 (2 of 1,068,000 detections, no switch).
PERFECT = 0.9999


def cell(name):
    """Rows of one condition cell, with `dataset`, `idf1`, `switches` typed."""
    rows = []
    with open(AGG / "summary.csv") as f:
        for r in csv.DictReader(f):
            if r["cell"] != name:
                continue
            rows.append({"dataset": FAMILY[r["dataset"]],
                         "session": r["session_name"],
                         "idf1": float(r["idf1"]),
                         "switches": int(r["switches"]),
                         "n_gt_dets": int(r["n_gt_dets"])})
    if len(rows) != 41:
        raise SystemExit(f"{name}: expected 41 sessions, found {len(rows)}")
    return rows


def proximity():
    """Per-session close-contact exposure and sigma = 0 result."""
    rows = json.loads((AGG / "panel_10f_merge.json").read_text())
    for r in rows:
        r["dataset"] = FAMILY[r["dataset"]]
    return rows


def swap_distance():
    """session -> closest approach (mm) of the two swapped animals' source 3D
    tracks within 50 frames of the swap. From `results/agg/swapdiag/`, one file
    per session with a swap at sigma = 0. This is the distance at the event; the
    session-wide minimum in `panel_10f_merge.json` can be far from it (BEDDING
    F6_F2: 4.7 mm session minimum, 45.1 mm at the swap)."""
    out = {}
    for f in sorted((AGG / "swapdiag").glob("*.json")):
        d = json.loads(f.read_text())
        name = Path(d["session"]).name
        out[name] = min(e["min_dist_within_50f_mm"] for e in d["events"])
    return out
