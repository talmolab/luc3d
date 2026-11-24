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
 * The video each of an SLP's cameras was predicted on, as the file names it
 * (`sourceFilename`, else `filename`; a '.' or missing path is left out).
 * File ▸ Load SLP keeps it on the session (`session.slpVideoByCamera`) so a
 * later Load SLP of the same video is recognised (`camerasAlreadyInSession`).
 * @param {{sourceFilename?: string, filename?: string}[]} videos - slpData.videos
 * @param {Object<number, string>} videoIdxToCameraName
 * @returns {Object<string, string>} camera name -> video path
 */
export function slpVideoByCamera(videos, videoIdxToCameraName) {
    var out = {};
    for (var k in videoIdxToCameraName) {
        var v = videos && videos[k];
        var p = v ? (v.sourceFilename || v.filename || '') : '';
        if (p && p !== '.') out[videoIdxToCameraName[k]] = p;
    }
    return out;
}

/**
 * The incoming cameras the session already has: the same camera name AND the
 * same video (`sameVideoPath`) as when that camera came from an SLP. Load SLP
 * on the same video again (e.g. to attach the video after continuing without
 * one) must not add its camera a second time: the renamed copy (`<name>_2`)
 * turned a one-camera session into a two-camera one, so Track All and the ID
 * Switches tab took the multi-camera path. Two different videos with the same
 * stem (campy names every video 0.mp4) differ in their full paths and are still
 * added; a camera the session did not get from an SLP has no path and is never
 * matched.
 *
 * After a reopen the session's path is the one the saved project wrote: the
 * eager loader reads it from the file's videos (`slpVideoByCamera`), and a lazy
 * project's loader holds it (`lazyLoader.videos`). A save writes the video as it
 * was picked, often just its name, so a shorter path matches the tail of a
 * longer one (`sameVideoPath`).
 * @param {Session} session
 * @param {Object<string, string>} incoming - `slpVideoByCamera` of the new file
 * @returns {string[]} camera names
 */
export function camerasAlreadyInSession(session, incoming) {
    var known = (session && session.slpVideoByCamera) || {};
    var lazyVideos = session && session.lazyLoader && session.lazyLoader.videos;
    var names = ((session && session.cameras) || []).map(function (c) { return c.name; });
    return Object.keys(incoming).filter(function (cam) {
        if (names.indexOf(cam) < 0) return false;
        var have = known[cam];
        if (!have && lazyVideos && typeof lazyVideos.get === 'function') {
            var rec = lazyVideos.get(cam);
            have = rec && rec.filename;
        }
        return sameVideoPath(have, incoming[cam]);
    });
}

/**
 * Do two video paths name the same file? Equal paths do; so does a shorter path
 * that is the tail of a longer one, folder by folder (`top.mp4` and
 * `/data/rec_a/top.mp4`, `cam_a/0.mp4` and `D:\rec\cam_a\0.mp4`), since a saved
 * project keeps a video as it was picked. Two full paths must match to their
 * shorter one's first folder, so `/rec/cam_a/0.mp4` and `/rec/cam_b/0.mp4`
 * differ. Separators `/` and `\` are the same; empty paths never match.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameVideoPath(a, b) {
    if (!a || !b) return false;
    var parts = function (p) { return String(p).split(/[\\/]+/).filter(function (x) { return x && x !== '.'; }); };
    var pa = parts(a), pb = parts(b);
    var n = Math.min(pa.length, pb.length);
    if (!n) return false;
    for (var i = 1; i <= n; i++) if (pa[pa.length - i] !== pb[pb.length - i]) return false;
    return true;
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
            var pointScores = instData.pointScores || null;
            if (nodeReorderMap) {
                var reorderedPoints = new Array(nodeReorderMap.length);
                var reorderedScores = pointScores ? new Array(nodeReorderMap.length).fill(NaN) : null;
                for (var ri = 0; ri < nodeReorderMap.length; ri++) {
                    reorderedPoints[nodeReorderMap[ri]] = points[ri] || null;
                    if (reorderedScores && ri < pointScores.length) reorderedScores[nodeReorderMap[ri]] = pointScores[ri];
                }
                points = reorderedPoints;
                pointScores = reorderedScores;
            }

            var inst = new Instance(
                points,
                newTrackIdx,
                instData.type || 'predicted',
                instData.score || 1.0
            );
            if (pointScores) inst.setPointScores(pointScores);
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
