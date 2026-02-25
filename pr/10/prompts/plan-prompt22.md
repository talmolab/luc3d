# Plan — Prompt 22

## Current State
- Camera clicking exists: raycaster picks spheres, calls `onCameraClicked` → `highlightVideoCell()`
- `highlightVideoCell` adds yellow border for 2s then removes it (temporary flash)
- `animateToCameraPerspective()` exists but is called directly on click, not on button
- No "Show Camera View" button in 3D viewer
- No declutter logic for camera perspective view

## Problems to Solve

### 1. Camera selection with persistent yellow border
- Click camera in 3D → highlight matching video panel with yellow border
- Border should be persistent (not 2s flash) until another camera is selected or deselected
- Track selected camera in viewport3d state

### 2. "Show Camera View" button
- Add button in top-right corner of 3D viewer container
- Clicking it animates to selected camera's perspective
- Should only work when a camera is selected

### 3. Declutter on zoom-in
- When viewing from camera perspective, hide that camera's wireframe + label + up-line
- Restore when user zooms out past a threshold
- Use distance from camera position as threshold (not raw zoom)

## Steps
1. Add `selectedCamera` property to Viewport3D; update click handler to set it
2. Change `highlightVideoCell` to be persistent (no setTimeout removal)
3. Separate click → select (highlight) from click → animate (move to button)
4. Add "Show Camera View" button to 3D container HTML
5. Add CSS for the button
6. Wire button to `animateToCameraPerspective(selectedCamera)`
7. Add declutter logic: track which camera is being viewed, hide on proximity
8. Check distance in render loop / orbit controls change event
