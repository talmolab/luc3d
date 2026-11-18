/**
 * pose/connect/remote-inference-plan.js — path resolution (desktop paths and the web's
 * session-root keys), the duplicate-target refusal, output paths, the per-view `track` spec
 * (identical to sleap-app's `buildRemoteTrackSpecs` for the same config, plus the LUCID fields),
 * and which tracked jobs still wait to be fetched.
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import { buildRemoteTrackSpecs } from '../pose/connect/remote-track-spec.js';
import {
  sessionRootOf, localCandidates, chooseLocalPath, resolveViewVideos, duplicateTargets, duplicateTargetsMessage,
  inferLocateRule, remoteOutputPath, buildViewSpec, planRemoteRun, pendingFetches, progressFromLine, lastProgress,
  describeViewStatus, safePart, lastErrorLine, MAX_FRAMES_SPEC_CHARS, framesTooLongMessage, unresolvedViews,
} from '../pose/connect/remote-inference-plan.js';
import { translatePath } from '../pose/connect/path-mappings.js';
import { defaultInferenceConfig, framesToSpec } from '../ui/inference-args.js';

const MOUNTS = ['/data'];
const stat = (files) => async (p) => ({ exists: files.has(p), shared: true });
const project = { name: 'rec.slp', id: 'abcd1234' };

describe('session root and local keys (web: no absolute paths)', () => {
  it('the root is the picked folder, else the session name', () => {
    expect(sessionRootOf([{ relPath: 'rec/cam1/0.mp4' }], 'S')).toBe('rec');
    expect(sessionRootOf([{ relPath: '' }, {}], 'Session 1')).toBe('Session 1');
    expect(sessionRootOf([], 'a/b')).toBe('a_b');
  });
  it('candidates: real path, absolute .slp path, relative key, then name', () => {
    expect(localCandidates({ view: 'c', absPath: '/Users/x/rec/cam1/0.mp4', relPath: 'rec/cam1/0.mp4', fileName: '0.mp4' }, 'rec'))
      .toEqual(['/Users/x/rec/cam1/0.mp4', 'rec/cam1/0.mp4', 'rec/0.mp4']);
    expect(localCandidates({ view: 'c', videoPath: 'cam1/0.mp4', fileName: '0.mp4' }, 'rec')).toEqual(['rec/cam1/0.mp4', 'rec/0.mp4']);
    expect(localCandidates({ view: 'c', videoPath: '/root/vast/x/cam1/0.mp4' }, 'rec')).toEqual(['/root/vast/x/cam1/0.mp4']);
  });
  it('prefers the spelling the worker can place', () => {
    const c = ['/Users/x/rec/cam1/0.mp4', 'rec/cam1/0.mp4'];
    expect(chooseLocalPath(c, { rules: [{ local: 'rec', worker: '/data/rec' }], mounts: MOUNTS })).toBe('rec/cam1/0.mp4');
    expect(chooseLocalPath(['/data/a/0.mp4', 'rec/x'], { rules: [], mounts: MOUNTS })).toBe('/data/a/0.mp4');
    expect(chooseLocalPath(c, { rules: [], mounts: MOUNTS })).toBe('/Users/x/rec/cam1/0.mp4');
    expect(chooseLocalPath([], { rules: [], mounts: MOUNTS })).toBeNull();
  });
});

describe('resolveViewVideos', () => {
  const descs = [
    { view: 'cam1', relPath: 'rec/cam1/0.mp4', fileName: '0.mp4' },
    { view: 'cam2', relPath: 'rec/cam2/0.mp4', fileName: '0.mp4' },
  ];
  const files = new Set(['/data/sess/cam1/0.mp4', '/data/sess/cam2/0.mp4']);

  it('without a rule nothing is located (a relative path the worker finds by luck does not count)', async () => {
    const lucky = async () => ({ exists: true, shared: true });
    const r = await resolveViewVideos(descs, { rules: [], mounts: MOUNTS, stat: lucky, sessionName: 'S' });
    expect(r.map((x) => x.visible)).toEqual([false, false]);
    expect(r[0].reason).toBe('no-location');
    expect(describeViewStatus(r[0])).toBe('not located on the worker yet');
  });
  it('one rule for the session root places every view', async () => {
    const r = await resolveViewVideos(descs, { rules: [{ local: 'rec', worker: '/data/sess' }], mounts: MOUNTS, stat: stat(files), sessionName: 'S' });
    expect(r.map((x) => x.worker)).toEqual(['/data/sess/cam1/0.mp4', '/data/sess/cam2/0.mp4']);
    expect(r.every((x) => x.visible)).toBe(true);
  });
  it('a rule whose file is missing says not found', async () => {
    const r = await resolveViewVideos(descs, { rules: [{ local: 'rec', worker: '/data/other' }], mounts: MOUNTS, stat: stat(files), sessionName: 'S' });
    expect(r[0].reason).toBe('not-found');
    expect(describeViewStatus(r[0])).toBe('not found on the worker');
  });
  it('desktop paths: a rule keyed on the real folder', async () => {
    const d = [{ view: 'cam1', absPath: '/Users/x/rec/cam1/0.mp4' }];
    const r = await resolveViewVideos(d, { rules: [{ local: '/Users/x/rec', worker: '/data/sess' }], mounts: MOUNTS, stat: stat(files), sessionName: 'S' });
    expect(r[0].worker).toBe('/data/sess/cam1/0.mp4');
  });
});

describe('inferLocateRule', () => {
  it('maps the whole session root when the worker file ends with the same relative path', () => {
    const rule = inferLocateRule('rec/cam1/0.mp4', '/data/sess/cam1/0.mp4', 'rec');
    expect(rule).toEqual({ local: 'rec', worker: '/data/sess' });
    expect(translatePath('rec/cam2/0.mp4', [rule])).toBe('/data/sess/cam2/0.mp4');
  });
  it('a worker folder named like the root works too', () => {
    expect(inferLocateRule('rec/cam1/0.mp4', '/data/rec/cam1/0.mp4', 'rec')).toEqual({ local: 'rec', worker: '/data/rec' });
  });
  it('a differently named file falls back to sleap-app\'s rule (exact file)', () => {
    expect(inferLocateRule('rec/cam1/0.mp4', '/data/x/other.mp4', 'rec')).toEqual({ local: 'rec/cam1/0.mp4', worker: '/data/x/other.mp4' });
  });
  it('desktop absolute paths: the common-suffix rule', () => {
    expect(inferLocateRule('/Users/x/rec/cam1/0.mp4', '/data/sess/rec/cam1/0.mp4', 'rec'))
      .toEqual({ local: '/Users/x', worker: '/data/sess' });
  });
});

describe('duplicate targets', () => {
  it('two views on one worker file are refused with both names and the way out', () => {
    const dups = duplicateTargets([
      { view: 'cam1', worker: '/data/0.mp4', visible: true },
      { view: 'cam2', worker: '/data/0.mp4', visible: true },
      { view: 'cam3', worker: '/data/3.mp4', visible: true },
      { view: 'cam4', worker: null, visible: false },
    ]);
    expect(dups).toEqual([{ worker: '/data/0.mp4', views: ['cam1', 'cam2'] }]);
    const msg = duplicateTargetsMessage(dups);
    expect(msg).toContain('cam1 and cam2 point at the same file on the worker (/data/0.mp4)');
    expect(msg).toContain('Locate on worker');
  });
  it('none when every view has its own', () => {
    expect(duplicateTargets([{ view: 'a', worker: '/x/a', visible: true }, { view: 'b', worker: '/x/b', visible: true }])).toEqual([]);
  });
});

describe('output paths', () => {
  const o = { dir: '/data/sess/', hasPredictionsDir: true, session: 'Session 1', view: 'cam/1', stamp: '261109_142530' };
  it('<dir>/predictions/<session>__<view>.<stamp>.predictions.slp', () => {
    expect(remoteOutputPath(o)).toBe('/data/sess/predictions/Session_1__cam_1.261109_142530.predictions.slp');
  });
  it('straight in the folder when there is no predictions folder', () => {
    expect(remoteOutputPath({ ...o, hasPredictionsDir: false })).toBe('/data/sess/Session_1__cam_1.261109_142530.predictions.slp');
  });
  it('safePart', () => { expect(safePart('..a b')).toBe('a_b'); expect(safePart('')).toBe('x'); });
});

describe('the track spec of a view', () => {
  const cfg = {
    ...defaultInferenceConfig(),
    modelPaths: ['/data/models/td'], tracking: true, trackerMethod: 'kalman', maxTracks: 3, filterOverlapping: true,
    kfNodeIndices: [0, 2], peakThreshold: 0.35, batchSize: 8, excludeUserLabeled: true,
  };
  const v = { view: 'cam1', workerPath: '/data/sess/cam1/0.mp4', framesSpec: '0-99', frameCount: 500 };
  const ctx = { outputPath: '/data/sess/predictions/S__cam1.t.predictions.slp', project };

  it('carries exactly the option fields of sleap-app\'s buildRemoteTrackSpecs for the same config', () => {
    const theirs = buildRemoteTrackSpecs(
      { ...cfg, frameRange: { start: 0, end: 99 }, videoIndex: 'all', ensureChannels: 'auto' },
      { dataPath: v.workerPath, pathMappings: {}, videoFrameCounts: [500], currentFrameIdx: 0, activeVideoFrameCount: 500 },
    )[0];
    const ours = buildViewSpec(cfg, v, ctx);
    const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k, x]) => x !== undefined
      && !['exclude_user_labeled', 'video_index', 'frame_filter', 'path_mappings'].includes(k)));
    expect(strip(ours)).toEqual({ ...strip(theirs), output_path: ctx.outputPath, project });
    expect(ours.type).toBe('track');
    expect(ours.data_path).toBe(v.workerPath);
    expect(ours.model_paths).toEqual(['/data/models/td']);
    expect(ours.frames).toBe('0-99');
    expect(ours.use_kalman).toBe(true);
    expect(ours.kf_node_indices).toBe('0,2');
    expect(ours.max_tracks).toBe(3);
    expect(ours.peak_threshold).toBe(0.35);
    expect(ours.batch_size).toBe(8);
  });
  it('drops the labels-only fields and any undefined key', () => {
    const s = buildViewSpec(cfg, v, ctx);
    expect('exclude_user_labeled' in s).toBe(false);
    expect('video_index' in s).toBe(false);
    expect('frame_filter' in s).toBe(false);
    expect('path_mappings' in s).toBe(false);
    expect(Object.values(s).includes(undefined)).toBe(false);
  });
  it('a whole-video target has no frames', () => {
    const s = buildViewSpec(cfg, { ...v, framesSpec: null }, ctx);
    expect('frames' in s).toBe(false);
  });
  it('tracking off leaves the tracker fields out', () => {
    const s = buildViewSpec({ ...cfg, tracking: false }, v, ctx);
    expect('tracker' in s).toBe(false);
    expect('use_kalman' in s).toBe(false);
  });
});

describe('planRemoteRun', () => {
  const base = {
    config: { ...defaultInferenceConfig(), modelPaths: [] },
    session: 'S', outputDir: '/data/sess', hasPredictionsDir: true, stamp: 'T', project, models: ['/data/models/m'],
    views: [
      { view: 'cam1', workerPath: '/data/sess/cam1/0.mp4', framesSpec: null, frameCount: 10 },
      { view: 'cam2', workerPath: '/data/sess/cam2/0.mp4', framesSpec: '1-3', frameCount: 10 },
      { view: 'cam3', workerPath: null, framesSpec: null, frameCount: 10 },
      { view: 'cam4', workerPath: '/data/x', framesSpec: null, frameCount: 10, skip: 'lazy-loaded — not supported yet' },
      { view: 'cam5', workerPath: '/data/y', framesSpec: '', frameCount: 10 },
    ],
  };
  it('one job per runnable view, in order, each with its own output path; skipped views have reasons', () => {
    const p = planRemoteRun(base);
    expect(p.error).toBeNull();
    expect(p.jobs.map((j) => j.view)).toEqual(['cam1', 'cam2']);
    expect(p.jobs.map((j) => j.outputPath)).toEqual([
      '/data/sess/predictions/S__cam1.T.predictions.slp', '/data/sess/predictions/S__cam2.T.predictions.slp',
    ]);
    expect(p.jobs[1].spec.frames).toBe('1-3');
    expect(p.jobs[0].spec.model_paths).toEqual(['/data/models/m']);
    expect(p.skipped.map((s) => s.view)).toEqual(['cam3', 'cam4', 'cam5']);
    expect(p.skipped[1].reason).toContain('lazy');
  });
  it('refuses two views on one worker file', () => {
    const p = planRemoteRun({ ...base, views: [
      { view: 'cam1', workerPath: '/data/0.mp4', framesSpec: null, frameCount: 1 },
      { view: 'cam2', workerPath: '/data/0.mp4', framesSpec: null, frameCount: 1 },
    ] });
    expect(p.jobs).toHaveLength(0);
    expect(p.error).toContain('cam1 and cam2 point at the same file');
  });
  it('refuses without models, without an output folder, and with nothing to run', () => {
    expect(planRemoteRun({ ...base, models: [] }).error).toContain('model');
    expect(planRemoteRun({ ...base, outputDir: null }).error).toContain('output folder');
    expect(planRemoteRun({ ...base, views: [base.views[2]] }).error).toContain('No view');
  });
});

describe('pending fetches', () => {
  const job = (o) => ({ kind: 'track', state: 'completed', camera: 'cam1', sessionId: 'S', projectTag: 'p', fetchedAt: null, workerId: 'w', jobId: 'j', ...o });
  it('completed, tagged, unfetched jobs of this project (and worker)', () => {
    const jobs = [
      job({ jobId: 'a' }), job({ jobId: 'b', fetchedAt: 5 }), job({ jobId: 'c', state: 'active' }),
      job({ jobId: 'd', projectTag: 'other' }), job({ jobId: 'e', camera: undefined }), job({ jobId: 'f', kind: 'train' }),
      job({ jobId: 'g', workerId: 'w2' }), job({ jobId: 'h', fetchedAt: undefined }),
    ];
    expect(pendingFetches(jobs, { projectTagId: 'p' }).map((j) => j.jobId)).toEqual(['a', 'g', 'h']);
    expect(pendingFetches(jobs, { projectTagId: 'p', workerId: 'w' }).map((j) => j.jobId)).toEqual(['a', 'h']);
  });
});

describe('progress lines', () => {
  it('reads sleap-nn --gui progress, newest first', () => {
    expect(progressFromLine('{"n_processed": 5, "n_total": 10, "rate": 2.5, "eta": 3}')).toEqual({ done: 5, total: 10, rate: 2.5, eta: 3 });
    expect(progressFromLine('hello')).toBeNull();
    expect(lastProgress(['{"n_processed":1,"n_total":4}', 'x', '{"n_processed":3,"n_total":4}', 'tail']).done).toBe(3);
    expect(lastProgress([])).toBeNull();
  });
});

describe('the reason a job failed', () => {
  it('is the newest exception line of its log (the worker says only "exit code 1")', () => {
    const log = ['Traceback (most recent call last):', '  File "x.py", line 1, in <module>', 'PermissionError: [Errno 13] Unable to create file (name = \'/data/ro/a.slp\')', ''];
    expect(lastErrorLine(log)).toBe("PermissionError: [Errno 13] Unable to create file (name = '/data/ro/a.slp')");
    expect(lastErrorLine(['torch.OutOfMemoryError: CUDA out of memory.', 'cleanup'])).toBe('torch.OutOfMemoryError: CUDA out of memory.');
    expect(lastErrorLine(['Predicting... 100%', 'Saved file'])).toBeNull();
    expect(lastErrorLine([])).toBeNull();
    expect(lastErrorLine(['ValueError: ' + 'x'.repeat(400)]).length).toBe(240);
  });
});

describe('frames size (sleap-nn --frames takes one range OR a plain list; the worker passes it as one argv entry)', () => {
  const base = {
    config: { ...defaultInferenceConfig(), modelPaths: [] },
    session: 'S', outputDir: '/data/sess', hasPredictionsDir: true, stamp: 'T', project, models: ['/data/models/m'],
  };
  const view = (framesSpec) => ({ view: 'cam1', workerPath: '/data/sess/cam1/0.mp4', framesSpec, frameCount: 108000 });
  const all = Array.from({ length: 108000 }, (_, i) => i);
  it('a contiguous run of 108,000 frames is the short range 0-107999', () => {
    const spec = framesToSpec(all);
    expect(spec).toBe('0-107999');
    expect(planRemoteRun({ ...base, views: [view(spec)] }).jobs[0].spec.frames).toBe('0-107999');
  });
  it('108,000 frames minus sparse user labels is a long list: refused with a message that suggests a range', () => {
    const labelled = new Set(all.filter((i) => i % 500 === 0));
    const spec = framesToSpec(all.filter((i) => !labelled.has(i)));
    expect(spec.length).toBeGreaterThan(MAX_FRAMES_SPEC_CHARS);
    const p = planRemoteRun({ ...base, views: [view(spec)] });
    expect(p.jobs).toHaveLength(0);
    expect(p.error).toContain('cam1');
    expect(p.error).toContain('100,000');
    expect(p.error).toContain('Custom range');
    expect(p.error).toContain('Exclude user-labeled');
    expect(p.error).toBe(framesTooLongMessage('cam1', spec.length));
  });
  it('a list at the limit still goes; one character over does not', () => {
    const at = '1,'.repeat(MAX_FRAMES_SPEC_CHARS / 2 - 1) + '12';
    expect(at.length).toBe(MAX_FRAMES_SPEC_CHARS);
    expect(planRemoteRun({ ...base, views: [view(at)] }).error).toBeNull();
    expect(planRemoteRun({ ...base, views: [view(at + '3')] }).error).toContain('too many');
  });
  it('only a view that would run counts (a skipped view\'s list is ignored)', () => {
    const big = '1,'.repeat(MAX_FRAMES_SPEC_CHARS);
    const p = planRemoteRun({ ...base, views: [view(null), { ...view(big), view: 'cam2', skip: 'not checked' }] });
    expect(p.error).toBeNull();
  });
});

describe('unresolvedViews', () => {
  const d = (view, o) => ({ view, checked: true, blocker: null, ...o });
  it('lists the checked, runnable views with no video on the worker', () => {
    const byView = { a: { visible: true }, b: { visible: false }, c: { visible: false } };
    expect(unresolvedViews([d('a'), d('b'), d('c', { checked: false }), d('e'), d('f', { blocker: 'lazy' })], byView)).toEqual(['b', 'e']);
    expect(unresolvedViews([d('a')], byView)).toEqual([]);
  });
});

describe('rich progress line fallback', () => {
  it('reads "NN% a/b" with rate and ETA when present', () => {
    expect(progressFromLine('Predicting... 42% 420/1000')).toEqual({ done: 420, total: 1000, rate: 0, eta: 0 });
    expect(progressFromLine('Predicting: 42%|████▏     | 420/1000 [00:10<00:14, 41.9it/s]')).toEqual({ done: 420, total: 1000, rate: 41.9, eta: 14 });
    expect(progressFromLine('50%|#####| 5/10 [00:05<1:01:01, 1.0it/s]').eta).toBe(3661);
  });
  it('ignores lines that are not progress', () => {
    expect(progressFromLine('Loading model 100% done')).toBeNull();
    expect(progressFromLine('INFO: 3 / 4 frames')).toBeNull();
    expect(progressFromLine('50% 11/10')).toBeNull();
  });
  it('lastProgress takes the newest of either form', () => {
    expect(lastProgress(['{"n_processed":1,"n_total":4}', '75% 3/4']).done).toBe(3);
  });
});

await run();
