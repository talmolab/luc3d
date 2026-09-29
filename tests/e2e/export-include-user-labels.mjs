/**
 * export-include-user-labels.mjs — the two SLP export modals' option UI
 * (luc3d #194): "Export SLEAP File Per Session" and "Export SLEAP File By Cam"
 * must say, in the modal, that USER LABELS are always written.
 *
 * Both modals always pass `instanceFilter.user = true`, but the only controls a
 * user could SEE were "Predicted Instances" and "Reprojections". With their own
 * labels absent from a list headed "Include", people reasonably read the silence
 * as an exclusion and went looking for a missing checkbox — so the group now
 * says it outright.
 *
 * A claim in the UI is only worth pinning if it is also TRUE, so this asserts
 * both halves:
 *
 *  1. Both modals' "Include" group opens with the NOTE "UserLabels are
 *     automatically saved", above exactly two option rows. It must stay prose: an
 *     always-on switch was tried first and is wrong, because a control that
 *     cannot be operated misstates what the user can do (and invites a future
 *     caller to read it as a real option). So this asserts the note contains no
 *     control at all, and that the group has two rows, not three.
 *  2. Predicted / Reprojections moved from bare checkboxes to the app's standard
 *     `.toggle-switch`, and BOTH still work: the ids the export handlers read
 *     (`slpPsIncPred`/`slpPsIncReproj`, `slpByCamIncPred`/`slpByCamReproj`) are
 *     intact, and clicking the `.slider` actually flips the checkbox. A
 *     `.toggle-switch` not wrapped in a `<label>` looks perfectly right and is
 *     completely dead, which is the failure a screenshot cannot catch.
 *  3. The Reprojections sub-toggle (UserInstance / PredictedInstance) still
 *     enables and disables with its switch, and By-Cam still disables the whole
 *     row as a unit when no session has reprojections to save.
 *  4. The promise holds end to end: running the Per-Session export with
 *     Predicted OFF and Reprojections OFF (the configuration whose UI looked
 *     like "nothing is included") writes a file that reads back with every user
 *     instance and no predicted ones.
 *  5. The Per-Session filename table is themed. The output field used to be a
 *     raw `<input>` — a white box in a system font on a dark modal — and the
 *     Download checkbox a stock white square. Both are now drawn from the app's
 *     tokens. Asserted as computed style, not markup, since that is what makes
 *     a theme regression visible. Also: the field carries the full name in
 *     `title` (it elides), and a user filename containing a `"` must survive
 *     into the field rather than breaking out of the attribute — these rows are
 *     built by string concatenation, so that escaping is load-bearing.
 *
 * Run: node tests/e2e/export-include-user-labels.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8244);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        errs.push('console.error: ' + t.slice(0, 200));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // -----------------------------------------------------------------
    // Fixture: two sessions sharing camera names, each frame carrying one
    // USER and one PREDICTED instance per camera. Predicted instances exist
    // so step 5's "Predicted OFF" run has something it could wrongly keep.
    // -----------------------------------------------------------------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup, Instance } = pd;

        const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
        const skel = new Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
        const mk = (name, camNames) => new Session(
            camNames.map((n, i) => new Camera(
                n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [320, 240])),
            skel, ['track_0', 'track_1'], name);

        const s1 = mk('Session A', ['camA', 'camB']);
        const s2 = mk('Session B', ['camA', 'camB']);
        for (let f = 0; f < 4; f++) {
            s1.addFrameGroup(new FrameGroup(f));
            const fg = s1.getFrameGroup(f);
            for (const cn of ['camA', 'camB']) {
                fg.addInstance(cn, new Instance(
                    [[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
                fg.addInstance(cn, new Instance(
                    [[60 + f, 20], [80 + f, 40], [100 + f, 60]], 1, 'predicted', 0.8));
            }
        }

        AS.setProjectSkeleton(skel);
        AS.state.sessions = [s1, s2];
        AS.state.session = s1;
        AS.state.activeSessionIdx = 0;
        AS.state.views = s1.cameras.map(c => ({
            name: c.name, videoWidth: 320, videoHeight: 240, canvas: null,
        }));
        AS.state.videoFiles = [
            ...s1.cameras.map(c => ({ name: c.name, assignedCamera: c.name, sessionIdx: 0 })),
            ...s2.cameras.map(c => ({ name: c.name, assignedCamera: c.name, sessionIdx: 1 })),
        ];
        AS.state.cameraDirMap = { camA: 'cam_a', camB: 'cam_b' };
    });

    /**
     * Shared assertions over whichever export modal is currently open.
     * `ids` names the option checkboxes that modal's export handler reads.
     */
    async function assertIncludeGroup(label, ids) {
        const r = await page.evaluate((ids) => {
            const modal = document.querySelector('.multi-frame-modal-overlay .multi-frame-modal');
            const group = modal.querySelector('.slp-inc-group');
            const note = modal.querySelector('.slp-inc-note');
            const rows = Array.from(modal.querySelectorAll('.slp-inc-row'));
            const flat = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
            return {
                noteText: flat(note),
                // The note must come BEFORE the switches — it frames them.
                noteIsFirst: !!(group && note && group.firstElementChild
                    && group.firstElementChild.nextElementSibling === note),
                rowCount: rows.length,
                rowTexts: rows.map(flat),
                // Nothing in the note may be a control: an assurance rendered as
                // an inert input is exactly the thing this replaced.
                noteHasControls: !!(note && note.querySelector(
                    'input, button, select, textarea, .toggle-switch')),
                // Every option switch must be a <label class="toggle-switch"> —
                // a <span> wrapper renders identically and never toggles.
                optionsAreLabels: ids.every(id => {
                    const sw = document.getElementById(id).closest('.toggle-switch');
                    return !!sw && sw.tagName === 'LABEL';
                }),
                // Scoped to the whole options area, not just `.slp-inc-row`, so a
                // regression that drops the group entirely fails here too rather
                // than passing on an empty query.
                bareCheckboxes: modal.querySelectorAll(
                    '.slp-inc-group input[type=checkbox]:not(.toggle-switch input),'
                    + '.slp-export-options input[type=checkbox]').length,
            };
        }, ids);

        check(/userlabels are automatically saved/i.test(r.noteText),
            `${label}: Include group states "UserLabels are automatically saved" `
            + `(got "${r.noteText}")`);
        check(r.noteIsFirst, `${label}: the note sits above the switches it qualifies`);
        check(!r.noteHasControls,
            `${label}: the note is prose — no inert switch pretending to be an option`);
        check(r.rowCount === 2,
            `${label}: exactly 2 option rows, one per thing the user can change (got ${r.rowCount})`);
        check(r.optionsAreLabels, `${label}: option switches are <label class="toggle-switch">`);
        check(r.bareCheckboxes === 0, `${label}: no bare checkboxes left in the Include group`);
    }

    /**
     * Click an option's visible `.slider`. Returns false when there isn't one,
     * so a run against a build without the switches reports every failure
     * instead of dying on the first missing locator.
     */
    async function clickSlider(id, opts) {
        const slider = page.locator(`#${id} + .slider`);
        if (await slider.count() === 0) return false;
        await slider.click(opts);
        return true;
    }

    /** The visible `.slider` must actually drive the underlying checkbox. */
    async function toggleViaSlider(id) {
        const before = await page.evaluate(i => document.getElementById(i).checked, id);
        if (!await clickSlider(id)) return { before, after: before, missing: true };
        const after = await page.evaluate(i => document.getElementById(i).checked, id);
        return { before, after };
    }

    // =================================================================
    // 1-3 — Per Session modal
    // =================================================================
    console.log('Export SLEAP File Per Session');
    await page.evaluate(async () => {
        (await import('/ui/export-modals.js')).showSlpExportPerSessionModal();
    });
    await page.waitForSelector('.slp-export-persession-modal', { timeout: 5000 });
    await assertIncludeGroup('per-session', ['slpPsIncPred', 'slpPsIncReproj']);

    const psPred = await toggleViaSlider('slpPsIncPred');
    check(psPred.before === true && psPred.after === false,
        'per-session: Predicted Instances defaults on and its slider toggles it off');

    const psReproj = await toggleViaSlider('slpPsIncReproj');
    check(psReproj.before === false && psReproj.after === true,
        'per-session: Reprojections defaults off and its slider toggles it on');
    check(await page.evaluate(() => {
        const t = document.getElementById('slpPsReprojToggle');
        return !!t && !t.classList.contains('slp-toggle-disabled');
    }), 'per-session: UserInstance/PredictedInstance sub-toggle enables with Reprojections');
    await clickSlider('slpPsIncReproj');
    check(await page.evaluate(() => {
        const t = document.getElementById('slpPsReprojToggle');
        return !!t && t.classList.contains('slp-toggle-disabled');
    }), 'per-session: sub-toggle disables again when Reprojections goes off');

    // =================================================================
    // 4 — the promise holds: Predicted OFF + Reprojections OFF still writes
    //     every user instance. Both are already off from the toggling above.
    // =================================================================
    const exported = await page.evaluate(async () => {
        // In-memory stand-in for the directory picker: headless Chromium has no
        // real one, and the modal always prompts rather than reusing a handle.
        const written = {};
        window.showDirectoryPicker = async () => ({
            getDirectoryHandle: async (name) => ({
                getFileHandle: async (fname) => ({
                    createWritable: async () => ({
                        write: async (blob) => { written[name + '/' + fname] = blob; },
                        close: async () => {},
                    }),
                }),
            }),
        });

        document.getElementById('slpPsExport').click();
        // Wait for the modal to close, which is how the handler signals success.
        for (let i = 0; i < 200; i++) {
            if (!document.querySelector('.slp-export-persession-modal')) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const err = document.getElementById('slpPsError');
        if (err && err.textContent) return { error: err.textContent };

        const fio = await import('/import-export/file-io.js');
        const names = Object.keys(written).sort();
        const out = { names, perFile: {} };
        for (const n of names) {
            const file = new File([written[n]], n.split('/').pop());
            const slp = await fio.parseSlpViaSleapIO(file);
            let user = 0, pred = 0;
            for (const f of slp.frames) {
                for (const inst of f.instances) {
                    if (inst.type === 'predicted') pred++; else user++;
                }
            }
            out.perFile[n] = { user, pred };
        }
        return out;
    });

    check(!exported.error, `per-session: export succeeded (${exported.error || 'no error'})`);
    check(JSON.stringify(exported.names) === JSON.stringify(['cam_a/camA_v1.slp', 'cam_b/camB_v1.slp']),
        `per-session: wrote one file per camera into its directory (${JSON.stringify(exported.names)})`);
    for (const n of (exported.names || [])) {
        const c = exported.perFile[n];
        check(c.user === 4, `per-session: ${n} kept all 4 user instances (got ${c.user})`);
        check(c.pred === 0, `per-session: ${n} wrote no predicted instances (got ${c.pred})`);
    }

    // =================================================================
    // 5 — the Per-Session filename table is in the app's own style
    // =================================================================
    console.log('Per-Session filename table');
    await page.evaluate(async () => {
        const ov = document.querySelector('.multi-frame-modal-overlay');
        if (ov) ov.remove();
        const AS = await import('/ui/app-state.js');
        // A name with a double quote: these rows are built by concatenating
        // HTML, so an unescaped value would break out of value="..." and the
        // field would come back truncated (or the row would collapse).
        AS.state.videoFiles[0].slpFilename =
            'ca"mA-10072022145417-0000_h265_CRF30_denoised.mp4.predictions.slp';
        (await import('/ui/export-modals.js')).showSlpExportPerSessionModal();
    });
    await page.waitForSelector('.slp-export-persession-modal', { timeout: 5000 });

    const table = await page.evaluate(() => {
        const q = document.querySelector('.slp-export-persession-modal');
        const inputs = Array.from(q.querySelectorAll('.slp-ps-filename'));
        const box = q.querySelector('.slp-ps-dl');
        const fi = getComputedStyle(inputs[0]);
        const cb = getComputedStyle(box);
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        return {
            count: inputs.length,
            firstValue: inputs[0].value,
            titlesMatchValues: inputs.every(i => i.title === i.value),
            spellcheckOff: inputs.every(i => i.getAttribute('spellcheck') === 'false'),
            inputBg: fi.backgroundColor,
            inputFont: fi.fontFamily,
            inputRadius: fi.borderTopLeftRadius,
            inputEllipsis: fi.textOverflow,
            checkboxAppearance: cb.appearance,
            checkboxBg: cb.backgroundColor,
            bodyBg,
        };
    });

    // The theme tokens are dark; "white-ish" is precisely the old browser default.
    const isLight = (c) => {
        const m = c.match(/\d+/g);
        return m && (+m[0] + +m[1] + +m[2]) / 3 > 200;
    };
    check(table.count === 2, `filenames: one field per camera (got ${table.count})`);
    check(table.firstValue.startsWith('ca"mA-'),
        `filenames: a name containing a quote survives into the field (got "${table.firstValue}")`);
    check(table.titlesMatchValues,
        'filenames: each field carries its full name in title (the text elides)');
    check(table.spellcheckOff, 'filenames: spellcheck off — no squiggles under _h265_CRF30');
    check(!isLight(table.inputBg),
        `filenames: field uses the dark theme background, not the browser default (got ${table.inputBg})`);
    check(/mono/i.test(table.inputFont),
        `filenames: field is monospace so the _CRF/_vN segments align (got ${table.inputFont})`);
    check(table.inputRadius !== '0px', 'filenames: field has the app\'s rounded corners');
    check(table.inputEllipsis === 'ellipsis', 'filenames: long names elide rather than clipping');
    check(table.checkboxAppearance === 'none' && !isLight(table.checkboxBg),
        `filenames: Download checkbox is drawn in the app's palette, not a white square `
        + `(appearance=${table.checkboxAppearance}, bg=${table.checkboxBg})`);

    // Unchecking a row dims it, so the Download column reads at a glance.
    await page.click('.slp-ps-dl[data-idx="0"]');
    const dimmed = await page.evaluate(() => {
        const row = document.querySelector('.slp-export-persession-modal tbody tr');
        return {
            marked: row.classList.contains('slp-ps-off'),
            faded: parseFloat(getComputedStyle(row.querySelector('.slp-ps-dir')).opacity) < 1,
        };
    });
    check(dimmed.marked && dimmed.faded, 'filenames: an unchecked row dims');
    await page.click('.slp-ps-dl[data-idx="0"]');
    check(await page.evaluate(() => !document.querySelector(
        '.slp-export-persession-modal tbody tr').classList.contains('slp-ps-off')),
        'filenames: re-checking it undims');

    // Editing a name keeps title in sync — otherwise hover reports a stale name.
    await page.evaluate(() => {
        const i = document.querySelector('.slp-ps-filename');
        i.value = 'renamed_v9.slp';
        i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    check(await page.evaluate(
        () => document.querySelector('.slp-ps-filename').title === 'renamed_v9.slp'),
        'filenames: editing a name updates its hover title');

    // =================================================================
    // 1-3 — By Cam modal
    // =================================================================
    console.log('Export SLEAP File By Cam');
    await page.evaluate(async () => {
        const ov = document.querySelector('.multi-frame-modal-overlay');
        if (ov) ov.remove();
        (await import('/ui/export-modals.js')).showSlpExportByCamModal();
    });
    await page.waitForSelector('.slp-bycam-table', { timeout: 5000 });
    await assertIncludeGroup('by-cam', ['slpByCamIncPred', 'slpByCamReproj']);

    const bcPred = await toggleViaSlider('slpByCamIncPred');
    check(bcPred.before === true && bcPred.after === false,
        'by-cam: Predicted Instances defaults on and its slider toggles it off');

    // No session here has been triangulated, so Reprojections is unavailable —
    // the whole row dims as a unit and the switch cannot be turned on.
    const bcReproj = await page.evaluate(() => {
        const row = document.getElementById('slpByCamReprojRow');
        const sub = document.getElementById('slpByCamReprojToggle');
        return {
            disabled: document.getElementById('slpByCamReproj').disabled,
            rowDimmed: !!row && row.classList.contains('slp-inc-row-disabled'),
            subToggleOff: !!sub && sub.classList.contains('slp-toggle-disabled'),
        };
    });
    check(bcReproj.disabled && bcReproj.rowDimmed && bcReproj.subToggleOff,
        'by-cam: Reprojections row is disabled as a unit when nothing is triangulated');
    await clickSlider('slpByCamReproj', { force: true });
    check(await page.evaluate(() => !document.getElementById('slpByCamReproj').checked),
        'by-cam: clicking the disabled Reprojections switch does nothing');

    if (errs.length) { errs.forEach(e => console.log('  ✗ ' + e)); fails += errs.length; }
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
