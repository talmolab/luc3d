# Plan — Prompt 15

## Current State
- Highlight border on `.video-cell` is technically not clipped by `overflow: hidden`, but the transformed canvas-wrapper content visually covers it when zoomed
- Zoom drift was fixed with offset clamping, but may still have edge cases
- After auto-assignment, instance_0 shows as blue (trackIdx=1) instead of red (trackIdx=0) — ordering issue
- No "brighten on selection" effect exists for cross-view track highlighting
- Triangulation uses ALL cameras, not just the ones used in group assignments

## Problems to Solve

### 1. Highlight still not visible when zoomed
**Root cause**: The `border` on `.video-cell` is correct but the scaled `.canvas-wrapper` child visually covers it because the wrapper's background/content extends over the border area.
**Fix**: Use a `::after` pseudo-element on `.video-cell` positioned absolutely with `inset: 0`, high `z-index`, `pointer-events: none`, and a visible border. This overlay sits above all content and is never clipped.

### 2. Zoom out past window
**Fix**: Add more robust clamping. Also use `< 1.001` instead of `<= 1.0` to handle floating-point edge cases. Add a comprehensive `clampZoom()` method.

### 3. instance_0 should be red (trackIdx=0), not blue
**Root cause**: After auto-assignment, the ordering of unlinked instances determines which group gets trackIdx 0 vs 1. The ordering may not match the original SLP track indices.
**Fix**: Sort unlinked instances by their original `trackIdx` before building assignments. This ensures instances originally labeled as track 0 get group trackIdx 0 (red).

### 4. Brighten skeleton on selection across views
**Fix**: When a group is selected, pass a `brighten` flag to `drawSkeleton` for instances belonging to the selected group. Use a lighter/brighter version of the track color.

### 5. Triangulation only uses assigned views
**Fix**: Filter cameras to only those present in the InstanceGroup before calling `triangulateAndReproject`. Don't create "filled" predicted instances for cameras outside the group.

## Steps
1. Replace highlight CSS with `::after` pseudo-element approach
2. Harden zoom clamping with floating-point tolerance
3. Sort unlinked instances by original trackIdx in auto-assignment
4. Add brightness boost for selected group's skeletons in all views
5. Filter cameras in triangulateCurrentFrame and triangulateAllFrames
