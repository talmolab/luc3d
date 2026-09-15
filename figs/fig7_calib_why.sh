#!/usr/bin/env bash
# The "why" half of Fig 7: what the gap is actually made of.
set -uo pipefail
W="$(cd "$(dirname "$0")" && pwd)"
R=/root/vast/eric/sleap-3d-gui/scratch/repos/calibrat3
C18=/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-calibrat3/593ff93b-c041-46a0-b50b-23461d5ac3fc/scratchpad/calib18
P=/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-calibrat3/593ff93b-c041-46a0-b50b-23461d5ac3fc/scratchpad/node-v22.12.0-linux-x64/bin
export PATH="$P:$PATH"

# 1 -- how much does ANIPOSE vary run to run? Its solver is unseeded.
for s in calib18 cal_test2; do
    echo "=== anipose solver repeats, $s ==="
    python3 "$W/anipose_repeats.py" "$W/$s" 5 2>&1 | tee "$W/$s/anipose_repeats.log"
done

# 2 -- ablate calibrat3's solver, one factor at a time, on identical detections
mkdir -p "$W/cal_test2/ablation" "$W/calib18/ablation"
cd "$R"
echo "=== ablation, 8-camera rig ==="
SESSION=/root/vast/eric/calibration_test/cal_test2 SAVED="$W/cal_test2/calibrat3_800.session.json" \
  OUT="$W/cal_test2/ablation.json" TOML_DIR="$W/cal_test2/ablation" BASE=http://localhost:8080 \
  node "$W/ablation.mjs" 2>&1 | tee "$W/cal_test2/ablation.log"
echo "=== ablation, 18-camera rig ==="
SESSION="$C18" SAVED="$W/calib18/calibrat3_800.session.json" REF_CAM=Camera6 \
  OUT="$W/calib18/ablation.json" TOML_DIR="$W/calib18/ablation" BASE=http://localhost:8080 \
  node "$W/ablation.mjs" 2>&1 | tee "$W/calib18/ablation.log"

# 3 -- score every ablation arm with the SAME independent scorer, against both tools
for s in cal_test2 calib18; do
    echo "=== scoring the ablation, $s ==="
    args=()
    for f in "$W/$s/ablation"/*.toml; do args+=("abl_$(basename "$f" .toml)=$f"); done
    # score.py writes scores.json / scores_<detset>.npz, which are THE MAIN RESULT for
    # panels a-d. Renaming them to ablation_* afterwards would leave the deposit without
    # its anipose-scored arms and silently empty four panels, so the main files are
    # parked first and put back after.
    cp "$W/$s/scores.json" "$W/$s/.main_scores.json"
    cp "$W/$s/scores_anipose.npz" "$W/$s/.main_scores_anipose.npz"
    python3 "$W/score.py" "$W/$s" "anipose=$W/$s/anipose_rows.pkl" -- \
        "anipose=$W/$s/calibration_anipose.toml" \
        "calibrat3_800=$W/$s/calibrat3_800.toml" \
        "${args[@]}" 2>&1 | grep -v "NVIDIA GPU" | tee "$W/$s/ablation_scores.log"
    mv "$W/$s/scores.json" "$W/$s/ablation_scores.json"
    mv "$W/$s/scores_anipose.npz" "$W/$s/ablation_scores_anipose.npz"
    mv "$W/$s/.main_scores.json" "$W/$s/scores.json"
    mv "$W/$s/.main_scores_anipose.npz" "$W/$s/scores_anipose.npz"
done

# 4 -- out of sample: frames calibrat3 never used. EVERY ablation arm is included, not
#      just the headline three: the question "is the richer intrinsic model better or
#      merely more flexible" is asked of each model separately, and can only be answered
#      by comparing that model's in-sample and held-out error.
for s in cal_test2 calib18; do
    echo "=== held-out frames, $s ==="
    args=()
    for f in "$W/$s/ablation"/*.toml; do args+=("abl_$(basename "$f" .toml)=$f"); done
    python3 "$W/heldout.py" "$W/$s" "$W/$s/calibrat3_800.session.json" -- \
        "calibrat3=$W/$s/calibrat3_800.toml" \
        "anipose=$W/$s/calibration_anipose.toml" \
        "anipose_on_ours=$W/$s/calibration_anipose_on_ours.toml" \
        "${args[@]}" \
        2>&1 | grep -v "NVIDIA GPU" | tee "$W/$s/heldout.log"
done
echo "DEEP_DIVE COMPLETE"
