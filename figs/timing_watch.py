#!/usr/bin/env python3
"""Process watch for timing sittings (LUC3D-JS plan, 2026-10-20).

A timing number is only real if nothing else of ours ran while it was measured. Names
alone are not enough (the 2026-10-19 T1 gate missed a 40-worker job its marker list did
not name), so this reads /proc and measures CPU per process.

  timing_watch.py precheck --root <pid> [--seconds 30]
      Exit 1 if, over the window, any process outside <pid>'s tree used more than
      MAX_OUTSIDE_CORES in total, or any outside process looks like ours (BENCH).
  timing_watch.py watch --root <pid> --out <log.jsonl> [--interval 5]
      Until <pid> exits: every interval, one JSON line with the 1-min load and every
      outside process that used >= 2% of a core, then a summary line:
      {"summary": true, "max_outside_cores": .., "bench_seen": [..], "valid": bool}.

The host's load from OTHER containers is not visible as processes here; it is logged
from /proc/loadavg and deposited, not removable.
"""
import argparse
import json
import os
import sys
import time

HZ = os.sysconf("SC_CLK_TCK")
MAX_OUTSIDE_CORES = 0.5
#: Things of ours that must never run during a sitting.
BENCH = ("fig2_solvers", "fig2g_retime", "fig3_bench", "fig3_exhaustive", "fig6_bench",
         "fig3_", "fig4_", "fig6_", "fig7_", "fig10", "stale_", "r_sweep", "lucid_geom",
         "make_figures", "sleap", "bytetrack", "blender", "ffmpeg", "playwright",
         "chromium", "bfs", "find /", "run_J", "run_X7", "timed_b", "calib")
#: Allowed outside processes (Eric's editor, the idle static server).
ALLOW = (".vscode-server", "http.server")


def procs():
    out = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open(f"/proc/{p}/stat") as f:
                st = f.read()
            with open(f"/proc/{p}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
        except OSError:
            continue
        rp = st.rindex(")")
        fields = st[rp + 2:].split()
        ppid, ut, stt = int(fields[1]), int(fields[11]), int(fields[12])
        out[int(p)] = (ppid, ut + stt, cmd)
    return out


def tree(ps, root):
    keep, grew = {root}, True
    while grew:
        grew = False
        for pid, (ppid, _, _) in ps.items():
            if ppid in keep and pid not in keep:
                keep.add(pid); grew = True
    return keep


def ancestors(ps, pid):
    """The launching shells above `pid` (they carry the sitting's own script name)."""
    up = set()
    while pid in ps and ps[pid][0] > 1:
        pid = ps[pid][0]; up.add(pid)
    return up


def sample(root, seconds, me):
    a = procs(); time.sleep(seconds); b = procs()
    ours = tree(b, root) | tree(b, me) | {me} | ancestors(b, root) | ancestors(b, me)
    rows, total = [], 0.0
    for pid, (ppid, t1, cmd) in b.items():
        if pid in ours or pid not in a:
            continue
        cores = (t1 - a[pid][1]) / HZ / seconds
        total += cores
        if cores >= 0.02 or any(m in cmd for m in BENCH):
            rows.append(dict(pid=pid, cores=round(cores, 3), cmd=cmd[:160]))
    bench = [r for r in rows if any(m in r["cmd"] for m in BENCH)
             and not any(a_ in r["cmd"] for a_ in ALLOW)]
    return rows, total, bench


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["precheck", "watch"])
    ap.add_argument("--root", type=int, required=True)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--interval", type=float, default=5)
    ap.add_argument("--out")
    a = ap.parse_args()
    me = os.getpid()
    if a.mode == "precheck":
        rows, total, bench = sample(a.root, a.seconds, me)
        print(json.dumps(dict(outside_cores=round(total, 3), load=open("/proc/loadavg").read().split()[:3],
                              busy=rows, bench=bench)))
        sys.exit(1 if bench or total > MAX_OUTSIDE_CORES else 0)
    mx, seen = 0.0, {}
    with open(a.out, "w") as fh:
        while os.path.exists(f"/proc/{a.root}"):
            rows, total, bench = sample(a.root, a.interval, me)
            mx = max(mx, total)
            for r in bench:
                seen[r["cmd"]] = r
            fh.write(json.dumps(dict(t=time.strftime("%H:%M:%S", time.gmtime()),
                                     load1=float(open("/proc/loadavg").read().split()[0]),
                                     outside_cores=round(total, 3), busy=rows)) + "\n")
            fh.flush()
        valid = not seen and mx <= MAX_OUTSIDE_CORES
        fh.write(json.dumps(dict(summary=True, max_outside_cores=round(mx, 3),
                                 bench_seen=list(seen.values()), valid=valid)) + "\n")


if __name__ == "__main__":
    main()
