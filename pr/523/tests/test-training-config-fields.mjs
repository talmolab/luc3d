/**
 * test-training-config-fields.mjs — ui/training-config-fields.js, the Full Configuration dialog's fields:
 *   1. ids are unique; every field sits in a section of its tab; the tabs' sections are sleap-app's;
 *   2. on every vendored preset, each editable field reads a value, and writing a value then reading it
 *      back gives that value (sleap-nn keys as the panel sends them: `applyPanelSettings` + `finalizeConfig`);
 *   3. nothing the dialog writes is a key Rust refuses: the edited config passes the same key walk and value
 *      kinds as src-tauri/src/train_config.rs (`train_config_keys.json`);
 *   4. the LR scheduler switch keeps exactly one scheduler block, with sleap-nn's defaults; the streaming
 *      pipeline sets num_workers 0; search finds fields by words of their label, hint or section;
 *      `coerce` clamps, rounds and keeps nullable empties as null.
 * Needs the offline `yaml` package for §2–3 (skipped without it).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_FIELDS, SECTIONS, searchFields, coerce, getPath, LR_SCHEDULERS } from '../ui/training-config-fields.js';
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js';
import { applyPanelSettings, finalizeConfig, hyperparamsFromConfig } from '../ui/training-args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// §1 shape.
const ids = CONFIG_FIELDS.map((f) => f.id);
assert.equal(new Set(ids).size, ids.length, 'unique ids');
for (const f of CONFIG_FIELDS) {
    assert.ok(SECTIONS[f.tab === 'pipeline' ? 'pipeline' : 'head'].includes(f.section), f.id + ' in a known section');
    assert.ok(['int', 'float', 'bool', 'select', 'text'].includes(f.kind), f.id + ' kind');
    if (f.kind === 'select') assert.ok(Array.isArray(f.options) && f.options.length, f.id + ' options');
}
assert.deepEqual(SECTIONS.head, ['Data', 'Augmentation', 'Optimization', 'Model']);
assert.ok(!CONFIG_FIELDS.some((f) => /wandb/i.test(f.id + f.label)), 'no W&B field');

// §4 (DOM-free bits that need no preset).
assert.deepEqual(searchFields('learning rate').map((f) => f.id).slice(0, 1), ['learningRate']);
assert.ok(searchFields('plateau').some((f) => f.id === 'stopOnPlateau'));
assert.deepEqual(searchFields(''), []);
const int = CONFIG_FIELDS.find((f) => f.id === 'maxEpochs');
assert.equal(coerce(int, '12.6'), 13);
assert.equal(coerce(int, '0'), 1, 'clamped to min');
assert.equal(coerce(int, 'abc'), undefined);
assert.equal(coerce(CONFIG_FIELDS.find((f) => f.id === 'cropSize'), ''), null, 'nullable empty is null');
assert.equal(coerce(int, ''), undefined, 'non-nullable empty is ignored');

const yamlPath = path.join(root, 'lib', 'yaml', 'browser', 'index.js');
if (!fs.existsSync(yamlPath)) {
    console.log('test-training-config-fields: (offline yaml package not installed: presets not walked)');
    console.log('test-training-config-fields: ok');
    process.exit(0);
}
const YAML = await import(pathToFileURL(yamlPath).href);
const parse = YAML.parse || (YAML.default && YAML.default.parse);
const table = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'src', 'train_config_keys.json'), 'utf8'));
const keys = new Set(Object.keys(table.keys));
const sections = new Set(table.sections);
function unknownKeys(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? prefix + '.' + k : k;
        if (p === 'trainer_config.wandb' || p.startsWith('trainer_config.wandb.')) continue;
        if (sections.has(p)) { if (v && typeof v === 'object' && !Array.isArray(v)) unknownKeys(v, p, out); continue; }
        if (!keys.has(p)) out.push(p);
    }
    return out;
}

/** train_config.rs `check_kind`: null passes; an int key needs a whole number, a float key any number. */
function badKinds(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? prefix + '.' + k : k;
        if (p === 'trainer_config.wandb' || p.startsWith('trainer_config.wandb.')) continue;
        if (sections.has(p)) { if (v && typeof v === 'object' && !Array.isArray(v)) badKinds(v, p, out); continue; }
        const kind = table.keys[p];
        if (v == null || !kind) continue;
        const ok = kind === 'bool' ? typeof v === 'boolean' : kind === 'int' ? Number.isInteger(v) : kind === 'float' ? typeof v === 'number'
            : kind === 'str' ? typeof v === 'string' : kind === 'list' ? Array.isArray(v) : kind === 'dict' ? (typeof v === 'object' && !Array.isArray(v)) : true;
        if (!ok) out.push(p + ' (' + kind + '): ' + JSON.stringify(v));
    }
    return out;
}

/** A value to write that differs from `cur` where it can. */
function another(f, cur) {
    if (f.kind === 'bool') return !cur;
    if (f.kind === 'select') { const o = f.options.find((x) => String(x[0]) !== String(cur)); return o ? o[0] : f.options[0][0]; }
    const lo = f.min != null ? f.min : 0, hi = f.max != null ? f.max : lo + 100;
    let v = f.kind === 'int' ? Math.round((lo + Math.min(hi, lo + 50)) / 2) : Number(((lo + Math.min(hi, lo + 2)) / 2).toFixed(4));
    if (v === cur) v = f.kind === 'int' ? Math.min(hi, v + 1) : Math.min(hi, v + (f.step || 0.01));
    return v;
}

let edited = 0;
for (const p of BASELINE_PROFILES) {
    // What the dialog edits: the config with the panel's fields baked in.
    const base = applyPanelSettings(parse(p.content), hyperparamsFromConfig(parse(p.content)));
    for (const f of CONFIG_FIELDS) {
        if (f.readOnly) continue;
        const doc = structuredClone(base);
        if (f.when && !f.when(doc)) continue;
        const cur = f.get(doc);
        const v = coerce(f, another(f, cur));
        assert.notEqual(v, undefined, p.filename + ' ' + f.id + ' value');
        f.set(doc, v);
        const back = f.get(doc);
        const same = f.kind === 'select' ? String(back) === String(v) : back === v;
        assert.ok(same, p.filename + ' ' + f.id + ': wrote ' + JSON.stringify(v) + ', read ' + JSON.stringify(back));
        const sent = finalizeConfig(applyPanelSettings(doc, hyperparamsFromConfig(doc)), { runName: 'r' });
        assert.deepEqual(unknownKeys(sent, '', []), [], p.filename + ' ' + f.id + ' writes only known keys');
        assert.deepEqual(badKinds(sent, '', []), [], p.filename + ' ' + f.id + ' writes values of the right kind');
        edited++;
    }
    // §4 LR scheduler: one block at a time, with defaults.
    const lr = CONFIG_FIELDS.find((f) => f.id === 'lrSchedulerType');
    for (const [k] of LR_SCHEDULERS) {
        const doc = structuredClone(base);
        lr.set(doc, k);
        assert.equal(lr.get(doc), k, p.filename + ' scheduler ' + k);
        const blocks = LR_SCHEDULERS.filter(([n]) => n !== 'none' && getPath(doc, 'trainer_config.lr_scheduler.' + n) != null).map(([n]) => n);
        assert.deepEqual(blocks, k === 'none' ? [] : [k], p.filename + ' only ' + k);
    }
    const pipe = CONFIG_FIELDS.find((f) => f.id === 'dataPipeline');
    const d2 = structuredClone(base);
    pipe.set(d2, 'torch_dataset');
    assert.equal(getPath(d2, 'trainer_config.train_data_loader.num_workers'), 0, 'streaming: no workers');
}
assert.ok(edited > BASELINE_PROFILES.length * 30, 'most fields edited on every preset (' + edited + ')');
console.log('test-training-config-fields: ' + edited + ' field edits over ' + BASELINE_PROFILES.length + ' presets');
console.log('test-training-config-fields: ok');
