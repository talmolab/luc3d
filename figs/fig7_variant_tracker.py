#!/usr/bin/env python
"""Build a Fig 7 deposit VARIANT carrying Fig 8's improved tracker as an extra series.

    THIS DOES NOT TOUCH `figs/out/fig3_trackers.json`. That deposit is the manuscript's
    record of what the SHIPPED tracker does, and it must stay that. This writes a NEW
    file, `figs/out/fig7_variant_stale10.json`, with one extra tracker key added.

WHY A VARIANT AND NOT A REGENERATION. Figures 3 and 7 are manuscript figures describing
`pose/cross-view-tracker.js` as it ships. Fig 8's best configuration -- `sync` +
`stale: 10` + `distanceThreshold 25` -- exists ONLY in `figs/fig8-bench/xv_experimental.js`,
served over the real module by a loader hook. Regenerating a manuscript figure with it
would make the manuscript describe a tracker the app does not contain. So the improved
tracker is added ALONGSIDE the shipped one, labelled, and the shipped series stays exactly
as measured.

WHAT CAN AND CANNOT BE REDONE THIS WAY, because the answer is lopsided and matters:

  Fig 7a (within vs cross)  BMimica, 50 sessions -> CAN be redone. `bmimica_50_sessions`
                            needs per-tracker `within`/`cross` distribution stats, and
                            `fig8_methods_50.json` carries exactly the four per-session
                            quantities the source CSV holds (within/cross IDF1 and
                            switches) for all 50 sessions.
  Fig 7b-7g                 SLAP-2M, 74 sessions -> NOW CAN, via `--slap2m`. This entry
                            used to read "CANNOT: the improved tracker has never been run
                            on SLAP-2M". It has been now (`figs/fig9_slap2m.py --pool
                            predictions`), and re-scored to per-(session, camera)
                            granularity by `figs/fig7_slap2m_rescore.py`. See
                            `--slap2m` below. The regime caveat still holds and is still
                            deposited: SLAP-2M's detector misses 35.4% of GT and the
                            ceiling for any identity fix there is 0.7704 against
                            BMimica's 0.9367, so nothing licenses reading one corpus's
                            effect size off the other's.

`--slap2m` CORRECTS A STALE TRACKER IN THE MANUSCRIPT'S OWN SLAP-2M ARM, and that half is
a CORRECTION rather than a variant -- the same footing as `--fix-sleap`, and pointed at US
rather than at a competitor.

`fig3_trackers.json`'s SLAP-2M LUC3D arm was produced by `matchFrameInstances`: the
pre-#131, pre-module-refactor PER-FRAME matcher, driven by
`luc3d-bench/scripts/luc3d_track_all.mjs` against a FLAT LUCID snapshot on 2026-05-15.
`pose/cross-view-tracker.js` (`runCrossViewTracker`) landed 2026-07-06 -- seven weeks
later. So every number on Fig 7 b-g describes a tracker that has not been the shipped
tracker since. That is measured, not inferred: re-running the reference driver over the
same pool reproduced the stored outputs assignment-for-assignment (0 of 9,042 frames
differ), and re-scoring those outputs with an independent scorer reproduces
`_eval_baseline.csv` to all sixteen digits (0.7360353065988466, max per-session diff
0.000e+00 over 74 sessions). The 0.0160 discrepancy decomposes additively and completely:
+0.013563 tracker generation (84.8%) and +0.002425 tail-node exclusion (15.2%).
Full account: `figs/out/ITEM3-SLAP2M-GATE.md`.

BMimica's LUC3D arm, by contrast, DOES come from `runCrossViewTracker`
(`scripts/bench/bench_crossview.mjs`, written 2026-07-21) -- which is why Fig 7a's gate
passes to 16 digits while b-g's could not. Fig 7 as shipped therefore labels two different
trackers "LUC3D": post-#131 on a, pre-#131 on b-g.

THREE ARMS GO IN THE FILE, and they must stay separable, because two unrelated things move
at once and a reader has to be able to tell which is which:

  slap2m                      the SHIPPED tracker (`runCrossViewTracker`, method {}). This
                              is the CORRECTION: it supersedes the pre-#131 numbers rather
                              than contradicting them. It occupies the key the panels read,
                              so the figure describes the app.
  slap2m_pre131_reference     `fig3_trackers.json`'s own block, verbatim, so what the
                              manuscript currently prints stays in the file and stays
                              traceable -- the same rule `--fix-sleap` follows.
  slap2m_fresh_anchor         the EXPERIMENTAL arm (`figs/fig8-bench/xv_experimental.js`,
                              {sync, stale 20} + distanceThreshold 25). NOT in the app.

WHAT IS RE-SCORED AND WHAT IS NOT. `figs/fig7_slap2m_rescore.py` calls luc3d-bench's own
`evaluate.eval_camera(..., no_sleap=True)` over the saved per-session tracker outputs and
emits a drop-in replacement for the `luc3d` rows of `outputs/PAF_3d_kalman/_eval_baseline.csv`.
The `sleap` and `bytetrack` rows are copied through BYTE FOR BYTE: neither uses LUCID's
tracker, so neither can move, and changing exactly one column is what keeps every paired
statistic in this file a like-for-like comparison. `evaluate.main()` is never called -- it
would overwrite `outputs/metrics/by_difficulty.csv`, a historical artefact
`fig3_trackers.py`'s provenance note reasons about.

TWO GATES, both refused-on-failure. (1) HARNESS EQUIVALENCE, from the re-scoring pass:
re-scoring the REFERENCE's own outputs through that script must reproduce
`_eval_baseline.csv`'s `luc3d` rows bit-identically on all 444 rows x 22 metric columns, so
a re-scored arm differs because the TRACKER differs and for no other reason. The BMimica-style
gate ("the shipped tracker reproduces the deposit") CANNOT pass here and must not be
loosened until it does: the two arms are different algorithms. (2) AGGREGATION EQUIVALENCE,
checked here: `fig3_trackers.slap2m()` re-run on the UNMODIFIED CSV must reproduce this
deposit's `slap2m` block exactly, every leaf, so the substituted blocks are computed by the
same code path that produced the manuscript's.

AND THE RESULT IS MIXED, WHICH IS THE WHOLE REASON THE ARMS STAY SEPARATE. The shipped
tracker's +0.0160 corpus gain is ENTIRELY the 35 two-animal sessions. On >= 3 animals the
pre-#131 tracker is BETTER and the shipped tracker's switch count blows up (3 animals:
0.3728 -> 0.3512, 205 -> 744 switches, n = 4 sessions; 4 animals: 0.3292 -> 0.2774,
299 -> 606, n = 3 sessions). The fresh anchor removes most of that blow-up (744 -> 54,
606 -> 145) without fully recovering the IDF1 (3 animals 0.3604 vs the old 0.3728). Those
n are 4 and 3 SESSIONS, so it is weak evidence -- but it is reproducible, and it is
deposited in `slap2m_arm_comparison` so no panel has to take it on trust.

The statistics are computed the same way `fig3_trackers.py` computes them, so the new
series is comparable to the existing ones rather than merely adjacent to them: the unit of
replication is the SESSION, per-camera rows are already averaged to one value per session
upstream, and the 95% CI is the normal-approximation +/- 1.96 * sd / sqrt(n) that deposit
uses.

`--fix-sleap` REPLACES THE SLEAP SERIES TOO, and that half is a CORRECTION, not a variant.
Fig 7a's BMimica SLEAP numbers (within 0.1154, cross 0.0616) come from
`outputs/bmimica/sleap_h5/`, which `scripts/bartul/bmimica_build_sleap_ref.py` builds from
the retracked `.slp` files using sleap-nn's own track id -- and TRUNCATES IT TO TWO TRACKS:

    sleap = np.full((F, N_ANIMALS, N_NODES, 2), np.nan)   # N_ANIMALS = 2
    ...
        if ti is not None and ti < N_ANIMALS:              # track >= 2 SILENTLY DROPPED

The retracked files hold a median of 47 tracks per camera-session. Counted directly on two
of them, the fraction of tracked instances that survive `ti < 2` is 84.5 / 11.7 / 0.0 /
24.9 / 11.1% on session 20250829_124351's five cameras and 1.1 / 2.8 / 6.1 / 1.1 / 7.1% on
20250907_174343's, against 17-188 tracks per file. So the series is a top-2-track fragment
of SLEAP's output scored as though it were all of it.

NOT the defect an earlier version of this file described. The first diagnosis was that the
series came from a detections-only pool's unstable SLOT INDEX, evidenced by a p95 498 px
frame-to-frame jump. That measurement is real but was taken on the DETECTION pool, which is
not what this series was scored from; the retracked tracks it IS scored from are coherent
(p95 4.8 px, measured). Right conclusion -- the series is invalid and understates SLEAP --
attributed to the wrong cause, which is why the corrected numbers below land at 0.21 rather
than at the 0.66 the first diagnosis predicted.

`figs/fig7_sleap_retracked.py` scores the 250 `.slp` files DIRECTLY, every track, so the
truncation is structurally absent rather than repaired: there is no intermediate fixed-width
array to overflow. This flag installs that result over the invalid one. Two rules it
follows, because a correction that erases what it corrects cannot be audited:

  * the OLD series is KEPT, under `SLEAP per-camera (2-track truncation, invalid)`, with its
    win counts, so the number the manuscript currently prints is still in the file and still
    traceable to the artefact that produced it;
  * the measuring script's coherence gate is re-checked HERE at install time. It is NOT what
    diagnoses this defect -- the tracks are coherent and always were -- but it is what
    establishes that the `.slp` track id is a usable identity at all, so a series measured
    from tracks that turned out to be incoherent is refused rather than plotted.

CROSS-VIEW CONVENTION, AND WHY THIS READS THE SCOPED DEPOSIT AND REFUSES THE OTHER ONE.
`figs/fig7_sleap_retracked.py` pools the five cameras with the track NAME as the hypothesis
id, UNSCOPED: `track_3` in camera A and `track_3` in camera B count as one identity.
luc3d-bench's `scripts/bartul/bmimica_eval_crossview_all.py`, which produced every number in
`fig3_trackers.json`, CAMERA-SCOPES its per-camera baselines instead (`ci * 10 + slot` for
SLEAP, `ci * 100000 + tid` for ByteTrack) and uses global ids only for LUC3D and 3D-MuPPET,
which actually have cross-view identity. Unscoped pooling can only ADD cross-view matches
that scoped pooling refuses, never remove one, so the unscoped number is an UPPER BOUND and
installing it would publish a cross-view "correction" of which part is a convention change
-- a correction that flatters us, which is worse than the defect being fixed. So
`--fix-sleap` reads `fig7_sleap_scoped.json` (`figs/fig7_sleap_scoped.py`, which measures
BOTH conventions in one pass and gates on reproducing the first pass's numbers exactly), puts
the CAMERA-SCOPED value in `cross`, and keeps the unscoped one beside it under
`cross_unscoped` / `per_session_cross_unscoped`. If that deposit is missing it REFUSES rather
than falling back. `within` is convention-free either way -- per-camera accumulators, per-
camera ids, no pooling -- so 0.1154 -> 0.2062 stands as measured.

`--muppet-coverage` FLAGS THE SECOND INVALID SERIES, and it does not repair it. 3D-MuPPET's
0.0112 / 0.0112 is a coverage number: `scripts/bartul/muppet_run.py` maps SORT track ids to
global ids ONCE at the init frame while SORT runs `max_age = 10`, so the first time a
tracklet dies its successor id is in no map and that camera falls silent for good. Measured
over all 50 result JSONs: coverage 0.17-7.22% of a session, median 1.31%, and the emitted
frames are a CONTIGUOUS PREFIX from frame 0 in all 50 -- it dies rather than thins. Every
unlabelled frame is scored as a miss, so 0.0112 is ~98.7% denominator and 1.3% measurement.
On the frames it does label it scores within-view 0.21-0.67 (4 sessions, first 20,000 frames;
`figs/out/ITEM6-BASELINE-AUDIT.md` §3), and its identities are coherent where present (p95
3.4 px). This flag deposits the coverage so the panel can label the series from a measured
value; it does NOT substitute the conditional score, because a coverage-conditional number
and a full-session number cannot share an axis, and the conditional one exists for 4 sessions
rather than 50.

The corrected series' own paired win counts are RECOMPUTED per session against whichever
LUC3D series ends up in the file's `LUC3D` slot, and pairing is by SESSION NAME rather than
by position -- `fig3_trackers.json`'s per-session arrays are in source-CSV order and
`fig8_methods_50.json`'s are in the harness's, so aligning them by index would silently
compare different sessions.

    $PY figs/fig7_variant_tracker.py [--config sync_stale10_dist25] [--fix-sleap]

Then render the variant panel with:

    python3 figs/panels/fig7_05_within_vs_cross.py --variant
"""
import argparse
import csv
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"

#: Label the extra series carries on the artwork. Names the mechanism, not the flag.
VARIANT_LABEL = "LUC3D + fresh anchor"

#: `--fix-sleap`. The deposit written by `figs/fig7_sleap_scoped.py` -- the CAMERA-SCOPED
#: pass -- the key it overwrites, and the key the erroneous series is MOVED to (not deleted;
#: see the docstring). The new name says what was actually measured, so nothing has to be
#: remembered about it. `SLEAP_SRC_UNSCOPED` is the first pass, named here only so the
#: refusal message can name what it is refusing to fall back to.
SLEAP_SRC = "fig7_sleap_scoped.json"
SLEAP_SRC_UNSCOPED = "fig7_sleap_retracked.json"
SLEAP_KEY = "SLEAP per-camera"
SLEAP_OLD_KEY = "SLEAP per-camera (2-track truncation, invalid)"

#: `--muppet-coverage`. 3D-MuPPET's series in `fig3_trackers.json` (0.0112 / 0.0112) is a
#: COVERAGE number, not an identity score: `scripts/bartul/muppet_run.py` builds
#: `global_by_track` once at the init frame while SORT runs `max_age = 10`, so when a
#: tracklet dies its successor id is in no map and that camera goes permanently silent.
#: Measured over all 50 result JSONs: assignments cover 0.17% to 7.22% of a session (median
#: 1.31%), and in every session the emitted frames are a CONTIGUOUS PREFIX from frame 0 --
#: it does not sample sparsely, it dies. Frames with no assignment are scored as misses, so
#: the 0.0112 is ~98.7% denominator. This flag measures that coverage and deposits it, so
#: the panel can label the series from the deposit instead of from a comment.
MUPPET_KEY = "3D-MuPPET"
MUPPET_RESULTS = Path("/root/vast/eric/luc3d-bench/outputs/bmimica/results/muppet")
MUPPET_GT = Path("/root/vast/eric/luc3d-bench/outputs/bmimica/gt")

#: `--slap2m`. Where `figs/fig7_slap2m_rescore.py` leaves its drop-in CSVs and its
#: harness-equivalence verdict, and the keys the three arms occupy in this deposit. The
#: SHIPPED arm takes the `slap2m` key the panels read, because that is the correction; the
#: pre-#131 block is preserved rather than deleted (same rule as `SLEAP_OLD_KEY`), and the
#: experimental arm is a third, separately named block so no panel can draw it as the app.
RESCORE = OUT / "tmp" / "fig7bg_rescore"
SLAP2M_CSV = {"shipped": "_eval_baseline__shipped.csv",
              "fresh": "_eval_baseline__fresh.csv"}
SLAP2M_REF_KEY = "slap2m_pre131_reference"
SLAP2M_FRESH_KEY = "slap2m_fresh_anchor"


def stats(values):
    """Distribution summary in `fig3_trackers.json`'s shape, computed its way."""
    v = sorted(values)
    n = len(v)
    if n == 0:
        return None
    mean = sum(v) / n
    sd = (sum((x - mean) ** 2 for x in v) / (n - 1)) ** 0.5 if n > 1 else 0.0
    half = 1.96 * sd / math.sqrt(n) if n > 1 else 0.0

    def q(p):
        if n == 1:
            return v[0]
        i = p * (n - 1)
        lo, hi = int(math.floor(i)), int(math.ceil(i))
        return v[lo] + (v[hi] - v[lo]) * (i - lo)

    return {"n_sessions": n, "mean": mean, "sd": sd, "median": q(0.5),
            "q25": q(0.25), "q75": q(0.75), "min": v[0], "max": v[-1],
            "ci95_lo": mean - half, "ci95_hi": mean + half}


def sign_p(pos, n):
    """Exact two-sided sign test, `fig3_trackers.py`'s function verbatim, so a recomputed
    win count carries a p-value computed the same way as the ones beside it."""
    if n == 0:
        return 1.0
    k = min(pos, n - pos)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def bmimica_sessions(base):
    """The SESSION NAME for each position in `bmimica_50_sessions`' per-session arrays.

    Those arrays are `csv.DictReader` row order over the deposit's own provenance file,
    `bmimica_crossview_all_eval.csv` (`fig3_trackers.bmimica()` builds them with a plain
    list comprehension over `rows`), and the deposit does not record the names. So they
    are read back from that CSV and the alignment is then PROVEN rather than assumed: the
    CSV's `luc3d_idf1` column must reproduce the deposit's `LUC3D.per_session_within`
    exactly, elementwise. If the CSV has been regenerated in a different order that check
    fails and nothing is written -- which is the point, because a silent misalignment here
    would pair each session's SLEAP score with a different session's LUC3D score.
    """
    p = Path(base["provenance"]["bmimica_cross_view"])
    if not p.exists():
        raise SystemExit(f"--fix-sleap needs the deposit's own provenance CSV to recover "
                         f"session order, and {p} is missing")
    with open(p) as f:
        rows = list(csv.DictReader(f))
    ref = base["bmimica_50_sessions"]["LUC3D"]["per_session_within"]
    if len(rows) != len(ref):
        raise SystemExit(f"{p.name} has {len(rows)} rows, the deposit has {len(ref)} "
                         f"sessions -- refusing to guess the pairing")
    for i, (r, v) in enumerate(zip(rows, ref)):
        if abs(float(r["luc3d_idf1"]) - v) > 0:
            raise SystemExit(f"{p.name} row {i} ({r['session']}) has luc3d_idf1 "
                             f"{r['luc3d_idf1']} but the deposit's array holds {v!r}: the "
                             f"CSV order is no longer the deposit's order, so session "
                             f"names cannot be recovered from it")
    return [r["session"] for r in rows]


def muppet_coverage(out):
    """Measure 3D-MuPPET's frame COVERAGE and deposit it beside its series. See the
    docstring: the series is a coverage artefact, and this is the statistic that says so.

    Coverage = frames carrying at least one camera assignment, over the session's GT frame
    count -- the same denominator the scorer uses, since a frame absent from the JSON is
    scored as a miss rather than skipped. `contiguous_prefix` records whether the emitted
    frame indices are exactly `0..n-1`, which distinguishes "the tracker died early" from
    "the tracker labels sparsely throughout": the first is a coverage collapse, the second
    would be a sampling choice, and they license different statements.
    """
    import h5py
    if not MUPPET_RESULTS.is_dir():
        raise SystemExit(f"--muppet-coverage needs {MUPPET_RESULTS}")
    rows = []
    for p in sorted(MUPPET_RESULTS.glob("*.json")):
        sid = p.stem
        gt_dir = MUPPET_GT / sid
        if not gt_dir.is_dir():
            continue
        d = json.loads(p.read_text())
        fr = d.get("frames")
        idx = sorted(int(k) for k, v in fr.items() if v) if isinstance(fr, dict) \
            else [i for i, v in enumerate(fr) if v]
        cam = sorted(q.name for q in gt_dir.iterdir() if q.is_dir())[0]
        with h5py.File(gt_dir / cam / "proofread.analysis.h5") as f:
            t = f["tracks"]
            n_frames = int(t.shape[-1] if t.ndim == 4 else t.shape[0])
        rows.append({"session": sid, "frames_emitted": len(idx),
                     "session_frames": n_frames,
                     "coverage": (len(idx) / n_frames) if n_frames else None,
                     "max_frame_index": (max(idx) if idx else -1),
                     "contiguous_prefix": bool(idx) and max(idx) == len(idx) - 1,
                     "init_frame": d.get("init_frame")})
    if not rows:
        raise SystemExit("--muppet-coverage found no scorable MuPPET sessions")
    cov = sorted(r["coverage"] for r in rows if r["coverage"] is not None)
    ent = out["bmimica_50_sessions"].get(MUPPET_KEY)
    if ent is None:
        raise SystemExit(f"[fig7v] no `{MUPPET_KEY}` series to annotate")
    ent["coverage"] = {
        "definition": "frames with at least one camera assignment in "
                      "outputs/bmimica/results/muppet/<session>.json, over the session's GT "
                      "frame count. Frames absent from the JSON are scored as MISSES by "
                      "bmimica_eval_crossview_all.py, not skipped, so this is the fraction "
                      "of the scored denominator the series actually measures.",
        "n_sessions": len(rows), "median": cov[len(cov) // 2],
        "mean": sum(cov) / len(cov), "min": cov[0], "max": cov[-1],
        "contiguous_prefix_sessions": sum(1 for r in rows if r["contiguous_prefix"]),
        "per_session": rows}
    ent["invalid_reason"] = (
        f"COVERAGE ARTEFACT, not an identity score. scripts/bartul/muppet_run.py builds "
        f"`global_by_track` once at the init frame while SORT runs `max_age = 10`, so a "
        f"tracklet's successor id is in no map and its camera goes permanently silent. "
        f"Assignments cover a median {cov[len(cov) // 2]:.2%} of a session (range "
        f"{cov[0]:.2%}-{cov[-1]:.2%}), a contiguous prefix from frame 0 in "
        f"{sum(1 for r in rows if r['contiguous_prefix'])}/{len(rows)} sessions. On the "
        f"frames it does label, within-view IDF1 is 0.21-0.67 (4 sessions, first 20,000 "
        f"frames; figs/out/ITEM6-BASELINE-AUDIT.md section 3) and identity is coherent "
        f"where present (p95 3.4 px). The plotted {ent['within']['mean']:.4f} is therefore "
        f"~{1 - cov[len(cov) // 2]:.1%} denominator. The flatness from within to cross view "
        f"is meaningless at this coverage and must not be offered as evidence of cross-view "
        f"consistency.")
    out.setdefault("caveats", []).append(
        f"`{MUPPET_KEY}`'s {ent['within']['mean']:.4f} / {ent['cross']['mean']:.4f} is NOT "
        f"an identity measurement -- see its `invalid_reason` and `coverage`. It is kept on "
        f"the panel because dropping a competitor silently is worse than labelling it, and "
        f"it is drawn so a reader can see it is not comparable. No conditional score is "
        f"substituted: that quantity has a different denominator and exists for 4 sessions, "
        f"not 50.")
    print(f"[fig7v] {MUPPET_KEY} coverage over {len(rows)} sessions: median "
          f"{cov[len(cov) // 2]:.2%}, range {cov[0]:.2%}-{cov[-1]:.2%}; contiguous prefix "
          f"in {sum(1 for r in rows if r['contiguous_prefix'])}/{len(rows)}")


def _slap2m_block(csv_path):
    """`fig3_trackers.slap2m()` computed over a DIFFERENT per-camera-session CSV.

    The aggregation is that function verbatim -- imported, its module-level `SLAP2M`
    constant temporarily repointed -- rather than reimplemented here. Reimplementing it
    would put the substituted arm on a different aggregation convention from the numbers
    it is compared against (session-first means, camera-session weighting in `by_animals`,
    the seeded bootstrap, the sorted `per_session` arrays), which is exactly the kind of
    silent mismatch this whole file exists to avoid. `main()` is never called: it writes
    `figs/out/fig3_trackers.json`, a manuscript deposit.
    """
    import fig3_trackers as f3
    old = f3.SLAP2M
    try:
        f3.SLAP2M = str(csv_path)
        return f3.slap2m()
    finally:
        f3.SLAP2M = old


def _deep_diff(a, b, path="", out=None):
    """Every leaf where two nested structures differ, EXACTLY (no tolerance).

    Used as the aggregation gate: a tolerance here would let a genuine change of
    convention pass as rounding.
    """
    out = [] if out is None else out
    if type(a) is not type(b) and not (isinstance(a, (int, float))
                                       and isinstance(b, (int, float))):
        out.append(f"{path}: type {type(a).__name__} vs {type(b).__name__}")
        return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append(f"{path}.{k}: present in only one")
            else:
                _deep_diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} vs {len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                _deep_diff(x, y, f"{path}[{i}]", out)
    elif a != b:
        out.append(f"{path}: {a!r} vs {b!r}")
    return out


def _arm_by_animals(csv_path):
    """Within-view IDF1 (session-first mean) and RAW switch sums per animal count, for one
    arm, straight from its per-camera-session CSV.

    This is the table the >= 3-animal regression lives in, and it is deposited so a panel
    does not have to recompute it -- or, worse, quote it from a report. `switches` is a raw
    sum over camera-sessions, so it may only ever be compared within the same denominator
    (74 sessions, 6 cameras); `idf1` averages the six cameras to one value per session
    first, which is this figure's unit of replication throughout.
    """
    import collections
    rows = [r for r in csv.DictReader(open(csv_path)) if r["tracker"] == "luc3d"]
    per = collections.defaultdict(list)
    animals, sw = {}, collections.Counter()
    for r in rows:
        per[r["session"]].append(float(r["idf1"]))
        animals[r["session"]] = int(r["animals"])
        sw[int(r["animals"])] += int(float(r["num_switches"]))
    idf1 = {s: sum(v) / len(v) for s, v in per.items()}
    out = {}
    for a in sorted(set(animals.values())):
        ss = [s for s in sorted(idf1) if animals[s] == a]
        out[str(a)] = {"n_sessions": len(ss),
                       "within_idf1": sum(idf1[s] for s in ss) / len(ss),
                       "within_switches": int(sw[a])}
    ss = sorted(idf1)
    out["all"] = {"n_sessions": len(ss),
                  "within_idf1": sum(idf1[s] for s in ss) / len(ss),
                  "within_switches": int(sum(sw.values()))}
    return out


def install_slap2m(out, base):
    """Install the SHIPPED tracker as the `slap2m` arm, preserve the pre-#131 one, and add
    the experimental fresh-anchor arm beside them. See the module docstring for why, for
    what re-scoring was done, and for the two gates applied here.
    """
    gate_p = RESCORE / "gate.json"
    if not gate_p.exists():
        raise SystemExit(
            f"--slap2m needs the harness-equivalence verdict at {gate_p}; run\n"
            f"  /root/vast/eric/luc3d-bench/liezl_env/bin/python "
            f"figs/fig7_slap2m_rescore.py --gate --adopt-shipped --arms fresh")
    g = json.loads(gate_p.read_text())
    if not g.get("passed") or g.get("max_abs_diff") != 0.0:
        raise SystemExit(f"[fig7v] REFUSING the SLAP-2M substitution: the re-scoring "
                         f"harness does not reproduce _eval_baseline.csv's luc3d rows "
                         f"exactly ({g.get('max_abs_diff')!r} over {g.get('n_rows')!r} "
                         f"rows). Do not loosen this -- find the difference first.")
    paths = {}
    for arm, name in SLAP2M_CSV.items():
        p = RESCORE / name
        if not p.exists():
            raise SystemExit(f"--slap2m needs {p} (arm `{arm}`)")
        paths[arm] = p

    # GATE 2, AGGREGATION EQUIVALENCE. `slap2m()` re-run on the UNMODIFIED CSV must
    # reproduce this deposit's own block, every leaf, exactly. That is what proves the
    # substituted blocks below are computed by the same code path as the manuscript's --
    # including the seeded bootstrap, whose CIs would otherwise be the first thing to
    # drift silently.
    import fig3_trackers as f3
    # Compared THROUGH a JSON round-trip, because that is the only difference the
    # deposit introduces: `slap2m()` returns `defaultdict`s and `json.load` gives plain
    # dicts, so a raw comparison reports a type mismatch on `by_animals` before it looks
    # at a single number. The round-trip changes no VALUE -- floats are written with
    # `repr` precision by `json.dump` and read back identically -- so exact equality is
    # still what is demanded of every leaf.
    repro = json.loads(json.dumps(_slap2m_block(f3.SLAP2M)))
    diffs = _deep_diff(repro, base["slap2m"], "slap2m")
    if diffs:
        raise SystemExit("[fig7v] REFUSING the SLAP-2M substitution: re-running "
                         "fig3_trackers.slap2m() on the UNMODIFIED CSV does not reproduce "
                         "this deposit's slap2m block, so a substituted block would not be "
                         f"comparable to it. First differences: {diffs[:5]}")
    print(f"[fig7v] aggregation gate: fig3_trackers.slap2m() reproduces the deposit's "
          f"slap2m block exactly (0 differing leaves)")

    blocks = {arm: _slap2m_block(p) for arm, p in paths.items()}
    ref = json.loads(json.dumps(base["slap2m"]))
    out[SLAP2M_REF_KEY] = ref
    out["slap2m"] = blocks["shipped"]
    out[SLAP2M_FRESH_KEY] = blocks["fresh"]

    # The per-animal-count table both movements have to be read through. Reference arm
    # from the manuscript CSV itself, so it is not a re-derivation of a re-derivation.
    out["slap2m_arm_comparison"] = {
        "note": ("Within-view IDF1 is the session-first mean (six cameras averaged to one "
                 "value per session, then over sessions); `within_switches` is a RAW SUM "
                 "over camera-sessions and may only be compared within this same "
                 "denominator (74 sessions x 6 cameras). n = 4 and n = 3 SESSIONS at 3 and "
                 "4 animals: weak evidence, reproducible, and not to be presented as "
                 "established."),
        "pre131_reference": _arm_by_animals(f3.SLAP2M),
        "shipped": _arm_by_animals(paths["shipped"]),
        "fresh_anchor": _arm_by_animals(paths["fresh"]),
    }
    out["slap2m_luc3d_is_substituted"] = (
        "The `slap2m` block in this file is the SHIPPED tracker "
        "(pose/cross-view-tracker.js runCrossViewTracker, method {}), re-scored per "
        "(session, camera) by figs/fig7_slap2m_rescore.py through luc3d-bench's own "
        "evaluate.eval_camera(no_sleap=True). fig3_trackers.json's block -- produced by the "
        "pre-#131 per-frame matcher `matchFrameInstances` on 2026-05-15, seven weeks before "
        "runCrossViewTracker was merged -- is preserved verbatim under "
        f"`{SLAP2M_REF_KEY}`. The EXPERIMENTAL fresh-anchor arm "
        f"({{sync, stale 20}} + distanceThreshold 25, figs/fig8-bench/xv_experimental.js, "
        f"NOT in the app) is under `{SLAP2M_FRESH_KEY}`. Only the LUC3D rows differ between "
        "the three: the sleap and bytetrack rows are copied byte for byte from "
        "_eval_baseline.csv.")

    a_ref = out["slap2m_arm_comparison"]["pre131_reference"]
    a_shp = out["slap2m_arm_comparison"]["shipped"]
    a_frs = out["slap2m_arm_comparison"]["fresh_anchor"]
    out.setdefault("caveats", []).extend([
        f"CORRECTION, not a variant: `slap2m` no longer holds the pre-#131 tracker's "
        f"numbers. Fig 7 b-g as shipped plots `matchFrameInstances`, the pre-module-refactor "
        f"PER-FRAME matcher, driven by luc3d-bench/scripts/luc3d_track_all.mjs against a "
        f"flat LUCID snapshot (run 2026-05-15, evaluated 2026-05-19). "
        f"pose/cross-view-tracker.js's runCrossViewTracker was merged 2026-07-06. Within-view "
        f"IDF1 {a_ref['all']['within_idf1']:.16f} -> {a_shp['all']['within_idf1']:.16f}; "
        f"within-view switches {a_ref['all']['within_switches']:,} -> "
        f"{a_shp['all']['within_switches']:,}. The old block is preserved under "
        f"`{SLAP2M_REF_KEY}`. Full account: figs/out/ITEM3-SLAP2M-GATE.md.",
        f"THE +{a_shp['all']['within_idf1'] - a_ref['all']['within_idf1']:.4f} CORPUS GAIN IS "
        f"ENTIRELY THE 2-ANIMAL SESSIONS, and on >= 3 animals the OLD tracker is better. "
        f"3 animals (n = {a_ref['3']['n_sessions']}): "
        f"{a_ref['3']['within_idf1']:.4f} -> {a_shp['3']['within_idf1']:.4f} with switches "
        f"{a_ref['3']['within_switches']:,} -> {a_shp['3']['within_switches']:,}. "
        f"4 animals (n = {a_ref['4']['n_sessions']}): "
        f"{a_ref['4']['within_idf1']:.4f} -> {a_shp['4']['within_idf1']:.4f}, switches "
        f"{a_ref['4']['within_switches']:,} -> {a_shp['4']['within_switches']:,}. The fresh "
        f"anchor removes most of the switch blow-up ({a_frs['3']['within_switches']:,} and "
        f"{a_frs['4']['within_switches']:,}) without fully recovering the IDF1 "
        f"({a_frs['3']['within_idf1']:.4f} against the old {a_ref['3']['within_idf1']:.4f}). "
        f"n = 4 and n = 3 sessions: weak, reproducible, and never to be averaged away.",
        f"`{SLAP2M_FRESH_KEY}` is figs/fig8-bench/xv_experimental.js with method "
        f"{{sync, stale 20}} and distanceThreshold 25, served over pose/cross-view-tracker.js "
        f"by an ESM loader hook. It is NOT in the app. It is deposited as a separate block, "
        f"never merged into `slap2m`.",
        "SLAP-2M HAS TWO DETECTION POOLS AND THEY ARE NOT INTERCHANGEABLE. Every SLAP-2M "
        "number in this file is the `predictions_h5s` pool (via PAF_3d_kalman/"
        "_eval_baseline.csv), where within-view IDF1 is 0.736-0.752; the same 74 sessions "
        "score 0.899 on `keeptrack_h5s`. Pool-dependent findings must say so: on this pool "
        "the fresh anchor cuts mislabelled detections 59% on the 42 multi-animal sessions, "
        "and on keeptrack the same arm is flat-to-marginally-worse (+1.3% relative) while "
        "switches still fall 30%.",
        "The 0.7704 identity-fix ceiling quoted for this pool is a property of the "
        "DETECTIONS, not of the tracker, so it survives the substitution unchanged -- "
        "including its 'other pool' label wherever it is drawn.",
        f"HARNESS EQUIVALENCE, measured: re-scoring the REFERENCE arm's own per-frame "
        f"outputs through figs/fig7_slap2m_rescore.py reproduces _eval_baseline.csv's luc3d "
        f"rows bit-identically ({g['n_rows']} rows x {g['n_metric_cols']} metric columns, "
        f"max abs difference {g['max_abs_diff']}). So the substituted arms differ from the "
        f"reference because the TRACKER differs and for no other reason. The BMimica-style "
        f"gate (the shipped tracker reproducing the deposit) cannot pass here and was NOT "
        f"loosened: the two arms are different algorithms.",
        "AGGREGATION EQUIVALENCE, checked at build time: fig3_trackers.slap2m() re-run on "
        "the unmodified CSV reproduces this deposit's own slap2m block on every leaf, so the "
        "substituted blocks come from the same code path -- including the seeded bootstrap "
        "CIs.",
        "NOTE THE FIGURE MIXES TWO LUC3D DEFINITIONS BY DESIGN, and the artwork says so: on "
        "panel a the LUC3D slot is the EXPERIMENTAL fresh anchor (BMimica, drawn in amber "
        "and labelled), while on b-g the LUC3D series is the SHIPPED tracker (SLAP-2M) with "
        "the fresh anchor drawn beside it as a separate, dashed, labelled arm. Both choices "
        "were made on instruction; neither may be inferred from the other.",
    ])
    print(f"[fig7v] SLAP-2M substitution installed:")
    print(f"        within-view IDF1  pre-#131 {a_ref['all']['within_idf1']:.16f}"
          f"  ->  shipped {a_shp['all']['within_idf1']:.16f}"
          f"  ->  fresh {a_frs['all']['within_idf1']:.16f}")
    print(f"        within switches   {a_ref['all']['within_switches']:,}  ->  "
          f"{a_shp['all']['within_switches']:,}  ->  {a_frs['all']['within_switches']:,}")
    for a in ("1", "2", "3", "4"):
        print(f"        {a} animal(s), n = {a_ref[a]['n_sessions']:>2}: "
              f"{a_ref[a]['within_idf1']:.4f} -> {a_shp[a]['within_idf1']:.4f} -> "
              f"{a_frs[a]['within_idf1']:.4f}   switches "
              f"{a_ref[a]['within_switches']:>5,} -> {a_shp[a]['within_switches']:>5,} -> "
              f"{a_frs[a]['within_switches']:>5,}")


def fix_sleap(out, base, luc_by_session):
    """Install the ALL-TRACKS SLEAP baseline over the 2-track-truncated one. See the
    docstring, including why its `cross` value is an upper bound on the deposit's
    camera-scoped convention while its `within` value is convention-free.

    `luc_by_session` is {session: (within, cross)} for whatever series occupies the file's
    `LUC3D` slot, used only for the paired win counts -- so in `--replace` mode the counts
    are against the fresh-anchor arm that the panel actually draws, not against a shipped
    series the panel no longer shows.
    """
    # THE SCOPED DEPOSIT OR NOTHING. `fig7_sleap_retracked.json` carries the same
    # within-view numbers but pools the cameras UNSCOPED, which is not the convention any
    # other number in this file was measured under (see the docstring). Installing it would
    # publish a cross-view "correction" of which part is a convention change, so this
    # refuses rather than falls back: an unavailable measurement is a reason to stop, not a
    # reason to use the incomparable one that is available.
    src = OUT / SLEAP_SRC
    if not src.exists():
        raise SystemExit(
            f"--fix-sleap needs {src} (the CAMERA-SCOPED pass); run\n"
            f"  /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig7_sleap_scoped.py\n"
            f"REFUSING to fall back to {SLEAP_SRC_UNSCOPED}: its cross-view number pools "
            f"the cameras unscoped and is not comparable to this deposit's other series.")
    d = json.loads(src.read_text())
    per = d["per_session"]
    coh = d["coherence_check"]
    tev = d["truncation_evidence"]
    # The scoped deposit names its inputs in `claim`/`why` rather than a
    # `source` field, so this degrades to a description instead of raising:
    # the provenance that matters (`measured_by`) is always present.
    source = d.get("source", "luc3d-bench/outputs/bmimica/retracked/ "
                             "(250 tracked .slp; see `measured_by`)")

    # THE REPRODUCTION GATE, re-checked here rather than trusted from the measuring run's
    # log. The scoped pass must reproduce the earlier pass's within-view and unscoped
    # cross-view numbers exactly; that is what proves it differs in the pooling id and in
    # nothing else, which is what makes its scoped cross-view number comparable to the
    # within-view number it is plotted beside.
    g = d.get("gate", {})
    if not g.get("passed") or g.get("max_abs_diff_within_idf1", 1) > g.get("tolerance", 0) \
            or g.get("max_abs_diff_within_switches", 1) != 0:
        raise SystemExit(f"[fig7v] REFUSING the SLEAP correction: the scoped pass's "
                         f"reproduction gate did not pass ({g})")
    # THE COHERENCE GATE. It does NOT diagnose the defect being corrected -- the truncation
    # does, and the tracks are coherent -- but it is what establishes that the `.slp` track
    # id is a usable identity in the first place, so a series measured from tracks that
    # turned out to be incoherent is refused rather than plotted.
    if not (coh["mean_track_jump_p95_px"] < 200):
        raise SystemExit(f"[fig7v] REFUSING the SLEAP correction: coherence gate FAILED "
                         f"(mean track jump p95 {coh['mean_track_jump_p95_px']:.1f} px)")
    old = out["bmimica_50_sessions"][SLEAP_KEY]
    if len(per) != old["within"]["n_sessions"]:
        raise SystemExit(f"[fig7v] the corrected SLEAP deposit covers {len(per)} sessions "
                         f"and the series it replaces covers "
                         f"{old['within']['n_sessions']} -- refusing to swap a subset in "
                         f"as though it were the same measurement")
    got = {q["session"] for q in per}
    if got != set(luc_by_session):
        raise SystemExit(f"[fig7v] session sets differ: {len(got - set(luc_by_session))} "
                         f"only in the corrected deposit, "
                         f"{len(set(luc_by_session) - got)} only in the file")

    # PER-SESSION ARRAYS IN THE FILE'S OWN ORDER, so `per_session_within[i]` still means
    # the same session it means for every other series in this deposit.
    order = list(luc_by_session)
    byname = {q["session"]: q for q in per}
    within = [byname[s]["within_idf1"] for s in order]
    # CAMERA-SCOPED is what goes in `cross`, because that is the convention every other
    # series in this file was measured under. The unscoped values are carried alongside so
    # the difference between the two conventions stays visible in the deposit.
    cross = [byname[s]["cross_idf1_scoped"] for s in order]
    cross_unscoped = [byname[s]["cross_idf1_unscoped"] for s in order]
    drift = [abs(w - c) for w, c in zip(within, cross)]
    ratio = [c / w for w, c in zip(within, cross) if w > 0]

    # The erroneous series is MOVED, not dropped -- both the stats and its win counts.
    out["bmimica_50_sessions"][SLEAP_OLD_KEY] = json.loads(json.dumps(old))
    if SLEAP_KEY in out.get("bmimica_wins", {}):
        out["bmimica_wins"][SLEAP_OLD_KEY] = \
            json.loads(json.dumps(out["bmimica_wins"][SLEAP_KEY]))
    out["bmimica_50_sessions"][SLEAP_KEY] = {
        "within": stats(within), "cross": stats(cross),
        "switches_2d_total": d["corrected"]["switches_2d_total"],
        "switches_xview_total": sum(q["cross_switches_scoped"] for q in per),
        "fragmentations_2d_total": d["corrected"]["fragmentations_2d_total"],
        # `cross_over_within` is fig3_trackers.py's definition (the MEAN of the per-session
        # ratios, not the ratio of the means), so it means the same thing as the entries
        # beside it. Its CI is left None: that deposit's interval is a 20,000-sample
        # percentile bootstrap and this file does not reproduce it, so reporting a
        # normal-approximation interval under the same key would misdescribe it.
        "cross_over_within": {"mean": sum(ratio) / len(ratio) if ratio else None,
                              "ci95_lo": None, "ci95_hi": None},
        "drift_abs_max": max(drift), "drift_abs_median": sorted(drift)[len(drift) // 2],
        # Same reason the variant arm leaves these None: the Wilcoxon/sign test over the
        # signed drift lives in fig3_trackers.py and is not reproduced here, and a panel
        # must not print a p-value that was carried over from a different measurement.
        "drift_wilcoxon_p": None, "drift_sign_p": None,
        "per_session_within": within, "per_session_cross": cross,
        # BOTH conventions on disk. `cross` above and `per_session_cross` are CAMERA-SCOPED;
        # these are the unscoped upper bound, kept so the size of the convention effect can
        # be read off the deposit instead of being taken on trust from a caveat.
        "cross_convention": "camera-scoped: hypothesis id keyed on (camera, track name), "
                            "matching bmimica_eval_crossview_all.py's `ci * 10 + slot`",
        "cross_unscoped": stats(cross_unscoped),
        "per_session_cross_unscoped": cross_unscoped,
        "source": source,
        "measured_by": d["generated_by"],
        "truncation_evidence": tev,
    }
    # PAIRED win counts, recomputed. `bmimica_wins[k]` is "LUC3D beats k in n/50", so
    # keeping the old 50/50 here would be asserting a comparison against numbers that are
    # no longer in the file.
    # Compared against the ALREADY-ALIGNED lists above, not re-read from the deposit by a
    # constructed key name. The constructed version (`f"{lbl}_idf1"`) broke the moment the
    # scoped deposit renamed that field to `cross_idf1_scoped`, and the failure mode of a
    # key-name guess here is a comparison against the WRONG convention rather than a
    # KeyError, so the arrays that the plotted series is built from are the safer source.
    w = {}
    for lbl, vals in (("within", within), ("cross", cross)):
        i = 0 if lbl == "within" else 1
        k = sum(1 for s, v in zip(order, vals) if luc_by_session[s][i] > v)
        w[lbl] = {"wins": k, "n": len(order), "sign_p": sign_p(k, len(order))}
    out.setdefault("bmimica_wins", {})[SLEAP_KEY] = w
    out["sleap_series_is_corrected"] = (
        f"`{SLEAP_KEY}` in this file is the ALL-TRACKS per-camera SLEAP baseline, scored "
        f"from {source} by {d['generated_by']}: within-view IDF1 "
        f"{stats(within)['mean']:.4f}, cross-view {stats(cross)['mean']:.4f} (CAMERA-SCOPED "
        f"pooling, this file's convention; the unscoped upper bound "
        f"{stats(cross_unscoped)['mean']:.4f} is in `cross_unscoped`). "
        f"`fig3_trackers.json` (and Fig 7a) report "
        f"{old['within']['mean']:.4f} / {old['cross']['mean']:.4f} for the same series, "
        f"which is INVALID: scripts/bartul/bmimica_build_sleap_ref.py truncates SLEAP's "
        f"tracks to the first TWO (`N_ANIMALS = 2`; `if ti is not None and ti < "
        f"N_ANIMALS`), and the retracked files hold a median of 47 tracks per "
        f"camera-session. The invalid numbers are preserved here under `{SLEAP_OLD_KEY}`.")
    out.setdefault("caveats", []).extend([
        f"CORRECTION, not a variant: `{SLEAP_KEY}` no longer holds "
        f"{old['within']['mean']:.4f}/{old['cross']['mean']:.4f}. Those were scored from "
        f"outputs/bmimica/sleap_h5/, which scripts/bartul/bmimica_build_sleap_ref.py builds "
        f"from the retracked .slp by sleap-nn's own track id but TRUNCATES to two tracks "
        f"(`N_ANIMALS = 2`), silently dropping every instance whose track index is >= 2. "
        f"The retracked files hold a median 47 tracks per camera-session (counted: 17-188 "
        f"per file on two sessions, with 0.0-84.5% of instances surviving the cut), so the "
        f"series was a top-2-track fragment of SLEAP scored as all of it. "
        f"{d['generated_by']} scores the 250 .slp files directly, every track. Old numbers "
        f"kept under `{SLEAP_OLD_KEY}`.",
        f"NOT the defect first recorded for this series. The original diagnosis -- a "
        f"detections-only pool's unstable SLOT INDEX, p95 498 px -- measured the DETECTION "
        f"pool, which is not what the series was scored from. The retracked tracks it IS "
        f"scored from are coherent: mean per-track p95 frame-to-frame centroid jump "
        f"{coh['mean_track_jump_p95_px']:.1f} px. That gate is still applied (a series from "
        f"incoherent tracks would be refused), but it is not the reason the old number was "
        f"wrong. Recorded by the measuring script as: {coh.get('note', '')}",
        f"CROSS-VIEW CONVENTION -- `{SLEAP_KEY}`'s `cross` is CAMERA-SCOPED, matching every "
        f"other series in this file. scripts/bartul/bmimica_eval_crossview_all.py scopes its "
        f"per-camera baselines (`ci*10 + slot` for SLEAP, `ci*100000 + tid` for ByteTrack) "
        f"and uses global ids only for LUC3D and 3D-MuPPET, which have cross-view identity. "
        f"The first correction pass (figs/fig7_sleap_retracked.py) pooled UNSCOPED instead, "
        f"treating track_3 in two cameras as one identity; that convention can only ADD "
        f"cross-view matches, so it is an upper bound and is NOT comparable here. Both are "
        f"deposited: scoped {stats(cross)['mean']:.4f} in `cross`, unscoped "
        f"{stats(cross_unscoped)['mean']:.4f} in `cross_unscoped`. Against Fig 7a's "
        f"{old['cross']['mean']:.4f} the honest, like-for-like change is the SCOPED one "
        f"({stats(cross)['mean'] / old['cross']['mean']:.2f}x), not the unscoped "
        f"({stats(cross_unscoped)['mean'] / old['cross']['mean']:.2f}x). `within` is "
        f"convention-free (per-camera accumulators, no pooling), so "
        f"{old['within']['mean']:.4f} -> {stats(within)['mean']:.4f} stands either way.",
        f"`{SLEAP_KEY}`'s distribution stats are this script's `stats()` (normal-"
        f"approximation 95% CI), not fig3_trackers.py's 20,000-sample percentile "
        f"bootstrap, and its quantiles interpolate where that deposit's index. Its "
        f"`drift_wilcoxon_p`/`drift_sign_p` and its `cross_over_within` CI are None for "
        f"the same reason: not reproduced here, so not reported.",
        f"`bmimica_wins['{SLEAP_KEY}']` was RECOMPUTED per session against the series in "
        f"this file's `LUC3D` slot, paired by session name. The other trackers' win counts "
        f"are unchanged and are against the SHIPPED tracker.",
    ])
    print(f"[fig7v] SLEAP correction installed from {SLEAP_SRC}:")
    print(f"        within {old['within']['mean']:.4f} -> {stats(within)['mean']:.4f} "
          f"(median {old['within']['median']:.4f} -> {stats(within)['median']:.4f})")
    print(f"        cross  {old['cross']['mean']:.4f} -> {stats(cross)['mean']:.4f} "
          f"(median {old['cross']['median']:.4f} -> {stats(cross)['median']:.4f})"
          f"   [CAMERA-SCOPED; unscoped upper bound "
          f"{stats(cross_unscoped)['mean']:.4f}]")
    print(f"        switches_2d {old['switches_2d_total']:,} -> "
          f"{d['corrected']['switches_2d_total']:,}   coherence p95 "
          f"{coh['mean_track_jump_p95_px']:.1f} px   tracks/camera-session median "
          f"{tev['tracks_per_camera_session']['median']:.0f}, surviving the builder's cut "
          f"median {tev['frac_instances_surviving_cut']['median']:.1%}")
    print(f"        LUC3D-in-this-file beats it {w['within']['wins']}/{w['within']['n']} "
          f"within, {w['cross']['wins']}/{w['cross']['n']} cross "
          f"(was {out['bmimica_wins'][SLEAP_OLD_KEY]['within']['wins']}/"
          f"{out['bmimica_wins'][SLEAP_OLD_KEY]['within']['n']} and "
          f"{out['bmimica_wins'][SLEAP_OLD_KEY]['cross']['wins']}/"
          f"{out['bmimica_wins'][SLEAP_OLD_KEY]['cross']['n']})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="sync_stale10_dist25",
                    help="which fig8_methods_50.json cell to add as a tracker series")
    ap.add_argument("--label", default=VARIANT_LABEL)
    ap.add_argument("--replace", action="store_true",
                    help="REPLACE the LUC3D series instead of adding a second one. Every "
                         "Fig 7 panel reads the `LUC3D` key, so this propagates to all of "
                         "them; the key is renamed on the artwork so no panel can present "
                         "the experimental tracker as the shipped one.")
    ap.add_argument("--fix-sleap", action="store_true",
                    help="ALSO replace the BMimica `SLEAP per-camera` series with the "
                         "ALL-TRACKS baseline from figs/out/fig7_sleap_retracked.json. This "
                         "is a CORRECTION: the series it replaces was truncated to SLEAP's "
                         "first two tracks of a median 47. The old numbers are kept under "
                         f"`{SLEAP_OLD_KEY}`.")
    ap.add_argument("--slap2m", action="store_true",
                    help="ALSO substitute the SLAP-2M `slap2m` block (Fig 7 b-g): the "
                         "SHIPPED tracker in the key the panels read, the pre-#131 block "
                         f"preserved under `{SLAP2M_REF_KEY}`, and the EXPERIMENTAL "
                         f"fresh-anchor arm under `{SLAP2M_FRESH_KEY}`. This is a "
                         "CORRECTION: the shipped block replaces a tracker that has not "
                         "been the shipped tracker since 2026-07-06.")
    ap.add_argument("--muppet-coverage", action="store_true",
                    help=f"Measure `{MUPPET_KEY}`'s frame coverage (median 1.31% of a "
                         f"session) and deposit it beside its series, so the panel can "
                         f"label a coverage artefact as one. Does NOT change its score.")
    a = ap.parse_args()

    base_p = OUT / "fig3_trackers.json"
    meth_p = OUT / "fig8_methods_50.json"
    for p in (base_p, meth_p):
        if not p.exists():
            raise SystemExit(f"{p} missing")

    base = json.loads(base_p.read_text())
    meth = json.loads(meth_p.read_text())
    cells = {c["config"]: c for c in meth["cells"]}
    if a.config not in cells:
        raise SystemExit(f"{a.config} not in {meth_p.name}; have {sorted(cells)}")
    cell = cells[a.config]
    per = cell["per_session"]

    # SANITY GATE, not an afterthought. The shipped tracker measured through the Fig 8
    # harness must equal the shipped tracker as `fig3_trackers.json` recorded it, or the
    # new series is not on the same footing as the old ones and must not be added.
    ship = cells.get("shipped")
    ref = base["bmimica_50_sessions"]["LUC3D"]
    if ship is None:
        raise SystemExit("no `shipped` cell in the 50-session deposit to cross-check with")
    d_cross = abs(ship["idf1_cross"] - ref["cross"]["mean"])
    d_within = abs(ship["idf1_within"] - ref["within"]["mean"])
    d_sw = abs(ship["switches"] - ref["switches_2d_total"])
    print(f"[fig7v] cross-check of the SHIPPED tracker through both pipelines:")
    print(f"        cross-view IDF1  {ship['idf1_cross']:.16f} vs "
          f"{ref['cross']['mean']:.16f}   diff {d_cross:.2e}")
    print(f"        within-view IDF1 {ship['idf1_within']:.16f} vs "
          f"{ref['within']['mean']:.16f}   diff {d_within:.2e}")
    print(f"        within switches  {ship['switches']} vs "
          f"{ref['switches_2d_total']}   diff {d_sw}")
    if d_cross > 1e-6 or d_within > 1e-6 or d_sw != 0:
        raise SystemExit("[fig7v] REFUSING to add the series: the Fig 8 harness does not "
                         "reproduce fig3_trackers.json's shipped numbers, so a new "
                         "series built from it would not be comparable to the existing "
                         "ones.")
    print("[fig7v] identical -- the two pipelines agree, series is comparable")

    out = json.loads(base_p.read_text())
    # REPLACE mode: the improved tracker takes over the `LUC3D` slot. Every Fig 7 panel
    # reads that key, so one substitution updates the whole figure instead of adding a
    # fifth series nobody asked for -- and two LUC3D lines on one panel is genuinely worse
    # than one, because a reader has to work out which is the app.
    #
    # The SHIPPED numbers are not discarded: they move to `LUC3D (shipped)` so the
    # comparison is still in the file and a panel can draw it if wanted. And the label
    # carries "fresh anchor" so the artwork never says a bare "LUC3D" for a tracker that
    # is not in pose/cross-view-tracker.js.
    if a.replace:
        out["bmimica_50_sessions"]["LUC3D (shipped)"] = \
            json.loads(json.dumps(out["bmimica_50_sessions"]["LUC3D"]))
        if "LUC3D" in out.get("bmimica_wins", {}):
            out["bmimica_wins"]["LUC3D (shipped)"] = out["bmimica_wins"]["LUC3D"]
        target = "LUC3D"
    else:
        target = a.label
    out["bmimica_50_sessions"][target] = {
        "within": stats([q["within_idf1"] for q in per]),
        "cross": stats([q["cross_idf1"] for q in per]),
        "switches_2d_total": cell["switches"],
        "switches_xview_total": sum(q["cross_switches"] for q in per),
        "per_session_within": [q["within_idf1"] for q in per],
        "per_session_cross": [q["cross_idf1"] for q in per],
        # DRIFT = how far cross-view IDF1 falls below within-view, per session. The panel
        # reads these, and they must be RECOMPUTED for the new tracker rather than carried
        # over from the shipped entry -- inheriting them would put the shipped tracker's
        # drift on the experimental tracker's row, which is exactly the kind of silent
        # cross-contamination this whole variant file exists to avoid. The p-values the
        # shipped entry carries came from a Wilcoxon/sign test in fig3_trackers.py that is
        # not reproduced here, so they are set to None and the panel must not print them
        # as though measured.
        "drift_abs_max": max(abs(q["cross_idf1"] - q["within_idf1"]) for q in per),
        "drift_abs_median": float(sorted(
            abs(q["cross_idf1"] - q["within_idf1"]) for q in per)[len(per) // 2]),
        "drift_wilcoxon_p": None,
        "drift_sign_p": None,
        "cross_over_within": {
            "mean": (sum(q["cross_idf1"] for q in per)
                     / max(1e-12, sum(q["within_idf1"] for q in per))),
            "ci95_lo": None, "ci95_hi": None},
    }
    # Paired win counts against the shipped tracker, in `bmimica_wins`' shape.
    sw = {q["session"]: q for q in ship["per_session"]}
    out.setdefault("bmimica_wins", {})[target] = {
        "within": {"wins": sum(1 for q in per
                               if q["within_idf1"] > sw[q["session"]]["within_idf1"]),
                   "n": len(per)},
        "cross": {"wins": sum(1 for q in per
                              if q["cross_idf1"] > sw[q["session"]]["cross_idf1"]),
                  "n": len(per)},
    }
    out["generated_by"] = ("figs/fig7_variant_tracker.py -- fig3_trackers.json plus one "
                           "EXPERIMENTAL tracker series"
                           + (" and a CORRECTED SLEAP series (--fix-sleap)"
                              if a.fix_sleap else "")
                           + "; NOT the manuscript deposit")
    out.setdefault("caveats", []).extend([
        f"`{a.label}` is figs/fig8-bench/xv_experimental.js with method "
        f"{json.dumps(cell.get('params', {}).get('method', {}))} and thresholds "
        f"{json.dumps(cell.get('params', {}).get('thresholds', {}))}. It is NOT in "
        f"pose/cross-view-tracker.js and NOT what the app does. Every other series in "
        f"this file is the shipped measurement, unchanged.",
        "Only the BMimica 50-session key carries the extra series. The improved tracker "
        "has never been run on SLAP-2M, so Fig 7b-7g cannot be redrawn from this file -- "
        "and SLAP-2M is a different regime (detector misses 35.4% of GT; identity-fix "
        "ceiling 0.7704 against BMimica's 0.9367), so no extrapolation is licensed.",
        "The shipped tracker measured through the Fig 8 harness reproduces this file's "
        "own shipped numbers exactly (checked at load: cross-view IDF1, within-view IDF1 "
        "and total within-view switches all identical), which is what makes the new "
        "series comparable to the existing ones.",
    ])

    # THE SLEAP CORRECTION LAST, so its win counts are computed against the LUC3D series
    # that ended up in the file rather than against the one that was there before
    # `--replace`. Pairing is by session NAME: this file's per-session arrays are in the
    # source CSV's order and `fig8_methods_50.json`'s are in the harness's, and the two
    # are NOT the same permutation (checked -- they disagree from the first element).
    if a.fix_sleap:
        names = bmimica_sessions(base)
        if a.replace:
            fresh = {q["session"]: q for q in per}
            missing = [s for s in names if s not in fresh]
            if missing:
                raise SystemExit(f"[fig7v] {len(missing)} sessions in the deposit are not "
                                 f"in cell {a.config}: {missing[:3]}")
            luc_by_session = {s: (fresh[s]["within_idf1"], fresh[s]["cross_idf1"])
                              for s in names}
        else:
            ref_luc = base["bmimica_50_sessions"]["LUC3D"]
            luc_by_session = dict(zip(names, zip(ref_luc["per_session_within"],
                                                 ref_luc["per_session_cross"])))
        fix_sleap(out, base, luc_by_session)
    if a.muppet_coverage:
        muppet_coverage(out)
    # THE SLAP-2M SUBSTITUTION LAST of the corrections, because it touches a different key
    # (`slap2m`) from everything above it (`bmimica_50_sessions`) and its gates read the
    # deposit's ORIGINAL block -- so it must see `base`, not a half-edited `out`.
    if a.slap2m:
        install_slap2m(out, base)

    if a.replace:
        out["luc3d_is_experimental"] = (
            "The `LUC3D` key in this file is NOT pose/cross-view-tracker.js. It is "
            f"figs/fig8-bench/xv_experimental.js, cell {a.config}. The shipped "
            "measurement is preserved under `LUC3D (shipped)`.")
    dest = OUT / "fig7_variant_best.json"
    dest.write_text(json.dumps(out, indent=2))
    w = out["bmimica_wins"][target]
    print(f"[fig7v] {'REPLACED LUC3D with' if a.replace else 'added'} "
          f"'{a.label}' from cell {a.config}:")
    print(f"        within {out['bmimica_50_sessions'][target]['within']['mean']:.4f}  "
          f"cross {out['bmimica_50_sessions'][target]['cross']['mean']:.4f}  "
          f"switches {cell['switches']:,}")
    print(f"        beats shipped on {w['within']['wins']}/{w['within']['n']} sessions "
          f"within-view, {w['cross']['wins']}/{w['cross']['n']} cross-view")
    print(f"[fig7v] wrote {dest}  (fig3_trackers.json untouched)")


if __name__ == "__main__":
    main()
