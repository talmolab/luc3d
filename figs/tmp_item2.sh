#!/usr/bin/env bash
# Item 2: re-score both SLAP-2M pools with the CORRECTED misgrouped metric (optimal id
# permutation). Tracking is fully cached, so this is scoring only.
set -uo pipefail
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
for pool in keeptrack predictions; do
  echo "=== re-scoring pool=$pool with the fixed metric ==="
  FIG9_WORKERS=28 $PY figs/fig9_slap2m.py --pool "$pool" --workers 28
done
echo "=== done ==="
