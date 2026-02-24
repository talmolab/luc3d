# Plan: Prompt 12 — Highlight on frame/window, toast in menu bar, skeleton color by identity, track labels

## Current State
On `josh-edits`. Prompt 11 fixed Assign dropdown — Manual/Automatic now work, auto-assignment unlinks+re-matches with Hungarian algorithm.

## Problems

### 1. Yellow/red highlight positioning
Currently: `.video-cell.video-selected .canvas-wrapper { outline: 2px solid ... }` — always on the canvas-wrapper.
Want: If entire video frame is visible, highlight goes around the video frame. If any side is clipped by zoom, highlight goes around the window (the `.video-cell`).

### 2. Toast widget location
Currently: `position: fixed; top: 48px; left: 50%;` — floating below the menu bar.
Want: Toast should be embedded IN the menu bar row (same bar as File/Edit/View/Load Demo).

### 3. Skeleton color matches identity after epipolar assignment
Currently: `drawSkeleton()` uses `getTrackColor(instance.trackIdx)`. After `runAutomaticAssignment()`, the code updates `inst.trackIdx = group.trackIdx`, but instances in the FrameGroup's instances list might still have old trackIdx values. Need to verify the color is actually applied correctly after auto-assignment.

### 4. Track name labels after grouping
Currently: `drawInstanceLabels()` draws track name labels using `inst.trackIdx` and `trackNames[]`. After auto-assignment creates groups, the instances should show their associated track name from the Instances tab. Need to ensure `drawAllOverlays()` passes the correct track names.

## Steps

### Step 1: Smart highlight (frame vs window)
- Detect whether the canvas is zoomed/clipped: compare canvas natural size vs visible area
- In CSS, add `.video-cell.video-selected.zoomed` style that applies outline to `.video-cell` instead of `.canvas-wrapper`
- In JS, when zoom state changes, toggle `.zoomed` class on the video-cell
- Apply same logic for `.auto-assign-selected`

### Step 2: Move toast into menu bar
- Remove the fixed-position toast from `document.body`
- Instead, append it to the `.menu-bar` element
- Change CSS: remove `position: fixed; top; left; transform` — use flex alignment within menu bar
- Style it to sit on the right side of the menu bar (after Load Demo)

### Step 3: Verify skeleton coloring after assignment
- In `runAutomaticAssignment()`, after creating groups, verify `inst.trackIdx` is updated
- Ensure `drawAllOverlays()` re-draws with correct colors
- The key: `drawSkeleton()` reads `instance.trackIdx` from the Instance object — after grouping, this must match the group's trackIdx

### Step 4: Track name labels on grouped instances
- Verify `drawAllOverlays()` passes `trackNames: state.session.tracks` to `drawInstanceLabels()`
- Ensure `drawFrameOverlays()` in overlays.js uses the trackNames option
- After auto-assignment, `drawAllOverlays()` is already called — just need to confirm labels appear
