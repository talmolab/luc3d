/**
 * pose/embedding-cache.js — remembers the image ID-switch check's crop
 * embeddings between runs (ui/image-embedder.js), so a re-run after Track All
 * re-embeds only the crops whose pixels can have changed.
 *
 * A crop is a pure function of: the video, the frame decoded for that view and
 * how it was decoded, the animal's crop geometry and the hulls masked out of it
 * (`cutCrop`), and of the model that embeds it (backend + dtype give slightly
 * different vectors). `cropKeyHash` hashes the EXACT bits of the geometry and
 * the masks — no rounding: two crops that rounded to one key could differ by a
 * pixel, and a cache hit must be the very vector the model would produce. Only
 * the masks that can reach the crop go into the key (`hullsReachingCrop`).
 *
 * Storage: vectors live in pooled Float32Array chunks (`EMBED_CACHE_CHUNK`
 * slots each, grown on demand), never one boxed array per crop; an LRU over a
 * Map (insertion order) bounds it at `maxEntries`. `get` returns a COPY, so a
 * slot recycled later cannot change a vector the caller holds.
 *
 * Pure — no DOM, no app state. Imported by ui/image-embedder.js.
 */

/** Most crops kept across all sessions: 65,536 x 384 floats = 96 MB (a 15-min, 5-animal, 3-view run is ~25k). */
export const EMBED_CACHE_MAX_ENTRIES = 65536;
/** Slots per pooled chunk (6 MB at 384 floats). */
export const EMBED_CACHE_CHUNK = 4096;

// ---- hashing: two independent 32-bit mixes of the values' IEEE-754 bits = a 64-bit key
const _f64 = new Float64Array(1), _u32 = new Uint32Array(_f64.buffer);

function mix(h, k) {                     // murmur3's per-word step
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19);
    return (Math.imul(h, 5) + 0xe6546b64) | 0;
}
function fmix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

/** Incremental 64-bit hash of numbers (exact bits; -0 and 0 differ, as they would in no crop). */
function hasher() {
    let a = 0x9747b28c | 0, b = 0x5bd1e995 | 0, n = 0;
    return {
        num: function (x) {
            _f64[0] = x;
            const lo = _u32[0], hi = _u32[1];
            a = mix(mix(a, lo), hi); b = mix(mix(b, hi ^ 0x27d4eb2f), lo ^ 0x165667b1); n++;
        },
        hex: function () {
            const x = fmix(a ^ n), y = fmix(b ^ (n * 0x9e3779b1));
            return x.toString(16).padStart(8, '0') + y.toString(16).padStart(8, '0');
        },
    };
}

/**
 * The hash of everything `cutCrop` reads besides the image: the animal's crop
 * geometry (cx, cy, angle, scale, L — the mask's dilation — and its hull) and
 * the hulls of the other animals masked out, in order. 16 hex characters.
 * @param {{cx: number, cy: number, angle: number, scale: number, L: number, hull: number[][]}} g
 * @param {number[][][]} others
 */
export function cropKeyHash(g, others) {
    const h = hasher();
    h.num(g.cx); h.num(g.cy); h.num(g.angle); h.num(g.scale); h.num(g.L);
    const hull = function (pts) {
        h.num(pts.length);
        for (let i = 0; i < pts.length; i++) { h.num(pts[i][0]); h.num(pts[i][1]); }
    };
    hull(g.hull || []);
    h.num((others || []).length);
    for (const o of others || []) hull(o);
    return h.hex();
}

/** Crop pixels beyond the crop square a masked hull may still touch (anti-aliasing reaches < 1 px). */
export const MASK_REACH_MARGIN = 2;

/**
 * The masked hulls that can change a crop's pixels: those `cutCrop` draws (3+
 * corners) whose bounding box, mapped into the crop the way `cutCrop` maps it
 * (about the body centre, rotated by -angle, scaled, side `side` px), comes
 * within MASK_REACH_MARGIN of the crop square. A hull entirely outside is drawn
 * off the canvas and changes nothing, so it is left out of the cache key — a
 * neighbour moving at the far side of the arena does not invalidate the crop.
 * Order is kept (masks are composited in order). Conservative: the bounding box
 * of a hull that misses the square may still meet it.
 * @param {{cx: number, cy: number, angle: number, scale: number}} g
 * @param {number[][][]} others
 * @param {number} side  the crop's side in pixels (CROP)
 */
export function hullsReachingCrop(g, others, side) {
    const c = Math.cos(g.angle), s = Math.sin(g.angle), half = side / 2, lo = -MASK_REACH_MARGIN, hi = side + MASK_REACH_MARGIN;
    return (others || []).filter(function (h) {
        if (!h || h.length < 3) return false;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < h.length; i++) {
            const dx = h[i][0] - g.cx, dy = h[i][1] - g.cy;
            const x = half + g.scale * (c * dx + s * dy), y = half + g.scale * (-s * dx + c * dy);
            if (!(isFinite(x) && isFinite(y))) return true;   // never in a hull from cropGeometry: keep the key exact
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return !(x1 < lo || x0 > hi || y1 < lo || y0 > hi);
    });
}

/**
 * A bounded LRU of fixed-length Float32 vectors, keyed by string.
 * @param {{maxEntries?: number, chunk?: number}} [opts]
 */
export class EmbeddingCache {
    constructor(opts) {
        opts = opts || {};
        this.maxEntries = Math.max(1, opts.maxEntries || EMBED_CACHE_MAX_ENTRIES);
        this.chunk = Math.max(1, opts.chunk || EMBED_CACHE_CHUNK);
        this.clear();
    }

    /** Drop everything, and the pooled memory with it. */
    clear() {
        this.dim = 0;
        this.chunks = [];
        this.slots = new Map();   // key -> slot, least recently used first
        this.free = [];
        this.next = 0;            // slots handed out so far (free ones are recycled first)
    }

    get size() { return this.slots.size; }

    /** Bytes held by the pool (allocated chunks). */
    get bytes() { return this.chunks.reduce(function (a, c) { return a + c.byteLength; }, 0); }

    has(key) { return this.slots.has(key); }

    /** A copy of the vector stored under `key` (now the most recently used), or null. */
    get(key) {
        const s = this.slots.get(key);
        if (s === undefined) return null;
        this.slots.delete(key); this.slots.set(key, s);
        const c = this.chunks[(s / this.chunk) | 0], at = (s % this.chunk) * this.dim;
        return c.slice(at, at + this.dim);
    }

    /** Store a copy of `vec` under `key`, evicting the least recently used entry when full. */
    put(key, vec) {
        if (!vec || !vec.length) return;
        if (this.dim && vec.length !== this.dim) this.clear();   // another model's vectors: start over
        if (!this.dim) this.dim = vec.length;
        let s = this.slots.get(key);
        if (s !== undefined) this.slots.delete(key);
        else if (this.free.length) s = this.free.pop();
        else if (this.next < this.maxEntries) s = this.next++;
        else {                                                   // full: recycle the least recently used slot
            const oldest = this.slots.keys().next().value;
            s = this.slots.get(oldest);
            this.slots.delete(oldest);
        }
        const ci = (s / this.chunk) | 0;
        while (this.chunks.length <= ci) this.chunks.push(new Float32Array(this.chunk * this.dim));
        this.chunks[ci].set(vec, (s % this.chunk) * this.dim);
        this.slots.set(key, s);
    }

    /** Remove every entry whose key `pred(key)` accepts. @returns {number} how many */
    deleteWhere(pred) {
        let n = 0;
        for (const [k, s] of this.slots) if (pred(k)) { this.slots.delete(k); this.free.push(s); n++; }
        if (!this.slots.size) this.clear();
        return n;
    }
}
