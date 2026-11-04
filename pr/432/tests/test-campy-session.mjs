/**
 * test-campy-session.mjs — reading a campy recording's session.json
 * (`loading/campy-session.js`).
 *
 * campy writes <recording>/session.json (schema "campy-session/1") and
 * campy-live writes campy-live-session.json beside it. LUC3D takes the frame
 * rate, the camera order, each camera's video, the experiment's details and the
 * calibration's SHA-256 from them. The fixture `session.json` is a real one
 * (tests/fixtures/campy-recording/README.md).
 *
 * What is pinned here:
 *  1. Finding the manifests among a picked folder's files (the shallowest
 *     session.json; campy-live's beside it; none → null).
 *  2. The record: frame rate, status, experiment, annotations, cameras in
 *     campy's order. campy's "None" for an unset field is no value. Animal IDs
 *     are kept as strings (campy allows numbers).
 *  3. Anything that is not campy-session/1 is ignored (null), never an error.
 *  4. Camera order and each camera's video; Camera10 after Camera9.
 *  5. The calibration check against campy-live's SHA-256, and cameras in only
 *     one of session.json and the calibration.
 *  6. The status in plain words and the warnings a load's status bar gains.
 *
 * `loading/campy-session.js` has no imports so Node can load it
 * (`session-loader.js` cannot be: it reaches a CDN). ESM, so
 * `tests/run-mjs-tests.mjs` picks it up.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    findCampyManifestFiles, parseCampySession, parseCampyLiveSession, readCampyRecording,
    campyCameraFor, orderByCampyCameras, campyVideoFile, preferCampyVideo,
    compareCampyCameraNames, sha256Hex, compareCalibrationSha256, frameRatesDisagree,
    describeCampyStatus, campyRecordingWarnings, withCampyWarnings, campyUnset, parseCampyJson,
} from '../loading/campy-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'campy-recording');
const sessionText = readFileSync(path.join(FIX, 'session.json'), 'utf8');
const liveText = readFileSync(path.join(FIX, 'campy-live-session.json'), 'utf8');
const calibBytes = readFileSync(path.join(FIX, 'calibration.toml'));

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

// A picked file: a name, the relative path a folder pick gives, its text.
const file = (rel, text) => ({
    name: rel.split('/').pop(), webkitRelativePath: rel,
    text: async () => (text === undefined ? '' : text),
});
const edited = (fn) => { const d = JSON.parse(sessionText); fn(d); return JSON.stringify(d); };

console.log('\n1. Finding the manifests');
{
    const files = [
        file('rec/Camera0/emuclip.mp4'), file('rec/Camera1/emuclip.mp4'),
        file('rec/Camera0/session.json'),            // deeper: not the recording's
        file('rec/session.json', sessionText),
        file('rec/campy-live-session_2.json', liveText),
        file('rec/campy-live-session.json', liveText),
        file('rec/Camera0/campy-live-session.json'), // not beside session.json
        file('rec/trigger.json'),
    ];
    const f = findCampyManifestFiles(files);
    check(f && f.session.webkitRelativePath === 'rec/session.json', 'the shallowest session.json is the recording\'s');
    check(f.root === 'rec', `the recording folder is the one it sits in (got '${f.root}')`);
    check(f.live.map(x => x.webkitRelativePath).join(',') === 'rec/campy-live-session.json,rec/campy-live-session_2.json',
        'campy-live\'s manifests beside it, sorted; the one in a camera folder is not one');
    check(findCampyManifestFiles([file('rec/Camera0/0.mp4'), file('rec/calibration.toml')]) === null,
        'a folder without session.json gives null');
    check(findCampyManifestFiles([]) === null && findCampyManifestFiles(null) === null, 'and so do no files');
    const parentPick = findCampyManifestFiles([file('parent/rec/session.json'), file('parent/rec/Camera0/0.mp4')]);
    check(parentPick && parentPick.root === 'parent/rec', 'a parent-folder pick keeps the session\'s own folder as root');
}

console.log('\n2. The record, from a real session.json');
{
    const r = parseCampySession(sessionText);
    check(r && r.schema === 'campy-session/1', 'read');
    check(r.frameRate === 20, `frame rate from config.effective.frameRate (got ${r.frameRate})`);
    check(r.status === 'complete', 'status');
    check(r.startedAt === '2026-10-23T04:07:04-04:00', 'start time');
    check(r.campyVersion === '2.1.1rc1', 'campy version');
    check(r.experiment.name === 'social', 'experiment name');
    check(JSON.stringify(r.experiment.animalIds) === '["M1","M2"]', 'animal IDs');
    check(r.experiment.notes === 'new bedding', 'notes');
    check(JSON.stringify(r.experiment.fields) === '[["cage","B3"]]', 'other fields, as [key, value]');
    check(r.annotations.length === 1 && r.annotations[0].text === 'M2 sleeping'
        && r.annotations[0].at === '2026-10-23T04:07:08-04:00', 'the note added afterwards, with its time');
    check(r.cameras.map(c => c.name + ':' + c.serial + ':' + c.video).join(',')
        === 'Camera0:emu0:Camera0/emuclip.mp4,Camera1:emu1:Camera1/emuclip.mp4', 'cameras: name, serial, video');
    check(r.live.length === 0 && r.calibrationCheck === null, 'nothing about campy-live until the loader adds it');

    // What campy writes for a run with no experiment details.
    const bare = parseCampySession(edited(d => {
        d.experiment = { name: 'None', animalIds: [], notes: 'None', fields: {} };
        d.cameras[0].serial = null;
    }));
    check(bare.experiment.name === null && bare.experiment.notes === null, 'campy\'s "None" is no value');
    check(bare.experiment.animalIds.length === 0 && bare.experiment.fields.length === 0, 'no IDs, no fields');
    check(bare.cameras[0].serial === null, 'a camera without a serial');
    check(campyUnset('None') && campyUnset('') && campyUnset(null) && !campyUnset(0) && !campyUnset('M1'),
        'campyUnset');
    const numeric = parseCampySession(edited(d => { d.experiment.animalIds = ['M1', 1234]; }));
    check(JSON.stringify(numeric.experiment.animalIds) === '["M1","1234"]', 'a numeric animal ID becomes a string');
    const noRate = parseCampySession(edited(d => { delete d.config.effective.frameRate; }));
    check(noRate.frameRate === null, 'no frame rate in the file → null (the video estimate stays)');
    const zeroRate = parseCampySession(edited(d => { d.config.effective.frameRate.value = 0; }));
    check(zeroRate.frameRate === null, 'a zero frame rate is no frame rate');
}

console.log('\n3. Not campy-session/1 → null');
{
    check(parseCampySession('not json') === null, 'garbage');
    check(parseCampySession('{"schema":"campy-session/2"}') === null, 'a later schema');
    check(parseCampySession('{"status":"complete"}') === null, 'no schema (some other session.json)');
    check(parseCampySession('[]') === null, 'an array');
    check(parseCampyLiveSession(sessionText) === null, 'session.json is not a campy-live manifest');
    const live = parseCampyLiveSession(liveText, 'campy-live-session.json');
    check(live && live.calibration && live.calibration.sha256.length === 64, 'campy-live\'s calibration SHA-256');
    check(live.calibration.cameraNames.join(',') === 'Camera0,Camera1', 'and its camera names');
    const twoD = parseCampyLiveSession(JSON.stringify({ schema: 'campy-live-session/1', calibration: null }));
    check(twoD && twoD.calibration === null, 'a 2D-only campy-live run has no calibration');

    // Python's json module writes inf / nan as bare Infinity / NaN, which
    // strict JSON.parse rejects. Real campy-live manifests have one: the
    // `--wait-sec` option's default is inf. The fixture carries it too.
    check(/"value": Infinity/.test(liveText), 'the fixture has campy-live\'s Infinity, like a real one');
    check(live !== null, 'and still parses');
    const py = parseCampyJson('{"a": Infinity, "b": -Infinity, "c": NaN, "d": [1, NaN], '
        + '"s": "Infinity and NaN stay", "e": "a \\"quoted\\" NaN", "f": 1.5}');
    check(py && py.a === null && py.b === null && py.c === null && py.d[1] === null,
        'Infinity, -Infinity and NaN read as null');
    check(py.s === 'Infinity and NaN stay' && py.e === 'a "quoted" NaN' && py.f === 1.5,
        'inside strings they are left alone (escaped quotes too)');
    check(parseCampyJson('{"a": Infinit}') === null && parseCampyJson('nonsense') === null,
        'anything else that is not JSON is still null');
    check(JSON.stringify(parseCampyJson('{"x": [1, 2]}')) === '{"x":[1,2]}', 'plain JSON unchanged');
}

console.log('\n4. Camera order and each camera\'s video');
{
    const r = parseCampySession(edited(d => {
        d.cameras = [9, 10, 2].map(i => ({ index: i, name: 'Camera' + i, folder: 'Camera' + i, video: 'Camera' + i + '/0.mp4' }));
    }));
    check(r.cameras.map(c => c.name).join(',') === 'Camera2,Camera9,Camera10', 'cameras sorted by campy\'s index');
    const dirs = ['Camera10', 'Camera9', 'other', 'Camera2', 'more'].map(n => ({ camName: n, dirName: n }));
    const ordered = orderByCampyCameras(r, dirs, d => ({ name: d.camName, dirName: d.dirName }));
    check(ordered.map(d => d.camName).join(',') === 'Camera2,Camera9,Camera10,other,more',
        'campy order, Camera10 after Camera9; the others after, in their own order');
    check(dirs[0].camName === 'Camera10', 'the input is not reordered in place');
    check(orderByCampyCameras(null, dirs, d => d).map(d => d.camName).join(',') === dirs.map(d => d.camName).join(','),
        'no record → unchanged');

    check(campyCameraFor(r, 'camera9').name === 'Camera9', 'a camera is found by name, ignoring case');
    const byFolder = parseCampySession(edited(d => { d.cameras[0].folder = 'top'; }));
    check(campyCameraFor(byFolder, 'x', 'top').name === 'Camera0', 'or by campy\'s folder');

    r.root = 'rec';
    const vids = [file('rec/Camera9/1.mp4'), file('rec/Camera9/0.mp4'), file('rec/Camera9/old/0.mp4')];
    const cam9 = campyCameraFor(r, 'Camera9');
    check(campyVideoFile(r, cam9, vids) === vids[1], 'campy\'s video is matched by its whole path');
    check(preferCampyVideo(r, cam9, vids)[0] === vids[1] && preferCampyVideo(r, cam9, vids).length === 3,
        'and goes first among the camera\'s videos, the others kept');
    check(preferCampyVideo(r, campyCameraFor(r, 'Camera2'), vids) === vids, 'unchanged when it is not there');
    const winRec = parseCampySession(edited(d => { d.cameras[0].video = 'Camera0\\0.mp4'; }));
    winRec.root = 'rec';
    check(campyVideoFile(winRec, winRec.cameras[0], [file('rec/Camera0/0.mp4')]) !== null,
        'a Windows-style video path still matches');
}

console.log('\n5. The calibration and the cameras');
{
    const files = [file('rec/session.json', sessionText), file('rec/campy-live-session.json', liveText)];
    const r = await readCampyRecording(files);
    check(r && r.live.length === 1 && r.root === 'rec', 'readCampyRecording reads both manifests');
    const sha = await sha256Hex(calibBytes);
    check(sha === parseCampyJson(liveText).calibration.sha256, 'sha256Hex of the fixture calibration is the recorded one');
    const same = compareCalibrationSha256(r, sha, 'calibration.toml');
    check(same && same.matches === true, 'the same calibration matches');
    const changed = Buffer.from(calibBytes); changed[changed.length - 2] ^= 1;
    const other = compareCalibrationSha256(r, await sha256Hex(changed), 'calibration.toml');
    check(other && other.matches === false && other.live[0].path === '/data/campy-test/calibration.toml',
        'one changed byte does not, and says which calibration campy-live used');
    check(compareCalibrationSha256(r, sha.toUpperCase(), 'c').matches, 'hex case does not matter');

    const two = await readCampyRecording([...files, file('rec/campy-live-session_2.json',
        JSON.stringify({ schema: 'campy-live-session/1', calibration: { path: 'b.toml', sha256: 'ab'.repeat(32) } }))]);
    check(compareCalibrationSha256(two, 'ab'.repeat(32), 'b.toml').matches,
        'with two campy-live runs, matching either one is a match');

    const noLive = await readCampyRecording([file('rec/session.json', sessionText)]);
    check(compareCalibrationSha256(noLive, sha, 'c') === null, 'no campy-live manifest → nothing to compare');
    const twoD = await readCampyRecording([file('rec/session.json', sessionText),
        file('rec/campy-live-session.json', JSON.stringify({ schema: 'campy-live-session/1', calibration: null }))]);
    check(compareCalibrationSha256(twoD, sha, 'c') === null, 'a 2D-only campy-live run → nothing to compare');
    check(await readCampyRecording([file('rec/session.json', 'garbage')]) === null, 'an unreadable session.json → null');

    check(compareCampyCameraNames(r, ['Camera0', 'camera1']) === null, 'the same cameras (any case) → null');
    const cm = compareCampyCameraNames(r, ['Camera0', 'Camera2']);
    check(cm && cm.onlyInRecording.join() === 'Camera1' && cm.onlyInCalibration.join() === 'Camera2',
        'cameras in only one of the two are named');
    check(compareCampyCameraNames(r, []) === null, 'no calibration → nothing to compare');
}

console.log('\n6. The status, and the status bar');
{
    const rec = (fn) => parseCampySession(edited(fn));
    check(describeCampyStatus(rec(() => {})).ok, 'complete is fine');
    const killed = describeCampyStatus(rec(d => { d.status = 'recording'; }));
    check(!killed.ok && killed.label === 'Did not finish' && /lost power/.test(killed.detail),
        `still "recording": campy never reached its end (${killed.detail})`);
    check(describeCampyStatus(rec(d => { d.status = 'interrupted'; })).label === 'Interrupted', 'interrupted');
    const failed2 = describeCampyStatus(rec(d => { d.status = 'failed'; d.end.failures = { Camera1: 'no frames after 3 s' }; }));
    check(!failed2.ok && failed2.detail.indexOf('Camera1 (no frames after 3 s)') >= 0, 'failed names the cameras and why');
    const errored = describeCampyStatus(rec(d => { d.status = 'failed'; d.end.error = 'disk full'; }));
    check(/error: disk full/.test(errored.detail), 'or the error');
    check(!describeCampyStatus(rec(d => { delete d.status; })).ok, 'no status is not fine either');

    const ok = rec(() => {});
    check(campyRecordingWarnings(ok).length === 0, 'a complete recording adds nothing to the status bar');
    const w = withCampyWarnings('Loaded 2 camera(s)', 'success', ok);
    check(w.message === 'Loaded 2 camera(s)' && w.kind === 'success', 'unchanged');
    check(withCampyWarnings('m', 'success', null).message === 'm', 'and so does no record');

    const bad = rec(d => { d.status = 'interrupted'; });
    bad.calibrationCheck = { matches: false, fileName: 'calibration.toml', sha256: 'a'.repeat(64),
        live: [{ file: 'campy-live-session.json', path: 'C:\\campy_data\\cal\\calibration.toml', sha256: 'b'.repeat(64) }] };
    bad.cameraMismatch = { onlyInRecording: ['Camera1'], onlyInCalibration: [] };
    const bw = withCampyWarnings('Loaded 2 camera(s)', 'success', bad);
    check(bw.kind === 'warning', 'warnings turn success into a warning');
    check(bw.message.indexOf('recording status: interrupted') >= 0, 'the status');
    check(bw.message.indexOf('aaaaaaaaaaaa…') >= 0 && bw.message.indexOf('calibration.toml, bbbbbbbbbbbb…') >= 0
        && /different calibration/.test(bw.message), `the calibration, with both hashes (${bw.message})`);
    check(bw.message.indexOf('not in the calibration: Camera1') >= 0, 'the cameras');
    check(withCampyWarnings('x', 'error', bad).kind === 'error', 'an error stays an error');
    check(withCampyWarnings('x', 'success', bad, { status: false }).message.indexOf('status') < 0,
        'status: false leaves the status out (File → Load Calibration)');
    check(!frameRatesDisagree(60, 59.7) && frameRatesDisagree(60, 59) && frameRatesDisagree(60, 30)
        && !frameRatesDisagree(60, 0), 'frame rates disagree beyond 1%');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
