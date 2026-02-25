# Plan: Prompt 6 — Timeline pause, visual UI changes, SLP interaction fix

## Current State
On `josh-edits`. Session folder loading now works (Prompt 5). Users can load SLP+video pairs from folders.

## Problems
1. Moving the timeline cursor causes the video to start playing — should pause immediately
2. No yellow highlight on the currently selected video in the dock
3. Thumbnails in view strip don't show the first video frame
4. Single-clicking a thumbnail doesn't select its dock panel
5. Double-clicking a thumbnail adds a panel even if already in dock
6. SLP pose instances loaded from files are not interactable (can't click/drag)

## Steps

### Step 1: Timeline cursor pauses video
- In `onFrameChange` callback (index.html ~line 1297), check if `state.isPlaying` and call `videoController.stopPlayback()` before seeking

### Step 2: Yellow highlight on selected video
- Track which video panel is active via dockview's `onDidActivePanelChange` event
- Add a persistent `.video-selected` CSS class with a subtle yellow border/highlight
- Remove highlight from previously selected panel when selection changes

### Step 3: Thumbnail shows first video frame
- In `populateViewStrip()`, render the first decoded frame directly to the thumbnail canvas (using `view.decoder.getFrame(0)`) instead of copying from `view.canvas` (which is null until docked)

### Step 4: Single-click selects dock panel
- Add `click` handler on strip items
- If the video is in the dock, find its panel and call `api.setActivePanel(panel)` on the dockview API

### Step 5: Double-click only for undocked videos
- Check `paneManager.dockedViews.get(viewName) > 0` before adding a new panel on double-click
- If already docked, just select the existing panel instead

### Step 6: Fix SLP interaction — build InstanceGroups in handleLoadSessionFolder
- After loading all SLP+video pairs, add the same "Build InstanceGroups" step that exists in `handleLoadSlp()` (lines 4982-5010)
- Group instances by track index per frame, create InstanceGroup objects, store in `session.instanceGroups`
