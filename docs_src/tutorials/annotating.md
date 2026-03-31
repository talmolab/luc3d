# Tutorial: Annotating Poses

This tutorial walks through the full annotation workflow — from creating your first skeleton instance to building up a labeled dataset across frames and camera views.

## Overview

The annotation workflow in LUC3D follows this pattern:

```
Navigate to frame → Create instance → Position keypoints → Repeat for each view
```

For multi-view 3D work, you then [group instances](../user-guide/tracks-identities.md) across cameras and [triangulate](../user-guide/triangulation.md).

## Creating Your First Instance

### Step 1: Navigate to a Frame

Use any of these to find a good frame to annotate:

- ++left++ / ++right++ — Step one frame at a time
- ++space++ — Play/pause to scan through the video
- Click on the **timeline** to jump to a specific frame
- ++ctrl+j++ — Jump to a specific frame number

Pick a frame where your subject is clearly visible in multiple camera views.

### Step 2: Select a Camera View

Click on a camera view to make it active, or press ++v++ to cycle through views. The active view has a highlighted border.

### Step 3: Add an Instance

Press ++n++ to create a new skeleton instance. A skeleton appears in the active camera view with all keypoints at default positions.

### Step 4: Position Keypoints

For each keypoint in the skeleton:

1. **Click and drag** the keypoint node to its correct position on the animal/subject
2. Place it precisely at the anatomical landmark

Work through all keypoints systematically (e.g., head → spine → limbs → tail).

!!! tip "Moving the whole skeleton"
    If the skeleton spawned far from your subject, hold ++alt++ and drag any node to move the entire instance at once, then fine-tune individual keypoints.

### Step 5: Handle Occluded Keypoints

Not every keypoint is visible in every camera view. For hidden keypoints:

- **Right-click** the node to mark it as **occluded** (the node becomes hollow)
- Right-click again to mark as **not visible** (the node disappears)
- Right-click once more to return to **visible**

!!! warning
    Don't guess the position of occluded keypoints — mark them as occluded. Guessed positions will degrade triangulation quality.

## Annotating Multiple Views

After annotating in one camera view, repeat for other views:

1. Click on the next camera view (or press ++v++)
2. Press ++n++ to add a new instance
3. Position all visible keypoints
4. Mark occluded keypoints

### How Many Views?

- **Minimum 2 views** required for triangulation
- **More views = better accuracy** — annotate in as many views as the keypoints are visible
- You don't need to annotate in views where the subject is barely visible or heavily occluded

## Annotating Multiple Subjects

If multiple animals/people are in the scene:

1. Create one instance per subject per camera view
2. Use **tracks** to label which instance belongs to which subject:
    - Select an instance
    - Press ++shift+1++ to assign Track 1, ++shift+2++ for Track 2, etc.
3. Consistent track assignment across views enables [auto-grouping](../user-guide/tracks-identities.md)

## Editing Existing Annotations

### Selecting an Instance

- **Click** any keypoint or edge to select that instance
- Press ++tab++ to cycle through instances in the current frame
- The selected instance is highlighted in the Instances panel

### Adjusting Keypoints

- **Drag** any keypoint to reposition it
- Hold ++alt++ + drag to move the entire instance

### Deleting

- Press ++delete++ to remove the selected instance from the current view
- Press ++shift+delete++ to remove it from all camera views

## Working with Predictions

If you've loaded SLEAP predictions:

1. Predictions appear as **dashed outlines** (predicted instances)
2. Review each prediction for accuracy
3. **Double-click** a correct prediction to convert it to a user instance
4. Adjust any mispositioned keypoints
5. Delete any incorrect predictions

This is much faster than annotating from scratch — you only need to fix errors.

## Frame-by-Frame Workflow

For efficient labeling of many frames:

### Labeling Strategy

1. **Don't label every frame** — label representative frames spread throughout the video
2. Focus on frames with **diverse poses** (different body positions, orientations)
3. Include frames where the subject is in **different locations** within the scene
4. Label frames where predictions are **poor or missing** (if using active learning)

### Efficient Navigation

- ++shift+right++ / ++shift+left++ — Jump to the next/previous labeled frame
- Use the **timeline** to see which frames already have annotations (marked with dots)
- Play through the video at normal speed to identify key frames to label

## Speed Up with Reprojection-Aided Labeling

You don't need to annotate every camera view manually. After labeling just **2 views**, you can triangulate and get **free reprojections** in all other views. See the full [Reprojection-Aided Labeling](reprojection-aided-labeling.md) tutorial for the complete workflow.

The short version:

1. Label 2 camera views carefully
2. Group and triangulate (++t++)
3. Press ++r++ to see reprojected annotations in all other views
4. Double-click reprojections to convert them to editable instances
5. Fine-tune and re-triangulate for even better accuracy

This also ensures all your annotations are **3D-consistent** across views — reprojections respect the camera geometry, so your labels are geometrically coherent.

## Building a Complete Dataset

### Recommended Workflow

1. **First pass**: Label 10–20 diverse frames across the video
2. **Use [reprojection-aided labeling](reprojection-aided-labeling.md)** to fill in additional camera views for free
3. **Group and triangulate** to verify annotation quality
4. **Fix** any instances with high reprojection error (> 5px)
5. **Second pass**: Add more frames, focusing on underrepresented poses
6. **Export** when satisfied with coverage and quality

### Quality Checks

After annotating, use these tools to verify quality:

- **Triangulate** (++t++) — Check reprojection errors
- **3D viewport** (++backslash++) — Verify the 3D skeleton looks anatomically correct
- **Reprojection overlays** (++r++) — See if reprojected points align with the video

High reprojection error on specific keypoints usually means those keypoints need adjustment in one or more camera views.
