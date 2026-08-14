#!/usr/bin/env python
"""ID ACCURACY (IDA) on BMimica — "of the detections, what fraction have the right ID".

    ############################################################################
    WHY THIS EXISTS. IDF1 answers "how good is identity overall" by folding
    coverage and correctness into one harmonic mean, which is the right summary
    for a paper and the wrong answer to "what percentage is correct". Three
    different percentages get called that, and they differ by DENOMINATOR:

        IDP = idtp / (idtp + idfp)   of the detections the tracker EMITTED
        IDR = idtp / (idtp + idfn)   of the animal-frames that EXIST in the GT
        IDA = idtp / num_matches     of the detections that were MATCHED to a
                                     real animal -- detector misses AND
                                     false-positive detections both excluded

    IDA is the one that isolates the tracker: it asks only about detections that
    correspond to a real animal, so a weak detector cannot drag it down and a
    noisy one cannot inflate it. `IDA >= IDP` always (dropping false positives
    from the denominator can only raise it) and the two are EQUAL when the pool
    emits no false positives -- which is worth checking rather than assuming,
    since some BMimica sessions score IDP exactly 1.0.

    KNOWN 1e-6-LEVEL ARTEFACT (caught by the docs pass, 2026-08-15): a handful of
    per-session values print marginally ABOVE 100% (e.g. 100.00006). That is not a
    bug in the sums -- motmetrics computes `idtp` from the GLOBAL trajectory
    alignment (the ID-measures bipartite matching over whole tracks) while
    `num_matches` counts FRAME-LEVEL match events, and the two alignments can
    disagree on a few detections per million. The quoted corpus numbers are
    unaffected (IDA and IDP agree to three decimals here because false positives
    are ~0.1% of matches); any consumer needing a hard [0,1] bound should quote
    IDP, whose numerator and denominator come from one alignment.
    ############################################################################

IT RE-SCORES, IT DOES NOT RE-TRACK. `figs/out/tmp/fig8m50/<cell>/<session>.json`
holds the per-frame assignments from the original run, so this walks that cache and
re-runs motmetrics with two extra fields. Nothing about the tracking changes, and
the IDF1 it prints MUST match `fig8_methods_50.json` for the same cell -- that is
the gate, and it is what makes the new number comparable to the published one.

RATES, NOT MEANS OF RATES. IDA is accumulated as summed `idtp` over summed
`num_matches` across cameras and sessions. A mean of per-session IDA weights a
30-second session like a three-hour one; both are reported and they are not the
same number.

    $PY figs/fig8_ida.py --cell sync_stale20_dist25 --workers 8
    $PY figs/fig8_ida.py --cell shipped --workers 8

Run with the bench interpreter (motmetrics + h5py):
/root/vast/eric/luc3d-bench/liezl_env/bin/python
Output: figs/out/fig8_ida_<cell>.json
"""
import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))
import fig3_score as fs  # noqa: E402
import fig3_sweep as f3  # noqa: E402

CACHE = OUT / "tmp" / "fig8m50"
BM = Path("/root/vast/eric/luc3d-bench/outputs/bmimica")
DET = BM / "det_h5"
GT = BM / "gt"


def job(cell, session):
    try:
        r = fs.score_session(
            str(CACHE / cell / f"{session}.json"),
            str(DET / session), str(GT / session),
            f3.CAMERAS, 2)
        r["session"] = session
        return session, r, None
    except Exception as e:  # noqa: BLE001
        return session, None, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell", default="sync_stale20_dist25")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()

    # session files only: the cell dir also holds params.json, which is not a
    # session and would count as a phantom 51st entry (it fails scoring and is
    # excluded from the aggregate either way -- this keeps the log honest).
    sessions = sorted(p.stem for p in (CACHE / a.cell).glob("2*.json"))
    if a.limit:
        sessions = sessions[:a.limit]
    print(f"[ida] cell {a.cell}: {len(sessions)} cached sessions, {a.workers} workers",
          flush=True)

    rows, t0 = [], time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(job, a.cell, s) for s in sessions]
        for i, f in enumerate(as_completed(futs), 1):
            s, r, err = f.result()
            if err:
                print(f"[ida] FAILED {s}: {err}", flush=True)
                continue
            rows.append(r)
            print(f"[ida] {s}: IDA {r['within_ida']:.4f}  IDP {r['within_idp']:.4f}  "
                  f"IDR {r['within_idr']:.4f}  IDF1 {r['within_idf1']:.4f}  "
                  f"FP {r['within_false_positives']:,}  ({i}/{len(sessions)}, "
                  f"{time.time() - t0:.0f}s)", flush=True)
    if not rows:
        sys.exit("[ida] nothing scored")
    rows.sort(key=lambda r: r["session"])

    idtp = sum(r["within_idtp"] for r in rows)
    matches = sum(r["within_matches"] for r in rows)
    objects = sum(r["within_objects"] for r in rows)
    fp = sum(r["within_false_positives"] for r in rows)
    miss = sum(r["within_misses"] for r in rows)
    ida_pooled = idtp / matches
    summary = {
        "cell": a.cell,
        "n_sessions": len(rows),
        "ida_pooled": ida_pooled,
        "ida_session_mean": float(np.mean([r["within_ida"] for r in rows])),
        "ida_session_median": float(np.median([r["within_ida"] for r in rows])),
        "ida_session_min": float(np.min([r["within_ida"] for r in rows])),
        "idp_session_mean": float(np.mean([r["within_idp"] for r in rows])),
        "idr_session_mean": float(np.mean([r["within_idr"] for r in rows])),
        "idf1_session_mean": float(np.mean([r["within_idf1"] for r in rows])),
        "idtp_total": idtp, "matches_total": matches, "objects_total": objects,
        "false_positives_total": fp, "misses_total": miss,
        "detection_recall_pooled": matches / objects if objects else None,
        "wrong_id_detections": matches - idtp,
    }
    print()
    print(f"[ida] {a.cell}, {len(rows)} sessions, WITHIN VIEW")
    print(f"      detections matched to a real animal : {matches:,}")
    print(f"      of those, CORRECT identity          : {idtp:,}")
    print(f"      of those, WRONG identity            : {matches - idtp:,}")
    print(f"      ID ACCURACY (pooled)                : {ida_pooled:.4%}")
    print(f"      ID ACCURACY (session mean)          : {summary['ida_session_mean']:.4%}"
          f"   (median {summary['ida_session_median']:.4%}, "
          f"worst {summary['ida_session_min']:.4%})")
    print(f"      IDP / IDR / IDF1 (session means)    : "
          f"{summary['idp_session_mean']:.4f} / {summary['idr_session_mean']:.4f} / "
          f"{summary['idf1_session_mean']:.4f}")
    print(f"      false-positive detections           : {fp:,} "
          f"({fp / matches:.3%} of matches) -- this is the whole gap between IDA and IDP")
    print(f"      detector recall (matches/objects)   : "
          f"{summary['detection_recall_pooled']:.4f}")

    (OUT / f"fig8_ida_{a.cell}.json").write_text(json.dumps(
        {"generated_by": "figs/fig8_ida.py",
         "claim": "ID accuracy (idtp / num_matches) for one cached fig8 method cell on "
                  "the 50 BMimica sessions, i.e. of the detections matched to a real "
                  "animal, the fraction carrying the correct identity.",
         "note": "IDA excludes BOTH detector misses (in IDR's denominator) and "
                 "false-positive detections (in IDP's denominator). IDA >= IDP always. "
                 "The IDF1 here must reproduce fig8_methods_50.json for this cell -- if "
                 "it does not, the cache and the deposit disagree and neither is safe.",
         "summary": summary, "per_session": rows}, indent=1))
    print(f"[ida] wrote {OUT / f'fig8_ida_{a.cell}.json'}")


if __name__ == "__main__":
    main()
