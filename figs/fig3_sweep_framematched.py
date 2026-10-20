#!/usr/bin/env python
"""Fig 3G/H sweep re-scored on THE SAME FRAMES as the exhaustive rule.

WHY (2026-10-15). The greedy sweep curves in Fig 3G/H were scored over every frame of
the 56 Mouse-Dyad-10M sessions (~50 million camera frames), while the exhaustive rule
drawn on the same axes is scored over only the frames exhaustive can compute (every
camera holding exactly 2 clean detections, ~24 million camera frames). Rates per
100,000 camera frames do not remove that difference: the clean frames are the easy
ones. fig3_frame_matched.py already scores the head-to-head greedy arm on the
exhaustive frames; this does the same for EVERY cell of BOTH sweep arms.

No new tracking. For each (arm, corr3d cell, session) it re-scores the stored sweep
output with fig3_score.score_session(frame_subset = the frames that session's
exhaustive.json computed), the same GT, the same scorer, SCORE_NOTAIL as the sweep.

Writes figs/out/<sweep deposit stem>_framematched.json for each arm: the sweep
deposit's schema, with every cell's metrics replaced by the frame-matched ones and
total_camera_frames set to the frame-matched total. The full-session values are kept
per cell under `full_session`.

    FIG3_VARIANT=md56 SCORE_NOTAIL=1 SFM_JOBS=40 \
      /root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig3_sweep_framematched.py
"""
import json, os, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

FIGS = Path(__file__).resolve().parent
OUT = FIGS / "out"
BENCH = Path("/root/vast/eric/luc3d-bench")
BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
_V = os.environ.get("FIG3_VARIANT", "")
HH = OUT / "tmp" / f"headtohead{'_' + _V if _V else ''}" / "A2_C5_bmimica"
#: (sweep deposit, its per-cell cache dir). The v1.0.5 sweeps used in Fig 3G/H.
ARMS = [
    ("fig3_sweep50__distanceThreshold25-stale20_f7733dbf_md56main.json",
     OUT / "tmp" / "sweep50_2dc001fe" / "distanceThreshold25-stale20_f7733dbf"),
    ("fig3_sweep50__distanceThreshold50-stale0_ce1d7f8d_md56main.json",
     OUT / "tmp" / "sweep50_2dc001fe" / "distanceThreshold50-stale0_ce1d7f8d"),
]
#: FIG3_VARIANT=b3 (2026-10-19, Eric): the b3 sweeps (det_h5_bvis5, tail in tracking)
#: re-scored on the b3 exhaustive arm's frames. Writes *_b3_framematched.json; the md56
#: deposits above are untouched.
if _V == "b3":
    BM_DET = BENCH / "outputs" / "bmimica" / "det_h5_bvis5"
    ARMS = [
        ("fig3_sweep50__distanceThreshold25-stale20_f7733dbf_b3.json",
         OUT / "tmp" / "sweep50_2dc001fe_b3" / "distanceThreshold25-stale20_f7733dbf"),
        ("fig3_sweep50__distanceThreshold50-stale0_ce1d7f8d_b3.json",
         OUT / "tmp" / "sweep50_2dc001fe_b3" / "distanceThreshold50-stale0_ce1d7f8d"),
    ]
    #: SFM_STALE20_ONLY=1: only the stale-20 arm (the one G/H plot).
    if os.environ.get("SFM_STALE20_ONLY") == "1":
        ARMS = ARMS[:1]


def cell_name(c):
    f = lambda x: str(int(x)) if float(x).is_integer() else str(x)
    return f"c2_{f(c['corr2d'])}_c3_{f(c['corr3d'])}"


def score_one(args):
    cache_dir, cell, sess = args
    res = cache_dir / cell / f"{sess}.json"
    cache = cache_dir / cell / f"{sess}.framematched.json"
    if cache.exists() and not os.environ.get("SFM_FORCE"):
        return args, json.loads(cache.read_text())
    sys.path.insert(0, str(FIGS))
    import fig3_score as fs
    exh = json.loads((HH / sess / "exhaustive.json").read_text())
    computed = frozenset(f["frame"] for f in exh["frames"])
    t0 = time.time()
    s = fs.score_session(str(res), str(BM_DET / sess), str(BM_GT / sess),
                         exh["cameras"], exh["numAnimals"], frame_subset=computed)
    rec = {"session": sess, "frames_scored": len(computed),
           "camera_frames": len(computed) * len(exh["cameras"]),
           **{k: s[k] for k in ("within_switches", "cross_switches", "within_idf1", "cross_idf1",
                                "within_idp", "within_idr", "cross_idp", "cross_idr")},
           "seconds": round(time.time() - t0, 1)}
    cache.write_text(json.dumps(rec))
    return args, rec


def main():
    if os.environ.get("SCORE_NOTAIL") != "1":
        sys.exit("set SCORE_NOTAIL=1 (the sweep and the exhaustive rule are scored tail-free)")
    jobs_n = int(os.environ.get("SFM_JOBS", "40"))
    deps = {name: json.loads((OUT / name).read_text()) for name, _ in ARMS}
    tasks = []
    for name, cdir in ARMS:
        for c in deps[name]["cells"]:
            for sess in deps[name]["sessions"]:
                if not (cdir / cell_name(c) / f"{sess}.json").exists():
                    sys.exit(f"missing {cdir / cell_name(c) / sess}.json")
                tasks.append((cdir, cell_name(c), sess))
    print(f"[sfm] {len(tasks)} scorings, {jobs_n} workers", flush=True)
    got, t0 = {}, time.time()
    with ProcessPoolExecutor(jobs_n) as ex:
        for i, f in enumerate(as_completed([ex.submit(score_one, t) for t in tasks]), 1):
            a, rec = f.result()
            got[a] = rec
            if i % 50 == 0:
                print(f"[sfm] {i}/{len(tasks)} ({time.time() - t0:.0f}s)", flush=True)

    for name, cdir in ARMS:
        d = deps[name]
        d["total_camera_frames_full_session"] = d["total_camera_frames"]
        tot = None
        for c in d["cells"]:
            recs = [got[(cdir, cell_name(c), s)] for s in d["sessions"]]
            camf = sum(r["camera_frames"] for r in recs)
            if tot is None:
                tot = camf
            assert camf == tot, "frame-matched denominators differ between cells"
            c["full_session"] = {k: c.get(k) for k in ("idf1_within", "idf1_cross", "switches",
                                                       "switches_per_100k_camera_frames")}
            mean = lambda k: sum(r[k] for r in recs) / len(recs)
            sw = sum(r["within_switches"] for r in recs)
            c.update({"idf1_within": mean("within_idf1"), "idf1_cross": mean("cross_idf1"),
                      "idp_within": mean("within_idp"), "idr_within": mean("within_idr"),
                      "idp_cross": mean("cross_idp"), "idr_cross": mean("cross_idr"),
                      "switches": sw, "switches_per_100k_camera_frames": sw / camf * 1e5,
                      "per_session": recs})
        d["total_camera_frames"] = tot
        d["camera_frames_by_session"] = {r["session"]: r["camera_frames"]
                                         for r in [got[(cdir, cell_name(d['cells'][0]), s)] for s in d["sessions"]]}
        d["frame_matched"] = ("Every cell re-scored on exactly the frames the exhaustive arm computed "
                              "(per session, exhaustive.json frames[].frame), by figs/fig3_sweep_framematched.py.")
        stem = name[:-5]
        (OUT / f"{stem}_framematched.json").write_text(json.dumps(d, indent=1))
        print(f"[sfm] wrote {stem}_framematched.json  total_camera_frames {tot:,}", flush=True)
    print("SFM DONE")


if __name__ == "__main__":
    main()
