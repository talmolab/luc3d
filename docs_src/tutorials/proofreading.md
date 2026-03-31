# Tutorial: Proofreading Annotations

Proofreading is the process of reviewing and correcting annotations to ensure high-quality data. LUC3D provides several tools for systematic quality checking.

## Why Proofread?

Common annotation errors that degrade 3D reconstruction:

- **Swapped keypoints** — Left/right limb confusion
- **Mispositioned keypoints** — Keypoint placed on the wrong body part
- **Wrong instance grouping** — Instances from different individuals linked together
- **Missing occlusion labels** — Guessed positions for hidden keypoints instead of marking as occluded

!!! tip "Use reprojections for proofreading"
    Reprojections show you exactly where keypoints **should** be based on 3D geometry. They're invaluable for catching errors. See [Reprojection-Aided Labeling](reprojection-aided-labeling.md) for the full workflow on using reprojections for both labeling and quality checking.

## Proofreading with Reprojection Error

The most powerful proofreading tool is **reprojection error** — it quantifies how consistent your annotations are across camera views.

### Step 1: Triangulate

1. Ensure your instances are [grouped across views](../user-guide/tracks-identities.md)
2. Press ++t++ to triangulate the current frame
3. Or use **Edit → Group by Track & Triangulate All** for batch processing

### Step 2: Enable Error Visualization

- Press ++e++ to toggle error visualization on the video views
- Press ++r++ to show reprojected instances (dotted outlines)
- Both can be enabled simultaneously

### Step 3: Interpret the Errors

Open the **Instances** tab in the info panel (++i++) to see detailed error information:

**Overall RMS error** — Total error for the instance group

| Error | Quality | Action |
|-------|---------|--------|
| < 2 px | Excellent | No action needed |
| 2–5 px | Acceptable | Review if possible |
| > 5 px | Poor | Needs correction |

**Per-keypoint error** — Identifies specific problem keypoints

- A keypoint with 15px error while others are < 2px → that specific keypoint is likely mispositioned
- All keypoints with ~10px error → possible calibration issue or systematic misalignment

**Per-camera error** — Identifies which camera view has the problem

- One camera with 20px error, others < 2px → the annotation in that camera view needs fixing

### Step 4: Fix Errors

For each flagged keypoint:

1. Look at the **reprojected position** (dotted overlay) — this is where the 3D point projects
2. Compare with your **annotated position** (solid node)
3. If the reprojection looks more correct, drag your annotation toward it
4. If neither looks right, check the annotation in all camera views

After fixing, re-triangulate (++t++) to see the updated error.

## Systematic Proofreading Workflow

### Frame-by-Frame Review

1. **Triangulate all frames** first (Edit → Group by Track & Triangulate All)
2. Navigate through frames with ++right++
3. At each frame, check the error readout in the status bar
4. Stop and fix frames with error > 5px
5. Use ++shift+right++ to jump between labeled frames

### Per-Keypoint Review

If a specific keypoint consistently has high error:

1. Note which keypoint is problematic (e.g., "left_ankle")
2. Go through labeled frames and verify that keypoint specifically
3. Common issues:
    - Left/right swap (fixing one view dramatically reduces error)
    - Keypoint placed on the wrong joint
    - Keypoint placed on clothing/fur instead of the actual joint

### Cross-View Consistency Check

For each labeled frame:

1. Select an instance in one camera view
2. Press ++f++ to find the corresponding instance in other views
3. Verify all views show annotations on the same individual
4. Check that keypoints correspond to the same anatomical landmarks

## Using the 3D Viewport for Proofreading

The 3D viewport (++backslash++) gives you a spatial sanity check:

### What to Look For

- **Anatomically correct skeleton** — Limbs should have reasonable lengths and angles
- **Consistent bone lengths** — The same bone shouldn't change length dramatically between frames
- **No impossible poses** — Limbs shouldn't pass through the body or have extreme joint angles
- **Correct scale** — The skeleton should be appropriately sized relative to the camera positions

### Using the Environment Overlay

1. Find a frame with a good triangulation (low error)
2. Click **Set Env** in the 3D viewport to freeze it as a reference
3. Navigate to other frames — the reference skeleton stays visible as a ghost
4. Compare the current frame's skeleton against the reference
5. Click **Clear Env** when done

## Common Error Patterns and Fixes

### High Error on All Keypoints

**Likely cause**: Wrong instance grouping — instances from different individuals are linked.

**Fix**: Unlink the group (++u++), verify which instances belong to the same individual, re-group correctly.

### High Error on One Specific Keypoint

**Likely cause**: Keypoint mispositioned in one or more views.

**Fix**: Check the per-camera error breakdown, fix the keypoint in the camera with the highest error.

### High Error in One Camera Only

**Likely cause**: Annotation in that camera view is off.

**Fix**: Focus on that camera view, compare annotation positions with reprojected positions, adjust.

### Error Increases Suddenly at a Frame

**Likely cause**: Identity swap — the tracker or annotator started following the wrong individual.

**Fix**: Check track assignments around that frame. Reassign tracks if they were swapped.

## Proofreading Checklist

For a thorough proofread of your dataset:

- [ ] All frames triangulated
- [ ] No frames with RMS error > 5px
- [ ] No individual keypoints with error > 10px
- [ ] 3D skeletons look anatomically correct in the viewport
- [ ] Consistent bone lengths across frames
- [ ] No identity swaps (tracks are continuous in the timeline)
- [ ] Occluded keypoints are marked as occluded (not guessed)
- [ ] All expected individuals are annotated in each frame
- [ ] Track assignments are consistent across all camera views
