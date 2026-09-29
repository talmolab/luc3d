#!/usr/bin/env python
"""Is Mouse-Dyad-10M's lower within-view IDF1 (Supp. Fig 6A vs 6B) a SESSION-LENGTH effect?

Mouse-Dyad-10M camera-sessions are ~180,200 frames; SLAP-2M's are ~18,000. IDF1 charges
every frame an identity stays wrong, so an unrecovered swap costs ~10x more frames in a
long session. Test: score the SAME Mouse-Dyad tracker outputs over the full session AND
over consecutive 18,000-frame windows (each window its own accumulator, so each window's
optimal GT<->hypothesis matching is re-solved -- exactly what a SLAP-2M-length session
gets), for all three trackers, with ONE convention for all of them -- the SLAP-2M one
(`luc3d-bench/scripts/evaluate.py`: GT masked by track occupancy, boxes from
`bbox_from_kpts`, IoU 0.5).

Arms (the Supp. Fig 6A arms):
    luc3d      figs/out/tmp/fig8m50/sync_stale20_dist25/<session>.json on det_h5 slots
    sleap      outputs/bmimica/retracked_max2/<session>/<serial>.slp  (cap 2)
    bytetrack  outputs/bmimica/results/bytetrack_noretire/<session>/<serial>.h5
               + stitch_to_2  (B1s)

    /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig6_window_length_control.py \
        --workers 60 [--sessions N]

Output: figs/out/fig6_window_length_control.json
"""
import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
BENCH = Path("/root/vast/eric/luc3d-bench")
BM = BENCH / "outputs" / "bmimica"
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]
LUC3D = OUT / "tmp" / "fig8m50" / "sync_stale20_dist25"
WINDOW = 18_000


def job(args):
    sid, cam = args
    sys.path.insert(0, str(BENCH / "scripts"))
    sys.path.insert(0, str(REPO / "figs"))
    import h5py
    import motmetrics as mm
    import sleap_io as sio
    import evaluate as ev
    from fig6_bytetrack_max2 import stitch_to_2

    gt, occ = ev.load_gt(BM / "gt" / sid / cam / "proofread.analysis.h5")
    nf = gt.shape[0]
    # LUC3D: identity per det_h5 slot
    with h5py.File(BM / "det_h5" / sid / f"{cam}_predictions.h5", "r") as f:
        det = f["tracks"][0]
    nf = min(nf, det.shape[0])
    lj = json.loads((LUC3D / f"{sid}.json").read_text())
    lids = ev.luc3d_assignments_for_cam(lj, cam, nf, det.shape[1])
    # SLEAP capped
    L = sio.load_slp(str(BM / "retracked_max2" / sid / f"{cam}.slp"), open_videos=False)
    tix = {id(t): i for i, t in enumerate(L.tracks)}
    sl = {}
    for lf in L:
        fi = int(lf.frame_idx)
        if fi >= nf:
            continue
        items = []
        for inst in lf.instances:
            if inst.track is None:
                continue
            b = ev.bbox_from_kpts(np.asarray(inst.numpy(), float))
            if b is not None:
                items.append((tix[id(inst.track)], b))
        sl[fi] = items
    # ByteTrack B1s
    with h5py.File(BM / "results" / "bytetrack_noretire" / sid / f"{cam}.h5", "r") as f:
        bt = stitch_to_2(f["tracks"][:])

    arms = ("luc3d", "sleap", "bytetrack")
    full = {a: mm.MOTAccumulator(auto_id=True) for a in arms}
    win = {a: {} for a in arms}
    for fi in range(nf):
        gb, gi = [], []
        for t in range(gt.shape[1]):
            if occ[fi, t]:
                b = ev.bbox_from_kpts(gt[fi, t])
                if b is not None:
                    gb.append(b)
                    gi.append(t)
        gn = np.array(gb) if gb else np.empty((0, 4))
        hyp = {"luc3d": [], "sleap": sl.get(fi, []), "bytetrack": []}
        for a in range(det.shape[1]):
            if lids[fi, a] >= 0:
                b = ev.bbox_from_kpts(det[fi, a])
                if b is not None:
                    hyp["luc3d"].append((int(lids[fi, a]), b))
        for j in range(bt.shape[1]):
            if np.isfinite(bt[fi, j, 0]):
                hyp["bytetrack"].append((int(bt[fi, j, 0]), bt[fi, j, 1:5]))
        w = fi // WINDOW
        for a in arms:
            ids = [i for i, _ in hyp[a]]
            pn = np.array([b for _, b in hyp[a]]) if hyp[a] else np.empty((0, 4))
            d = mm.distances.iou_matrix(gn, pn, max_iou=0.5)
            full[a].update(gi, ids, d)
            win[a].setdefault(w, mm.MOTAccumulator(auto_id=True)).update(gi, ids, d)
    mh = mm.metrics.create()
    res = {"session": sid, "camera": cam, "n_frames": int(nf)}
    for a in arms:
        res[f"{a}_full"] = float(mh.compute(full[a], metrics=["idf1"], name="x")["idf1"]["x"])
        # drop a short tail window (< half a window) so it cannot dominate the mean
        ws = [float(mh.compute(acc, metrics=["idf1"], name="x")["idf1"]["x"])
              for w, acc in sorted(win[a].items())
              if min(WINDOW, nf - w * WINDOW) >= WINDOW // 2]
        res[f"{a}_window_mean"] = float(np.nanmean(ws))
        res[f"{a}_n_windows"] = len(ws)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=60)
    ap.add_argument("--sessions", type=int, default=None, help="evenly spaced subset")
    a = ap.parse_args()
    sess = sorted(p.stem for p in LUC3D.glob("*.json") if p.stem != "params")
    sess = [s for s in sess if (BM / "retracked_max2" / s).is_dir()]
    if a.sessions:
        sess = [sess[i] for i in np.linspace(0, len(sess) - 1, a.sessions).round().astype(int)]
    jobs = [(s, c) for s in sess for c in SER]
    rows = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for f in as_completed([ex.submit(job, j) for j in jobs]):
            try:
                rows.append(f.result())
            except Exception as e:  # noqa: BLE001
                print("FAILED", repr(e)[:300], flush=True)
    per = {}
    for r in rows:
        per.setdefault(r["session"], []).append(r)
    summ = {}
    for arm in ("luc3d", "sleap", "bytetrack"):
        for k in ("full", "window_mean"):
            v = [np.mean([r[f"{arm}_{k}"] for r in rs]) for rs in per.values()]
            summ[f"{arm}_{k}"] = float(np.mean(v))
    out = {"generated_by": "figs/fig6_window_length_control.py", "window_frames": WINDOW,
           "n_sessions": len(per), "n_camera_sessions": len(rows),
           "summary_session_mean_of_camera_mean": summ, "rows": rows}
    name = "fig6_window_length_control.json" if not a.sessions else \
        f"fig6_window_length_control_{a.sessions}.json"
    (OUT / name).write_text(json.dumps(out, indent=1))
    print(json.dumps(out["summary_session_mean_of_camera_mean"], indent=1))
    print(f"{len(per)} sessions, {len(rows)} camera-sessions -> {OUT / name}")


if __name__ == "__main__":
    main()
