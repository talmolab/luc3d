/**
 * test-training-config-keys.mjs — src-tauri/src/train_config_keys.json, the allowlist Rust checks a
 * local training config against (src-tauri/src/train_config.rs):
 *   1. it lists sleap-nn's sections and keys, the keys Rust forces, and drops W&B;
 *   2. every vendored preset (lib/sleap-app-profiles), as the panel sends it (`applyPanelSettings` +
 *      `finalizeConfig`), uses only keys the table knows (needs the offline `yaml` package);
 *   3. with sleap-nn's own Python installed (uv tool), the table matches the installed sleap-nn
 *      (`scripts/gen_train_config_keys.py --check`); skipped without it (CI has no sleap-nn).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js';
import { applyPanelSettings, finalizeConfig, hyperparamsFromConfig } from '../ui/training-args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'src', 'train_config_keys.json'), 'utf8'));
const keys = new Set(Object.keys(table.keys));
const sections = new Set(table.sections);

// §1 shape.
assert.ok(keys.size > 300, 'sleap-nn has hundreds of config keys');
for (const k of ['trainer_config.max_epochs', 'data_config.validation_fraction', 'trainer_config.train_data_loader.batch_size']) assert.ok(keys.has(k), k);
for (const k of ['trainer_config.ckpt_dir', 'trainer_config.run_name', 'model_config.pretrained_backbone_weights', 'trainer_config.zmq.publish_port']) {
    assert.ok(k in table.forced, 'forced: ' + k);
}
assert.deepEqual(table.dropped_prefixes, ['trainer_config.wandb.']);
assert.ok(![...keys].some((k) => k.startsWith('trainer_config.wandb.')), 'no W&B key is allowed through');

// The same walk Rust does (train_config.rs `walk`): unknown keys are refused.
function unknownKeys(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? prefix + '.' + k : k;
        if (p === 'trainer_config.wandb' || p.startsWith('trainer_config.wandb.')) continue;
        if (sections.has(p)) { if (v && typeof v === 'object' && !Array.isArray(v)) unknownKeys(v, p, out); continue; }
        if (!keys.has(p)) out.push(p);
    }
    return out;
}

// §2 the presets, as the panel sends them.
const yamlPath = path.join(root, 'lib', 'yaml', 'browser', 'index.js');
if (fs.existsSync(yamlPath)) {
    const YAML = await import(pathToFileURL(yamlPath).href);
    const parse = YAML.parse || (YAML.default && YAML.default.parse);
    for (const p of BASELINE_PROFILES) {
        const doc = parse(p.content);
        const sent = finalizeConfig(applyPanelSettings(doc, hyperparamsFromConfig(doc)), { runName: 'r' });
        assert.deepEqual(unknownKeys(sent, '', []), [], p.filename + ' uses only known keys');
        assert.ok(!JSON.stringify(sent).includes('${'), p.filename + ' has no interpolation');
    }
    console.log('test-training-config-keys: all ' + BASELINE_PROFILES.length + ' presets pass the key table');
} else {
    console.log('test-training-config-keys: (offline yaml package not installed: presets not walked)');
}

// §3 the table matches the installed sleap-nn.
const py = path.join(os.homedir(), '.local', 'share', 'uv', 'tools', 'sleap-nn', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
if (fs.existsSync(py)) {
    const r = spawnSync(py, ['-I', path.join(root, 'scripts', 'gen_train_config_keys.py'), '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'train_config_keys.json matches the installed sleap-nn:\n' + (r.stdout || '') + (r.stderr || ''));
    console.log('test-training-config-keys: ' + r.stdout.trim());
} else {
    console.log('test-training-config-keys: (no uv sleap-nn here: the table was not compared with it)');
}
console.log('test-training-config-keys: ok');
