/**
 * test-training-groups.mjs — pose/training-groups.js: "Models for views" groups and run names.
 */
import assert from 'node:assert/strict';
import {
    trainingGroups, groupModelLabel, trainingRunName, safeRunPart, RUN_NAME_RE, GROUP_COLORS, DEFAULT_GROUP_MODE,
} from '../pose/training-groups.js';

assert.equal(DEFAULT_GROUP_MODE, 'shared');

// §1 shared: one group with every view, de-duplicated, order kept.
{
    const g = trainingGroups('shared', ['cam1', 'cam2', 'cam1', '', null, 'cam3']);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].views, ['cam1', 'cam2', 'cam3']);
    assert.equal(g[0].name, 'all views');
    assert.equal(g[0].color, GROUP_COLORS[0]);
}

// §2 per view: one group per camera, colours cycling.
{
    const g = trainingGroups('perview', ['cam1', 'cam2']);
    assert.deepEqual(g.map((x) => x.views), [['cam1'], ['cam2']]);
    assert.deepEqual(g.map((x) => x.id), ['view:cam1', 'view:cam2']);
    assert.equal(g[1].color, GROUP_COLORS[1]);
    assert.deepEqual(trainingGroups('perview', []), []);
}

// §3 labels and run names.
assert.equal(groupModelLabel('Centroid', { name: 'all views' }), 'Centroid · all views');
assert.equal(groupModelLabel('Centroid', null), 'Centroid');
assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'centroid', mode: 'shared', group: { name: 'all views' }, nFrames: 168 }),
    '251123_142211.centroid.n=168');
assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'centered_instance', mode: 'perview', group: { name: 'cam 2/side' }, nFrames: 69 }),
    '251123_142211.centered_instance.cam_2_side.n=69');
assert.equal(trainingRunName({ timestamp: '251123_142211', head: 'bottomup', nFrames: null }), '251123_142211.bottomup');
assert.equal(safeRunPart('..'), '_');
assert.equal(safeRunPart('.hidden'), '_hidden');
assert.equal(safeRunPart(''), '_');
assert.ok(RUN_NAME_RE.test('251123_142211.centroid.cam2.n=69'));
assert.ok(!RUN_NAME_RE.test('../x'));
assert.ok(!RUN_NAME_RE.test('a/b'));
assert.ok(!RUN_NAME_RE.test('..'));
assert.ok(!RUN_NAME_RE.test('.x'));

console.log('test-training-groups: ok');
