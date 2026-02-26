# Plan: Prompt 11 — Fix Assign dropdown Manual & Automatic buttons

## Current State
On `josh-edits`. Prompt 10 fixed Assign dropdown visibility by removing the wrapper div and using a plain `toolbar-btn` + fixed-position menu as sibling. The dropdown opens but clicking Manual or Automatic does nothing visible.

## Problem
Both Manual and Automatic menu items in the Assign dropdown don't produce any visible effect when clicked.

## Root Cause Analysis
Three potential issues:
1. **Missing stopPropagation on dropdown menu**: The File menu dropdowns (`.menu-dropdown`) have `e.stopPropagation()` handlers (line 1371-1372) to prevent the document-level click handler (line 1359) from interfering. The Assign dropdown menu (`.toolbar-dropdown-menu`) does NOT have this protection. While the menu item handlers should fire before the document handler (bubbling order), adding stopPropagation ensures no interference.

2. **`startAutoAssignment()` silent early returns**: The function checks `!state.session`, `!fg`, and `!hasUnlinked` and returns with only a `setStatus()` warning that may be too subtle for the user to notice. The toast never appears in these cases.

3. **Manual handler lacks visible feedback**: Calling `interactionManager.setAssignmentMode()` toggles an internal mode flag but has no obvious visual indicator (no button highlight, no status message).

## Steps

### Step 1: Add stopPropagation to dropdown menu
- Add a click stopPropagation handler on `#tbAssignMenu` (the dropdown menu div) so that clicks inside it don't bubble to document handlers that close it

### Step 2: Add stopPropagation to menu item handlers
- Add `e.stopPropagation()` to both Manual and Automatic click handlers for robustness

### Step 3: Improve Manual button feedback
- Add a `setStatus()` message when assignment mode is toggled
- Toggle the Assign button's `.active` class to show visual state

### Step 4: Improve Automatic button feedback
- Add more visible status messages for early returns
- Ensure the toast has high z-index (1000+) and is properly created
- Add alert-style feedback if the toast fails to create

### Step 5: Verify auto-assignment end-to-end flow
- Ensure view selection (red highlight toggle) works with dockview cells
- Ensure Continue button triggers `runAutomaticAssignment()` properly
- Ensure Hungarian algorithm + group creation + color sync all work
