#!/usr/bin/env bash
# Unattended chain for the ByteTrack half of Fig 7a's baseline-fairness fix.
#
#   never-retire tracking (eks_env: supervision) -> score 4 arms (liezl_env: motmetrics)
#
# The two stages need DIFFERENT interpreters -- `supervision` is only in eks_env and
# `motmetrics` only in liezl_env -- which is why this is a shell chain and not a flag.
#
# The scorer's own gate re-scores the SHIPPED arm and must reproduce
# outputs/bmimica/bmimica_crossview_all_eval.csv to 1e-9, so a scorer that drifted
# cannot report a new number. Verified on 20250829_141847 before this chain was
# launched: within and cross max |diff| both 0.000e+00.
#
#   nohup bash figs/fig7_bytetrack_max2_chain.sh > figs/out/tmp/byte_max2_chain.log 2>&1 &
set -u
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs || exit 1
SV=/root/vast/eric/luc3d-bench/eks_env/bin/python        # has supervision 0.30.0
MM=/root/vast/eric/luc3d-bench/liezl_env/bin/python      # has motmetrics
B1=/root/vast/eric/luc3d-bench/outputs/bmimica/results/bytetrack_noretire

echo "=== [$(date -u +%H:%M:%S)] never-retire tracking, 50 sessions x 5 cameras"
# 8 workers, not more: the sleap-nn re-run owns most of the box right now, and this
# stage is pure-CPU per camera-session over 180,200 frames.
$SV fig7_bytetrack_max2.py --stage track --workers 8 || {
  echo "!!! tracking stage reported failures -- see above"; }

N=$(find "$B1" -name '*.h5' | wc -l)
echo "=== [$(date -u +%H:%M:%S)] $N of 250 camera-sessions written"
if [ "$N" -lt 250 ]; then
  echo "!!! partial run. The scorer needs BOTH arms present per session and skips a"
  echo "!!! session that is missing either, so the deposit's n_sessions will say what"
  echo "!!! was actually compared -- do not read it as 50."
fi

echo "=== [$(date -u +%H:%M:%S)] scoring all four arms (B0, B0s, B1, B1s)"
$MM fig7_bytetrack_max2.py --stage score --workers 16 --arms B0,B0s,B1,B1s
echo "=== [$(date -u +%H:%M:%S)] chain done"
