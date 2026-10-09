#!/usr/bin/env python
"""Pack SLAP-2M's PROOFREAD per-camera 2D labels into the keeptrack_h5s layout.

For each camera: tracks (74, Fmax, 5, 15, 2) float64 and det_scores (74, Fmax, 5),
NaN where empty, gzip-4 chunked like outputs/keeptrack_h5s, session axis = the master
sheet row. Identity is stripped by shuffling the slot order independently in every
frame (seeded), so the tracker sees detections, not GT tracks. Scores are 1.0.
Lets fig4_slap2m.py --pool proofread run the cross-view tracker on what the
proofreaders could see, as the occlusion floor for Fig 4B.
"""
import os, sys, h5py, numpy as np, pandas as pd
BENCH = "/root/vast/eric/luc3d-bench"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "tmp", "proofread_pool")
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
FMAX, D, N = 108133, 5, 15
os.makedirs(OUT, exist_ok=True)
ms = pd.read_csv(f"{BENCH}/outputs/sleap_nn_master_sheet.tsv", sep="\t", index_col=0).reset_index(drop=True)
rng = np.random.default_rng(20261006)
for cam in CAMS:
    dst = os.path.join(OUT, f"{cam}_predictions.h5")
    with h5py.File(dst, "w") as g:
        tr = g.create_dataset("tracks", (len(ms), FMAX, D, N, 2), dtype="f8", chunks=(1, 4096, D, N, 2), compression="gzip", compression_opts=4, fillvalue=np.nan)
        sc = g.create_dataset("det_scores", (len(ms), FMAX, D), dtype="f8", chunks=(1, 4096, D), compression="gzip", compression_opts=4, fillvalue=np.nan)
        g.attrs.update({"camera": cam, "n_dets": D, "ordering": "shuffled per frame (identity-stripped)", "source": "proofread 2D labels (*.predictions.proofread.slp.analysis.h5)"})
        for i, row in ms.iterrows():
            p = row[f"{cam}_proofread_h5"]
            if not isinstance(p, str) or not os.path.exists(p):
                print(f"  {cam} {row['session']}: missing proofread h5", flush=True); continue
            with h5py.File(p, "r") as f:
                a = np.transpose(f["tracks"][:], (3, 0, 2, 1))          # (F, T, N, 2)
            F, T = a.shape[0], a.shape[1]
            F = min(F, FMAX)
            block = np.full((F, D, N, 2), np.nan); sblock = np.full((F, D), np.nan)
            present = np.isfinite(a[:F, :, :, 0]).any(-1)                 # (F, T)
            for fi in range(F):
                slots = np.where(present[fi])[0]
                if not len(slots): continue
                order = rng.permutation(len(slots))
                block[fi, :len(slots)] = a[fi, slots[order]]
                sblock[fi, :len(slots)] = 1.0
            tr[i, :F] = block; sc[i, :F] = sblock
    print(f"wrote {dst} ({os.path.getsize(dst)/1e6:.0f} MB)", flush=True)
