#!/usr/bin/env python3
"""Mutual rearing AT PROXIMITY, normalised to each animal's own baseline rearing.

THE PRIMARY STATISTIC FOR FIG 12 (Eric, 2026-08-20: "it must be proximity and mutual
rearing compared to baseline rearing"). It exists because three separate confounds were
found and killed in one afternoon, and every earlier version of the measure fell to at
least one of them:

  * INDIVIDUAL REARING PROPENSITY. SLAP-2M's mice rear 27.6% of the time against
    Mouse-Dyad-10M's 8.6%. Any raw co-rearing count is dominated by that 3.2x, which is
    what made the retired "familiar pairs co-rear 13x more" claim look real.
  * ARENA GEOMETRY. Animals are within 2 body lengths 31.4% / 59.2% / 89.8% of the time
    (Mouse-Dyad-10M / SLAP-2M / SCN2A), so a proximity criterion is nearly free in a small
    arena and selective in a large one.
  * BOUT AUTOCORRELATION. Rears last ~1 s and cluster, so any null that scatters them
    (an independence product, a reshuffle) is far too flat and almost anything clears it.

All three live inside the null here, so the ratio is directly comparable across corpora.

obs  = fraction of frames with (A rearing) AND (B rearing) AND (pair within NEAR_BL)
null = the same statistic with B's rear series CIRCULARLY SHIFTED, which preserves B's
       rear rate, bout durations and autocorrelation and destroys only its temporal
       alignment to "A is rearing and they are close". Positions -- and therefore the real
       proximity mask -- are left untouched.
enrichment = obs / median(null).  1.0 = chance.

Deposits `data/fig12/fig12_mutual_enrichment.csv` (one row per session).

This is the measure that survives every confound found today at once: individual rearing
propensity, arena size / proximity availability, and rear-bout autocorrelation are all
inside the null, so the ratio is comparable across corpora. The `_all` twin drops the
proximity condition, so the pair (near, all) separates "coordinated" from
"coordinated AND specifically when close".
"""
import sys, os
sys.path.insert(0,'/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs')
import numpy as np
from concurrent.futures import ProcessPoolExecutor
import fig5_rear_coupling as RC, fig12_social as F
NOSE,TTI,NECK=RC.NOSE,RC.TTI,RC.NECK
NSHIFT=48
L_={"mouse-dyad-10m":F._load_bmimica,"slap-2m":F._load_slap,"scn2a":F._load_scn2a}

def job(a):
    c,k,arg=a
    ld=L_[c](arg)
    if ld is None or ld[0].shape[1]!=2: return None
    t,fps=ld[0],ld[1]
    nose,tti,neck=t[:,:,NOSE,:],t[:,:,TTI,:],t[:,:,NECK,:]
    L=np.nanmedian(np.linalg.norm(nose-tti,axis=-1),axis=0); Lm=float(np.nanmean(L))
    if not np.isfinite(Lm) or Lm<=0: return None
    rA=neck[:,0,2]/L[0]>RC.REAR_FRAC; rB=neck[:,1,2]/L[1]>RC.REAR_FRAC
    sep=np.linalg.norm(tti[:,0,:]-tti[:,1,:],axis=-1)/Lm
    near=np.isfinite(sep)&(sep<=RC.NEAR_BL)
    n=t.shape[0]
    if rA.sum()<50 or rB.sum()<50 or near.sum()<50: return None
    rng=np.random.default_rng(0)
    shifts=rng.integers(int(0.05*n), int(0.95*n), NSHIFT)
    res={"corpus":c,"session":k}
    for tag,mask in (("near",near),("all",np.ones(n,bool))):
        obs=float(np.mean(rA&rB&mask))
        nulls=[float(np.mean(rA&np.roll(rB,int(s))&mask)) for s in shifts]
        m=float(np.median(nulls))
        res[f"obs_{tag}"]=obs; res[f"null_{tag}"]=m
        res[f"enr_{tag}"]=obs/m if m>0 else np.nan
    return res

if __name__=="__main__":
    import pandas as pd
    from pathlib import Path
    jobs=[j for c in L_ for j in F._sessions(c)]
    with ProcessPoolExecutor(max_workers=12) as ex:
        rows=[r for r in ex.map(job,jobs) if r]
    from scipy import stats
    print("Mutual rearing vs a circular-shift null (1.0 = chance)\n")
    print(f"{'corpus':16s}{'n':>4s}{'ENRICH near':>26s}{'ENRICH all':>24s}{'near/all':>10s}{'p (near>1)':>12s}")
    for c in L_:
        g=[r for r in rows if r['corpus']==c]
        en=np.array([r['enr_near'] for r in g],float); en=en[np.isfinite(en)]
        ea=np.array([r['enr_all'] for r in g],float);  ea=ea[np.isfinite(ea)]
        p=stats.wilcoxon(en-1.0, alternative='greater').pvalue if len(en)>5 else np.nan
        print(f"{c:16s}{len(g):4d}"
              f"{np.median(en):10.2f} [{np.percentile(en,25):.2f}-{np.percentile(en,75):.2f}]"
              f"{np.median(ea):10.2f} [{np.percentile(ea,25):.2f}-{np.percentile(ea,75):.2f}]"
              f"{np.median(en)/np.median(ea):10.2f}{p:12.3g}")
    out=Path(__file__).resolve().parent/"data"/"fig12"
    out.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out/"fig12_mutual_enrichment.csv", index=False)
    print(f"\n  deposited -> data/fig12/fig12_mutual_enrichment.csv ({len(rows)} sessions)")
    print("\n  ENRICH near = mutual rearing WHILE CLOSE, over its own shifted null")
    print("  ENRICH all  = mutual rearing regardless of distance, same null")
    print("  near/all    = how much of the coordination is specific to being close")
