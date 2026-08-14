#!/usr/bin/env bash
# Unattended chain for the 2-track SLEAP re-run of Fig 7a's baseline.
#
#   pilot (already running) -> VERIFY the cap -> full 50 sessions -> VERIFY -> SCORE
#
# IT REFUSES RATHER THAN CONTINUES. A `--max_tracks 2` run that silently failed to cap
# anything produces files of exactly the right shape with a plausible IDF1, so every
# stage gate here is "the cap held on every camera-session, or stop". Same reasoning as
# figs/fig8_finish*.sh: an unattended chain that carries on past a failed gate is worse
# than no chain, because it produces a number nobody knows is void.
#
#   nohup bash figs/fig7_sleap_max2_chain.sh > figs/out/tmp/sleap_max2_chain.log 2>&1 &
set -u
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs || exit 1
SNN=/root/vast/eric/sleap_nn_030_env/bin/python
BENCH=/root/vast/eric/luc3d-bench/liezl_env/bin/python
MAX2=/root/vast/eric/luc3d-bench/outputs/bmimica/retracked_max2
PILOT=20250827_141755
# 12 workers: each sleap-nn track process peaked at ~1.5 GB RSS and ~1.3 cores in the
# pilot, on a 64-core / 503 GB box that was already at load ~13. 12 leaves the box
# usable for the ByteTrack half and the figure re-renders.
WORKERS=12

echo "=== [$(date -u +%H:%M:%S)] waiting for the pilot to finish"
while pgrep -f "sleap_nn.cli track" > /dev/null; do sleep 60; done

echo "=== [$(date -u +%H:%M:%S)] pilot done; VERIFYING the cap on ${PILOT}"
$SNN fig7_sleap_max2_retrack.py --verify || {
  echo "!!! CAP GATE FAILED on the pilot. NOT launching the full run."
  echo "!!! --max_tracks 2 did not take: check that --candidates_method local_queues is"
  echo "!!! being passed (fixed_window silently ignores max_tracks) and that the"
  echo "!!! sleap-nn version still honours it. Nothing here is scoreable."
  exit 2
}

echo "=== [$(date -u +%H:%M:%S)] cap holds. Full run, all 50 sessions x 5 cameras"
$SNN fig7_sleap_max2_retrack.py --workers "$WORKERS" || {
  echo "!!! full run reported failures -- see above. Verifying what exists anyway."; }

echo "=== [$(date -u +%H:%M:%S)] VERIFYING the cap on every output"
$SNN fig7_sleap_max2_retrack.py --verify > /dev/null || {
  echo "!!! CAP GATE FAILED on the full run. NOT scoring."
  exit 3
}
N=$(find "$MAX2" -name '*.slp' | wc -l)
echo "=== [$(date -u +%H:%M:%S)] cap holds on all $N camera-sessions"
if [ "$N" -lt 250 ]; then
  echo "!!! only $N of 250 camera-sessions produced. Scoring the partial set, which is"
  echo "!!! NOT comparable to the 50-session baseline -- the deposit records n_sessions,"
  echo "!!! and any comparison must use the same sessions on both arms."
fi

echo "=== [$(date -u +%H:%M:%S)] scoring (camera-scoped AND unscoped, both deposited)"
$BENCH fig7_sleap_scoped.py --retracked "$MAX2" --out fig7_sleap_max2.json --workers 16
echo "=== [$(date -u +%H:%M:%S)] chain done"
