#!/usr/bin/env bash
# After fig6_slap2m_fair_chain.sh: install the fair block, re-render Supp. Fig 6 B-D, sync, assemble.
set -uo pipefail
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
LOG=/root/vast/eric/luc3d-bench/logs
while pgrep -f "fig6_slap2m_fair_chain.sh" > /dev/null; do sleep 60; done
grep -q "\[chain\].*DONE" $LOG/slap2m_fair_chain.log || { echo "[figs] chain did not finish cleanly; not installing"; exit 2; }
/root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig6_slap2m_fair.py --stage install || exit 3
for p in fig6_01_survival fig6_02_by_animals fig6_03_error_decomposition; do
  figs/.venv/bin/python figs/panels/$p.py || { echo "[figs] $p FAILED"; exit 4; }
done
figs/.venv/bin/python figs/fig6_sync.py && figs/.venv/bin/python figs/assemble.py 6
echo "[figs] $(date) DONE"
