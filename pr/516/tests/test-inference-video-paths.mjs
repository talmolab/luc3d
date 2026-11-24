/**
 * test-inference-video-paths.mjs — ui/inference-video-paths.js: matching each
 * camera view's browser File to a video on disk under the picked folder.
 */
import assert from 'node:assert/strict';
import { matchViewVideos, isVideoName } from '../ui/inference-video-paths.js';

assert.ok(isVideoName('a.MP4') && !isVideoName('a.slp'));

// campy layout: every camera's video is 0.mp4, told apart by folder.
const listing = [
    { rel: 'cam1/0.mp4', size: 100 },
    { rel: 'cam2/0.mp4', size: 200 },
    { rel: 'side.mp4', size: 300 },
    { rel: 'dup/top.mp4', size: 5 },
    { rel: 'dup2/top.mp4', size: 5 },
];
const m = matchViewVideos([
    { view: 'cam1', fileName: '0.mp4', fileSize: 100, relPath: 'rec_2026/cam1/0.mp4' },
    { view: 'cam2', fileName: '0.mp4', fileSize: 200, relPath: 'rec_2026/cam2/0.mp4' },
    { view: 'side', fileName: 'side.mp4', fileSize: 300 },
    { view: 'top', fileName: 'top.mp4', fileSize: 5 },
    { view: 'wrongsize', fileName: 'side.mp4', fileSize: 1 },
    { view: 'fromslp', fileName: '', fileSize: null, videoPath: '/old/machine/cam2/0.mp4' },
    { view: 'missing', fileName: 'nope.mp4', fileSize: 1 },
], listing);
assert.deepEqual(m.cam1, { rel: 'cam1/0.mp4' });
assert.deepEqual(m.cam2, { rel: 'cam2/0.mp4' });
assert.deepEqual(m.side, { rel: 'side.mp4' });
assert.match(m.top.error, /several/);
assert.match(m.wrongsize.error, /different size/);
// cam2/0.mp4 already went to cam2: a second view never gets the same file.
assert.ok(m.fromslp.error);
assert.match(m.missing.error, /no video named nope.mp4/);

// The picked folder is a PARENT of the recording: the relative path matches as a suffix.
const m2 = matchViewVideos([{ view: 'a', fileName: '0.mp4', fileSize: 1, relPath: 'rec/a/0.mp4' }],
    [{ rel: 'rec/a/0.mp4', size: 1 }, { rel: 'rec/b/0.mp4', size: 1 }]);
assert.deepEqual(m2.a, { rel: 'rec/a/0.mp4' });
// Windows-style separators in the recorded .slp path.
const m3 = matchViewVideos([{ view: 'b', fileName: '', fileSize: null, videoPath: 'D:\\data\\b\\0.mp4' }],
    [{ rel: 'a/0.mp4', size: 1 }, { rel: 'b/0.mp4', size: 1 }]);
assert.deepEqual(m3.b, { rel: 'b/0.mp4' });
console.log('test-inference-video-paths: all passed');
