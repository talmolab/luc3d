# Plan: Prompt 13 — Fix zoomed highlight, disable zoom-out past fit, better track colors

## Current State
On `josh-edits`. Prompt 12 added smart highlight (frame vs window), toast in menu bar, track labels, verified skeleton coloring.

## Problems

### 1. No highlight visible on clipped sides when zoomed
`.video-cell` has `overflow: hidden`. When zoomed, the outline on `.video-cell` is clipped by the parent container (dockview panel). `outline` renders outside the border box but gets clipped by ancestor `overflow: hidden`.

**Fix:** Use `box-shadow: inset` instead of `outline` for the zoomed state. Inset box-shadow renders inside the border box and isn't affected by parent overflow clipping.

### 2. Zooming out past video fit
Currently `zoomVideo()` allows min scale of 0.25 (line 1276). The canvas is already sized by `fitCanvasesToCells()` to fit the cell (one dimension maxed, other letterboxed). Scale 1.0 = fit state. Scale < 1.0 = smaller than cell.

**Fix:** Change min scale from 0.25 to 1.0 in `zoomVideo()`. No limit for zooming in (keep max 10).

### 3. Track colors not ideal
Current palette: blue, green, yellow, pink, cyan, orange, purple, red — pastel/muted.
Want: start with primary colors (red, blue, green, orange), then add distinct shades.

**Fix:** Replace `TRACK_COLORS` with a better palette starting with primary colors. Document in PROJECT.md.

## Steps

### Step 1: Fix zoomed highlight with box-shadow inset
- Change `.video-cell.video-selected.zoomed` to use `box-shadow: inset 0 0 0 2px rgba(255,221,68,0.5)`
- Change `.video-cell.auto-assign-selected.zoomed` to use `box-shadow: inset 0 0 0 3px #ef4444`

### Step 2: Set minimum zoom to 1.0
- In `zoomVideo()`, change `Math.max(0.25, ...)` to `Math.max(1.0, ...)`
- Also in keyboard zoom handler `zoomAllVideos`, apply same limit

### Step 3: Update track color palette
- Replace TRACK_COLORS with primaries-first palette
- Document palette in PROJECT.md
