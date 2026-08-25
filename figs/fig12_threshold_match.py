#!/usr/bin/env python3
"""
How much of the rear-coupling effect is the PROXIMITY THRESHOLD meeting a big arena?

THE PROBLEM. Fig 12a splits rear onsets by whether the animals were within NEAR_BL = 2
body lengths. That is a fixed multiple of body length, but the corpora sit in arenas of
very different size RELATIVE to their animals -- roughly 9.6 body lengths across for
Mouse-Dyad-10M, 3.8 for SLAP-2M, 2.9 for the s-DANNCE SCN2A rats. So the same "2 body
lengths" is a selective condition in one arena and almost the whole arena in another: it
covers ~27% of the time in Mouse-Dyad-10M and ~90% in the rat cage, where "near" and "far"
are barely different populations and the contrast cannot do any work. A corpus can then
fail to show proximity-gated coupling for a purely geometric reason.

THREE THRESHOLDS, run through the SAME detector (`fig5_rear_coupling.session_coupling`,
imported, with its NEAR_BL rebound per session):

  * `fixed`        2.0 body lengths everywhere -- what Fig 12a currently does.
  * `arena`        2.0 x (arena_i / arena_ref): the threshold is a constant FRACTION of
                   the arena, so a smaller arena gets a proportionally smaller threshold.
                   This is the geometric reading of "scale it down for small arenas".
  * `selectivity`  each session's own separation quantile at the reference corpus's near
                   FRACTION OF TIME. This matches how OFTEN the animals count as near
                   rather than how far apart they are, which is what actually determines
                   whether near-vs-far is a real contrast.

The two disagree on purpose and the table prints both: `arena` equalises geometry,
`selectivity` equalises statistical power. If the effect survives both in
Mouse-Dyad-10M and appears in neither of the others under either, the corpus difference is
not a threshold artefact. If the others light up once matched, it largely is.

REFERENCE IS MOUSE-DYAD-10M, because it is the corpus whose effect is under scrutiny;
matching everything to it is the conservative direction (it hands the other corpora the
threshold that worked, rather than moving the goalposts to a fourth value nobody used).

    figs/.venv/bin/python figs/fig12_threshold_match.py
    figs/.venv/bin/python figs/fig12_threshold_match.py --limit 6      # quick pass
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

import fig12_social as F
import fig5_rear_coupling as RC

HERE = Path(__file__).resolve().parent
DEPOSIT = HERE / "data" / "fig12"
NOSE, TTI = RC.NOSE, RC.TTI
REF = "mouse-dyad-10m"
CORPORA = [REF, "slap-2m", "scn2a"]
MODES = ["fixed", "arena", "selectivity"]


def geometry(t):
    """(body length mm, arena extent in BL, separation series in BL) for one session."""
    tti, nose = t[:, :, TTI, :], t[:, :, NOSE, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    Lm = float(np.nanmean(L))
    if not np.isfinite(Lm) or Lm <= 0:
        return None
    # Arena extent from the floor-plane spread of BOTH animals' tail bases, on 1-99
    # percentiles so one bad frame cannot inflate it, as a diagonal.
    xy = tti[:, :, :2].reshape(-1, 2)
    rng = [np.nanpercentile(xy[:, k], 99) - np.nanpercentile(xy[:, k], 1) for k in (0, 1)]
    arena = float(np.hypot(*rng) / Lm)
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / Lm
    return Lm, arena, sep


def _geom_job(job):
    corpus, key, arg = job
    ld = {"mouse-dyad-10m": F._load_bmimica, "slap-2m": F._load_slap,
          "scn2a": F._load_scn2a}[corpus](arg)
    if ld is None or ld[0].shape[1] != 2:
        return None
    g = geometry(ld[0])
    if g is None:
        return None
    Lm, arena, sep = g
    fin = sep[np.isfinite(sep)]
    if fin.size < 100:
        return None
    return {"corpus": corpus, "session": key, "L_mm": Lm, "arena_bl": arena,
            "frac_within_2bl": float(np.mean(fin <= RC.NEAR_BL)),
            "sep_p_ref": None}      # filled once the reference fraction is known


def _couple_job(job):
    """Run the coupling detector with NEAR_BL rebound for this session."""
    corpus, key, arg, near_bl = job
    ld = {"mouse-dyad-10m": F._load_bmimica, "slap-2m": F._load_slap,
          "scn2a": F._load_scn2a}[corpus](arg)
    if ld is None or ld[0].shape[1] != 2:
        return None
    t, fps = ld[0], ld[1]
    # Rebinding the module global is safe here: each worker is its own process and runs
    # one job at a time, and `session_coupling` reads NEAR_BL at call time.
    RC.NEAR_BL = float(near_bl)
    r = RC.session_coupling(t, fps)
    if r is None:
        return None
    return {"session": key, "near_bl": float(near_bl), **r}


def peak(summary, cond):
    c = summary.get(cond) if summary else None
    if not c:
        return np.nan, np.nan
    p = np.asarray(c["p50"], float)
    t = np.asarray(summary["t"], float)
    i = int(np.nanargmax(p))
    return float(p[i]), float(t[i])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    args = ap.parse_args()

    # ---- pass 1: geometry, to set the thresholds --------------------------------
    jobs = [j for c in CORPORA for j in F._sessions(c, args.limit)]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        geo = [g for g in ex.map(_geom_job, jobs) if g]
    G = pd.DataFrame(geo)
    per_corpus = G.groupby("corpus").agg(
        n=("session", "size"), L_mm=("L_mm", "median"),
        arena_bl=("arena_bl", "median"),
        frac_within_2bl=("frac_within_2bl", "median")).reindex(CORPORA)
    arena_ref = per_corpus.loc[REF, "arena_bl"]
    frac_ref = per_corpus.loc[REF, "frac_within_2bl"]

    # Per-session thresholds for each mode.
    sep_q = {}
    for c in CORPORA:
        for j in F._sessions(c, args.limit):
            sep_q[(c, j[1])] = j
    thresholds = {}
    for g in geo:
        c, k = g["corpus"], g["session"]
        thresholds[(c, k, "fixed")] = RC.NEAR_BL_FIXED if hasattr(RC, "NEAR_BL_FIXED") else 2.0
        thresholds[(c, k, "arena")] = 2.0 * (g["arena_bl"] / arena_ref)
        thresholds[(c, k, "selectivity")] = None      # needs the session's own quantile

    # `selectivity` needs each session's separation quantile at frac_ref, so recompute
    # the separation series once more per session (cheap next to the coupling run).
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        qs = [q for q in ex.map(_quantile_job,
                                [(g["corpus"], g["session"],
                                  sep_q[(g["corpus"], g["session"])][2], frac_ref)
                                 for g in geo]) if q]
    for c, k, v in qs:
        thresholds[(c, k, "selectivity")] = v

    # ---- pass 2: coupling under each mode ---------------------------------------
    rows = []
    for mode in MODES:
        cj = []
        for g in geo:
            c, k = g["corpus"], g["session"]
            nb = thresholds.get((c, k, mode))
            if nb is None or not np.isfinite(nb) or nb <= 0:
                continue
            cj.append((c, k, sep_q[(c, k)][2], nb))
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            got = [r for r in ex.map(_couple_job, cj) if r]
        by = {}
        for (c, k, _, nb), r in zip(cj, got):
            by.setdefault(c, []).append(r)
        for c in CORPORA:
            summ = RC.summarise(by.get(c, []), c)
            npk, nlag = peak(summ, "near")
            fpk, _ = peak(summ, "far")
            nulp, _ = peak(summ, "null")
            used = [t for (cc, kk, mm), t in thresholds.items()
                    if cc == c and mm == mode and t]
            rows.append({
                "mode": mode, "corpus": c,
                "near_bl": float(np.median(used)) if used else np.nan,
                "n_sessions": summ["n_sessions"] if summ else 0,
                "near_onsets": summ["n_onsets"]["near"] if summ else 0,
                "far_onsets": summ["n_onsets"]["far"] if summ else 0,
                "near_peak": npk, "near_peak_lag_s": nlag, "far_peak": fpk,
                "near_minus_far": npk - fpk, "null_peak": nulp,
                "near_sessions": summ["near"]["n_sessions"] if summ and summ["near"] else 0,
            })
        print(f"  mode {mode} done", flush=True)

    T = pd.DataFrame(rows)
    DEPOSIT.mkdir(parents=True, exist_ok=True)
    per_corpus.to_csv(DEPOSIT / "fig12_threshold_geometry.csv")
    T.to_csv(DEPOSIT / "fig12_threshold_match.csv", index=False)

    pd.set_option("display.width", 220, "display.max_columns", 40)
    print("\nGEOMETRY (medians over sessions)")
    print(per_corpus.to_string(float_format=lambda v: f"{v:.3g}"))
    print(f"\n  reference = {REF}: arena {arena_ref:.2f} BL, "
          f"2 BL covers {frac_ref*100:.1f}% of the time")
    print("\nCOUPLING UNDER EACH THRESHOLD")
    print(T[["mode", "corpus", "near_bl", "n_sessions", "near_sessions", "near_onsets",
             "far_onsets", "near_peak", "far_peak", "near_minus_far",
             "null_peak"]].to_string(index=False, float_format=lambda v: f"{v:.3g}"))
    print(f"\ndeposited -> data/fig12/fig12_threshold_{{geometry,match}}.csv")


def _quantile_job(job):
    corpus, key, arg, frac = job
    ld = {"mouse-dyad-10m": F._load_bmimica, "slap-2m": F._load_slap,
          "scn2a": F._load_scn2a}[corpus](arg)
    if ld is None or ld[0].shape[1] != 2:
        return None
    g = geometry(ld[0])
    if g is None:
        return None
    sep = g[2]
    fin = sep[np.isfinite(sep)]
    if fin.size < 100:
        return None
    return corpus, key, float(np.quantile(fin, frac))


if __name__ == "__main__":
    main()
