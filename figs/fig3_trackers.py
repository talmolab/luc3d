#!/usr/bin/env python3
"""
Aggregate the luc3d-bench tracker benchmark into figs/out/fig3_trackers.json.

Nothing here is recomputed from raw video: these tracker runs already exist in
luc3d-bench, on a shared identity-stripped detection pool, over full-length sessions.
What this script does is (a) pin the provenance to the SHIPPED LUC3D configuration and
(b) derive the session-level paired statistics the figures need.

=============================== PROVENANCE (read this) =========================
luc3d-bench/outputs/metrics/ holds THREE mutually inconsistent runs under the single
label "luc3d", and none of them is the shipped app:

  metrics/per_camera_session_metrics.csv  (May 18 06:55)  IDF1 0.738301, frag 7.27
  metrics/by_tracker.csv + by_animals/by_bedding/by_camera (May 18 01:55)
                                                          IDF1 0.736490, frag 7.52
  metrics/auc_summary.tsv                 (May 19)        IDF1 0.7383

The 06:55 per-camera file is an evaluation of outputs/luc3d_results_v2/, which was
produced by re-running the tracker with outputs/luc3d_winner_params.json --
`applyUndercountVerifyClean` + `applyInterpolation` (interpMaxGap 5), `uvMaxAcceptCost`,
`uvMinMargin`. Those knobs exist ONLY in the bench harness
(luc3d-bench/scripts/luc3d_track_all.mjs, opt-in via TRACKER_PARAMS); grepping the LUCID
source for any of them returns nothing. They are a benchmark post-processing variant, not
the shipped tool, and must never be plotted as "LUC3D". The 01:55 aggregates are a third
run whose per-camera file was overwritten and no longer exists.

The shipped run IS on disk: outputs/luc3d_results/ was produced with no --params, i.e.
with the app's own defaults, and its evaluation survives as

  outputs/PAF_3d_kalman/_eval_baseline.csv                IDF1 0.736035, frag 28.11

VERIFIED, not assumed: `scripts/evaluate.py`'s own `eval_camera` was re-run over
outputs/luc3d_results/ and the result is bit-identical to _eval_baseline.csv on all
1,332 rows x 10 metric columns (max abs difference 0.0). PAF_3d_kalman/metrics/
headline.csv independently labels these numbers "LUC3D (baseline)" and its "LUC3D + PAF
(L1 only)" variant is 0.738089 -- i.e. metrics/'s 0.738301 sits with the PAF variant,
not with the baseline. So this file, and only this file, is the SLAP-2M source here.

Cross-view IDF1 does not exist in that corpus at all, so the cross-view panel uses the
one corpus that has it:

  outputs/bmimica/bmimica_crossview_all_eval.csv          50 sessions, 5 cameras, 4 trackers

which was produced by scripts/bartul/bmimica_luc3d_real.py driving LUCID's OWN headless
driver, lucid/scripts/bench/bench_crossview.mjs, at its default thresholds
(corr3dWeight = 6) -- again the shipped code path, no post-processing.

Two corpora, two files, one shipped configuration. Every SLAP-2M number in Figs 3 and 7
comes from _eval_baseline.csv and every cross-view number from
bmimica_crossview_all_eval.csv. No other bench metrics file is read.
================================================================================

WHY WITHIN-VIEW AND CROSS-VIEW MUST BOTH BE REPORTED. Within-view IDF1 scores each
camera separately with its own optimal identity relabelling, so a per-camera tracker can
score well while assigning unrelated labels in every view -- it cannot fail the metric on
the thing multi-view is for. Cross-view IDF1 pools all cameras into one accumulator with
one global identity per animal. For a tracker with no cross-view association mechanism
the best a camera-local label can do is cover one camera's share, so cross-view IDF1 is
bounded near 1/C. That ceiling is a definitional consequence of the property being
measured, not a bug, and must be stated. See outputs/subgroup_7_7_2026/README.md.

Unit of replication is the SESSION throughout: per-camera rows are averaged up to one
value per session before any statistic is taken, so a session does not count more
heavily for having more cameras.

Usage: python3 figs/fig3_trackers.py
"""
from __future__ import annotations

import csv
import json
import math
import os
import random
import statistics as st
from collections import defaultdict

BENCH = "/root/vast/eric/luc3d-bench/outputs"
# The ONLY two bench metrics files this figure reads. See PROVENANCE above.
SLAP2M = f"{BENCH}/PAF_3d_kalman/_eval_baseline.csv"
BM_XVIEW = f"{BENCH}/bmimica/bmimica_crossview_all_eval.csv"
# n = 1 session, recorded in the JSON for the record and deliberately NOT plotted.
HARD = f"{BENCH}/subgroup_7_7_2026/crossview_hardsession_metric.csv"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "fig3_trackers.json")

BM_TRACKERS = [("luc3d", "LUC3D"), ("sleap", "SLEAP per-camera"),
               ("byte", "ByteTrack"), ("muppet", "3D-MuPPET")]


# ------------------------------------------------------------------ statistics ---
def mean(v):
    return sum(v) / len(v)


def boot_ci(vals, n=20000, seed=0):
    """Percentile bootstrap CI of the mean, resampling SESSIONS."""
    if len(vals) < 2:
        return [None, None]
    rng = random.Random(seed)
    k = len(vals)
    means = [mean([vals[rng.randrange(k)] for _ in range(k)]) for _ in range(n)]
    means.sort()
    return [means[int(0.025 * n)], means[int(0.975 * n)]]


def sign_p(pos, n):
    """Exact two-sided sign test. No SciPy in the figure environment, and an exact
    binomial is both trivial and unimpeachable at these n."""
    if n == 0:
        return 1.0
    k = min(pos, n - pos)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def wilcoxon_p(d):
    """Wilcoxon signed-rank, normal approximation with continuity correction and
    mid-ranks for ties. n >= 3 here, so the approximation is adequate; the exact sign
    test is reported alongside it."""
    d = [x for x in d if x != 0]
    n = len(d)
    if n < 3:
        return None
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    W = sum(ranks[i] for i in range(n) if d[i] > 0)
    mu = n * (n + 1) / 4
    sd = math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
    z = (abs(W - mu) - 0.5) / sd
    return 2 * (1 - 0.5 * (1 + math.erf(z / math.sqrt(2))))


def pearson(x, y):
    mx, my = mean(x), mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def summarise(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    lo, hi = boot_ci(vals)
    s = sorted(vals)
    n = len(s)
    return dict(n_sessions=n, mean=mean(s), sd=(st.stdev(s) if n > 1 else 0.0),
                median=s[n // 2], q25=s[int(0.25 * n)], q75=s[int(0.75 * n)],
                min=s[0], max=s[-1], ci95_lo=lo, ci95_hi=hi)


def read_csv(path, delim=","):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f, delimiter=delim))


# ------------------------------------------------------------------- SLAP-2M ---
def slap2m():
    rows = read_csv(SLAP2M)
    if not rows:
        return {}
    per = defaultdict(lambda: defaultdict(list))     # tracker -> session -> rows
    cov = {}
    for r in rows:
        per[r["tracker"]][r["session"]].append(r)
        cov[r["session"]] = dict(animals=int(r["animals"]), bedding=r["bedding"],
                                 difficulty=int(r["difficulty"]))
    trackers = sorted(per)
    sessions = sorted(per["luc3d"])

    def sess_mean(tr, col):
        return {s: mean([float(x[col]) for x in rs if x[col] != ""])
                for s, rs in per[tr].items()}

    idf1 = {t: sess_mean(t, "idf1") for t in trackers}
    # The detection pool is shared, so any tracker's recall measures the DETECTOR.
    # LUC3D's is used as the pool's recall; the three agree to ~0.003.
    recall = sess_mean("luc3d", "recall")

    within = {}
    for t in trackers:
        vals = [idf1[t][s] for s in sessions]
        d = summarise(vals)
        d["per_session"] = sorted(vals)
        within[t] = d

    # paired per-session difference against SLEAP, by animal count. The whole point of
    # this shape is that n is visible: the 3- and 4-animal cells are 4 and 3 sessions.
    paired = {}
    for key in ("1", "2", "3", "4", "all"):
        ss = [s for s in sessions
              if key == "all" or cov[s]["animals"] == int(key)]
        if not ss:
            continue
        d = [idf1["luc3d"][s] - idf1["sleap"][s] for s in ss]
        lo, hi = boot_ci(d)
        wins = sum(1 for x in d if x > 0)
        paired[key] = dict(n_sessions=len(ss), mean=mean(d), median=st.median(d),
                           ci95_lo=lo, ci95_hi=hi, wins=wins, losses=len(ss) - wins,
                           sign_p=sign_p(wins, len(ss)), wilcoxon_p=wilcoxon_p(d),
                           per_session=sorted(d),
                           bedding=dict(black=sum(1 for s in ss
                                                  if cov[s]["bedding"] == "black"),
                                        white=sum(1 for s in ss
                                                  if cov[s]["bedding"] == "white")),
                           difficulties=sorted({cov[s]["difficulty"] for s in ss}))

    # camera-session-weighted IDF1 per animal count -- the number the previous caption
    # quoted from by_animals.csv, recomputed on the shipped run.
    by_animals = defaultdict(dict)
    cs = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if r["idf1"]:
            cs[int(r["animals"])][r["tracker"]].append(float(r["idf1"]))
    for a, d in cs.items():
        for t, v in d.items():
            by_animals[str(a)][t] = dict(idf1=mean(v), n_camera_sessions=len(v))

    by_bedding = {}
    for b in ("black", "white"):
        ss = [s for s in sessions if cov[s]["bedding"] == b]
        if not ss:
            continue
        by_bedding[b] = dict(
            n_sessions=len(ss),
            detector_recall=mean([recall[s] for s in ss]),
            **{t: dict(idf1=mean([idf1[t][s] for s in ss])) for t in trackers})

    errdec = {}
    for t in trackers:
        rs = [x for d in per[t].values() for x in d]
        fp = sum(int(float(x["num_false_positives"])) for x in rs)
        fn = sum(int(float(x["num_misses"])) for x in rs)
        sw = sum(int(float(x["num_switches"])) for x in rs)
        gt = sum(int(float(x["num_objects"])) for x in rs)
        tot = fp + fn + sw
        errdec[t] = dict(false_positives=fp, false_negatives=fn, id_switches=sw,
                         gt_instances=gt, fn_share=fn / tot, fp_share=fp / tot,
                         idsw_share=sw / tot)

    # what the within-view metric is actually measuring
    xs = [recall[s] for s in sessions]
    n = len(xs)
    rec_corr = {}
    for t in trackers:
        r = pearson(xs, [idf1[t][s] for s in sessions])
        rec_corr[t] = dict(r=r, r2=r * r, n_sessions=n,
                           t_stat=r * math.sqrt((n - 2) / (1 - r * r)))
    # Column 4 is bytetrack IDF1, APPENDED (not inserted) so positional consumers
    # of columns 0-3 keep working: figs/panels/fig7_07_recall.py reads 0, 1, 2.
    # Columns: [recall, luc3d IDF1, sleap IDF1, n_animals, bytetrack IDF1].
    rec_corr["per_session"] = [[recall[s], idf1["luc3d"][s], idf1["sleap"][s],
                               cov[s]["animals"], idf1["bytetrack"][s]]
                               for s in sessions]

    # camera-session level wins (3-way argmax and pairwise), ties counted not hidden
    cscore = defaultdict(dict)
    for r in rows:
        if r["idf1"]:
            cscore[(r["session"], r["camera"])][r["tracker"]] = float(r["idf1"])
    argmax = defaultdict(int)
    for v in cscore.values():
        top = max(v.values())
        best = [t for t in v if v[t] == top]
        argmax["tie" if len(best) > 1 else best[0]] += 1
    pairwise = {}
    for a, b in (("luc3d", "sleap"), ("luc3d", "bytetrack"), ("sleap", "bytetrack")):
        ab = sum(1 for v in cscore.values() if v.get(a, 0) > v.get(b, 0))
        ba = sum(1 for v in cscore.values() if v.get(b, 0) > v.get(a, 0))
        pairwise[f"{a}_vs_{b}"] = dict(a_wins=ab, b_wins=ba,
                                       ties=len(cscore) - ab - ba, total=len(cscore))

    survival = {f"{th:g}": {t: sum(1 for s in sessions if idf1[t][s] >= th)
                            for t in trackers} for th in (0.2, 0.3, 0.5, 0.7, 0.9)}

    # Frame-count denominators, so error_decomposition's raw counts can be quoted
    # as rates (e.g. per 100,000 camera-frames). Source: the num_frames column of
    # _eval_baseline.csv itself (motmetrics' frame count per camera-session).
    # Asserted, not assumed: num_frames is identical across the three trackers for
    # every camera-session AND identical across the 6 cameras within every session,
    # so total_camera_frames sums the 444 camera-sessions and total_video_frames
    # sums one per-session value over the 74 sessions.
    frames_cs = {}                                # (session, camera) -> num_frames
    for r in rows:
        nf = int(float(r["num_frames"]))
        k = (r["session"], r["camera"])
        assert frames_cs.setdefault(k, nf) == nf, f"num_frames varies by tracker {k}"
    frames_sess = {}
    for (s, _c), nf in frames_cs.items():
        assert frames_sess.setdefault(s, nf) == nf, f"num_frames varies by camera {s}"
    total_camera_frames = sum(frames_cs.values())
    total_video_frames = sum(frames_sess.values())

    # the honest negative: LUC3D fragments more than SLEAP
    frag = {t: sess_mean(t, "num_fragmentations") for t in trackers}
    fd = [frag["luc3d"][s] - frag["sleap"][s] for s in sessions]
    lo, hi = boot_ci(fd)
    frag_paired = dict(mean=mean(fd), median=st.median(fd), ci95_lo=lo, ci95_hi=hi,
                       n_sessions=len(fd), wins=sum(1 for x in fd if x < 0),
                       wilcoxon_p=wilcoxon_p(fd), units="fragmentations per camera")

    return dict(source=SLAP2M, n_sessions=len(sessions), n_camera_sessions=len(cscore),
                total_camera_frames=total_camera_frames,
                total_video_frames=total_video_frames,
                frames_source=("num_frames column of _eval_baseline.csv (motmetrics "
                               "per-camera-session frame count); identical across "
                               "trackers per camera-session and across cameras per "
                               "session, verified by assertion at aggregation time"),
                within_view=within, paired_vs_sleap=paired, by_animals=by_animals,
                by_bedding=by_bedding, error_decomposition=errdec,
                detector_recall_corr=rec_corr, camera_session_argmax=dict(argmax),
                camera_session_pairwise=pairwise, survival_n_sessions=survival,
                fragmentations_paired=frag_paired,
                animals_per_session={str(a): sum(1 for s in sessions
                                                 if cov[s]["animals"] == a)
                                     for a in sorted({c["animals"]
                                                      for c in cov.values()})})


# ------------------------------------------------------------------- BMimica ---
def bmimica():
    rows = read_csv(BM_XVIEW)
    if not rows:
        return {}
    out = {}
    for key, name in BM_TRACKERS:
        within = [float(r[f"{key}_idf1"]) for r in rows if r.get(f"{key}_idf1")]
        cross = [float(r[f"{key}_xview_idf1"]) for r in rows
                 if r.get(f"{key}_xview_idf1")]
        sw2d = [float(r[f"{key}_sw2d"]) for r in rows if r.get(f"{key}_sw2d")]
        swx = [float(r[f"{key}_xview_sw"]) for r in rows if r.get(f"{key}_xview_sw")]
        drift = [abs(w - c) for w, c in zip(within, cross)]
        signed = [c - w for w, c in zip(within, cross)]
        ratio = [c / w for w, c in zip(within, cross) if w > 0]
        rl, rh = boot_ci(ratio)
        out[name] = dict(
            within=summarise(within), cross=summarise(cross),
            switches_2d_total=int(sum(sw2d)), switches_xview_total=int(sum(swx)),
            cross_over_within=dict(mean=mean(ratio), ci95_lo=rl, ci95_hi=rh),
            drift_abs_max=max(drift), drift_abs_median=st.median(drift),
            drift_wilcoxon_p=wilcoxon_p(signed),
            drift_sign_p=sign_p(sum(1 for x in signed if x > 0),
                                sum(1 for x in signed if x != 0)),
            per_session_within=within, per_session_cross=cross)
    # LUC3D vs each other tracker, per session, both metrics
    wins = {}
    for key, name in BM_TRACKERS[1:]:
        w = {}
        for m, lbl in (("idf1", "within"), ("xview_idf1", "cross")):
            k = sum(1 for r in rows
                    if float(r[f"luc3d_{m}"]) > float(r[f"{key}_{m}"]))
            w[lbl] = dict(wins=k, n=len(rows), sign_p=sign_p(k, len(rows)))
        wins[name] = w
    out["_luc3d_wins_vs"] = wins
    out["_n_sessions"] = len(rows)
    return out


def main():
    bm = bmimica()
    sl = slap2m()

    hard = {}
    for r in read_csv(HARD):
        hard[r["tracker"]] = dict(within=float(r["per_camera_idf1"]),
                                  cross=float(r["crossview_idf1"]),
                                  switches_xview=int(r["crossview_switches"]),
                                  switches_within=int(r["within_switches_sum"]))

    payload = dict(
        generated_by="figs/fig3_trackers.py",
        provenance=dict(
            slap2m_within_view=SLAP2M,
            bmimica_cross_view=BM_XVIEW,
            shipped_configuration=(
                "LUC3D with the app's shipped defaults. SLAP-2M: outputs/luc3d_results/ "
                "run with no --params (luc3d-bench/scripts/luc3d_track_all.mjs leaves "
                "every threshold at the app's default), evaluated in "
                "PAF_3d_kalman/_eval_baseline.csv. BMimica: LUCID's own "
                "scripts/bench/bench_crossview.mjs at default thresholds "
                "(corr3dWeight = 6)."),
            verification=(
                "scripts/evaluate.py's eval_camera was re-run over "
                "outputs/luc3d_results/ and reproduces _eval_baseline.csv bit-identically "
                "on all 1,332 rows (max abs difference 0.0 across idf1/idp/idr/switches/"
                "fragmentations/recall/precision/misses/false_positives/objects)."),
            rejected=[
                "outputs/metrics/per_camera_session_metrics.csv (IDF1 0.738301, frag "
                "7.27): an evaluation of outputs/luc3d_results_v2/, which was produced "
                "with outputs/luc3d_winner_params.json (applyUndercountVerifyClean, "
                "applyInterpolation interpMaxGap 5, uvMaxAcceptCost 120, uvMinMargin "
                "1.2). Those options exist only in the bench harness, not in the LUCID "
                "source, so this is a post-processed variant and not the shipped tool.",
                "outputs/metrics/by_tracker.csv / by_animals.csv / by_bedding.csv / "
                "by_camera.csv / session_wins.csv / session_pairwise.csv / "
                "worst_idf1_luc3d.csv (IDF1 0.736490, frag 7.52): aggregates of a third "
                "run whose per-camera file was overwritten and no longer exists.",
                "outputs/metrics/auc_summary.tsv (0.7383): derived from the variant "
                "per-camera file above.",
                "outputs/PAF_3d_kalman/ variants (PAF L1 0.738089, L1+tracklet-vote, "
                "liezl_cross_view, ...): real improvements, but VARIANTS. Supplementary "
                "material at most, and never labelled LUC3D.",
            ]),
        note=("Aggregated from existing luc3d-bench runs. Unit of replication is the "
              "SESSION: per-camera rows are averaged to one value per session before any "
              "statistic."),
        metric=("IDF1 (motmetrics). within = each camera scored separately with its own "
                "optimal identity relabelling; cross = all cameras pooled into one "
                "accumulator with one global identity per animal."),
        slap2m=sl,
        bmimica_50_sessions={k: v for k, v in bm.items() if not k.startswith("_")},
        bmimica_wins=bm.get("_luc3d_wins_vs", {}),
        hard_session_slap2m=hard,
        caveats=[
            "SHIPPED-BASELINE NUMBERS. See provenance above: outputs/metrics/'s "
            "\"luc3d\" columns are a post-processed variant and are NOT used anywhere.",
            "LUC3D LOSES to SLEAP on WITHIN-VIEW IDF1 at 3 animals and at 4 animals. "
            "The cells are n = 4 and n = 3 SESSIONS (24 and 18 camera-sessions), SLEAP "
            "wins every one of those 7 sessions individually, and they are confounded: "
            "all three 4-animal sessions are black bedding at difficulty 4. The paper's "
            "claim is cross-view identity consistency, not per-camera superiority.",
            "Within-view IDF1 is dominated by the SHARED DETECTOR, not by association: "
            "r(session IDF1, detector recall) = 0.975, R2 = 0.95 over 74 sessions, and "
            ">99% of every tracker's error mass is detector false negatives. Read panels "
            "on within-view IDF1 accordingly -- including the 3-4 animal loss.",
            "Corpus means are dragged by a heavy tail: LUC3D within-view IDF1 mean 0.736 "
            "vs median 0.900. Report both.",
            "Cross-view IDF1 is bounded near 1/C for any tracker with no cross-view "
            "association mechanism (0.20 at C=5, 0.167 at C=6). At C=5 the per-camera "
            "trackers land far BELOW that bound (0.062 and 0.046), so the bound is a "
            "ceiling on what they could achieve, not a level they reach.",
            "3D-MuPPET is flat from within- to cross-view but at IDF1 0.011: flatness "
            "alone is not the claim, height and flatness must be read together.",
            "LUC3D fragments MORE than SLEAP (+24.0 fragmentations per camera per "
            "session, 95% CI [+18.3, +30.0]). Stated, not hidden.",
            "All on-pool trackers receive identical per-frame detections (identity "
            "stripped), so the comparison isolates association, not detector quality.",
            "The hard-session file is n = 1 session and includes UDMT, which is "
            "OFF-POOL (its own detector). Recorded here, plotted nowhere.",
            "3D-MuPPET's dmin was retuned 200 -> 100 mm for mouse scale and its detector "
            "replaced by the shared pool; that is the published method's tracking logic, "
            "not the shipped system.",
        ])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=1)

    if sl:
        print(f"SLAP-2M within-view, n = {sl['n_sessions']} sessions "
              f"({sl['n_camera_sessions']} camera-sessions) [SHIPPED baseline]")
        for t, v in sorted(sl["within_view"].items(),
                           key=lambda kv: -kv[1]["median"]):
            print(f"  {t:<10} mean {v['mean']:.4f}  median {v['median']:.4f}  "
                  f"IQR {v['q25']:.3f}-{v['q75']:.3f}")
        print("\n  paired LUC3D - SLEAP by animal count:")
        for k, v in sl["paired_vs_sleap"].items():
            print(f"    {k:<4} n={v['n_sessions']:<3} {v['mean']:+.4f} "
                  f"[{v['ci95_lo']:+.4f},{v['ci95_hi']:+.4f}]  "
                  f"wins {v['wins']}/{v['n_sessions']}  sign p={v['sign_p']:.3g}")
        e = sl["error_decomposition"]
        print("\n  error decomposition (shared GT "
              f"{e['luc3d']['gt_instances']:,} instances):")
        for t, v in e.items():
            print(f"    {t:<10} FP {v['false_positives']:>7,}  FN "
                  f"{v['false_negatives']:>9,}  IDsw {v['id_switches']:>6,}  "
                  f"FN share {v['fn_share']:.4f}")
        rc = sl["detector_recall_corr"]
        print(f"\n  r(LUC3D IDF1, detector recall) = {rc['luc3d']['r']:.4f}  "
              f"R2 = {rc['luc3d']['r2']:.4f}  n = {rc['luc3d']['n_sessions']}")
        print("  bedding IDF1 (black -> white), detector recall in brackets:")
        bb = sl["by_bedding"]
        for t in ("luc3d", "sleap", "bytetrack"):
            b, w = bb["black"][t]["idf1"], bb["white"][t]["idf1"]
            print(f"    {t:<10} {b:.4f} -> {w:.4f}  Δ{abs(b - w):.4f}")
        print(f"    detector   {bb['black']['detector_recall']:.4f} -> "
              f"{bb['white']['detector_recall']:.4f}  "
              f"Δ{abs(bb['black']['detector_recall'] - bb['white']['detector_recall']):.4f}")
    if bm:
        print(f"\nBMimica cross-view, n = {bm['_n_sessions']} sessions:")
        for _k, name in BM_TRACKERS:
            b = bm[name]
            w, c = b["within"], b["cross"]
            print(f"  {name:<20} within {w['mean']:.4f} cross {c['mean']:.4f} "
                  f"ratio {b['cross_over_within']['mean']:.3f} "
                  f"[{b['cross_over_within']['ci95_lo']:.3f},"
                  f"{b['cross_over_within']['ci95_hi']:.3f}]  "
                  f"max drift {b['drift_abs_max']:.4f}")
        for name, w in bm["_luc3d_wins_vs"].items():
            print(f"  LUC3D beats {name:<18} within {w['within']['wins']}/"
                  f"{w['within']['n']}  cross {w['cross']['wins']}/{w['cross']['n']} "
                  f"(sign p = {w['cross']['sign_p']:.2g})")
    print(f"\n[json] {OUT}")


if __name__ == "__main__":
    main()
