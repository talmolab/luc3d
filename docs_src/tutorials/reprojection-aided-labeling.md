# Tutorial: Reprojection-Aided Labeling

One of LUC3D's most powerful features is **reprojection-aided labeling** — the ability to generate free annotations in additional camera views after labeling just two views. This dramatically reduces annotation effort and ensures 3D consistency across all views.

## The Core Idea

When you annotate the same keypoints in **2 camera views**, LUC3D can:

1. **Triangulate** the 3D position of each keypoint
2. **Reproject** those 3D points into every other camera view
3. Give you **free 2D annotations** in cameras you haven't labeled yet

Instead of manually annotating 4, 6, or 8 camera views, you label 2 and get the rest for free — then just review and adjust.

```
Label 2 views → Triangulate → Reproject to all views → Adjust if needed
```

## Step-by-Step Workflow

### Step 1: Label Two Camera Views

Pick the two views where your subject is most clearly visible:

1. In **Camera 1**, press ++n++ to create an instance and position all keypoints
2. In **Camera 2**, press ++n++ and position keypoints for the same individual
3. Mark any occluded keypoints (right-click) rather than guessing

!!! tip "Choosing your two views"
    Pick views with the widest angle between them (e.g., front + side, or back + top). Wider baselines produce more accurate triangulations.

### Step 2: Group the Two Instances

1. Press ++a++ to enter assignment mode
2. Click the instance in Camera 1
3. Click the corresponding instance in Camera 2
4. Press ++c++ to create the group

### Step 3: Triangulate

Press ++t++ to triangulate the current frame. LUC3D computes the 3D position of each keypoint from your two labeled views.

### Step 4: View the Free Reprojections

Press ++r++ to show reprojected instances. You'll see **dotted overlays** appear in **every camera view** — including the ones you haven't labeled yet. These are the 3D points projected back into each camera's 2D space.

The reprojections in Camera 3, Camera 4, etc. are essentially **free annotations** derived from your work in just two views.

### Step 5: Convert Reprojections to Editable Instances

To use reprojections as a starting point:

1. Navigate to a camera view with only a reprojected instance (dotted overlay)
2. **Double-click** the reprojected instance to convert it to a user instance
3. Fine-tune any keypoints that are slightly off
4. The instance is now part of the group

### Step 6: Re-triangulate for Better Accuracy

After adding more views to the group:

1. Press ++t++ to re-triangulate
2. With 3+ views contributing, the 3D reconstruction becomes more accurate
3. Reprojection errors decrease
4. The reprojections in remaining views become even more precise

This creates a **virtuous cycle**: more views → better 3D → better reprojections → easier labeling.

## 3D-Consistent Labeling

Beyond saving time, reprojection-aided labeling ensures **3D consistency** across all camera views.

### The Problem with Independent Labeling

When you label each camera view independently, small inconsistencies creep in:

- A keypoint might be placed 3 pixels too far left in one view
- The same keypoint might be 2 pixels too high in another view
- These errors compound during triangulation, producing noisy 3D reconstructions

### How Reprojections Help

Reprojections show you exactly where a keypoint **should** be based on the 3D reconstruction. By using reprojections as your guide:

- All views are geometrically consistent with each other
- Annotations respect the camera geometry and calibration
- The resulting 3D skeleton is physically plausible
- Bone lengths remain consistent across frames

### Workflow for 3D-Consistent Labeling

1. **Label 2 views** carefully — these are your anchor views
2. **Triangulate** to get the 3D reconstruction
3. **Check reprojections** in all views — do they land on the correct body parts?
4. If a reprojection is off:
    - The issue is likely in one of your anchor views
    - Check the per-camera error in the Instances tab
    - Fix the annotation in the view with the highest error
    - Re-triangulate
5. Once reprojections look good in all views, the annotations are 3D-consistent

## Using Reprojections for Proofreading

Reprojections are also a powerful proofreading tool for annotations you've already made.

### Spot-Checking Existing Labels

1. Triangulate a labeled frame (++t++)
2. Press ++r++ to overlay reprojections
3. Compare the reprojected positions (dotted) with your annotations (solid)
4. Large gaps between them indicate annotation errors

### Identifying Specific Errors

| What You See | Likely Problem |
|-------------|----------------|
| Reprojection is close but offset by a few pixels | Minor annotation inaccuracy — adjust the keypoint |
| Reprojection is on the wrong body part | Left/right swap or wrong keypoint identity |
| Reprojection is wildly off in one view | Annotation in that view needs major correction |
| All reprojections are slightly off | Calibration may need improvement |

### Batch Proofreading

1. Run **Edit → Group by Track & Triangulate All** to triangulate every frame
2. Enable reprojection overlay (++r++) and error visualization (++e++)
3. Scrub through frames with ++right++
4. Stop at frames where reprojections visibly diverge from annotations
5. Fix and re-triangulate

## Tips for Best Results

!!! tip "Start with your best two views"
    The quality of reprojections depends entirely on the accuracy of your initial two-view annotations. Take extra care with these.

!!! tip "Wide baseline = better reprojections"
    Two cameras at 90 degrees apart produce much better triangulations than two cameras side by side.

!!! tip "Don't fight the reprojection"
    If a reprojection looks correct but your annotation disagrees, trust the reprojection — it represents the 3D-consistent position. Adjust your annotation to match.

!!! tip "Iterate: label → triangulate → check → fix"
    The fastest workflow is iterative. Don't try to perfectly label all views before triangulating. Label two, triangulate, use reprojections to fill in the rest, then refine.

!!! tip "Use error thresholds"
    After triangulating, sort by reprojection error. Focus your proofreading time on instances with error > 5px — these have the most room for improvement.

## Summary

| Traditional Labeling | Reprojection-Aided Labeling |
|---------------------|---------------------------|
| Label all N camera views independently | Label 2 views, get N-2 for free |
| Annotations may be inconsistent across views | All annotations are 3D-consistent |
| Errors only found after triangulation | Errors visible immediately via reprojection overlay |
| Time scales linearly with camera count | Time is nearly constant regardless of camera count |

Reprojection-aided labeling is the key workflow that makes multi-view annotation in LUC3D practical — even with large camera arrays.
