#!/usr/bin/env bash
# Render the 50-session methods panel (8f) the moment the full 8d-at-50 pass finishes.
#
# The pass is 36 configs x 50 sessions = 1,800 tracker runs + 1,800 motmetrics scorings.
# This waits for its deposit, then renders 8f, re-renders 8e (whose 4 configs live in the
# same deposit), re-runs the report, lints, re-assembles Fig 8 and refreshes the summary.
#
#   nohup setsid bash figs/fig8_finish50.sh > figs/out/tmp/fig8_finish50.log 2>&1 &
set -uo pipefail
REPO=/root/vast/eric/sleap-3d-gui/scratch/repos/lucid
BENCH_PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
PLOT_PY="$REPO/figs/.venv/bin/python"
OUT="$REPO/figs/out"
LOG="$OUT/tmp/fig8m_all50_top.log"
cd "$REPO" || exit 1
say() { echo "[finish50 $(date -u +%H:%M:%S)] $*"; }

say "waiting for the 36-config 50-session pass (1800 track + 1800 score)"
waited=0
while ! grep -q "^\[fig8m\] wrote" "$LOG" 2>/dev/null; do
    if ! pgrep -f "all-sessions --configs sync_stale30" >/dev/null; then
        say "the pass is no longer running and wrote no deposit -- stopping"; exit 1
    fi
    sleep 120; waited=$((waited + 120))
    if [ "$waited" -ge 43200 ]; then say "12 h elapsed -- stopping"; exit 1; fi
done
say "pass complete after ${waited}s of waiting"

say "rendering 8f (methods, all 50 sessions)"
"$PLOT_PY" figs/panels/fig8_04_methods.py --all50 2>&1 | grep -E "wrote|deposited|rror"
say "re-rendering 8e (same deposit, its 4 configs)"
"$PLOT_PY" figs/panels/fig8_05_all50.py 2>&1 | grep -E "wrote|deposited|rror"
say "linting and assembling"
"$PLOT_PY" figs/lint_text.py 2>&1 | tail -2
"$PLOT_PY" figs/assemble.py 8 2>&1 | tail -2

say "writing the 50-session methods report"
{
    echo "FIG 8D AT 50 SESSIONS — $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo
    "$BENCH_PY" figs/fig8_report50.py 2>&1
    echo
    echo "================ EVERY CONFIG, 50 SESSIONS ================"
    grep -E "switches=" "$LOG" | sed 's/.*\[fig8m\] //' | sort
} > "$OUT/FIG8D-50-SESSIONS.txt" 2>&1
say "wrote $OUT/FIG8D-50-SESSIONS.txt"
say "done"
