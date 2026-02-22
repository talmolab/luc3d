# Plan: Prompt 9 — UI tweaks: node size, label size, 3D resize, camera highlight, assign button

## Current State
On `josh-edits`. Prompt 8 added Assign dropdown, auto-assignment, removed preemptive triangulation.

## Problems
1. Default node size is 8, should be 1
2. No independent label size control
3. 3D visualizer doesn't re-center when info panel is toggled
4. Selecting a video window doesn't highlight the camera in the 3D viewer
5. Assign button/dropdown not visible on screen (needs to be next to Create Group)

## Steps

### Step 1: Set default node size to 1
- Change `<input id="nodeSizeSlider" value="8">` to `value="1"`
- Change `<span id="nodeSizeValue">8</span>` to `1`

### Step 2: Add independent label size slider
- Add a new "Label Size" slider in the toolbar next to the node size slider
- Default label size: 11 (current hardcoded value in overlays.js)
- Pass label size to drawFrameOverlays and drawInstanceLabels
- Make label rendering use this value instead of hardcoded 11

### Step 3: Re-render 3D visualizer on info panel toggle
- In `toggleInfoPanel()`, after toggling the collapsed class, call `viewport3d.resize()` with a slight delay (to let CSS transition complete)

### Step 4: Highlight camera in 3D viewer on window selection
- In the `onDidActivePanelChange` handler, when a video panel is selected (not during auto-assignment), call `viewport3d.highlightCamera(viewName)` or equivalent
- Check if viewport3d has a camera highlight method

### Step 5: Fix Assign button visibility
- The Assign dropdown is already in the HTML next to Create Group. The issue may be with the dropdown wrapper CSS or the button rendering. Simplify: ensure the dropdown is properly styled inline with other toolbar buttons.
