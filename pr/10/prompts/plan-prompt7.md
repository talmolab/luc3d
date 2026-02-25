# Plan: Prompt 7 — UI Changes

## Current State
On `josh-edits`. Prompt 6 fixed timeline pause, thumbnails, selection, and SLP interaction.

## Problems
1. Multiple instances of same video in dock impairs zooming
2. Yellow highlight is on the entire panel window, not around the video border
3. "Hide Panel" button doesn't collapse the right panel (need to verify/fix)
4. No button to collapse the timeline (only a menu item exists)
5. Videos aren't auto-arranged in a grid on load

## Steps

### Step 1: Prevent duplicate video panels
- In `addVideoPanel()`, check `dockedViews` and skip if already docked
- In `onDidDrop` handler, prevent adding duplicates from strip drag
- Already handled in double-click from Prompt 6

### Step 2: Move highlight to video border (canvas-wrapper)
- Change `video-selected` CSS to target `.video-cell.video-selected .canvas-wrapper`
- Apply a subtle yellow border on the canvas-wrapper, not the full panel

### Step 3: Fix Hide Panel button
- The code exists and should work. Verify the event listener is wired up at line 6313.
- If needed, ensure the CSS transition works and the wrapper collapses.

### Step 4: Add timeline collapse button
- Add a toggle button in the controls-bar (near transport controls)
- Wire it to `toggleTimeline()`
- Show collapse/expand icon

### Step 5: Auto-grid layout on load
- Create `addAllViewsAsGrid()` method in paneManager
- Calculate optimal grid: rows=1 for n<=3, rows=2 for n<=8, rows=3 for n<=15
- Add first row left-to-right with `direction: 'right'`
- Add second row below corresponding first-row panels
- Call this from `loadDemoSession()`, `handleLoadSessionFolder()`, and `handleLoadSlp()` finalization
