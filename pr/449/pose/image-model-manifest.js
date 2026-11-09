/**
 * pose/image-model-manifest.js — what an image-model PACKAGE for the image
 * ID-switch check is, independent of where its files come from (DOM-free,
 * import-free; ui/image-model-package.js loads the files).
 *
 * A package is a folder (or the same layout at a URL / Hugging Face repo):
 *
 *   lucid-model.json            this module's manifest (below)
 *   config.json                 transformers.js model config (model_type dinov2 / dinov3_vit)
 *   preprocessor_config.json    optional (the app does its own preprocessing)
 *   onnx/model.onnx             fp32, required; must output last_hidden_state (CLS = token 0)
 *   onnx/model_fp16.onnx        optional; used on GPUs with 'shader-f16' when the manifest says `fp16: true`
 *
 * lucid-model.json:
 *   {
 *     "format": "lucid-image-model", "version": 1,
 *     "name": "SLAP rig, fine-tuned dinov2-small",       shown in the app
 *     "base": "facebook/dinov2-small",                    what it was trained from
 *     "license": "Apache-2.0",                            the base model's license
 *     "input": 168,                                       model input side (px), a multiple of 14 or 16
 *     "crop": 160,                                        the crop it was trained on: must equal the app's CROP
 *     "threshold": -1,                                    recommended flag threshold (-4..0)
 *     "fp16": true,                                       model_fp16.onnx checked against fp32 on WebGPU
 *     "sha256": {"onnx/model.onnx": "<hex>", ...},        optional; checked when the files are local
 *     "training": {...}, "validation": {...}              free-form, shown to the user
 *   }
 *
 * A model is identified by `key`: a SHA-256 over its manifest's model-defining
 * fields and its weights' hashes (`modelPackageKey`). The embedding cache keys
 * vectors by it, so vectors from one model are never served for another, and the
 * project records it, so a saved choice can be matched to a loaded package.
 *
 * Depends on: nothing.
 */

/** The manifest's file name, at the package's root. */
export const MODEL_MANIFEST_NAME = 'lucid-model.json';
export const MODEL_MANIFEST_FORMAT = 'lucid-image-model';
export const MODEL_FP32_PATH = 'onnx/model.onnx';
export const MODEL_FP16_PATH = 'onnx/model_fp16.onnx';
export const MODEL_CONFIG_PATH = 'config.json';

/** Input sides a package may declare (px): ViT patch grids of 14 or 16 px, 8 to 32 patches a side. */
export function validModelInput(n) {
    return Number.isInteger(n) && n >= 112 && n <= 512 && (n % 14 === 0 || n % 16 === 0);
}

/** https anywhere, or http on this machine only (a local server). */
const WEB_URL = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i;

const str = function (v, max) { return typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 200) : ''; };

/**
 * Parse and check a manifest (its JSON text or the parsed object) against the
 * crop side the app cuts (`crop`, ui/image-embedder.js CROP).
 * @returns {{ok: true, manifest: Object} | {ok: false, error: string}}
 *   `manifest` is normalised: name, base, license, input, crop, threshold,
 *   fp16 (boolean), sha256 (path -> lowercase hex), training, validation.
 */
export function parseModelManifest(raw, crop) {
    let m = raw;
    if (typeof raw === 'string') {
        try { m = JSON.parse(raw); } catch (e) { return { ok: false, error: MODEL_MANIFEST_NAME + ' is not valid JSON' }; }
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: MODEL_MANIFEST_NAME + ' must hold a JSON object' };
    if (m.format !== MODEL_MANIFEST_FORMAT) return { ok: false, error: MODEL_MANIFEST_NAME + ' is not a LUCID image model (its "format" must be "' + MODEL_MANIFEST_FORMAT + '")' };
    if (m.version !== 1) return { ok: false, error: 'this LUCID reads image-model packages of version 1; this one is version ' + JSON.stringify(m.version) };
    const name = str(m.name, 120);
    if (!name) return { ok: false, error: MODEL_MANIFEST_NAME + ' has no "name"' };
    if (!validModelInput(m.input)) return { ok: false, error: '"input" must be a whole number of pixels from 112 to 512, a multiple of 14 or 16 (got ' + JSON.stringify(m.input) + ')' };
    if (crop != null && m.crop !== crop) return { ok: false, error: 'the model was trained on ' + JSON.stringify(m.crop) + '-px crops; this LUCID cuts ' + crop + '-px crops' };
    if (typeof m.threshold !== 'number' || !isFinite(m.threshold) || m.threshold < -4 || m.threshold > 0) {
        return { ok: false, error: '"threshold" must be a number from -4 to 0 (the flag threshold to use with this model)' };
    }
    const sha = {};
    if (m.sha256 != null) {
        if (typeof m.sha256 !== 'object' || Array.isArray(m.sha256)) return { ok: false, error: '"sha256" must map file paths to their SHA-256' };
        for (const p of Object.keys(m.sha256)) {
            const h = String(m.sha256[p]).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(h)) return { ok: false, error: '"sha256" of ' + p + ' is not a SHA-256 hex digest' };
            sha[p] = h;
        }
    }
    const obj = function (v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; };
    return { ok: true, manifest: {
        name: name, base: str(m.base), license: str(m.license), input: m.input, crop: m.crop, threshold: m.threshold,
        fp16: m.fp16 === true, sha256: sha, training: obj(m.training), validation: obj(m.validation),
    } };
}

/**
 * The text `modelPackageKey` hashes: the fields that change what the model
 * computes or how its scores are read, plus every weight file's hash (sorted).
 * A name or note edit leaves the key alone.
 */
export function modelKeyMaterial(manifest, fileHashes) {
    const files = Object.keys(fileHashes || {}).sort().map(function (p) { return p + '=' + fileHashes[p]; });
    return ['lucid-image-model/1', 'input=' + manifest.input, 'crop=' + manifest.crop, 'fp16=' + (manifest.fp16 ? 1 : 0)].concat(files).join('\n');
}

/** Lowercase hex of a digest's bytes. */
export function hexOf(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
}

/**
 * What a session saves about its image model (`Session.imageModel`, written to
 * `metadata.lucid.imageModel` only when set): enough to name it, match it to a
 * loaded package by `key`, and reload it when it came from a URL.
 * @returns {?{key: string, name: string, input: number, threshold: number, url?: string, folder?: string}}
 */
export function modelChoiceOf(pkg) {
    if (!pkg || !pkg.key) return null;
    const out = { key: pkg.key, name: pkg.name, input: pkg.input, threshold: pkg.threshold };
    if (pkg.source && pkg.source.kind === 'url') out.url = pkg.source.url;
    if (pkg.source && pkg.source.kind === 'files' && pkg.source.folder) out.folder = pkg.source.folder;
    return out;
}

/** A saved choice read back from a file, or null when absent or malformed (= the built-in model). */
export function ingestModelChoice(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.key !== 'string' || !/^[0-9a-f]{64}$/.test(raw.key)) return null;
    if (!validModelInput(raw.input) || typeof raw.threshold !== 'number' || !isFinite(raw.threshold)) return null;
    const out = { key: raw.key, name: str(raw.name, 120) || 'image model ' + raw.key.slice(0, 8), input: raw.input, threshold: raw.threshold };
    if (typeof raw.url === 'string' && WEB_URL.test(raw.url)) out.url = raw.url;
    else if (typeof raw.url === 'string' && /^[\w.-]+\/[\w.-]+$/.test(raw.url)) out.url = raw.url;
    if (typeof raw.folder === 'string' && raw.folder) out.folder = raw.folder.slice(0, 200);
    return out;
}

/**
 * Where a package's files are, for a URL the user typed: a Hugging Face repo id
 * ("owner/name") or an https URL of the folder (http only on localhost). Returns the base URL that file
 * paths are appended to, or null when it is neither.
 */
export function packageBaseUrl(input) {
    const s = String(input || '').trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(s)) return 'https://huggingface.co/' + s + '/resolve/main/';
    if (!WEB_URL.test(s)) return null;
    const noManifest = s.replace(/\/?lucid-model\.json(\?.*)?$/i, '');
    return noManifest.endsWith('/') ? noManifest : noManifest + '/';
}
