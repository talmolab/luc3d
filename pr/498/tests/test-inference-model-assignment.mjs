// Per-view model assignment (ui/inference-model-assignment.js) and the
// playback-key modal rule (ui/keyboard-target.js playbackBlockedByModal).
import assert from 'node:assert/strict';
import {
    createAssignment, cloneAssignment, addModel, addFolderToModel, removeModel, assignView, assignViews,
    clearAssignments, modelOfView, viewsOfModel, pruneViews, perViewModelPaths, modelLabel, foldersNeeded, folderName,
} from '../ui/inference-model-assignment.js';
import { playbackBlockedByModal, isPlaybackKey } from '../ui/keyboard-target.js';
import { defaultInferenceConfig } from '../ui/inference-args.js';
import { planInferenceJobs } from '../ui/inference-jobs.js';

const VIEWS = ['back', 'backL', 'mid', 'top', 'topL'];

// 1. Starts empty: no view has a model.
const a = createAssignment();
assert.equal(a.models.length, 0);
VIEWS.forEach((v) => assert.equal(modelOfView(a, v), null));
assert.deepEqual(perViewModelPaths(a, VIEWS), {}, 'nothing assigned → no view runs');

// 2. One model per view, and one model for several views.
const bu = addModel(a, ['/m/luc3d_6views_bottomup']);
const top = addModel(a, ['/m/top_bottomup/']);
assert.equal(addModel(a, ['/m/luc3d_6views_bottomup']), bu, 'the same folder twice is the same model');
assert.equal(a.models.length, 2);
assert.notEqual(bu.color, top.color, 'each model gets its own colour');
assert.equal(modelLabel(top), 'top_bottomup');
assignViews(a, ['back', 'backL', 'mid'], bu.id);
assignView(a, 'top', top.id);
assert.deepEqual(viewsOfModel(a, bu.id, VIEWS), ['back', 'backL', 'mid']);
assert.deepEqual(viewsOfModel(a, top.id, VIEWS), ['top']);
assignView(a, 'mid', top.id);   // moving a view leaves its old model
assert.deepEqual(viewsOfModel(a, bu.id, VIEWS), ['back', 'backL']);
assignView(a, 'topL', 'no-such-model');
assert.equal(modelOfView(a, 'topL'), null, 'an unknown model id assigns nothing');

// 3. perViewModelPaths → jobs: each view its own folders; a view with no model is skipped.
const pv = perViewModelPaths(a, VIEWS);
assert.deepEqual(pv, { back: ['/m/luc3d_6views_bottomup'], backL: ['/m/luc3d_6views_bottomup'], mid: ['/m/top_bottomup/'], top: ['/m/top_bottomup/'] });
const cfg = defaultInferenceConfig();
cfg.modelPaths = [];
cfg.perViewModels = pv;
const plan = planInferenceJobs(cfg, VIEWS.map((v) => ({ view: v, videoPath: '/v/' + v + '.mp4', frames: null })), { outputDir: '/o', stamp: 'S' });
assert.deepEqual(plan.jobs.map((j) => j.view + ':' + j.modelPaths.join()), [
    'back:/m/luc3d_6views_bottomup', 'backL:/m/luc3d_6views_bottomup', 'mid:/m/top_bottomup/', 'top:/m/top_bottomup/']);
assert.deepEqual(plan.skipped, [{ view: 'topL', reason: 'no model' }]);

// 4. The modal edits a copy.
const copy = cloneAssignment(a);
clearAssignments(copy);
assert.deepEqual(copy.byView, {});
assert.equal(Object.keys(a.byView).length, 4, 'clearing the copy leaves the applied assignment');
assert.equal(copy.models.length, 2, 'Clear all keeps the models');

// 5. Remove a model → its views go back to no model; prune drops views of another session.
removeModel(a, top.id);
assert.equal(modelOfView(a, 'top'), null);
assert.equal(modelOfView(a, 'mid'), null);
pruneViews(a, ['back']);
assert.deepEqual(Object.keys(a.byView), ['back']);

// 6. Top-Down: two folders per model.
assert.equal(foldersNeeded('top-down'), 2);
assert.equal(foldersNeeded('bottom-up'), 1);
const td = addModel(a, ['/m/centroid']);
assert.equal(addFolderToModel(a, td.id, '/m/centered'), true);
assert.equal(addFolderToModel(a, td.id, '/m/centered'), false, 'no duplicate folder');
assert.equal(modelLabel(td), 'centroid + centered');
assert.equal(folderName('C:\\models\\run1\\'), 'run1');

// 7. Playback keys under modals.
function fakeDoc(layers) {
    return {
        querySelectorAll: () => layers.map((l) => ({
            hasAttribute: (n) => n === 'data-allow-playback' && !!l.allow,
            getClientRects: () => (l.hidden ? [] : [1]),
        })),
    };
}
assert.equal(playbackBlockedByModal(fakeDoc([])), false, 'no modal → playback keys work');
assert.equal(playbackBlockedByModal(fakeDoc([{}])), true, 'a modal → blocked');
assert.equal(playbackBlockedByModal(fakeDoc([{ allow: true }])), false, 'a tracking/triangulation modal → allowed');
assert.equal(playbackBlockedByModal(fakeDoc([{ allow: true }, {}])), true, 'any other modal on top → blocked');
assert.equal(playbackBlockedByModal(fakeDoc([{ hidden: true }])), false, 'a hidden backdrop does not count');
for (const k of ['ArrowLeft', 'ArrowRight', ' ', 'Home', 'End']) assert.equal(isPlaybackKey({ key: k }), true, k);
assert.equal(isPlaybackKey({ key: 'ArrowLeft', altKey: true }), true, 'Opt+← (labeled frame) is playback');
assert.equal(isPlaybackKey({ key: 'ArrowLeft', metaKey: true }), false);
assert.equal(isPlaybackKey({ key: '+' }), false, 'zoom is not playback');

console.log('test-inference-model-assignment: ok');
