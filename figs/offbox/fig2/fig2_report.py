#!/usr/bin/env python3
"""Every number the manuscript quotes off fig2.json, computed the way the panels
compute it (src.data_loader.median across sessions, not a pooled statistic)."""
import json
import math
import statistics
import sys

NODES = 15


def med(xs):
    return statistics.median(xs)


def report(path):
    d = json.load(open(path))
    ps = d["per_session"]
    print(f"=== {path}")
    print(f"sessions                       {d['n_sessions']}")
    strides = sorted({s["stride"] for s in ps})
    fu = [s["frames_used"] for s in ps]
    print(f"stride                         {strides}")
    print(f"frames_used per session        {min(fu)}-{max(fu)} (median {med(fu):.0f})")
    print(f"frames_used total              {sum(fu):,}")
    print(f"frames_total (corpus)          {sum(s['frames_total'] for s in ps):,}")
    K = sum(s["keypoints_used"] for s in ps)
    print(f"keypoints total                {K:,}")
    print(f"retained_frac (median)         {med([s['retained_frac'] for s in ps]):.4f}")

    for key in ("held_out_vs_observation", "held_out"):
        a = {k: med([s[key][k] for s in ps])
             for k in ("p5", "p25", "p50", "p75", "p90", "p95", "p99",
                       "acc2", "acc5", "acc10", "acc20", "acc40")}
        n = sum(s[key]["n"] for s in ps)
        print(f"-- {key}: n = {n:,}")
        print(f"   median px                   {a['p50']:.4f}")
        print(f"   p90 / p95 / p99 px          {a['p90']:.3f} / {a['p95']:.3f} / {a['p99']:.3f}")
        print(f"   <= 5 px                     {a['acc5']*100:.4f}%")
        print(f"   <= 10 px                    {a['acc10']*100:.4f}%")
        print(f"   <= 20 px                    {a['acc20']*100:.4f}%")
        print(f"   OUTSIDE 10 px               {(1-a['acc10'])*100:.4f}%")

    # Fig 2b placements
    accs = {t: med([s["held_out_vs_observation"][f"acc{t}"] for s in ps])
            for t in (5, 10)}
    ncam = {s["cameras"] for s in ps}
    assert len(ncam) == 1, ncam
    C = ncam.pop()
    for t in (10, 5):
        p = 1 - accs[t]
        aided = 2 * NODES + (C - 2) * NODES * p
        trad = C * NODES
        print(f"placements tau={t}px C={C}      {trad:.0f} -> {aided:.2f}  "
              f"({trad/aided:.4f}x, p={p:.5f})")

    # Fig 2d law
    rows = {}
    for s in ps:
        for k, v in (s.get("err3d_mm_by_pair") or {}).items():
            r = rows.setdefault(k, {"b": [], "p50": [], "n": 0})
            r["b"].append(v["baseline_deg"])
            r["p50"].append(v["p50"])
            r["n"] += v.get("n", 0)
    pairs = sorted(((med(r["b"]), med(r["p50"]), k, r["n"]) for k, r in rows.items()))
    k_const = med([e * math.sin(math.radians(b)) for b, e, _, _ in pairs])
    floor = med([s["err3d_mm_by_anchor_count"]["5"]["p50"] for s in ps])
    within = sum(1 for b, e, _, _ in pairs
                 if abs(e - k_const / math.sin(math.radians(b))) / (k_const / math.sin(math.radians(b))) <= 0.25)
    print(f"depth constant k               {k_const:.4f} mm")
    print(f"all-5-view floor               {floor:.4f} mm")
    print(f"in-sample band                 {within}/{len(pairs)} within +/-25%")
    print(f"widest pair                    {pairs[-1][2]} {pairs[-1][0]:.2f} deg  {pairs[-1][1]:.3f} mm")
    print(f"narrowest pair                 {pairs[0][2]} {pairs[0][0]:.2f} deg  {pairs[0][1]:.3f} mm")
    print(f"range                          {pairs[0][1]/pairs[-1][1]:.3f}x")
    print(f"two-anchor solves              {sum(p[3] for p in pairs):,}")
    for kk in ("2", "3", "4", "5"):
        v = med([s["err3d_mm_by_anchor_count"][kk]["p50"] for s in ps])
        print(f"   3D err k={kk} anchors (mm)     {v:.4f}")
    for kk in ("2", "3", "4"):
        v = med([s["by_anchor_count"][kk]["p50"] for s in ps])
        print(f"   held-out px k={kk} anchors      {v:.4f}")
    xv = med([s["crossview_resid"]["p50"] for s in ps])
    print(f"cross-view resid median px     {xv:.4f}")
    print()


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
