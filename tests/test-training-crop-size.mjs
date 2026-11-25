/**
 * test-training-crop-size.mjs — pose/training-crop-size.js (the crop a centered-instance model trains on):
 *   1. REAL labels: the three instances of a 5-mouse, 8-camera project (1280x1024) that set its sizes
 *      (tests/fixtures/sleap-nn-training/crop-size-instances.json: the widest box and the farthest reach from the
 *      centre of mass, from Trunk and from TTI). sleap-nn 0.3.5's own `find_instance_crop_size` gave, on all 3,383
 *      training instances: Auto + Medium RF (stride 16, ±180°, scale 1.1) 752 (the size it trained on), Trunk +
 *      stride 32 768, Trunk + stride 16 768, TTI + stride 32 736; without padding 512 / 544 / 528 / 512.
 *      sleap-app's bounding-box estimate would say 672 for the first.
 *   2. augmentation padding = sleap-nn's `compute_augmentation_padding`; the probabilities as sleap-nn reads
 *      them (left-out rotation_p / scale_p = 1.0, affine_p only when none is set, use_augmentations_train off);
 *   3. the crop centre: the anchor when visible, else the centre of mass; min_crop_size; a crop size set by hand;
 *      no instances = null; a smaller video measured in size-matched pixels;
 *   4. sleap-app's warnings; node visibility percentages.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    augmentationPadding, configAugmentation, configMaxStride, cropCentre, effectiveCropSize, cropSizeWarnings,
    nodeVisibility, sizeMatchTarget, frameScale, MIN_CROP_SIZE, reducePoints, configCentroid,
} from '../pose/training-crop-size.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'sleap-nn-training', 'crop-size-instances.json'), 'utf8'));
const frames = [{ width: fx.video.width, height: fx.video.height, instances: fx.instances.map((pts) => pts.map((p) => [p[0] ?? NaN, p[1] ?? NaN, p[2]])) }];
const idx = (n) => fx.nodes.indexOf(n);

/** A centered-instance config the way the presets write it (Medium RF: stride 16; ±180°, scale 0.9–1.1). */
function config(o) {
    o = o || {};
    const geo = { rotation_min: -(o.rot ?? 180), rotation_max: o.rot ?? 180, scale_min: 0.9, scale_max: 1.1, affine_p: 1.0 };
    Object.assign(geo, o.geo || {});
    return {
        data_config: {
            use_augmentations_train: o.augment ?? true,
            preprocessing: Object.assign({ max_height: null, max_width: null, scale: 1.0, crop_size: o.crop ?? null, min_crop_size: 100 }, o.pre || {}),
            augmentation_config: { geometric: geo },
        },
        model_config: { backbone_config: { unet: { max_stride: o.stride ?? 16, filters: 24 }, convnext: null, swint: null } },
    };
}

// §1 the real labels, against sleap-nn's own numbers.
const auto16 = effectiveCropSize(config(), frames, null);
assert.equal(auto16.cropSize, 752, 'Auto + Medium RF: sleap-nn trained on 752');
assert.equal(auto16.auto, true);
assert.equal(auto16.padding, 237);
assert.ok(Math.abs(auto16.maxBboxDim - 426.1) < 0.1, String(auto16.maxBboxDim));
assert.ok(Math.abs(auto16.required - 509.1) < 0.1, String(auto16.required));
assert.equal(effectiveCropSize(config({ stride: 32 }), frames, idx('Trunk')).cropSize, 768);
assert.equal(effectiveCropSize(config({ stride: 16 }), frames, idx('Trunk')).cropSize, 768);
assert.equal(effectiveCropSize(config({ stride: 32 }), frames, idx('TTI')).cropSize, 736);
const noPad = (stride, anchor) => effectiveCropSize(config({ stride, augment: false }), frames, anchor).cropSize;
assert.deepEqual([noPad(16, null), noPad(32, idx('Trunk')), noPad(16, idx('Trunk')), noPad(32, idx('TTI'))], [512, 544, 528, 512]);
// sleap-app's estimate (largest box + padding, rounded) is smaller; the LUCID change this module documents.
assert.equal(Math.ceil((auto16.maxBboxDim + auto16.padding) / 16) * 16, 672);

// §2 padding and how a config's augmentation is read.
assert.equal(augmentationPadding(426.1, 180, 1.1), 237);
assert.equal(augmentationPadding(200, 0, 1.0), 0);
// Python's math.ceil on the same doubles: 200 * 1.1 = 220.00000000000003, so 21 (as sleap-nn).
assert.equal(augmentationPadding(200, 0, 1.1), 21);
assert.equal(augmentationPadding(200, 15, 1.0), 45);
assert.equal(augmentationPadding(200, 45, 1.0), 83);
assert.deepEqual(configAugmentation(config()), { rotationMax: 180, scaleMax: 1.1 }, 'rotation_p / scale_p left out = 1.0');
assert.equal(configAugmentation(config({ augment: false })), null);
assert.deepEqual(configAugmentation(config({ geo: { rotation_p: 0, scale_p: null, translate_p: null } })), null,
    'rotation off, scale_p null: affine_p ignored because rotation_p is set');
assert.deepEqual(configAugmentation(config({ geo: { rotation_p: null, scale_p: null, translate_p: null, affine_p: 1 } })), { rotationMax: 180, scaleMax: 1.1 },
    'all three null: affine_p bundles them');
assert.deepEqual(configAugmentation(config({ rot: 0 })), { rotationMax: 0, scaleMax: 1.1 }, 'rotation Off still scales');
const noUse = config(); delete noUse.data_config.use_augmentations_train;
assert.deepEqual(configAugmentation(noUse), { rotationMax: 180, scaleMax: 1.1 }, 'use_augmentations_train left out = True');
assert.equal(configMaxStride(config({ stride: 32 })), 32);
assert.equal(configMaxStride({ model_config: { backbone_config: { unet: null, convnext: { max_stride: 32 } } } }), 32);

// §3 the crop centre, the floor, a set crop, no instances, a smaller video.
const pts = [[0, 0, true], [100, 0, true], [10, 0, false], [NaN, NaN, false]];
assert.deepEqual(cropCentre(pts, 1), [100, 0], 'visible anchor');
assert.deepEqual(cropCentre(pts, 2), [50, 0], 'hidden anchor: centre of mass of the visible nodes');
assert.deepEqual(cropCentre(pts, null), [50, 0]);
assert.equal(cropCentre([[1, 1, false]], null), null);
const tiny = [{ width: 640, height: 480, instances: [[[10, 10, true], [30, 10, true]]] }];
const tinyCrop = effectiveCropSize(config({ augment: false }), tiny, null);
assert.equal(tinyCrop.cropSize, MIN_CROP_SIZE + (16 - MIN_CROP_SIZE % 16), 'min_crop_size 100, rounded up to the stride: 112');
const nullMin = config({ augment: false, pre: { min_crop_size: null } });
assert.equal(effectiveCropSize(nullMin, tiny, null).cropSize, 32, 'min_crop_size null: no floor (20 px reach -> 32)');
const set = effectiveCropSize(config({ crop: 512 }), frames, null);
assert.deepEqual([set.cropSize, set.auto, set.padding], [512, false, 0]);
assert.equal(effectiveCropSize(config(), [], null).cropSize, null);
const mixed = [{ width: 1280, height: 1024, instances: [] }, { width: 640, height: 512, instances: [[[0, 0, true], [100, 0, true]]] }];
const target = sizeMatchTarget(config(), mixed);
assert.deepEqual(target, { height: 1024, width: 1280 });
assert.equal(frameScale(mixed[1], target), 2, 'a half-size video is scaled up to the target');
assert.equal(effectiveCropSize(config({ augment: false }), mixed, null).required, 200, 'measured after the size matcher');
assert.deepEqual(sizeMatchTarget(config({ pre: { max_height: 600, max_width: 800 } }), mixed), { height: 600, width: 800 });

// §3b the head's centring rule (sleap-nn resolve_centroid_method / reduce_points), crop_padding, one of max_hw.
const tri = [[0, 0, true], [10, 0, true], [0, 30, true], [5, 5, false]];
assert.deepEqual(reducePoints(tri, 'center_of_mass'), [10 / 3, 10]);
assert.deepEqual(reducePoints(tri, 'bbox_center'), [5, 15]);
const gm = reducePoints([[0, 0, true], [10, 0, true], [0, 10, true], [100, 100, true]], 'geometric_median');
assert.ok(Math.abs(gm[0] - gm[1]) < 1e-9 && gm[0] > 2 && gm[0] < 6, 'Weiszfeld: pulled far less by the outlier than the mean (27.5) ' + gm);
const withHead = (leaf) => { const d = config(); d.model_config.head_configs = { centroid: null, centered_instance: { confmaps: leaf } }; return d; };
assert.deepEqual(configCentroid(config()), { method: 'center_of_mass', fallback: 'center_of_mass' });
assert.deepEqual(configCentroid(withHead({ anchor_part: null, centroid_method: 'bbox_center' })), { method: 'bbox_center', fallback: 'center_of_mass' });
assert.deepEqual(configCentroid(withHead({ centroid_fallback: 'geometric_median', centroid_method: 'nonsense' })), { method: 'center_of_mass', fallback: 'geometric_median' });
assert.deepEqual(cropCentre(tri, 3, { fallback: 'bbox_center' }), [5, 15], 'hidden anchor: the configured fallback');
assert.deepEqual(cropCentre(tri, null, { method: 'bbox_center' }), [5, 15], 'no anchor: the configured method');
assert.equal(effectiveCropSize(withHead({ centroid_method: 'bbox_center' }), frames, null).cropSize, 672,
    'Auto centred on the box midpoint: 426 + 237 -> 672 (what sleap-app estimates)');
assert.equal(effectiveCropSize(config({ pre: { crop_padding: 16 } }), frames, null).cropSize, 528, 'a set crop_padding replaces the derived one: 509 + 16 -> 528');
assert.deepEqual(sizeMatchTarget(config({ pre: { max_height: 600, max_width: null } }), mixed), { height: 1024, width: 1280 },
    'either max_height or max_width missing: sleap-nn takes both from the videos');

// §4 sleap-app's warnings, node visibility.
assert.deepEqual(cropSizeWarnings(set, 1), []);
assert.match(cropSizeWarnings({ cropSize: 160, auto: true, maxBboxDim: 120 }, 0.5)[0], /only 80px after input scaling/);
assert.match(cropSizeWarnings({ cropSize: 256, auto: false, maxBboxDim: 426.1 }, 1)[0], /smaller than the largest labeled instance \(426px\)/);
assert.deepEqual(cropSizeWarnings({ cropSize: 256, auto: true, maxBboxDim: 426.1 }, 1), [], 'Auto never clips');
assert.deepEqual(nodeVisibility([{ instances: [[[0, 0, true], [0, 0, false]], [[0, 0, true], [0, 0, true]]] }], 2), [100, 50]);
assert.deepEqual(nodeVisibility([], 2), [0, 0]);

console.log('test-training-crop-size: all checks passed');
