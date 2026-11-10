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
    // sleap-app Inference (desktop app only), and the Inference panel's own
    // buttons/status icons (Lucide, same names as sleap-app's InferencePanel.tsx)
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'maximize-2': '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
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
    // Section headers (sleap-app's ChevronDown / ChevronRight / X)
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    // sleap-app Connect (ui/connect/*): the rail icon and the panel's own buttons
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    plug: '<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>',
    unplug: '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
    'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    // Toast icons (ui/connect/notify.js)
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};

/** The full `<svg>` for a Lucide icon name, sized by CSS (`.panel-rail-icon svg`). */
export function railIconSvg(name) {
    const body = RAIL_ICONS[name];
    if (!body) throw new Error('panel-rail-icons: no icon "' + name + '"');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" focusable="false">' + body + '</svg>';
}
