// ui/seekbar-preview.js — a thumbnail of the selected view at the hovered
// frame, above the seekbar's hover tooltip (ui/seekbar-tooltip.js), so you can
// see what is there before you click.
//
// Dependency-free (imports NO project modules), like ui/seekbar-tooltip.js: the
// view comes from `getView`, handed in by `ui/ui-wiring.js`, and frames from
// that view's `decoder.peekFrame(frame, widthPx)` (loading/video.js) — a
// caller-owned copy that never moves playback, the step cursor or the frame
// cache, so hovering cannot disturb the views or a paused step.
//
// **One decode at a time, the newest wins.** A decode can take a keyframe run
// (up to ~250 frames on field recordings), far longer than a mousemove, so
// frames hovered while one is in flight are not queued: when it lands, the
// latest hovered frame is decoded next and everything in between is skipped.
// Each result is drawn as it lands, dimmed (`.is-pending`) while it is not
// the frame under the cursor, so the thumbnail follows a moving pointer and
// never claims to be a frame it is not. The last THUMB_CACHE thumbnails are
// kept, so going back over a stretch you hovered is instant.
//
// **Layout-free while you move**, like the tooltip: `show` only writes. The
// box has a fixed CSS width (PREVIEW_WIDTH), so it is clamped over the bar
// without measuring it, and its canvas height is only written when the view's
// aspect ratio changes.

/** CSS px width of the thumbnail (the `.seekbar-preview` box adds its border). */
export const PREVIEW_WIDTH = 224;
/** Thumbnails kept (~150 KB each at 224 px, 2x DPR, 16:9). */
export const THUMB_CACHE = 48;

/**
 * Where the box's centre goes for cursor x `x` on a bar `barWidth` px wide:
 * over the cursor, clamped so a box `boxWidth` wide stays over the bar —
 * centred on the bar when the bar is narrower than the box.
 */
export function previewLeft(x, barWidth, boxWidth) {
    var half = boxWidth / 2;
    if (barWidth <= boxWidth) return barWidth / 2;
    return Math.max(half, Math.min(barWidth - half, x));
}

/** A small LRU of thumbnails keyed by string; `get` refreshes an entry, evicted bitmaps are closed. */
export function createThumbCache(max) {
    var map = new Map();
    return {
        has: function (k) { return map.has(k); },
        get: function (k) {
            var v = map.get(k);
            map.delete(k);
            map.set(k, v);
            return v;
        },
        set: function (k, v) {
            if (map.has(k)) { var old = map.get(k); if (old && old !== v && old.close) old.close(); map.delete(k); }
            map.set(k, v);
            while (map.size > max) {
                var oldest = map.keys().next().value;
                var bmp = map.get(oldest);
                map.delete(oldest);
                if (bmp && bmp.close) bmp.close();
            }
        },
        clear: function () {
            map.forEach(function (bmp) { if (bmp && bmp.close) bmp.close(); });
            map.clear();
        },
        get size() { return map.size; },
    };
}

/**
 * Add the preview box to `seekbar` (`#seekbar`) and return its controller,
 * which `installSeekbarTooltip` drives through its `preview` option.
 *
 * @param {HTMLElement} seekbar
 * @param {{
 *   getView: () => ({name: string, decoder: ?object, videoWidth?: number, videoHeight?: number} | null),
 *                                    // the selected view, or null for none
 *   devicePixelRatio?: () => number,
 * }} opts
 * @returns {{show: (frame: number, x: number, barWidth: number) => void, hide: () => void, element: HTMLElement}}
 */
export function installSeekbarPreview(seekbar, opts) {
    var box = document.createElement('div');
    box.className = 'seekbar-preview';
    box.id = 'seekbarPreview';
    box.setAttribute('aria-hidden', 'true');
    box.hidden = true;
    var canvas = document.createElement('canvas');
    canvas.className = 'seekbar-preview-canvas';
    var label = document.createElement('div');
    label.className = 'seekbar-preview-label';
    box.appendChild(canvas);
    box.appendChild(label);
    seekbar.appendChild(box);
    var ctx = canvas.getContext('2d');

    var dpr = function () {
        var r = opts.devicePixelRatio ? opts.devicePixelRatio() : (window.devicePixelRatio || 1);
        return Math.min(2, Math.max(1, r || 1));
    };
    var boxWidth = PREVIEW_WIDTH + 2;          // + the 1px border each side (styles.css)

    var cache = createThumbCache(THUMB_CACHE);
    // Decoder identity for cache keys. A pooled decoder can switchSource() to
    // another video and stay the same object, so its source is part of the id.
    var ids = new WeakMap(), nextId = 1;
    function decoderKey(decoder) {
        var src = decoder._source || decoder.file || decoder.url || null;
        var rec = ids.get(decoder);
        if (!rec || rec.src !== src) { rec = { id: nextId++, src: src }; ids.set(decoder, rec); }
        return rec.id;
    }

    var want = null;      // {key, decoder, frame, viewName}: the hovered frame
    var shown = null;     // {key, viewName}: what the canvas holds
    var busy = false;
    var aspect = 0;       // the canvas's height / width, set when it changes
    var labelText = '';

    function setAspect(view) {
        var w = view.videoWidth, h = view.videoHeight;
        var a = (w > 0 && h > 0) ? h / w : 9 / 16;
        if (a === aspect) return;
        aspect = a;
        var cssH = Math.round(PREVIEW_WIDTH * a);
        canvas.style.height = cssH + 'px';
        canvas.width = Math.round(PREVIEW_WIDTH * dpr());
        canvas.height = Math.round(cssH * dpr());
        shown = null;     // resizing cleared it
    }

    function paint(bitmap, job) {
        if (bitmap) {
            try { ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); }
            catch (e) { bitmap = null; }   // closed under us (evicted): show it as missing
        }
        if (!bitmap) ctx.clearRect(0, 0, canvas.width, canvas.height);
        box.classList.toggle('is-empty', !bitmap);
        shown = { key: job.key, viewName: job.viewName };
        box.classList.toggle('is-pending', !want || want.key !== shown.key);
    }

    async function pump() {
        if (busy || !want) return;
        var job = want;
        if (cache.has(job.key)) { paint(cache.get(job.key), job); return; }
        busy = true;
        var bitmap = null;
        try { bitmap = await job.decoder.peekFrame(job.frame, canvas.width); }
        catch (e) { bitmap = null; }
        busy = false;
        if (bitmap) cache.set(job.key, bitmap);   // not a miss: it may only have been early (video still loading)
        // Draw it if the box still shows this view (a nearby frame beats a blank box).
        if (want && !box.hidden && want.viewName === job.viewName) paint(bitmap, job);
        if (want && want.key !== job.key) pump();
    }

    function show(frame, x, barWidth) {
        var view = opts.getView();
        var decoder = view && view.decoder;
        if (!decoder || typeof decoder.peekFrame !== 'function') { hide(); return; }
        setAspect(view);
        if (view.name !== labelText) { labelText = view.name || ''; label.textContent = labelText; }
        var key = decoderKey(decoder) + ':' + frame;
        want = { key: key, decoder: decoder, frame: frame, viewName: view.name };
        if (shown && shown.viewName !== view.name) {   // another camera's image must not linger
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            box.classList.remove('is-empty');
            shown = null;
        }
        box.classList.toggle('is-pending', !shown || shown.key !== key);
        box.style.left = previewLeft(x, barWidth, boxWidth) + 'px';
        box.hidden = false;
        pump();
    }

    function hide() {
        want = null;
        box.hidden = true;
    }

    return { show: show, hide: hide, element: box, _cache: cache };
}
