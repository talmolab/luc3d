# Plan: Prompt 4 — Load Session Folder

## Current State
On branch `josh-edits`. The app can load individual SLP files, videos, and calibration files separately. There is no folder-selection mechanism — only individual file picking via `pickFiles()`.

## Problem
Users need to select files individually. We want a `File > Load Session Folder` option that loads a structured folder:
```
folder/
├── calibration.toml
├── videos/
│   ├── *.mp4
└── slp/
    ├── *.slp
```
- Auto-match SLPs to videos by filename stem
- If no calibration.toml, allow loading later
- Show popup for unmatched SLPs to let user pick videos manually

## Steps

### Step 1: Add menu item
- Add `<div class="menu-dropdown-item" id="menuLoadSessionFolder">Load Session Folder...</div>` to the File menu, after "Load Session..."

### Step 2: Implement folder picker helper
- Add `pickFolder()` function using `<input type="file" webkitdirectory>` — returns list of File objects with `webkitRelativePath`

### Step 3: Implement `handleLoadSessionFolder()`
- Call `pickFolder()` to get all files in the folder
- Scan for `calibration.toml` (or `.json`) at root level
- Scan `videos/` subdirectory for video files (`.mp4`, `.avi`, `.webm`, `.mov`)
- Scan `slp/` subdirectory for `.slp` files
- If calibration found, parse it
- Match each SLP to a video by filename stem (case-insensitive)
- For unmatched SLPs, show a popup modal with a table (SLP name → file picker)
- Load each SLP + its matched video
- Populate view strip and rebuild video controller

### Step 4: Wire up menu click handler
- Add event listener for `menuLoadSessionFolder` click
