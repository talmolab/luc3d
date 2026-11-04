/**
 * desktop-dialogs.mjs — app questions go through ui/ask.js, so they work in
 * the macOS desktop app (WKWebView: `confirm()` returns false and `prompt()`
 * null at once, showing nothing) AND stay the native dialogs in a browser.
 *
 * Asserted:
 *  A. Desktop (`window.lucidDesktop = {isDesktop, confirm: mock}` installed
 *     before the app loads, as the shim does):
 *     1. File ▸ New Project with a session open asks `lucidDesktop.confirm`
 *        (same message, a title) and never a native dialog; answering false
 *        keeps the session, true resets the project.
 *     2. Deleting a session (Sessions ▸ remove button, and `removeSession`)
 *        asks `lucidDesktop.confirm`; false keeps it, true removes it.
 *     3. Track ▸ Swap Tracks shows the in-app text modal: Enter submits (the
 *        frame prompts' defaults are pre-selected), the four answers swap the
 *        tracks; Esc cancels with nothing changed; each modal removes its key
 *        listener on close.
 *     4. A shim without `confirm` falls back to the in-app modal (Esc = false).
 *  B. Browser (no lucidDesktop): Playwright sees the SAME native confirm /
 *     prompt texts as before, and accept / dismiss act as before.
 *
 * Run: node tests/e2e/desktop-dialogs.mjs   (spawns its own http.server;
 * PORT= to move it, default 9531)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9531);
const URL = `http://localhost:${PORT}/index.html`;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const NEW_PROJECT_MSG = 'Unsaved changes will be lost. Start a new project?';

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** Installed before any app script: the desktop shim's confirm, mocked, plus a
 *  count of document keydown listeners so a leak shows. */
function desktopInit() {
    window.__confirmCalls = [];
    window.__confirmAnswer = false;
    window.lucidDesktop = {
        isDesktop: true,
        fsaWriteOnly: false,
        confirm: function (message, opts) {
            window.__confirmCalls.push({ message: String(message), opts: opts || null });
            return new Promise(r => setTimeout(() => r(window.__confirmAnswer), 30));   // async, like IPC
        },
    };
    window.__keydownNet = 0;
    const add = Document.prototype.addEventListener, rem = Document.prototype.removeEventListener;
    Document.prototype.addEventListener = function (t, f, o) { if (t === 'keydown') window.__keydownNet++; return add.call(this, t, f, o); };
    Document.prototype.removeEventListener = function (t, f, o) { if (t === 'keydown') window.__keydownNet--; return rem.call(this, t, f, o); };
}

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => { await (await import('./pose/initialization.js')).loadDemoSession(); });
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.views.length > 0, null, { timeout: 60000 });
    // A second track (Swap Tracks needs two) and a second session (Delete).
    await page.evaluate(async () => {
        const { state } = window.__lucid;
        const pd = await import('./pose/pose-data.js');
        if (state.session.tracks.length < 2) state.session.tracks.push('mouse_1');
        const s0 = state.session;
        s0._views = state.views;
        state.sessions.push(new pd.Session(s0.cameras, s0.skeleton, ['track_0'], 'S2'));
    });
}

const snap = (page) => page.evaluate(() => {
    const { state } = window.__lucid;
    return {
        session: !!state.session,
        views: state.views.length,
        sessions: state.sessions.map(s => s.name),
        status: document.getElementById('statusText').textContent,
        askModals: document.querySelectorAll('.ask-modal').length,
    };
});
const tick = (page, ms = 120) => page.waitForTimeout(ms);
const clickMenu = (page, id) => page.evaluate((id) => document.getElementById(id).click(), id);

/** Track of every instance, as one string, to see a swap. */
const trackSig = (page) => page.evaluate(() => {
    const s = window.__lucid.state.session; const out = [];
    for (const [f, fg] of s.frameGroups) {
        for (const [cam, insts] of fg.instances) for (const i of insts) out.push(i.trackIdx);
        if (fg.unlinkedInstances) for (const [cam, ul] of fg.unlinkedInstances) for (const u of ul) out.push(u.instance.trackIdx);
    }
    return out.join(',');
});

let browser;
try {
    browser = await chromium.launch();

    // ───────────────────────────── A. desktop ─────────────────────────────
    console.log('A. Desktop (lucidDesktop.confirm mocked)');
    {
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
        await ctx.addInitScript(desktopInit);
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
        const native = [];
        page.on('dialog', d => { native.push(d.type() + ': ' + d.message()); d.dismiss(); });
        await boot(page);

        console.log(' 1. New Project');
        await page.evaluate(() => { window.__confirmCalls = []; window.__confirmAnswer = false; });
        await clickMenu(page, 'menuNewProject');
        let calls = await page.evaluate(() => window.__confirmCalls);
        check(calls.length === 1 && calls[0].message === NEW_PROJECT_MSG,
            `asks lucidDesktop.confirm with the same text (${JSON.stringify(calls)})`);
        check(calls[0] && calls[0].opts && calls[0].opts.title === 'New Project', 'passes a title');
        await tick(page);
        let s = await snap(page);
        check(s.session && s.views > 0, `answer false keeps the project (session ${s.session}, ${s.views} views)`);
        // (answer true — the reset — comes in 4, last: the other checks need the session)

        console.log(' 2. Delete session');
        await page.evaluate(() => { window.__confirmCalls = []; window.__confirmAnswer = false; });
        await page.evaluate(() => document.getElementById('btnRemoveSession').click());
        await tick(page);
        calls = await page.evaluate(() => window.__confirmCalls);
        s = await snap(page);
        check(calls.length === 1 && /^Delete session ".*"\?$/.test(calls[0].message),
            `the remove button asks lucidDesktop.confirm (${JSON.stringify(calls.map(c => c.message))})`);
        check(s.sessions.length === 2 && s.session, `answer false keeps both sessions (${s.sessions})`);
        await page.evaluate(() => { window.__confirmCalls = []; window.__confirmAnswer = true; });
        const removed = await page.evaluate(async () => (await import('./ui/sessions-panes.js')).removeSession(1));
        calls = await page.evaluate(() => window.__confirmCalls);
        s = await snap(page);
        check(calls.length === 1 && calls[0].message === 'Delete session "S2"?', `removeSession(1) asks about S2 (${calls.map(c => c.message)})`);
        check(removed !== false && s.sessions.length === 1 && s.session, `answer true removes it (${s.sessions})`);

        console.log(' 3. Swap Tracks (in-app text modal)');
        const before = await trackSig(page);
        const net0 = await page.evaluate(() => window.__keydownNet);
        await clickMenu(page, 'menuSwapTracks');
        await page.waitForSelector('.ask-modal', { timeout: 3000 });
        let m = await page.evaluate(() => {
            const el = document.querySelector('.ask-modal');
            const inp = el.querySelector('input');
            return { msg: el.querySelector('.ask-modal-message').textContent, value: inp.value,
                focused: document.activeElement === inp, title: (el.querySelector('h3') || {}).textContent };
        });
        check(/^Swap track A\?\n\n1\. mouse_0\n2\. mouse_1\n\nEnter number:$/.test(m.msg), `first question, line breaks kept (${JSON.stringify(m.msg)})`);
        check(m.value === '' && m.focused, `empty field, focused (${JSON.stringify(m.value)}, focused ${m.focused})`);
        check(m.title === 'Swap Tracks', `titled (${m.title})`);
        check(native.length === 0, `no native dialog (${native.join(' | ') || 'none'})`);
        await page.keyboard.type('1'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => /Swap with track B/.test((document.querySelector('.ask-modal-message') || {}).textContent || ''));
        await page.keyboard.type('2'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => /Start frame/.test((document.querySelector('.ask-modal-message') || {}).textContent || ''));
        m = await page.evaluate(() => {
            const inp = document.querySelector('.ask-modal input');
            return { value: inp.value, selected: inp.selectionStart === 0 && inp.selectionEnd === inp.value.length,
                expect: String(window.__lucid.state.currentFrame + 1) };
        });
        check(m.value === m.expect && m.selected, `start-frame default ${m.value} (want ${m.expect}), selected ${m.selected}`);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => /End frame/.test((document.querySelector('.ask-modal-message') || {}).textContent || ''));
        m = await page.evaluate(() => document.querySelector('.ask-modal input').value);
        check(m === '0', `end-frame default 0 (${m})`);
        await page.keyboard.press('Enter');
        await tick(page);
        s = await snap(page);
        const after = await trackSig(page);
        check(s.askModals === 0, 'the modal is gone');
        check(/^Swapped mouse_0 ↔ mouse_1/.test(s.status), `the swap ran ("${s.status}")`);
        check(before.length > 0 && after !== before && after.length === before.length, 'instance tracks changed');
        check(await page.evaluate(() => window.__keydownNet) === net0, 'every key listener removed on close');

        // Esc cancels, at the first and at a later question.
        await page.evaluate(() => { document.getElementById('statusText').textContent = 'marker'; });
        await clickMenu(page, 'menuSwapTracks');
        await page.waitForSelector('.ask-modal');
        await page.keyboard.press('Escape');
        await tick(page);
        s = await snap(page);
        check(s.askModals === 0 && s.status === 'marker', `Esc on the first question cancels (status "${s.status}")`);
        await clickMenu(page, 'menuSwapTracks');
        await page.waitForSelector('.ask-modal');
        await page.keyboard.type('2'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => /Swap with track B/.test((document.querySelector('.ask-modal-message') || {}).textContent || ''));
        await page.keyboard.press('Escape');
        await tick(page);
        s = await snap(page);
        check(s.askModals === 0 && s.status === 'marker' && (await trackSig(page)) === after,
            `Esc on a later question cancels with nothing swapped (status "${s.status}")`);
        // The Cancel button too.
        await clickMenu(page, 'menuSwapTracks');
        await page.waitForSelector('.ask-modal');
        await page.click('.ask-modal .ask-modal-cancel');
        await tick(page);
        s = await snap(page);
        check(s.askModals === 0 && s.status === 'marker', 'Cancel button cancels');
        check(await page.evaluate(() => window.__keydownNet) === net0, 'no key listener left behind after Esc / Cancel');

        console.log(' 4. Fallbacks, then New Project = yes');
        const fb = await page.evaluate(async () => {
            const ask = await import('./ui/ask.js');
            const saved = window.lucidDesktop.confirm;
            delete window.lucidDesktop.confirm;
            const p = ask.askConfirm('Fallback?', { okLabel: 'Go' });
            await new Promise(r => setTimeout(r, 30));
            const shown = document.querySelector('.ask-modal');
            const info = { shown: !!shown, ok: shown && shown.querySelector('.ask-modal-ok').textContent,
                hasInput: !!(shown && shown.querySelector('input')) };
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            info.answer = await p;
            const p2 = ask.askConfirm('Fallback 2?');
            await new Promise(r => setTimeout(r, 30));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            info.answer2 = await p2;
            window.lucidDesktop.confirm = function () { return Promise.reject(new Error('ipc down')); };
            const p3 = ask.askConfirm('Fallback 3?');
            await new Promise(r => setTimeout(r, 30));
            info.shown3 = !!document.querySelector('.ask-modal');
            document.querySelector('.ask-modal .ask-modal-ok').click();
            info.answer3 = await p3;
            window.lucidDesktop.confirm = saved;
            const p4 = ask.askAlert('Note');
            await new Promise(r => setTimeout(r, 30));
            const al = document.querySelector('.ask-modal');
            info.alertButtons = al ? al.querySelectorAll('button').length : -1;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await p4;
            info.left = document.querySelectorAll('.ask-modal').length;
            return info;
        });
        check(fb.shown && fb.ok === 'Go' && !fb.hasInput, `a shim without confirm asks in-app (${JSON.stringify(fb)})`);
        check(fb.answer === false && fb.answer2 === true, 'in-app confirm: Esc → false, Enter → true');
        check(fb.shown3 && fb.answer3 === true, 'a failed native confirm falls back to in-app');
        check(fb.alertButtons === 1 && fb.left === 0, 'askAlert: one OK button, closes');

        await page.evaluate(() => { window.__confirmCalls = []; window.__confirmAnswer = true; });
        await clickMenu(page, 'menuNewProject');
        await tick(page);
        calls = await page.evaluate(() => window.__confirmCalls);
        s = await snap(page);
        check(calls.length === 1 && !s.session && s.views === 0, `answer true resets the project (session ${s.session}, ${s.views} views)`);
        check(native.length === 0, `no native dialog in the whole desktop run (${native.join(' | ') || 'none'})`);
        check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
        await ctx.close();
    }

    // ───────────────────────────── B. browser ─────────────────────────────
    console.log('B. Browser (no lucidDesktop): native dialogs, unchanged');
    {
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
        const seen = [];
        let answer = (d) => d.dismiss();
        page.on('dialog', d => { seen.push({ type: d.type(), message: d.message(), def: d.defaultValue() }); answer(d); });
        await boot(page);
        check(await page.evaluate(() => !window.lucidDesktop), 'no lucidDesktop');

        console.log(' 1. New Project');
        answer = (d) => d.dismiss();
        await clickMenu(page, 'menuNewProject');
        await tick(page);
        let s = await snap(page);
        check(seen.length === 1 && seen[0].type === 'confirm' && seen[0].message === NEW_PROJECT_MSG,
            `native confirm, same text (${JSON.stringify(seen)})`);
        check(s.session && s.views > 0, 'dismiss keeps the project');

        console.log(' 2. Delete session');
        seen.length = 0;
        answer = (d) => d.dismiss();
        await page.evaluate(async () => (await import('./ui/sessions-panes.js')).removeSession(1));
        s = await snap(page);
        check(seen.length === 1 && seen[0].type === 'confirm' && seen[0].message === 'Delete session "S2"?',
            `native confirm, same text (${JSON.stringify(seen)})`);
        check(s.sessions.length === 2, 'dismiss keeps it');
        seen.length = 0;
        answer = (d) => d.accept();
        await page.evaluate(async () => (await import('./ui/sessions-panes.js')).removeSession(1));
        s = await snap(page);
        check(seen.length === 1 && s.sessions.length === 1, `accept removes it (${s.sessions})`);

        console.log(' 3. Swap Tracks');
        seen.length = 0;
        // null = accept the default (Playwright's bare accept() answers "", so pass it)
        const replies = ['1', '2', null, null];
        answer = (d) => { const r = replies.shift(); return d.accept(r == null ? d.defaultValue() : r); };
        const before = await trackSig(page);
        await clickMenu(page, 'menuSwapTracks');
        await tick(page);
        s = await snap(page);
        const cf = await page.evaluate(() => window.__lucid.state.currentFrame);
        check(seen.length === 4 && seen.every(d => d.type === 'prompt'), `four native prompts (${seen.map(d => d.type)})`);
        check(seen[0] && seen[0].message === 'Swap track A?\n\n1. mouse_0\n2. mouse_1\n\nEnter number:' && seen[0].def === '',
            `prompt 1 text unchanged (${JSON.stringify(seen[0])})`);
        check(seen[1] && seen[1].message.startsWith('Swap with track B?') && seen[1].def === '', 'prompt 2 text unchanged');
        check(seen[2] && seen[2].message === 'Start frame (1-indexed):' && seen[2].def === String(cf + 1), `prompt 3 default ${seen[2] && seen[2].def}`);
        check(seen[3] && seen[3].message === 'End frame (1-indexed, or 0 for all):' && seen[3].def === '0', 'prompt 4 default 0');
        check(/^Swapped mouse_0 ↔ mouse_1/.test(s.status) && (await trackSig(page)) !== before, `the swap ran ("${s.status}")`);
        seen.length = 0;
        answer = (d) => d.dismiss();
        await page.evaluate(() => { document.getElementById('statusText').textContent = 'marker'; });
        await clickMenu(page, 'menuSwapTracks');
        await tick(page);
        s = await snap(page);
        check(seen.length === 1 && s.status === 'marker', 'dismissing the first prompt cancels');
        check(s.askModals === 0, 'no in-app modal in a browser');

        console.log(' 4. New Project accept');
        seen.length = 0;
        answer = (d) => d.accept();
        await clickMenu(page, 'menuNewProject');
        await tick(page);
        s = await snap(page);
        check(seen.length === 1 && !s.session && s.views === 0, 'accept resets the project');
        check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
        await ctx.close();
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
