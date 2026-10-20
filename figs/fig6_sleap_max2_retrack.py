#!/usr/bin/env python
"""Fig 7a fairness fix — re-run the SLEAP baseline on BMimica with the track count
ACTUALLY capped at 2, which the shipped baseline never asked for.

    ############################################################################
    WHAT WAS WRONG WITH THE BASELINE'S CONFIGURATION, and it is our defect, not
    sleap-nn's ceiling.

    `luc3d-bench/scripts/bartul/bmimica_retrack_all.py` runs sleap-nn 0.3.0 with

        --tracking_window_size 15
        --tracking_target_instance_count 2
        --post_connect_single_breaks

    and NO `--max_tracks`, NO `--candidates_method`, NO
    `--tracking_clean_instance_count`. In sleap-nn 0.3.0:

    * `--tracking_target_instance_count` caps INSTANCES PER FRAME. It never
      limited the number of tracks the tracker may create.
    * `--max_tracks` is the track cap, and it is honoured ONLY by
      `candidates_method='local_queues'` -- `fixed_window`, the default we got,
      SILENTLY IGNORES IT (`cli.py:1269-1274`, `tracking/tracker.py:246-251`).
      Both were unset, so the run had an unbounded track pool.
    * `--post_connect_single_breaks` DID run (it takes
      `max_instances=tracking_target_instance_count` = 2 --
      `tracking/tracker.py:1791` -- despite its own help text claiming it needs
      `max_tracks`). It merges only the exact pattern "exactly one track lost and
      exactly one new track spawned in the same frame", which is why a median of
      47.5 tracks per camera-session survived it.

    So the 0.2062 within-view IDF1 the corrected Fig 7a reports for SLEAP is that
    configuration's number, and the fragmentation it is penalised for (1,111,431
    fragmentations; hard top-2-id IDF1 ceiling 0.2702) is partly ours. LUC3D's
    arm on this corpus is constrained to 2 global identities BY CONSTRUCTION and
    cannot fragment, so scoring an unconstrained per-camera tracker against it is
    an asymmetric comparison. This run removes that asymmetry.

    Eric, 2026-08-13: "we need to rerun the sleap with the two tracks enforced ...
    that's fine if it moves against us because we still win the cross-view."
    ############################################################################

WHAT IS DIFFERENT AND WHAT IS DELIBERATELY IDENTICAL. Every filter, the tracking
window and the break-connection pass are copied from `bmimica_retrack_all.py`
unchanged, so the only difference between the two runs is the track cap:

    + --max_tracks 2                        the cap
    + --candidates_method local_queues      or the cap is silently dropped
    + --tracking_clean_instance_count 2     post-hoc cull to 2 tracks per frame

`--candidates_method local_queues` is passed EXPLICITLY rather than relying on the
CLI's auto-switch: the auto-switch exists (`cli.py:1269`) but it is an INFO-level
side effect of another flag, and a silent change of association method is exactly
the class of thing that produced this defect in the first place.

IT WRITES TO A NEW DIRECTORY. `outputs/bmimica/retracked_max2/`, never
`retracked/`. The shipped baseline's 250 `.slp` files are the provenance of a
number in a manuscript figure and are not to be overwritten by an experiment.

THE OUTPUT IS NOT A RESULT UNTIL IT IS GATED. A run that silently failed to cap
the tracks looks exactly like a run that did, so `--verify` reads each output back
and counts distinct tracks; anything above 2 means the flags did not take and the
file must not be scored. Score with:

    $PY figs/fig6_sleap_scoped.py --retracked <...>/retracked_max2 \
        --out fig7_sleap_max2.json

    ./fig6_sleap_max2_retrack.py --pilot                 # 1 session x 5 cameras
    ./fig6_sleap_max2_retrack.py --workers 10            # all 50 x 5
    ./fig6_sleap_max2_retrack.py --verify                # track counts per output

Interpreter: /root/vast/eric/sleap_nn_030_env/bin/python (sleap-nn 0.3.0).
NOTE that env's `bin/python` symlink was dead on 2026-08-13 (it pointed into a
`uv`-managed CPython 3.11 that had been removed); repaired with `uv python install
3.11`, which re-created `/root/.local/share/uv/python/cpython-3.11-linux-x86_64-gnu`.
"""
import argparse
import glob
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

ROOT = "/root/vast/eric/BMimica"
SRC_OUT = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked"
OUT = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2"
#: `--out-dir` repoints this. IT EXISTS TO MAKE A COLLISION IMPOSSIBLE, not for
#: convenience: a second driver run in parallel with the first must not be able to write
#: the same `.slp` path at the same moment as the first (the resume check happens when a
#: job STARTS, so two drivers can both decide a missing file needs computing). Driver 2
#: therefore writes its own directory and the results are hard-linked in afterwards --
#: `os.link` fails on an existing path rather than clobbering, so the merge cannot race
#: either. Same flags, same code, so the two drivers' outputs are the same computation.
SLEAP = os.environ.get("SLEAP_PY", "/root/vast/eric/sleap_nn_030_env/bin/python")
SER = ["21241563", "21369048", "21372315", "21372316", "22085397"]
TARGET = 2

#: Copied verbatim from `bmimica_retrack_all.py`. If these drift the two runs stop
#: being a controlled comparison and the difference stops being "the track cap".
SHARED_FLAGS = [
    "--filter_min_instance_score", "0.85",
    "--filter_min_mean_node_score", "0.55",
    "--filter_min_visible_nodes", "8",
    "--filter_overlapping", "--filter_overlapping_method", "oks",
    "--filter_overlapping_threshold", "0.50",
    "--tracking", "--tracking_window_size", "15",
    "--tracking_target_instance_count", str(TARGET),
    "--post_connect_single_breaks",
]
#: The only difference. See the module docstring.
CAP_FLAGS = [
    "--max_tracks", str(TARGET),
    "--candidates_method", "local_queues",
    "--tracking_clean_instance_count", str(TARGET),
]


#: --notail (2026-10-15). Supp Fig 6A's SLEAP arm must not see the four tail nodes at
#: TRACKING time (LUC3D and ByteTrack already did not; scoring was already tail-free).
#: Only the tail changes, so the input becomes the POOL's own source files (`retracked/`,
#: the files `det_h5` is built from: same filters, same <= 2 instances per frame) with the
#: tail set to NaN and the old track labels stripped. The filter flags are NOT re-applied
#: (they count the tail and would select a different detection set than the pool); the
#: tracking and cap flags are unchanged. Stages: --prep, then the run, then --verify.
NOTAIL_SRC = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_notail_src"
NOTAIL_OUT = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2_notail"
#: FIG6_SLEAPNT_DIRTAG=<tag> (opt-in): private retracked_notail_src_<tag>/ and
#: retracked_max2_notail_<tag>/, so two machines can never write the same files (2026-10-15:
#: an HDF5 lock collision when both machines prepped the shared dirs at once).
if os.environ.get("FIG6_SLEAPNT_DIRTAG"):
    NOTAIL_SRC += "_" + os.environ["FIG6_SLEAPNT_DIRTAG"]
    NOTAIL_OUT += "_" + os.environ["FIG6_SLEAPNT_DIRTAG"]
TAIL = (4, 7, 8, 9)          # TailTip, Tail_0, Tail_1, Tail_2 (asserted against the skeleton)
#: --b3 (2026-10-15, Fig 6c). The SLEAP arm under the Mouse-Dyad b3 rules (MDB-B-SERIES-RESULTS):
#: input = the body >= 5 pool (`det_h5_bvis5/`, SLAP-2M's rule: >= 5 of the 11 body keypoints
#: visible, NO score or overlap filters), tail INCLUDED in tracking. The input is the raw
#: BMimica predictions put through exactly the pool builder's rule and slot cut
#: (`bmimica_build_lite_pool.py`: body >= 5, canonical sort, first 4), track labels stripped,
#: so SLEAP sees the same detections LUC3D's b3 arm sees (`--check-prep` proves it against the
#: pool). The filter flags are NOT passed (they are the filters b3 removes); tracking and cap
#: flags unchanged. Scoring stays tail-free (SCORE_NOTAIL=1 in fig6_sleap_scoped.py).
B3_POOL = "/root/vast/eric/luc3d-bench/outputs/bmimica/det_h5_bvis5"
B3_SRC = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_b3_src"
B3_OUT = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2_b3"
B3_BODY_MIN, B3_SLOTS = 5, 4
B3 = False
TRACK_ONLY_FLAGS = [f for f in SHARED_FLAGS[SHARED_FLAGS.index("--tracking"):]]
NOTAIL = False
SINGLE_THREAD = False        # --single-thread: OMP/MKL/OPENBLAS = 1, CPU only (as fig6_slap2m_fair)


def prep_job(args):
    """retracked/<sid>/<cam>.slp -> retracked_notail_src/<sid>/<cam>.slp: tail NaN, no tracks."""
    sid, cam = args
    import numpy as np
    import sleap_io as sio
    src = f"{SRC_OUT}/{sid}/{cam}.slp"
    dst = f"{NOTAIL_SRC}/{sid}/{cam}.slp"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return (sid, cam, "skip_done", 0)
    if not os.path.exists(src):
        return (sid, cam, "no_src", 0)
    L = sio.load_slp(src)
    names = [n.name for n in L.skeletons[0].nodes]
    assert [names[i] for i in TAIL] == ["TailTip", "Tail_0", "Tail_1", "Tail_2"], names
    n = 0
    for lf in L.labeled_frames:
        for inst in lf.instances:
            inst.points["xy"][list(TAIL)] = np.nan
            inst.points["visible"][list(TAIL)] = False
            inst.track = None
            n += 1
    L.tracks = []
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst[:-4] + ".partial.slp"
    sio.save_slp(L, tmp)
    os.rename(tmp, dst)
    return (sid, cam, "ok", n)


def _b3_keep(lf):
    sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/lib")
    import numpy as np
    from canonical_order import sort_instances, instance_xy
    body = [i for i in range(15) if i not in TAIL]
    keep = [i for i in lf.instances if np.isfinite(instance_xy(i)[body, 0]).sum() >= B3_BODY_MIN]
    return sort_instances(keep)[:B3_SLOTS]


def prep_b3_job(args):
    """raw BMimica/<sid>/<cam>/*.slp -> retracked_b3_src/<sid>/<cam>.slp: the pool's rule, no tracks."""
    sid, cam = args
    import sleap_io as sio
    dst = f"{B3_SRC}/{sid}/{cam}.slp"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return (sid, cam, "skip_done", 0)
    src = sorted(glob.glob(f"{ROOT}/{sid}/{cam}/*.slp"))
    if not src:
        return (sid, cam, "no_src", 0)
    L = sio.load_slp(src[0], open_videos=False)
    names = [n.name for n in L.skeletons[0].nodes]
    assert [names[i] for i in TAIL] == ["TailTip", "Tail_0", "Tail_1", "Tail_2"], names
    # The raw files carry the recording PC's Windows path (F:/Jinrun/...); sleap-nn opens the
    # video, so repoint it at the local copy (as retracked/ already is).
    mp4 = sorted(glob.glob(f"{ROOT}/{sid}/{cam}/*.mp4"))
    assert len(L.videos) == 1 and len(mp4) == 1, (L.videos, mp4)
    L.videos[0].replace_filename(mp4[0], open=False)
    n = 0
    frames = []
    for lf in L.labeled_frames:
        lf.instances = _b3_keep(lf)
        for inst in lf.instances:
            inst.track = None
        n += len(lf.instances)
        if lf.instances:
            frames.append(lf)
    L.labeled_frames = frames
    L.tracks = []
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst[:-4] + ".partial.slp"
    sio.save_slp(L, tmp)
    os.rename(tmp, dst)
    return (sid, cam, "ok", n)


def check_prep_b3(sid, cam):
    """The prepped file, put through the pool's slot order, must equal det_h5_bvis5 exactly."""
    sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts/lib")
    import numpy as np
    import h5py
    import sleap_io as sio
    from canonical_order import sort_instances, instance_xy
    pool = h5py.File(f"{B3_POOL}/{sid}/{cam}_predictions.h5", "r")["tracks"][0]
    L = sio.load_slp(f"{B3_SRC}/{sid}/{cam}.slp", open_videos=False)
    assert len(L.tracks) == 0, "tracks not stripped"
    assert all(os.path.exists(v.filename) for v in L.videos), f"video missing: {L.videos}"
    mine = np.full_like(pool, np.nan)
    for lf in L.labeled_frames:
        assert lf.frame_idx < pool.shape[0], f"frame {lf.frame_idx} beyond pool"
        for slot, inst in enumerate(sort_instances(lf.instances)):
            mine[lf.frame_idx, slot] = instance_xy(inst)
    assert np.array_equal(mine, pool, equal_nan=True), f"{sid}/{cam}: differs from det_h5_bvis5"
    return len(L.labeled_frames)


def _check_prep_b3_job(args):
    return check_prep_b3(*args)


def _check_prep_job(args):
    return check_prep(*args)


def check_prep(sid, cam):
    """The prepped file must equal its source except: tail NaN, no tracks."""
    import numpy as np
    import sleap_io as sio
    a = sio.load_slp(f"{SRC_OUT}/{sid}/{cam}.slp")
    b = sio.load_slp(f"{NOTAIL_SRC}/{sid}/{cam}.slp")
    body = [i for i in range(len(a.skeletons[0].nodes)) if i not in TAIL]
    assert len(b.tracks) == 0, "tracks not stripped"
    fa = {lf.frame_idx: lf for lf in a.labeled_frames}
    fb = {lf.frame_idx: lf for lf in b.labeled_frames}
    assert fa.keys() == fb.keys(), "frame sets differ"
    for f in fa:
        ia, ib = fa[f].instances, fb[f].instances
        assert len(ia) == len(ib), f"frame {f}: instance count differs"
        for x, y in zip(ia, ib):
            pa, pb = x.numpy(), y.numpy()
            assert np.array_equal(pa[body], pb[body], equal_nan=True), f"frame {f}: body differs"
            assert np.isnan(pb[list(TAIL)]).all(), f"frame {f}: tail not NaN"
    return len(fa)


def runnable_sessions():
    """The same 50 sessions the shipped baseline used -- taken from ITS OUTPUT
    directory rather than re-deriving the filter, so the two runs cannot disagree
    about the corpus."""
    return sorted(os.path.basename(p.rstrip("/"))
                  for p in glob.glob(SRC_OUT + "/*/") if os.path.isdir(p))


def retrack_job(args):
    sid, cam = args
    if NOTAIL:
        src = [f"{NOTAIL_SRC}/{sid}/{cam}.slp"] if os.path.exists(f"{NOTAIL_SRC}/{sid}/{cam}.slp") else []
    elif B3:
        src = [f"{B3_SRC}/{sid}/{cam}.slp"] if os.path.exists(f"{B3_SRC}/{sid}/{cam}.slp") else []
    else:
        src = [p for p in glob.glob(f"{ROOT}/{sid}/{cam}/*.slp") if p.endswith(".slp")]
    if not src:
        return (sid, cam, "no_src", 0.0)
    dstdir = f"{OUT}/{sid}"
    os.makedirs(dstdir, exist_ok=True)
    dst = f"{dstdir}/{cam}.slp"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return (sid, cam, "skip_done", 0.0)
    cmd = ([SLEAP, "-m", "sleap_nn.cli", "track", "--data_path", src[0]]
           + (TRACK_ONLY_FLAGS if (NOTAIL or B3) else SHARED_FLAGS) + CAP_FLAGS
           + ["--output_path", dst])
    env = dict(os.environ)
    if SINGLE_THREAD:
        env.update(OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
                   CUDA_VISIBLE_DEVICES="")
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800, env=env)
        if r.returncode != 0 or not os.path.exists(dst):
            return (sid, cam, "FAIL:" + r.stderr[-400:].replace("\n", " "),
                    time.time() - t0)
        return (sid, cam, "ok", time.time() - t0)
    except Exception as e:
        return (sid, cam, "ERR:" + str(e)[:300], time.time() - t0)


def verify():
    """Read every output back and count distinct tracks. >2 means the cap did not
    take, and the file is NOT a valid 2-track baseline no matter what it scores."""
    sys.path.insert(0, "/root/vast/eric/luc3d-bench/scripts")
    import sleap_io as sio
    bad, ok = [], []
    for sid in runnable_sessions():
        for cam in SER:
            p = f"{OUT}/{sid}/{cam}.slp"
            if not os.path.exists(p):
                continue
            L = sio.load_slp(p)
            n = len(L.tracks)
            n_inst = sum(len(lf.instances) for lf in L)
            if NOTAIL:
                import numpy as np
                tail_ok = all(np.isnan(i.numpy()[list(TAIL)]).all() for lf in L for i in lf.instances)
                if not tail_ok:
                    bad.append((sid, cam, "TAIL PRESENT", n_inst))
                    print(f"  {sid}/{cam}: TAIL PRESENT in output", flush=True)
                    continue
            (ok if n <= TARGET else bad).append((sid, cam, n, n_inst))
            print(f"  {sid}/{cam}: {n} tracks, {n_inst:,} instances"
                  f"{'   <-- CAP NOT ENFORCED' if n > TARGET else ''}", flush=True)
    print(f"\n{len(ok)} outputs at <= {TARGET} tracks, {len(bad)} ABOVE the cap")
    if bad:
        print("REFUSE to score: the cap did not take on "
              f"{len(bad)} camera-sessions, e.g. {bad[:3]}")
        return 1
    return 0


def compare(out_dir, ref_dir, only_session=None):
    """Exact equality of two tracking runs: per frame, the multiset of (track name,
    keypoints). Used to prove an environment reproduces a deposited run."""
    import numpy as np
    import sleap_io as sio
    sess = [only_session] if only_session else runnable_sessions()
    n_bad = n_ok = 0
    for sid in sess:
        for cam in SER:
            p, q = f"{out_dir}/{sid}/{cam}.slp", f"{ref_dir}/{sid}/{cam}.slp"
            if not (os.path.exists(p) and os.path.exists(q)):
                continue
            def rows(path):
                L = sio.load_slp(path)
                return {lf.frame_idx: sorted((i.track.name if i.track else "", np.nan_to_num(i.numpy(), nan=-1e9).round(6).tobytes())
                                             for i in lf.instances) for lf in L.labeled_frames}
            ra, rb = rows(p), rows(q)
            diff = [f for f in set(ra) | set(rb) if ra.get(f) != rb.get(f)]
            print(f"  {sid}/{cam}: {len(ra)} vs {len(rb)} frames, {len(diff)} differ", flush=True)
            n_bad += bool(diff); n_ok += not diff
    print(f"compare: {n_ok} identical, {n_bad} different")
    return 1 if (n_bad or not n_ok) else 0


def main():
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--out-dir", default=OUT,
                    help="where to write; see the note on OUT before using this")
    ap.add_argument("--sessions", default=None,
                    help="comma-separated session ids (a DISJOINT slice for a second "
                         "driver -- overlapping slices defeat the point)")
    ap.add_argument("--pilot", action="store_true",
                    help="one session x 5 cameras, to time it and prove the cap")
    ap.add_argument("--only-session", default=None)
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--notail", action="store_true",
                    help="tail-free arm: input retracked_notail_src, out retracked_max2_notail")
    ap.add_argument("--prep", action="store_true", help="(--notail) build retracked_notail_src")
    ap.add_argument("--check-prep", action="store_true", help="(--notail) assert prep == source minus tail")
    ap.add_argument("--b3", action="store_true",
                    help="Fig 6c b3 arm: input retracked_b3_src (body >= 5 pool, tail kept), "
                         "out retracked_max2_b3; --prep / --check-prep build and gate the input")
    ap.add_argument("--single-thread", action="store_true")
    ap.add_argument("--compare-to", default=None,
                    help="compare every output under --out-dir with this directory (exact)")
    a = ap.parse_args()
    global NOTAIL, SINGLE_THREAD, B3
    NOTAIL, SINGLE_THREAD, B3 = a.notail, a.single_thread, a.b3
    if NOTAIL and B3:
        sys.exit("--notail and --b3 are different arms; pass one")
    OUT = NOTAIL_OUT if (a.notail and a.out_dir == OUT) else B3_OUT if (a.b3 and a.out_dir == OUT) else a.out_dir
    if a.compare_to:
        sys.exit(compare(OUT, a.compare_to, a.only_session))
    if B3 and (a.prep or a.check_prep):
        sess = [a.only_session] if a.only_session else runnable_sessions()
        jobs = [(s, c) for s in sess for c in SER]
        fn = _check_prep_b3_job if a.check_prep else prep_b3_job
        print(f"[b3 {'check' if a.check_prep else 'prep'}] {len(jobs)} camera-sessions -> {B3_SRC}", flush=True)
        bad = 0
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            futs = {ex.submit(fn, j): j for j in jobs}
            for f in as_completed(futs):
                s_, c_ = futs[f]
                try:
                    r = f.result()
                except Exception as e:  # noqa: BLE001
                    bad += 1; print(f"  {s_}/{c_} FAILED {e!r}"[:400], flush=True); continue
                print(f"  {s_}/{c_} {r}", flush=True)
                bad += isinstance(r, tuple) and r[2] not in ("ok", "skip_done")
        print(f"[b3] {'check-prep' if a.check_prep else 'prep'}: {len(jobs) - bad} of {len(jobs)} OK")
        sys.exit(1 if bad else 0)
    if a.prep or a.check_prep:
        sess = [a.only_session] if a.only_session else runnable_sessions()
        jobs = [(s, c) for s in sess for c in SER if os.path.exists(f"{SRC_OUT}/{s}/{c}.slp")]
        if a.check_prep:
            with ProcessPoolExecutor(max_workers=a.workers) as ex:
                for (s, c), nf in zip(jobs, ex.map(_check_prep_job, jobs)):
                    print(f"  check {s}/{c}: {nf} frames OK", flush=True)
            print(f"check-prep: all {len(jobs)} OK")
            sys.exit(0)
        print(f"[prep] {len(jobs)} camera-sessions -> {NOTAIL_SRC}", flush=True)
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            for s, c, st, n in ex.map(prep_job, jobs):
                print(f"[prep] {s}/{c} {st} {n} instances", flush=True)
        sys.exit(0)
    if a.verify:
        sys.exit(verify())

    sess = runnable_sessions()
    if a.sessions:
        want = a.sessions.split(",")
        missing = [w for w in want if w not in sess]
        if missing:
            sys.exit(f"unknown sessions: {missing}")
        sess = want
    elif a.only_session:
        sess = [a.only_session]
    elif a.pilot:
        sess = sess[:1]
    jobs = [(s, c) for s in sess for c in SER
            if glob.glob(f"{ROOT}/{s}/{c}/*.slp")]
    print(f"{len(sess)} sessions, {len(jobs)} camera-sessions, "
          f"{a.workers} workers -> {OUT}", flush=True)
    os.makedirs(OUT, exist_ok=True)
    done = fail = 0
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(retrack_job, j) for j in jobs]
        for f in as_completed(futs):
            sid, cam, st, dt = f.result()
            done += 1
            if st.startswith(("FAIL", "ERR", "no_src")):
                fail += 1
            print(f"[{done}/{len(jobs)}] {sid}/{cam} {st} ({dt:.0f}s) "
                  f"elapsed {time.time() - t0:.0f}s", flush=True)
    print(f"done: {done - fail} ok, {fail} failed, {time.time() - t0:.0f}s total")


if __name__ == "__main__":
    main()
