/**
 * test-training-models.mjs — pose/training-models.js: the models of a training run, their views, the quick
 * splits, problems, the inference model of a view, and run names.
 */
import assert from 'node:assert/strict';
import {
    MODEL_COLORS, ALL_VIEWS_NAME, orderedViews, freeColor, newModelName, createModel, modelViews, setModelViews, toggleModelView,
    addModelViews, removeModelViews, modelsOfView, viewToken, viewTokens, splitViews, modelProblems, inferenceModelOf, modelRunLabel,
    trainingRunName, safeRunPart, RUN_NAME_RE, uniqueRunParts,
} from '../pose/training-models.js';

const ALL = ['Camera0_mid', 'Camera1_topB', 'Camera2_topC', 'Camera3_topL', 'Camera4_topR', 'Camera5_sideR', 'Camera6_sideC', 'Camera7_sideL'];

// §1 order and creation.
{
    assert.deepEqual(orderedViews(['b', 'x', 'a', 'b', ''], ['a', 'b', 'c']), ['a', 'b', 'x']);
    const a = createModel([], { views: ['cam1', 'cam1', 'cam2'], extra: { modelType: 'top_down' } });
    assert.equal(a.id, 'm1');
    assert.equal(a.name, 'Model 1');
    assert.equal(a.color, MODEL_COLORS[0]);
    assert.deepEqual(a.views, ['cam1', 'cam2']);
    assert.equal(a.modelType, 'top_down');
    assert.equal(a.auto, false);
    const b = createModel([a], { name: '  Top views ' });
    assert.equal(b.id, 'm2');
    assert.equal(b.name, 'Top views');
    assert.equal(b.color, MODEL_COLORS[1]);
    assert.equal(newModelName([a, { name: 'Model 2' }]), 'Model 3');
    assert.equal(freeColor(MODEL_COLORS.map((c) => ({ color: c }))), MODEL_COLORS[0]);
}

// §2 auto models follow every view; an edit makes the views explicit.
{
    const m = createModel([], { name: ALL_VIEWS_NAME, views: ['cam1'], auto: true });
    assert.deepEqual(modelViews(m, ['cam1', 'cam2']), ['cam1', 'cam2']);
    toggleModelView(m, 'cam2', ['cam1', 'cam2', 'cam3']);
    assert.equal(m.auto, false);
    assert.deepEqual(m.views, ['cam1', 'cam3']);
    toggleModelView(m, 'cam2', ['cam1', 'cam2', 'cam3']);
    assert.deepEqual(m.views, ['cam1', 'cam2', 'cam3']);
    removeModelViews(m, ['cam1', 'cam3'], ['cam1', 'cam2', 'cam3']);
    assert.deepEqual(m.views, ['cam2']);
    addModelViews(m, ['cam3', 'cam1'], ['cam1', 'cam2', 'cam3']);
    assert.deepEqual(m.views, ['cam1', 'cam2', 'cam3']);
    // A view the project does not show (a session not open) is kept, but does not train.
    setModelViews(m, ['gone', 'cam2'], ['cam1', 'cam2']);
    assert.deepEqual(m.views, ['cam2', 'gone']);
    assert.deepEqual(modelViews(m, ['cam1', 'cam2']), ['cam2']);
}

// §3 name tokens and quick splits.
{
    assert.equal(viewToken('Camera1_topB'), 'top');
    assert.equal(viewToken('Camera6_sideC'), 'side');
    assert.equal(viewToken('Camera0_mid'), 'mid');
    assert.equal(viewToken('back2'), 'back');
    assert.equal(viewToken('cam-A'), 'a');
    assert.deepEqual(viewTokens(ALL), ['mid', 'top', 'side']);
    assert.deepEqual(splitViews('all', ALL), [{ name: 'All views', views: ALL, auto: true }]);
    assert.equal(splitViews('perview', ALL).length, 8);
    assert.deepEqual(splitViews('name', ALL).map((s) => [s.name, s.views.length]), [['Mid views', 1], ['Top views', 4], ['Side views', 3]]);
    assert.deepEqual(splitViews('all', []), []);
}

// §4 problems, a view in two models, and which model a view infers with.
{
    const top = createModel([], { name: 'Top', views: ['Camera0_mid', 'Camera1_topB', 'Camera2_topC'] });
    const side = createModel([top], { name: 'Side', views: ['Camera0_mid', 'Camera5_sideR'] });
    const empty = createModel([top, side], { name: 'Empty' });
    const ms = [top, side, empty];
    const avail = ['Camera0_mid', 'Camera1_topB', 'Camera2_topC', 'Camera5_sideR', 'Camera7_sideL'];
    assert.deepEqual(modelsOfView(ms, 'Camera0_mid', avail).map((m) => m.name), ['Top', 'Side']);
    const p = modelProblems(ms, avail);
    assert.deepEqual(p.unused, ['Camera7_sideL']);
    assert.deepEqual(p.empty.map((m) => m.name), ['Empty']);
    // The most specific model (fewest views) by default; the user's pick when it trains the view.
    assert.equal(inferenceModelOf(ms, 'Camera0_mid', {}, avail).name, 'Side');
    assert.equal(inferenceModelOf(ms, 'Camera0_mid', { Camera0_mid: top.id }, avail).name, 'Top');
    assert.equal(inferenceModelOf(ms, 'Camera0_mid', { Camera0_mid: empty.id }, avail).name, 'Side');
    assert.equal(inferenceModelOf(ms, 'Camera7_sideL', {}, avail), null);
    // A tie keeps the first in the list.
    const a = createModel([], { name: 'A', views: ['x', 'y'] });
    const b = createModel([a], { name: 'B', views: ['x', 'z'] });
    assert.equal(inferenceModelOf([a, b], 'x', null, ['x', 'y', 'z']).name, 'A');
}

// §5 labels and run names.
{
    assert.equal(modelRunLabel('Centroid', { name: 'Top views' }, true), 'Centroid · Top views');
    assert.equal(modelRunLabel('Centroid', { name: 'All views' }, false), 'Centroid');
    assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'centroid', model: { name: 'All views' }, multi: false, nFrames: 168 }),
        '251123_142211.centroid.n=168');
    assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'centered_instance', model: { name: 'Top views/2' }, multi: true, nFrames: 500 }),
        '251123_142211.centered_instance.Top_views_2.n=500');
    assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'bottomup', nFrames: null }), '251123_142211.bottomup');
    assert.equal(safeRunPart('..'), '_');
    assert.equal(safeRunPart('.hidden'), '_hidden');
    assert.equal(safeRunPart(''), '_');
    assert.ok(RUN_NAME_RE.test('251123_142211.centroid.Top_views.n=69'));
    assert.ok(!RUN_NAME_RE.test('../x'));
    assert.ok(!RUN_NAME_RE.test('a/b'));
    assert.ok(!RUN_NAME_RE.test('..'));
    assert.ok(!RUN_NAME_RE.test('.x'));
}

// §6 run parts are unique across a run (names that sanitize alike, case-insensitive file systems).
{
    const parts = uniqueRunParts([{ id: 'a', name: 'Top views' }, { id: 'b', name: 'Top_views' }, { id: 'c', name: '顶部' },
        { id: 'd', name: '侧面' }, { id: 'e', name: 'top_VIEWS' }, { id: 'f', name: 'Side' }]);
    assert.deepEqual([...parts.values()], ['Top_views', 'Top_views_2', '_', '__2', 'top_VIEWS_3', 'Side']);
}

console.log('test-training-models: ok');
