# Plan — Prompt 18

## Current State
- Assign dropdown has Manual and Automatic options
- Automatic triggers view selection toast → runs `runAutomaticAssignment()` on current frame
- No tracking of whether auto-assignment was already run or which views were used
- `state.currentFrame` / `state.totalFrames` track frame position

## Problems to Solve

### 1. Flyout submenu on "Automatic" with "Current Frame" and "Multiple Frames"
- Replace direct `startAutoAssignment()` call with a submenu
- "Current Frame" keeps existing behavior
- "Multiple Frames" opens a modal

### 2. Track auto-assignment state
- Store `state.lastAutoAssignViews` (array of view names used) after successful auto-assign
- Store `state.lastAutoAssignFrame` to know which frame was assigned
- Check these to determine modal State 1 vs State 2

### 3. "Multiple Frames" modal
- State 1 (no assignment on current frame): message + Continue to dismiss
- State 2 (assignment already run): dual-handle range slider, start/end text fields, Cancel/Continue
- Continue runs assignment across frame range with progress bar

### 4. Multi-frame assignment execution
- Loop through selected frame range
- For each frame: seek, run `runAutomaticAssignment()` with saved views
- Show real-time progress bar

## Steps
1. Add `state.lastAutoAssignViews` and `state.lastAutoAssignFrame` tracking
2. Add flyout submenu HTML for Automatic → Current Frame / Multiple Frames
3. Add CSS for flyout submenu and modal
4. Add JS: flyout submenu show/hide logic
5. Add JS: `showMultiFrameModal()` with State 1/State 2 detection
6. Add JS: `runMultiFrameAssignment()` — loop, seek, assign, progress bar
7. Store auto-assign views after successful single-frame assignment
