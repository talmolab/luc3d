/**
 * Tests for pose/connect/new-job-plan.js — the DOM-free part of the New job wizard's Inference path
 * (sleap-app tests/unit/newJobWizard.test.tsx "Inference: Models step / Submit" + the LUCID data sources).
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  workerFileKind, inferenceTargetsFor, frameRangeError, buildWorkerInferenceConfig, buildWorkerFileSpecs,
  fileSourceBlocker, seedWizardFromRun,
} from '../pose/connect/new-job-plan.js';
import { projectTag } from '../pose/connect/project-tag.js';
import { groupCompletedRuns } from '../pose/connect/worker-ui-helpers.js';
import { INFERENCE_DEFAULTS } from '../ui/inference-args.js';

describe('workerFileKind / inferenceTargetsFor', () => {
  it('tells labels, video and other apart (case-insensitive)', () => {
    expect(workerFileKind('/data/a.slp')).toBe('slp');
    expect(workerFileKind('/data/A.SLP')).toBe('slp');
    expect(workerFileKind('/data/cam1.mp4')).toBe('video');
    expect(workerFileKind('/data/cam1.MOV')).toBe('video');
    expect(workerFileKind('/data/notes.txt')).toBe('other');
    expect(workerFileKind(null)).toBe('other');
  });
  it('a .slp keeps sleap-app\'s targets minus Random sample; a video offers the whole video or a range', () => {
    expect(inferenceTargetsFor('slp').map((t) => t.value)).toEqual(['suggestions', 'user_labeled', 'predicted', 'all_videos']);
    expect(inferenceTargetsFor('video').map((t) => t.value)).toEqual(['video', 'range']);
  });
  it('validates a frame range', () => {
    expect(frameRangeError(0, 9)).toBeNull();
    expect(frameRangeError(5, 5)).toBeNull();
    expect(frameRangeError(9, 0)).toBe('The last frame must be at least the first.');
    expect(frameRangeError(NaN, 3)).toBe('Enter whole frame numbers, 0 or more.');
    expect(frameRangeError(-1, 3)).toBe('Enter whole frame numbers, 0 or more.');
    expect(frameRangeError(0.5, 3)).toBe('Enter whole frame numbers, 0 or more.');
  });
});

describe('buildWorkerFileSpecs', () => {
  const base = { modelDirs: ['/data/models/td'], headTypes: ['centroid', 'centered_instance'], defaults: INFERENCE_DEFAULTS };

  it('a worker .slp: one standalone track job on the labels path, the model dirs, a frame filter, the project tag', () => {
    const specs = buildWorkerFileSpecs({ ...base, path: '/data/sess/a.slp', target: 'suggestions' });
    expect(specs.length).toBe(1);
    expect(specs[0].type).toBe('track');
    expect(specs[0].data_path).toBe('/data/sess/a.slp');
    expect(specs[0].model_paths).toEqual(['/data/models/td']);
    expect(specs[0].frame_filter).toBe('suggested');
    expect(specs[0].project).toEqual(projectTag('/data/sess/a.slp'));
    expect('video_index' in specs[0]).toBe(false);
    expect('frames' in specs[0]).toBe(false);
  });

  it('a worker .slp with All videos has neither filter nor frames', () => {
    const [s] = buildWorkerFileSpecs({ ...base, path: '/data/a.slp', target: 'all_videos' });
    expect('frame_filter' in s).toBe(false);
    expect('frames' in s).toBe(false);
  });

  it('a worker video: a plain track job with no view tag; the whole video has no frames', () => {
    const [s] = buildWorkerFileSpecs({ ...base, path: '/data/sess/cam1/0.mp4', target: 'video' });
    expect(s.type).toBe('track');
    expect(s.data_path).toBe('/data/sess/cam1/0.mp4');
    expect(s.model_paths).toEqual(['/data/models/td']);
    expect('frames' in s).toBe(false);
    expect('video_index' in s).toBe(false);
    expect('camera' in s).toBe(false);
    expect(s.project).toEqual(projectTag('/data/sess/cam1/0.mp4'));
  });

  it('a worker video with a frame range sends frames "a-b"', () => {
    const [s] = buildWorkerFileSpecs({ ...base, path: '/data/c.mp4', target: 'range', start: 10, end: 49 });
    expect(s.frames).toBe('10-49');
  });

  it('refuses a file that is neither .slp nor video', () => {
    expect(buildWorkerFileSpecs({ ...base, path: '/data/notes.txt', target: 'video' })).toBeNull();
  });

  it('the config never leaks undefined keys into the spec', () => {
    const [s] = buildWorkerFileSpecs({ ...base, path: '/data/a.slp', target: 'predicted' });
    expect(Object.values(s).includes(undefined)).toBe(false);
  });

  it('buildWorkerInferenceConfig maps the model type to the pipeline (top_down fallback)', () => {
    expect(buildWorkerInferenceConfig({}, { modelType: 'bottom_up_id', modelPaths: ['/m'], target: 'video' }).pipeline).toBe('bottom-up-id');
    expect(buildWorkerInferenceConfig({}, { modelType: 'weird', modelPaths: ['/m'], target: 'video' }).pipeline).toBe('top-down');
  });
});

describe('fileSourceBlocker', () => {
  it('says what is missing, in order', () => {
    expect(fileSourceBlocker({ path: null, modelDirs: [], target: 'video' })).toBe('Pick a file on the worker.');
    expect(fileSourceBlocker({ path: '/d/n.txt', modelDirs: ['/m'], target: 'video' })).toBe('Pick a .slp or a video file.');
    expect(fileSourceBlocker({ path: '/d/a.slp', modelDirs: [], target: 'suggestions' })).toBe('Add a model folder.');
    expect(fileSourceBlocker({ path: '/d/a.mp4', modelDirs: ['/m'], target: 'range', start: 9, end: 1 })).toBe('The last frame must be at least the first.');
    expect(fileSourceBlocker({ path: '/d/a.mp4', modelDirs: ['/m'], target: 'range', start: 1, end: 9 })).toBe('');
    expect(fileSourceBlocker({ path: '/d/a.slp', modelDirs: ['/m'], target: 'suggestions' })).toBe('');
    expect(fileSourceBlocker({ path: '/d/a.slp', modelDirs: ['/m'], target: 'suggestions', submitting: true })).toBe('Adding…');
  });
});

describe('groupCompletedRuns + seedWizardFromRun (the Models step)', () => {
  const j = (o) => ({ kind: 'train', state: 'completed', modelTypes: ['m'], createdAt: '2026-10-01T00:00:00Z', labelsPath: '/data/l.slp', ...o });
  it('a job without run is its own run; a run with a still-running sibling is left out', () => {
    const runs = groupCompletedRuns([
      j({ jobId: 'a' }),
      j({ jobId: 'b', run: { id: 'r', index: 0, count: 2 }, modelTypes: ['centroid'] }),
      j({ jobId: 'c', run: { id: 'r', index: 1, count: 2 }, modelTypes: ['centered_instance'], state: 'running' }),
    ]);
    expect(runs.map((r) => r.runId)).toEqual(['a']);
  });
  it('seeds the labels path and model type of a run (configs are not read: no training)', async () => {
    const detail = async (_w, id) => ({ labelsPath: '/data/l.slp', spec: { model_types: [id === 'x' ? 'centroid' : 'centered_instance'] } });
    const seed = await seedWizardFromRun(detail, 'w', ['x', 'y']);
    expect(seed).toEqual({ labelsPath: '/data/l.slp', modelType: 'top_down', configs: [] });
    expect(await seedWizardFromRun(async () => ({ spec: { model_types: ['centroid'] } }), 'w', ['x'])).toBeNull();
  });
});

await run();
