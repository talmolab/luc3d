/**
 * toolbar-3d-toggle-button.mjs — issue #151.
 *
 * "In situations where monitor space is limited, it would be helpful to have a
 * button to toggle closed the 3d view. I think the 'Hide/Show 3d View' button
 * should be right next to 'Hide/Show Panel' button."
 *
 * Before this, the 3D viewport could only be collapsed from the `\` shortcut
 * or View ▸ Toggle 3D Viewport — both invisible to a user who has not gone
 * looking for them, whereas the info panel had a labelled toolbar button.
 *
 * What this pins, beyond "a button exists":
 *   - It is LEFT of the info-panel button and on the same toolbar row, which
 *     is the actual layout the issue asks for (asserted from real geometry,
 *     not from DOM order — a flex `order`/`row-reverse` could satisfy source
 *     order while rendering the pair backwards).
 *   - Both toggles carry a visible border, so they read as a distinct pair of
 *     layout controls against the toolbar's otherwise borderless buttons.
 *   - The label tracks the panel's ACTUAL state, not the button's own idea of
 *     it. There are three ways to toggle the viewport (button, `\`, menu), so
 *     the test drives all three and asserts the label after each — a
 *     button-local boolean would pass the click case and desync on the other
 *     two.
 *   - Toggling from the button leaves the info panel's width alone (the
 *     independence guarantee from the same PR), so the new entry point does
 *     not reintroduce the width handoff that caused the original bug.
 *
 * Run: node toolbar-3d-toggle-button.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8121);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A calibrated session, so the 3D viewport really initializes (a WebGL
    // context, a render loop) and "collapse" has something to actually stop.
    // Without calibration `sessionHasCalibration()` is false, the viewport
    // never comes up, and every assertion below would pass for the wrong
    // reason.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = [
            new Camera('cam1', K, [0, 0, 0, 0, 0], [0.01, 0.02, 0.03], [0, 0, 500], [512, 512]),
            new Camera('cam2', K, [0, 0, 0, 0, 0], [0.04, 0.05, 0.06], [100, 0, 500], [512, 512]),
        ];
        const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['mouseA'], 'BtnTest');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(1, 0);
        g.addInstance('cam1', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
        g.addInstance('cam2', new Instance([[12, 22], [32, 42]], 0, 'user', 1));
        for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
        g.points3d = new Float64Array([0, 0, 10, 0, 0, 20]);
        g.reprojections = { cam1: [[10, 20], [30, 40]], cam2: [[12, 22], [32, 42]] };
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;

        const init = await import('/pose/initialization.js');
        init.setup3DViewport();
    });
    await page.waitForTimeout(500);

    const snap = () => page.evaluate(() => {
        const b3 = document.getElementById('viewport3dToggleBtn');
        const bi = document.getElementById('infoPanelToggleBtn');
        const vp = document.getElementById('viewport3dContainer');
        const wrap = document.getElementById('infoPanelWrapper');
        if (!b3 || !bi) return { missing: true, has3dBtn: !!b3, hasInfoBtn: !!bi };
        const r3 = b3.getBoundingClientRect();
        const ri = bi.getBoundingClientRect();
        const cs3 = getComputedStyle(b3);
        const csi = getComputedStyle(bi);
        return {
            missing: false,
            label3d: b3.textContent.trim(),
            labelInfo: bi.textContent.trim(),
            // Geometry, not DOM order.
            btn3dRight: r3.right,
            btnInfoLeft: ri.left,
            sameRow: Math.abs(r3.top - ri.top) < 2,
            border3d: cs3.borderTopWidth + ' ' + cs3.borderTopStyle + ' ' + cs3.borderTopColor,
            borderInfo: csi.borderTopWidth + ' ' + csi.borderTopStyle + ' ' + csi.borderTopColor,
            border3dPx: parseFloat(cs3.borderTopWidth),
            borderInfoPx: parseFloat(csi.borderTopWidth),
            border3dStyle: cs3.borderTopStyle,
            // A border must not silently eat the shared toolbar button height.
            btn3dHeight: Math.round(r3.height),
            btnInfoHeight: Math.round(ri.height),
            vp3dCollapsed: vp.classList.contains('collapsed'),
            vp3dWidth: vp.getBoundingClientRect().width,
            infoWidth: wrap.getBoundingClientRect().width,
            // Button widths, to catch the label swap resizing the button.
            btn3dWidth: r3.width,
            btnInfoWidth: ri.width,
            btn3dLeft: r3.left,
            btnInfoRight: ri.right,
            // Gap from the right-hand button to the window edge, and whether
            // tightening it pushed anything out of the toolbar.
            gapToEdge: window.innerWidth - ri.right,
            toolbarScrollOverflow:
                document.querySelector('.toolbar').scrollWidth
                - document.querySelector('.toolbar').clientWidth,
        };
    });

    // ---------------- 1. The button exists, where the issue asked ----------
    const s0 = await snap();
    check(!s0.missing, `both toolbar toggles exist (3D=${s0.has3dBtn !== false}, info=${s0.hasInfoBtn !== false})`);
    if (s0.missing) throw new Error('toolbar toggle button(s) missing — nothing further to assert');

    check(s0.btn3dRight <= s0.btnInfoLeft,
        `3D toggle renders to the LEFT of the info-panel toggle (3D right edge ${Math.round(s0.btn3dRight)} <= info left edge ${Math.round(s0.btnInfoLeft)})`);
    check(s0.sameRow, 'the two toggles sit on the same toolbar row');
    check(s0.btnInfoLeft - s0.btn3dRight < 24,
        `they are adjacent, not merely both right-aligned (gap ${Math.round(s0.btnInfoLeft - s0.btn3dRight)}px < 24px)`);

    // Pushed hard against the window edge: the shared `.toolbar-group` right
    // padding is dropped and the group pulls into `.toolbar`'s own padding,
    // so the gutter is a few px rather than the stacked 16px.
    check(s0.gapToEdge <= 6,
        `the pair sits flush to the right edge (${s0.gapToEdge}px gutter <= 6px)`);
    check(s0.toolbarScrollOverflow <= 0,
        `tightening the gutter did not overflow the toolbar (scroll overflow ${s0.toolbarScrollOverflow}px)`);

    // ---------------- 2. Light borders, per the request -------------------
    console.log('    3D border:', s0.border3d, '| info border:', s0.borderInfo);
    check(s0.border3dPx >= 1 && s0.border3dStyle !== 'none',
        `3D toggle has a visible border (${s0.border3d})`);
    check(s0.borderInfoPx >= 1,
        `info-panel toggle has a matching visible border (${s0.borderInfo})`);
    check(s0.btn3dHeight === s0.btnInfoHeight && s0.btn3dHeight === 28,
        `the border does not change the 28px toolbar button height (3D=${s0.btn3dHeight}, info=${s0.btnInfoHeight})`);

    // ---------------- 3. Clicking toggles, and relabels -------------------
    check(s0.label3d === 'Hide 3D View', `label starts as "Hide 3D View" while the viewer is shown (got "${s0.label3d}")`);
    check(s0.vp3dCollapsed === false, 'viewport starts expanded');

    await page.click('#viewport3dToggleBtn');
    await page.waitForTimeout(350);
    const s1 = await snap();
    check(s1.vp3dCollapsed === true, 'clicking the button collapses the 3D viewport');
    check(s1.vp3dWidth === 0, `collapsed viewport has zero width (got ${s1.vp3dWidth}) — not merely hidden behind another panel`);
    check(s1.label3d === 'Show 3D View', `label flips to "Show 3D View" (got "${s1.label3d}")`);
    check(Math.abs(s1.infoWidth - s0.infoWidth) < 1,
        `the info panel keeps its width when the 3D viewer is hidden from the button (${s0.infoWidth} -> ${s1.infoWidth})`);

    await page.click('#viewport3dToggleBtn');
    await page.waitForTimeout(350);
    const s2 = await snap();
    check(s2.vp3dCollapsed === false, 'clicking again re-expands the 3D viewport');
    check(s2.label3d === 'Hide 3D View', `label flips back to "Hide 3D View" (got "${s2.label3d}")`);
    check(Math.abs(s2.vp3dWidth - s0.vp3dWidth) < 2,
        `the viewport comes back at its original width (${s0.vp3dWidth} -> ${s2.vp3dWidth})`);

    // ---------------- 4. The label follows the OTHER two entry points -----
    // A button-local boolean would pass section 3 and desync here.
    await page.keyboard.press('Backslash');
    await page.waitForTimeout(350);
    const s3 = await snap();
    check(s3.vp3dCollapsed === true, 'the `\\` shortcut still collapses the viewport');
    check(s3.label3d === 'Show 3D View',
        `the button label follows a collapse done via \`\\\` (got "${s3.label3d}")`);

    // The dropdown only renders once its parent menu is open.
    await page.click('.menu-item[data-menu="view"]');
    await page.waitForTimeout(150);
    await page.click('#menuToggle3D');
    await page.waitForTimeout(350);
    const s4 = await snap();
    check(s4.vp3dCollapsed === false, 'View ▸ Toggle 3D Viewport still expands the viewport');
    check(s4.label3d === 'Hide 3D View',
        `the button label follows an expand done from the View menu (got "${s4.label3d}")`);

    // Toggle the INFO panel too, so its button is sampled in both of its own
    // label states — otherwise its width check below never varies the label
    // and passes for free.
    await page.click('#infoPanelToggleBtn');
    await page.waitForTimeout(350);
    const s5 = await snap();
    check(s5.labelInfo === 'Show Panel', `info-panel button relabels to "Show Panel" (got "${s5.labelInfo}")`);
    await page.click('#infoPanelToggleBtn');
    await page.waitForTimeout(350);
    const s6 = await snap();
    check(s6.labelInfo === 'Hide Panel', `and back to "Hide Panel" (got "${s6.labelInfo}")`);

    // ---------------- 5. No shimmy: the label swap must not resize --------
    // "Hide" and "Show" are different widths in a proportional font, so an
    // unpinned button resizes on every toggle — and because the pair is
    // right-aligned, a width change on the info button also shoves the 3D
    // button sideways. Each button is pinned to its own widest label, so
    // every state below must agree to the pixel.
    const all = [s0, s1, s2, s3, s4, s5, s6];
    const widths3d = all.map(s => s.btn3dWidth);
    const widthsInfo = all.map(s => s.btnInfoWidth);
    const lefts3d = all.map(s => s.btn3dLeft);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    console.log('    3D widths:', widths3d.map(w => w.toFixed(2)).join(' '),
        '| info widths:', widthsInfo.map(w => w.toFixed(2)).join(' '));
    // Both labels are covered on both buttons: 3D "Hide" at s0/s2/s4/s5/s6
    // and "Show" at s1/s3; info "Hide" everywhere except s5, "Show" at s5.
    check(spread(widths3d) < 0.5,
        `the 3D toggle keeps one width across Hide/Show (spread ${spread(widths3d).toFixed(2)}px)`);
    check(spread(widthsInfo) < 0.5,
        `the info-panel toggle keeps one width across Hide/Show (spread ${spread(widthsInfo).toFixed(2)}px)`);
    check(spread(lefts3d) < 0.5,
        `the 3D toggle never shifts position (left-edge spread ${spread(lefts3d).toFixed(2)}px)`);

    // The pin must be the WIDER label, not a truncation of it: a button
    // clamped to the narrower "Hide" width would still have a stable width
    // and pass the checks above while clipping "Show 3D View".
    const fit = await page.evaluate(() => {
        const out = {};
        for (const id of ['viewport3dToggleBtn', 'infoPanelToggleBtn']) {
            const b = document.getElementById(id);
            // scrollWidth > clientWidth means the text is being clipped.
            out[id] = { scroll: b.scrollWidth, client: b.clientWidth, text: b.textContent.trim() };
        }
        return out;
    });
    for (const [id, m] of Object.entries(fit)) {
        check(m.scroll <= m.client + 1,
            `${id} shows "${m.text}" without clipping it (scrollWidth ${m.scroll} <= clientWidth ${m.client})`);
    }

    // ---------------- 6. No collateral damage ----------------------------
    check(s4.labelInfo === 'Hide Panel',
        `the info-panel button label is untouched throughout (got "${s4.labelInfo}")`);
    check(errs.length === 0, `no page errors (${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''})`);

} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS — toolbar 3D toggle button (issue #151)');
process.exit(fails ? 1 : 0);
