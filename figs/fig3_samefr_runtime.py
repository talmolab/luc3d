#!/usr/bin/env python
"""Fig 3F on IDENTICAL frames: greedy (LUC3D) and exhaustive timed on the same frames.

WHY (2026-10-15). Fig 3F compared exhaustive seconds/frame -- total wall time including
a whole-session eligibility scan, divided by the eligible (capped) frames it enumerated,
over every session of each configuration -- against LUC3D seconds/frame from
fig3_scale_runtime.py, which tracks the FIRST 3,000 frames of ONE session per cell.
Different frames, different sessions, different timer scope.

Here both arms use, per (configuration, session):
  frames   exactly the frames the exhaustive run computed (`frames[].frame` in its
           exhaustive.json), passed to fig3_bench.mjs --frame-list;
  scope    solve time only: exhaustive `enumerationSeconds` (its eligibility scan is
           excluded) vs greedy `runtimeSeconds` (runCrossViewTracker only);
  code     LUC3D v1.0.5 (LUCID_ROOT) for both drivers' pose/;
  load     the same parallelism as the exhaustive pass (HH_JOBS, default 16).
Aggregation is frame-weighted for both: sum(seconds) / sum(frames).

Reads the head-to-head cache (fig3_headtohead.py, FIG3_VARIANT). Writes
figs/out/fig3_runtime_samefr<_variant>.json (the fig3_runtime.json schema, one
`measured` cell per configuration) and figs/out/fig3_headtohead_samefr<_variant>.json
(a copy of the head-to-head deposit whose `seconds_per_frame_exhaustive` is the
enumeration-only rate on the same frames; the old value is kept as
`seconds_per_frame_exhaustive_total`).

    LUCID_ROOT=/root/vast/eric/lucid-main-md56 FIG3_VARIANT=md56 SCORE_NOTAIL=1 \
      $PY figs/fig3_samefr_runtime.py
"""
import json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fig3_headtohead as hh  # noqa: E402

OUT = HERE / "out"
SFX = hh.OUT_SUFFIX if hasattr(hh, "OUT_SUFFIX") else hh.SUFFIX   # includes HH_RUN_TAG
TMP = OUT / "tmp" / f"samefr_runtime{SFX}"
JOBS = int(os.environ.get("HH_JOBS", "16"))


def one(cfg, sess):
    d = hh.cell_dir(cfg, sess)
    # A configuration exhaustive cannot run (A4_C6, analytic only) has no frames to match:
    # greedy is then timed on the whole session, and the cell says so (frames_matched False).
    exh = json.loads((d / "exhaustive.json").read_text()) if (d / "exhaustive.json").exists() else None
    frames = [f["frame"] for f in exh["frames"]] if exh else None
    o = TMP / cfg["key"] / sess["session"]
    o.mkdir(parents=True, exist_ok=True)
    out = o / "greedy.json"
    cmd = ["node", str(hh.GREEDY_DRIVER), "--session-idx", str(sess["det_session_idx"]),
           "--num-animals", str(cfg["animals"]), "--calibration", str(sess["calibration"]),
           "--pred-h5-dir", sess["det_dir"], "--cameras", ",".join(cfg["cameras"]),
           "--out", str(out)]
    if frames is not None:
        (o / "frames.json").write_text(json.dumps(frames))
        cmd += ["--frame-list", str(o / "frames.json")]
    if sess["max_frames"]:
        cmd += ["--max-frames", str(sess["max_frames"])]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        return cfg["key"], sess["session"], None, r.stderr[-600:]
    g = json.loads(out.read_text())
    if frames is not None and g["framesProcessed"] != len(frames):
        return cfg["key"], sess["session"], None, f"greedy saw {g['framesProcessed']} of {len(frames)} frames"
    return cfg["key"], sess["session"], {
        "frames": g["framesProcessed"], "greedy_s": g["runtimeSeconds"], "frames_matched": frames is not None,
        "exh_enum_s": exh["enumerationSeconds"] if exh else None, "exh_total_s": exh["runtimeSeconds"] if exh else None,
        "exh_frames_computed": exh["framesComputed"] if exh else None}, None


def main():
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned v1.0.5 checkout")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    jobs = [(c, s) for c in hh.CONFIGS for s in hh.sessions_for(c)[0]]
    print(f"[samefr] {len(jobs)} (config, session) cells, {JOBS} jobs, LUC3D {commit[:8]}", flush=True)
    res, errs = {}, []
    with ProcessPoolExecutor(JOBS) as ex:
        futs = [ex.submit(one, c, s) for c, s in jobs]
        for i, f in enumerate(as_completed(futs), 1):
            k, s, r, e = f.result()
            if e:
                errs.append((k, s, e)); print(f"  FAILED {k}/{s}: {e}", flush=True)
            else:
                res.setdefault(k, {})[s] = r
            if i % 20 == 0:
                print(f"[samefr] {i}/{len(jobs)}", flush=True)
    if errs:
        sys.exit(f"[samefr] {len(errs)} cells failed; nothing written")

    h = json.loads((OUT / f"fig3_headtohead{SFX}.json").read_text())
    measured, sessions = [], set()
    for c in h["configs"]:
        cfg = next(x for x in hh.CONFIGS if x["key"] == c["key"])
        cells = res.get(c["key"], {})
        if not cells:
            continue
        nf = sum(v["frames"] for v in cells.values())
        g = sum(v["greedy_s"] for v in cells.values()) / nf
        matched = all(v["frames_matched"] for v in cells.values())
        e = sum(v["exh_enum_s"] for v in cells.values()) / nf if matched else None
        c["seconds_per_frame_exhaustive_total"] = c.get("seconds_per_frame_exhaustive")
        c["seconds_per_frame_exhaustive"] = e
        c["samefr_frames_matched"] = matched
        c["seconds_per_frame_greedy_samefr"] = g
        c["samefr_frames"] = nf
        c["samefr_sessions"] = len(cells)
        label = next(iter(cells))
        sessions.add(label)
        measured.append({"animals": cfg["animals"], "cameras": len(cfg["cameras"]),
                         "dataset": c.get("dataset"), "seconds_per_frame": g, "frames": nf,
                         "session": label, "n_sessions": len(cells),
                         "frames_matched": matched,
                         "exhaustive_seconds_per_frame": e, "ratio": (e / g) if e else None})
        print(f"  {c['key']:>16}: {len(cells)} sessions, {nf:,} frames  greedy {g*1e3:.4f} ms  "
              + (f"exhaustive {e*1e3:.3f} ms  ratio {e/g:,.1f}x" if e else "exhaustive not run (analytic)"), flush=True)
    note = ("Both arms on IDENTICAL frames: per (configuration, session) the frames the "
            "exhaustive run enumerated; solve time only (exhaustive enumerationSeconds, greedy "
            "runCrossViewTracker); frame-weighted; LUC3D " + commit + "; " + str(JOBS) + " parallel jobs.")
    h["samefr_note"] = note
    (OUT / f"fig3_headtohead_samefr{SFX}.json").write_text(json.dumps(h, indent=1))
    (OUT / f"fig3_runtime_samefr{SFX}.json").write_text(json.dumps(
        {"generated_by": "figs/fig3_samefr_runtime.py", "lucid_commit": commit, "note": note,
         "sessions": sorted(sessions), "measured": measured, "per_cell": res}, indent=1))
    print(f"[samefr] wrote fig3_runtime_samefr{SFX}.json and fig3_headtohead_samefr{SFX}.json")


if __name__ == "__main__":
    main()
