# Plan: Prompt 2 — Branch management and demo files

## Current State
All Prompt 1 UI changes (dockview, view strip, split handles, FPS pill, etc.) are uncommitted on `main`:
- Modified: `index.html`, `styles.css`
- Untracked: `PROJECT.md`, `prompts/`

The demo sample videos (`sample_session/`) do not exist in this repository but are available at `/root/vast/joshua/vibes/mv-gui/sample_session/` (5 files: 4 mp4s + board.toml).

## Problem
1. All changes are on `main` but should be on a separate `josh-edits` branch
2. `main` should be reverted to its clean original state
3. Demo files need to be copied into this repo so the "Load Demo" feature works

## Steps

### Step 1: Create `josh-edits` branch and commit all changes
- Create branch `josh-edits` from current HEAD
- Copy `sample_session/` from `/root/vast/joshua/vibes/mv-gui/sample_session/` into this repo
- Stage all changes (index.html, styles.css, PROJECT.md, prompts/, sample_session/)
- Commit everything on `josh-edits`

### Step 2: Revert `main` to original state
- Switch back to `main`
- Restore `index.html` and `styles.css` to HEAD (discard modifications)
- Remove untracked files that were added (PROJECT.md, prompts/) — these only need to live on `josh-edits`
