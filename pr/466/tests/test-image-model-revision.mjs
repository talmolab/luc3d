/**
 * test-image-model-revision.mjs — every load of the image ID-switch check's
 * built-in model is pinned to one Hugging Face commit of IMAGE_MODEL_ID
 * (ui/image-embedder.js `IMAGE_MODEL_REVISION`, carried by `BUILTIN_IMAGE_MODEL.revision`).
 *
 * transformers.js's `from_pretrained` follows the repo's `main` unless it is given
 * a `revision`, so a load that omits it fetches whatever was last pushed to the
 * repo: weights the -1.2 threshold was never calibrated on. The pin only holds if
 * EVERY load passes it, so this test:
 *  1. checks the pin is the calibrated commit (moving it is a recalibration: change
 *     CALIBRATED_REVISION here in the same change, with the new calibration);
 *  2. runs the real load paths — WebGPU (`loadImageModel`), WebNN (`loadWebNNModel`),
 *     the CPU pool's load message (`createCpuModelPool`) and the CPU worker itself
 *     (ui/image-model-worker.js) — against a stand-in transformers.js that records
 *     each `from_pretrained` call, and checks each one asked for that commit;
 *  3. checks a package (a model the user trained, ui/image-model-package.js) is
 *     loaded with no revision, as before: its files are its own;
 *  4. scans the source for every `from_pretrained(` call, which must take its
 *     options from `pretrainedOptions` (or pass `revision: …IMAGE_MODEL_REVISION`).
 * Negative controls: the checker rejects an unpinned load, a load of `main` and a
 * load of another commit, and the scan flags an unpinned call.
 *
 * Run:  node tests/test-image-model-revision.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** olinesn/dinov3-vits16-lucid, "Upload folder using huggingface_hub", 2026-11-03: the files the check is calibrated on. */
const CALIBRATED_REVISION = '8f8b666d951d95412d4990b8ae3a28f6e015c57e';

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}

// ---- a stand-in transformers.js: records every from_pretrained call ----------
globalThis.__fromPretrained = [];
const FAKE = 'data:text/javascript,' + encodeURIComponent(`
export const env = { useBrowserCache: true, fetch: (u, i) => fetch(u, i), backends: { onnx: { webgpu: { device: null, adapter: null } } } };
export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
export const AutoModel = { from_pretrained: async (id, options) => {
    globalThis.__fromPretrained.push({ id, options: Object.assign({}, options) });
    const model = async () => ({ last_hidden_state: { dims: [1, 1, 1], data: new Float32Array(1) } });
    model.dispose = () => {};
    return model;
} };`);
registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('https://cdn.jsdelivr.net/npm/@huggingface/transformers@')) return { url: FAKE, shortCircuit: true };
        return next(specifier, context);
    },
});

globalThis.window = globalThis;
const E = await import(pathToFileURL(path.join(ROOT, 'ui', 'image-embedder.js')).href);
const { IMAGE_MODEL_ID, IMAGE_MODEL_REVISION, BUILTIN_IMAGE_MODEL } = E;

/** Why a recorded load is not a load of the pinned built-in model ('' = it is). */
function unpinned(call) {
    if (!call) return 'no load recorded';
    if (call.id !== IMAGE_MODEL_ID) return 'loaded ' + call.id;
    const rev = call.options && call.options.revision;
    if (rev == null) return 'no revision: follows the repo\'s main';
    if (rev !== CALIBRATED_REVISION) return 'revision ' + JSON.stringify(rev) + ', not the calibrated ' + CALIBRATED_REVISION.slice(0, 12);
    return '';
}
const lastLoad = () => globalThis.__fromPretrained[globalThis.__fromPretrained.length - 1];

// ---- 1. the pin: the calibrated commit, on the built-in entry ----------------
ok(IMAGE_MODEL_ID === 'olinesn/dinov3-vits16-lucid', 'the built-in model is DINOv3 ViT-S/16 (' + IMAGE_MODEL_ID + ')');
ok(/^[0-9a-f]{40}$/.test(IMAGE_MODEL_REVISION), 'IMAGE_MODEL_REVISION is a 40-hex commit id, not a branch or tag: ' + JSON.stringify(IMAGE_MODEL_REVISION));
ok(IMAGE_MODEL_REVISION === CALIBRATED_REVISION, 'IMAGE_MODEL_REVISION is the calibrated commit ' + CALIBRATED_REVISION.slice(0, 12) + ' (got ' + IMAGE_MODEL_REVISION + ')');
ok(BUILTIN_IMAGE_MODEL.revision === IMAGE_MODEL_REVISION, 'the pin is on the built-in registry entry (BUILTIN_IMAGE_MODEL.revision)');
ok(E.pretrainedOptions(BUILTIN_IMAGE_MODEL, { device: 'x' }).revision === IMAGE_MODEL_REVISION, 'pretrainedOptions adds it to a built-in load');

// ---- negative controls: the checker catches an unpinned or wrong load --------
ok(unpinned({ id: IMAGE_MODEL_ID, options: { device: 'webgpu' } }) !== '', 'control: a load without a revision fails');
ok(unpinned({ id: IMAGE_MODEL_ID, options: { revision: 'main' } }) !== '', 'control: a load of `main` fails');
ok(unpinned({ id: IMAGE_MODEL_ID, options: { revision: '986b21e5b4080d544ec234de29e5038c01033739' } }) !== '', 'control: a load of another commit fails');
ok(unpinned({ id: IMAGE_MODEL_ID, options: E.pretrainedOptions(Object.assign({}, BUILTIN_IMAGE_MODEL, { revision: undefined }), {}) }) !== '',
   'control: a built-in entry that lost its revision would fail');
ok(unpinned({ id: IMAGE_MODEL_ID, options: { revision: CALIBRATED_REVISION } }) === '', 'control: the pinned load passes');

// ---- 2. the real load paths ---------------------------------------------------
E.setActiveImageModel(null);
{
    globalThis.__fromPretrained.length = 0;
    await E.loadImageModel();
    const why = unpinned(lastLoad());
    ok(globalThis.__fromPretrained.length === 1 && why === '' && lastLoad().options.device === 'webgpu', 'WebGPU (loadImageModel) loads the pinned commit' + (why ? ': ' + why : ''));
}
{
    globalThis.__fromPretrained.length = 0;
    await E.loadWebNNModel();
    const why = unpinned(lastLoad());
    ok(globalThis.__fromPretrained.length === 1 && why === '' && lastLoad().options.device === 'webnn-gpu', 'WebNN (loadWebNNModel) loads the pinned commit' + (why ? ': ' + why : ''));
}
// The CPU pool: what it tells each worker to load (a fake Worker answers 'loaded')
const sent = [];
globalThis.Worker = class {
    constructor() { setTimeout(() => {}, 0); }
    postMessage(m) { sent.push(m); if (m.type === 'load') setTimeout(() => this.onmessage({ data: { type: 'loaded' } }), 0); }
    terminate() {}
};
{
    const pool = await E.createCpuModelPool(2);
    pool.terminate();
    const loads = sent.filter(m => m.type === 'load');
    ok(loads.length === 2 && loads.every(m => m.model.id === IMAGE_MODEL_ID && m.model.revision === CALIBRATED_REVISION && m.model.pkg === null),
       'the CPU pool tells every worker to load the pinned commit (' + JSON.stringify(loads.map(m => m.model.revision)) + ')');
}
delete globalThis.Worker;
// The CPU worker: what it loads — the pinned commit even when the message names none
const posted = [];
globalThis.self = { postMessage: (m) => posted.push(m) };
await import(pathToFileURL(path.join(ROOT, 'ui', 'image-model-worker.js')).href);
for (const [label, model] of [['the pool\'s message', { id: IMAGE_MODEL_ID, revision: IMAGE_MODEL_REVISION, input: 192, pkg: null }],
                              ['a message with no revision', { id: IMAGE_MODEL_ID, revision: null, input: 192, pkg: null }],
                              ['a message with a wrong revision', { id: IMAGE_MODEL_ID, revision: 'main', input: 192, pkg: null }],
                              ['no model in the message (the default)', undefined]]) {
    globalThis.__fromPretrained.length = 0; posted.length = 0;
    await self.onmessage({ data: { type: 'load', model } });
    const why = unpinned(lastLoad());
    ok(why === '' && lastLoad().options.device === 'wasm' && posted.some(m => m.type === 'loaded'),
       'CPU worker, ' + label + ': loads the pinned commit' + (why ? ' — ' + why : ''));
}

// ---- 3. a package keeps what #431 does: no revision ---------------------------
{
    const pkg = { key: 'a'.repeat(64), id: 'lucid-pkg/' + 'a'.repeat(16), builtin: false, name: 'test package', input: 192, threshold: -1, fp16: true,
                  mb: {}, source: { kind: 'url', url: 'owner/model', base: 'https://huggingface.co/owner/model/resolve/main/' } };
    E.setActiveImageModel(pkg);
    globalThis.__fromPretrained.length = 0;
    await E.loadImageModel();
    const c = lastLoad();
    ok(c && c.id === pkg.id && !('revision' in c.options), 'a package loads its own files with no revision (' + JSON.stringify(c && c.options.revision) + ')');
    posted.length = 0; globalThis.__fromPretrained.length = 0;
    await self.onmessage({ data: { type: 'load', model: { id: pkg.id, revision: null, input: 192, pkg: { repo: pkg.id, source: { kind: 'url', base: pkg.source.base } } } } });
    ok(lastLoad() && lastLoad().id === pkg.id && lastLoad().options.revision == null, 'the CPU worker loads a package with no revision too');
    E.setActiveImageModel(null);
}

// ---- 4. every from_pretrained call in the source goes through the pin ---------
/** The text of each `from_pretrained(...)` call's argument list in `src` (a stub's `from_pretrained:` is not a call). */
function pretrainedCalls(src) {
    const out = [];
    const re = /\bfrom_pretrained\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
        let depth = 1, i = re.lastIndex;
        for (; i < src.length && depth > 0; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') depth--;
        }
        out.push(src.slice(re.lastIndex, i - 1));
    }
    return out;
}
const pinnedCall = (args) => /\bpretrainedOptions\s*\(/.test(args) || /\brevision\s*:\s*(E\.)?IMAGE_MODEL_REVISION\b/.test(args);
const control = pretrainedCalls("await T.AutoModel.from_pretrained(IMAGE_MODEL_ID, { device: 'webgpu', dtype: f(x) });");
ok(control.length === 1 && !pinnedCall(control[0]), 'control: the scan finds an unpinned call and reports it unpinned');
ok(pretrainedCalls('export const AutoModel = { from_pretrained: async (id) => {} };').length === 0, 'control: a stub definition is not a call');

function walk(dir, acc) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.m?js$/.test(e.name)) acc.push(p);
    }
    return acc;
}
const files = ['ui', 'pose', 'loading', 'import-export', path.join('tests', 'e2e')].flatMap(d => walk(path.join(ROOT, d), []));
let calls = 0;
for (const f of files) {
    for (const args of pretrainedCalls(fs.readFileSync(f, 'utf8'))) {
        calls++;
        ok(pinnedCall(args), path.relative(ROOT, f) + ': from_pretrained(' + args.trim().split('\n')[0] + ' …) takes no pinned options (pretrainedOptions or revision: IMAGE_MODEL_REVISION)');
    }
}
// WebGPU + WebNN in image-embedder.js, the CPU worker, image-check-cpu.mjs's reference, image-model-package.mjs's
ok(calls >= 5, 'found every load site (expected at least 5, found ' + calls + ')');

console.log(`\ntest-image-model-revision: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
