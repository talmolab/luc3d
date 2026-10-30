/**
 * ui/section-state.js — remember which collapsible sections a user left open.
 *
 * A `<details>` keeps its state for as long as the DOM node lives, which is the
 * whole app session — but loading a project RELOADS the page, and the markup's
 * `open` attributes come back. On a panel built out of five or six sections
 * that means every one of them is expanded again, and the user re-collapses the
 * same ones after every load. The state has to outlive the document, so it goes
 * in `localStorage`.
 *
 * This is **browser-local display taste, not project state** — the same
 * classification as the Visibility panel's global appearance prefs and the
 * plane panel's node-size / edge-width sliders. It must NOT be written into the
 * `.slp`: which sections one annotator likes folded away says nothing about the
 * project, and round-tripping it would move `save-golden-digest.mjs`.
 *
 * A LEAF module — it imports nothing, and is imported by `ui/info-panel.js`
 * (the Skeleton tab's Nodes / Edges) and `ui/plane-definition.js` (the Define
 * Planes panel). Those two already sit on opposite sides of several import
 * chains, so anything with its own imports would risk closing a cycle.
 *
 * Storage is BEST-EFFORT throughout. Private windows, blocked site data and
 * quota errors all make `localStorage` throw on read or write, and a section
 * that cannot be remembered must still open and close — so every access is
 * wrapped and a failure degrades to the markup's own default.
 */

/**
 * Read a namespace's `{ id: open }` map. Always returns an object, including
 * when storage is unavailable or holds something that is not a JSON object
 * (hand-edited, or written by a different build).
 *
 * @param {string} key - localStorage key naming the group of sections.
 * @returns {Object<string, boolean>}
 */
function readMap(key) {
    try {
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
        return {};
    }
}

/**
 * Wire one `<details>` so its open/closed state survives a page load.
 *
 * Restores first, then listens: the restore assigns `el.open`, which itself
 * fires `toggle`, so the listener has to be attached afterwards or the first
 * thing it would do is write back what it just read.
 *
 * An id with no stored value keeps the markup's default. That is what lets a
 * section ship collapsed (the origin panel's Danger Zone) or expanded without
 * this module having an opinion about which.
 *
 * @param {string} id - Element id of the `<details>`.
 * @param {string} key - localStorage key to group it under.
 */
export function persistSectionState(id, key) {
    const el = document.getElementById(id);
    if (!el) return;

    const saved = readMap(key);
    if (typeof saved[id] === 'boolean') el.open = saved[id];

    el.addEventListener('toggle', function () {
        // Re-read rather than mutating a captured copy: several sections share
        // one key, and each holds its own closure. A stale copy would write back
        // its neighbours' state as it was when THIS section was wired.
        const cur = readMap(key);
        cur[id] = el.open;
        try {
            localStorage.setItem(key, JSON.stringify(cur));
        } catch (e) { /* storage unavailable — the section still works */ }
    });
}

/**
 * Wire several sections under one key.
 *
 * @param {string[]} ids
 * @param {string} key
 */
export function persistSectionStates(ids, key) {
    for (let i = 0; i < ids.length; i++) persistSectionState(ids[i], key);
}
