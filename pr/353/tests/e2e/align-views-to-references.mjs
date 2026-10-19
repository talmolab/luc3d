/**
 * align-views-to-references.mjs — View ▸ "Align Views to References…" (issue
 * #226) in the real app, end to end.
 *
 * Fixture: a ring of five calibrated cameras around a vertical POST (a 2-node
 * "skeleton": base and top, one metre apart), each camera rolled differently so
 * the post leans a different way in every pane — the "disorienting grid" of the
 * issue. cam0 and cam2 are pre-rotated so the post stands upright in them (the
 * user's two references). A second session uses the same camera names with a
 * slightly perturbed calibration, for "Also apply to the other sessions".
 *
 * Asserted, through the real dock panes and the real menu item:
 *  1. The dialog pre-selects the two views the user already turned and
 *     previews a rotation for every other camera.
 *  2. Esc closes it with NOTHING changed.
 *  3. An upside-down reference is refused inline and disables Apply; one
 *     reference is not enough; more than two can be ticked.
 *  4. Apply writes both copies — the session store AND `view.rotation` — and,
 *     measured ON SCREEN through the wrapper's computed CSS transform, the post
 *     now points up in EVERY pane (within the 0.5° the integer store allows).
 *  5. The project is marked dirty (rotation is saved project state).
 *  6. The other session is aligned from ITS OWN calibration: its post is
 *     upright for its cameras too, not merely given session 1's numbers.
 *
 * Writes `align-views-before.png` / `align-views-after.png` to $SHOT_DIR when set.
 *
 * Run: node tests/e2e/align-views-to-references.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8262);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        errs.push('console.error: ' + t.slice(0, 300));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- fixture -------------------------------------------------------------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const VA = await import('/pose/view-align.js');
        const vf = await import('/ui/video-filters.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const unit = (a) => { const n = Math.hypot(...a); return a.map(v => v / n); };
        function lookAt(name, C, target, rollDeg) {
            const z = unit(sub(target, C));
            let x = unit(cross(z, [0, 0, 1]));
            let y = cross(z, x);
            const r = rollDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
            [x, y] = [x.map((v, i) => c * v + s * y[i]), x.map((v, i) => -s * v + c * y[i])];
            const R = [x, y, z];
            const t = R.map(row => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]));
            return new Camera(name, [[700, 0, 320], [0, 700, 240], [0, 0, 1]], [-0.1, 0.02, 0, 0, 0], R, t, [640, 480]);
        }
        const BASE = [0, 0, 0], TOP = [0, 0, 1000];
        const skel = new Skeleton('post', ['base', 'top'], [[0, 1]]);

        function makeSession(name, rolls, wobble) {
            const cams = rolls.map((roll, i) => {
                const a = (i / rolls.length) * 2 * Math.PI + wobble;
                return lookAt('cam' + i, [3000 * Math.cos(a), 3000 * Math.sin(a), 1200 + 200 * (i % 2)], [0, 0, 500], roll);
            });
            const session = new Session(cams, skel, ['track_0'], name);
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(10, null);
            for (const cam of cams) {
                const pt = (X) => cam.distortPoint(cam.project(X));
                const inst = new Instance([pt(BASE), pt(TOP)], 0, 'user', 1);
                g.addInstance(cam.name, inst);
                fg.addInstance(cam.name, inst);
            }
            session.instanceGroups.set(0, [g]);
            return session;
        }
        const s1 = makeSession('Ring A', [25, -60, 110, 170, -20], 0);
        // Same rig re-calibrated for another recording: the cameras moved a
        // little, so its angles must be solved, not copied.
        const s2 = makeSession('Ring B', [26, -62, 111.5, 170, -21], 0.05);

        // The user's two references: rotate cam0 and cam2 until the post stands up.
        for (const name of ['cam0', 'cam2']) {
            const cam = s1.cameras.find(c => c.name === name);
            const a = VA.projectToImage(cam, [0, 0, 400]), b = VA.projectToImage(cam, [0, 0, 600]);
            vf.setSessionRotation(s1, name, VA.rotationForImageDir([b[0] - a[0], b[1] - a[1]]));
        }

        AS.state.sessions = [s1, s2];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s1;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = s1.cameras.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = s1.cameras.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;

        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        const rendering = await import('/ui/rendering.js');
        rendering.drawAllOverlays(0);

        // Each view's video canvas is blank with no decoder; paint a flat card so
        // the rotated tiles are visible in the screenshots.
        for (const v of AS.state.views) {
            if (!v.ctx || !v.canvas) continue;
            v.ctx.fillStyle = '#2b3140';
            v.ctx.fillRect(0, 0, v.canvas.width, v.canvas.height);
            v.ctx.fillStyle = '#c8cde0';
            v.ctx.font = '40px sans-serif';
            v.ctx.fillText(v.name + ' — image top', 20, 50);
        }
        window.__s1 = s1; window.__s2 = s2;
    });

    // On-screen angle of the post in each pane, read off the wrapper's COMPUTED
    // transform (what the user sees), plus the stored and live rotations.
    const measure = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const vf = await import('/ui/video-filters.js');
        const out = {};
        for (const v of AS.state.views) {
            const cam = AS.state.session.cameras.find(c => c.name === v.name);
            const pt = (X) => cam.distortPoint(cam.project(X));
            const a = pt([0, 0, 400]), b = pt([0, 0, 600]);
            const wrapper = v.wrapper || v.canvas.parentElement;
            const m = new DOMMatrix(getComputedStyle(wrapper).transform === 'none' ? undefined : getComputedStyle(wrapper).transform);
            const k = parseFloat(v.canvas.style.width) / v.videoWidth;   // video px -> wrapper css px
            const A = m.transformPoint(new DOMPoint(a[0] * k, a[1] * k));
            const B = m.transformPoint(new DOMPoint(b[0] * k, b[1] * k));
            // Angle from screen-up; 0 = the post stands upright on screen.
            const screenDeg = Math.atan2(B.x - A.x, -(B.y - A.y)) * 180 / Math.PI;
            out[v.name] = {
                screenDeg,
                stored: vf.getSessionRotation(AS.state.session, v.name),
                live: v.rotation || 0,
            };
        }
        return out;
    });

    const before = await measure();
    check(Math.abs(before.cam0.screenDeg) < 0.6 && Math.abs(before.cam2.screenDeg) < 0.6,
        'precondition: the two reference panes already show the post upright');
    check(['cam1', 'cam3', 'cam4'].every(n => Math.abs(before[n].screenDeg) > 5),
        'precondition: the other panes show it leaning');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'align-views-before.png') });

    // ---- 1. open via the real menu item ------------------------------------------
    await page.evaluate(() => document.getElementById('menuAlignViews').click());
    await page.waitForSelector('.align-views-modal');
    const dialog = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.align-views-table tbody tr')];
        return {
            checked: rows.filter(r => r.querySelector('input').checked).map(r => r.querySelector('.align-views-name').textContent),
            results: Object.fromEntries(rows.map(r => [r.querySelector('.align-views-name').textContent, r.querySelector('.align-views-result').textContent])),
            applyDisabled: document.getElementById('alignViewsApply').disabled,
            hasAll: !!document.getElementById('alignViewsAll'),
        };
    });
    check(JSON.stringify(dialog.checked) === JSON.stringify(['cam0', 'cam2']),
        'pre-selects the two views the user already turned (got ' + dialog.checked + ')');
    check(dialog.results.cam0 === 'reference' && dialog.results.cam2 === 'reference', 'references are labelled');
    check(['cam1', 'cam3', 'cam4'].every(n => /^-?\d+°$/.test(dialog.results[n])), 'previews an angle for every other camera');
    check(!dialog.applyDisabled, 'Apply is enabled');
    check(dialog.hasAll, 'offers "also apply to the other sessions"');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'align-views-modal.png') });

    // ---- 2. Esc closes with nothing changed --------------------------------------------
    await page.keyboard.press('Escape');
    const escClosed = await page.evaluate(() => !document.querySelector('.align-views-modal'));
    check(escClosed, 'Esc closes the dialog');
    const afterEsc = await measure();
    check(['cam1', 'cam3', 'cam4'].every(n => afterEsc[n].stored === before[n].stored && afterEsc[n].live === before[n].live),
        'Esc changed nothing');

    // ---- 3. an upside-down reference is refused inline --------------------------------
    await page.evaluate(() => {
        const s1 = window.__s1;
        window.__savedCam2 = s1.videoRotation.cam2;
        s1.videoRotation.cam2 = ((s1.videoRotation.cam2 + 180 + 180) % 360) - 180;
        document.getElementById('menuAlignViews').click();
    });
    await page.waitForSelector('.align-views-modal');
    const flipped = await page.evaluate(() => ({
        error: document.getElementById('alignViewsError').textContent,
        applyDisabled: document.getElementById('alignViewsApply').disabled,
    }));
    check(/upside down/.test(flipped.error), 'an upside-down reference is refused inline: "' + flipped.error.slice(0, 70) + '…"');
    check(flipped.applyDisabled, 'Apply is disabled while the references conflict');
    // Unticking the bad one leaves ONE reference: still not enough.
    const oneLeft = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.align-views-table tbody tr')];
        rows.find(r => r.querySelector('.align-views-name').textContent === 'cam2').querySelector('input').click();
        return {
            summary: document.getElementById('alignViewsSummary').textContent,
            applyDisabled: document.getElementById('alignViewsApply').disabled,
        };
    });
    check(/Tick 1 more reference view\./.test(oneLeft.summary) && oneLeft.applyDisabled, 'one reference is not enough: "' + oneLeft.summary + '"');
    // A further tick ADDS a reference (no cap at two).
    const three = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.align-views-table tbody tr')];
        const box = n => rows.find(r => r.querySelector('.align-views-name').textContent === n).querySelector('input');
        box('cam1').click(); box('cam3').click();
        return rows.filter(r => r.querySelector('input').checked).map(r => r.querySelector('.align-views-name').textContent);
    });
    check(JSON.stringify(three) === JSON.stringify(['cam0', 'cam1', 'cam3']), 'more than two references can be ticked (' + three + ')');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__s1.videoRotation.cam2 = window.__savedCam2; });

    // ---- 4/5/6. apply for real, to both sessions ---------------------------------------
    await page.evaluate(async () => {
        const sl = await import('/import-export/save-load.js');
        if (sl.clearDirty) sl.clearDirty();
        document.getElementById('menuAlignViews').click();
    });
    await page.waitForSelector('.align-views-modal');
    await page.evaluate(() => {
        document.getElementById('alignViewsAll').click();
        document.getElementById('alignViewsApply').click();
    });
    await page.waitForFunction(() => !document.querySelector('.align-views-modal'));
    const after = await measure();
    for (const n of Object.keys(after)) {
        check(Math.abs(after[n].screenDeg) <= 0.6,
            `${n}: post upright on screen (${after[n].screenDeg.toFixed(2)}°, rotation ${after[n].live}°)`);
        check(after[n].stored === after[n].live, `${n}: session store and view.rotation agree`);
    }
    check(after.cam0.stored === before.cam0.stored && after.cam2.stored === before.cam2.stored, 'references untouched');
    const status = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/Aligned 3 views to cam0 \+ cam2/.test(status) && /1 other session/.test(status), 'status reports the result: "' + status + '"');
    const dirty = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        return { global: AS.state.isDirty, s1: window.__s1.isDirty, s2: window.__s2.isDirty };
    });
    check(dirty.global && dirty.s1, 'project and active session marked dirty');
    check(dirty.s2, 'the other edited session is marked dirty too (its own flag)');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'align-views-after.png') });

    // Session 2: solved from its OWN calibration with session 1's reference angles.
    const s2 = await page.evaluate(async () => {
        const vf = await import('/ui/video-filters.js');
        const VA = await import('/pose/view-align.js');
        const s2 = window.__s2;
        const refRot = { cam0: vf.getSessionRotation(window.__s1, 'cam0'), cam2: vf.getSessionRotation(window.__s1, 'cam2') };
        const expect = VA.alignViewRotations(s2.cameras, refRot, ['cam0', 'cam2']);
        const out = {};
        for (const cam of s2.cameras) {
            const pt = (X) => cam.distortPoint(cam.project(X));
            const a = pt([0, 0, 400]), b = pt([0, 0, 600]);
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const deg = vf.getSessionRotation(s2, cam.name);
            const t = deg * Math.PI / 180;
            const sx = dx * Math.cos(t) - dy * Math.sin(t), sy = dx * Math.sin(t) + dy * Math.cos(t);
            out[cam.name] = { deg, screenDeg: Math.atan2(sx, -sy) * 180 / Math.PI,
                              s1deg: vf.getSessionRotation(window.__s1, cam.name),
                              expected: vf.clampRotationSetting(expect.rotations[cam.name]) };
        }
        return out;
    });
    for (const n of Object.keys(s2)) {
        check(s2[n].deg === s2[n].expected, `session 2 ${n}: ${s2[n].deg}° = its own solve (${s2[n].expected}°)`);
        // The references are copied and the rig moved ~2°, so "up" is only
        // approximately vertical in session 2 — but close.
        check(Math.abs(s2[n].screenDeg) <= 6, `session 2 ${n}: post within 6° of upright (${s2[n].screenDeg.toFixed(2)}°)`);
    }
    check(s2.cam0.deg === s2.cam0.s1deg && s2.cam2.deg === s2.cam2.s1deg, 'session 2 carries over the reference angles');
    check(['cam1', 'cam3', 'cam4'].some(n => s2[n].deg !== s2[n].s1deg), 'session 2 got its own angles, not copies of session 1');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
