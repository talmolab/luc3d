// import-export/visibility-metadata.js — the `metadata.lucid` <-> Session
// mapping for the Visibility panel's SESSION-SCOPED settings.
//
// ## What this covers, and what it deliberately does not
//
// The Visibility panel holds two kinds of state:
//
//   * Session-scoped — per-camera video brightness / contrast / rotation, and
//     the timeline's hidden camera / track / identity sets. These describe THIS
//     project's videos and entities, so they belong in the project file. That
//     is everything this module handles.
//
//   * Global appearance preferences — the User / Predicted / Reprojections /
//     Display Legend / 3D Viewer sliders, styles and toggles. Those are
//     browser-local display taste, are shared across every session, and stay in
//     `localStorage.visibilitySettings` (see `ui/ui-wiring.js`). They are NOT
//     written here on purpose: baking them into the `.slp` would make opening a
//     colleague's project silently reassign your node sizes and 3D widgets.
//
// ## Contract
//
// One module owns the key list so a writer and a reader cannot drift — adding a
// setting means touching `writeVisibilityMetadata` / `readVisibilityMetadata`
// here and nothing else. The six call sites (four writers, three readers, one
// of which is shared) each pass the `metadata.lucid` dict straight through.
//
// Three invariants the callers depend on:
//
//   1. **Defaults are never written.** Every helper returns `null` (or omits the
//      key) when the setting is at its default, and this module only assigns
//      truthy payloads. A project nobody adjusted therefore produces byte-
//      identical output to one saved before these settings existed, which is
//      what `tests/e2e/save-golden-digest.mjs` pins.
//   2. **Only `lucid` is touched.** `writeVisibilityMetadata` mutates the object
//      it is handed and reads nothing else off the session's metadata, so it
//      cannot disturb `sessionName` / `tracks` / `frameIdentityMap` /
//      `identities` / `skeleton` / `identityId` or any future sibling.
//   3. **Reads tolerate absence and garbage.** Every key is optional; a `.slp`
//      written before this existed, or by SLEAP / another tool, simply has none
//      of them and loads unchanged. Nothing here throws on a malformed payload.
//
// Purely additive to the file format: these are optional keys inside LUCID's own
// `metadata.lucid` dict, which sleap-io and sleap-io.js round-trip as opaque
// JSON, so files stay readable by the SLEAP GUI.

import {
    serializeVideoContrast, ingestVideoContrast,
    serializeVideoBrightness, ingestVideoBrightness,
    serializeVideoRotation, ingestVideoRotation,
} from '../ui/video-filters.js';
import { serializeHiddenSets, ingestHiddenSets } from '../ui/timeline-visibility.js';

/**
 * Every `metadata.lucid` key this module may write. Exported so tests (and the
 * `save-slim-metadata` / golden-digest guards) can assert that a default project
 * carries none of them, without duplicating the list.
 *
 * @type {string[]}
 */
export const VISIBILITY_METADATA_KEYS = [
    'videoBrightness',
    'videoContrast',
    'videoRotation',
    'hiddenCameras',
    'hiddenTracks',
    'hiddenIdentities',
];

/**
 * Write a session's Visibility-panel state into a `metadata.lucid` dict.
 *
 * Mutates `lucid` in place and returns it. Keys at their default are omitted
 * entirely rather than written as an empty object/array — see invariant 1.
 *
 * @param {Object} lucid - the `metadata.lucid` dict to extend
 * @param {Object} session - a `pose/pose-data.js` Session
 * @returns {Object} the same `lucid` object
 */
export function writeVisibilityMetadata(lucid, session) {
    if (!lucid || !session) return lucid;

    var brightness = serializeVideoBrightness(session);
    if (brightness) lucid.videoBrightness = brightness;

    var contrast = serializeVideoContrast(session);
    if (contrast) lucid.videoContrast = contrast;

    var rotation = serializeVideoRotation(session);
    if (rotation) lucid.videoRotation = rotation;

    // `hidden` is a fragment carrying only the non-empty sets, so an all-visible
    // project contributes no keys at all.
    var hidden = serializeHiddenSets(session);
    if (hidden) {
        for (var k in hidden) {
            if (Object.prototype.hasOwnProperty.call(hidden, k)) lucid[k] = hidden[k];
        }
    }

    return lucid;
}

/**
 * Read a `metadata.lucid` dict's Visibility-panel state back onto a session.
 *
 * Safe to call with `null`/`undefined`/garbage — every key is optional.
 *
 * @param {Object} session - a `pose/pose-data.js` Session
 * @param {*} lucid - the `metadata.lucid` dict from disk (may be absent)
 * @returns {Object} session
 */
export function readVisibilityMetadata(session, lucid) {
    if (!session) return session;
    var src = (lucid && typeof lucid === 'object') ? lucid : {};
    ingestVideoBrightness(session, src.videoBrightness);
    ingestVideoContrast(session, src.videoContrast);
    ingestVideoRotation(session, src.videoRotation);
    ingestHiddenSets(session, src);
    return session;
}
