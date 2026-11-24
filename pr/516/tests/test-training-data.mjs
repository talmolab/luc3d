/**
 * test-training-data.mjs — pose/training-data.js: the validation split by moment, the `${`
 * name check and the identity-model checks behind the Training panel.
 */
import assert from 'node:assert/strict';
import {
    momentKey, splitMoments, seededRandom, interpolationProblem, idModelProblem,
    isIdModelType, isBoxModelType, DEFAULT_VALIDATION_FRACTION,
} from '../pose/training-data.js';

// §1 moment keys are unique across sessions.
assert.equal(momentKey(0, 12), '0:12');
assert.notEqual(momentKey(0, 12), momentKey(1, 12));

// §2 split by moment: every view of one moment lands on one side.
{
    const keys = [];
    for (let s = 0; s < 2; s++) for (let f = 0; f < 50; f++) for (let cam = 0; cam < 4; cam++) keys.push(momentKey(s, f * 10));
    const sp = splitMoments(keys, { fraction: 0.1, seed: 3 });
    assert.equal(sp.sameAsTrain, false);
    assert.equal(sp.train.size + sp.val.size, 100, 'duplicates (views) collapse into one moment');
    assert.equal(sp.val.size, 10, '10 % of 100 moments');
    for (const k of sp.val) assert.ok(!sp.train.has(k), 'a moment is never on both sides');
    // Reproducible, and independent of visit order.
    const again = splitMoments(keys.slice().reverse(), { fraction: 0.1, seed: 3 });
    assert.deepEqual([...again.val].sort(), [...sp.val].sort());
    const other = splitMoments(keys, { fraction: 0.1, seed: 4 });
    assert.notDeepEqual([...other.val].sort(), [...sp.val].sort(), 'another seed, another split');
}

// §3 small sets: at least one on each side; one moment → validation = training.
{
    const two = splitMoments([momentKey(0, 1), momentKey(0, 2)], { fraction: 0.1 });
    assert.equal(two.val.size, 1);
    assert.equal(two.train.size, 1);
    const one = splitMoments([momentKey(0, 1), momentKey(0, 1)]);
    assert.equal(one.sameAsTrain, true);
    assert.equal(one.reason, 'too-few');
    assert.deepEqual([...one.val], ['0:1']);
    const big = splitMoments(Array.from({ length: 5 }, (_, i) => momentKey(0, i)), { fraction: 0.99 });
    assert.ok(big.train.size >= 1 && big.val.size >= 1);
    const def = splitMoments(Array.from({ length: 40 }, (_, i) => momentKey(0, i)));
    assert.equal(def.val.size, Math.round(40 * DEFAULT_VALIDATION_FRACTION));
}

// §4 overfit mode: validation is the training data.
{
    const sp = splitMoments([momentKey(0, 1), momentKey(0, 2), momentKey(1, 2)], { overfit: true });
    assert.equal(sp.sameAsTrain, true);
    assert.equal(sp.reason, 'overfit');
    assert.equal(sp.train.size, 3);
    assert.equal(sp.val.size, 3);
}

// §5 the PRNG is deterministic.
{
    const a = seededRandom(7), b = seededRandom(7);
    for (let i = 0; i < 5; i++) assert.equal(a(), b());
}

// §6 `${` names are refused (they become OmegaConf interpolations in training_config.yaml).
assert.equal(interpolationProblem([{ kind: 'node', names: ['head', 'thorax'] }]), null);
assert.match(interpolationProblem([{ kind: 'node', names: ['head', '${oc.env:HOME}'] }]), /node name "\$\{oc\.env:HOME\}"/);
assert.equal(interpolationProblem([{ kind: 'node', names: ['$tail'] }]), null, 'a lone $ is fine');

// §7 identity-model checks.
const sess = (o) => Object.assign({ name: 'S1', fromIdentity: true, trackNames: ['Ann', 'Bob'], userInstances: 10, trackless: 0 }, o);
assert.equal(idModelProblem([sess()], { views: 4 }), null);
assert.match(idModelProblem([sess({ trackless: 2 })], { views: 4 }), /2 labelled instances in S1 have no identity/);
assert.match(idModelProblem([sess({ trackless: 10, predictedWithIdentity: 5 })], { views: 4 }), /only on predicted/);
assert.match(idModelProblem([sess({ fromIdentity: false, trackNames: ['track_0'] })], { views: 2 }), /tracks but no identities/);
assert.equal(idModelProblem([sess({ fromIdentity: false, trackNames: ['track_0'] })], { views: 1 }), null,
    'one camera of one session: its own tracks are consistent (sleap-app parity)');
assert.match(idModelProblem([sess({ fromIdentity: false }), sess({ name: 'S2', fromIdentity: false })], { views: 1 }), /across sessions/);
assert.match(idModelProblem([sess({ trackNames: ['track_0', 'track_1'] }), sess({ name: 'S2', trackNames: ['track_0', 'track_1'] })], { views: 2 }), /no names/);
assert.match(idModelProblem([sess(), sess({ name: 'S2', trackNames: ['Ann', 'Cat'] })], { views: 2 }), /name their identities differently/);
assert.equal(idModelProblem([sess(), sess({ name: 'S2', trackNames: ['Bob', 'Ann'] })], { views: 2 }), null, 'same names, any order');
assert.equal(idModelProblem([sess({ trackNames: ['track_0'] })], { views: 3 }), null, 'one session: positions cannot collide');
assert.match(idModelProblem([sess({ userInstances: 0 })], { views: 1 }), /Label at least one frame/);
assert.equal(idModelProblem([sess(), sess({ name: 'S2', userInstances: 0, trackNames: [] })], { views: 2 }), null, 'a session with no labels is ignored');

// §8 model-type helpers.
assert.ok(isIdModelType('top_down_id') && isIdModelType('bottom_up_id') && !isIdModelType('top_down'));
assert.ok(isBoxModelType('bbox') && isBoxModelType('top_down_bbox') && !isBoxModelType('bottom_up'));

console.log('test-training-data: ok');
