# Plan: Prompt 5 — Fix folder upload for Load Session Folder

## Current State
On `josh-edits`. The `Load Session Folder` feature was added in Prompt 4 but doesn't work — no SLP or video files get loaded when a correct folder is uploaded.

## Problem
The console error shown is from a browser extension (Kami), not our code. The actual issue is likely:
1. The `pickFolder()` focus-based cancel detection may kill the dialog prematurely (folder selection takes longer than file selection)
2. The file categorization is too strict — requires exact `videos/` and `slp/` subfolder names with exactly one level of nesting
3. Need better browser compatibility (`directory` attribute alongside `webkitdirectory`)

## Steps

### Step 1: Fix pickFolder() in file-io.js
- Add `directory` attribute for Firefox compat
- Remove aggressive focus-based cancel detection for folder picker (it's unreliable with slow folder dialogs)
- Add better fallback

### Step 2: Make folder scanning more robust
- Case-insensitive subfolder matching (Videos, VIDEOS, videos all work)
- Look for SLP and video files at any depth, not just exact paths
- If no videos/ or slp/ subfolders found, search the entire folder tree
- Support calibration files with any name ending in .toml or .json at root level

### Step 3: Add debug logging
- Log all files found with their paths
- Log categorization results
