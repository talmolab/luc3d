#!/usr/bin/env python
"""Re-score SLAP-2M LUC3D arms into a DROP-IN replacement for the `luc3d` rows of
`outputs/PAF_3d_kalman/_eval_baseline.csv`, so Fig 7's panels b-g can be rebuilt on a
tracker that still exists.

WHY THIS SCRIPT EXISTS. `figs/out/fig3_trackers.json`'s SLAP-2M LUC3D arm -- the source of
every number on Fig 7 b-g -- was produced by `matchFrameInstances`, the pre-#131,
pre-module-refactor PER-FRAME matcher, driven by `luc3d-bench/scripts/luc3d_track_all.mjs`
against a FLAT LUCID snapshot on 2026-05-15. `pose/cross-view-tracker.js`
(`runCrossViewTracker`) landed 2026-07-06, seven weeks later. So Fig 7 b-g describes a
tracker that has not been the shipped tracker since. Full account, with the additive
decomposition of the 0.0160 discrepancy: `figs/out/ITEM3-SLAP2M-GATE.md`.

WHY A CSV AND NOT A SUMMARY JSON. `fig3_trackers.slap2m()` consumes far more than a mean:
paired LUC3D-SLEAP differences per session, `by_animals` (camera-session weighted),
`by_bedding`, the error decomposition (`num_false_positives`/`num_misses`/`num_switches`/
`num_objects`), `recall_correlation.per_session` rows, camera-session argmax and pairwise
win counts, survival curves, and the paired fragmentation statistic. Every one of those
needs LUC3D at PER-(SESSION, CAMERA) granularity. `figs/out/fig9_slap2m_predictions.json`
does not carry it (it has `per_camera_idf1` but session-level sums for the counts), so the
clean route is to re-score with luc3d-bench's OWN scorer and emit its own CSV shape.

WHAT IS AND IS NOT TOUCHED. `evaluate.eval_camera(..., no_sleap=True)` is called DIRECTLY.
`evaluate.main()` is never called: it overwrites `luc3d-bench/outputs/metrics/by_difficulty.csv`,
a historical artefact `figs/fig3_trackers.py`'s provenance note reasons about. Only the
`luc3d` rows are recomputed; the `sleap` and `bytetrack` rows are copied through BYTE FOR
BYTE from `_eval_baseline.csv`, because neither uses LUCID's tracker and neither can move.
Nothing under `luc3d-bench/outputs/` is written.

THE GATE, AND WHY IT IS THE ONLY ONE AVAILABLE. The BMimica gate in
`figs/fig7_variant_tracker.py` asks the shipped tracker to reproduce the deposit exactly.
On SLAP-2M that gate CANNOT pass and must not be loosened until it does: the two arms are
different algorithms (item 3). The gate that IS meaningful here is HARNESS equivalence --
re-scoring the REFERENCE's own per-frame outputs (`outputs/luc3d_results/`) through this
script must reproduce `_eval_baseline.csv`'s `luc3d` rows bit-identically, on all 444 rows
and all 22 metric columns. That is what licenses using this script's output for a different
arm: if it reproduces the reference exactly on the reference's inputs, then its numbers for
another arm differ because the TRACKER differs and for no other reason. `--gate` runs it and
writes the verdict to `<out>/gate.json`; `figs/fig7_variant_tracker.py --slap2m` refuses to
substitute unless that verdict is present and passing.

ARMS. Each is a directory of per-session tracker outputs in the schema
`evaluate.luc3d_assignments_for_cam` already accepts:

    reference   luc3d-bench/outputs/luc3d_results/            pre-#131 matchFrameInstances
                                                              (what Fig 7 b-g plots today)
    shipped     figs/out/tmp/fig9slap_predictions/shipped/    runCrossViewTracker, method {}
    fresh       .../sync_stale20_dist25/                      + {sync, stale 20}, distThresh 25

`shipped` normally does not need running: item 3 already deposited its CSV at
`figs/data/fig7/slap2m_luc3d_shipped_percam_ITEM3.csv` (header byte-identical to
`_eval_baseline.csv`; its within-view mean 0.7520235409209860 agrees to all 16 digits
between luc3d-bench's scorer and `figs/fig3_score.py`, two independent implementations).
`--adopt-shipped` copies that file in rather than re-deriving it; `--arms shipped` re-derives
it, and `--check-shipped` re-derives it and DIFFS against the deposited one.

    $PY figs/fig7_slap2m_rescore.py --gate --arms fresh --workers 8

Run with the bench interpreter (motmetrics, h5py):
/root/vast/eric/luc3d-bench/liezl_env/bin/python
"""
import argparse
import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
BENCH = Path("/root/vast/eric/luc3d-bench")
sys.path.insert(0, str(BENCH / "scripts"))
import evaluate as ev  # noqa: E402

#: The manuscript CSV. READ ONLY -- this script never writes inside luc3d-bench.
BASELINE = BENCH / "outputs" / "PAF_3d_kalman" / "_eval_baseline.csv"
#: evaluate.py's own master sheet, i.e. the one whose row index IS the `session_idx` the
#: reference run used. Item 3 verified it agrees with `sleap_nn_master_sheet.tsv` (which
#: the fresh/shipped tracker runs used) on session order, `animals`, `num_animals`,
#: `frames` and `calibration_toml` for all 74 rows, so the two arms are indexed alike.
MASTER = BENCH / "outputs" / "predictions_master_sheet.tsv"
PRED_H5 = BENCH / "outputs" / "predictions_h5s"
CAMERAS = ["back", "backL", "mid", "midL", "top", "topL"]

ARMS = {
    "reference": BENCH / "outputs" / "luc3d_results",
    "shipped": OUT / "tmp" / "fig9slap_predictions" / "shipped",
    "fresh": OUT / "tmp" / "fig9slap_predictions" / "sync_stale20_dist25",
}
#: Item 3's deposited per-camera CSV for the `shipped` arm. See the docstring.
SHIPPED_DEPOSIT = REPO / "figs" / "data" / "fig7" / "slap2m_luc3d_shipped_percam_ITEM3.csv"

DEST = OUT / "tmp" / "fig7bg_rescore"

#: The columns `eval_camera` returns, in `_eval_baseline.csv`'s order. The gate compares
#: all of them, not just IDF1: a harness that agreed on IDF1 and disagreed on
#: `num_objects` would still poison `error_decomposition`.
METRIC_COLS = ["mota", "motp", "idf1", "idp", "idr", "idtp", "idfp", "idfn",
               "num_switches", "num_fragmentations", "precision", "recall",
               "num_false_positives", "num_misses", "num_detections", "num_objects",
               "num_predictions", "mostly_tracked", "partially_tracked", "mostly_lost",
               "num_unique_objects", "num_frames"]


def _one(task):
    """One (arm, session, camera) evaluation. Module-level for ProcessPoolExecutor."""
    (arm, arm_dir, session, session_idx, cam, gt_h5, difficulty, bedding, animals) = task
    try:
        m = ev.eval_camera(PRED_H5 / f"{cam}_predictions.h5", Path(gt_h5),
                           Path(arm_dir) / f"{session}.json", None,
                           session_idx=session_idx, no_sleap=True)
    except Exception as e:  # noqa: BLE001
        return arm, session, cam, None, repr(e)
    row = {"session": session, "camera": cam, "tracker": "luc3d",
           "difficulty": difficulty, "bedding": bedding, "animals": animals}
    row.update({k: m["luc3d"][k] for k in METRIC_COLS})
    return arm, session, cam, row, None


def tasks_for(arm, sess_rows):
    d = ARMS[arm]
    out = []
    for r in sess_rows:
        j = d / f"{r['session']}.json"
        if not j.exists():
            raise SystemExit(f"[rescore] arm {arm}: missing tracker output {j}")
        for cam in CAMERAS:
            out.append((arm, str(d), r["session"], r["idx"], cam, r["gt"][cam],
                        r["difficulty"], r["bedding"], r["animals"]))
    return out


def sessions():
    df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)
    rows = []
    for idx, r in df.iterrows():
        gt = {c: r[f"{c}_proofread_h5"] for c in CAMERAS}
        missing = [c for c, p in gt.items()
                   if not (isinstance(p, str) and Path(p).exists())]
        if missing:
            raise SystemExit(f"[rescore] {r['session']}: no proofread GT for {missing} -- "
                             f"refusing to score a subset of the cameras, which would "
                             f"change the denominator against _eval_baseline.csv")
        rows.append({"session": str(r["session"]), "idx": int(idx), "gt": gt,
                     "difficulty": int(r["difficulty"]), "bedding": r["bedding"],
                     "animals": int(r["animals"])})
    return rows


def fmt(v):
    """Value as CSV text. `repr` on floats, so a float written here and read back with
    `float()` is the SAME float -- the gate compares exact equality and a %.6f would
    quietly make it a tolerance test.

    NaN IS WRITTEN AS AN EMPTY CELL, because that is what `_eval_baseline.csv` holds and
    this file has to be a drop-in for it. motmetrics returns NaN for `motp`, `idp` and
    `precision` on a camera-session where the tracker emitted NO predictions at all
    (there is one: session 10202022163211, camera `back`), pandas wrote those as empty,
    and `fig3_trackers.slap2m()`'s `sess_mean` skips a cell by testing `!= ""`. Writing
    the string `nan` instead would sail past that test and poison a session mean with
    NaN -- silently, since NaN propagates through `sum()` without complaint.
    """
    if isinstance(v, float):
        return "" if v != v else repr(v)
    return str(v)


def _f(s):
    """CSV cell -> float, with the empty cell read as NaN (see `fmt`)."""
    return float("nan") if s == "" else float(s)


def write_percam(arm, rows_by_key, sess_rows):
    """`luc3d` rows only, in `_eval_baseline.csv`'s column order and (session, camera)
    order, so it is a drop-in for that file's `luc3d` third."""
    DEST.mkdir(parents=True, exist_ok=True)
    p = DEST / f"{arm}_luc3d_percam.csv"
    cols = ["session", "camera", "tracker", "difficulty", "bedding", "animals"] + METRIC_COLS
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in sess_rows:
            for cam in CAMERAS:
                row = rows_by_key[(r["session"], cam)]
                w.writerow([fmt(row[c]) for c in cols])
    print(f"[rescore] {arm}: wrote {p} ({len(sess_rows) * len(CAMERAS)} rows)")
    return p


def merge(arm, percam_csv):
    """`_eval_baseline.csv` with its `luc3d` rows REPLACED and nothing else touched.

    The `sleap` and `bytetrack` rows are copied as the raw strings they are in the
    original file, so they cannot move even by a float round-trip; row ORDER is the
    original's, so anything positional downstream keeps meaning what it meant.
    """
    with open(BASELINE) as f:
        rd = csv.DictReader(f)
        fields = rd.fieldnames
        orig = list(rd)
    with open(percam_csv) as f:
        new = {(r["session"], r["camera"]): r for r in csv.DictReader(f)}
    if len(new) != sum(1 for r in orig if r["tracker"] == "luc3d"):
        raise SystemExit(f"[rescore] {arm}: {len(new)} new luc3d rows against "
                         f"{sum(1 for r in orig if r['tracker'] == 'luc3d')} in the "
                         f"baseline -- refusing to merge a partial arm")
    out, replaced = [], 0
    for r in orig:
        if r["tracker"] != "luc3d":
            out.append(r)
            continue
        k = (r["session"], r["camera"])
        if k not in new:
            raise SystemExit(f"[rescore] {arm}: no re-scored row for {k}")
        # Keep the baseline's own difficulty/bedding/animals strings: they are corpus
        # facts, not measurements, and copying them through means the merged file
        # differs from the original in the METRIC columns alone.
        m = dict(r)
        for c in METRIC_COLS:
            m[c] = new[k][c]
        out.append(m)
        replaced += 1
    p = DEST / f"_eval_baseline__{arm}.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out)
    print(f"[rescore] {arm}: wrote {p} ({len(out)} rows, {replaced} luc3d rows replaced)")
    return p


def gate(percam_csv):
    """HARNESS EQUIVALENCE. The reference arm, re-scored here, against the manuscript
    CSV's own `luc3d` rows: all 444 rows x 22 metric columns, exact equality demanded.

    See the docstring for why this is the gate rather than "the shipped tracker
    reproduces the deposit" (it cannot -- different algorithms) and what it licenses.
    """
    with open(BASELINE) as f:
        ref = {(r["session"], r["camera"]): r for r in csv.DictReader(f)
               if r["tracker"] == "luc3d"}
    with open(percam_csv) as f:
        got = {(r["session"], r["camera"]): r for r in csv.DictReader(f)}
    if set(ref) != set(got):
        return {"passed": False,
                "why": f"row sets differ: {len(set(ref) - set(got))} only in the "
                       f"baseline, {len(set(got) - set(ref))} only in the re-score"}
    # NaN == NaN counts as agreement here, and it has to: one camera-session
    # (10202022163211/back) has no LUC3D predictions at all, so motmetrics returns NaN for
    # motp/idp/precision and both files hold an empty cell. Treating that as a mismatch
    # would fail the gate on the one row where the two sides agree perfectly.
    worst, nan_pairs = {}, 0
    for c in METRIC_COLS:
        d = 0.0
        for k in ref:
            a, b = _f(got[k][c]), _f(ref[k][c])
            if a != a and b != b:
                nan_pairs += 1
                continue
            d = max(d, abs(a - b))
        worst[c] = d
    mx = max(worst.values())
    v = {"passed": mx == 0.0, "n_rows": len(ref), "n_metric_cols": len(METRIC_COLS),
         "max_abs_diff": mx, "max_abs_diff_by_column": worst,
         "nan_cells_agreeing": nan_pairs,
         "baseline": str(BASELINE), "rescored": str(percam_csv),
         "claim": ("evaluate.eval_camera(no_sleap=True), driven by "
                   "figs/fig7_slap2m_rescore.py over outputs/luc3d_results/, reproduces "
                   "_eval_baseline.csv's luc3d rows exactly. So a re-scored arm differs "
                   "from the reference because the TRACKER differs and for no other "
                   "reason."),
         "generated_by": "figs/fig7_slap2m_rescore.py --gate",
         "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    return v


def run(arm, sess_rows, workers):
    ts = tasks_for(arm, sess_rows)
    print(f"[rescore] {arm}: {len(ts)} (session, camera) evaluations, {workers} workers",
          flush=True)
    rows, t0 = {}, time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_one, t) for t in ts]
        done = 0
        for f in as_completed(futs):
            _a, s, cam, row, err = f.result()
            done += 1
            if err:
                raise SystemExit(f"[rescore] {arm}: {s}/{cam} FAILED: {err}")
            rows[(s, cam)] = row
            if done % 30 == 0 or done == len(ts):
                print(f"[rescore] {arm}: {done}/{len(ts)} "
                      f"({time.time() - t0:.0f}s)", flush=True)
    return write_percam(arm, rows, sess_rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="fresh",
                    help="comma-separated: " + ",".join(ARMS))
    ap.add_argument("--gate", action="store_true",
                    help="re-score the REFERENCE arm and demand bit-identical "
                         "reproduction of _eval_baseline.csv's luc3d rows")
    ap.add_argument("--adopt-shipped", action="store_true",
                    help="use item 3's deposited per-camera CSV for the shipped arm "
                         "instead of re-deriving it")
    ap.add_argument("--check-shipped", action="store_true",
                    help="re-derive the shipped arm and DIFF it against the deposited CSV")
    ap.add_argument("--workers", type=int,
                    default=int(os.environ.get("FIG7BG_WORKERS", "8")))
    a = ap.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    sess_rows = sessions()
    print(f"[rescore] {len(sess_rows)} sessions x {len(CAMERAS)} cameras")

    if a.gate:
        p = DEST / "reference_luc3d_percam.csv"
        if not p.exists():
            p = run("reference", sess_rows, a.workers)
        v = gate(p)
        (DEST / "gate.json").write_text(json.dumps(v, indent=2))
        print(f"[rescore] GATE {'PASSED' if v['passed'] else 'FAILED'}: "
              f"max abs diff {v.get('max_abs_diff')} over {v.get('n_rows')} rows x "
              f"{v.get('n_metric_cols')} metric columns")
        if not v["passed"]:
            raise SystemExit("[rescore] GATE FAILED -- stop. Do not substitute.")
        merge("reference", p)

    if a.adopt_shipped:
        p = DEST / "shipped_luc3d_percam.csv"
        p.write_bytes(SHIPPED_DEPOSIT.read_bytes())
        print(f"[rescore] shipped: adopted item 3's deposit {SHIPPED_DEPOSIT}")
        merge("shipped", p)

    for arm in [x for x in a.arms.split(",") if x]:
        p = run(arm, sess_rows, a.workers)
        merge(arm, p)
        if arm == "shipped" and a.check_shipped:
            mine = {(r["session"], r["camera"]): r
                    for r in csv.DictReader(open(p))}
            dep = {(r["session"], r["camera"]): r
                   for r in csv.DictReader(open(SHIPPED_DEPOSIT))
                   if r["tracker"] == "luc3d"}
            worst = {c: max(abs(float(mine[k][c]) - float(dep[k][c])) for k in mine)
                     for c in METRIC_COLS}
            print(f"[rescore] shipped vs item 3's deposit: max abs diff "
                  f"{max(worst.values())} over {len(mine)} rows")


if __name__ == "__main__":
    main()
