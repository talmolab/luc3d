#!/usr/bin/env python
"""Light-filter variants of the UNFILTERED SLAP-2M pool (2026-10-08, Eric: "is there a
minimal amount of filtering we can do that is a middle ground between unfiltered and
filtered? we still want IDF1 at or above .9 but we want less false positives and
misgrouped frames").

Source: out/tmp/predslp_pool (the pre-proofreading predictions, packed by
build_predslp_pool.py). Each variant blanks (NaN) whole detections that fail its rule and
keeps everything else byte-for-byte, so the only difference between two variants is the rule.

What the unfiltered pool actually contains (12 multi-animal sessions x 3 cameras,
`scratchpad/pooldiag.py`): no frame ever holds more detections than animals (the
inference already caps at N), and near-duplicates are 0.03% of detections, so neither a
per-frame cap nor OKS de-duplication can do anything here. What it DOES contain is a tail of
partial skeletons (7% of detections have < 8 visible keypoints, 2% < 4) and of low-
confidence instances (instance score p5 0.81, p10 0.87). Those are what these rules target.

The pool stores the instance score but not per-node scores, so the sleap-nn
`--filter_min_mean_node_score` rule cannot be reproduced from it.

    $PY figs/build_lite_pools.py            # all variants
    $PY figs/build_lite_pools.py vis6       # one

Output: out/tmp/lite_pools/<variant>/{cam}_predictions.h5 (same layout as keeptrack_h5s).
"""
import os
import sys

import h5py
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "out", "tmp", "predslp_pool")
DST = os.path.join(HERE, "out", "tmp", "lite_pools")
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]

#: variant -> (min visible keypoints, min instance score, combine). "or" drops a detection
#: failing EITHER rule; "and" drops only one failing BOTH (small AND low-confidence), which
#: spares partially visible real animals. Chosen from figs/fp_character.py (2026-10-08):
#: unfiltered FPs have median 5 visible keypoints vs 14 for hits, and 23.5% of FPs are
#: correct detections of animals whose 2D label is missing, so no rule should chase those.
VARIANTS = {
    "vis4": (4, 0.0, "or"),
    "vis6": (6, 0.0, "or"),
    "score07": (0, 0.7, "or"),
    "vis4_or_score07": (4, 0.7, "or"),
    "vis6_and_score08": (6, 0.8, "and"),
    "vis8_and_score085": (8, 0.85, "and"),
}
#: BODY-ONLY keypoint counts (2026-10-08, Eric: "the tail should not be counted for any of
#: these numbers"): visible keypoints are counted over the 11 non-tail nodes, so a detection
#: is never kept or dropped because of its tail. These are the variants the tail-free
#: figures use.
TAIL = (4, 7, 8, 9)            # TailTip, Tail_0, Tail_1, Tail_2 (SLAP-2M)
for _n in (4, 5, 6, 7):
    VARIANTS[f"bvis{_n}"] = (_n, 0.0, "or")
BODY_ONLY = {f"bvis{_n}" for _n in (4, 5, 6, 7)}
CHUNK = 4096


def build(name):
    min_vis, min_score, mode = VARIANTS[name]
    out = os.path.join(DST, name)
    os.makedirs(out, exist_ok=True)
    for cam in CAMS:
        src = os.path.join(SRC, f"{cam}_predictions.h5")
        dst = os.path.join(out, f"{cam}_predictions.h5")
        tmp = dst + ".partial"
        if os.path.exists(dst):
            print(f"  {name}/{cam}: exists, skip", flush=True)
            continue
        kept = dropped = 0
        with h5py.File(src, "r") as fi, h5py.File(tmp, "w") as fo:
            tr_i, sc_i = fi["tracks"], fi["det_scores"]
            tr_o = fo.create_dataset("tracks", shape=tr_i.shape, dtype=tr_i.dtype,
                                     chunks=tr_i.chunks, compression="gzip",
                                     compression_opts=4, fillvalue=np.nan)
            sc_o = fo.create_dataset("det_scores", shape=sc_i.shape, dtype=sc_i.dtype,
                                     chunks=sc_i.chunks, compression="gzip",
                                     compression_opts=4, fillvalue=np.nan)
            for k, v in fi.attrs.items():
                fo.attrs[k] = v
            fo.attrs["source"] = f"lite filter {name}: {SRC}"
            fo.attrs["lite_min_visible_nodes"] = min_vis
            fo.attrs["lite_min_instance_score"] = min_score
            fo.attrs["lite_combine"] = mode
            fo.attrs["lite_count_nodes"] = "body (tail excluded)" if name in BODY_ONLY else "all"
            for s in range(tr_i.shape[0]):
                for f0 in range(0, tr_i.shape[1], CHUNK):
                    f1 = min(tr_i.shape[1], f0 + CHUNK)
                    tr = tr_i[s, f0:f1]
                    sc = sc_i[s, f0:f1]
                    fin = np.isfinite(tr[..., 0])                   # (F, D, N)
                    present = fin.any(-1)
                    if name in BODY_ONLY:
                        body = [n for n in range(fin.shape[-1]) if n not in TAIL]
                        vis = fin[..., body].sum(-1)
                    else:
                        vis = fin.sum(-1)
                    if not present.any():
                        continue
                    with np.errstate(invalid="ignore"):
                        lo_v, lo_s = vis < min_vis, sc < min_score
                        bad = present & ((lo_v & lo_s) if mode == "and" else (lo_v | lo_s))
                    tr[bad] = np.nan
                    sc[bad] = np.nan
                    kept += int((present & ~bad).sum())
                    dropped += int(bad.sum())
                    tr_o[s, f0:f1] = tr
                    sc_o[s, f0:f1] = sc
        os.replace(tmp, dst)
        print(f"  {name}/{cam}: kept {kept:,}, dropped {dropped:,} "
              f"({100 * dropped / max(kept + dropped, 1):.2f}%)", flush=True)


if __name__ == "__main__":
    names = sys.argv[1:] or list(VARIANTS)
    for n in names:
        print(f"[lite] {n} {VARIANTS[n]}", flush=True)
        build(n)
