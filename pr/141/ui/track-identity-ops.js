/**
 * track-identity-ops.js — pure (DOM-free) operations backing the Track /
 * Identity menu modals in `ui/ui-wiring.js` (New / Rename / Delete).
 *
 * These are deliberately dependency-free (they operate on a passed-in
 * `session`) so they can be unit-tested headlessly. The modals themselves
 * live in `ui/ui-wiring.js`, which can't be loaded in the test runner because
 * of its `app.js` import graph — so the substantive logic lives here instead.
 *
 * `session` shape used here:
 *   - tracks: string[]
 *   - identities: { id:number, name:string }[]
 *   - cameras: { name:string }[]
 *   - frameGroups: Map<frameIdx, { instances: Map<cam, Instance[]>,
 *                                  unlinkedInstances: Map<cam, {instance}[]> }>
 *   - instanceGroups: Map<frameIdx, { identityId:number,
 *                                     instances: Map<cam, Instance> }[]>
 *   - _hiddenTracks?: Set<string>, _hiddenIdentities?: Set<string>
 */

/**
 * @param {'track'|'identity'} kind
 * @returns {boolean} true if a track/identity with this exact name exists.
 */
export function nameExists(session, kind, name) {
    if (kind === 'track') {
        return session.tracks.indexOf(name) >= 0;
    }
    return session.identities.some(function (id) { return id.name === name; });
}

/**
 * Count, per camera, the instances that will lose their track/identity when
 * the track/identity at `idx` is deleted.
 *
 * Track: instances (grouped + unlinked) whose `trackIdx === idx`.
 * Identity: instances (grouped + unlinked) whose per-frame identity
 *   (`getIdentityIdForTrack(cam, trackIdx, frameIdx)`) is `identities[idx].id`.
 *   The per-frame map — NOT `group.identityId` — is the canonical per-instance
 *   identity source (group.identityId is only set once triangulated/grouped),
 *   so it is what we count.
 *
 * @param {'track'|'identity'} kind
 * @returns {{ perCamera: Object<string,number>, total: number }}
 */
export function countNulledByCamera(session, kind, idx) {
    var perCamera = {};
    (session.cameras || []).forEach(function (c) { perCamera[c.name] = 0; });
    var total = 0;

    if (kind === 'track') {
        for (var [, fg] of session.frameGroups) {
            for (var [cn, insts] of fg.instances) {
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === idx) {
                        perCamera[cn] = (perCamera[cn] || 0) + 1;
                        total++;
                    }
                }
            }
            for (var [cn2, ulList] of fg.unlinkedInstances) {
                for (var u = 0; u < ulList.length; u++) {
                    if (ulList[u].instance.trackIdx === idx) {
                        perCamera[cn2] = (perCamera[cn2] || 0) + 1;
                        total++;
                    }
                }
            }
        }
    } else {
        var identityId = session.identities[idx].id;
        for (var [frameIdx, fg2] of session.frameGroups) {
            for (var [cnA, instsA] of fg2.instances) {
                for (var ia = 0; ia < instsA.length; ia++) {
                    if (instsA[ia].trackIdx == null) continue;
                    if (session.getIdentityIdForTrack(cnA, instsA[ia].trackIdx, frameIdx) === identityId) {
                        perCamera[cnA] = (perCamera[cnA] || 0) + 1;
                        total++;
                    }
                }
            }
            for (var [cnB, ulB] of fg2.unlinkedInstances) {
                for (var ib = 0; ib < ulB.length; ib++) {
                    var tiB = ulB[ib].instance.trackIdx;
                    if (tiB == null) continue;
                    if (session.getIdentityIdForTrack(cnB, tiB, frameIdx) === identityId) {
                        perCamera[cnB] = (perCamera[cnB] || 0) + 1;
                        total++;
                    }
                }
            }
        }
    }

    return { perCamera: perCamera, total: total };
}

/**
 * Delete the track at `idx`: remove it from `session.tracks`, null every
 * instance that referenced it, and shift higher `trackIdx` values down by one
 * (so indices stay aligned with the shortened array). Drops the name from the
 * hidden-tracks set if present.
 *
 * Any GroupedInstance that used the deleted track is first **ungrouped** (its
 * members return to the unlinked pool); those members are then nulled to "no
 * track" by the remap pass like any other instance.
 *
 * @returns {string} the deleted track's name.
 */
export function deleteTrackAt(session, idx) {
    var name = session.tracks[idx];

    // Ungroup any GroupedInstance that uses the deleted track — deleting a
    // track dissolves its groups and leaves the members trackless. Collect the
    // groups first (don't mutate instanceGroups while iterating), then unlink.
    if (session.instanceGroups && session.unlinkGroup) {
        var trackGroups = [];
        for (var [tfi, tgroups] of session.instanceGroups) {
            for (var tg = 0; tg < tgroups.length; tg++) {
                var usesTrack = false;
                for (var [, tInst] of tgroups[tg].instances) {
                    if (tInst.trackIdx === idx) { usesTrack = true; break; }
                }
                if (usesTrack) trackGroups.push([tfi, tgroups[tg]]);
            }
        }
        for (var tgi = 0; tgi < trackGroups.length; tgi++) {
            session.unlinkGroup(trackGroups[tgi][0], trackGroups[tgi][1]);
        }
    }

    session.tracks.splice(idx, 1);
    // Instances on the deleted track become trackless (`null` — the app-wide
    // trackless sentinel; NOT -1, which would index past TRACK_COLORS and crash
    // the renderer). Higher trackIdx values shift down to stay aligned with the
    // shortened array. A `seen` set guards against processing a shared instance
    // twice: grouped (instanceGroups) instances normally share object refs with
    // frameGroups, and double-decrementing would corrupt their trackIdx.
    var seen = new Set();
    function retrack(inst) {
        if (!inst || seen.has(inst)) return;
        seen.add(inst);
        if (inst.trackIdx === idx) inst.trackIdx = null;
        else if (inst.trackIdx > idx) inst.trackIdx--;
    }
    for (var [, fg] of session.frameGroups) {
        for (var [, insts] of fg.instances) {
            for (var i = 0; i < insts.length; i++) retrack(insts[i]);
        }
        for (var [, ulList] of fg.unlinkedInstances) {
            for (var u = 0; u < ulList.length; u++) retrack(ulList[u].instance);
        }
    }
    // GroupedInstances explicitly — so a deleted track never lingers on a
    // grouped instance even if (in some load path) it isn't in frameGroups.
    if (session.instanceGroups) {
        for (var [, groups] of session.instanceGroups) {
            for (var gi = 0; gi < groups.length; gi++) {
                for (var [, gInst] of groups[gi].instances) retrack(gInst);
            }
        }
    }
    // Per-frame identities are keyed "frame:cam:trackIdx", so they must follow
    // the same trackIdx remap or they'd orphan/misattribute: an instance keeps
    // its identity when it loses its track. Entries on the deleted track move to
    // the trackless (`null`) key so the identity stays attached to the now-
    // trackless instance; entries on higher tracks shift down by one. (Grouped
    // instances also carry identity on `group.identityId`, left untouched.)
    if (session.frameIdentityMap) {
        var remapped = new Map();
        for (var [key, val] of session.frameIdentityMap) {
            var parts = key.split(':');
            var t = parseInt(parts[parts.length - 1], 10);
            var newT;
            if (t === idx) newT = 'null';
            else if (t > idx) newT = String(t - 1);
            else newT = String(t);
            var prefix = parts.slice(0, parts.length - 1).join(':');
            remapped.set(prefix + ':' + newT, val);
        }
        session.frameIdentityMap = remapped;
    }
    if (session._hiddenTracks) session._hiddenTracks.delete(name);
    return name;
}

/**
 * Delete the identity at `idx`: **ungroup** every GroupedInstance carrying its
 * id (group-level OR via the per-frame map), clear the per-frame identity, then
 * remove it from `session.identities`. Identities are keyed by stable `.id`, so
 * no index shifting is needed. Drops the name from the hidden-identities set if
 * present.
 *
 * @returns {string} the deleted identity's name.
 */
export function deleteIdentityAt(session, idx) {
    var identity = session.identities[idx];

    // A group carries this identity if its group-level identityId matches, or
    // (pre-triangulation, when group.identityId is unset) if any member's
    // per-frame identity resolves to it. Such groups are ungrouped — deleting
    // an identity dissolves its groups and leaves the members identity-less.
    var idGroups = [];
    for (var [ifi, igroups] of session.instanceGroups) {
        for (var ig = 0; ig < igroups.length; ig++) {
            var grp = igroups[ig];
            var carries = grp.identityId === identity.id;
            if (!carries && session.getIdentityIdForTrack) {
                for (var [icam, iInst] of grp.instances) {
                    if (iInst.trackIdx == null) continue;
                    if (session.getIdentityIdForTrack(icam, iInst.trackIdx, ifi) === identity.id) {
                        carries = true;
                        break;
                    }
                }
            }
            if (carries) idGroups.push([ifi, grp]);
        }
    }
    if (session.unlinkGroup) {
        for (var igi = 0; igi < idGroups.length; igi++) {
            session.unlinkGroup(idGroups[igi][0], idGroups[igi][1]);
        }
    } else {
        // Fallback for sessions without unlinkGroup: unassign in place.
        for (var igj = 0; igj < idGroups.length; igj++) idGroups[igj][1].identityId = null;
    }

    // Clear the canonical per-frame per-track identity assignments pointing at
    // it, so those instances actually resolve to "no identity" (matches the
    // count + the modal's "instances will have null identity" warning).
    if (session.frameIdentityMap) {
        for (var [k, v] of session.frameIdentityMap) {
            if (v === identity.id) session.frameIdentityMap.delete(k);
        }
    }
    session.identities.splice(idx, 1);
    if (session._hiddenIdentities) session._hiddenIdentities.delete(identity.name);
    return identity.name;
}
