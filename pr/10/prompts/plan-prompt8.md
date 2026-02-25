# Plan: Prompt 8 — Triangulation bug, Assign dropdown, Automatic Identity Assignment

## Current State
On `josh-edits`. Prompt 7 added grid layout, duplicate prevention, and UI fixes.

## Problems

### 1. Triangulation runs pre-emptively on load
**Bug explanation:** `precomputeTriangulation()` is called at:
- Line 648: inside `loadDemoSession()` — runs triangulation on ALL frames immediately
- Line 4889: inside `handleLoadSessionFolder()` finalize

`precomputeTriangulation()` (lines 674-709) iterates every frame in `session.instanceGroups`, calls `triangulateAndReproject()` on each group, and stores `group.points3d` and `group.reprojections`. The 3D viewport (`updateSkeleton()` in viewport3d.js) renders any group with non-null `points3d`.

**Result:** As soon as a project loads, the 3D viewer shows triangulated points before the user has done any identity assignment or requested triangulation.

**Fix:** Remove both `precomputeTriangulation()` calls from loading flows. Triangulation should only run when the user explicitly triggers `triangulateCurrentFrame()`.

### 2. Convert Assign button to dropdown
Currently: `<button id="tbAssign">Assign</button>` toggles assignment mode.
Need: Dropdown with "Manual" (current behavior) and "Automatic" (new flow).

### 3. Automatic Identity Assignment
Flow:
1. User clicks Assign > Automatic
2. Persistent toast: "Select the views for automatic Identity Assignment" + Cancel/Continue
3. Yellow selection highlight temporarily hidden
4. User clicks video windows to select/deselect (red highlight when selected)
5. On Continue: run epipolar matching + Hungarian on selected views' unlinked instances
6. If no views selected: notify and abort

**Algorithm:**
- For each pair of unlinked instances across different selected views, compute cost = mean reprojection error from `triangulateAndReproject()`
- Use a reference view approach: pick first selected view as reference, run Hungarian bipartite matching against each other view
- Group matched instances and call `createGroupFromUnlinked()`

### 4. Color labels by identity
After assignment, update `instance.trackIdx` in each group's instances to match the group's `trackIdx`, ensuring consistent coloring via `getTrackColor()`.

## Steps

### Step 1: Remove precomputeTriangulation from loading flows
- Remove call at line 648 (`loadDemoSession`)
- Remove call at line 4889 (`handleLoadSessionFolder`)

### Step 2: Convert Assign to dropdown
- Replace `<button id="tbAssign">` with a dropdown container
- Add Manual and Automatic options
- Manual = current `setAssignmentMode()` behavior
- Automatic = new auto-assignment flow

### Step 3: Implement auto-assignment UI
- Add persistent toast/banner component
- Add view selection mode with red highlight on click
- Wire Cancel (abort) and Continue (run matching)

### Step 4: Implement Hungarian algorithm
- Add `hungarianAlgorithm(costMatrix)` to triangulation.js
- Returns optimal assignment minimizing total cost

### Step 5: Implement automatic matching
- Collect unlinked instances from selected views for current frame
- For each pair across views, compute reprojection error via existing triangulation
- Build cost matrix, run Hungarian, create groups

### Step 6: Update instance colors after assignment
- When creating groups, set each instance's trackIdx to match the group's trackIdx
