/**
 * ui/panel-rail-icons.js — the icons of the right-edge panel rail (`ui/panel-rail.js`).
 *
 * Inlined from Lucide 0.575.0 (`lucide-static`, the same release sleap-app
 * loads through `lucide-react`), so the rail shows the same picture as
 * sleap-app's sidebar wherever the two apps have the same panel. Inline SVG:
 * no network fetch, so offline mode and the version stamp need nothing.
 * Only the child elements are copied; `railIconSvg` adds Lucide's standard
 * 24x24 / stroke-2 / currentColor wrapper.
 *
 * Lucide is ISC licensed (portions from Feather, MIT):
 *   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2026 as
 *   part of Feather (MIT). All other copyright (c) for Lucide are held by
 *   Lucide Contributors 2026.
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 * Full text: lib/LICENSES.txt (Lucide).
 *
 * Leaf module: imports nothing.
 */

/** Lucide icon name → its SVG child elements (verbatim from lucide-static 0.575.0). */
export const RAIL_ICONS = {
    // sleap-app Instances
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
        '<path d="M16 3.128a4 4 0 0 1 0 7.744"/>' +
        '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
        '<circle cx="9" cy="7" r="4"/>',
    // sleap-app View (overlay visibility and styling)
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
        '<circle cx="12" cy="12" r="3"/>',
    // ID Switches: two opposing arrows (identity swap)
    'arrow-left-right': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/>' +
        '<path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    // sleap-app Videos
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/>' +
        '<path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/>' +
        '<path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    // Cameras (no sleap-app counterpart)
    camera: '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/>' +
        '<circle cx="12" cy="13" r="3"/>',
    // sleap-app Skeleton
    bone: '<path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"/>',
    // Session (no sleap-app counterpart)
    'folder-tree': '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/>' +
        '<path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/>' +
        '<path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>',
    // sleap-app's collapse / expand toggle (right-docked)
    'panel-right-close': '<rect width="18" height="18" x="3" y="3" rx="2"/>' +
        '<path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
    'panel-right-open': '<rect width="18" height="18" x="3" y="3" rx="2"/>' +
        '<path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
};

/** The full `<svg>` for a Lucide icon name, sized by CSS (`.panel-rail-icon svg`). */
export function railIconSvg(name) {
    const body = RAIL_ICONS[name];
    if (!body) throw new Error('panel-rail-icons: no icon "' + name + '"');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" focusable="false">' + body + '</svg>';
}
