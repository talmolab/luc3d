#!/usr/bin/env bash
# Second half of the 2-track SLEAP re-run, plus the final gate and score.
#
# WHY A SECOND DRIVER. Driver 1 (12 workers, still running, reparented to init after its
# chain shell was killed) measured ~1,800 s per camera-session, i.e. ~9 h for the 209 it
# had left. Driver 2 takes the LAST 24 sessions of the sorted list -- driver 1's frontier
# was at index 10 when this was launched, so 16 sessions of headroom -- and the wall clock
# roughly halves.
#
# FIDELITY IS NOT TRADED FOR SPEED, and the two mechanisms that guarantee it:
#
#   1. Driver 2 runs the SAME script with the SAME flags, so its outputs are the same
#      computation, not an approximation of it.
#   2. It writes its OWN directory (`retracked_max2b/`) and the files are hard-linked
#      into `retracked_max2/` by the merge loop. `os.link` raises on an existing path
#      instead of clobbering, so no file can ever be written twice or half-written by
#      two processes -- which is the failure the earlier plan (one shared directory, two
#      drivers) could not rule out, because the resume check happens when a job STARTS.
#
# Then: wait for BOTH drivers -> final merge -> CAP GATE on all 250 -> score. The chain
# refuses to score if the cap does not hold, exactly as chain 1 did.
#
#   nohup bash figs/fig7_sleap_max2_chain2.sh > figs/out/tmp/sleap_max2_chain2.log 2>&1 &
set -u
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs || exit 1
SNN=/root/vast/eric/sleap_nn_030_env/bin/python
BENCH=/root/vast/eric/luc3d-bench/liezl_env/bin/python
MAX2=/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2
MAX2B=/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2b
TAIL=$(cat /tmp/tail24.txt)

merge() {
  $SNN - <<'PY'
import os, glob
A = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2"
B = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2b"
n = 0
for src in glob.glob(B + "/*/*.slp"):
    if os.path.getsize(src) < 1000:
        continue
    sid = os.path.basename(os.path.dirname(src))
    os.makedirs(f"{A}/{sid}", exist_ok=True)
    dst = f"{A}/{sid}/{os.path.basename(src)}"
    try:
        os.link(src, dst)          # raises FileExistsError rather than clobbering
        n += 1
    except FileExistsError:
        pass
if n:
    print(f"    merged {n} new file(s) into retracked_max2/", flush=True)
PY
}

echo "=== [$(date -u +%H:%M:%S)] driver 2: 24 tail sessions, 16 workers -> $MAX2B"
$SNN fig7_sleap_max2_retrack.py --workers 16 --out-dir "$MAX2B" --sessions "$TAIL" \
  > out/tmp/sleap_max2_driver2.log 2>&1 &
D2=$!

# Merge as files land so driver 1 SKIPS the tail instead of recomputing it.
while kill -0 $D2 2>/dev/null || pgrep -f "fig7_sleap_max2_retrack.py --workers 12" > /dev/null; do
  merge
  A=$(find "$MAX2" -name '*.slp' | wc -l); B=$(find "$MAX2B" -name '*.slp' 2>/dev/null | wc -l)
  echo "=== [$(date -u +%H:%M:%S)] max2 $A/250 (driver2 dir $B/120)"
  sleep 300
done
merge

echo "=== [$(date -u +%H:%M:%S)] both drivers done. Final merge + CAP GATE"
N=$(find "$MAX2" -name '*.slp' | wc -l)
echo "=== $N of 250 camera-sessions present"
$SNN fig7_sleap_max2_retrack.py --verify > out/tmp/sleap_max2_verify.log 2>&1 || {
  echo "!!! CAP GATE FAILED -- see out/tmp/sleap_max2_verify.log. NOT scoring."
  exit 3
}
tail -2 out/tmp/sleap_max2_verify.log

# DUPLICATE-WORK CHECK, AND IT IS FREE EVIDENCE. If both drivers happened to produce the
# same camera-session (driver 1 reaching a tail session before the merge did), the two
# files are the same computation and must be byte-identical. A difference would mean
# sleap-nn's tracking is not deterministic, which would undermine every comparison here.
$SNN - <<'PY'
import glob, os, hashlib
A = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2"
B = "/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2b"
def h(p):
    d = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            d.update(c)
    return d.hexdigest()
same = diff = linked = 0
for src in glob.glob(B + "/*/*.slp"):
    sid = os.path.basename(os.path.dirname(src))
    dst = f"{A}/{sid}/{os.path.basename(src)}"
    if not os.path.exists(dst):
        continue
    if os.path.samefile(src, dst):
        linked += 1
    elif h(src) == h(dst):
        same += 1
    else:
        diff += 1
        print(f"    !!! NOT IDENTICAL: {sid}/{os.path.basename(src)}")
print(f"    determinism check: {linked} hard-linked (same inode), {same} independently "
      f"computed and byte-identical, {diff} DIFFERENT")
PY

echo "=== [$(date -u +%H:%M:%S)] scoring"
$BENCH fig7_sleap_scoped.py --retracked "$MAX2" --out fig7_sleap_max2.json --workers 16
echo "=== [$(date -u +%H:%M:%S)] chain 2 done"
