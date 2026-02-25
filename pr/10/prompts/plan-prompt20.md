# Plan — Prompt 20

## Current State
- Assign → Automatic has a flyout with "Current Frame" / "Multiple Frames"
- Multiple Frames modal shows range slider, text fields, progress bar
- Triangulate and Triangulate All are separate toolbar buttons
- No camera view list in the multi-frame assignment modal

## Problems to Solve

### 1. Add camera views list to multi-frame assignment modal
- Show selected views as a bulleted list to the right of the End text field

### 2. Triangulate flyout menu
- Replace Triangulate button with dropdown: Current Frame / Multiple Frames
- Remove Triangulate All button
- Current Frame keeps existing triangulateCurrentFrame() behavior
- Multiple Frames opens a modal mirroring the assignment modal

### 3. Multi-frame triangulation modal
- Dual-handle range slider, synced text fields, camera view list
- Cancel/Continue buttons, progress bar
- Validation: check all frames in range have identity assignment
- If missing: show condensed range error (e.g., "Frames [10-15, 23, 40-42]")
- On error: cancel triangulation, keep modal open

## Steps
1. Update multi-frame assignment modal: add camera views bulleted list
2. Replace toolbar Triangulate/Triangulate All with dropdown + flyout
3. Update menu items (Edit menu) to match
4. Add showTriangulateMultiFrameModal() with validation logic
5. Add runMultiFrameTriangulation() with progress bar
6. Add helper: condenseMissingFrames() for error display
7. Wire up all event handlers
