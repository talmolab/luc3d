# Plan — Prompt 19

## Current State
- `handleLoadSessionFolder()` step 5 (lines 5251-5288) automatically groups instances into InstanceGroups by matching trackIdx across cameras
- This makes instances appear pre-assigned with identity colors on load
- User wants identity assignment to only happen through the Assign menu

## Problem
Identity assignment runs automatically when a session folder is loaded. The auto-grouping in step 5 creates InstanceGroups from SLP trackIdx data, which visually appears as if identity assignment has already been run.

## Fix
Replace step 5's auto-grouping logic. Instead of creating InstanceGroups, convert all instances from `fg.instances` into UnlinkedInstances. This way:
- Instances still render (overlays draw from `fg.instances`)
- No pre-assigned identity groups exist
- `runAutomaticAssignment()` can find them via `fg.getUnlinkedInstances()`
- User must explicitly assign identities through the Assign menu

## Steps
1. Replace step 5 code: instead of building InstanceGroups, move all instances to the unlinked pool
