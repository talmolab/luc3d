#!/usr/bin/env python
"""CONSISTENCY-PLAN S4 (2026-10-19): every SLAP-2M arm Fig 6c b-d reads (LUC3D, SLEAP sleapnt,
ByteTrack) is scored over the same 74 sessions, 444 camera-sessions and 11,726,640 camera-frames.

Source: out/fig6_slap2m_fair_sleapnt_percam.csv (the `slap2m_fair` block of
fig7_variant_best_c6b3.json names it). Per (session, camera) the motmetrics `num_frames` and the GT
`num_objects` must be identical across the three trackers. Writes out/s4_frame_gate.json.
"""
import csv, json, sys
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
SRC = OUT / "fig6_slap2m_fair_sleapnt_percam.csv"
WANT = {"sessions": 74, "camera_sessions": 444, "camera_frames": 11_726_640}
cells = defaultdict(dict)
for r in csv.DictReader(SRC.open()):
    cells[(r["session"], r["camera"])][r["tracker"]] = (int(r["num_frames"]), int(float(r["num_objects"])))
arms = sorted({t for v in cells.values() for t in v})
bad = [{"session": s, "camera": c, **{t: v.get(t) for t in arms}}
       for (s, c), v in cells.items() if set(v) != set(arms) or len(set(v.values())) != 1]
tot = {t: sum(v[t][0] for v in cells.values() if t in v) for t in arms}
got = {"sessions": len({s for s, _ in cells}), "camera_sessions": len(cells)}
ok = (not bad and got["sessions"] == WANT["sessions"] and got["camera_sessions"] == WANT["camera_sessions"]
      and all(x == WANT["camera_frames"] for x in tot.values()))
out = {"generated_by": "figs/s4_frame_gate.py", "source": SRC.name, "arms": arms, **got,
       "camera_frames_by_arm": tot, "expected": WANT, "mismatches": bad, "passed": ok}
(OUT / "s4_frame_gate.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k != "mismatches"}), "mismatches:", len(bad))
sys.exit(0 if ok else 1)
