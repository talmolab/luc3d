#!/usr/bin/env python
"""Fig 3F, clean timing sitting (2026-10-19, CONSISTENCY-PLAN T1).

Greedy (LUC3D v1.0.5) and exhaustive timed on IDENTICAL frames, ONE process at a time,
interleaved, in rounds. Replaces the earlier comparison, which timed exhaustive at
16 parallel jobs (load 4.7-17) against a single-process LUC3D on different frames.

Per (configuration, session):
  frames  K frames drawn uniformly (fixed seed) from the frames the FIG3_VARIANT
          exhaustive cache enumerated -- so every one is eligible -- and passed to BOTH
          drivers as --frame-list. Both must report exactly K frames.
  tail    as the variant's head-to-head (b3: Mouse-Dyad tail IN for both arms, SLAP-2M
          tail-free for both).
  scope   solve time only: exhaustive `enumerationSeconds` (eligibility scan excluded),
          greedy `runtimeSeconds` (runCrossViewTracker only).
  order   greedy/exhaustive alternate per session; the order flips every round.
Rate per cell and round = sum(seconds) / sum(frames); the deposit reports the median over
rounds and the spread. /proc/loadavg is recorded around every call. A4_C6 has no
exhaustive run (analytic); the per-hypothesis rate of every measured cell is reported
for its extrapolation.

Refuses to start if any other bench/tracking process is running.

    LUCID_ROOT=/root/vast/eric/lucid-main-md56 FIG3_VARIANT=b3 SCORE_NOTAIL=1 \\
      PATH=/root/vast/eric/node26_env/bin:$PATH $PY figs/fig3f_timing_clean.py

`T_A4C6=1` (2026-10-20): GREEDY-ONLY sitting for A4_C6, which has no exhaustive run. Its
K frames are drawn the same way from the frames eligible at 4x6 (every camera holds exactly
4 detections), found by the exhaustive driver's `--eligible-only` scan (untimed, nothing
enumerated). Writes figs/out/fig3_runtime_clean<_variant>_a4c6.json only.

Writes (new files only) figs/out/fig3_runtime_clean<_variant>.json,
figs/out/fig3_headtohead_clean<_variant>.json and a per-call log
figs/out/tmp/timing_clean<_variant>/calls.jsonl.
"""
import json
import math
import os
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fig3_headtohead as hh  # noqa: E402

OUT = HERE / "out"
#: T_TAG=<tag> (2026-10-20, J17): a fresh sitting written under its own names
#: (tmp/timing_clean<_variant><tag>/, fig3_*_clean<_variant><tag>*.json); nothing earlier
#: is overwritten. Frames are drawn by the same seeded rule, so they are identical.
TAG = os.environ.get("T_TAG", "")
SFX = hh.SUFFIX
TMP = OUT / "tmp" / f"timing_clean{SFX}{TAG}"
ROUNDS = int(os.environ.get("T_ROUNDS", "3"))
#: frames per session: cheap cells get more, A>=3 cells (seconds per frame) fewer
K = {"A2_C5_bmimica": 1000, "A2_C6_slap2m": 1000, "A3_C5_slap2m": 100, "A4_C3_slap2m": 100}
SEED = 20261019
#: `T_SMOKE=1`: one session per cell, K=20, one round -- a check that the wiring works
SMOKE = os.environ.get("T_SMOKE") == "1"
BENCH_MARKERS = ("fig3_bench", "fig3_exhaustive", "fig6_bench", "sleap-nn", "sleap_nn",
                 "fig6_slap2m_fair", "bytetrack", "evaluate.py", "fig3_headtohead",
                 "stale_sweep", "r_sweep",
                 # 2026-10-19: the frame-matched sweep rescoring (40 workers) ran unnoticed
                 # through the first T1 sitting because none of the markers above matched it
                 "fig3_sweep", "framematched", "frame_matched", "fig3_scale", "fig3_trackers",
                 "fig2g_retime", "timed_b.py", "run_all_b")


def others_running():
    """Bench/tracking processes other than this one and its ancestors (read from /proc,
    not pgrep -f, which would match the shell that launched us)."""
    mine, p = {os.getpid()}, os.getppid()
    while p > 1:
        mine.add(p)
        try:
            p = int(open(f"/proc/{p}/stat").read().split(")")[1].split()[1])
        except Exception:
            break
    hits = []
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) in mine:
            continue
        try:
            cmd = open(f"/proc/{d}/cmdline", "rb").read().replace(b"\0", b" ").decode()
        except Exception:
            continue
        if any(m in cmd for m in BENCH_MARKERS) and "fig3f_timing_clean" not in cmd:
            hits.append((d, cmd[:120]))
    return hits


def _my_tree():
    mine, p = {os.getpid()}, os.getppid()
    while p > 1:
        mine.add(p)
        try:
            p = int(open(f"/proc/{p}/stat").read().split(")")[1].split()[1])
        except Exception:
            break
    return mine


def _cpu_ticks():
    out = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                f = open(f"/proc/{d}/stat").read().split(")")[1].split()
                out[int(d)] = int(f[11]) + int(f[12])     # utime + stime
            except Exception:
                pass
    return out


#: 2026-10-20: the marker list above only knows OUR bench scripts. Anything else in this
#: container (an audit's grep, a build, a render) also competes for the CPU, so every
#: process outside this sitting's own tree is now MEASURED: cores it used over `secs`.
#: Load from outside the container is not visible here and stays in the loadavg record.
MAX_OTHER_CORES = float(os.environ.get("T_MAX_OTHER_CORES", "1.0"))


def other_cores(secs=2.0):
    a = _cpu_ticks()
    time.sleep(secs)
    b = _cpu_ticks()
    mine = _my_tree()
    hz = os.sysconf("SC_CLK_TCK")
    return sum(b[p] - a.get(p, b[p]) for p in b if p not in mine) / hz / secs


#: T_QUIET_WAIT seconds (default 1800): a busy container is WAITED out, never timed through.
QUIET_WAIT = float(os.environ.get("T_QUIET_WAIT", "1800"))


def require_quiet(where):
    t0 = time.time()
    while True:
        busy = others_running()
        oc = None if busy else other_cores()
        if not busy and oc <= MAX_OTHER_CORES:
            return oc
        if time.time() - t0 > QUIET_WAIT:
            raise SystemExit(f"[timing] {where}: not quiet for {QUIET_WAIT:.0f} s "
                             f"(bench {busy[:3]}, other cores {oc}) -- refusing to time")
        print(f"[timing] {where}: waiting for quiet (bench {busy[:1]}, other cores {oc})", flush=True)
        time.sleep(10)


def load():
    return [float(x) for x in open("/proc/loadavg").read().split()[:3]]


def frames_for(cfg, sess, k):
    exh = json.loads((hh.cell_dir(cfg, sess) / "exhaustive.json").read_text())
    pool = sorted(f["frame"] for f in exh["frames"])
    if len(pool) <= k:
        return pool
    rng = np.random.default_rng(SEED + sum(map(ord, cfg["key"] + sess["session"])))
    return sorted(int(x) for x in rng.choice(pool, size=k, replace=False))


def eligible_frames(cfg, sess, d):
    """Frames where every camera of `cfg` holds exactly A detections (exhaustive Pass A)."""
    out = d / "eligible.json"
    if not out.exists():
        cmd = ["node", str(hh.EXH_DRIVER), "--session-idx", str(sess["det_session_idx"]),
               "--num-animals", str(cfg["animals"]), "--calibration", str(sess["calibration"]),
               "--pred-h5-dir", sess["det_dir"], "--cameras", ",".join(cfg["cameras"]),
               "--out", str(out), "--eligible-only"]
        if sess["max_frames"]:
            cmd += ["--max-frames", str(sess["max_frames"])]
        run(cmd)
    return json.loads(out.read_text())["eligibleFrames"]


def run(cmd):
    l0, t0 = load(), time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=86400)
    if r.returncode != 0:
        raise SystemExit(f"[timing] FAILED: {' '.join(cmd)}\n{r.stderr[-800:]}")
    return l0, load(), time.time() - t0


def main():
    if not os.environ.get("LUCID_ROOT"):
        sys.exit("set LUCID_ROOT to the pinned v1.0.5 checkout")
    commit = subprocess.run(["git", "-C", os.environ["LUCID_ROOT"], "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    if not commit.startswith("2dc001fe"):
        sys.exit(f"LUCID_ROOT is at {commit[:8]}, not v1.0.5 (2dc001fe)")
    print(f"[timing] container quiet: other processes {require_quiet('start'):.2f} cores", flush=True)
    TMP.mkdir(parents=True, exist_ok=True)
    if os.environ.get("T_A4C6") == "1":
        return main_a4c6(commit)
    log = (TMP / ("calls_smoke.jsonl" if SMOKE else "calls.jsonl")).open("a")

    cells = []
    for cfg in hh.CONFIGS:
        if cfg["key"] not in K:
            continue
        sessions = hh.sessions_for(cfg)[0]
        if SMOKE:
            sessions = sessions[:1]
        for sess in sessions:
            k = 20 if SMOKE else K[cfg["key"]]
            fr = frames_for(cfg, sess, k)
            fl = TMP / cfg["key"] / sess["session"] / "frames.json"
            fl.parent.mkdir(parents=True, exist_ok=True)
            fl.write_text(json.dumps(fr))
            cells.append((cfg, sess, fr, fl))
    print(f"[timing] {len(cells)} (config, session) cells, {ROUNDS if not SMOKE else 1} "
          f"round(s), LUC3D {commit[:8]}, load {load()}", flush=True)

    rounds = 1 if SMOKE else ROUNDS
    res = {}   # (key, session) -> list of {round, greedy_s, exh_s, frames, loads}
    #: T_RESUME=1 (J17): calls already in calls.jsonl (each passed the quiet gate when it
    #: was timed) are kept and not re-timed; the interleaving and order rule are unchanged.
    done = set()
    if os.environ.get("T_RESUME") == "1" and not SMOKE:
        for line in open(TMP / "calls.jsonl"):
            r = json.loads(line)
            done.add((r["round"], r["config"], r["session"]))
            res.setdefault((r["config"], r["session"]), []).append(r)
        print(f"[timing] resume: {len(done)} calls kept from calls.jsonl", flush=True)
    for rd in range(rounds):
        for i, (cfg, sess, fr, fl) in enumerate(cells):
            if (rd, cfg["key"], sess["session"]) in done:
                continue
            oc = require_quiet(f"round {rd} cell {i}")
            d = TMP / cfg["key"] / sess["session"]
            base = ["--session-idx", str(sess["det_session_idx"]),
                    "--num-animals", str(cfg["animals"]),
                    "--calibration", str(sess["calibration"]),
                    "--pred-h5-dir", sess["det_dir"],
                    "--cameras", ",".join(cfg["cameras"]),
                    "--frame-list", str(fl)]
            if sess["max_frames"]:
                base += ["--max-frames", str(sess["max_frames"])]
            g_out, e_out = d / f"greedy_r{rd}.json", d / f"exhaustive_r{rd}.json"
            g_cmd = (["node", str(hh.GREEDY_DRIVER)] + base + ["--out", str(g_out)]
                     + (["--no-exclude-tail"] if hh.tail_in_tracking(cfg) else []))
            e_cmd = (["node", str(hh.EXH_DRIVER)] + base +
                     ["--out", str(e_out), "--max-hypotheses", str(hh.MAX_HYPOTHESES)]
                     + (["--exclude-tail"] if hh.EXH_EXCLUDE_TAIL and not hh.tail_in_tracking(cfg) else []))
            order = [("greedy", g_cmd), ("exhaustive", e_cmd)]
            if (rd + i) % 2:
                order.reverse()
            rec = {"round": rd, "config": cfg["key"], "session": sess["session"],
                   "frames_listed": len(fr), "order": [o for o, _ in order],
                   "other_cores_before": oc}
            for name, cmd in order:
                l0, l1, wall = run(cmd)
                rec[f"{name}_load_before"], rec[f"{name}_load_after"] = l0, l1
                rec[f"{name}_wall_s"] = wall
            g = json.loads(g_out.read_text())
            e = json.loads(e_out.read_text())
            if g["framesProcessed"] != len(fr) or e["framesComputed"] != len(fr):
                raise SystemExit(f"[timing] frame mismatch {cfg['key']}/{sess['session']}: "
                                 f"listed {len(fr)}, greedy {g['framesProcessed']}, "
                                 f"exhaustive {e['framesComputed']}")
            if hh.tail_in_tracking(cfg) and (g.get("excludeTail") is not False or e.get("excludeTail")):
                raise SystemExit(f"[timing] tail flags wrong for {cfg['key']} (tail must be IN)")
            if not hh.tail_in_tracking(cfg) and (g.get("excludeTail") is False or not e.get("excludeTail")):
                raise SystemExit(f"[timing] tail flags wrong for {cfg['key']} (tail must be OUT)")
            rec.update(greedy_s=g["runtimeSeconds"], exh_s=e["enumerationSeconds"],
                       frames=len(fr), hypotheses_per_frame=e["hypothesesPerFrame"],
                       greedy_exclude_tail=g.get("excludeTail"), exh_exclude_tail=e.get("excludeTail"))
            log.write(json.dumps(rec) + "\n")
            log.flush()
            res.setdefault((cfg["key"], sess["session"]), []).append(rec)
            if i % 10 == 0:
                print(f"[timing] round {rd} {i + 1}/{len(cells)} load {load()}", flush=True)
    if SMOKE:
        print("[timing] smoke OK:", json.dumps(list(res.values())[0][0])[:400])
        return

    h = json.loads((OUT / f"fig3_headtohead{SFX}.json").read_text())
    measured, all_loads = [], []
    for c in h["configs"]:
        key = c["key"]
        recs = [r for (k, _s), v in res.items() if k == key for r in v]
        if not recs:
            continue
        per_round = []
        for rd in range(rounds):
            rr = [r for r in recs if r["round"] == rd]
            nf = sum(r["frames"] for r in rr)
            per_round.append({"round": rd, "frames": nf,
                              "greedy_spf": sum(r["greedy_s"] for r in rr) / nf,
                              "exh_spf": sum(r["exh_s"] for r in rr) / nf})
        g = st.median(p["greedy_spf"] for p in per_round)
        e = st.median(p["exh_spf"] for p in per_round)
        hyp = recs[0]["hypotheses_per_frame"]
        for r in recs:
            all_loads += [r["greedy_load_before"][0], r["exhaustive_load_before"][0]]
        n_sess = len({r["session"] for r in recs})
        c["seconds_per_frame_exhaustive_previous"] = c.get("seconds_per_frame_exhaustive")
        c["seconds_per_frame_exhaustive"] = e
        c["seconds_per_frame_greedy_clean"] = g
        c["clean_frames_per_round"] = per_round[0]["frames"]
        c["clean_sessions"] = n_sess
        measured.append({"key": key, "animals": next(x for x in hh.CONFIGS if x["key"] == key)["animals"],
                         "cameras": len(next(x for x in hh.CONFIGS if x["key"] == key)["cameras"]),
                         "dataset": c.get("dataset"), "n_sessions": n_sess,
                         "frames_per_round": per_round[0]["frames"],
                         "seconds_per_frame": g, "exhaustive_seconds_per_frame": e,
                         "ratio": e / g, "hypotheses_per_frame": hyp,
                         "exhaustive_seconds_per_hypothesis": e / hyp,
                         "rounds": per_round, "frames_matched": True})
        sp_g = (max(p["greedy_spf"] for p in per_round) / min(p["greedy_spf"] for p in per_round) - 1) * 100
        sp_e = (max(p["exh_spf"] for p in per_round) / min(p["exh_spf"] for p in per_round) - 1) * 100
        print(f"  {key:>16}: {n_sess} sessions x {per_round[0]['frames']:,} frames  greedy "
              f"{g * 1e3:.4f} ms (spread {sp_g:.1f}%)  exhaustive {e * 1e3:.3f} ms "
              f"(spread {sp_e:.1f}%)  ratio {e / g:,.1f}x", flush=True)
    note = ("Clean sitting (CONSISTENCY-PLAN T1): both arms on IDENTICAL frames per "
            "(configuration, session), one process at a time, interleaved, order flipped "
            f"each round, {rounds} rounds, median over rounds; solve time only "
            "(exhaustive enumerationSeconds, greedy runCrossViewTracker); LUC3D "
            f"{commit}; host 1-min load at call start median {st.median(all_loads):.1f}, "
            f"max {max(all_loads):.1f} (includes load from outside this container).")
    h["clean_timing_note"] = note
    (OUT / f"fig3_headtohead_clean{SFX}{TAG}.json").write_text(json.dumps(h, indent=1))
    (OUT / f"fig3_runtime_clean{SFX}{TAG}.json").write_text(json.dumps(
        {"generated_by": "figs/fig3f_timing_clean.py", "lucid_commit": commit, "note": note,
         "variant": hh.VARIANT, "seed": SEED, "k": K, "measured": measured}, indent=1))
    print(f"[timing] wrote fig3_runtime_clean{SFX}{TAG}.json and fig3_headtohead_clean{SFX}{TAG}.json")


def main_a4c6(commit, k=100):
    """Greedy-only clean timing at 4 animals x 6 cameras (the analytic exhaustive cell)."""
    cfg = next(c for c in hh.CONFIGS if c["key"] == "A4_C6_slap2m_hard")
    assert not hh.tail_in_tracking(cfg)   # SLAP-2M: tail-free
    log = (TMP / "calls_a4c6.jsonl").open("a")
    cells = []
    for sess in hh.sessions_for(cfg)[0]:
        d = TMP / cfg["key"] / sess["session"]
        d.mkdir(parents=True, exist_ok=True)
        pool = eligible_frames(cfg, sess, d)
        rng = np.random.default_rng(SEED + sum(map(ord, cfg["key"] + sess["session"])))
        fr = pool if len(pool) <= k else sorted(int(x) for x in rng.choice(pool, size=k, replace=False))
        fl = d / "frames.json"
        fl.write_text(json.dumps(fr))
        cells.append((sess, fr, fl, len(pool)))
        print(f"[a4c6] {sess['session']}: {len(pool):,} eligible, timing {len(fr)}", flush=True)
    per_round, loads = [], []
    for rd in range(ROUNDS):
        tot_s = tot_f = 0
        for sess, fr, fl, _ in cells:
            oc = require_quiet(f"a4c6 round {rd}")
            out = TMP / cfg["key"] / sess["session"] / f"greedy_r{rd}.json"
            cmd = ["node", str(hh.GREEDY_DRIVER), "--session-idx", str(sess["det_session_idx"]),
                   "--num-animals", str(cfg["animals"]), "--calibration", str(sess["calibration"]),
                   "--pred-h5-dir", sess["det_dir"], "--cameras", ",".join(cfg["cameras"]),
                   "--frame-list", str(fl), "--out", str(out)]
            if sess["max_frames"]:
                cmd += ["--max-frames", str(sess["max_frames"])]
            l0, l1, wall = run(cmd)
            g = json.loads(out.read_text())
            if g["framesProcessed"] != len(fr):
                raise SystemExit(f"[a4c6] frame mismatch {sess['session']}: listed {len(fr)}, "
                                 f"greedy {g['framesProcessed']}")
            if g.get("excludeTail") is False:
                raise SystemExit(f"[a4c6] tail must be OUT for SLAP-2M ({sess['session']})")
            rec = {"round": rd, "session": sess["session"], "frames": len(fr),
                   "greedy_s": g["runtimeSeconds"], "load_before": l0, "load_after": l1,
                   "other_cores_before": oc,
                   "wall_s": wall}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            loads.append(l0[0])
            tot_s += g["runtimeSeconds"]
            tot_f += len(fr)
        per_round.append({"round": rd, "frames": tot_f, "greedy_spf": tot_s / tot_f})
        print(f"[a4c6] round {rd}: {tot_s / tot_f * 1e3:.4f} ms/frame, load {load()}", flush=True)
    g = st.median(p["greedy_spf"] for p in per_round)
    note = ("Clean greedy-only sitting for A4_C6 (no exhaustive run exists at 4x6): K frames "
            "per session drawn (fixed seed) from the frames eligible at 4x6, one process at a "
            f"time, {ROUNDS} rounds, median over rounds; solve time only (runCrossViewTracker); "
            f"LUC3D {commit}; host 1-min load at call start median {st.median(loads):.1f}, "
            f"max {max(loads):.1f} (includes load from outside this container).")
    (OUT / f"fig3_runtime_clean{SFX}{TAG}_a4c6.json").write_text(json.dumps(
        {"generated_by": "figs/fig3f_timing_clean.py (T_A4C6=1)", "lucid_commit": commit,
         "note": note, "variant": hh.VARIANT, "seed": SEED, "k": k,
         "measured": [{"key": cfg["key"], "animals": cfg["animals"],
                       "cameras": len(cfg["cameras"]), "dataset": cfg["dataset"],
                       "n_sessions": len(cells),
                       "eligible_frames": {s["session"]: n for s, _, _, n in cells},
                       "frames_per_round": per_round[0]["frames"],
                       "seconds_per_frame": g, "rounds": per_round}]}, indent=1))
    print(f"[a4c6] greedy {g * 1e3:.4f} ms/frame -> fig3_runtime_clean{SFX}{TAG}_a4c6.json")


if __name__ == "__main__":
    main()
