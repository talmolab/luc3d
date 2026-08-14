#!/usr/bin/env bash
# Render the new Fig 8 the moment the precision/recall re-score lands. Unattended.
set -uo pipefail
REPO=/root/vast/eric/sleap-3d-gui/scratch/repos/lucid
BENCH_PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
PLOT_PY="$REPO/figs/.venv/bin/python"
OUT="$REPO/figs/out"; LOG="$OUT/tmp/fig8m_all50_pr.log"
cd "$REPO" || exit 1
say() { echo "[prfinish $(date -u +%H:%M:%S)] $*"; }
say "waiting for the 5-config precision/recall re-score (250 scorings)"
w=0
while ! grep -q "^\[fig8m\] wrote" "$LOG" 2>/dev/null; do
    pgrep -f "all-sessions --configs shipped,sync_stale1" >/dev/null || { say "pass gone, no deposit -- stop"; exit 1; }
    sleep 90; w=$((w+90)); [ "$w" -ge 21600 ] && { say "6h -- stop"; exit 1; }
done
say "re-score complete"
say "rendering 8d (precision/recall + IDF1 + switch rate) and 8e"
"$PLOT_PY" figs/panels/fig8_07_pr_switches.py 2>&1 | grep -E "wrote|deposited|rror|RE-SCORED"
"$PLOT_PY" figs/panels/fig8_05_all50.py 2>&1 | grep -E "wrote|deposited|rror"
say "rebuilding the Fig 7 variant with the fresh-anchor arm"
"$BENCH_PY" figs/fig7_variant_tracker.py 2>&1 | tail -4
"$PLOT_PY" figs/panels/fig7_05_within_vs_cross.py --variant 2>&1 | grep -E "wrote|deposited|rror"
say "linting and assembling"
"$PLOT_PY" figs/lint_text.py 2>&1 | tail -2
"$PLOT_PY" figs/assemble.py 8 2>&1 | tail -2
"$PLOT_PY" figs/assemble.py 7 2>&1 | tail -2
{
  echo "FIG 8 + FIG 7 — $(date -u '+%Y-%m-%d %H:%M UTC')"; echo
  "$BENCH_PY" figs/fig8_report50.py 2>&1
  echo; echo "=== per-config, 50 sessions ==="
  grep -E "switches=" "$LOG" | sed 's/.*\[fig8m\] //' | sort
} > "$OUT/FIG8-FINAL-50.txt" 2>&1
say "wrote $OUT/FIG8-FINAL-50.txt"; say done
