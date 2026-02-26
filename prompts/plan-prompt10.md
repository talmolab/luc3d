# Plan: Prompt 10 — Fix Assign dropdown visibility

## Current State
On `josh-edits`. The Assign dropdown HTML exists in the toolbar (lines 97-103) inside a `toolbar-dropdown` wrapper div, but it's not rendering on screen.

## Problem
The user's observed layout is:
```
+Inst -Inst │ CreateGroup Unlink │ Triangulate ...
```
The Assign dropdown between the separator and CreateGroup is invisible.

## Root Cause
The `toolbar-dropdown` wrapper div with `display: inline-flex` and `position: relative` likely causes the button to not render properly as a flex child of `toolbar-group`. The extra wrapper level may collapse or get zero width.

## Fix
Remove the wrapper div and make Assign a regular `toolbar-btn` like the others. Attach the dropdown menu as a sibling element positioned absolutely relative to the toolbar-group (which already has `position: relative` via the toolbar). This matches how all other toolbar buttons render.

## Steps
1. Restructure HTML: remove `toolbar-dropdown` wrapper, make Assign a plain button + sibling dropdown menu
2. Update CSS: position dropdown menu relative to the button using JS-set coordinates
3. Update JS click handler to position and toggle the menu
