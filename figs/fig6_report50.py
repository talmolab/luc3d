#!/usr/bin/env python
"""Report `figs/out/fig8_methods_50.json` — Fig 8d's methods over ALL 50 BMimica sessions.

Fig 8a-8d are measured on the 8 sessions Fig 3e used, which is what makes their rates
comparable to Fig 3e's and is also their main weakness. This repo's own history is the
reason to care: `figs/README.md` records that Fig 4 over all 50 sessions REVERSED a
conclusion drawn from a subset. So a tracker change only earns a recommendation if it
survives here.

WHAT THIS PRINTS, AND WHY IN THIS ORDER.

1. A HARNESS CROSS-CHECK first. `figs/out/fig3_trackers.json` already carries an
   independent 50-session BMimica measurement of the shipped tracker — LUC3D cross-view
   IDF1 0.7493, within-view 0.7494, from earlier luc3d-bench runs through a different
   pipeline. If this pass's `shipped` cell does not land on that, the 50-session harness
   is wrong and nothing below it means anything. Printed before any result.

2. MEDIAN and quartiles, not just the mean. At n = 50 the mean hides the shape, and the
   shape is the whole question for a method whose 8-session gain was carried by a few
   sessions.

3. PER-SESSION win/loss and the WORST single-session harm. Two of the eight Fig 8
   sessions were already at their oracle ceiling and a method that gains on the mean by
   damaging them is not a candidate; over 50 sessions that risk is larger, not smaller.

4. A PAIRED test. The sessions are the same for every configuration, so the comparison is
   paired: Wilcoxon signed-rank on the per-session IDF1 differences, which assumes far
   less than a t-test about a bounded, skewed metric.

    $PY figs/fig6_report50.py

Run with the bench interpreter (needs scipy/numpy):
/root/vast/eric/luc3d-bench/liezl_env/bin/python
"""
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"

REFERENCE = ("figs/out/fig3_trackers.json", "bmimica_50_sessions", "LUC3D")


def harness_crosscheck(shipped):
    """Does this pass's shipped cell agree with the repo's existing 50-session number?"""
    p = OUT / "fig3_trackers.json"
    if not p.exists():
        print("[report50] fig3_trackers.json absent -- cross-check skipped")
        return
    d = json.loads(p.read_text())["bmimica_50_sessions"]["LUC3D"]
    ref_cross, ref_within = d["cross"]["mean"], d["within"]["mean"]
    print("HARNESS CROSS-CHECK (before any result is read)")
    print(f"  shipped tracker, this pass      cross {shipped['idf1_cross']:.4f}  "
          f"within {shipped['idf1_within']:.4f}  ({shipped['n_sessions']} sessions)")
    print(f"  shipped tracker, fig3_trackers  cross {ref_cross:.4f}  "
          f"within {ref_within:.4f}  ({d['cross']['n_sessions']} sessions)")
    dc = abs(shipped["idf1_cross"] - ref_cross)
    print(f"  agreement: {dc:.4f} on cross-view IDF1 -- "
          + ("OK, independent pipelines agree" if dc < 0.01 else
             "DISAGREES; investigate before trusting anything below"))
    print()


def main():
    p = OUT / "fig8_methods_50.json"
    if not p.exists():
        sys.exit(f"{p} missing -- run `$PY figs/fig6_methods.py --all-sessions ...` first")
    d = json.loads(p.read_text())
    cells = {c["config"]: c for c in d["cells"] if c.get("idf1_cross") is not None}
    if "shipped" not in cells:
        sys.exit("no `shipped` control in the 50-session deposit")
    cf = d["total_camera_frames"]
    base = {q["session"]: q for q in cells["shipped"]["per_session"]}

    print(f"ALL-SESSION BMIMICA PASS — {len(d['sessions'])} sessions, "
          f"{cf:,} camera-frames\n")
    harness_crosscheck(cells["shipped"])

    order = ["shipped", "dist25_corr36", "sync_stale10_dist25", "sync_stale1_dist25"]
    order += [k for k in cells if k not in order]

    print(f"{'configuration':<24}{'sw':>7}{'/100k':>8}{'mean':>8}{'median':>8}"
          f"{'q25':>7}{'q75':>7}{'bett':>6}{'wors':>6}{'worstIDF1':>11}{'worstSw':>9}")
    for name in order:
        c = cells.get(name)
        if not c:
            continue
        ps = c["per_session"]
        v = np.array([q["cross_idf1"] for q in ps])
        dv = np.array([q["cross_idf1"] - base[q["session"]]["cross_idf1"] for q in ps])
        ds = np.array([q["within_switches"] - base[q["session"]]["within_switches"]
                       for q in ps])
        print(f"{name:<24}{c['switches']:>7d}{c['switches'] * 1e5 / cf:>8.3f}"
              f"{v.mean():>8.4f}{np.median(v):>8.4f}{np.percentile(v, 25):>7.4f}"
              f"{np.percentile(v, 75):>7.4f}{int((dv > 1e-4).sum()):>6d}"
              f"{int((dv < -1e-4).sum()):>6d}{dv.min():>+11.4f}{int(ds.max()):>+9d}")

    print("\nPAIRED per-session comparisons (Wilcoxon signed-rank on IDF1 differences)")
    try:
        from scipy.stats import wilcoxon
    except ImportError:
        print("  scipy unavailable -- skipped")
        wilcoxon = None
    pairs = [("sync_stale1_dist25", "shipped"), ("sync_stale10_dist25", "shipped"),
             ("sync_stale1_dist25", "dist25_corr36"),
             ("sync_stale10_dist25", "dist25_corr36"),
             ("sync_stale1_dist25", "sync_stale10_dist25")]
    for a, b in pairs:
        if a not in cells or b not in cells:
            continue
        av = {q["session"]: q["cross_idf1"] for q in cells[a]["per_session"]}
        bv = {q["session"]: q["cross_idf1"] for q in cells[b]["per_session"]}
        common = sorted(set(av) & set(bv))
        dif = np.array([av[s] - bv[s] for s in common])
        nz = dif[np.abs(dif) > 1e-9]
        line = (f"  {a} vs {b}: n={len(common)}, "
                f"median diff {np.median(dif):+.4f}, "
                f"{int((dif > 1e-4).sum())} better / {int((dif < -1e-4).sum())} worse")
        if wilcoxon is not None and len(nz) >= 6:
            try:
                line += f", p={wilcoxon(nz).pvalue:.2g}"
            except Exception as e:  # noqa: BLE001
                line += f", wilcoxon failed ({e})"
        elif wilcoxon is not None:
            line += f", too few non-tied pairs ({len(nz)}) for a test"
        print(line)

    print("\nWORST sessions for each candidate (largest IDF1 loss against shipped)")
    for name in ("sync_stale1_dist25", "sync_stale10_dist25"):
        c = cells.get(name)
        if not c:
            continue
        rows = sorted(c["per_session"],
                      key=lambda q: q["cross_idf1"] - base[q["session"]]["cross_idf1"])[:5]
        print(f"  {name}:")
        for q in rows:
            s = q["session"]
            print(f"    {s}  {base[s]['cross_idf1']:.4f} -> {q['cross_idf1']:.4f} "
                  f"({q['cross_idf1'] - base[s]['cross_idf1']:+.4f})  "
                  f"sw {base[s]['within_switches']} -> {q['within_switches']}")


if __name__ == "__main__":
    main()
