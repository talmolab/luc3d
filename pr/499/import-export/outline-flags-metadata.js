// import-export/outline-flags-metadata.js — the `metadata.lucid` <-> Session
// mapping for the Outlines panel's flags on bad animal outlines
// (pose/outline-flags.js) and the outlines corrected with its brush
// (pose/outline-edits.js). The fourth `metadata.lucid` writer module, beside
// visibility, smoothing and plane.
//
// Two keys per session, each written only when the session has some:
// `outlineFlags` (`{v: 1, flags: [...]}`) and `outlineEdits` (`{v: 1, edits:
// [...]}`, each corrected label image as run-length rows). A project nobody
// flagged or corrected writes nothing, so its bytes do not move
// (`tests/e2e/save-golden-digest.mjs`). Reading REPLACES both, so a file
// without a key leaves none. Only `lucid` is touched, and nothing here throws
// on a malformed payload. SLEAP and sleap-io carry the keys as opaque JSON.
//
// Depends on: pose/outline-flags.js, pose/outline-edits.js

import { serializeOutlineFlags, ingestOutlineFlags } from '../pose/outline-flags.js?v=388836b834d4';
import { serializeOutlineEdits, ingestOutlineEdits } from '../pose/outline-edits.js?v=388836b834d4';

/** Every `metadata.lucid` key this module may write. */
export const OUTLINE_FLAGS_METADATA_KEYS = ['outlineFlags', 'outlineEdits'];

/** Add the session's outline flags and corrected outlines to a `metadata.lucid` dict (none: nothing). -> lucid */
export function writeOutlineFlagsMetadata(lucid, session) {
    if (!lucid || !session) return lucid;
    var payload = serializeOutlineFlags(session);
    if (payload) lucid.outlineFlags = payload;
    var edits = serializeOutlineEdits(session);
    if (edits) lucid.outlineEdits = edits;
    return lucid;
}

/** Read a `metadata.lucid` dict's outline flags and corrected outlines onto a session (absent: none). -> session */
export function readOutlineFlagsMetadata(session, lucid) {
    if (!session) return session;
    var src = lucid && typeof lucid === 'object' ? lucid : {};
    ingestOutlineFlags(session, src.outlineFlags);
    ingestOutlineEdits(session, src.outlineEdits);
    return session;
}
