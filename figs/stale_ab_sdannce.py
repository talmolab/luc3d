#!/usr/bin/env python3
"""Eviction A/B on social-DANNCE (2026-10-18): LUC3D v1.0.5 C1_sigma0 at stale 0
(fig10-bench/results_v105_stale0, FIG10_PARAMS={"thresholds":{"stale":0}}) against the
paper's stale-20 deposit (fig10-bench/results_v105, shipped defaults). Same prep seeds, so
the only difference is the eviction window.

    python3 figs/stale_ab_sdannce.py      -> figs/out/stale_ab_sdannce.json
"""
import json
from pathlib import Path

B = Path(__file__).resolve().parent / "fig10-bench"
ARMS = {"stale20": B / "results_v105", "stale0": B / "results_v105_stale0"}


def load(root):
    return {(p.parent.parent.name, p.parent.name): json.loads(p.read_text())
            for p in root.glob("*/*/C1_sigma0.json")}


def main():
    runs = {a: load(r) for a, r in ARMS.items()}
    keys = sorted(runs["stale20"])
    if sorted(runs["stale0"]) != keys:
        raise SystemExit(f"session sets differ: {len(runs['stale0'])} vs {len(keys)}")
    out = {"cell": "C1_sigma0", "n_sessions": len(keys), "arms": {}, "per_session": []}
    for a in ARMS:
        rs = [runs[a][k] for k in keys]
        out["arms"][a] = {"switches": sum(r["switches"] for r in rs),
                          "zero_switch_sessions": sum(r["switches"] == 0 for r in rs),
                          "idf1_mean": sum(r["idf1"] for r in rs) / len(rs)}
        for ds in sorted({k[0] for k in keys}):
            d = [runs[a][k] for k in keys if k[0] == ds]
            out["arms"][a][ds] = {"switches": sum(r["switches"] for r in d),
                                  "zero_switch": f"{sum(r['switches'] == 0 for r in d)}/{len(d)}",
                                  "idf1_mean": sum(r["idf1"] for r in d) / len(d)}
    for k in keys:
        z, t = runs["stale0"][k], runs["stale20"][k]
        if z["idf1"] != t["idf1"] or z["switches"] != t["switches"]:
            out["per_session"].append({"dataset": k[0], "session": k[1],
                                       "idf1_stale0": z["idf1"], "idf1_stale20": t["idf1"],
                                       "sw_stale0": z["switches"], "sw_stale20": t["switches"]})
    (B.parent / "out" / "stale_ab_sdannce.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if k != "per_session"}, indent=1))
    print(f"{len(out['per_session'])} of {len(keys)} sessions differ:")
    for r in out["per_session"]:
        print(" ", r)


if __name__ == "__main__":
    main()
