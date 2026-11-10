/**
 * ui/connect/dom.js — the small DOM helpers every Connect UI file shares.
 *
 * LUCID addition (no sleap-app counterpart: React builds its elements itself).
 */
import { railIconSvg } from '../panel-rail-icons.js';

/** `<tag class="cls">text</tag>`: no class when `cls` is falsy, no text when `text` is undefined. */
export function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/** A `type="button"` button (never submits); `title` only when given. */
export function button(cls, text, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title !== undefined) b.title = title;
    return b;
}

/** A Lucide icon of the rail's inlined set in a `<span class="<base> <cls>">` (`base` defaults to `connect-icon`). */
export function icon(name, cls, base) {
    const s = el('span', (base || 'connect-icon') + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

export function errMsg(err) { return err instanceof Error ? err.message : String(err); }

/** The build's release from `<meta name="lucid-release">`, 'dev' when empty. */
export function releaseVersion() {
    const m = document.querySelector('meta[name="lucid-release"]');
    return (m && (m.getAttribute('content') || '').trim()) || 'dev';
}
