/**
 * browser-hints.js — browser-specific advice for features a browser has off:
 * Brave's File System Access API (below), and Brave's fingerprinting
 * protection, which hides the real CPU core count and adds noise to canvas
 * reads (at the end of this file).
 *
 * Brave ships the File System Access API (`showSaveFilePicker`,
 * `showDirectoryPicker`, `showOpenFilePicker`) DISABLED by default, while
 * reporting itself as Chrome. LUCID uses that API to stream large saves and
 * exports straight to disk and to enumerate multi-session folders, so in
 * Brave those features quietly degrade (in-memory download, which can crash
 * the tab on a large project) or refuse ("Use Chrome or Edge"). Measured with
 * Brave 1.96 (Chromium 154) on macOS: all three pickers are `undefined` by
 * default and present with `--enable-features=FileSystemAccessAPI`, the
 * feature behind brave://flags/#file-system-access-api ("File System Access API";
 * flag id confirmed in Brave 1.96's flags page).
 *
 * Other browsers without the API (Safari, Firefox) can't turn it on, so they
 * get no hint here — the existing generic messages stand.
 */

/** Whether this is Brave (it exposes `navigator.brave.isBrave`). */
export function isBrave() {
    try {
        return typeof navigator !== 'undefined' && !!navigator.brave &&
            typeof navigator.brave.isBrave === 'function';
    } catch (e) {
        return false;
    }
}

/** Whether the File System Access pickers are available. */
export function hasFileSystemAccess() {
    return typeof window !== 'undefined' &&
        typeof window.showSaveFilePicker === 'function' &&
        typeof window.showDirectoryPicker === 'function';
}

/**
 * How to turn the File System Access API back on — only in Brave with it off;
 * '' everywhere else (append-safe).
 * @returns {string}
 */
export function fileSystemAccessHint() {
    if (!isBrave() || hasFileSystemAccess()) return '';
    // brave:// URLs can't be opened from a web page, so the user pastes it.
    return 'Brave has the File System Access API turned off. To enable it, paste ' +
        'brave://flags/#file-system-access-api into the address bar, set "File System Access API" ' +
        'to Enabled and relaunch Brave — or use Chrome or Edge.';
}

// ---------------------------------------------------------------------------
// Brave's fingerprinting protection ("farbling")
// ---------------------------------------------------------------------------
//
// With Shields at their default, Brave reports a RANDOM core count to each
// site (navigator.hardwareConcurrency, between 2 and the true count, fixed for
// a session) and adds noise to canvas pixel reads. Measured with Brave 1.97
// (Chromium 155) on a 12-core M2 Pro, fresh profiles: cores 4, 6, 7, 8, 9,
// 10, 11, 12 across sessions; a 64 x 64 pattern written and read straight back
// came back with 230-280 of 16,384 values changed by 1. Both stop with a
// per-site exception (Shields > Advanced controls > Allow fingerprinting):
// cores 12 every session, 0 values changed.
//
// It matters here because LUCID sizes its worker pools from the core count —
// Triangulate All took 4.7 s with 4 cores reported vs 3.0 s with 12 on 60,000
// frames, 16 s at Brave's floor of 2 — the CPU line divides by it, and the
// image ID-switch check reads its crops back from a canvas.

var _canvasPerturbed = null;
var _canvasProbe = null;   // test hook: () => boolean

/**
 * Whether the browser adds noise to canvas pixel reads: a known 64 x 64
 * pattern, written with putImageData and read straight back, comes back
 * changed. Exact in every browser that does not farble (Chromium: 0 of 16,384
 * values changed). Checked once per page (~7 ms in Brave) — the answer cannot
 * change without a reload, which is what changing Shields does.
 * @returns {boolean}
 */
export function canvasReadsPerturbed() {
    if (_canvasProbe) return !!_canvasProbe();
    if (_canvasPerturbed != null) return _canvasPerturbed;
    _canvasPerturbed = false;
    try {
        var N = 64, c = document.createElement('canvas');
        c.width = c.height = N;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        var img = ctx.createImageData(N, N), d = img.data;
        for (var i = 0; i < d.length; i += 4) {
            var p = i >> 2;
            d[i] = p & 255; d[i + 1] = ((p >> 6) * 4) & 255; d[i + 2] = (p * 7) & 255; d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        var back = ctx.getImageData(0, 0, N, N).data;
        for (var j = 0; j < back.length; j++) if (back[j] !== d[j]) { _canvasPerturbed = true; break; }
    } catch (e) { /* no canvas: nothing to say */ }
    return _canvasPerturbed;
}

/** Test hook: replace the canvas probe (null restores the real one and forgets its cached answer). */
export function __setCanvasProbe(fn) {
    _canvasProbe = fn || null;
    _canvasPerturbed = null;
}

/** Whether Brave's fingerprinting protection is on for this site: Brave, and canvas reads come back noisy. */
export function braveFingerprintingActive() {
    return isBrave() && canvasReadsPerturbed();
}

/**
 * What to tell the user when Brave's fingerprinting protection is on for this
 * site — null everywhere else (other browsers, or Brave with the site
 * allowed). Step by step, in Brave 1.97's own words ("Advanced controls",
 * "Allow fingerprinting"; older versions have a "Block fingerprinting"
 * switch), and save-first: changing Shields reloads the page.
 * @param {number} cores  the core count the browser reports
 * @returns {?{lead: string, why: string, steps: string[], after: string}}
 */
export function braveFingerprintingHint(cores) {
    if (!braveFingerprintingActive()) return null;
    var n = cores > 0 ? Math.round(cores) : 0;
    return {
        // "random", not "wrong": the draw can land on the true count, and the note still applies
        lead: 'Brave reports a random number of CPU cores to this site' + (n ? ' (this session: ' + n + ')' : '') + '.',
        why: 'So the CPU numbers here may be off, Triangulate All and the image ID-switch check may use fewer workers ' +
            'than the computer has, and Brave adds slight noise to the images the image check reads. ' +
            'To fix it for this site:',
        steps: [
            'Let this finish, then save your project: the next step reloads the page.',
            'Click the Brave Shields icon (the lion) at the right end of the address bar.',
            'Open Advanced controls and choose Allow fingerprinting (in older Brave versions, switch off Block fingerprinting). ' +
                'Reload the page if Brave does not.',
        ],
        after: 'This note goes away once it has worked.',
    };
}

/**
 * Fill `el` with the hint (`braveFingerprintingHint`) and show it, or hide it
 * when there is none. Built with text nodes, not HTML.
 * @returns {boolean} whether a hint is shown
 */
export function renderBraveFingerprintingHint(el, cores) {
    if (!el) return false;
    var h = braveFingerprintingHint(cores);
    el.textContent = '';
    el.hidden = !h;
    if (!h) return false;
    var lead = document.createElement('p'), strong = document.createElement('strong');
    strong.textContent = h.lead;
    lead.appendChild(strong);
    lead.appendChild(document.createTextNode(' ' + h.why));
    var ol = document.createElement('ol');
    h.steps.forEach(function (s) { var li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
    var after = document.createElement('p');
    after.textContent = h.after;
    el.appendChild(lead); el.appendChild(ol); el.appendChild(after);
    return true;
}
