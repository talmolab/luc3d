# Plan: Prompt 1 — Update UI from mv-gui

## Current State
The project was moved from `/root/vast/joshua/vibes/mv-gui` to `/root/vast/joshua/lucid`. The current repo has **evolved non-UI functionality** (more export formats, SLP merge, skeleton load/save, camera-video assignment, single-view mode, etc.) but has an **outdated UI layout** compared to the old repo.

## Problem
The UI in `lucid` is missing several key features from the `mv-gui` UI described in PROJECT.md:

1. **View Strip sidebar** (64px left panel with draggable video thumbnails)
2. **Dockview panel system** (drag-and-drop split video panels replacing static 2x2 grid)
3. **Split-pane drag handles** (resizable dividers between video/3D/info panels)
4. **Info Panel Wrapper** (collapsed state managed via wrapper div, not direct panel)
5. **FPS pill** (rounded pill with double-click-to-edit, replacing plain text)
6. **Editable frame number** (double-click counter to type frame number)
7. **Unzoom button** (clickable button replacing CSS pseudo-element)
8. **"Hide Panel" toggle** in toolbar (instead of "Info" button in controls bar)
9. **"Load Demo"** as standalone menu bar item
10. **Loading overlay dismiss button**

## Steps

### Step 1: Update HTML structure
- Add dockview CSS link in `<head>`
- Add "Load Demo" as standalone menu bar item (keep it in File too)
- Add `infoPanelToggleBtn` to toolbar (right-aligned)
- Replace static `<div class="video-grid">` with view-strip + video-dock structure
- Add split handles between video section, 3D viewport, and info panel
- Wrap info panel in `info-panel-wrapper`
- Replace FPS display with FPS pill
- Remove "Info" button from controls bar
- Add loading dismiss button

### Step 2: Update CSS
- Add view-strip styles (sidebar, items, thumbnails, status dots)
- Add video-dock + video-dock-empty styles
- Add dockview theme overrides (.dockview-theme-abyss)
- Add unzoom-btn styles (replacing .zoomed::after pseudo)
- Add FPS pill styles
- Add info-panel-wrapper styles
- Update split-handle styles (dragging, hidden, ghost-line)
- Add frame-display .current-frame:hover
- Update panel-tab overflow styles
- Update canvas-wrapper to inline-block (dockview compat)
- Update responsive breakpoints for view-strip

### Step 3: Update JavaScript — Dockview integration
- Change `<script>` to `<script type="module">` with dockview ESM import
- Create `VideoPaneRenderer` class (IContentRenderer)
- Create `paneManager` object (init, addVideoPanel, addAllViews, clearAll)
- Create `panelRenderers` Map and `refreshPaneInteractions()`
- Add `mapPositionToDirection()` helper
- Add `renderDuplicatePanels()` function
- Adapt video loading to use dockview panels instead of static grid cells

### Step 4: Update JavaScript — View strip
- Create `populateViewStrip()` function with drag/drop support
- Create `updateViewStripThumbnail()` function
- Create `updateStripItemStatus()` function

### Step 5: Update JavaScript — Split handles & misc UI
- Create `setupSplitHandles()` and `setupDragHandle()` functions
- Add editable frame number (double-click)
- Add editable FPS pill (double-click)
- Add info panel toggle button in toolbar
- Update `toggleInfoPanel()` to use wrapper

### Step 6: Update PROJECT.md
- Update file listing for new files in lucid (slp-merge.js, frame-worker.js, etc.)
- Update menu structure (new items: New/Save/Load Project, export H5 formats, etc.)
- Update keyboard shortcuts (V, G, Alt+Drag)
- Update session tab description (Camera-Video Assignment section)
- Update skeleton tab (Load/Save buttons)
- Update test count
- Update file paths from `/root/vast/joshua/vibes/mv-gui` to `/root/vast/joshua/lucid`
