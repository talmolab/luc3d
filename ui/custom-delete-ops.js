// ui/custom-delete-ops.js — pure, DOM-free logic behind "Custom Instance
// Delete…". Mirrors SLEAP's sleap/gui/dialogs/delete.py `DeleteDialog`
// (Labels ▸ Custom Instance Delete…), adapted to LUCID's multi-view model.
//
// This module imports NO project modules — it only calls methods on the Session
// it is handed — so it can be bridged into the browser test runner and unit
// tested in isolation. Same contract as ui/track-identity-ops.js. The DOM modal
// lives in ui/ui-wiring.js and consumes these two functions.
//
// ## Vocabulary (deliberately LUCID's, not SLEAP's)
//
// SLEAP's *video* scope is LUCID's **session**: every camera in a session shares
// one frame index space, so a single camera is a VIEW FILTER, not a frame
// domain.
//
// "Grouped" / "Ungrouped" are the panel headers (`Grouped Instances` /
// `Ungrouped Instances`). The code word for ungrouped is "unlinked"
// (`FrameGroup.unlinkedInstances`, `UnlinkedInstance`), but the UI must never
// say "Unlinked": in SLEAP an *unlinked prediction* means one with no
// `from_predicted` back-link to a user instance — an unrelated concept that
// happens to share the word.
//
// Grouping is ORTHOGONAL to type: a grouped instance is still user or predicted.
// So `type` and `grouping` are separate axes, and "delete grouped instances" is
// expressed as type=all + grouping=grouped.
//
// ## Why deletion needs a store pass
//
// On a lazy project the columnar store is the source of truth. Deleting only
// from `frameGroups`/`instanceGroups` fails twice: `finalizeLazyFrameGroup`
// resurrects any store row with no matching `_rawInstIndex` member into the
// ungrouped pool on the next hydration (no save required), and `appendStore`
// copies the columns verbatim on save. `SioLazyLoader.deleteInstanceRows` is the
// durable half; this module drives it and then mirrors the removal into memory.

/**
 * @typedef {Object} DeleteFilters
 * @property {'user'|'predicted'|'all'} type
 * @property {'any'|'grouped'|'ungrouped'} grouping
 * @property {string|null} view            Camera name, or null for all views.
 * @property {'any'|'none'|'specific'} trackMode
 * @property {number|null} trackIdx        Track index when trackMode==='specific'.
 * @property {'any'|'none'|'specific'} identityMode
 * @property {number|null} identityId      Identity id when identityMode==='specific'.
 * @property {'currentFrame'} frameScope   Session-wide scope lands in phase 2.
 */

/**
 * @typedef {Object} DeleteContext
 * @property {number} currentFrame
 */

// ---------------------------------------------------------------------------
// Matchers (pure)
// ---------------------------------------------------------------------------

function _typeMatches(instType, filterType) {
    if (filterType === 'user') return instType === 'user';
    if (filterType === 'predicted') return instType === 'predicted';
    // 'all' = user + predicted, matching SLEAP's "all instances" (real labels).
    // Reprojections are derived and are never observed labels, so they are not
    // eligible here — they live in `reprojectedInstances`, not `fg.instances`.
    return instType === 'user' || instType === 'predicted';
}

function _trackMatches(inst, filters) {
    if (filters.trackMode === 'any') return true;
    var t = (inst && inst.trackIdx != null && inst.trackIdx >= 0) ? inst.trackIdx : null;
    if (filters.trackMode === 'none') return t === null;
    return t === filters.trackIdx;
}

function _identityMatches(session, camName, inst, frameIdx, filters) {
    if (filters.identityMode === 'any') return true;
    var t = (inst && inst.trackIdx != null && inst.trackIdx >= 0) ? inst.trackIdx : null;
    // Resolve through the PER-FRAME map, not `group.identityId` — the latter is
    // only refreshed on the frame an identity was assigned, so it is stale
    // everywhere else (the #155/#168 class). This is the same call
    // `groupByIdentityAndTriangulateAll` buckets by, so the dialog and the
    // grouping can never disagree.
    var idVal = null;
    if (t != null && session.getIdentityIdForTrack) {
        idVal = session.getIdentityIdForTrack(camName, t, frameIdx);
    }
    if (filters.identityMode === 'none') return idVal == null;
    return idVal === filters.identityId;
}

function _viewMatches(camName, filters) {
    return !filters.view || filters.view === camName;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Find everything a given filter set would delete, plus the cascade the user
 * needs to be warned about. Pure — mutates nothing.
 *
 * The cascade counts matter as much as the instance count: a group must have >=2
 * members, so removing members can dissolve a group (losing its 3D) and can
 * silently PROMOTE a surviving predicted member of a formerly-mixed group to
 * `type='user'`. Reporting only "N instances" hides both.
 *
 * @param {Object} session
 * @param {DeleteFilters} filters
 * @param {DeleteContext} ctx
 * @returns {{targets: Array, count: number, byCamera: Object, groupsDissolved: number,
 *            groupsUngrouped: number, instancesPromoted: number, groupsLosing3d: number}}
 */
export function collectDeletionTargets(session, filters, ctx) {
    var targets = [];
    var byCamera = {};
    if (!session) {
        return { targets: targets, count: 0, byCamera: byCamera, groupsDissolved: 0,
            groupsUngrouped: 0, instancesPromoted: 0, groupsLosing3d: 0 };
    }
    var frames = [ctx.currentFrame];   // phase 1: current frame only

    var bump = function (camName) { byCamera[camName] = (byCamera[camName] || 0) + 1; };

    for (var fi = 0; fi < frames.length; fi++) {
        var frameIdx = frames[fi];
        var fg = session.getFrameGroup ? session.getFrameGroup(frameIdx) : session.frameGroups.get(frameIdx);

        // --- grouped members (InstanceGroup members) ---
        if (filters.grouping !== 'ungrouped') {
            var groups = session.instanceGroups.get(frameIdx) || [];
            for (var gi = 0; gi < groups.length; gi++) {
                var group = groups[gi];
                for (var [camName, inst] of group.instances) {
                    if (!inst) continue;
                    if (!_viewMatches(camName, filters)) continue;
                    if (!_typeMatches(inst.type, filters.type)) continue;
                    if (!_trackMatches(inst, filters)) continue;
                    if (!_identityMatches(session, camName, inst, frameIdx, filters)) continue;
                    targets.push({
                        kind: 'grouped', frameIdx: frameIdx, camName: camName,
                        group: group, inst: inst,
                        rawIdx: inst._rawInstIndex != null ? inst._rawInstIndex : null,
                    });
                    bump(camName);
                }
            }
        }

        // --- ungrouped instances (the UnlinkedInstance pool) ---
        if (filters.grouping !== 'grouped' && fg) {
            for (var [ulCam, ulList] of fg.unlinkedInstances) {
                if (!_viewMatches(ulCam, filters)) continue;
                for (var ui = 0; ui < ulList.length; ui++) {
                    var ul = ulList[ui];
                    var uInst = ul && ul.instance;
                    if (!uInst) continue;
                    if (!_typeMatches(uInst.type, filters.type)) continue;
                    if (!_trackMatches(uInst, filters)) continue;
                    if (!_identityMatches(session, ulCam, uInst, frameIdx, filters)) continue;
                    targets.push({
                        kind: 'ungrouped', frameIdx: frameIdx, camName: ulCam,
                        ul: ul, inst: uInst,
                        rawIdx: uInst._rawInstIndex != null ? uInst._rawInstIndex : null,
                    });
                    bump(ulCam);
                }
            }
        }
    }

    var cascade = previewCascade(targets);
    return {
        targets: targets,
        count: targets.length,
        byCamera: byCamera,
        groupsDissolved: cascade.groupsDissolved,
        groupsUngrouped: cascade.groupsUngrouped,
        instancesPromoted: cascade.instancesPromoted,
        groupsLosing3d: cascade.groupsLosing3d,
    };
}

/**
 * Work out, without mutating anything, what the >=2-member invariant will do to
 * the groups these targets touch.
 *
 * - remaining 0 -> the group is dissolved (`removeInstanceGroup`).
 * - remaining 1 -> the group is auto-ungrouped (`unlinkGroup`); the lone
 *   survivor returns to the ungrouped pool, and if the group was MIXED
 *   (user + predicted) before the delete, a predicted survivor is promoted to
 *   `type='user', modified=true`.
 * - remaining >=2 -> the group survives but its 3D is stale, so it is purged
 *   and marked dirty.
 */
export function previewCascade(targets) {
    var buckets = new Map();   // group -> {group, cams:Set}
    for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (t.kind !== 'grouped') continue;
        var b = buckets.get(t.group);
        if (!b) { b = { group: t.group, cams: new Set() }; buckets.set(t.group, b); }
        b.cams.add(t.camName);
    }
    var groupsDissolved = 0, groupsUngrouped = 0, instancesPromoted = 0, groupsLosing3d = 0;
    for (var [group, bucket] of buckets) {
        var removing = 0;
        for (var cam of bucket.cams) if (group.instances.has(cam)) removing++;
        var remaining = group.instances.size - removing;
        var had3d = !!(group.points3d && group.points3d.length);
        if (remaining <= 0) {
            groupsDissolved++;
            if (had3d) groupsLosing3d++;
        } else if (remaining === 1) {
            groupsUngrouped++;
            if (had3d) groupsLosing3d++;
            // Was it mixed before the delete, and is the survivor predicted?
            var hasUser = false, hasPred = false, survivor = null;
            for (var [c2, i2] of group.instances) {
                if (!i2) continue;
                if (i2.type === 'user') hasUser = true;
                else if (i2.type === 'predicted') hasPred = true;
                if (!bucket.cams.has(c2)) survivor = i2;
            }
            if (hasUser && hasPred && survivor && survivor.type === 'predicted') instancesPromoted++;
        } else {
            if (had3d) groupsLosing3d++;
        }
    }
    return {
        groupsDissolved: groupsDissolved,
        groupsUngrouped: groupsUngrouped,
        instancesPromoted: instancesPromoted,
        groupsLosing3d: groupsLosing3d,
    };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Apply a deletion durably. Order is load-bearing — see
 * scratch/PLAN-custom-instance-delete.md §5.2:
 *
 *   1. store rows (the persistence; must run BEFORE `_rawInstIndex` is touched,
 *      since the row identity IS `_rawInstIndex`)
 *   2. renumber `_rawInstIndex` on survivors
 *   3. `instanceGroups` cascade (project-wide)
 *   4. `frameGroups` cascade (resident) under the SAME `seen` Set
 *   5. `frameIdentityMap` prune
 *
 * Step 4 shares `seen` with step 3 because a hydrated frame's `fg.instances`
 * entries are usually the SAME objects as that frame's `instanceGroups` members
 * — the #195 lesson. (Removal is idempotent per container so `seen` is belt and
 * braces here, but the invariant is preserved deliberately: any future
 * field-mutating step added to these passes would silently self-cancel without
 * it.)
 *
 * App-level triangulation caches are NOT touched here (this module is import
 * free): the caller must run `purgeTriangulationDataForGroup(frameIdx, group)`
 * over the returned `purgedGroups`.
 *
 * @param {Object} session
 * @param {Array} targets  from `collectDeletionTargets`
 * @returns {{deleted: number, durable: number|null, errorRows: number, firstError: Error|null,
 *            purgedGroups: Array, groupsDissolved: number, groupsUngrouped: number,
 *            instancesPromoted: number, touchedFrames: Array<number>}}
 */
export function executeDeletion(session, targets) {
    var purgedGroups = [];
    var result = {
        deleted: 0, durable: null, errorRows: 0, firstError: null,
        purgedGroups: purgedGroups, groupsDissolved: 0, groupsUngrouped: 0,
        instancesPromoted: 0, touchedFrames: [],
    };
    if (!session || !targets || targets.length === 0) return result;

    // ---- 0. Index the kill set by (camera, frame) -> Set<rawInstIndex>.
    // Captured BEFORE any mutation: a store row's identity is its offset within
    // its (camera, frame) list, i.e. exactly `_rawInstIndex`.
    var killByCam = new Map();
    var touched = new Set();
    for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        touched.add(t.frameIdx);
        if (t.rawIdx == null) continue;   // memory-only instance (never came from the store)
        if (!killByCam.has(t.camName)) killByCam.set(t.camName, new Map());
        var perFrame = killByCam.get(t.camName);
        if (!perFrame.has(t.frameIdx)) perFrame.set(t.frameIdx, new Set());
        perFrame.get(t.frameIdx).add(t.rawIdx);
    }
    result.touchedFrames = Array.from(touched);

    // ---- 1. THE PERSISTENCE. Remove the rows from the columnar store.
    if (session.lazyLoader && typeof session.lazyLoader.deleteInstanceRows === 'function' &&
        killByCam.size > 0) {
        var storeRes = session.lazyLoader.deleteInstanceRows(
            function (camName, frameIdx, offsetInFrame) {
                var pf = killByCam.get(camName);
                if (!pf) return false;
                var set = pf.get(frameIdx);
                return !!set && set.has(offsetInFrame);
            }
        );
        result.durable = storeRes.deleted;
        result.errorRows = storeRes.errorRows;
        result.firstError = storeRes.firstError;
    }

    // ---- 2. Renumber `_rawInstIndex` on every SURVIVING instance of each
    // touched (camera, frame). The store just compacted, so an unchanged
    // `_rawInstIndex` would make `refFor` write grouping refs pointing at the
    // wrong instances and make `finalizeLazyFrameGroup` hydrate the wrong 2D
    // into group members. New index = old index minus the number of deleted
    // rows before it.
    if (killByCam.size > 0) {
        var seenRenumber = new Set();
        var shiftFor = function (killSet, oldIdx) {
            var shift = 0;
            for (var k of killSet) if (k < oldIdx) shift++;
            return shift;
        };
        var renumberInst = function (inst, killSet) {
            if (!inst || seenRenumber.has(inst)) return;
            seenRenumber.add(inst);
            if (inst._rawInstIndex == null) return;
            if (killSet.has(inst._rawInstIndex)) return;   // being deleted; leave it
            inst._rawInstIndex = inst._rawInstIndex - shiftFor(killSet, inst._rawInstIndex);
        };
        for (var [rCam, rPerFrame] of killByCam) {
            for (var [rFrame, rKill] of rPerFrame) {
                var rGroups = session.instanceGroups.get(rFrame) || [];
                for (var rgi = 0; rgi < rGroups.length; rgi++) {
                    var gInst = rGroups[rgi].instances.get(rCam);
                    if (gInst) renumberInst(gInst, rKill);
                }
                var rFg = session.getFrameGroup ? session.getFrameGroup(rFrame) : session.frameGroups.get(rFrame);
                if (!rFg) continue;
                var rArr = rFg.instances.get(rCam);
                if (rArr) for (var ai = 0; ai < rArr.length; ai++) renumberInst(rArr[ai], rKill);
                var rUl = rFg.unlinkedInstances.get(rCam);
                if (rUl) for (var uj = 0; uj < rUl.length; uj++) renumberInst(rUl[uj] && rUl[uj].instance, rKill);
            }
        }
    }

    // ---- 3 + 4. Memory cascade, grouped targets bucketed by group so the
    // full/lone-survivor/partial decision is made ONCE per group.
    var seen = new Set();
    var groupBuckets = new Map();
    var ungroupedTargets = [];
    for (var bi = 0; bi < targets.length; bi++) {
        var bt = targets[bi];
        if (bt.kind === 'ungrouped') { ungroupedTargets.push(bt); continue; }
        var gb = groupBuckets.get(bt.group);
        if (!gb) {
            gb = { group: bt.group, frameIdx: bt.frameIdx, cams: new Set() };
            groupBuckets.set(bt.group, gb);
        }
        gb.cams.add(bt.camName);
    }

    for (var [bGroup, bucket] of groupBuckets) {
        var frameIdx2 = bucket.frameIdx;

        // Snapshot mixed state BEFORE removing anything, so an auto-ungroup of a
        // formerly-mixed group still promotes the survivor to user — the
        // contract pinned by tests/test-delete-auto-ungroup.js.
        var hadUser = false, hadPred = false;
        for (var [, mInst] of bGroup.instances) {
            if (!mInst) continue;
            if (mInst.type === 'user') hadUser = true;
            else if (mInst.type === 'predicted') hadPred = true;
        }
        var wasMixed = hadUser && hadPred;

        var removeCams = [];
        for (var rc of bucket.cams) if (bGroup.instances.has(rc)) removeCams.push(rc);
        var remaining = bGroup.instances.size - removeCams.length;

        if (remaining <= 0) {
            session.removeInstanceGroup(frameIdx2, bGroup);
            result.deleted += removeCams.length;
            result.groupsDissolved++;
            purgedGroups.push({ frameIdx: frameIdx2, group: bGroup });
            continue;
        }

        var fg2 = session.getFrameGroup ? session.getFrameGroup(frameIdx2) : session.frameGroups.get(frameIdx2);
        for (var rci = 0; rci < removeCams.length; rci++) {
            var cam2 = removeCams[rci];
            var victim = bGroup.instances.get(cam2);
            if (seen.has(victim)) { /* already unhooked via another container */ }
            seen.add(victim);
            bGroup.instances.delete(cam2);
            // NEVER touch group.observedPoints — it is a read-only getter since
            // #189 and assigning throws a TypeError in every ES module. It is
            // derived from group.instances, so the line above is what updates it.
            if (fg2) {
                var arr2 = fg2.instances.get(cam2);
                if (arr2) {
                    var at = arr2.indexOf(victim);
                    if (at >= 0) arr2.splice(at, 1);
                    if (arr2.length === 0) fg2.instances.delete(cam2);
                }
            }
            result.deleted++;
        }

        if (bGroup.instances.size === 0) {
            session.removeInstanceGroup(frameIdx2, bGroup);
            result.groupsDissolved++;
        } else if (bGroup.instances.size === 1) {
            // A group must have >=2 members — auto-ungroup the lone survivor.
            session.unlinkGroup(frameIdx2, bGroup, wasMixed);
            result.groupsUngrouped++;
            if (wasMixed) result.instancesPromoted++;
        } else {
            bGroup.points3d = null;
            bGroup.usedCameras = null;
            if (typeof bGroup.markDirty === 'function') bGroup.markDirty();
            else bGroup.dirty = true;
        }
        purgedGroups.push({ frameIdx: frameIdx2, group: bGroup });
    }

    for (var ut = 0; ut < ungroupedTargets.length; ut++) {
        var uTarget = ungroupedTargets[ut];
        var uFg = session.getFrameGroup ? session.getFrameGroup(uTarget.frameIdx)
            : session.frameGroups.get(uTarget.frameIdx);
        if (uFg && typeof uFg.removeUnlinkedById === 'function') {
            uFg.removeUnlinkedById(uTarget.ul.id);
            result.deleted++;
        }
    }

    // ---- 5. Prune orphaned frameIdentityMap entries. Two reasons this is not
    // cosmetic: the map is serialized into the .slp, so residue ships and can
    // re-attach a ghost identity to a later instance reusing the same
    // (frame, camera, track); and `ensureGroupsFromIdentities` RECREATES groups
    // from this map for any frame with no instanceGroups entry, so an unpruned
    // entry brings a deleted group back on the next Triangulate All.
    pruneOrphanIdentities(session, result.touchedFrames);

    return result;
}

/**
 * Drop `frameIdentityMap` entries for (frame, camera, track) triples that no
 * longer have any instance. Must go through `deleteFrameIdentity` — the keys are
 * PACKED NUMBERS since #185, so the old `frameIdx + ':' + cam + ':' + track`
 * string comparison silently matches nothing.
 */
export function pruneOrphanIdentities(session, frameIndices) {
    if (!session || !session.frameIdentityMap || !session.deleteFrameIdentity) return 0;
    var pruned = 0;
    for (var fi = 0; fi < frameIndices.length; fi++) {
        var frameIdx = frameIndices[fi];
        // Live (camera, trackIdx) pairs remaining on this frame.
        var live = new Set();
        var note = function (camName, inst) {
            if (!inst || inst.trackIdx == null || inst.trackIdx < 0) return;
            live.add(camName + ' ' + inst.trackIdx);
        };
        var groups = session.instanceGroups.get(frameIdx) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            for (var [gc, gInst] of groups[gi].instances) note(gc, gInst);
        }
        var fg = session.getFrameGroup ? session.getFrameGroup(frameIdx) : session.frameGroups.get(frameIdx);
        if (fg) {
            for (var [fc, arr] of fg.instances) for (var ai = 0; ai < arr.length; ai++) note(fc, arr[ai]);
            for (var [uc, uarr] of fg.unlinkedInstances) {
                for (var ui = 0; ui < uarr.length; ui++) note(uc, uarr[ui] && uarr[ui].instance);
            }
        }
        // Candidate triples: every (camera, track) this frame could hold. Derived
        // from the session's cameras x tracks rather than by scanning the packed
        // map, so this needs no knowledge of the key encoding.
        var cams = (session.cameras || []).map(function (c) { return c.name; });
        var nTracks = (session.tracks || []).length;
        for (var ci = 0; ci < cams.length; ci++) {
            for (var ti = 0; ti < nTracks; ti++) {
                if (live.has(cams[ci] + ' ' + ti)) continue;
                if (session.hasFrameIdentity && !session.hasFrameIdentity(frameIdx, cams[ci], ti)) continue;
                if (session.deleteFrameIdentity(frameIdx, cams[ci], ti)) pruned++;
            }
        }
    }
    return pruned;
}
