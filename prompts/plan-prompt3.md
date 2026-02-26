# Plan: Prompt 3 — ViewWin empty on load, unzoom button fix, drag-drop rendering

## Current State
On branch `josh-edits`. Dockview UI is in place with view strip, split handles, FPS pill. The Load Demo flow auto-populates the dock with all 4 videos. The unzoom button exists but doesn't work (zoom proxy not initialized). Drag-and-drop from strip to dock creates panels but canvases are blank.

## Problems
1. **ViewWin auto-populates on Load Demo** — should remain empty, only the view strip sidebar should populate. Empty dock should say "Drag and Drop videos".
2. **Double-click unzoom should be removed** — replace with blue "Zoomed" text in top-right that changes to "Unzoom" on hover and resets zoom on click. The button exists but is broken (`_zoomProxy` never set).
3. **Dragged videos don't render** — `VideoPaneRenderer.init()` creates canvases but never renders the current frame to them.

## Steps

### Step 1: ViewWin empty on Load Demo
- Remove `paneManager.addAllViews()` call from `loadDemoSession()`
- Update `videoDockEmpty` text to "Drag and Drop videos"
- Also remove auto-add from other loading flows (handleLoadVideos, handleLoadSlp, etc.) — only populate the view strip, let user drag videos in
- Ensure `rebuildVideoController()` still works without panels (needs views for decoding, not for rendering)

### Step 2: Fix unzoom button
- Remove double-click-to-unzoom handler from `video.js` `setupZoomHandlers()`
- Fix `_zoomProxy` in `VideoPaneRenderer` — the button should use the actual view object (not a proxy)
- Ensure `applyZoom()` in video.js shows/hides the unzoom button (check if this logic exists in lucid's video.js)
- Style: blue text, top-right corner (already matches CSS)

### Step 3: Fix drag-and-drop video rendering
- After `VideoPaneRenderer.init()` creates canvases, trigger a re-render of the current frame
- Call `videoController.seekToFrame(state.currentFrame)` in `refreshPaneInteractions()` or at end of `init()`
- Ensure `fitCanvasesToCells()` is called after panel is added
