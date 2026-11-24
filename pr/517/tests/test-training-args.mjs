/**
 * test-training-args.mjs — ui/training-args.js: model types, config slots and the mapping between
 * a sleap-nn training config and the Training panel's fields (sleap-app parity), plus the vendored
 * presets (lib/sleap-app-profiles/profiles.js). With the offline `yaml` package installed
 * (scripts/offline_deps.py install), every preset is also parsed and round-tripped.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    MODEL_TYPE_OPTIONS, getConfigSlots, getSlotLabel, slotToHeadType, headLabel, profilesForHead, defaultProfile,
    detectHeadType, hyperparamsFromConfig, applyPanelSettings, finalizeConfig, anchorChoices, DEFAULT_MODEL_TYPE,
} from '../ui/training-args.js';
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// §1 sleap-app's model types, slots and labels.
assert.deepEqual(MODEL_TYPE_OPTIONS.map((o) => o.label),
    ['Single Animal', 'Top-Down', 'Bottom-Up', 'Top-Down + ID', 'Bottom-Up + ID', 'Box Detector', 'Top-Down (Box Crops)']);
assert.equal(DEFAULT_MODEL_TYPE, 'top_down');
assert.deepEqual(getConfigSlots('top_down'), ['centroid', 'centered_instance']);
assert.deepEqual(getConfigSlots('top_down_id'), ['centroid', 'centered_instance']);
assert.deepEqual(getConfigSlots('bottom_up'), ['config']);
assert.deepEqual(getConfigSlots('single_animal'), ['config']);
assert.equal(getSlotLabel('centroid'), 'Centroid Config');
assert.equal(getSlotLabel('centered_instance'), 'Centered Instance Config');
assert.equal(getSlotLabel('config'), 'Config');
assert.equal(slotToHeadType('top_down', 'centroid'), 'centroid');
assert.equal(slotToHeadType('top_down', 'centered_instance'), 'centered_instance');
assert.equal(slotToHeadType('top_down_id', 'centered_instance'), 'multi_class_topdown', 'LUCID: the ID pipeline gets the multi-class preset');
assert.equal(slotToHeadType('bottom_up', 'config'), 'bottomup');
assert.equal(slotToHeadType('bottom_up_id', 'config'), 'multi_class_bottomup');
assert.equal(slotToHeadType('single_animal', 'config'), 'single_instance');
assert.equal(headLabel('centered_instance'), 'Centered Instance');
assert.equal(headLabel('bottomup'), 'Bottom-Up');

// §2 the presets: 10 pose profiles, Medium RF first, labels as sleap-app shows them.
assert.equal(BASELINE_PROFILES.length, 10);
assert.ok(BASELINE_PROFILES.every((p) => !/bbox/.test(p.filename)), 'no box-detector profiles');
assert.deepEqual(profilesForHead('centroid').map((p) => p.label), ['Preset: Centroid (Medium RF)', 'Preset: Centroid (Large RF)']);
assert.equal(defaultProfile('top_down', 'centered_instance').label, 'Preset: Centered Instance (Medium RF)');
assert.equal(defaultProfile('top_down_id', 'centered_instance').label, 'Preset: Multi-Class Top-Down');
assert.equal(defaultProfile('bottom_up', 'config').label, 'Preset: Bottom-Up (Medium RF)');
for (const p of BASELINE_PROFILES) assert.ok(!p.content.includes('${'), p.filename + ' has no interpolation');

// §3 reading and writing the panel's fields (a centered-instance config's shape).
const doc = {
    data_config: { validation_fraction: 0.1, augmentation_config: { geometric: { rotation_min: -180, rotation_max: 180, scale_min: 0.9, scale_max: 1.1, affine_p: 1 } },
        skeletons: [{ nodes: ['x'] }] },
    model_config: { head_configs: { single_instance: null, centroid: null, centered_instance: { confmaps: { part_names: ['a'], anchor_part: 'thorax', sigma: 2.5 } }, bottomup: null } },
    trainer_config: { max_epochs: 200, train_data_loader: { batch_size: 4 }, seed: 7, use_wandb: true, wandb: { api_key: 'secret' } },
};
assert.equal(detectHeadType(doc), 'centered_instance');
const hp = hyperparamsFromConfig(doc);
assert.deepEqual(hp, { maxEpochs: 200, batchSize: 4, rotationPreset: '180', rotationCustomAngle: 180, scaleEnabled: true, scaleMin: 0.9,
    scaleMax: 1.1, anchorPart: 'thorax', validationFraction: 0.1, seed: 7 });
const out = applyPanelSettings(doc, Object.assign({}, hp, { maxEpochs: 5, batchSize: 8, rotationPreset: '15', scaleEnabled: false, anchorPart: 'head' }));
assert.equal(out.trainer_config.max_epochs, 5);
assert.equal(out.trainer_config.train_data_loader.batch_size, 8);
assert.deepEqual([out.data_config.augmentation_config.geometric.rotation_min, out.data_config.augmentation_config.geometric.rotation_max,
    out.data_config.augmentation_config.geometric.affine_p], [-15, 15, 1]);
assert.deepEqual([out.data_config.augmentation_config.geometric.scale_min, out.data_config.augmentation_config.geometric.scale_max], [1, 1]);
assert.equal(out.model_config.head_configs.centered_instance.confmaps.anchor_part, 'head');
assert.equal(out.model_config.head_configs.centered_instance.confmaps.sigma, 2.5, 'other values kept');
assert.equal(doc.trainer_config.max_epochs, 200, 'the source config is not changed');
// The panel's Validation Fraction is written (sleap-app applyHyperparamsToYaml): a worker's sleap-nn splits by it.
assert.equal(applyPanelSettings(doc, Object.assign({}, hp, { validationFraction: 0.25 })).data_config.validation_fraction, 0.25);
const off = applyPanelSettings(doc, Object.assign({}, hp, { rotationPreset: 'off' }));
assert.deepEqual([off.data_config.augmentation_config.geometric.rotation_max, off.data_config.augmentation_config.geometric.affine_p], [0, 0]);
assert.equal(hyperparamsFromConfig(off).rotationPreset, 'off');
const cust = applyPanelSettings(doc, Object.assign({}, hp, { rotationPreset: 'custom', rotationCustomAngle: 45 }));
assert.equal(hyperparamsFromConfig(cust).rotationPreset, 'custom');
assert.equal(hyperparamsFromConfig(cust).rotationCustomAngle, 45);
// A centroid head has no anchor key: a null anchor never adds one.
const cen = { model_config: { head_configs: { centroid: { confmaps: { sigma: 2.5 } } } } };
assert.ok(!('anchor_part' in applyPanelSettings(cen, Object.assign({}, hp, { anchorPart: null })).model_config.head_configs.centroid.confmaps));

// §4 finalizeConfig pins what LUC3D owns.
const fin = finalizeConfig(out, { runName: '251123_142211.centered_instance.n=12', validationFraction: 0.2 });
assert.equal(fin.trainer_config.run_name, '251123_142211.centered_instance.n=12');
assert.equal(fin.trainer_config.use_wandb, false);
assert.equal(fin.trainer_config.wandb.api_key, '');
assert.deepEqual(fin.data_config.skeletons, []);
assert.equal(fin.data_config.train_labels_path, null);
assert.equal(fin.data_config.validation_fraction, 0.2);
assert.equal(fin.model_config.head_configs.centered_instance.confmaps.part_names, null, 'a preset\'s node names are cleared');
assert.deepEqual(anchorChoices(['head', 'tail']), [['', 'Auto'], ['head', 'head'], ['tail', 'tail']]);

// §5 every preset parses, maps to its head and round-trips (needs the offline yaml package).
const yamlPath = path.join(root, 'lib', 'yaml', 'browser', 'index.js');
if (fs.existsSync(yamlPath)) {
    const YAML = await import(pathToFileURL(yamlPath).href);
    const parse = YAML.parse || (YAML.default && YAML.default.parse);
    const stringify = YAML.stringify || (YAML.default && YAML.default.stringify);
    for (const p of BASELINE_PROFILES) {
        const d = parse(p.content);
        assert.equal(detectHeadType(d), p.headType, p.filename + ' head');
        const h = hyperparamsFromConfig(d);
        assert.ok(h.maxEpochs > 0 && h.batchSize > 0, p.filename + ' epochs/batch');
        const again = parse(stringify(finalizeConfig(applyPanelSettings(d, h), { runName: 'r' })));
        assert.deepEqual(hyperparamsFromConfig(again).maxEpochs, h.maxEpochs);
        assert.equal(again.trainer_config.run_name, 'r');
    }
    console.log('test-training-args: presets parsed with the offline yaml package');
} else {
    console.log('test-training-args: (offline yaml package not installed: preset parsing skipped)');
}
console.log('test-training-args: ok');
