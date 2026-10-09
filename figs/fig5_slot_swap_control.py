#!/usr/bin/env python3
"""
Slot-swap control for the Figure 4 sex asymmetry.

WHY. In Mouse-Dyad-10M the male always occupies track slot 0 and the female slot 1
(verified against every session's track_names in fig5_upright.py). Sex is therefore
perfectly confounded with slot index, and any asymmetry in how the event detector or
the pre-onset features treat slot 0 and slot 1 would present as a sex difference. The
control re-runs `session_upright` on every session with the two slots swapped in the
input arrays (and the two track names swapped to match) and checks that the output is
the same set of displays with the roles reversed: identical start and end frames, the
initiator flipped, and every per-track feature of slot 0 equal to the swapped run's
slot 1 feature. A pipeline with no slot preference passes with a maximum difference of
zero.

Deposits data/fig5/fig5s_slot_swap_control.csv, one row per session plus a summary row.

    .venv/bin/python figs/fig5_slot_swap_control.py
"""
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fig5_upright as U  # noqa: E402
from src.style import deposit  # noqa: E402

#: (slot-0 field, slot-1 field) pairs that must exchange under the swap.
PAIRED = [("speed_bl_s_t0", "speed_bl_s_t1"), ("speed_rel_t0", "speed_rel_t1"),
          ("pursuit_rel_t0", "pursuit_rel_t1"), ("peak_mm_t0", "peak_mm_t1")]


def one(sd):
    ld = U._load(sd)
    if ld is None:
        return None
    t, fps, names, code = ld
    sid = os.path.basename(sd)
    r = U.session_upright(t, fps, names, code, sid)
    if r is None:
        return None
    rs = U.session_upright(np.ascontiguousarray(t[:, ::-1]), fps, names[::-1], code, sid)
    ev = sorted(r["events"], key=lambda e: e["start_frame"])
    es = sorted(rs["events"], key=lambda e: e["start_frame"])
    same_frames = ([(e["start_frame"], e["end_frame"]) for e in ev]
                   == [(e["start_frame"], e["end_frame"]) for e in es])
    init_flipped = all(
        (a["initiator_track"] is None and b["initiator_track"] is None)
        or (a["initiator_track"] is not None and b["initiator_track"] is not None
            and a["initiator_track"] == 1 - b["initiator_track"])
        for a, b in zip(ev, es))
    mx = 0.0
    for a, b in zip(ev, es):
        for k0, k1 in PAIRED:
            x, y = a[k0], b[k1]
            if x is None or y is None:
                if (x is None) != (y is None):
                    mx = np.inf
                continue
            if np.isfinite(x) and np.isfinite(y):
                mx = max(mx, abs(x - y))
            elif np.isfinite(x) != np.isfinite(y):
                mx = np.inf
    return {"session": sid, "n_events": r["n_events"], "n_events_swapped": rs["n_events"],
            "same_frames": same_frames, "initiator_flipped": init_flipped,
            "max_abs_diff_paired_fields": mx}


def main():
    sds = [d for d in sorted(glob.glob(f"{U.BMIMICA}/*")) if os.path.isdir(d)]
    with ProcessPoolExecutor(max_workers=14) as ex:
        rows = [r for r in ex.map(one, sds) if r]
    df = pd.DataFrame(rows)
    ok = bool(df.same_frames.all() and df.initiator_flipped.all()
              and (df.max_abs_diff_paired_fields == 0).all())
    summary = pd.DataFrame([{"session": "SUMMARY", "n_events": int(df.n_events.sum()),
                             "n_events_swapped": int(df.n_events_swapped.sum()),
                             "same_frames": bool(df.same_frames.all()),
                             "initiator_flipped": bool(df.initiator_flipped.all()),
                             "max_abs_diff_paired_fields": float(df.max_abs_diff_paired_fields.max())}])
    deposit(pd.concat([df, summary], ignore_index=True), 5, "fig5s_slot_swap_control.csv")
    print(f"{len(df)} sessions, {int(df.n_events.sum())} displays; "
          f"swap-invariant: {ok}; max |diff| = {df.max_abs_diff_paired_fields.max()}")


if __name__ == "__main__":
    main()
