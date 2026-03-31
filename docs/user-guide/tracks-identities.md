# Tracks & Identities

LUC3D provides two complementary systems for tracking individuals across frames and camera views: **Tracks** and **Identities**.

## Concepts

### Tracks

A **Track** is a global label representing a persistent individual across frames (e.g., "mouse_1", "mouse_2"). Tracks are used to:

- Follow the same animal/person through time
- Color-code instances consistently
- Batch operations like "triangulate all frames for track X"

### Identities

An **Identity** is a per-frame assignment that maps instances to unique individuals within a single frame. Identities are useful for:

- Distinguishing multiple animals in the same frame
- Cross-view correspondence (same identity = same individual)
- Auto-grouping instances across cameras

### Instance Groups

An **Instance Group** links instances across multiple camera views that represent the same individual at the same frame. Groups are required for triangulation.

## Managing Tracks

### Create a Track

- **Tracks → New Track** in the menu
- Enter a name (e.g., "mouse_1")

### Assign a Track

- Select an instance, then press ++shift+1++ through ++shift+9++ for quick assignment
- Or use **Tracks → Assign Track** in the menu

### Rename/Delete Tracks

- **Tracks → Rename Track** — Change a track's display name
- **Tracks → Delete Track** — Remove the track (instances become trackless)

## Managing Identities

### Assign an Identity

- Select an instance, then press ++1++ through ++9++ for quick assignment
- Identities are auto-created if they don't exist yet

### Create Named Identities

- **Tracks → New Identity** — Create an identity with a custom name

## Color Modes

Control how instances are colored via the **Tracks** menu:

| Mode | Behavior |
|------|----------|
| **Color by Track** | Each track gets a distinct color (default) |
| **Color by Identity** | Each identity gets a distinct color |

## Grouping Instances Across Views

### Creating Groups (Assignment Mode)

1. Press ++a++ to enter **assignment mode**
2. Click an ungrouped instance in one camera view — it gets selected
3. Click instances in other camera views that show the same individual
4. Press ++c++ or ++enter++ to create the group

The linked instances form an **InstanceGroup** and can now be triangulated.

### Editing Groups

1. Select a grouped instance
2. Click **Edit → Edit Group** or use the toolbar
3. Click instances to reassign them between groups
4. Press ++enter++ to confirm or ++escape++ to cancel

### Unlinking Groups

- Select a grouped instance and press ++u++ or use **Edit → Unlink Group**
- The group is dissolved and instances become independent again

## Auto-Grouping

LUC3D can automatically group instances across views based on track or identity assignments:

- **Edit → Group by Track & Triangulate All** — Groups instances sharing the same track across cameras, then triangulates all frames
- **Edit → Group by Identity & Triangulate All** — Groups instances sharing the same identity, then triangulates

!!! tip
    Auto-grouping works best when you've consistently assigned tracks or identities across all camera views before grouping.

## Trust Track Labels

Enable **Tracks → Trust Track Labels** to automatically create identities from track names. This is useful when your track names already represent unique individuals and you want identity assignment to follow automatically.

## Timeline

The [timeline widget](shortcuts.md) at the bottom of the screen visualizes track and identity occupancy across frames:

- **Tracks mode** — Shows colored bars for each track
- **IDs mode** — Shows colored bars for each identity
- **Both mode** — Displays tracks and identities simultaneously

Click on the timeline to jump to a frame. Use ++shift++ + drag for range selection.
