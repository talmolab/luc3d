#!/usr/bin/env python
"""Exhaustive enumeration's identity numbers on the 50 BMimica sessions alone,
as the reference level for the r-sweep panel (Fig 3d).

    ############################################################################
    WHY PER-CORPUS. The sweep panel's axes are 50 BMimica sessions with a
    45,021,960 camera-frame denominator. The only aggregated exhaustive figure on
    disk (`fig3_headtohead.json`: within 0.3777, 22,290 switches) pools 92
    sessions across BOTH corpora with two configurations frame-capped -- putting
    that on a BMimica-only axis is the same corpus-mixing error already fixed in
    Fig 7. This walks the 50 per-session `score.json` files the head-to-head
    harness already wrote (`out/tmp/headtohead/A2_C5_bmimica/<session>/`), so it
    is an AGGREGATION of an existing measurement, not a new one: the same scoring
    produced fig3_headtohead.json's numbers.

    THE DENOMINATOR CAVEAT, stated because the panel must not hide it: exhaustive
    runs only on CLEAN frames (every camera holds exactly A detections) -- on
    BMimica that is 4,324,469 of 9,004,392 video frames. Its switch count is
    therefore deposited with ITS OWN camera-frame denominator (clean x 5), and
    the panel's reference line uses that rate. Scoring its switches against the
    full-session denominator would flatter it (fewer opportunities to switch);
    scoring the greedy arms against the clean denominator would change every
    published curve. Two denominators, each labelled, is the honest form.
    ############################################################################

    $PY figs/fig3_exhaustive_bmimica.py

Output: figs/out/fig3_exhaustive_bmimica.json
"""
import json
from pathlib import Path

import numpy as np

FIGS = Path(__file__).resolve().parent
CACHE = FIGS / "out" / "tmp" / "headtohead" / "A2_C5_bmimica"
OUT = FIGS / "out" / "fig3_exhaustive_bmimica.json"
N_CAMERAS = 5


def main():
    rows = []
    for sdir in sorted(p for p in CACHE.iterdir() if p.is_dir()):
        sc = sdir / "score.json"
        ex = sdir / "exhaustive.json"
        if not (sc.exists() and ex.exists()):
            continue
        s = json.loads(sc.read_text())["exhaustive"]
        e = json.loads(ex.read_text())
        rows.append({"session": sdir.name,
                     "idf1_within": s["idf1_within"],
                     "idf1_cross": s["idf1_cross"],
                     "switches": s["switches"],
                     "cross_switches": s["cross_switches"],
                     "frames_computed": e["framesComputed"],
                     "frames_considered": e["framesConsidered"]})
    if len(rows) != 50:
        raise SystemExit(f"[exh] {len(rows)} sessions with scores, expected 50 -- "
                         f"refusing to deposit a partial corpus as if it were whole")

    w = np.array([r["idf1_within"] for r in rows])
    c = np.array([r["idf1_cross"] for r in rows])
    sw = sum(r["switches"] for r in rows)
    frames = sum(r["frames_computed"] for r in rows)
    camframes = frames * N_CAMERAS
    out = {
        "generated_by": "figs/fig3_exhaustive_bmimica.py",
        "claim": "Exhaustive enumeration's IDF1 and switch count restricted to the "
                 "50 BMimica sessions, aggregated from the head-to-head harness's own "
                 "per-session score.json files. No new tracking or scoring.",
        "n_sessions": len(rows),
        "idf1_within_mean": float(w.mean()),
        "idf1_within_median": float(np.median(w)),
        "idf1_cross_mean": float(c.mean()),
        "switches_total": int(sw),
        "frames_computed_total": int(frames),
        "camera_frames_computed": int(camframes),
        "switches_per_100k_camera_frames": float(sw / camframes * 1e5),
        "denominator_note": "clean frames only (every camera holds exactly 2 "
                            "detections): 4.32M of 9.00M video frames. The sweep "
                            "panel's greedy curves use the full-session 45,021,960 "
                            "camera-frame denominator; the two rates are labelled.",
        "per_session": rows,
    }
    OUT.write_text(json.dumps(out, indent=1))
    print(f"[exh] 50 BMimica sessions: within {out['idf1_within_mean']:.4f} "
          f"(median {out['idf1_within_median']:.4f})  cross "
          f"{out['idf1_cross_mean']:.4f}  switches {sw:,} over {camframes:,} "
          f"clean camera-frames = {out['switches_per_100k_camera_frames']:.1f}/100k")
    print(f"[exh] wrote {OUT}")


if __name__ == "__main__":
    main()
