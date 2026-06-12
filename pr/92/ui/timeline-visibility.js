/**
 * ui/timeline-visibility.js — per-session timeline visibility toggles.
 *
 * Block 2 of Prompt 4. Owns the toggle semantics that the Info Panel ↔
 * Timeline contract relies on. Three independent hidden-sets live ON the
 * `Session` object (so toggles persist across mode switches and stay
 * isolated between sessions):
 *
 *   session._hiddenCameras    — Set<cameraName>
 *   session._hiddenTracks     — Set<trackName>
 *   session._hiddenIdentities — Set<identityName>
 *
 * `_hiddenCameras` takes precedence — a hidden camera hides EVERY row in
 * its tree, regardless of per-track / per-identity toggle state.
 *
 * State is in-memory only (per the user's clarification — no localStorage
 * persistence across reloads). Renames migrate hidden-set membership from
 * the old name to the new name; deletes leave the stale entry harmlessly
 * (it just never matches anything).
 *
 * Exports a flat set of helpers (`toggle*`, `is*Visible`, `list*`,
 * `get*VisibilityList`, `rename*`) that the Info Panel wiring and (live
 * code in `ui/timeline.js` separately) consume. The module has NO
 * transitive imports so it loads cleanly in the node test runner sandbox.
 *
 * Mirrors its exports onto `window.TimelineVisibility` and individual
 * `window.toggleCameraVisibility` / … globals (when `window` exists) so
 * the VAPI test in `tests/test-timeline-visibility-list.js` can resolve
 * them in either form.
 */

// ----------------------------------------------------------------------------
// Internal — lazy-init the per-session hidden Sets.
// ----------------------------------------------------------------------------

function ensureHiddenSets(session) {
    if (!session) return;
    if (!session._hiddenCameras) session._hiddenCameras = new Set();
    if (!session._hiddenTracks) session._hiddenTracks = new Set();
    if (!session._hiddenIdentities) session._hiddenIdentities = new Set();
}

// ----------------------------------------------------------------------------
// Toggle helpers — flip Set membership, return the new VISIBLE boolean.
// ----------------------------------------------------------------------------

function toggleCameraVisibility(session, camName) {
    ensureHiddenSets(session);
    var set = session._hiddenCameras;
    if (set.has(camName)) {
        set.delete(camName);
        return true;   // now visible
    }
    set.add(camName);
    return false;      // now hidden
}

function toggleTrackVisibility(session, trackName) {
    ensureHiddenSets(session);
    var set = session._hiddenTracks;
    if (set.has(trackName)) {
        set.delete(trackName);
        return true;
    }
    set.add(trackName);
    return false;
}

function toggleIdentityVisibility(session, identityName) {
    ensureHiddenSets(session);
    var set = session._hiddenIdentities;
    if (set.has(identityName)) {
        set.delete(identityName);
        return true;
    }
    set.add(identityName);
    return false;
}

// ----------------------------------------------------------------------------
// Visibility queries — return `true` if the entity is NOT hidden.
// ----------------------------------------------------------------------------

function isCameraVisible(session, camName) {
    ensureHiddenSets(session);
    return !session._hiddenCameras.has(camName);
}

function isTrackVisible(session, trackName) {
    ensureHiddenSets(session);
    return !session._hiddenTracks.has(trackName);
}

function isIdentityVisible(session, identityName) {
    ensureHiddenSets(session);
    return !session._hiddenIdentities.has(identityName);
}

// ----------------------------------------------------------------------------
// Source-list helpers — enumerate every entity for the Visibility tab.
// These read live from `session` so newly added entries appear immediately
// and deleted ones drop out.
// ----------------------------------------------------------------------------

function listCamerasForVisibility(session) {
    if (!session || !session.cameras) return [];
    var names = [];
    var i;
    if (Array.isArray(session._uploadedCameras)) {
        var allowed = {};
        for (i = 0; i < session._uploadedCameras.length; i++) {
            allowed[session._uploadedCameras[i]] = true;
        }
        for (i = 0; i < session.cameras.length; i++) {
            var cn = session.cameras[i].name;
            if (allowed[cn]) names.push(cn);
        }
    } else {
        for (i = 0; i < session.cameras.length; i++) {
            names.push(session.cameras[i].name);
        }
    }
    return names;
}

function listTracksForVisibility(session) {
    if (!session || !session.tracks) return [];
    return session.tracks.slice();
}

function listIdentitiesForVisibility(session) {
    if (!session || !session.identities) return [];
    var out = [];
    for (var i = 0; i < session.identities.length; i++) {
        out.push(session.identities[i].name);
    }
    return out;
}

// ----------------------------------------------------------------------------
// Visibility-list helpers — return `[{ name, visible, … }]` suitable for
// rendering the Visibility tab's toggle rows.
// ----------------------------------------------------------------------------

function getCameraVisibilityList(session) {
    ensureHiddenSets(session);
    var names = listCamerasForVisibility(session);
    var out = [];
    for (var i = 0; i < names.length; i++) {
        out.push({ name: names[i], visible: !session._hiddenCameras.has(names[i]) });
    }
    return out;
}

function getTrackVisibilityList(session) {
    ensureHiddenSets(session);
    var names = listTracksForVisibility(session);
    var out = [];
    for (var i = 0; i < names.length; i++) {
        out.push({ name: names[i], visible: !session._hiddenTracks.has(names[i]) });
    }
    return out;
}

function getIdentityVisibilityList(session) {
    ensureHiddenSets(session);
    var out = [];
    if (!session || !session.identities) return out;
    for (var i = 0; i < session.identities.length; i++) {
        var ident = session.identities[i];
        out.push({
            id: ident.id,
            name: ident.name,
            color: ident.color || null,
            visible: !session._hiddenIdentities.has(ident.name),
        });
    }
    return out;
}

// ----------------------------------------------------------------------------
// Rename migration — keep the hidden-set membership in sync with renames.
// Idempotent: if the old name isn't hidden, nothing happens.
// ----------------------------------------------------------------------------

function renameHiddenTrack(session, oldName, newName) {
    ensureHiddenSets(session);
    if (!session._hiddenTracks.has(oldName)) return;
    session._hiddenTracks.delete(oldName);
    session._hiddenTracks.add(newName);
}

function renameHiddenIdentity(session, oldName, newName) {
    ensureHiddenSets(session);
    if (!session._hiddenIdentities.has(oldName)) return;
    session._hiddenIdentities.delete(oldName);
    session._hiddenIdentities.add(newName);
}

// ----------------------------------------------------------------------------
// ESM exports
// ----------------------------------------------------------------------------

export {
    ensureHiddenSets,
    toggleCameraVisibility,
    toggleTrackVisibility,
    toggleIdentityVisibility,
    isCameraVisible,
    isTrackVisible,
    isIdentityVisible,
    listCamerasForVisibility,
    listTracksForVisibility,
    listIdentitiesForVisibility,
    getCameraVisibilityList,
    getTrackVisibilityList,
    getIdentityVisibilityList,
    renameHiddenTrack,
    renameHiddenIdentity,
};

// ----------------------------------------------------------------------------
// Browser/test-sandbox global mirroring. The headless node runner exposes
// each script's top-level `var` declarations onto the sandbox global, but
// the VAPI test specifically probes `window.toggleCameraVisibility` and
// `globalThis.TimelineVisibility.toggleCameraVisibility`. Mirror both
// shapes so resolution succeeds in either form. Guarded with `typeof` so
// the module remains safe to import from pure-Node tooling.
// ----------------------------------------------------------------------------

if (typeof window !== 'undefined') {
    window.TimelineVisibility = {
        ensureHiddenSets: ensureHiddenSets,
        toggleCameraVisibility: toggleCameraVisibility,
        toggleTrackVisibility: toggleTrackVisibility,
        toggleIdentityVisibility: toggleIdentityVisibility,
        isCameraVisible: isCameraVisible,
        isTrackVisible: isTrackVisible,
        isIdentityVisible: isIdentityVisible,
        listCamerasForVisibility: listCamerasForVisibility,
        listTracksForVisibility: listTracksForVisibility,
        listIdentitiesForVisibility: listIdentitiesForVisibility,
        getCameraVisibilityList: getCameraVisibilityList,
        getTrackVisibilityList: getTrackVisibilityList,
        getIdentityVisibilityList: getIdentityVisibilityList,
        renameHiddenTrack: renameHiddenTrack,
        renameHiddenIdentity: renameHiddenIdentity,
    };
    window.toggleCameraVisibility = toggleCameraVisibility;
    window.toggleTrackVisibility = toggleTrackVisibility;
    window.toggleIdentityVisibility = toggleIdentityVisibility;
    window.isCameraVisible = isCameraVisible;
    window.isTrackVisible = isTrackVisible;
    window.isIdentityVisible = isIdentityVisible;
    window.listCamerasForVisibility = listCamerasForVisibility;
    window.listTracksForVisibility = listTracksForVisibility;
    window.listIdentitiesForVisibility = listIdentitiesForVisibility;
}
