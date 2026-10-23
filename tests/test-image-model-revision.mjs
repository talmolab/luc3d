/**
 * test-image-model-revision.mjs — every load of the image ID-switch check's model
 * is pinned to one Hugging Face commit (ui/image-embedder.js `IMAGE_MODEL_REVISION`).
 *
 * transformers.js's `from_pretrained` follows the repo's `main` branch unless it is
 * given a `revision`, so a load site that omits it would fetch whatever the repo
 * owner last uploaded: weights the check was never calibrated against, and code
 * nobody here reviewed. The pin only holds if EVERY call passes it, so this scans
 * the source for each `from_pretrained(` call and checks its options.
 *
 * Run:  node tests/test-image-model-revision.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
globalThis.window = globalThis;
const { IMAGE_MODEL_ID, IMAGE_MODEL_REVISION } = await import(pathToFileURL(path.join(ROOT, 'ui', 'image-embedder.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}

// ---- the pin is a full commit id, not a branch or tag ------------------------
ok(IMAGE_MODEL_ID === 'onnx-community/dinov2-small', 'the model is dinov2-small');
ok(/^[0-9a-f]{40}$/.test(IMAGE_MODEL_REVISION), 'IMAGE_MODEL_REVISION is a 40-hex commit id, got ' + JSON.stringify(IMAGE_MODEL_REVISION));

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
const pinned = (args) => /\brevision\s*:\s*(E\.)?IMAGE_MODEL_REVISION\b/.test(args);

// ---- negative control: the scan catches an unpinned call ---------------------
const control = pretrainedCalls("await T.AutoModel.from_pretrained(IMAGE_MODEL_ID, { device: 'webgpu', dtype: f(x) });");
ok(control.length === 1 && !pinned(control[0]), 'control: an unpinned call is found and reported unpinned');
ok(pretrainedCalls('export const AutoModel = { from_pretrained: async (id) => {} };').length === 0, 'control: a stub definition is not a call');

// ---- every call in the app and in the tests that load the real model --------
function walk(dir, acc) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.m?js$/.test(e.name)) acc.push(p);
    }
    return acc;
}
const files = ['ui', 'pose', 'loading', 'import-export', path.join('tests', 'e2e')]
    .flatMap(d => walk(path.join(ROOT, d), []));
let calls = 0;
for (const f of files) {
    for (const args of pretrainedCalls(fs.readFileSync(f, 'utf8'))) {
        calls++;
        ok(pinned(args), path.relative(ROOT, f) + ': from_pretrained(' + args.trim().split('\n')[0] + ' …) does not pass revision: IMAGE_MODEL_REVISION');
    }
}
// WebGPU + WebNN in image-embedder.js, the CPU worker, and image-check-cpu.mjs's reference
ok(calls >= 4, 'found every load site (expected at least 4, found ' + calls + ')');

console.log(`\ntest-image-model-revision: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
