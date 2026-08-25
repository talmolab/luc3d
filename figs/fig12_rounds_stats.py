#!/usr/bin/env python3
"""
SOC1 vs SOC3: the one place familiarity is manipulated with everything else fixed.

WHY THIS COMPARISON IS THE CLEAN ONE. Fig 12's cross-corpus contrast (SLAP-2M's familiar
cagemates against Mouse-Dyad-10M's novel pairs) differs in arena size, frame rate, session
length, strain, rig and lab, so it cannot isolate familiarity. SOC1 and SOC3 are rounds 1
and 3 of ONE round-robin over the SAME six rats (deposit README: "6 rats, round-robin
meeting round N"), ~2 weeks apart, in the same arena at the same 50 Hz. Fourteen animal
pairs are measured in BOTH rounds, so the test can be PAIRED on the pair itself.

WHAT IT SHOWS, and it is not what the cross-corpus panel suggests:
  * COORDINATION IS NULL IN BOTH ROUNDS AND DOES NOT MOVE. near ~= far in each round, so
    the proximity gating that makes Mouse-Dyad-10M's effect social never appears; and the
    initiator bias sits at its coin-flip null in both.
  * RATE FALLS with familiarity -- down in 11 of 14 pairs. This is the OPPOSITE direction
    to the cross-corpus comparison, where the FAMILIAR mice co-reared 13x MORE. Holding
    animals, arena, rig and frame rate fixed therefore reverses the sign, which is direct
    evidence that the SLAP-2M / Mouse-Dyad-10M rate gap is species or rig rather than
    familiarity. Fig 12b's rate bars must not be read as a familiarity result.

TWO LIMITS, both stated rather than buried. The rate test is MARGINAL (p ~ 0.04, n = 14)
and is one uncorrected test among several run on this data, so it is suggestive, not
established -- the Holm-corrected column is printed for that reason. And the familiarity
GRADIENT IS ASSUMED, not documented: the README says "meeting round N" but never states
the six rats were unfamiliar at round 1, and round 2 is unavailable (the SOC2 dataset
publishes zero files upstream), so this is meeting 1 vs meeting 3 under that assumption.

    figs/.venv/bin/python figs/fig12_social.py --corpus scn2a-r1 --corpus scn2a-r3 \\
        --out figs/out/fig12_scn2a_rounds.json
    figs/.venv/bin/python figs/fig12_rounds_stats.py
"""
from __future__ import annotations

import json
import re
from math import comb
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

HERE = Path(__file__).resolve().parent
SRC = HERE / "out" / "fig12_scn2a_rounds.json"
DEPOSIT = HERE / "data" / "fig12"

R1, R3 = "scn2a-r1", "scn2a-r3"
#: Paired measures. `initiator_bias` is carried as its EXCESS over the session's own
#: coin-flip expectation, never raw -- the raw statistic has a floor above 0.5 and a
#: round with fewer displays would score higher for arithmetic reasons alone.
MEASURES = [("rate_per_min", "displays per minute"),
            ("n_events", "displays"),
            ("bias_excess", "initiator bias over own null")]


def coin_bias(n):
    """E[max(k, n-k)/n] for k ~ Binomial(n, 1/2): the bias a fair coin produces."""
    return sum(comb(n, k) * 0.5 ** n * max(k, n - k) / n for k in range(n + 1))


def by_pair(leader):
    """Sessions keyed by the unordered animal pair, e.g. ('1','6') for M1_M6."""
    out = {}
    for r in leader["per_session"]:
        m = re.findall(r"M(\d)", r["session"])
        if len(m) != 2:
            continue
        r = dict(r)
        n = r["n_initiator_known"]
        r["bias_excess"] = (r["initiator_bias"] - coin_bias(n)
                            if n and r["initiator_bias"] is not None else np.nan)
        out[tuple(sorted(m))] = r
    return out


def main():
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}; run the --corpus scn2a-r1/-r3 measurement first")
    D = json.loads(SRC.read_text())
    L, C = D["leader"], D["coupling"]
    p1, p3 = by_pair(L[R1]), by_pair(L[R3])
    both = sorted(set(p1) & set(p3))

    # ---- per-pair table (the deposit; every number below is recomputable from it) ----
    rows = []
    for k in both:
        row = {"pair": f"M{k[0]}_M{k[1]}"}
        for fld, _ in MEASURES:
            row[f"r1_{fld}"] = p1[k].get(fld)
            row[f"r3_{fld}"] = p3[k].get(fld)
        rows.append(row)
    per_pair = pd.DataFrame(rows)
    DEPOSIT.mkdir(parents=True, exist_ok=True)
    per_pair.to_csv(DEPOSIT / "fig12_scn2a_rounds_per_pair.csv", index=False)

    # ---- paired tests ----
    tests = []
    for fld, label in MEASURES:
        a = np.array([p1[k].get(fld, np.nan) for k in both], float)
        b = np.array([p3[k].get(fld, np.nan) for k in both], float)
        ok = np.isfinite(a) & np.isfinite(b)
        a, b = a[ok], b[ok]
        d = b - a
        w = stats.wilcoxon(a, b)
        # Sign test alongside Wilcoxon: with n = 14 the signed-rank statistic leans on
        # the magnitudes, and the count of pairs that moved is the more robust summary.
        n_down = int((d < 0).sum())
        sign_p = stats.binomtest(n_down, len(d), 0.5).pvalue
        tests.append({
            "measure": label, "field": fld, "n_pairs": len(d),
            "r1_median": float(np.median(a)), "r3_median": float(np.median(b)),
            "median_change": float(np.median(d)),
            "n_down": n_down, "n_up": int((d > 0).sum()),
            "wilcoxon_p": float(w.pvalue), "sign_test_p": float(sign_p),
            # Rank-biserial: the paired effect size Wilcoxon implies, in [-1, 1].
            "effect_r": float(1 - 2 * w.statistic / (len(d) * (len(d) + 1) / 2)),
        })
    t = pd.DataFrame(tests)
    # Holm over the three paired tests, because they are reported together.
    order = np.argsort(t["wilcoxon_p"].values)
    holm = np.empty(len(t))
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, (len(t) - rank) * t["wilcoxon_p"].values[i])
        holm[i] = min(1.0, running)
    t["wilcoxon_p_holm"] = holm
    t.to_csv(DEPOSIT / "fig12_scn2a_rounds_tests.csv", index=False)

    # ---- corpus-level coordination summary (not paired: curves are aggregated) ----
    crows = []
    for key, lbl in ((R1, "round 1"), (R3, "round 3")):
        c = C[key]
        tt = np.asarray(c["t"], float)
        rec = {"round": lbl, "n_sessions": c["n_sessions"],
               "near_onsets": c["n_onsets"]["near"]}
        for cond in ("near", "far", "near_q", "null"):
            x = c[cond]
            if not x:
                rec[f"{cond}_peak"] = np.nan
                continue
            p = np.asarray(x["p50"], float)
            i = int(np.nanargmax(p))
            rec[f"{cond}_peak"] = float(p[i])
            rec[f"{cond}_peak_lag_s"] = float(tt[i])
        rec["near_minus_far"] = rec["near_peak"] - rec["far_peak"]
        crows.append(rec)
    co = pd.DataFrame(crows)
    co.to_csv(DEPOSIT / "fig12_scn2a_rounds_coupling.csv", index=False)

    pd.set_option("display.width", 200, "display.max_columns", 50)
    print(f"\nSOC1 vs SOC3 — {len(both)} animal pairs measured in both rounds\n")
    print("PAIRED TESTS")
    print(t[["measure", "n_pairs", "r1_median", "r3_median", "median_change",
             "n_down", "n_up", "effect_r", "wilcoxon_p", "sign_test_p",
             "wilcoxon_p_holm"]].to_string(index=False, float_format=lambda v: f"{v:.4g}"))
    print("\nCOORDINATION (corpus-level; near ~= far in both rounds = shared drive)")
    print(co[["round", "n_sessions", "near_onsets", "near_peak", "far_peak",
              "near_minus_far", "near_q_peak", "null_peak"]].to_string(
                  index=False, float_format=lambda v: f"{v:.3g}"))
    print("\nPER-PAIR")
    print(per_pair.to_string(index=False, float_format=lambda v: f"{v:.3g}"))
    print(f"\ndeposited -> {DEPOSIT.relative_to(HERE.parent)}/fig12_scn2a_rounds_"
          "{per_pair,tests,coupling}.csv")


if __name__ == "__main__":
    main()
