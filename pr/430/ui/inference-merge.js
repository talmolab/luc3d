/**
 * ui/inference-merge.js — bring one view's sleap-nn predictions into the open
 * project through LUCID's SLP import path.
 *
 * The predictions `.slp` (one video) is parsed by `parseSlpForImport`, its
 * skeleton checked with `validateSkeletonCompatibility` (same node names, any
 * order), and its instances added to that view as UNGROUPED predicted
 * instances (`mergePredictionsIntoCamera`). Run Track ▸ All frames afterwards
 * to group them across views and triangulate.
 *
 * "Existing predictions" (sleap-app's choice, applied to THIS view only):
 *   - replace:   delete this view's predicted instances on the frames that got
 *                new ones, then add;
 *   - clear_all: delete every predicted instance of this view first;
 *   - keep:      add on top.
 * User instances are never deleted or changed (the delete filter is
 * type = predicted). Deletion goes through the Custom Delete path
 * (`collectDeletionTargets` + `executeDeletion`), which also removes the rows
 * from a lazy project's store; a lazy project's affected frames are hydrated
 * before anything is added (`batchLoadLazyFrames`).
 *
 * sleap-nn's own tracks (Tracking section) are per video: they are imported
 * named `<view>: <track>` so two views' `track_0` never become one LUCID track.
 */
import { state, timeline, viewport3d, interactionManager } from './app-state.js?v=6a08874aa4a2';
import { parseSlpForImport } from '../import-export/slp-import.js?v=6a08874aa4a2';
import {
    validateSkeletonCompatibility, mergeTracksIntoSession, mergePredictionsIntoCamera,
} from '../import-export/slp-merge.js?v=6a08874aa4a2';
import { collectDeletionTargets, executeDeletion } from './custom-delete-ops.js?v=6a08874aa4a2';
import { batchLoadLazyFrames, updateTimelineForFrame, getInstanceGroupsForFrame } from '../pose/triangulation.js?v=6a08874aa4a2';
import { purgeTriangulationDataForGroup } from './identity-assignment.js?v=6a08874aa4a2';
import { markDirty } from '../import-export/save-load.js?v=6a08874aa4a2';
import { drawAllOverlays } from './rendering.js?v=6a08874aa4a2';
import { updateInfoPanel } from './info-panel.js?v=6a08874aa4a2';

/** Contiguous runs of sorted frame indices: [[start, count], …]. */
export function frameRuns(frames) {
    var runs = [];
    for (var i = 0; i < frames.length;) {
        var j = i;
        while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
        runs.push([frames[i], j - i + 1]);
        i = j + 1;
    }
    return runs;
}

function deleteViewPredictions(session, camName, onlyFrames) {
    var found = collectDeletionTargets(session, {
        type: 'predicted', grouping: 'any', view: camName,
        trackMode: 'any', trackIdx: null, identityMode: 'any', identityId: null,
        frameScope: 'currentSession',
    }, { currentFrame: state.currentFrame });
    var targets = found.targets;
    if (onlyFrames) targets = targets.filter(function (t) { return onlyFrames.has(t.frameIdx); });
    if (targets.length === 0) return { deleted: 0, touchedFrames: [] };
    if (interactionManager) interactionManager.clearSelection();
    var res = executeDeletion(session, targets);
    res.purgedGroups.forEach(function (p) { purgeTriangulationDataForGroup(p.frameIdx, p.group); });
    if (res.errorRows > 0) throw new Error(res.errorRows + ' old prediction row(s) could not be removed');
    return { deleted: res.durable != null ? res.durable : res.deleted, touchedFrames: res.touchedFrames };
}

/**
 * Merge a predictions file into view `camName` of the current session.
 *
 * @param {File} file  the predictions `.slp`
 * @param {string} camName
 * @param {'replace'|'clear_all'|'keep'} mode
 * @returns {Promise<{instances:number, frames:number, deleted:number}>}
 */
export async function mergeViewPredictions(file, camName, mode) {
    var session = state.session;
    if (!session) throw new Error('No project is open');
    if (!session.cameras.some(function (c) { return c.name === camName; })) {
        throw new Error('View ' + camName + ' is not in the current session');
    }
    var slpData = await parseSlpForImport(file, function () {});
    var incoming = slpData.skeleton || { nodes: [] };
    var skel = validateSkeletonCompatibility(session.skeleton, { nodes: incoming.nodes || [] });
    if (skel.error) throw new Error('Skeleton mismatch: ' + skel.error);

    var newFrames = new Set();
    slpData.frames.forEach(function (fd) {
        if (fd.instances.some(function (d) { return !d.type || d.type === 'predicted'; })) newFrames.add(fd.frameIdx);
    });

    var deleted = 0, touched = [];
    if (mode === 'clear_all' || mode === 'replace') {
        var del = deleteViewPredictions(session, camName, mode === 'replace' ? newFrames : null);
        deleted = del.deleted;
        touched = del.touchedFrames;
    }

    if (session.lazyLoader) {
        var sorted = Array.from(newFrames).sort(function (a, b) { return a - b; });
        var runs = frameRuns(sorted);
        for (var r = 0; r < runs.length; r++) await batchLoadLazyFrames(runs[r][0], runs[r][1]);
    }

    var trackNames = (slpData.tracks || []).map(function (t) {
        return camName + ': ' + (typeof t === 'string' ? t : (t && t.name) || 'track');
    });
    var trackRemap = mergeTracksIntoSession(session, trackNames);
    var merged = mergePredictionsIntoCamera(session, slpData, camName, {
        trackRemap: trackRemap, nodeReorderMap: skel.reorderMap,
    });

    markDirty();
    var allTouched = new Set(touched.concat(merged.frames));
    allTouched.forEach(function (f) { updateTimelineForFrame(f); });
    if (timeline) {
        timeline.setData(session);
        if (typeof timeline.refreshTracks === 'function') timeline.refreshTracks(session, { cap: true });
    }
    if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
    drawAllOverlays(state.currentFrame);
    updateInfoPanel();
    return { instances: merged.instances, frames: merged.frames.length, deleted: deleted };
}
