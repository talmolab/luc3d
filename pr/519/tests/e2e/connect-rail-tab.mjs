/**
 * connect-rail-tab.mjs — the Connect panel on the right-edge rail (web app).
 *
 *  1. The rail has a Connect button (Lucide globe) with its panel section.
 *  2. Clicking it opens the panel; the empty state is sleap-app's: the
 *     "Open Connect window" button, no worker list, the pairing form
 *     ("Pair with a worker", `sleap1…` box, no Cancel), and, once the device
 *     key exists, "This device: <id>…".
 *  3. The form's help line names `sleap-connect serve` / `sleap-connect pair`;
 *     the Pair button starts disabled; Advanced shows the address box.
 *  4. Open Connect window (no window yet) brings the panel to the front;
 *     `setConnectWindowOpener(fn)` makes it call `fn` instead.
 *  5. Toasts (sonner as sleap-app configures it): success/error/info stack
 *     bottom-right (offset 56px) with a per-kind icon, a repeated id replaces,
 *     the action runs its handler and the toast has no Copy (one without an
 *     action has a copy icon), the close x sits top-left, text is selectable,
 *     only 3 show (the older one collapses and comes back), hovering pauses
 *     all, "Clear all (n)" appears at 2+.
 *
 * Usage: node tests/e2e/connect-rail-tab.mjs   (PORT= to move its server)
 */
import { runConnectE2E, check, watchPage, bootApp } from './fixtures/connect-e2e.mjs';

await runConnectE2E(9391, async ({ browser, BASE }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watchPage(page);
    await bootApp(page, BASE);

    console.log('\n--- 1. The rail button ---');
    const btn = await page.evaluate(() => {
        const b = document.querySelector('.panel-rail-btn[data-tab="tabConnect"]');
        return { label: b.getAttribute('aria-label'), svg: !!b.querySelector('svg'),
            circle: !!b.querySelector('svg circle'), section: !!document.querySelector('.panel-section[data-tab="tabConnect"]') };
    });
    check(btn.label === 'Connect' && btn.svg && btn.circle, 'a Connect button with the globe icon', btn);
    check(btn.section, 'and a panel section for it');

    console.log('\n--- 2. Opening it: the empty state ---');
    await page.click('.panel-rail-btn[data-tab="tabConnect"]');
    await page.waitForSelector('[data-pf="pair"]', { state: 'visible', timeout: 5000 });
    const s = await page.evaluate(() => ({
        open: document.getElementById('connectOpenWindow').textContent.trim(),
        workersHidden: document.getElementById('connectWorkers').hidden,
        err: document.getElementById('connectError').hidden,
        title: document.querySelector('.connect-pair-form .connect-card-title').textContent,
        placeholder: document.querySelector('[data-pf="code"]').placeholder,
        cancelHidden: document.querySelector('[data-pf="cancel"]').hidden,
        newBtn: !!document.getElementById('connectPairNew') && !!document.getElementById('connectPairNew').offsetParent,
        pairDisabled: document.querySelector('[data-pf="pair"]').disabled,
        pairText: document.querySelector('[data-pf="pair"]').textContent.trim(),
        scrollers: [...document.querySelectorAll('.connect-panel, .connect-panel *')]
            .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length,
    }));
    check(s.open === 'Open Connect window', 'Open Connect window button', s.open);
    check(s.workersHidden && s.err, 'no worker list, no error box');
    check(s.title === 'Pair with a worker', 'the pairing form is showing', s.title);
    check(s.placeholder === 'sleap1…', 'placeholder sleap1…', s.placeholder);
    check(s.cancelHidden, 'no Cancel while nothing is paired');
    check(!s.newBtn, 'and no "Pair a new worker" button behind it');
    check(s.pairDisabled && s.pairText === 'Pair', 'Pair is disabled', s);
    check(s.scrollers === 0, 'no inner scroller in the panel', s.scrollers);
    await page.waitForFunction(() => /^This device: .{16}…$/.test(document.getElementById('connectDevice').textContent), null, { timeout: 5000 })
        .then(() => check(true, 'This device: <16 chars>… shows once the key exists'),
              () => check(false, 'This device line', null));

    console.log('\n--- 3. Form text ---');
    const help = await page.evaluate(() => document.querySelector('.connect-pair-form .connect-hint').textContent);
    check(help === 'Paste the code sleap-connect serve printed on the worker, or get a new one there with sleap-connect pair.', 'help line', help);
    check(await page.evaluate(() => document.querySelector('[data-pf="address"]').offsetParent === null), 'address box hidden under Advanced');
    await page.click('[data-pf="advanced"]');
    check(await page.evaluate(() => document.querySelector('[data-pf="address"]').offsetParent !== null), 'Advanced: connect by address shows it');
    check(await page.evaluate(() => document.querySelector('[data-pf="address"]').placeholder) === 'ws://192.168.1.42:9631', 'with its placeholder');

    console.log('\n--- 4. Open Connect window (default opener: the panel; the window itself is connect-window.mjs) ---');
    await page.click('.panel-rail-btn[data-tab="tabConnect"]');   // fold the section
    check(await page.evaluate(() => document.querySelector('[data-pf="pair"]').offsetParent === null), 'the folded panel shows nothing');
    // `setupConnect` installs the lazy Connect window opener; with none set the button only fronts the panel.
    await page.evaluate(async () => { (await import('./ui/connect/index.js')).setConnectWindowOpener(null); });
    await page.evaluate(() => document.getElementById('connectOpenWindow').click());
    check(await page.evaluate(() => document.querySelector('[data-pf="pair"]').offsetParent !== null), 'the button brings the Connect panel to the front');
    await page.evaluate(async () => {
        const m = await import('./ui/connect/index.js');
        window.__opened = 0;
        m.setConnectWindowOpener(() => { window.__opened++; });
        document.getElementById('connectOpenWindow').click();
        m.setConnectWindowOpener(null);
    });
    check(await page.evaluate(() => window.__opened) === 1, 'setConnectWindowOpener(fn) is what the button calls');

    console.log('\n--- 5. Toasts ---');
    await page.evaluate(async () => {
        const { notify } = await import('./ui/connect/notify.js');
        window.__acted = 0;
        notify.success('Job A finished', { id: 'a', action: { label: 'Open', onClick: () => { window.__acted++; } } });
        notify.error('Job B failed', { id: 'b', description: 'boom' });
        notify.info('first', { id: 'c' });
        notify.info('second', { id: 'c' });
    });
    const t = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.connect-toast')];
        const r = document.getElementById('connectToasts').getBoundingClientRect();
        return { n: items.length, texts: items.map((e) => e.querySelector('.connect-toast-title').textContent),
            br: r.right > innerWidth - 40 && r.bottom > innerHeight - 100,
            select: getComputedStyle(items[0]).userSelect };
    });
    check(t.n === 3 && t.texts.join('|') === 'Job A finished|Job B failed|second', 'three toasts; same id replaced', t);
    check(t.br, 'bottom-right');
    check(t.select === 'text', 'text is selectable');
    const chrome = await page.evaluate(() => {
        const q = (id, sel) => document.querySelector(`.connect-toast[data-toast-id="${id}"] ${sel}`);
        const r = document.getElementById('connectToasts').getBoundingClientRect();
        const t = document.querySelector('.connect-toast[data-toast-id="b"]').getBoundingClientRect();
        const x = q('b', '.connect-toast-close').getBoundingClientRect();
        const c = q('b', '.connect-toast-copy').getBoundingClientRect();
        return { aCopy: !!q('a', '.connect-toast-copy'), bCopy: !!q('b', '.connect-toast-copy'),
            icons: ['a', 'b', 'c'].map((id) => !!q(id, '.connect-toast-kind svg')),
            offset: Math.round(innerHeight - r.bottom), closeLeft: x.left < t.left + 12 && x.top < t.top + 12,
            copyRight: c.right > t.right - 16 && c.top < t.top + 16, copyIsSvg: !!q('b', '.connect-toast-copy svg'),
            clear: document.getElementById('connectToastsClear') && document.getElementById('connectToastsClear').textContent };
    });
    check(!chrome.aCopy && chrome.bCopy, 'a toast with an action has no Copy; one without has it', chrome);
    check(chrome.icons.every(Boolean), 'each toast leads with its kind icon');
    check(chrome.offset === 56, 'offset 56px from the bottom', chrome.offset);
    check(chrome.closeLeft && chrome.copyRight && chrome.copyIsSvg, 'close x top-left, copy icon top-right', chrome);
    check(chrome.clear === 'Clear all (3)', '"Clear all (3)" under the stack', chrome.clear);
    await page.click('.connect-toast[data-toast-id="a"] .connect-toast-action');
    check(await page.evaluate(() => window.__acted) === 1 && !(await page.$('.connect-toast[data-toast-id="a"]')), 'action runs and closes the toast');
    await page.click('.connect-toast[data-toast-id="b"] .connect-toast-close');
    check(!(await page.$('.connect-toast[data-toast-id="b"]')), 'close button closes');
    await page.evaluate(async () => {
        const { notify } = await import('./ui/connect/notify.js');
        notify.info('x'); notify.info('y'); notify.info('z'); notify.info('w');
    });
    const vis = () => page.evaluate(() => [...document.querySelectorAll('.connect-toast')].filter((e) => !e.hidden).map((e) => e.querySelector('.connect-toast-title').textContent).join(''));
    check(await vis() === 'yzw' && await page.evaluate(() => document.querySelectorAll('.connect-toast').length) === 5, 'three show, the two older (c, x) are collapsed (not dropped)', await vis());
    const box = await page.evaluate(() => { const r = [...document.querySelectorAll('.connect-toast')].filter((e) => !e.hidden)[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(4600);
    check(await vis() === 'yzw', 'hovering the stack pauses every toast');
    await page.mouse.move(300, 300);
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].filter((e) => !e.hidden).map((e) => e.querySelector('.connect-toast-title').textContent).join('').includes('x'), null, { timeout: 7000 })
        .then(() => check(true, 'the collapsed toasts come back once newer ones close'), () => check(false, 'collapsed toast returns'));
    await page.waitForFunction(() => document.querySelectorAll('.connect-toast').length === 0, null, { timeout: 7000 })
        .then(() => check(true, 'all auto-dismiss after ~4 s'), () => check(false, 'auto-dismiss'));
    check(await page.evaluate(() => document.getElementById('connectToastsClear').hidden), 'the Clear all pill is gone');
    await page.evaluate(async () => { const { notify } = await import('./ui/connect/notify.js'); notify.info('p'); notify.info('q'); });
    await page.click('#connectToastsClear');
    check(await page.evaluate(() => document.querySelectorAll('.connect-toast').length) === 0, 'Clear all dismisses the stack');
});
