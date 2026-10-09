#!/usr/bin/env python
"""Fig 4C's (g, m) histogram split BY NODE, to ask which keypoints drive the misses.

Same loaders, matching (fig4_detections.match_frame_wise, stride 1) and (g, m)
counting as fig4_recovery.session_histogram -- the only change is that the
histogram is kept per node, hist[node, g, m], so the surface can be recomputed
for any node subset (e.g. without the tail) with fig4_recovery.surface_from_hist.

    $PY figs/fig4_recovery_pernode.py --pilot
    $PY figs/fig4_recovery_pernode.py --workers 12

Output: figs/out/fig4_recovery_pernode.json  {session: {"hist": [N][7][7], "n_cameras"}}
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
OUT = FIGS / "out"


def session_histogram_pernode(row, sidx):
    import fig4_detections as f6
    sd = os.path.join(f6.SLAP_ROOT, os.path.dirname(row["points_3D"]))
    calib_p = os.path.join(sd, "calibration.toml")
    if not os.path.exists(calib_p):
        return None, "no calibration"
    cams_all = f6.load_calibration(calib_p)
    use = [c for c in f6.CAMS if c in cams_all and (row.get(f"{c}_reproj_h5") or "")]
    if len(use) < 3:
        return None, f"only {len(use)} usable cameras"
    gt_mask, det_mask, F_min = [], [], None
    for c in use:
        rp = row[f"{c}_reproj_h5"]
        rp = rp if os.path.isabs(rp) else os.path.join(f6.SLAP_ROOT, rp)
        if not os.path.exists(rp):
            return None, f"missing reproj h5 for {c}"
        R = f6.load_reference(rp, 1)
        raw, _sc = f6.load_raw(c, sidx, 1, R.shape[0])
        F = min(R.shape[0], raw.shape[0])
        m, _which = f6.match_frame_wise(raw[:F], R[:F])
        gt_mask.append(np.isfinite(R[:F, :, :, 0]))
        det_mask.append(np.isfinite(m[..., 0]))
        F_min = F if F_min is None else min(F_min, F)
    G = np.stack([g[:F_min] for g in gt_mask], axis=-1)     # (F, T, N, C)
    D = np.stack([d[:F_min] for d in det_mask], axis=-1) & G
    N = G.shape[2]
    g = G.sum(axis=-1)                                      # (F, T, N)
    m = D.sum(axis=-1)
    hist = np.zeros((N, 7, 7), dtype=np.int64)
    node = np.broadcast_to(np.arange(N)[None, None, :], g.shape)
    np.add.at(hist, (node.ravel(), g.ravel(), m.ravel()), 1)
    return {"hist": hist.tolist(), "n_cameras": int(G.shape[-1]), "n_nodes": int(N)}, None


def _job(args):
    row, sidx = args
    try:
        h, err = session_histogram_pernode(row, sidx)
        return row["session"], h, err
    except Exception as e:  # noqa: BLE001
        return row["session"], None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--pilot", action="store_true")
    a = ap.parse_args()
    import pandas as pd
    import fig4_detections as f6
    df = pd.read_csv(f6.MASTER, sep="\t").reset_index(drop=True)
    jobs = [(r, i) for i, r in df.iterrows()]
    if a.pilot:
        jobs = jobs[:1]
    print(f"[rec/node] {len(jobs)} sessions, {a.workers} workers", flush=True)
    t0 = time.time()
    res, errs = {}, []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(_job, j) for j in jobs]), 1):
            sid, h, err = f.result()
            if err:
                errs.append(f"{sid}: {err}")
                print(f"[rec/node] FAILED {sid}: {err}", flush=True)
            else:
                res[sid] = h
                print(f"[rec/node] {sid} ok ({i}/{len(jobs)}, {time.time()-t0:.0f}s)", flush=True)
    det = json.loads((OUT / "fig6_detections.json").read_text())
    diff = {s["session"]: s.get("difficulty") for s in det["sessions"]}
    # FIG4_REC_TAG (2026-10-08): tagged output for another FIG4_POOL, so the base deposit
    # (keeptrack) is never overwritten
    tag = os.environ.get("FIG4_REC_TAG", "")
    out = OUT / ("fig4_recovery_pernode_pilot.json" if a.pilot
                 else f"fig4_recovery_pernode{'_' + tag if tag else ''}.json")
    out.write_text(json.dumps({"generated_by": "figs/fig4_recovery_pernode.py",
                               "histograms": res, "difficulty": diff, "failures": errs}))
    print(f"[rec/node] wrote {out} ({len(res)} sessions, {len(errs)} failures)")


if __name__ == "__main__":
    main()
