#!/usr/bin/env python
"""Supplementary Fig 6 / Section 5.1 fairness fix on SLAP-2M -- LUC3D, SLEAP and
ByteTrack on ONE detection pool, each baseline at its best honest configuration.

    ############################################################################
    WHY THIS EXISTS. The SLAP-2M within-view comparison in the manuscript (L150,
    L389, L391: "56 of 74 sessions, +0.099, P = 1.1e-5") was measured with

    * SLEAP scored on its inference-time tracks with NO track cap -- a single
      animal split across several tracks, which is where the single-animal gap
      came from;
    * ByteTrack at `lost_track_buffer = 60` frames;
    * the truncated `predictions_h5s` pool (4 slots; 64% of detections kept, and
      27-30% in the 3-4-animal sessions).

    This is the SLAP-2M twin of the Mouse-Dyad-10M fix
    (`fig6_sleap_max2_retrack.py`, `fig6_bytetrack_max2.py`,
    `fig6_fair_baselines.py`): SLEAP capped at the session's animal count,
    ByteTrack never-retire plus the no-GT stitch to the animal count, and all
    three methods scored on the keeptrack pool with one scorer.
    ############################################################################

THE POOL. `outputs/keeptrack_h5s` is sleap-nn 0.2.0's FILTERED detections
(`scripts/sleap_nn/retrack_one.py`: instance score 0.85, mean node score 0.55,
>= 8 visible nodes, OKS overlap 0.50) with track ids stripped and slots reordered
by score. LUC3D's shipped tracker (`sync_stale20_dist25`, i.e. stale 20,
distThresh 25, synchronous) was run on it by `figs/fig9_slap2m.py --pool
keeptrack` into `figs/out/tmp/fig9slap/sync_stale20_dist25/`. ByteTrack reads
the same array. SLEAP re-runs sleap-nn **0.2.0** -- the version that BUILT the
pool -- on the same raw `.predictions.slp` with the SAME filter flags, so its
detections are the pool's and only the tracker differs:

    + --max_tracks N --candidates_method local_queues
    + --tracking_clean_instance_count N          (N = sheet num_animals)

STAGES

    PYS=/root/vast/eric/luc3d-bench/sleap_nn_env/bin/python   # sleap-nn 0.2.0
    PYE=/root/vast/eric/luc3d-bench/eks_env/bin/python        # supervision
    PYL=/root/vast/eric/luc3d-bench/liezl_env/bin/python      # motmetrics

    $PYS figs/fig6_slap2m_fair.py --stage sleap --workers 48
    $PYE figs/fig6_slap2m_fair.py --stage verify         # SLEAP track counts <= N
    $PYE figs/fig6_slap2m_fair.py --stage bytetrack --workers 32
    $PYL figs/fig6_slap2m_fair.py --stage score --workers 48

Outputs: luc3d-bench/outputs/slap2m_fair/{sleap_cap,bytetrack_noretire_stitch}/
<session>/<cam>.{slp,h5}; figs/out/fig6_slap2m_fair.json (+ per-camera CSV).
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "figs" / "out"
BENCH = Path("/root/vast/eric/luc3d-bench")
MASTER = BENCH / "outputs" / "predictions_master_sheet.tsv"
POOL = BENCH / "outputs" / "keeptrack_h5s"
FAIR = BENCH / "outputs" / "slap2m_fair"
SLEAP_OUT = FAIR / "sleap_cap"
BYTE_OUT = FAIR / "bytetrack_noretire_stitch"
LUC3D = OUT / "tmp" / "fig9slap" / "sync_stale20_dist25"
SLEAP_PY = BENCH / "sleap_nn_env" / "bin" / "python"      # sleap-nn 0.2.0
#: FAIR_VARIANT=unfilt (2026-10-07, Fig 6b): all three trackers on the UNFILTERED
#: pre-proofreading predictions, NO match gate (eric/figs' tracker has none). Every path
#: and deposit is tagged so the base Fig 6 inputs are never touched:
#:   pool       out/tmp/predslp_pool                 (was keeptrack_h5s)
#:   outputs    out/tmp/slap2m_fair_unfilt/          (was luc3d-bench/outputs/slap2m_fair)
#:   LUC3D      out/tmp/fig9slap_predslp/sync_stale20_dist25, checked against
#:              fig9_slap2m_predslp.json             (was fig9slap / fig9_slap2m.json)
#:   SLEAP      sleap-nn track with NO --filter_* flags, same N cap
#:   deposits   fig6_slap2m_fair_unfilt{.json,_percam.csv}; install writes
#:              fig7_variant_best_unfilt.json (seeded from the base file), which the
#:              panels read under FIG_VARIANT=unfilt.
#: FAIR_SLEAP_PY overrides the sleap-nn interpreter (the bench env is broken, 2026-10-07).
VARIANT = os.environ.get("FAIR_VARIANT", "")
if VARIANT not in ("", "unfilt", "bvis4", "bvis5"):
    raise SystemExit(f"FAIR_VARIANT={VARIANT!r}: only unfilt / bvis4 / bvis5 are defined")
SUFFIX = f"_{VARIANT}" if VARIANT else ""
REF_JSON = "fig9_slap2m.json"
if VARIANT == "unfilt":
    POOL = OUT / "tmp" / "predslp_pool"
    FAIR = OUT / "tmp" / "slap2m_fair_unfilt"
    SLEAP_OUT = FAIR / "sleap_cap"
    BYTE_OUT = FAIR / "bytetrack_noretire_stitch"
    LUC3D = OUT / "tmp" / "fig9slap_predslp" / "sync_stale20_dist25"
    REF_JSON = "fig9_slap2m_predslp.json"
#: FAIR_VARIANT=bvis4 (2026-10-08, Eric chose "Body >= 4"): the unfiltered predictions minus
#: detections with < 4 visible BODY keypoints. sleap-nn's own filter counts the tail, so
#: SLEAP gets body>=4-filtered copies of the raw .predictions.slp (stage `sleapsrc`) and
#: runs with NO filter flags -- the same detections LUC3D and ByteTrack see.
#: FAIR_VARIANT=bvis5 is the same at >= 5 body keypoints (Figs 3c/4c/6c, 2026-10-08).
SLEAP_SRC = None
BODY_MIN = None
if VARIANT in ("bvis4", "bvis5"):
    BODY_MIN = int(VARIANT[-1])
    POOL = OUT / "tmp" / "lite_pools" / VARIANT
    FAIR = OUT / "tmp" / f"slap2m_fair_{VARIANT}"
    SLEAP_OUT = FAIR / "sleap_cap"
    BYTE_OUT = FAIR / "bytetrack_noretire_stitch"
    SLEAP_SRC = FAIR / "src"
    LUC3D = OUT / "tmp" / f"fig9slap_lite_{VARIANT}" / "sync_stale20_dist25"
    REF_JSON = f"fig9_slap2m_lite_{VARIANT}.json"
#: tail-free scoring everywhere (score_notail): GT, LUC3D, SLEAP and ByteTrack boxes
import score_notail  # noqa: E402
if score_notail.ACTIVE:
    REF_JSON = REF_JSON.replace(".json", "_notailscore.json")
if os.environ.get("FAIR_SLEAP_PY"):
    SLEAP_PY = Path(os.environ["FAIR_SLEAP_PY"])
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]

#: Copied from `scripts/sleap_nn/retrack_one.py` (the flags that BUILT the pool).
#: If these drift, SLEAP's detections stop being the pool's.
SHARED_FLAGS = [
    "--filter_min_instance_score", "0.85",
    "--filter_min_mean_node_score", "0.55",
    "--filter_min_visible_nodes", "8",
    "--filter_overlapping", "--filter_overlapping_method", "oks",
    "--filter_overlapping_threshold", "0.50",
    "--tracking", "--tracking_window_size", "15",
    "--post_connect_single_breaks",
]
if VARIANT in ("unfilt", "bvis4", "bvis5"):   # sleap-nn's filters are opt-in; no flags = none
    SHARED_FLAGS = ["--tracking", "--tracking_window_size", "15",
                    "--post_connect_single_breaks"]


def cap_flags(n):
    return ["--tracking_target_instance_count", str(n),
            "--max_tracks", str(n),
            "--candidates_method", "local_queues",
            "--tracking_clean_instance_count", str(n)]


def master():
    import csv
    with open(MASTER) as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    return [{"idx": i, "session": r["session"], "animals": int(r["num_animals"]),
             "difficulty": int(r["difficulty"]), "bedding": r["bedding"],
             **{f"{c}_raw": r[f"{c}_raw_pred_slp"] for c in CAMS},
             **{f"{c}_gt": r[f"{c}_proofread_h5"] for c in CAMS}}
            for i, r in enumerate(rows)]


# ------------------------------------------------------------- stage: sleapsrc
def sleapsrc_job(args):
    """Copy one raw .predictions.slp minus instances with < BODY_MIN visible BODY keypoints
    -- build_lite_pools.py's `bvisN` rule, applied to the file SLEAP reads."""
    sid, cam, src = args
    dst = SLEAP_SRC / sid / f"{cam}.slp"
    if dst.exists() and dst.stat().st_size > 1000:
        return sid, cam, "skip", 0, 0
    if not src or not Path(src).exists():
        return sid, cam, "no_src", 0, 0
    import sleap_io as sio
    dst.parent.mkdir(parents=True, exist_ok=True)
    L = sio.load_slp(src)
    body = [i for i in range(len(L.skeletons[0].nodes)) if i not in (4, 7, 8, 9)]
    kept = dropped = 0
    for lf in L.labeled_frames:
        keep = []
        for inst in lf.instances:
            pts = inst.numpy()
            if np.isfinite(pts[body, 0]).sum() >= BODY_MIN:
                keep.append(inst)
            else:
                dropped += 1
        kept += len(keep)
        lf.instances = keep
    tmp = dst.with_suffix(".partial.slp")
    sio.save_slp(L, str(tmp))
    tmp.rename(dst)
    return sid, cam, "ok", kept, dropped


def stage_sleapsrc(rows, workers):
    jobs = [(r["session"], c, r[f"{c}_raw"]) for r in rows for c in CAMS]
    from concurrent.futures import ProcessPoolExecutor
    tk = td = 0
    with ProcessPoolExecutor(workers) as ex:
        for sid, cam, st, k, d in ex.map(sleapsrc_job, jobs):
            tk += k; td += d
            if st not in ("ok", "skip"):
                print(f"[sleapsrc] {sid}/{cam} {st}", flush=True)
    print(f"[sleapsrc] done: kept {tk:,}, dropped {td:,} instances -> {SLEAP_SRC}", flush=True)


# ---------------------------------------------------------------- stage: sleap
def sleap_job(args):
    sid, cam, src, n = args
    if SLEAP_SRC is not None:            # body>=4-filtered copy (stage sleapsrc)
        src = str(SLEAP_SRC / sid / f"{cam}.slp")
    dst = SLEAP_OUT / sid / f"{cam}.slp"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 1000:
        return sid, cam, "skip", 0.0
    if not src or not Path(src).exists():
        return sid, cam, "no_src", 0.0
    tmp = dst.with_suffix(".partial.slp")
    cmd = ([str(SLEAP_PY), "-m", "sleap_nn.cli", "track", "--data_path", src]
           + SHARED_FLAGS + cap_flags(n) + ["--output_path", str(tmp)])
    env = {**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "OPENBLAS_NUM_THREADS": "1", "CUDA_VISIBLE_DEVICES": ""}
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=4 * 3600, env=env)
    if r.returncode != 0 or not tmp.exists():
        return sid, cam, "FAIL:" + r.stderr[-400:].replace("\n", " "), time.time() - t0
    tmp.rename(dst)          # atomic: a killed job never leaves a plausible .slp
    return sid, cam, "ok", time.time() - t0


def stage_sleap(rows, workers):
    jobs = [(r["session"], c, r[f"{c}_raw"], r["animals"]) for r in rows for c in CAMS
            if isinstance(r[f"{c}_gt"], str) and r[f"{c}_gt"]]
    # longest (most animals) first so the tail is short
    jobs.sort(key=lambda j: -j[3])
    print(f"[sleap] {len(jobs)} camera-sessions -> {SLEAP_OUT}", flush=True)
    t0, done, fail = time.time(), 0, 0
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(sleap_job, j) for j in jobs]):
            sid, cam, st, dt = f.result()
            done += 1
            if st not in ("ok", "skip"):
                fail += 1
                print(f"  {sid}/{cam}: {st}", flush=True)
            if st == "ok":
                print(f"[sleap] {done}/{len(jobs)} {sid}/{cam} {dt:.0f}s "
                      f"(elapsed {time.time() - t0:.0f}s)", flush=True)
    print(f"[sleap] done: {done - fail} ok, {fail} failed, {time.time() - t0:.0f}s")


def stage_verify(rows):
    """Read every SLEAP output back and count tracks. > N means the cap did not
    take, and the file must not be scored."""
    import sleap_io as sio
    bad, ok, missing = [], 0, 0
    for r in rows:
        for c in CAMS:
            p = SLEAP_OUT / r["session"] / f"{c}.slp"
            if not p.exists():
                missing += 1
                continue
            L = sio.load_slp(str(p), open_videos=False)
            used = {id(i.track) for lf in L for i in lf.instances if i.track is not None}
            if len(used) > r["animals"]:
                bad.append((r["session"], c, len(used), r["animals"]))
            else:
                ok += 1
    print(f"[verify] {ok} at <= N tracks, {len(bad)} ABOVE, {missing} missing")
    for b in bad[:20]:
        print("   CAP NOT ENFORCED", b)
    return 1 if bad else 0


# ---------------------------------------------------------------- stage: bytetrack
def byte_job(args):
    """Never-retire ByteTrack on the pool, then `stitch_to_2(n_slots=N)` (no GT).
    Reproduces the files the interrupted 2026-09-28 run wrote byte for byte
    (checked on 10072022120554/back and 10072022151549/top)."""
    idx, sid, cam, n = args
    import h5py
    sys.path.insert(0, str(BENCH / "scripts"))
    sys.path.insert(0, str(REPO / "figs"))
    import run_bytetrack_bench as _rbb
    score_notail.install_fn(_rbb, "bbox_from_keypoints")   # tail-free ByteTrack boxes
    from run_bytetrack_bench import run_camera_session
    from fig6_bytetrack_max2 import stitch_to_2
    dst = BYTE_OUT / sid / f"{cam}.h5"
    if dst.exists() and dst.stat().st_size > 500:
        return sid, cam, "skip"
    dst.parent.mkdir(parents=True, exist_ok=True)
    src = POOL / f"{cam}_predictions.h5"
    with h5py.File(src, "r") as f:
        nf = int(f["tracks"].shape[1])
    raw = run_camera_session(src, idx, lost_track_buffer=nf)
    st = stitch_to_2(raw, n_slots=n)
    tmp = dst.with_suffix(".partial.h5")
    with h5py.File(tmp, "w") as f:
        f.create_dataset("tracks", data=st)
        f.create_dataset("tracks_raw", data=raw)
        f.attrs["lost_track_buffer"] = nf
        f.attrs["n_slots"] = n
    tmp.rename(dst)
    return sid, cam, "ok"


def stage_bytetrack(rows, workers):
    jobs = [(r["idx"], r["session"], c, r["animals"]) for r in rows for c in CAMS]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(byte_job, j) for j in jobs]):
            sid, cam, st = f.result()
            if st != "skip":
                print(f"[byte] {sid}/{cam} {st}", flush=True)
    print("[byte] done")


# ---------------------------------------------------------------- stage: score
def sleap_to_array(slp, n_frames, n_slots):
    """A capped SLEAP .slp as the bench's ByteTrack schema `(F, slots, 6)` =
    [track, x1, y1, x2, y2, score], boxes from `evaluate.bbox_from_kpts` so SLEAP,
    ByteTrack and LUC3D are boxed identically."""
    import sleap_io as sio
    import evaluate as ev
    L = sio.load_slp(str(slp), open_videos=False)
    tix = {id(t): i for i, t in enumerate(L.tracks)}
    arr = np.full((n_frames, n_slots, 6), np.nan)
    over = 0
    for lf in L:
        fi = int(lf.frame_idx)
        if fi >= n_frames:
            continue
        j = 0
        for inst in lf.instances:
            if inst.track is None:
                continue
            b = ev.bbox_from_kpts(np.asarray(inst.numpy(), float))
            if b is None:
                continue
            if j >= n_slots:
                over += 1
                continue
            arr[fi, j] = (tix[id(inst.track)], *b, float(getattr(inst, "score", 1.0) or 1.0))
            j += 1
    return arr, over


def score_job(r):
    import h5py
    sys.path.insert(0, str(BENCH / "scripts"))
    import evaluate as ev
    score_notail.install(ev)
    tmpdir = FAIR / "_score_tmp" / r["session"]
    tmpdir.mkdir(parents=True, exist_ok=True)
    out = []
    for c in CAMS:
        gt = r[f"{c}_gt"]
        if not isinstance(gt, str) or not gt:
            continue
        pool = POOL / f"{c}_predictions.h5"
        with h5py.File(pool, "r") as f:
            n_frames, n_slots = f["tracks"].shape[1:3]
        luc = LUC3D / f"{r['session']}.json"
        byte = BYTE_OUT / r["session"] / f"{c}.h5"
        m1 = ev.eval_camera(pool, Path(gt), luc, byte, session_idx=r["idx"], no_sleap=True)
        arr, over = sleap_to_array(SLEAP_OUT / r["session"] / f"{c}.slp", n_frames, n_slots)
        sh5 = tmpdir / f"{c}.sleap_as_byte.h5"
        with h5py.File(sh5, "w") as f:
            f.create_dataset("tracks", data=arr)
        m2 = ev.eval_camera(pool, Path(gt), luc, sh5, session_idx=r["idx"], no_sleap=True)
        sh5.unlink()
        for tracker, m in (("luc3d", m1["luc3d"]), ("bytetrack", m1["bytetrack"]),
                           ("sleap", m2["bytetrack"])):
            out.append({"session": r["session"], "camera": c, "tracker": tracker,
                        "difficulty": r["difficulty"], "bedding": r["bedding"],
                        "animals": r["animals"], **m,
                        **({"sleap_dropped_over_slots": over} if tracker == "sleap" else {})})
        # the LUC3D number is computed twice through the same code; must agree
        assert m1["luc3d"]["idf1"] == m2["luc3d"]["idf1"]
    return out


def stats(rows):
    sys.path.insert(0, str(REPO / "figs"))
    from fig3_trackers import sign_p, wilcoxon_p, boot_ci
    import statistics as st
    per = {}
    meta = {}
    for x in rows:
        per.setdefault(x["tracker"], {}).setdefault(x["session"], []).append(float(x["idf1"]))
        meta[x["session"]] = int(x["animals"])
    sess = sorted(meta)
    idf1 = {t: {s: float(np.mean(v)) for s, v in d.items()} for t, d in per.items()}
    res = {"within_view_mean": {t: float(np.mean([idf1[t][s] for s in sess])) for t in idf1},
           "within_view_median": {t: float(np.median([idf1[t][s] for s in sess])) for t in idf1},
           "per_session": {s: {t: idf1[t][s] for t in idf1} | {"animals": meta[s]}
                           for s in sess},
           "paired": {}}
    for base in ("sleap", "bytetrack"):
        for key in ("1", "2", "3", "4", "all", "ge2", "3-4"):
            ss = [s for s in sess if key == "all"
                  or (key == "ge2" and meta[s] >= 2)
                  or (key == "3-4" and meta[s] >= 3)
                  or (key.isdigit() and meta[s] == int(key))]
            d = [idf1["luc3d"][s] - idf1[base][s] for s in ss]
            if not d:
                continue
            wins = sum(1 for v in d if v > 0)
            lo, hi = boot_ci(d)
            res["paired"][f"luc3d_minus_{base}__{key}"] = dict(
                n_sessions=len(ss), mean=float(np.mean(d)), median=float(st.median(d)),
                ci95_lo=lo, ci95_hi=hi, wins=wins, ties=sum(1 for v in d if v == 0),
                losses=sum(1 for v in d if v < 0), sign_p=sign_p(wins, len(ss)),
                # The number the manuscript quotes: exact two-sided sign test with
                # ties EXCLUDED (the standard test). `sign_p` above is fig3_trackers'
                # convention, which counts ties as losses -- on the 9 exactly tied
                # single-animal sessions that manufactures a significant P.
                sign_p_ties_excluded=sign_p(wins, wins + sum(1 for v in d if v < 0)),
                wilcoxon_p=wilcoxon_p(d))
    return res


def gate_luc3d(rows):
    """This harness's LUC3D per-camera IDF1 must match the fig9_slap2m.json
    deposit that the manuscript's keeptrack LUC3D numbers come from."""
    d = json.loads((OUT / REF_JSON).read_text())
    cell = [c for c in d["cells"] if c["config"] == "sync_stale20_dist25"][0]
    ref = {p["session"]: p["per_camera_idf1"] for p in cell["per_session"]}
    mine = {}
    for x in rows:
        if x["tracker"] == "luc3d":
            mine.setdefault(x["session"], {})[x["camera"]] = float(x["idf1"])
    diffs = []
    for s, pc in ref.items():
        if s in mine:
            diffs += [abs(a - mine[s][c]) for a, c in zip(pc, CAMS)]
    g = {"reference": f"{REF_JSON} cells[sync_stale20_dist25].per_camera_idf1",
         "n_camera_sessions": len(diffs), "max_abs_diff": max(diffs),
         "within_mean_ref": cell["all_sessions"]["idf1_within"]}
    print(f"[gate] LUC3D vs fig9 deposit: {len(diffs)} camera-sessions, max |diff| "
          f"{g['max_abs_diff']:.3e}")
    return g


def stage_score(rows, workers):
    import csv
    allrows = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(score_job, r): r["session"] for r in rows}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                allrows += f.result()
                print(f"[score] {futs[f]} ({i}/{len(rows)})", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[score] FAILED {futs[f]}: {e!r}", flush=True)
    allrows.sort(key=lambda x: (x["session"], x["camera"], x["tracker"]))
    keys = list(dict.fromkeys(k for x in allrows for k in x))
    csv_path = OUT / f"fig6_slap2m_fair{SUFFIX}_percam.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(allrows)
    s = stats(allrows)
    out = {"generated_by": "figs/fig6_slap2m_fair.py --stage score",
           "pool": str(POOL), "n_sessions": len({x["session"] for x in allrows}),
           "arms": {"luc3d": f"shipped tracker, {LUC3D}",
                    "sleap": "sleap-nn 0.2.0, " + ("NO filters" if VARIANT == "unfilt" else "pool filters") + " + --max_tracks N "
                             "--candidates_method local_queues "
                             "--tracking_clean_instance_count N (N = animals)",
                    "bytetrack": "supervision 0.30.0, lost_track_buffer = n_frames + "
                                 "stitch_to_2(n_slots=N), no GT"},
           "scorer": "luc3d-bench scripts/evaluate.py eval_camera (motmetrics, IoU 0.5)",
           "gate_luc3d": gate_luc3d(allrows), **s}
    (OUT / f"fig6_slap2m_fair{SUFFIX}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({"within_view_mean": s["within_view_mean"],
                      "within_view_median": s["within_view_median"]}, indent=1))
    for k, v in s["paired"].items():
        print(f"  {k:32s} n={v['n_sessions']:2d} mean {v['mean']:+.3f} median "
              f"{v['median']:+.3f} wins {v['wins']}/{v['n_sessions']} sign p={v['sign_p']:.2g}")
    print(f"[score] wrote {csv_path} and {OUT / f'fig6_slap2m_fair{SUFFIX}.json'}")


def stage_install():
    """`fig3_trackers.slap2m()` -- verbatim, the aggregation every Supp. Fig 6 B-D
    panel already reads -- over the fair CSV, installed as the ADDITIVE key
    `slap2m_fair` in `fig7_variant_best.json`. No existing block is modified."""
    import shutil
    sys.path.insert(0, str(REPO / "figs"))
    import fig3_trackers as f3
    csv_path = OUT / f"fig6_slap2m_fair{SUFFIX}_percam.csv"
    old = f3.SLAP2M
    try:
        f3.SLAP2M = str(csv_path)
        block = json.loads(json.dumps(f3.slap2m()))
    finally:
        f3.SLAP2M = old
    block["source"] = (f"{csv_path.name} (figs/fig6_slap2m_fair.py): {POOL.name} pool; "
                       "LUC3D shipped tracker; SLEAP capped at N; ByteTrack never-retire "
                       "+ stitch to N")
    vb = OUT / f"fig7_variant_best{SUFFIX}.json"
    bak = OUT / f"fig7_variant_best{SUFFIX}.pre_slap2m_fair.json"
    if VARIANT and not vb.exists():
        # seed the variant file from the base one; only its slap2m_fair block changes
        shutil.copy2(OUT / "fig7_variant_best.json", vb)
    if not bak.exists():
        shutil.copy2(vb, bak)
    t = json.loads(vb.read_text())
    t["slap2m_fair"] = block
    vb.write_text(json.dumps(t, indent=1))
    w = block["within_view"]
    print("[install] slap2m_fair within-view means:",
          {k: round(v["mean"], 4) for k, v in w.items()})
    for k, v in block["paired_vs_sleap"].items():
        print(f"  paired {k}: n={v['n_sessions']} mean {v['mean']:+.4f} median "
              f"{v['median']:+.4f} wins {v['wins']} sign p {v['sign_p']:.3g}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True,
                    choices=["sleapsrc", "sleap", "verify", "bytetrack", "score", "stats",
                             "install"])
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--sessions", default=None)
    a = ap.parse_args()
    rows = master()
    if a.sessions:
        want = set(a.sessions.split(","))
        rows = [r for r in rows if r["session"] in want]
    if a.stage == "sleapsrc":
        stage_sleapsrc(rows, a.workers)
    elif a.stage == "sleap":
        stage_sleap(rows, a.workers)
    elif a.stage == "verify":
        sys.exit(stage_verify(rows))
    elif a.stage == "bytetrack":
        stage_bytetrack(rows, a.workers)
    elif a.stage == "stats":
        # recompute the paired statistics from the deposited per-camera CSV
        import csv as _csv
        with open(OUT / f"fig6_slap2m_fair{SUFFIX}_percam.csv") as f:
            allrows = list(_csv.DictReader(f))
        jp = OUT / f"fig6_slap2m_fair{SUFFIX}.json"
        j = json.loads(jp.read_text())
        j.update(stats(allrows))
        jp.write_text(json.dumps(j, indent=1))
        for k, v in j["paired"].items():
            print(f"  {k:32s} wins {v['wins']} losses {v['losses']} ties {v['ties']} "
                  f"sign p (ties excl.) {v['sign_p_ties_excluded']:.3g}")
    elif a.stage == "install":
        stage_install()
    else:
        stage_score(rows, a.workers)


if __name__ == "__main__":
    main()
