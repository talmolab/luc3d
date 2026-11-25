/**
 * pose/training-handoff.js — post-training inference, DOM-free (sleap-app `src/lib/postTrainingTarget.ts`
 * and the post-training step of `trainingStore.ts`): the target choices, the Inference panel pipeline of a
 * trained model type, which trained model folders run on which views, and the skeleton check.
 *
 * LUCID changes: the targets are the Inference panel's (no Suggested frames or Selected clip: LUC3D has
 * neither; "Entire session (all views)" and one random sample of moments shared by every view, so the
 * views stay comparable in 3D). The default is Random sample, not sleap-app's Suggested frames: a few
 * predicted frames to correct, which is what sleap-app's default is for. Each model runs on the views of
 * the current session it was trained for ("One model for all views": every trained view).
 *
 * Tests: tests/test-training-handoff.mjs.
 */

/** sleap-app POST_TRAINING_TARGET_OPTIONS, with the Inference panel's targets. */
export const POST_TRAINING_TARGETS = Object.freeze([
    ['nothing', 'Nothing (skip inference)'],
    ['frame', 'Current frame'],
    ['user_labeled', 'User labeled frames'],
    ['predicted', 'Frames with predictions'],
    ['video', 'Entire session (all views)'],
    ['random', 'Random sample'],
]);

export const POST_TRAINING_DEFAULTS = Object.freeze({
    target: 'random',
    sampleCount: 20,
    skipUserLabeled: false,
    existingPredictions: 'replace',
});

export const POST_TRAINING_TARGET_HINT = 'Which frames of the current session to run inference on after training completes. ' +
    'Predictions will be merged back into the project.';

/** The Inference panel's pipeline (`ui/inference-panel.js` PIPELINE_OPTIONS) for a trained model type. */
export function inferencePipelineFor(modelType) {
    return ({
        single_animal: 'single-animal',
        top_down: 'top-down',
        bottom_up: 'bottom-up',
        top_down_id: 'top-down-id',
        bottom_up_id: 'bottom-up-id',
    })[modelType] || null;
}

/**
 * The models a finished run hands to inference: one entry per group whose every model trained and
 * reported its folder, with the group's views and the folders in the group's model order (Top-Down:
 * centroid, then centered instance). `incomplete` names the groups left out.
 *
 * @param {{groupId: string, status: string, modelDir: string|null}[]} rows the run's progress rows
 * @param {{id: string, name: string, views: string[]}[]} groups the run's groups
 */
export function trainedModels(rows, groups) {
    const models = [];
    const incomplete = [];
    for (const g of groups || []) {
        const rs = (rows || []).filter(function (r) { return r.groupId === g.id; });
        const ok = rs.length > 0 && rs.every(function (r) { return r.status === 'completed' && !!r.modelDir; });
        if (ok) models.push({ groupId: g.id, name: g.name, views: g.views.slice(), paths: rs.map(function (r) { return r.modelDir; }) });
        else incomplete.push(g.name);
    }
    return { models: models, incomplete: incomplete };
}

/**
 * Why the trained models' predictions cannot be merged into the project now, or null: the merge
 * requires the same node names (`validateSkeletonCompatibility`), and the skeleton may have been edited
 * while the models trained (the training file is a snapshot).
 */
export function skeletonChangeProblem(trainedNodes, currentNodes) {
    const a = (trainedNodes || []).map(String);
    const b = (currentNodes || []).map(String);
    const added = b.filter(function (n) { return a.indexOf(n) === -1; });
    const removed = a.filter(function (n) { return b.indexOf(n) === -1; });
    if (!added.length && !removed.length) return null;
    const parts = [];
    if (added.length) parts.push('added ' + added.join(', '));
    if (removed.length) parts.push('removed ' + removed.join(', '));
    return 'The skeleton changed while the models trained (' + parts.join('; ') + '), so their predictions cannot be merged.';
}
