#!/usr/bin/env bash
# Waits for tmp_corr12.sh to finish BOTH SLAP-2M pools, then re-renders Fig 9 so its
# keeptrack deposit carries the corr3dWeight-12 cell the predictions pool already has.
# Polls a log rather than holding a pipe, so it survives the parent going away.
set -uo pipefail
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid
LOG=figs/out/tmp/corr12_run.log
for _ in $(seq 1 720); do                      # 720 x 60 s = 12 h ceiling
    grep -q '^=== done ===' "$LOG" && break
    pgrep -f tmp_corr12.sh > /dev/null || { echo "[wait] corr12 job GONE without '=== done ==='"; break; }
    sleep 60
done
if ! grep -q '^=== done ===' "$LOG"; then
    echo "[wait] REFUSING to re-render: corr12 never completed. Fig 9 keeps its current, valid 2-cell state."
    exit 1
fi
echo "[wait] corr12 finished; re-rendering Fig 9"
PY=figs/.venv/bin/python
for p in fig9_01_idf1_survival fig9_02_rates fig9_03_strata; do
    echo "--- $p"; $PY "figs/panels/$p.py" || echo "FAILED: $p"
done
$PY figs/assemble.py 9 || echo "FAILED: assemble 9"
$PY figs/lint_text.py | tail -3
echo "=== fig9 re-render done ==="
