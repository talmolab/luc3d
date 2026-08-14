#!/usr/bin/env bash
# Run the NEW best configuration -- fresh anchor AT corr3dWeight 12, which Fig 3g found
# beats the shipped 6 once the anchor is no longer stale -- on both corpora, through the
# same harnesses as every other cell so the numbers are directly comparable.
#
# Queued sequentially and at modest worker counts on purpose: two other heavy passes are
# already running and starving them would delay the plan's items 1 and 2.
set -uo pipefail
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
echo "=== BMimica, all 50 sessions ==="
FIG8M_WORKERS=16 $PY figs/fig8_methods.py --all-sessions \
  --configs sync_stale20_dist25_corr12
echo "=== SLAP-2M, keeptrack pool (Fig 9) ==="
FIG9_WORKERS=16 $PY figs/fig9_slap2m.py --pool keeptrack --workers 16 \
  --configs shipped,sync_stale20_dist25,sync_stale20_dist25_corr12
echo "=== SLAP-2M, predictions pool (Fig 7's pool) ==="
FIG9_WORKERS=16 $PY figs/fig9_slap2m.py --pool predictions --workers 16 \
  --configs shipped,sync_stale20_dist25,sync_stale20_dist25_corr12
echo "=== done ==="
