#!/usr/bin/env python3
"""Measure ONE fig2 session and write it to its own JSON.

Thin driver around fig2_measure.measure_session -- the measurement itself is
untouched; this only replaces the serial `for sid in sids` loop in main() so the
50 sessions can run one-per-process.

    python fig2_one.py <session_id> <stride> <out.json>
"""
import json
import os
import sys
import time

HERE = "/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs"
sys.path.insert(0, HERE)

import fig2_measure as fm  # noqa: E402


def main():
    sid, stride, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    t0 = time.time()
    try:
        r = fm.measure_session(sid, stride)
    except Exception as e:  # noqa: BLE001
        print(f"{sid}: FAIL {type(e).__name__}: {e}", flush=True)
        raise SystemExit(2)
    dt = time.time() - t0
    if r is None:
        print(f"{sid}: skip (missing inputs / too little overlap)  {dt:.1f}s",
              flush=True)
        raise SystemExit(3)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as f:
        json.dump(r, f, indent=1)
    print(f"{sid}: K={r['keypoints_used']} retained={r['retained_frac']:.3f} "
          f"held-out p50={r['held_out'].get('p50', float('nan')):.2f}px "
          f"frames_used={r['frames_used']} stride={stride}  {dt:.1f}s", flush=True)


if __name__ == "__main__":
    main()
