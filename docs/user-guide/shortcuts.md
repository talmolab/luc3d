# Keyboard Shortcuts

Complete reference of all keyboard shortcuts and mouse interactions in LUC3D.

## Playback & Navigation

| Key | Action |
|-----|--------|
| ++space++ | Play / Pause |
| ++left++ | Previous frame |
| ++right++ | Next frame |
| ++shift+left++ | Previous labeled frame |
| ++shift+right++ | Next labeled frame |
| ++home++ | Jump to first frame |
| ++end++ | Jump to last frame |
| ++ctrl+j++ | Jump to specific frame (edit frame counter) |

## View Controls

| Key | Action |
|-----|--------|
| ++plus++ / ++equal++ | Zoom in all views |
| ++minus++ | Zoom out all views |
| ++0++ | Reset zoom to fit |
| ++v++ | Cycle single-camera view (next camera) |
| ++g++ | Return to grid view (all cameras) |
| ++i++ | Toggle info panel |
| ++backslash++ | Toggle 3D viewport |

## Instance Operations

| Key | Action |
|-----|--------|
| ++n++ | Add new instance |
| ++ctrl+i++ | Add instance (smart positioning) |
| ++delete++ / ++backspace++ | Delete selected instance |
| ++shift+delete++ | Delete instance from all cameras |
| ++tab++ | Cycle through instances in current frame |
| ++escape++ | Clear selection / Cancel operation |

## Grouping

| Key | Action |
|-----|--------|
| ++a++ | Toggle assignment mode |
| ++c++ | Create group from selected instances |
| ++u++ | Unlink selected group |
| ++enter++ | Confirm group creation / Edit group |
| ++escape++ | Cancel group editing |

## Triangulation & Tracking

| Key | Action |
|-----|--------|
| ++t++ | Triangulate current frame |
| ++shift+t++ | Track current frame |
| ++ctrl+shift+t++ | Track all frames |
| ++f++ | Find matching instance across cameras |

## Track & Identity Assignment

| Key | Action |
|-----|--------|
| ++1++ – ++9++ | Assign identity 1–9 to selected instance |
| ++shift+1++ – ++shift+9++ | Assign track 1–9 to selected instance |

## Visibility Toggles

| Key | Action |
|-----|--------|
| ++u++ | Toggle user instances |
| ++p++ | Toggle predicted instances |
| ++r++ | Toggle reprojections |
| ++e++ | Toggle error visualization |

## File Operations

| Key | Action |
|-----|--------|
| ++ctrl+o++ | Load session folder |

## Help

| Key | Action |
|-----|--------|
| ++question++ | Show keyboard shortcuts overlay |

## Mouse Interactions

### On Keypoint Nodes

| Gesture | Action |
|---------|--------|
| Click + drag | Move keypoint |
| ++alt++ + drag | Move entire instance (preserves relative positions) |
| Right-click | Cycle visibility state (visible → occluded → hidden) |
| Double-click (predicted) | Convert predicted instance to user instance |

### On Empty Space

| Gesture | Action |
|---------|--------|
| Drag | Pan (when zoomed in) |
| Double-click | Reset zoom to fit |
| Scroll wheel | Zoom in/out |

### On Timeline

| Gesture | Action |
|---------|--------|
| Click | Jump to frame |
| Drag | Scrub through frames |
| ++shift++ + drag | Range selection |
| Scroll wheel | Zoom timeline |
| Middle-click drag | Pan timeline |
