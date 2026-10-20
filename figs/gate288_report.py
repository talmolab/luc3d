"""GATE288 (2026-10-16, Eric): does matchGate=1 (#248, turned off by #288) still hurt now
that Mouse-Dyad uses the b3 pool? Markdown only, no figure. Both arms LUC3D v1.0.5 (2dc001fe).
  Mouse-Dyad-10M: b3 (det_h5_bvis5, tail in tracking, tail-free scoring), 56 sessions,
    r = 6, stale 20, dist 25. Gate 0 = the fig3b sweep's r=6 cell; gate 1 = new cell.
  s-DANNCE: C1_sigma0, 41 sessions. Gate 0 = SDV105 results_v105; gate 1 = results_v105_gate1.
"""
import json, glob, os, sys
F = "/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs"
OUT = f"{F}/figures/drafts/GATE288-B3-REPORT-2026-10-16.md"

def md_cell(path, r=6):
    d = json.load(open(path))
    c = [c for c in d["cells"] if c["corr3d"] == r and c["corr2d"] == 1][0]
    return {p["session"]: p for p in c["per_session"]}, d["total_camera_frames"], d["lucid_commit"]

g0, frames, c0 = md_cell(f"{F}/out/fig3_sweep50__distanceThreshold25-stale20_f7733dbf_b3.json")
g1, _, c1 = md_cell(f"{F}/out/fig3_sweep50__distanceThreshold25-matchGate1-stale20_114e4384_b3.json")
assert set(g0) == set(g1), "session sets differ"
S = sorted(g0)
def tot(g, k): return sum(g[s][k] for s in S)
def mean(g, k): return sum(g[s][k] for s in S) / len(S)
worse = sum(g1[s]["cross_idf1"] < g0[s]["cross_idf1"] - 1e-12 for s in S)
better = sum(g1[s]["cross_idf1"] > g0[s]["cross_idf1"] + 1e-12 for s in S)
ident = all(g0[s]["cross_switches"] == g1[s]["cross_switches"] and g0[s]["cross_idf1"] == g1[s]["cross_idf1"] for s in S)

R = f"{F}/fig10-bench"
def sd(root):
    out = {}
    for p in glob.glob(f"{root}/*/*/C1_sigma0.json"):
        j = json.load(open(p)); out[(j["dataset"], j["session_name"])] = j
    return out
s0, s1 = sd(f"{R}/results_v105"), sd(f"{R}/results_v105_gate1")
assert set(s0) == set(s1) and len(s0) == 41, (len(s0), len(s1))
K = sorted(s0)
sw0, sw1 = sum(s0[k]["switches"] for k in K), sum(s1[k]["switches"] for k in K)
i0, i1 = sum(s0[k]["idf1"] for k in K) / len(K), sum(s1[k]["idf1"] for k in K) / len(K)
sworse = sum(s1[k]["idf1"] < s0[k]["idf1"] - 1e-12 for k in K)
sbetter = sum(s1[k]["idf1"] > s0[k]["idf1"] + 1e-12 for k in K)

def ratio(a, b): return f"{b / a:.1f}x" if a else "n/a"
cw0, cw1 = tot(g0, "cross_switches"), tot(g1, "cross_switches")
L = [
 "# Match gate (#248 / #288) re-check on the b3 filtering",
 "",
 "2026-10-16. Markdown only, no figure. Both arms use LUC3D v1.0.5 "
 f"(Mouse-Dyad commits: gate 0 `{c0[:8]}`, gate 1 `{c1[:8]}`).",
 "",
 "The question: #288 turned the gate off because it gave about 6x the ID switches on "
 "Mouse-Dyad-10M and 10x on s-DANNCE. Is that still true now that Mouse-Dyad uses the b3 pool?",
 "",
 "## Result",
 "",
 "| Dataset | Gate 0 switches | Gate 1 switches | Ratio | Gate 0 IDF1 | Gate 1 IDF1 | Sessions worse / better |",
 "|---|---|---|---|---|---|---|",
 f"| Mouse-Dyad-10M, b3, 56 sessions, r = 6 (cross-view) | {cw0} | {cw1} | {ratio(cw0, cw1)} | "
 f"{mean(g0, 'cross_idf1'):.4f} | {mean(g1, 'cross_idf1'):.4f} | {worse} / {better} |",
 f"| s-DANNCE, C1_sigma0, 41 sessions | {sw0} | {sw1} | {ratio(sw0, sw1)} | {i0:.4f} | {i1:.4f} | {sworse} / {sbetter} |",
 "",
 f"Mouse-Dyad within-view switches: {tot(g0, 'within_switches')} -> {tot(g1, 'within_switches')}. "
 f"Per 100k camera-frames (cross): {cw0 / frames * 1e5:.2f} -> {cw1 / frames * 1e5:.2f}. IDF1 is the session mean.",
 "",
 "Earlier result that #288 rests on (`lucid-matchgate/figs/MATCHGATE-REPORT.md`, 2026-10-07, "
 "pre-v1.0.5 code, 50 sessions, old filtered pool): Mouse-Dyad 413 -> 2,494 switches "
 "(cross IDF1 0.861 -> 0.728). s-DANNCE 10 -> 118 switches (IDF1 0.985 -> 0.953).",
 "",
 "## Like-for-like check",
 "",
 "- Same sessions in both arms (asserted). Same code (v1.0.5). Same thresholds except matchGate.",
 "- Mouse-Dyad: b3 pool, tail in tracking, tail-free scoring, in both arms. Gate 0 is the cell Fig 3b G/H plots at r = 6.",
 "- s-DANNCE: the detections are synthesized from GT with the same per-cell seeds, so its input did not change with the b3 filtering. "
 "Only the code version differs from the 10-07 test.",
 f"- Gate had an effect on Mouse-Dyad (outputs not identical): {not ident}.",
 "",
 "## Per-session, Mouse-Dyad (cross IDF1 / cross switches)",
 "",
 "| Session | Gate 0 | Gate 1 |", "|---|---|---|",
] + [f"| {s} | {g0[s]['cross_idf1']:.4f} / {g0[s]['cross_switches']} | {g1[s]['cross_idf1']:.4f} / {g1[s]['cross_switches']} |" for s in S] + [
 "", "## Per-session, s-DANNCE (IDF1 / switches)", "",
 "| Dataset / session | Gate 0 | Gate 1 |", "|---|---|---|",
] + [f"| {d}/{s} | {s0[(d, s)]['idf1']:.4f} / {s0[(d, s)]['switches']} | {s1[(d, s)]['idf1']:.4f} / {s1[(d, s)]['switches']} |" for d, s in K]
open(OUT, "w").write("\n".join(L) + "\n")
print(f"RESULT Mouse-Dyad sw {cw0}->{cw1} ({ratio(cw0, cw1)}) IDF1 {mean(g0,'cross_idf1'):.4f}->{mean(g1,'cross_idf1'):.4f} | "
      f"s-DANNCE sw {sw0}->{sw1} ({ratio(sw0, sw1)}) IDF1 {i0:.4f}->{i1:.4f} | wrote {OUT}")
