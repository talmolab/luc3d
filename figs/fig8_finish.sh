#!/usr/bin/env bash
# Post-process the Fig 8 measurement passes the moment they finish, unattended.
#
# WHY THIS EXISTS. The measurement passes are nohup'd and reparented to init, so they
# survive a disconnect on their own. What does NOT survive is the analysis: re-aggregating
# the deposit, printing the 50-session report, rendering the panels and re-assembling the
# figure all needed a person (or an agent) still sitting there. This chains them, so the
# work is DONE rather than merely finished when someone comes back.
#
# Everything it does is idempotent and re-runnable. It never re-tracks and never re-scores
# -- `--reaggregate` is arithmetic over numbers already in the deposit.
#
#   nohup bash figs/fig8_finish.sh > figs/out/tmp/fig8_finish.log 2>&1 &
#
# Read figs/out/FIG8-SUMMARY.txt afterwards; that is the whole point of it.
set -uo pipefail

REPO=/root/vast/eric/sleap-3d-gui/scratch/repos/lucid
BENCH_PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python
PLOT_PY="$REPO/figs/.venv/bin/python"
OUT="$REPO/figs/out"
SUMMARY="$OUT/FIG8-SUMMARY.txt"
cd "$REPO" || exit 1

say() { echo "[finish $(date -u +%H:%M:%S)] $*"; }

# Wait for a run to write its deposit. Bounded: if a pass dies, this must not spin for
# ever pretending to wait for it.
wait_for() {           # wait_for <logfile> <max-seconds> <label>
    local log=$1 max=$2 label=$3 waited=0
    while ! grep -q "^\[fig8m\] wrote" "$log" 2>/dev/null; do
        if ! pgrep -f "fig8_methods.py" >/dev/null; then
            say "$label: no fig8_methods.py process left and no 'wrote' line -- giving up"
            return 1
        fi
        sleep 60; waited=$((waited + 60))
        if [ "$waited" -ge "$max" ]; then
            say "$label: still unfinished after ${max}s -- giving up waiting"
            return 1
        fi
    done
    say "$label: complete"
    return 0
}

say "waiting for the 50-session pass"
wait_for "$OUT/tmp/fig8m_all50.log" 14400 "50-session pass"
FIFTY=$?

say "waiting for the motion re-run (bug fix re-measurement)"
wait_for "$OUT/tmp/fig8m_motionfix.log" 3600 "motion re-run"

# --- the 8-session deposit: fold in the motion re-run, redraw 8d -----------------
say "re-aggregating the 8-session deposit"
"$BENCH_PY" figs/fig8_methods.py --reaggregate 2>&1 | tail -2
say "rendering 8c and 8d"
"$PLOT_PY" figs/panels/fig8_03_loss_budget.py 2>&1 | grep -E "wrote|deposited|rror"
"$PLOT_PY" figs/panels/fig8_04_methods.py 2>&1 | grep -E "wrote|deposited|rror"

# --- the 50-session deposit: report + 8e ----------------------------------------
if [ "$FIFTY" -eq 0 ] && [ -f "$OUT/fig8_methods_50.json" ]; then
    say "rendering 8e and writing the 50-session report"
    "$PLOT_PY" figs/panels/fig8_05_all50.py 2>&1 | grep -E "wrote|deposited|rror"
else
    say "no 50-session deposit -- skipping 8e"
fi

say "linting rendered text and assembling figure 8"
"$PLOT_PY" figs/lint_text.py 2>&1 | tail -3
"$PLOT_PY" figs/assemble.py 8 2>&1 | tail -3

# --- the human-readable landing page -------------------------------------------
{
    echo "FIG 8 — unattended finish, $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo
    echo "================ ALL 50 BMIMICA SESSIONS ================"
    if [ -f "$OUT/fig8_methods_50.json" ]; then
        "$BENCH_PY" figs/fig8_report50.py 2>&1
    else
        echo "(the 50-session pass did not produce a deposit; see"
        echo " figs/out/tmp/fig8m_all50.log)"
    fi
    echo
    echo "================ 8 SESSIONS (Fig 3e subset) ================"
    grep -E "switches=" "$OUT"/tmp/fig8m_round*.log 2>/dev/null \
        | sed 's/.*\[fig8m\] //' | sort -u
    echo
    echo "================ MOTION RE-RUN (after the frame-stamp fix) ================"
    grep -E "switches=" "$OUT/tmp/fig8m_motionfix.log" 2>/dev/null \
        | sed 's/.*\[fig8m\] //' || echo "(not available)"
    echo
    echo "================ INTEGRITY ================"
    for f in fig8_methods_verify.json fig8_methods_recheck.json; do
        [ -f "$OUT/$f" ] && "$BENCH_PY" -c "
import json,sys
d=json.load(open('$OUT/$f'))
k=[x for x in ('all_identical','all_reproduce') if x in d]
print('$f:', {x: d[x] for x in k}, d.get('mismatched') or '')"
    done
} > "$SUMMARY" 2>&1

say "wrote $SUMMARY"
say "done"
