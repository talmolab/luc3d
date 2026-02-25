# Plan — Prompt 14

## Current State
- Highlight on zoomed/clipped videos uses `box-shadow: inset` but still clipped by `overflow: hidden` on `.video-cell`
- Pan handler allows unlimited offset drift when scale=1.0 (video slides around even when not zoomed)
- After auto identity assignment, skeleton colors don't change visually (data flow issue)
- Auto-assignment creates groups based on reference view instance count only (if ref has 1 mouse, only 1 group created even if other views have 2)

## Problems to Solve

### 1. Highlight not visible on clipped sides
**Root cause**: `.video-cell` has `overflow: hidden` which clips `box-shadow: inset`.
**Fix**: Use `border` instead of `box-shadow` for the zoomed highlight. Borders are rendered inside the element and are not clipped by `overflow: hidden`. Need to also adjust for red auto-assign highlight.

### 2. Videos zoom out past window
**Root cause**: Pan handler (`mousemove` in `setupZoomHandlers`) has no offset constraints. At scale=1.0, the user can still drag/offset the video away from center.
**Fix**: Clamp `offsetX`/`offsetY` to 0 when `scale <= 1.0`. Also clamp after zooming out to prevent drift.

### 3. Skeleton colors don't change after auto-assignment
**Root cause**: The `unlinkGroup()` removes instances from `fg.instances`, then `createGroupFromUnlinked()` adds them back. The `inst.trackIdx` is updated on line 2161-2163 AFTER `createGroupFromUnlinked()`. The issue is the `drawFrameOverlays()` code at line 1160 reads `inst.trackIdx` from the instance in `frameGroup.instances`, and these ARE the same objects (pass by reference). So the color SHOULD be correct. Need to verify more carefully — possible issue: the `for...of` on `group.instances` (a Map) might not iterate properly, or `trackIdx` isn't being set properly.
**Fix**: Add explicit trackIdx setting in `createGroupFromUnlinked`, and ensure the color update is applied correctly. Also log to verify.

### 4. Track count uses reference view only
**Root cause**: `assignments` array sized to `refInstances.length` (line 2110). If ref has 1 instance and another view has 2, only 1 assignment slot exists.
**Fix**: Use the **minimum** instance count across all selected views as the number of tracks/groups. The view with the minimum count becomes the reference view, ensuring the Hungarian algorithm can match all available instances optimally.

## Steps
1. Fix highlight CSS: Replace `box-shadow: inset` with `border` for `.video-cell.video-selected.zoomed` and `.video-cell.auto-assign-selected.zoomed`
2. Fix zoom: Clamp offsets to 0 when scale <= 1.0 in pan handler and after zoom operations
3. Fix auto-assignment algorithm: Use min instance count across views as reference, set trackIdx robustly
4. Verify the data flow for skeleton color after assignment
