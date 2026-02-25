# Plan — Prompt 17 (Part 2)

## Current State
- Skeleton tab has editable nodes (double-click to rename, delete button) and editable edges
- Both have add functionality (+ Node, + Edge)
- Load/Save Skeleton buttons exist
- Session folder loading scans for calibration, videos, and SLPs — no skeleton file detection

## Problems to Solve

### 1. Make nodes read-only
- Remove double-click-to-rename on node names
- Remove delete button on nodes
- Remove "New node name" input and "+ Node" button
- Keep the node table as a read-only reference

### 2. Move edges section above nodes section
- In the HTML, swap the order of the Edges and Nodes info-sections

### 3. Auto-load skeleton JSON from session folder
- During `handleLoadSessionFolder()`, scan for a JSON file with "skeleton" in the name
- If found, parse it and use it as the skeleton (overriding the SLP skeleton)
- Apply after SLP loading so it overrides the SLP-defined skeleton

## Steps
1. Reorder HTML: edges section first, then nodes section
2. Remove node editing UI elements (add input, add button, delete buttons, rename handler)
3. Remove the node header column for delete button (3rd column)
4. Add skeleton JSON file detection in `handleLoadSessionFolder()`
5. Apply loaded skeleton JSON override after SLP processing
