#!/usr/bin/env python3
"""
Mutual rearing while near, by session QUARTILE, with proximity matched for selectivity.

TWO FIXES OVER `fig12_mutual_enrichment.py`, both from Eric (2026-08-20).

FIX 1 -- `near/all` WAS CONFOUNDED BY HOW OFTEN "NEAR" IS TRUE. At a fixed 2 body lengths
the animals count as near 31.4% of the time in Mouse-Dyad-10M, 59.2% in SLAP-2M and 89.8%
in the SCN2A rats. When `near` covers 90% of frames, obs_near is ~0.9 x obs_all and the
shifted null scales the same way, so the ratio is driven to 1.0 BY CONSTRUCTION. The rats'
near/all = 1.00 was therefore not a measurement that their coordination is non-spatial --
the statistic could not have returned anything else. So every session here uses its OWN
separation quantile at the reference near-fraction (Mouse-Dyad-10M's median 31.4%), making
"near" equally selective in every corpus and the ratio actually comparable. `fixed` is
retained alongside so the size of the correction is visible rather than asserted.

FIX 2 -- THE TIME COURSE. The enrichment is recomputed within each QUARTILE of the session,
which asks whether the coordination itself changes as the animals stop being new to each
other. This is the confound-free familiarity test: within a session nothing varies except
elapsed time. Note the earlier rate analysis found displays becoming RARER within a session
in the two non-cagemate corpora and flat in the cagemate one; that is about how OFTEN, and
this is about how COORDINATED, which are separate questions.

THE NULL is a circular shift of animal B's rear series over the WHOLE session (48 shifts),
with the statistic then restricted to the quartile. Shifting globally preserves B's rear
rate, bout durations and autocorrelation; restricting afterwards keeps the quartile's own
proximity and A-rearing structure intact. Positions are never shifted, so the real
proximity mask is untouched.

A quartile is reported only if it carries MIN_FRAMES co-rear-near frames and a non-zero
null, so a cell that cannot estimate the ratio comes back empty rather than noisy.

    figs/.venv/bin/python figs/fig12_enrich_timecourse.py
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

import fig12_social as F
import fig5_rear_coupling as RC

HERE = Path(__file__).resolve().parent
DEPOSIT = HERE / "data" / "fig12"
NOSE, TTI, NECK = RC.NOSE, RC.TTI, RC.NECK
LOADERS = {"mouse-dyad-10m": F._load_bmimica, "slap-2m": F._load_slap,
           "scn2a": F._load_scn2a}
REF = "mouse-dyad-10m"
NSHIFT = 48
NBINS = 4
#: A quartile needs this many frames of (A rearing & B rearing & near) before its ratio is
#: reported. Below it the estimate is a handful of frames divided by a small null.
MIN_FRAMES = 30


def _job(job):
    corpus, key, arg, ref_frac = job
    ld = LOADERS[corpus](arg)
    if ld is None or ld[0].shape[1] != 2:
        return None
    t, fps = ld[0], ld[1]
    nose, tti, neck = t[:, :, NOSE, :], t[:, :, TTI, :], t[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    Lm = float(np.nanmean(L))
    if not np.isfinite(Lm) or Lm <= 0:
        return None
    rA = neck[:, 0, 2] / L[0] > RC.REAR_FRAC
    rB = neck[:, 1, 2] / L[1] > RC.REAR_FRAC
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / Lm
    fin = np.isfinite(sep)
    if rA.sum() < 50 or rB.sum() < 50 or fin.sum() < 500:
        return None
    n = t.shape[0]
    both = rA & rB

    # `matched`: this session's own separation quantile at the reference near-fraction, so
    # "near" is equally SELECTIVE across corpora. `fixed`: the original 2 body lengths.
    thr_matched = float(np.quantile(sep[fin], ref_frac))
    masks = {"fixed": fin & (sep <= RC.NEAR_BL),
             "matched": fin & (sep <= thr_matched)}

    rng = np.random.default_rng(0)
    shifts = [int(s) for s in rng.integers(int(0.05 * n), int(0.95 * n), NSHIFT)]
    rolled = [np.roll(rB, s) for s in shifts]

    edges = (np.linspace(0, 1, NBINS + 1) * n).astype(int)
    rows = []
    for mode, near in masks.items():
        for b in range(NBINS):
            sl = slice(edges[b], edges[b + 1])
            m_near, m_A = near[sl], rA[sl]
            obs_c = int(np.count_nonzero(m_A & rB[sl] & m_near))
            nulls = [float(np.mean(m_A & r[sl] & m_near)) for r in rolled]
            nm = float(np.median(nulls))
            obs = obs_c / max(m_A.size, 1)
            rows.append({
                "corpus": corpus, "session": key, "mode": mode, "bin": b + 1,
                "near_frac": float(np.mean(m_near)),
                "obs_frames": obs_c,
                "enr": (obs / nm) if (nm > 0 and obs_c >= MIN_FRAMES) else np.nan,
            })
        # whole-session `all` (no proximity) for the near/all ratio
        pass
    for b in range(NBINS):
        sl = slice(edges[b], edges[b + 1])
        obs_c = int(np.count_nonzero(both[sl]))
        nulls = [float(np.mean(rA[sl] & r[sl])) for r in rolled]
        nm = float(np.median(nulls))
        obs = obs_c / max(rA[sl].size, 1)
        rows.append({"corpus": corpus, "session": key, "mode": "all", "bin": b + 1,
                     "near_frac": 1.0, "obs_frames": obs_c,
                     "enr": (obs / nm) if (nm > 0 and obs_c >= MIN_FRAMES) else np.nan})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    args = ap.parse_args()

    # Reference near-fraction: the median fraction of time Mouse-Dyad-10M spends within
    # 2 BL. Matching to the corpus under scrutiny is the conservative direction.
    ref_frac = 0.314
    jobs = [(c, k, a, ref_frac) for c in LOADERS
            for (c2, k, a) in F._sessions(c, args.limit)]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        got = [r for r in ex.map(_job, jobs) if r]
    D = pd.DataFrame([r for rows in got for r in rows])
    DEPOSIT.mkdir(parents=True, exist_ok=True)
    D.to_csv(DEPOSIT / "fig12_enrich_timecourse.csv", index=False)

    pd.set_option("display.width", 200)
    print(f"\nsessions: {D.groupby('corpus').session.nunique().to_dict()}")
    print("\nHow selective is 'near' under each mode (median frac of frames)")
    print(D[D['mode'] != 'all'].groupby(['corpus', 'mode']).near_frac.median()
          .unstack().to_string(float_format=lambda v: f"{v:.3f}"))

    for mode in ("fixed", "matched", "all"):
        sub = D[D['mode'] == mode]
        piv = sub.pivot_table(index="corpus", columns="bin", values="enr",
                              aggfunc="median")
        nsess = sub.dropna(subset=["enr"]).pivot_table(
            index="corpus", columns="bin", values="session", aggfunc="nunique")
        print(f"\nENRICHMENT by session quartile — mode '{mode}'  (median over sessions)")
        print(piv.to_string(float_format=lambda v: f"{v:.2f}"))
        print("  sessions contributing per bin:")
        print(nsess.to_string())

    print("\nQ1 vs Q4, paired within session (mode 'matched')")
    m = D[D['mode'] == 'matched']
    for c in LOADERS:
        w = m[m.corpus == c].pivot(index="session", columns="bin", values="enr")
        if 1 not in w or NBINS not in w:
            continue
        v = w[[1, NBINS]].dropna()
        if len(v) < 5:
            print(f"  {c:16s} only {len(v)} sessions with both Q1 and Q4 — skipped")
            continue
        t = stats.wilcoxon(v[1], v[NBINS])
        print(f"  {c:16s} n={len(v):3d}  Q1 {v[1].median():5.2f} -> Q4 "
              f"{v[NBINS].median():5.2f}   down in {int((v[NBINS]<v[1]).sum())}/{len(v)}"
              f"   Wilcoxon p={t.pvalue:.3g}")
    print("\ndeposited -> data/fig12/fig12_enrich_timecourse.csv")


if __name__ == "__main__":
    main()
