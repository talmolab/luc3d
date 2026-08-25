#!/usr/bin/env python3
"""
Does the rear coupling DECAY WITHIN a session, as the two animals stop being new?

WHY THIS IS THE BEST FAMILIARITY TEST AVAILABLE. Every cross-corpus contrast in Fig 12
confounds familiarity with arena size, strain, body size, rig and sex, and no reanalysis
can separate them (see the threshold and frame-rate audits). But novelty decays WITHIN a
single session with nothing else changing at all -- same animals, same arena, same rig,
same sampling. If proximity-gated coupling is about social novelty it should be strongest
early and weaken; if it is a stable property of the pair it should be flat.

THREE MEASUREMENTS, because "does it fade" can mean three different things:

  * RATE over time -- how often the display happens, per bin of session time. Bins are
    fractions of each session, not absolute minutes, so sessions of different length are
    comparable (Mouse-Dyad-10M runs ~20 min at 150 Hz, the SCN2A rats ~30 min at 50 Hz,
    SLAP-2M ~10 min at 30 Hz).
  * COUPLING over time -- the enrichment recomputed on the FIRST vs SECOND HALF of each
    session independently, each with its own base rate and its own circular-shift null.
    Halves rather than quartiles because the near condition needs MIN_ONSETS = 20 onsets
    per session to count, and quartering starves it: ~52 near onsets per session becomes
    ~13, below the gate. The gate counts are printed so a starved cell is visible.
  * PER-DISPLAY-ORDINAL properties -- duration, nose gap, initiator lag and height match
    against the display's INDEX within its session (1st, 2nd, 3rd...). This asks whether
    the displays themselves change as they accumulate, which is a different question from
    whether they get rarer: a pair could keep the behaviour but perform it more loosely.

WHAT WOULD MEAN WHAT. Rate falling with a flat enrichment = they do it less but do it the
same way, i.e. waning interest. Enrichment falling = the coordination itself dissolves, the
strong form of a novelty account. Both flat = the coupling is a stable property of the
pair, and novelty within the session is not what drives it.

    figs/.venv/bin/python figs/fig12_timecourse.py
    figs/.venv/bin/python figs/fig12_timecourse.py --corpus mouse-dyad-10m --bins 5
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
import fig5_upright as UP

HERE = Path(__file__).resolve().parent
DEPOSIT = HERE / "data" / "fig12"
LOADERS = {"mouse-dyad-10m": F._load_bmimica, "slap-2m": F._load_slap,
           "scn2a": F._load_scn2a}


def _job(job):
    corpus, key, arg, nbins = job
    ld = LOADERS[corpus](arg)
    if ld is None or ld[0].shape[1] != 2:
        return None
    t, fps, names, code = ld
    F_n = t.shape[0]
    out = {"corpus": corpus, "session": key, "fps": fps,
           "minutes": F_n / fps / 60.0}

    # ---- events, with their position in the session -------------------------------
    up = UP.session_upright(t, fps, names, code, key)
    ev = []
    if up:
        for e in up["events"]:
            ev.append({"start_frac": e["start_frame"] / F_n,
                       "dur_s": e["dur_s"], "min_nose_gap": e["min_nose_gap"],
                       "lag_s": e["lag_s"], "height_match": e["height_match"]})
        ev.sort(key=lambda x: x["start_frac"])
        for i, e in enumerate(ev):
            e["ordinal"] = i + 1
    out["events"] = ev
    # Rate per bin, in displays per minute, over EQUAL FRACTIONS of the session.
    edges = np.linspace(0, 1, nbins + 1)
    per_bin_min = (F_n / fps / 60.0) / nbins
    out["rate_bins"] = [
        float(sum(1 for e in ev if edges[b] <= e["start_frac"] < edges[b + 1])
              / per_bin_min) for b in range(nbins)]

    # ---- coupling on each HALF, independently ------------------------------------
    half = F_n // 2
    for tag, sl in (("h1", slice(0, half)), ("h2", slice(half, F_n))):
        r = RC.session_coupling(t[sl], fps)
        out[tag] = {"session": key, **r} if r else None
    return out


def _peak(summ, cond):
    c = summ.get(cond) if summ else None
    if not c:
        return np.nan
    p = np.asarray(c["p50"], float)
    return float(p[np.nanargmax(p)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", action="append", default=None,
                    choices=list(LOADERS))
    ap.add_argument("--bins", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    args = ap.parse_args()
    corpora = args.corpus or list(LOADERS)

    rate_rows, coup_rows, ev_rows = [], [], []
    for c in corpora:
        jobs = [(cc, k, a, args.bins) for cc, k, a in F._sessions(c, args.limit)]
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            got = [r for r in ex.map(_job, jobs) if r]
        print(f"{c}: {len(got)} sessions", flush=True)

        # rate by bin
        R = np.array([g["rate_bins"] for g in got], float)
        for b in range(args.bins):
            rate_rows.append({"corpus": c, "bin": b + 1, "n_sessions": R.shape[0],
                              "rate_p50": float(np.median(R[:, b])),
                              "rate_mean": float(np.mean(R[:, b]))})
        # PAIRED first-vs-last bin, on the session
        if R.shape[1] >= 2 and R.shape[0] >= 5:
            a, bb = R[:, 0], R[:, -1]
            w = stats.wilcoxon(a, bb) if np.any(a != bb) else None
            print(f"   rate bin1 {np.median(a):.2f} -> bin{args.bins} {np.median(bb):.2f}"
                  f"/min, down in {int((bb < a).sum())}/{len(a)}"
                  + (f", Wilcoxon p={w.pvalue:.3g}" if w else ""))

        # coupling per half
        for tag in ("h1", "h2"):
            rows = [g[tag] for g in got if g.get(tag)]
            s = RC.summarise(rows, c)
            near, far, null = _peak(s, "near"), _peak(s, "far"), _peak(s, "null")
            coup_rows.append({
                "corpus": c, "half": tag, "n_sessions": s["n_sessions"] if s else 0,
                "near_sessions": s["near"]["n_sessions"] if s and s["near"] else 0,
                "near_onsets": s["n_onsets"]["near"] if s else 0,
                "near_peak": near, "far_peak": far, "near_minus_far": near - far,
                "null_peak": null})
        for g in got:
            for e in g["events"]:
                ev_rows.append({"corpus": c, "session": g["session"], **e})

    RT, CP = pd.DataFrame(rate_rows), pd.DataFrame(coup_rows)
    EV = pd.DataFrame(ev_rows)
    DEPOSIT.mkdir(parents=True, exist_ok=True)
    RT.to_csv(DEPOSIT / "fig12_timecourse_rate.csv", index=False)
    CP.to_csv(DEPOSIT / "fig12_timecourse_coupling.csv", index=False)
    EV.to_csv(DEPOSIT / "fig12_timecourse_events.csv", index=False)

    pd.set_option("display.width", 200, "display.max_columns", 30)
    print("\nRATE by session bin (displays/min, median over sessions)")
    print(RT.pivot(index="corpus", columns="bin", values="rate_p50").to_string(
        float_format=lambda v: f"{v:.3f}"))
    print("\nCOUPLING, first vs second half of the session")
    print(CP.to_string(index=False, float_format=lambda v: f"{v:.3g}"))

    print("\nDISPLAY PROPERTIES vs ordinal within session (Spearman)")
    for c in corpora:
        e = EV[EV.corpus == c]
        if len(e) < 20:
            continue
        print(f"  {c}  (n={len(e)} displays)")
        for fld in ("dur_s", "min_nose_gap", "lag_s", "height_match"):
            v = e[["ordinal", fld]].dropna()
            if len(v) < 20:
                continue
            r = stats.spearmanr(v["ordinal"], v[fld])
            # also against position in session, which is not the same as ordinal
            v2 = e[["start_frac", fld]].dropna()
            r2 = stats.spearmanr(v2["start_frac"], v2[fld])
            print(f"     {fld:14s} vs ordinal rho={r.statistic:+.3f} p={r.pvalue:.3g}"
                  f"   | vs session position rho={r2.statistic:+.3f} p={r2.pvalue:.3g}")
    print(f"\ndeposited -> data/fig12/fig12_timecourse_{{rate,coupling,events}}.csv")


if __name__ == "__main__":
    main()
