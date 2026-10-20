#!/usr/bin/env python
"""CONSISTENCY-PLAN M6 (2026-10-19): do LUC3D, SLEAP and ByteTrack score Mouse-Dyad over the
SAME camera-frames, per session and camera?

Each scorer's frame count, from the code that produced the b3 deposits:
  LUC3D      fig3_score.score_session: nf = min(GT frames, det_h5_bvis5 frames)
             (fig8_methods_50_b3.json camera_frames_by_session records it)
  SLEAP      fig6_sleap_scoped.score_session: nf = GT frames (missing output frames are misses)
  ByteTrack  fig6_bytetrack_max2.score_session: nf = min(GT frames, bytetrack_noretire_b3 frames)
Shape reads only. Writes out/m6_frame_gate_b3.json.
"""
import json, sys
from pathlib import Path
import h5py

FIGS = Path(__file__).resolve().parent
BM = Path("/root/vast/eric/luc3d-bench/outputs/bmimica")
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]
luc = json.loads((FIGS / "out" / "fig8_methods_50_b3.json").read_text())
rows, bad = [], []
for s in luc["sessions"]:
    for c in SER:
        with h5py.File(BM / "gt" / s / c / "proofread.analysis.h5", "r") as f:
            g = f["tracks"].shape[-1]
        with h5py.File(BM / "det_h5_bvis5" / s / f"{c}_predictions.h5", "r") as f:
            d = f["tracks"].shape[1]
        with h5py.File(BM / "results" / "bytetrack_noretire_b3" / s / f"{c}.h5", "r") as f:
            b = f["tracks"].shape[0]
        r = {"session": s, "camera": c, "luc3d": min(g, d), "luc3d_deposit": luc["camera_frames_by_session"][s][c],
             "sleap": g, "bytetrack": min(g, b), "gt": g, "det": d, "bytetrack_out": b}
        rows.append(r)
        if not (r["luc3d"] == r["luc3d_deposit"] == r["sleap"] == r["bytetrack"]):
            bad.append(r)
tot = {k: sum(r[k] for r in rows) for k in ("luc3d", "sleap", "bytetrack")}
out = {"generated_by": "figs/m6_frame_gate.py", "n_sessions": len(luc["sessions"]), "n_camera_sessions": len(rows),
       "totals": tot, "mismatches": bad, "passed": not bad}
(FIGS / "out" / "m6_frame_gate_b3.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k != "mismatches"}), "mismatches:", len(bad))
for r in bad[:10]:
    print("  ", r)
sys.exit(0 if not bad else 1)
