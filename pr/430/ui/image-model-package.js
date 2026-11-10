/**
 * ui/image-model-package.js — loads image-model PACKAGES for the image
 * ID-switch check (format: pose/image-model-manifest.js) and serves their files
 * to transformers.js, on the main thread and in the CPU model workers.
 *
 * Two sources:
 *   - a local folder the user picks (`loadModelPackageFromFiles`): every file is
 *     read once through loading/cold-read-guard.js (cloud-synced folders), the
 *     weights are hashed and checked against the manifest's `sha256`, and the
 *     bytes are kept in memory for this page;
 *   - a URL or Hugging Face repo id (`loadModelPackageFromUrl`): only the
 *     manifest is fetched up front; transformers.js fetches the weights on first
 *     use and the browser caches them like the built-in model.
 *
 * transformers.js asks for every file by URL through `env.fetch`
 * (`https://huggingface.co/<repo>/resolve/main/<path>`). A package is given the
 * repo id `lucid-pkg/<first 16 hex of its key>`; `installModelPackageFetch`
 * wraps `env.fetch` so those URLs are answered from the package (its bytes, or
 * its own URL) and every other URL — the built-in model — goes out unchanged.
 * Each realm (the page, each CPU worker) installs it on its own copy of the
 * library and is told the packages it may serve (`serveModelPackage`).
 *
 * Depends on: pose/image-model-manifest.js, loading/cold-read-guard.js.
 * Used by: ui/image-embedder.js, ui/image-model-worker.js, ui/image-model-dialog.js, ui/id-switch-modal.js.
 */

import {
    parseModelManifest, modelKeyMaterial, hexOf, packageBaseUrl,
    MODEL_MANIFEST_NAME, MODEL_FP32_PATH, MODEL_FP16_PATH, MODEL_CONFIG_PATH,
} from '../pose/image-model-manifest.js?v=6a08874aa4a2';
import { readBlobArrayBuffer } from '../loading/cold-read-guard.js?v=6a08874aa4a2';

/** Repo-id prefix of packages, as transformers.js sees them. */
export const PACKAGE_REPO_PREFIX = 'lucid-pkg/';
/** The crop side packages must have been trained on (ui/image-embedder.js CROP; kept here so this module imports no UI). */
export const PACKAGE_CROP = 160;

const _packages = new Map();     // key -> package
const _served = new Map();       // repo id -> {kind: 'files', files: {path: Blob}} | {kind: 'url', base}

/** transformers.js repo id of the package with this key. */
export function modelRepoId(key) { return PACKAGE_REPO_PREFIX + String(key).slice(0, 16); }

async function sha256Hex(data) {
    const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return hexOf(await crypto.subtle.digest('SHA-256', buf));
}

function register(pkg) {
    _packages.set(pkg.key, pkg);
    serveModelPackage(pkg.id, pkg.source.kind === 'files' ? { kind: 'files', files: pkg.source.files } : { kind: 'url', base: pkg.source.base });
    return pkg;
}

/** The loaded package with this key, or null. */
export function registeredModelPackage(key) { return _packages.get(key) || null; }

/** Every package loaded on this page, most recent last. */
export function registeredModelPackages() { return Array.from(_packages.values()); }

/** Forget every loaded package (tests). */
export function clearModelPackages() { _packages.clear(); _served.clear(); }

/** Let this realm serve `repo`'s files (a worker calls it with what `modelPackageTransfer` sent). */
export function serveModelPackage(repo, source) { _served.set(repo, source); }

/** What a CPU worker needs to serve a package: its repo id and its files (Blobs clone without copying) or base URL. */
export function modelPackageTransfer(pkg) {
    if (!pkg || pkg.builtin) return null;
    return { repo: pkg.id, source: pkg.source.kind === 'files' ? { kind: 'files', files: pkg.source.files } : { kind: 'url', base: pkg.source.base } };
}

function makePackage(manifest, key, source, sizes) {
    const fp32 = sizes[MODEL_FP32_PATH] || 0, fp16 = sizes[MODEL_FP16_PATH] || 0;
    return {
        key: key, id: modelRepoId(key), builtin: false,
        name: manifest.name, base: manifest.base, license: manifest.license,
        input: manifest.input, threshold: manifest.threshold, fp16: manifest.fp16,
        // download / memory size in MB per dtype, for the status lines (0 = unknown, a URL package before download)
        mb: { fp32: Math.round(fp32 / 1e6), fp16: Math.round(fp16 / 1e6) },
        manifest: manifest, source: source,
    };
}

/**
 * A package from a folder the user picked (`<input webkitdirectory>` files, or
 * any File list whose `webkitRelativePath`s keep the folder's layout). The
 * manifest may sit at the top or one folder down. Throws an Error whose message
 * says what is wrong for the user.
 * @param {FileList|File[]} fileList
 * @param {function(string)} [onStatus]
 */
export async function loadModelPackageFromFiles(fileList, onStatus) {
    const all = Array.from(fileList || []);
    const rel = function (f) { return String(f.webkitRelativePath || f.name).replace(/\\/g, '/'); };
    const manifests = all.filter(function (f) { const p = rel(f); return p === MODEL_MANIFEST_NAME || p.endsWith('/' + MODEL_MANIFEST_NAME); })
        .sort(function (a, b) { return rel(a).length - rel(b).length; });
    if (!manifests.length) throw new Error('no ' + MODEL_MANIFEST_NAME + ' in that folder: pick the model package\'s folder');
    const mPath = rel(manifests[0]), root = mPath.slice(0, mPath.length - MODEL_MANIFEST_NAME.length);
    const byPath = new Map();
    all.forEach(function (f) { const p = rel(f); if (p.startsWith(root)) byPath.set(p.slice(root.length), f); });
    const parsed = parseModelManifest(await manifests[0].text(), PACKAGE_CROP);
    if (!parsed.ok) throw new Error(parsed.error);
    const manifest = parsed.manifest;
    for (const need of [MODEL_CONFIG_PATH, MODEL_FP32_PATH]) if (!byPath.has(need)) throw new Error('the package has no ' + need);
    const weights = [MODEL_FP32_PATH];
    if (manifest.fp16) { if (byPath.has(MODEL_FP16_PATH)) weights.push(MODEL_FP16_PATH); else manifest.fp16 = false; }
    const files = {}, hashes = {}, sizes = {};
    for (const p of byPath.keys()) {
        if (p.startsWith('onnx/') && weights.indexOf(p) < 0) continue;      // weights the app never loads
        const f = byPath.get(p);
        if (onStatus && p.endsWith('.onnx')) onStatus('Reading ' + p + ' (' + Math.round(f.size / 1e6) + ' MB)…');
        const buf = await readBlobArrayBuffer(f);
        if (weights.indexOf(p) >= 0) {
            hashes[p] = await sha256Hex(buf);
            sizes[p] = buf.byteLength;
            if (manifest.sha256[p] && manifest.sha256[p] !== hashes[p]) throw new Error(p + ' does not match the SHA-256 in ' + MODEL_MANIFEST_NAME + ': the file is damaged or from another model');
        }
        files[p] = new Blob([buf]);
    }
    const key = await sha256Hex(modelKeyMaterial(manifest, hashes));
    const folder = root.replace(/\/$/, '').split('/').pop() || manifests[0].name;
    const existing = _packages.get(key);
    if (existing) return existing;
    return register(makePackage(manifest, key, { kind: 'files', folder: folder, files: files }, sizes));
}

/**
 * A package at a URL: a Hugging Face repo id ("owner/name") or the https URL of
 * its folder (or of its lucid-model.json). Fetches the manifest only. When the
 * manifest lists the weights' SHA-256 the key is the same as for the folder; when
 * not, it is tied to this URL and manifest instead.
 * @param {string} input
 */
export async function loadModelPackageFromUrl(input) {
    const base = packageBaseUrl(input);
    if (!base) throw new Error('give a Hugging Face repo ("owner/name") or an https:// URL of the package folder');
    let resp;
    try { resp = await fetch(base + MODEL_MANIFEST_NAME, { cache: 'no-cache' }); }
    catch (e) { throw new Error('could not reach ' + base + ' (' + String((e && e.message) || e) + ')'); }
    if (!resp.ok) throw new Error('no ' + MODEL_MANIFEST_NAME + ' at ' + base + ' (HTTP ' + resp.status + ')');
    const text = await resp.text();
    const parsed = parseModelManifest(text, PACKAGE_CROP);
    if (!parsed.ok) throw new Error(parsed.error);
    const manifest = parsed.manifest, hashes = {};
    [MODEL_FP32_PATH].concat(manifest.fp16 ? [MODEL_FP16_PATH] : []).forEach(function (p) { if (manifest.sha256[p]) hashes[p] = manifest.sha256[p]; });
    const complete = !!hashes[MODEL_FP32_PATH] && (!manifest.fp16 || !!hashes[MODEL_FP16_PATH]);
    const key = await sha256Hex(modelKeyMaterial(manifest, hashes) + (complete ? '' : '\nurl=' + base + '\nmanifest=' + text));
    const existing = _packages.get(key);
    if (existing) return existing;
    return register(makePackage(manifest, key, { kind: 'url', url: String(input).trim(), base: base }, {}));
}

// ---- transformers.js file hook --------------------------------------------------------------------

/** `{repo, path}` when `url` is a package file's URL as transformers.js builds it, else null. */
export function packageFileOf(url) {
    const s = String(url);
    const i = s.indexOf('/' + PACKAGE_REPO_PREFIX);
    if (i < 0) return null;
    const rest = s.slice(i + 1).split('?')[0];          // lucid-pkg/<key16>/resolve/main/<path>
    const m = /^(lucid-pkg\/[0-9a-f]{16})\/(?:resolve\/[^/]+\/)?(.+)$/.exec(rest);
    return m ? { repo: m[1], path: decodeURIComponent(m[2]) } : null;
}

function answer(url, init, orig) {
    const f = packageFileOf(url), src = f && _served.get(f.repo);
    if (!src) return orig(url, init);
    if (src.kind === 'url') return orig(src.base + f.path, init);
    const blob = src.files[f.path];
    if (!blob) return Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }));
    return Promise.resolve(new Response(blob, { status: 200, headers: { 'content-length': String(blob.size), 'content-type': 'application/octet-stream' } }));
}

/**
 * Wrap transformers.js's `env.fetch` (module `T`) once, so package URLs are
 * answered from the packages this realm serves. Other URLs are unchanged.
 */
export function installModelPackageFetch(T) {
    const env = T && T.env;
    if (!env || env.__lucidPackages) return;
    const orig = typeof env.fetch === 'function' ? env.fetch : function (u, i) { return fetch(u, i); };
    env.fetch = function (url, init) { return answer(url, init, orig); };
    env.__lucidPackages = true;
}

/**
 * Run `load` (a from_pretrained call) for `pkg` with the browser cache OFF when
 * its files are local: they are already in memory, and transformers.js would
 * otherwise copy them into Cache Storage under the package's made-up URL.
 */
export async function withPackageCachePolicy(T, pkg, load) {
    if (!pkg || pkg.builtin || pkg.source.kind !== 'files' || !T.env.useBrowserCache) return load();
    T.env.useBrowserCache = false;
    try { return await load(); } finally { T.env.useBrowserCache = true; }
}

/** Same as `withPackageCachePolicy`, from a worker that has only the transfer. */
export async function withTransferCachePolicy(T, transfer, load) {
    if (!transfer || transfer.source.kind !== 'files' || !T.env.useBrowserCache) return load();
    T.env.useBrowserCache = false;
    try { return await load(); } finally { T.env.useBrowserCache = true; }
}
