/**
 * pose/connect/open-predictions-plan.js — Connect's "Open as new project" (luc3d #450): which jobs of a run
 * open, how a multi-camera run's results are named (cameras, session), and the combined `slpData` handed to
 * `handleLoadSlpFile` (videos, frames, tracks, skeleton order, the synthetic recording session).
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  runJobsToOpen, nameCameras, combinePredictions, parseLucidOutputName, DEFAULT_SESSION_NAME,
} from '../pose/connect/open-predictions-plan.js';

const job = (jobId, state, index, o = {}) => ({ jobId, kind: 'track', state, run: { id: 'R', index, count: 3 }, createdAt: '2026-11-01T00:00:0' + index + 'Z', ...o });

describe('which jobs of the run open', () => {
  it('every completed track job of the clicked job\'s run, in run order; the rest are left out with why', () => {
    const jobs = [job('c', 'failed', 2), job('a', 'completed', 0), job('b', 'running', 1), job('x', 'completed', 0, { run: { id: 'OTHER', index: 0 } }),
      { jobId: 't', kind: 'train', state: 'completed', run: { id: 'R', index: 0 } }, job('d', 'completed', 3)];
    const r = runJobsToOpen(jobs, 'a');
    expect(r.open.map((j) => j.jobId)).toEqual(['a', 'd']);
    expect(r.leftOut.map((l) => l.job.jobId + ':' + l.reason)).toEqual(['b:still running', 'c:failed']);
  });
  it('a job with no run is a run of one', () => {
    const r = runJobsToOpen([{ jobId: 'solo', kind: 'track', state: 'completed' }, job('a', 'completed', 0)], 'solo');
    expect(r.open.map((j) => j.jobId)).toEqual(['solo']);
    expect(r.leftOut).toEqual([]);
  });
  it('queued and canceled jobs are named so', () => {
    const r = runJobsToOpen([job('a', 'completed', 0), job('q', 'queued', 1), job('k', 'canceled', 2)], 'a');
    expect(r.leftOut.map((l) => l.reason)).toEqual(['still queued', 'canceled']);
  });
});

describe('LUCID output names', () => {
  it('session and view from <session>__<view>.<stamp>.predictions.slp', () => {
    expect(parseLucidOutputName('/data/out/predictions/rec1__cam_top.261117_101500.predictions.slp')).toEqual({ session: 'rec1', view: 'cam_top' });
    expect(parseLucidOutputName('C:\\out\\Session_1__cam2.261117_101500.predictions.slp')).toEqual({ session: 'Session_1', view: 'cam2' });
    expect(parseLucidOutputName('/data/out/whatever.predictions.slp')).toBe(null);
    expect(parseLucidOutputName(undefined)).toBe(null);
  });
});

describe('camera and session names', () => {
  it('this device\'s tracked view and session win', () => {
    const r = nameCameras([
      { jobId: '1', camera: 'top', sessionId: 'rec A', outputPath: '/o/x__y.261117_101500.predictions.slp', videos: ['/w/rec/0.mp4'] },
      { jobId: '2', camera: 'side', sessionId: 'rec A', videos: ['/w/rec/1.mp4'] },
    ]);
    expect(r.cameras.map((c) => c.name)).toEqual(['top', 'side']);
    expect(r.sessionName).toBe('rec A');
  });
  it('another device\'s LUCID job: the view and session in its output name', () => {
    const r = nameCameras([
      { jobId: '1', outputPath: '/o/predictions/rec1__cam1.261117_101500.predictions.slp', videos: ['/w/rec1/cam1/0.mp4'] },
      { jobId: '2', outputPath: '/o/predictions/rec1__cam2.261117_101500.predictions.slp', videos: ['/w/rec1/cam2/0.mp4'] },
    ]);
    expect(r.cameras.map((c) => c.name)).toEqual(['cam1', 'cam2']);
    expect(r.sessionName).toBe('rec1');
  });
  it('no tag: the video stem, and the folder above it for the session', () => {
    const r = nameCameras([{ jobId: '1', videos: ['/w/sess/cam1.mp4'] }, { jobId: '2', videos: ['/w/sess/cam2.mp4'] }]);
    expect(r.cameras.map((c) => c.name)).toEqual(['cam1', 'cam2']);
    expect(r.sessionName).toBe('sess');
  });
  it('campy\'s 0.mp4 in every camera folder: the folder names the camera, its parent the session', () => {
    const r = nameCameras([{ jobId: '1', videos: ['/w/rec/cam1/0.mp4'] }, { jobId: '2', videos: ['/w/rec/cam2/0.mp4'] }]);
    expect(r.cameras.map((c) => c.name)).toEqual(['cam1', 'cam2']);
    expect(r.sessionName).toBe('rec');
  });
  it('a stem equal to another camera\'s tracked name takes its folder', () => {
    const r = nameCameras([{ jobId: '1', camera: 'top', videos: ['/w/a/x.mp4'] }, { jobId: '2', videos: ['/w/side/top.mp4'] }]);
    expect(r.cameras.map((c) => c.name)).toEqual(['top', 'side']);
  });
  it('still the same name: a suffix, first one keeps it', () => {
    const r = nameCameras([{ jobId: '1', videos: ['/w/a/0.mp4'] }, { jobId: '2', videos: ['/x/a/0.mp4'] }, { jobId: '3', videos: ['/y/b/v.mp4'] }]);
    expect(r.cameras.map((c) => c.name)).toEqual(['a', 'a_2', 'v']);
  });
  it('the job\'s data path when the result names no video; cam_<n> with nothing at all', () => {
    const r = nameCameras([{ jobId: '1', dataPath: '/w/s/left.mp4', videos: [] }, { jobId: '2', videos: [null] }]);
    expect(r.cameras.map((c) => c.name)).toEqual(['left', 'cam_1']);
    expect(r.sessionName).toBe(DEFAULT_SESSION_NAME);
  });
  it('sessions that disagree fall through to the folder, then "Session 1"', () => {
    expect(nameCameras([{ jobId: '1', sessionId: 'A', videos: ['/w/s/c1.mp4'] }, { jobId: '2', sessionId: 'B', videos: ['/w/s/c2.mp4'] }]).sessionName).toBe('s');
    expect(nameCameras([{ jobId: '1', videos: ['/w/s/c1.mp4'] }, { jobId: '2', videos: ['/w/t/c2.mp4'] }]).sessionName).toBe(DEFAULT_SESSION_NAME);
  });
  it('a multi-video result (one sleap-app job on a project): one camera per video, the job\'s tag ignored', () => {
    const r = nameCameras([{ jobId: '1', camera: 'top', videos: ['/w/s/c1.mp4', '/w/s/c2.mp4'] }]);
    expect(r.cameras.map((c) => [c.name, c.part, c.video])).toEqual([['c1', 0, 0], ['c2', 0, 1]]);
  });
});

const pred = (points, trackIdx, score = 0.9) => ({ type: 'predicted', trackIdx, score, points, occluded: points.map(() => false), pointScores: Float64Array.from(points.map((_, i) => i / 10)) });
const slp = (o) => ({
  skeleton: o.skeleton || { name: 'sk', nodes: ['A', 'B'], edges: [[0, 1]] },
  tracks: o.tracks || [],
  frames: o.frames || [],
  videos: (o.videos || []).map((f, i) => ({ index: i, filename: f, sourceFilename: null, backendType: 'MediaVideo', shape: null, embedded: false, dataset: null })),
  sessions: [], identities: [], provenance: null,
});

describe('combining a run into one session', () => {
  const a = { jobId: 'ja', camera: 'cam1', sessionId: 'rec', slpData: slp({ videos: ['/w/rec/cam1.mp4'], tracks: ['track_0'],
    frames: [{ frameIdx: 0, videoIdx: 0, instances: [pred([[1, 2], [3, 4]], 0)] }, { frameIdx: 5, videoIdx: 0, instances: [pred([[5, 6], null], -1)] }] }) };
  const b = { jobId: 'jb', camera: 'cam2', sessionId: 'rec', slpData: slp({ skeleton: { name: 'sk', nodes: ['B', 'A'], edges: [[0, 1]] }, videos: ['/w/rec/cam2.mp4'], tracks: ['track_0', 'track_1'],
    frames: [{ frameIdx: 0, videoIdx: 0, instances: [pred([[30, 40], [10, 20]], 1)] }] }) };

  it('one camera per job, videos in order, frames re-pointed, the session named', () => {
    const r = combinePredictions([a, b]);
    expect(r.sessionName).toBe('rec');
    expect(r.cameras.map((c) => [c.name, c.jobId, c.frames, c.instances])).toEqual([['cam1', 'ja', 2, 2], ['cam2', 'jb', 1, 1]]);
    expect(r.slpData.videos.map((v) => [v.index, v.filename])).toEqual([[0, '/w/rec/cam1.mp4'], [1, '/w/rec/cam2.mp4']]);
    expect(r.slpData.frames.map((f) => [f.frameIdx, f.videoIdx])).toEqual([[0, 0], [5, 0], [0, 1]]);
  });
  it('a recording session the loader reads: cameras by name, no matrices, the video map, the session name', () => {
    const s = combinePredictions([a, b]).slpData.sessions;
    expect(s.length).toBe(1);
    expect(s[0].calibration).toEqual({ cam1: { name: 'cam1' }, cam2: { name: 'cam2' } });
    expect(s[0].camcorder_to_video_idx_map).toEqual({ cam1: 0, cam2: 1 });
    expect(s[0].metadata).toEqual({ lucid: { sessionName: 'rec' } });
    expect(s[0].frame_group_dicts).toBe(undefined);
  });
  it('tracks are per camera ("<camera>: <track>"), only those used; trackless stays -1', () => {
    const d = combinePredictions([a, b]).slpData;
    expect(d.tracks).toEqual(['cam1: track_0', 'cam2: track_1']);
    expect(d.frames.map((f) => f.instances[0].trackIdx)).toEqual([0, -1, 1]);
  });
  it('a camera whose skeleton lists the nodes in another order is re-ordered to the first one\'s', () => {
    const d = combinePredictions([a, b]).slpData;
    expect(d.skeleton.nodes).toEqual(['A', 'B']);
    const i = d.frames[2].instances[0];
    expect(i.points).toEqual([[10, 20], [30, 40]]);
    expect(Array.from(i.pointScores)).toEqual([0.1, 0]);
    // the source is not modified
    expect(b.slpData.frames[0].instances[0].points).toEqual([[30, 40], [10, 20]]);
  });
  it('different node names: refused, naming both cameras', () => {
    const c = { jobId: 'jc', camera: 'cam3', slpData: slp({ skeleton: { nodes: ['A', 'C'] }, videos: ['/w/rec/cam3.mp4'] }) };
    expect(() => combinePredictions([a, c])).toThrow(/skeletons differ: cam3 has A, C, cam1 has A, B/);
  });
  it('a camera with no detections still gets its camera', () => {
    const e = { jobId: 'je', camera: 'cam9', sessionId: 'rec', slpData: slp({ skeleton: { nodes: [] }, videos: ['/w/rec/cam9.mp4'] }) };
    const r = combinePredictions([a, e]);
    expect(r.cameras.map((c) => [c.name, c.frames])).toEqual([['cam1', 2], ['cam9', 0]]);
  });
  it('several results with embedded frames are refused; nothing at all is refused', () => {
    const emb = { jobId: 'x', slpData: Object.assign(slp({ videos: ['/w/e.slp'] })) };
    emb.slpData.videos[0].embedded = true;
    expect(() => combinePredictions([a, emb])).toThrow(/embed/);
    expect(() => combinePredictions([])).toThrow(/No predictions/);
    expect(combinePredictions([emb]).cameras.length).toBe(1);
  });
  it('a multi-video result: each video its own camera, frames by their video', () => {
    const m = { jobId: 'jm', slpData: slp({ videos: ['/w/s/left.mp4', '/w/s/right.mp4'], tracks: ['t'],
      frames: [{ frameIdx: 3, videoIdx: 1, instances: [pred([[1, 1], [2, 2]], 0)] }, { frameIdx: 3, videoIdx: 0, instances: [pred([[1, 1], [2, 2]], 0)] }] }) };
    const r = combinePredictions([m]);
    expect(r.cameras.map((c) => [c.name, c.frames])).toEqual([['left', 1], ['right', 1]]);
    expect(r.sessionName).toBe('s');
    expect(r.slpData.tracks).toEqual(['right: t', 'left: t']);
    expect(r.slpData.frames.map((f) => f.videoIdx)).toEqual([1, 0]);
  });
});

await run();
