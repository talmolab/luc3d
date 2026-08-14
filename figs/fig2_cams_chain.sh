#!/usr/bin/env bash
# track (node) -> score (liezl_env: motmetrics), gated on k5 reproducing the deposit.
set -u
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs || exit 1
echo "=== [$(date -u +%H:%M:%S)] camera-subset tracking"
python3 fig2_cams_identity.py --stage track --workers 12 || echo "!!! track stage failures above"
echo "=== [$(date -u +%H:%M:%S)] scoring + gate"
/root/vast/eric/luc3d-bench/liezl_env/bin/python fig2_cams_identity.py --stage score --workers 16
echo "=== [$(date -u +%H:%M:%S)] done"
