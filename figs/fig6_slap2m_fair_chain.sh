#!/usr/bin/env bash
# Overnight chain for the SLAP-2M fair re-run: SLEAP (resumable) -> cap verify -> score.
set -uo pipefail
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
B=/root/vast/eric/luc3d-bench
LOG=$B/logs
# 1. SLEAP: wait for a running driver, then re-invoke once to retry any failures (resume skips done files)
while pgrep -f "fig6_slap2m_fair.py --stage sleap" > /dev/null; do sleep 60; done
echo "[chain] $(date) sleap pass 1 finished; retry pass"
$B/sleap_nn_env/bin/python figs/fig6_slap2m_fair.py --stage sleap --workers 48 > $LOG/slap2m_fair_sleap_retry.log 2>&1
n=$(find $B/outputs/slap2m_fair/sleap_cap -name '*.slp' ! -name '*.partial.slp' | wc -l)
echo "[chain] $(date) sleap outputs: $n / 444"
# 2. ByteTrack: fills any gap (all 444 already exist -> all skip)
$B/eks_env/bin/python figs/fig6_slap2m_fair.py --stage bytetrack --workers 32 > $LOG/slap2m_fair_byte.log 2>&1
# 3. Verify the SLEAP cap took on every file
$B/eks_env/bin/python figs/fig6_slap2m_fair.py --stage verify > $LOG/slap2m_fair_verify.log 2>&1
v=$?; cat $LOG/slap2m_fair_verify.log
if [ $v -ne 0 ] || [ "$n" -ne 444 ]; then echo "[chain] REFUSING to score (verify=$v, n=$n)"; exit 2; fi
# 4. Score all three arms
$B/liezl_env/bin/python figs/fig6_slap2m_fair.py --stage score --workers 48 > $LOG/slap2m_fair_score.log 2>&1
tail -30 $LOG/slap2m_fair_score.log
echo "[chain] $(date) DONE"
