#!/usr/bin/env python
"""Compare light-filter variants against filtered (keeptrack) and unfiltered (predslp)
on the 42 multi-animal SLAP-2M sessions: LUC3D sync/stale20/dist25 in every arm.

    figs/.venv/bin/python figs/lite_compare.py
"""
import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / "out"
CFG = "sync_stale20_dist25"
ARMS = [("filtered (figure)", "fig9_slap2m.json"),
        ("unfiltered", "fig9_slap2m_predslp_multi.json")]
for v in ("vis4", "vis6", "score07", "vis4_or_score07", "vis6_and_score08",
          "vis8_and_score085"):
    ARMS.append((v, f"fig9_slap2m_lite_{v}_lite.json"))


def per_session(name):
    p = OUT / name
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    c = {x["config"]: x for x in d["cells"]}[CFG]
    return {q["session"]: q for q in c["per_session"] if q["animals"] > 1}


rows = []
for label, name in ARMS:
    ps = per_session(name)
    if not ps:
        print(f"{label:20s} (not ready)")
        continue
    v = list(ps.values())
    idf = np.array([q["cross_idf1"] for q in v])
    d7 = [q["cross_idf1"] for q in v if q["difficulty"] == 7]
    fp = sum(q["within_false_positives"] for q in v)
    miss = sum(q["within_misses"] for q in v)
    sw = sum(q["within_switches"] for q in v)
    mis = sum(q["misgrouped"] for q in v)
    lab = sum(q["det_labelled"] for q in v)
    rows.append((label, len(v), np.median(idf), idf.mean(), np.median(d7) if d7 else np.nan,
                 (idf >= 0.9).sum(), fp, miss, sw, 1e5 * mis / max(lab, 1)))
print(f"{'arm':20s} {'n':>3s} {'IDF1 med':>8s} {'mean':>6s} {'d7 med':>6s} {'>=.9':>5s} "
      f"{'FP':>8s} {'misses':>9s} {'switch':>6s} {'misgrp/100k':>11s}")
for r in rows:
    print(f"{r[0]:20s} {r[1]:3d} {r[2]:8.3f} {r[3]:6.3f} {r[4]:6.3f} {r[5]:5d} "
          f"{r[6]:8,} {r[7]:9,} {r[8]:6,} {r[9]:11.0f}")
