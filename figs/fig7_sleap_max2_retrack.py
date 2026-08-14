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

    $PY figs/fig7_sleap_scoped.py --retracked <...>/retracked_max2 \
        --out fig7_sleap_max2.json

    ./fig7_sleap_max2_retrack.py --pilot                 # 1 session x 5 cameras
    ./fig7_sleap_max2_retrack.py --workers 10            # all 50 x 5
    ./fig7_sleap_max2_retrack.py --verify                # track counts per output

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
SLEAP = "/root/vast/eric/sleap_nn_030_env/bin/python"
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


def runnable_sessions():
    """The same 50 sessions the shipped baseline used -- taken from ITS OUTPUT
    directory rather than re-deriving the filter, so the two runs cannot disagree
    about the corpus."""
    return sorted(os.path.basename(p.rstrip("/"))
                  for p in glob.glob(SRC_OUT + "/*/") if os.path.isdir(p))


def retrack_job(args):
    sid, cam = args
    src = [p for p in glob.glob(f"{ROOT}/{sid}/{cam}/*.slp") if p.endswith(".slp")]
    if not src:
        return (sid, cam, "no_src", 0.0)
    dstdir = f"{OUT}/{sid}"
    os.makedirs(dstdir, exist_ok=True)
    dst = f"{dstdir}/{cam}.slp"
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return (sid, cam, "skip_done", 0.0)
    cmd = ([SLEAP, "-m", "sleap_nn.cli", "track", "--data_path", src[0]]
           + SHARED_FLAGS + CAP_FLAGS + ["--output_path", dst])
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
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
            (ok if n <= TARGET else bad).append((sid, cam, n, n_inst))
            print(f"  {sid}/{cam}: {n} tracks, {n_inst:,} instances"
                  f"{'   <-- CAP NOT ENFORCED' if n > TARGET else ''}", flush=True)
    print(f"\n{len(ok)} outputs at <= {TARGET} tracks, {len(bad)} ABOVE the cap")
    if bad:
        print("REFUSE to score: the cap did not take on "
              f"{len(bad)} camera-sessions, e.g. {bad[:3]}")
        return 1
    return 0


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
    a = ap.parse_args()
    OUT = a.out_dir
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
