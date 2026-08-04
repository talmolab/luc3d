/**
 * slp-merge.js — Helpers for additive multi-SLP loading.
 *
 * Pure functions that can be tested independently.
 * Used by index.html for the additive merge path in handleAddSlp().
 */

import { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } from '../pose/pose-data.js';

/**
 * Validate that incoming skeleton is compatible with existing session skeleton.
 * Compares node NAME SETS, not exact order. Returns a reorder map if names match
 * but order differs.
 * @param {Skeleton} existing
 * @param {Skeleton} incoming
 * @returns {{ error: string|null, reorderMap: number[]|null }}
 *   reorderMap[incomingIdx] = existingIdx (for reordering incoming point data)
 */
export function validateSkeletonCompatibility(existing, incoming) {
    if (existing.nodes.length !== incoming.nodes.length) {
        return { error: 'Node count mismatch: existing has ' + existing.nodes.length + ', incoming has ' + incoming.nodes.length, reorderMap: null };
    }

    // Check if names match exactly in order (fast path)
    var exactMatch = true;
    for (var i = 0; i < existing.nodes.length; i++) {
        if (existing.nodes[i] !== incoming.nodes[i]) {
            exactMatch = false;
            break;
        }
    }
    if (exactMatch) {
        return { error: null, reorderMap: null };
    }

    // Names differ in order — check if they're the same SET
    var existingSet = {};
    for (var ei = 0; ei < existing.nodes.length; ei++) {
        existingSet[existing.nodes[ei]] = ei;
    }
    var reorderMap = [];
    for (var ii = 0; ii < incoming.nodes.length; ii++) {
        var inName = incoming.nodes[ii];
        if (existingSet[inName] === undefined) {
            return { error: 'Node "' + inName + '" in incoming skeleton not found in existing skeleton', reorderMap: null };
        }
        reorderMap[ii] = existingSet[inName];
    }

    // Verify all existing nodes are covered (no duplicates in incoming)
    var covered = new Set(reorderMap);
    if (covered.size !== existing.nodes.length) {
        return { error: 'Incoming skeleton has duplicate node names', reorderMap: null };
    }

    console.log('[slp-merge] Skeleton nodes match by SET but differ in order, built reorder map');
    return { error: null, reorderMap: reorderMap };
}

/**
 * Merge incoming track names into session, returning a remap table.
 * @param {Session} session
 * @param {string[]} incomingTracks
 * @returns {Map<number, number>} oldTrackIdx -> newTrackIdx
 */
export function mergeTracksIntoSession(session, incomingTracks) {
    var remap = new Map();
    for (var i = 0; i < incomingTracks.length; i++) {
        var name = incomingTracks[i];
        var existingIdx = session.tracks.indexOf(name);
        if (existingIdx >= 0) {
            remap.set(i, existingIdx);
        } else {
            var newIdx = session.tracks.length;
            session.tracks.push(name);
            remap.set(i, newIdx);
        }
    }
    return remap;
}

/**
 * Merge frames from parsed SLP data into an existing session.
 * @param {Session} session
 * @param {object} slpData - Parsed SLP data from worker
 * @param {object} videoIdxToCameraName - Map of video index to camera name
 * @param {Camera[]} cameras - Cameras derived from this SLP
 * @param {Map<number, number>} trackRemap - Track index remapping
 * @param {number[]|null} nodeReorderMap - If non-null, reorderMap[incomingIdx] = existingIdx
 * @returns {number[]} List of affected frame indices
 */
export function mergeSlpFramesIntoSession(session, slpData, videoIdxToCameraName, cameras, trackRemap, nodeReorderMap) {
    var affectedFrames = new Set();
    for (var fi = 0; fi < slpData.frames.length; fi++) {
        var fd = slpData.frames[fi];
        var camName = videoIdxToCameraName[fd.videoIdx];
        if (!camName && cameras.length > 0) {
            camName = cameras[fd.videoIdx % cameras.length].name;
        }
        if (!camName) camName = 'cam_' + fd.videoIdx;

        var fg = session.frameGroups.get(fd.frameIdx);
        if (!fg) {
            fg = new FrameGroup(fd.frameIdx);
            session.addFrameGroup(fg);
        }

        for (var ii = 0; ii < fd.instances.length; ii++) {
            var instData = fd.instances[ii];
            // Trackless instances (track=-1/null in SLP — e.g. reprojections
            // exported as UserInstance, or predictions whose track was deleted)
            // keep null trackIdx for BOTH user and predicted types. Coercing
            // trackless predictions to track 0 made a deleted-track instance
            // reappear on the first track (global_0) after a merge/reimport.
            var newTrackIdx;
            if (instData.trackIdx != null && instData.trackIdx >= 0) {
                newTrackIdx = trackRemap.has(instData.trackIdx) ? trackRemap.get(instData.trackIdx) : instData.trackIdx;
            } else {
                newTrackIdx = null;
            }

            // Reorder points if node ordering differs between incoming and existing skeleton
            var points = instData.points;
            if (nodeReorderMap) {
                var reorderedPoints = new Array(nodeReorderMap.length);
                for (var ri = 0; ri < nodeReorderMap.length; ri++) {
                    reorderedPoints[nodeReorderMap[ri]] = points[ri] || null;
                }
                points = reorderedPoints;
            }

            var inst = new Instance(
                points,
                newTrackIdx,
                instData.type || 'predicted',
                instData.score || 1.0
            );
            fg.addInstance(camName, inst);
        }
        affectedFrames.add(fd.frameIdx);
    }
    return Array.from(affectedFrames);
}

/**
 * Rebuild InstanceGroups for specified frames (re-group by trackIdx across all cameras).
 * @param {Session} session
 * @param {number[]} frameIndices
 */
export function rebuildInstanceGroupsForFrames(session, frameIndices) {
    for (var f = 0; f < frameIndices.length; f++) {
        var frameIdx = frameIndices[f];
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) continue;

        var trackInstances = new Map();
        for (var [cn, insts] of fg.instances) {
            for (var i = 0; i < insts.length; i++) {
                // Trackless instances (user OR predicted) skip trackIdx grouping
                // entirely — they have no track to group by, and bucketing them
                // into track 0 would both collide with a real track-0 instance
                // and resurrect the deleted-track-becomes-global_0 bug.
                if (insts[i].trackIdx == null) continue;
                var tIdx = insts[i].trackIdx;
                if (!trackInstances.has(tIdx)) trackInstances.set(tIdx, []);
                trackInstances.get(tIdx).push({ camName: cn, instance: insts[i] });
            }
        }

        var groupsList = [];
        for (var [trkIdx, entries] of trackInstances) {
            var grp = new InstanceGroup(Date.now() + trkIdx + frameIdx, trkIdx);
            for (var ei = 0; ei < entries.length; ei++) {
                grp.addInstance(entries[ei].camName, entries[ei].instance);
            }
            groupsList.push(grp);
        }
        session.instanceGroups.set(frameIdx, groupsList);
    }
}
