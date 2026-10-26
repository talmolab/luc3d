/**
 * test-slp-provenance.mjs — a loaded .slp's provenance survives LUC3D's save.
 *
 * Every save used to write a fresh `{ source: 'lucid', exported_at }`, so saving
 * campy-live-export's campy-live.slp dropped what campy kept there: the
 * recording's session.json, its campy-live-session.json, `animalIds` and
 * `calibrationDiffers`. `import-export/slp-provenance.js` is the rule; this pins
 * it. The real load → save → reopen is `tests/e2e/slp-provenance-roundtrip.mjs`.
 */
import {
    buildSaveProvenance, foreignProvenance, fileSessionProvenance, fileSessionNames,
    provenanceSessionKeys, LUCID_PROVENANCE_KEY, PROVENANCE_SESSIONS_KEY,
} from '../import-export/slp-provenance.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AT = '2026-10-23T12:00:00.000Z';

// campy-live-export's provenance (campy/liveexport.py Provenance()), in its key order.
const CAMPY = {
    'campy-live-export': 'D:/rec/campy-live.log',
    session: { schema: 'campy-session/1', experiment: { name: 'None', animalIds: ['m1', 'm2'] },
               cameras: [{ index: 0, name: 'Cam1', video: 'Cam1/0.mp4' }] },
    'campy-live-session': { schema: 'campy-live-session/1', calibration: { path: 'cal.toml', sha256: 'ab12' } },
    animalIds: ['m1', 'm2'],
    calibrationDiffers: { given: 'cd34', campyLive: 'ab12' },
};
const OTHER = { 'campy-live-export': 'E:/rec2/campy-live.log', animalIds: ['m7'] };
const sess = (name, fileProvenance) => ({ name, fileProvenance });

console.log('\n-- a project with no provenance writes what LUC3D always wrote --');
{
    const out = buildSaveProvenance([sess('S1', null)], AT);
    check(eq(out, { source: 'lucid', exported_at: AT }), 'exactly { source, exported_at }, same key order');
    check(eq(buildSaveProvenance([], AT), { source: 'lucid', exported_at: AT }), 'no sessions: same');
    check(eq(buildSaveProvenance([sess('S1', {}), sess('S2', null)], AT), { source: 'lucid', exported_at: AT }),
        'empty dicts count as none');
    check(typeof buildSaveProvenance([sess('S1', null)]).exported_at === 'string', 'exported_at defaults to now');
}

console.log('\n-- campy-live.slp: every campy key kept, LUC3D adds its pair --');
{
    const loaded = fileSessionProvenance(CAMPY, [], 0);
    check(eq(loaded, CAMPY), 'the loaded session keeps the whole dict');
    check(loaded !== CAMPY && loaded.session !== CAMPY.session, 'as a copy, not the file\'s objects');
    const out = buildSaveProvenance([sess('rec', loaded)], AT);
    check(eq(out, Object.assign({}, CAMPY, { source: 'lucid', exported_at: AT })),
        'saved: campy\'s five keys unchanged, then source + exported_at');
    check(!(PROVENANCE_SESSIONS_KEY in out) && !(LUCID_PROVENANCE_KEY in out), 'no nesting for one provenance');

    // Reopen the saved file and save again: still the same, only exported_at moves.
    const again = buildSaveProvenance([sess('rec', fileSessionProvenance(out, ['rec'], 0))], '2026-10-24T00:00:00.000Z');
    check(eq(again, Object.assign({}, CAMPY, { source: 'lucid', exported_at: '2026-10-24T00:00:00.000Z' })),
        'save → reopen → save: same keys, exported_at refreshed, nothing doubled');
}

console.log('\n-- LUC3D never overwrites another program\'s source / exported_at --');
{
    const foreign = { source: '/data/train', exported_at: '2020-01-01', filename: 'x.slp' };
    const out = buildSaveProvenance([sess('S', fileSessionProvenance(foreign, [], 0))], AT);
    check(out.source === '/data/train' && out.exported_at === '2020-01-01' && out.filename === 'x.slp',
        'their source / exported_at / filename stay');
    check(eq(out[LUCID_PROVENANCE_KEY], { source: 'lucid', exported_at: AT }), 'LUC3D\'s pair goes under "lucid"');
    const again = buildSaveProvenance([sess('S', fileSessionProvenance(out, [], 0))], '2026-10-24T00:00:00.000Z');
    check(eq(again, Object.assign({}, foreign, { lucid: { source: 'lucid', exported_at: '2026-10-24T00:00:00.000Z' } })),
        'saved twice: still one "lucid" pair, refreshed');
    const onlyAt = buildSaveProvenance([sess('S', { exported_at: 'then' })], AT);
    check(onlyAt.exported_at === 'then' && onlyAt.lucid.exported_at === AT, 'an exported_at alone also counts as theirs');
    const notOurs = foreignProvenance({ lucid: 'some other tool', a: 1 });
    check(eq(notOurs, { lucid: 'some other tool', a: 1 }), 'a "lucid" key that is not LUC3D\'s pair is kept');
}

console.log('\n-- LUC3D\'s own keys are not carried as the file\'s --');
{
    check(foreignProvenance({ source: 'lucid', exported_at: AT }) === null, 'a LUC3D-only provenance is none');
    check(foreignProvenance({ source: 'mv-gui', exported_at: AT }) === null, 'so is the old "mv-gui" one');
    check(foreignProvenance(null) === null && foreignProvenance([1]) === null && foreignProvenance('x') === null,
        'non-dicts are none');
}

console.log('\n-- sessions from different files: all kept, by session name --');
{
    const out = buildSaveProvenance([sess('A', CAMPY), sess('B', OTHER), sess('C', null), sess('D', CAMPY)], AT);
    check(eq(Object.assign({}, out, { [PROVENANCE_SESSIONS_KEY]: undefined }),
        Object.assign({}, CAMPY, { source: 'lucid', exported_at: AT, [PROVENANCE_SESSIONS_KEY]: undefined })),
        'top level: the first session\'s');
    check(eq(out[PROVENANCE_SESSIONS_KEY], { B: OTHER, C: {} }),
        'lucid_sessions: B\'s whole dict, C as {} (it had none); A and D match the top, so not listed');

    // Reopen: each session gets its own back.
    const names = ['A', 'B', 'C', 'D'];
    const back = names.map((n, i) => fileSessionProvenance(out, names, i));
    check(eq(back, [CAMPY, OTHER, null, CAMPY]), 'reopened: A, B, C, D each get their own');
    const resaved = buildSaveProvenance(names.map((n, i) => sess(n, back[i])), AT);
    check(eq(resaved, out), 'and saving again writes the same provenance');

    // First session with none: the first that has one gives the top level.
    const out2 = buildSaveProvenance([sess('X', null), sess('Y', OTHER)], AT);
    check(out2['campy-live-export'] === OTHER['campy-live-export'] && eq(out2[PROVENANCE_SESSIONS_KEY], { X: {} }),
        'a first session without one: top = the next with one, it is listed as {}');
    check(eq([0, 1].map(i => fileSessionProvenance(out2, ['X', 'Y'], i)), [null, OTHER]), 'and that reopens right');

    // The single-SLP folder loader reads only session 0 of a file.
    check(eq(fileSessionProvenance(out, names, 0), CAMPY), 'session 0 alone: the top level');
}

console.log('\n-- repeated session names stay apart --');
{
    check(eq(provenanceSessionKeys(['S', 'S', 'T', 'S']), ['S', 'S #2', 'T', 'S #3']), 'S, S #2, T, S #3');
    check(eq(provenanceSessionKeys(['S', 'S #2', 'S']), ['S', 'S #2', 'S #3']), 'a name already taken is skipped');
    check(eq(provenanceSessionKeys([null, undefined, '']), ['', ' #2', ' #3']), 'missing names');
    const out = buildSaveProvenance([sess('S', CAMPY), sess('S', OTHER)], AT);
    check(eq(out[PROVENANCE_SESSIONS_KEY], { 'S #2': OTHER }), 'two sessions named S: the second is "S #2"');
    check(eq([0, 1].map(i => fileSessionProvenance(out, ['S', 'S'], i)), [CAMPY, OTHER]), 'and each reopens right');
}

console.log('\n-- the reader takes the names LUC3D wrote --');
{
    const raw = [{ metadata: { lucid: { sessionName: 'A' } } }, { metadata: {} }, null];
    check(eq(fileSessionNames(raw), ['A', '', '']), 'metadata.lucid.sessionName, else ""');
    check(eq(fileSessionNames(undefined), []), 'no sessions_json: none');
    check(eq(fileSessionProvenance(CAMPY, [], 3), CAMPY), 'an index past the names: the top level');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
