/**
 * progress-card.js — the style every long operation's progress popup shares:
 * the image ID-switch check's dialog (ui/id-switch-modal.js) and the loading
 * overlay's card (ui/loading-overlay.js — Track All, Triangulate All, the
 * body-size check). For the e2e tests of those four:
 * tests/e2e/id-switch-image-check.mjs, triangulate-all-cpu-load.mjs,
 * track-all-cpu-load.mjs and size-switch-check.mjs.
 *
 * Served over the dev http server and `import()`ed from inside the page.
 */

/** The alpha of a computed CSS colour ("rgb(…)" = 1, "rgba(…, a)" = a). */
function alpha(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return null;
    const parts = m[1].split(/[,/ ]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
}

/**
 * @param {Element} card      the popup's card
 * @param {Element} backdrop  the full-window layer under it
 * @param {Element} [line]    the CPU line, which should start at the card's left content edge
 * @returns {{ok: boolean, why: string, cardAlpha: ?number, backdropAlpha: ?number, lineLeft: ?number}}
 */
export function progressCardStyle(card, backdrop, line) {
    const cs = getComputedStyle(card), bs = getComputedStyle(backdrop);
    const cr = card.getBoundingClientRect(), br = backdrop.getBoundingClientRect();
    const contentLeft = cr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const lineLeft = line ? line.getBoundingClientRect().left - contentLeft : null;
    const out = { cardAlpha: alpha(cs.backgroundColor), backdropAlpha: alpha(bs.backgroundColor), lineLeft };
    const why = [];
    if (out.cardAlpha !== 1) why.push('card background ' + cs.backgroundColor + ' is not opaque');
    if (out.backdropAlpha !== 0) why.push('backdrop ' + bs.backgroundColor + ' greys the app out');
    if (!(br.left <= 0 && br.top <= 0 && br.right >= innerWidth && br.bottom >= innerHeight) || bs.pointerEvents === 'none')
        why.push('backdrop no longer covers and blocks the app');
    if (cs.textAlign !== 'left' && cs.textAlign !== 'start') why.push('card text is ' + cs.textAlign + '-aligned');
    if (line && !(Math.abs(lineLeft) <= 1)) why.push('the CPU line starts ' + lineLeft.toFixed(1) + ' px from the card\'s left edge');
    return Object.assign(out, { ok: why.length === 0, why: why.join('; ') });
}
