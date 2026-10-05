/**
 * id-switch-fix.mjs — "Fix switch…" in the ID Switches tab, in the real app.
 *
 * Fixture: two calibrated views (no video), 120 frames at 30 fps, three animals
 * with identities id_0 / id_1 / id_2 at fixed places. The tracker's labels are
 * CROSSED from frame 51 on: the animal at id_0's place carries id_1 and vice
 * versa. The session holds one ID-switch result with two rows:
 *   - the onset id_0 ↔ id_1, close 40..50, reaching the end of the session;
 *   - id_1 ↔ id_2 at 90, inside the crossed stretch (a follow-on).
 * Asserted:
 *  1. The selected row offers "Fix switch…"; the dialog names frames 52–120
 *     ("where they separate") from the lead-in, and 51–120 ("the frame you are
 *     paused on") from inside the close spell. Esc and Cancel change nothing, and
 *     no app shortcut fires under the dialog.
 *  2. Confirming swaps exactly that stretch: every frame's labels are right again,
 *     frames before it are untouched; the row stays, ticked and marked Fixed, the
 *     view is back at its lead-in, and the box still encloses the pair at frame 60.
 *  3. The follow-on row inside the stretch is renamed to the animals it is about
 *     (id_0 ↔ id_2) and its box still encloses the id_2 animal.
 *  4. The fix is in the saved checklist; Undo restores the identities exactly and
 *     offers Fix again.
 *
 * Run: node tests/e2e/id-switch-fix.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8281);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'Trunk'];
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const s = new pd.Session(cams, new pd.Skeleton('m', NODES, []), [], 'FIX');
        const ids = ['id_0', 'id_1', 'id_2'].map(n => s.addIdentity(n).id);
        const home = [[120, 200], [190, 230], [540, 380]];
        let gid = 1;
        for (let f = 0; f < 120; f++) {
            const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
            const gs = [];
            for (let a = 0; a < 3; a++) {
                const label = f > 50 && a < 2 ? ids[1 - a] : ids[a];          // crossed from frame 51
                const g = new pd.InstanceGroup(gid++, label);
                for (const c of cams) {
                    const [cx, cy] = home[a];
                    const inst = new pd.Instance(NODES.map((_, k) => [cx + 12 * k - 24, cy + (k % 2) * 8]), null, 'predicted', 0.9);
                    g.addInstance(c.name, inst); fg.addInstance(c.name, inst);
                }
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = 120; AS.state.currentFrame = 0; AS.state.fps = 30;
        AS.paneManager.clearAll();
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        if (AS.timeline) { AS.timeline.setTotalFrames(120); AS.timeline.setData(s); }
        const onset = { frame: 50, startFrame: 40, nameA: 'id_0', nameB: 'id_1', identityA: ids[0], identityB: ids[1],
                        score: -80, cue: 'size', kind: 'onset', switchBackAt: null, flagged: true, continues: false };
        const follow = { frame: 90, startFrame: 85, nameA: 'id_1', nameB: 'id_2', identityA: ids[1], identityB: ids[2],
                         score: -70, cue: 'size', kind: 'onset', switchBackAt: null, followOf: 50, flagged: true, continues: false };
        s._idSwitch = { results: { size: { ok: true, flags: [onset, follow], changes: [], encounters: [{}, {}], sampleHz: 15, step: 2, fps: 30, fpsFromVideo: false } },
                        reviewed: new Set(), fixes: [], showRepeats: false, current: null };
        const M = await import('/ui/id-switch-modal.js');
        M.refreshIdSwitchPanel(s); M.openIdSwitchPanel();
        // truth: label at each place per frame; `wrong` counts frames whose labels are crossed
        window.__labels = () => {
            const S = AS.state.session, out = { wrong: [], snap: '' };
            for (let f = 0; f < 120; f++) {
                const gs = S.instanceGroups.get(f);
                if (gs[0].identityId !== ids[0] || gs[1].identityId !== ids[1] || gs[2].identityId !== ids[2]) out.wrong.push(f);
                out.snap += gs.map(g => g.identityId).join('') + ',';
            }
            return out;
        };
    });

    const onsetRow = '#idSwitchPanel .id-switch-row[data-frame="50"]';
    const dialogText = () => page.evaluate(() => { const d = document.querySelector('.id-switch-fix-modal'); return d ? d.textContent : null; });
    const frame = () => page.evaluate(() => window.__lucid.state.currentFrame);
    const before = await page.evaluate(() => window.__labels());
    check(before.wrong.length === 69 && before.wrong[0] === 51, `fixture: labels crossed on frames 51..119 (${before.wrong.length})`);

    // ---- 1. the button and the dialog
    await page.click(onsetRow + ' .id-switch-line1');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 10, null, { timeout: 10000 }).catch(() => {});
    check(await page.isVisible(onsetRow + ' .id-switch-fix'), 'the selected row offers "Fix switch…"');
    check(!(await page.isVisible('#idSwitchPanel .id-switch-row[data-frame="90"] .id-switch-fix')), 'only the selected row does');
    await page.click(onsetRow + ' .id-switch-fix');
    let t = await dialogText();
    check(!!t && /frames 52–120/.test(t) && /where they separate/.test(t) && /the end of the video/.test(t),
        `from the lead-in: frames 52–120, starting where they separate (${t && t.slice(0, 140)})`);
    await page.keyboard.press('v');
    check(await page.evaluate(() => window.__lucid.state.viewMode) === 'grid', 'an app shortcut (v) does not fire under the dialog');
    await page.keyboard.press('Escape');
    check(await dialogText() === null && (await page.evaluate(() => window.__labels())).snap === before.snap, 'Esc closes it and changes nothing');

    await page.click(onsetRow + ' .id-switch-end');                               // frame 50: inside the close spell
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 50, null, { timeout: 10000 }).catch(() => {});
    await page.click(onsetRow + ' .id-switch-fix');
    t = await dialogText();
    check(!!t && /frames 51–120/.test(t) && /paused on/.test(t), `paused inside the red section: frames 51–120, from the paused frame`);
    await page.click('#idSwitchFixCancel');
    check(await dialogText() === null && (await page.evaluate(() => window.__labels())).snap === before.snap, 'Cancel changes nothing');

    // ---- 2. confirm from the lead-in (frames 52–120 = indices 51..119: exactly the crossed stretch)
    await page.click(onsetRow + ' .id-switch-line1');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 10, null, { timeout: 10000 }).catch(() => {});
    await page.click(onsetRow + ' .id-switch-fix');
    await page.click('#idSwitchFixOk');
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__labels());
    check(after.wrong.length === 0, `every frame's labels are right after the fix (still wrong: ${after.wrong.slice(0, 5)})`);
    check(after.snap.slice(0, 51 * 4) === before.snap.slice(0, 51 * 4), 'frames before the stretch are untouched');
    const row = await page.evaluate(() => {
        const r = document.querySelector('#idSwitchPanel .id-switch-row[data-frame="50"]');
        return r && { fixed: r.classList.contains('is-fixed'), current: r.classList.contains('is-current'),
                      ticked: r.querySelector('.id-switch-tick').checked, note: (r.querySelector('.id-switch-fixed-note') || {}).textContent,
                      undo: !!r.querySelector('.id-switch-undo'), status: document.getElementById('statusText')?.textContent || '' };
    });
    check(row && row.fixed && row.current && row.ticked && /52–120/.test(row.note || '') && row.undo,
        `the row stays selected, ticked and Fixed, with Undo (${JSON.stringify(row)})`);
    check(await frame() === 10, `the view is back at the row's lead-in (${await frame()})`);

    // the box at frame 60 still encloses the pair (it reads the corrected labels)
    const boxAt = async (f) => {
        await page.evaluate(async (f) => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, f);
        await page.waitForTimeout(150);
        return page.evaluate(() => window.__lucid.state.views.map(v => {
            const c = v.wrapper.querySelector('.id-switch-canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sx = c.width / 640, sy = c.height / 480;
            let pair = 0, far = 0;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
                if (!d[(y * c.width + x) * 4 + 3]) continue;
                const vx = x / sx, vy = y / sy;
                if (vx < 300 && vy < 320) pair++; else if (vx > 450 && vy > 300) far++;
            }
            return { pair, far };
        }));
    };
    let b = await boxAt(60);
    check(b.every(v => v.pair > 200 && v.far === 0), `frame 60: the box encloses id_0 + id_1 (${JSON.stringify(b)})`);

    // ---- 3. the follow-on row inside the stretch is renamed to the animals it is about
    const follow = await page.evaluate(() => {
        const r = document.querySelector('#idSwitchPanel .id-switch-row[data-frame="90"] .id-switch-pair');
        return r && r.textContent;
    });
    check(follow === 'id_0 ↔ id_2', `the follow-on row now reads id_0 ↔ id_2 (${follow})`);
    await page.click('#idSwitchPanel .id-switch-row[data-frame="90"] .id-switch-line1');
    b = await boxAt(88);
    check(b.every(v => v.pair > 200 && v.far > 200), `its box encloses the id_0 animal and id_2 (${JSON.stringify(b)})`);

    // ---- 4. saved, then undone
    const saved = await page.evaluate(async () => {
        const R = await import('/ui/id-switch-review.js');
        return R.serializeIdSwitchReview(window.__lucid.state.session).fixes;
    });
    check(JSON.stringify(saved) === JSON.stringify([['size:50:id_0:id_1', '', 'id_0', 'id_1', 51, 119]]), `saved with the checklist (${JSON.stringify(saved)})`);
    await page.click(onsetRow + ' .id-switch-line1');
    await page.click(onsetRow + ' .id-switch-undo');
    await page.waitForTimeout(150);
    const undone = await page.evaluate(() => window.__labels());
    check(undone.snap === before.snap, 'Undo restores every identity exactly');
    check(await page.isVisible(onsetRow + ' .id-switch-fix') &&
          await page.evaluate(() => !document.querySelector('#idSwitchPanel .id-switch-row[data-frame="50"]').classList.contains('is-fixed')),
        'and the row offers Fix again');
    check(await page.evaluate(() => document.querySelector('#idSwitchPanel .id-switch-row[data-frame="90"] .id-switch-pair').textContent) === 'id_1 ↔ id_2',
        'the follow-on row has its old name back');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
