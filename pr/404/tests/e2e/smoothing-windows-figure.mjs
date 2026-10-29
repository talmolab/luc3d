/**
 * smoothing-windows-figure.mjs — Settings ▸ Temporal Smoothing shows what the
 * Median and Gaussian windows do, and the sketches follow the typed windows
 * (ui/smoothing-windows-figure.js).
 *
 * Asserted, in the real Settings ▸ Temporal Smoothing:
 *  1. Two cards (median, Gaussian), each with a chart; with both windows off
 *     (the default) each is labelled as an example.
 *  2. Typing a median window relabels its card and widens its shaded window;
 *     the blue line drops the spike (its point at the spike frame sits well
 *     below the red dot).
 *  3. Median off + Gaussian on feeds the Gaussian the raw 3D: the card says the
 *     spike becomes a bump; turning the median on hides that note again.
 *  4. Each card's Window slider (down to 1 frame) sets the stage's window and the matching field,
 *     and Apply stores it; the Frame slider moves the shaded window and fades
 *     the output after that frame; ▶ slides the window forward and pauses.
 *
 * Run: node tests/e2e/smoothing-windows-figure.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8283);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(() => { document.getElementById('menuSettings').click(); document.querySelector('.settings-nav-item[data-panel="smoothing"]').click(); });

    const type = (label, v) => page.evaluate(([l, val]) => {
        const i = document.querySelector(`.settings-panel[data-panel="smoothing"] input[aria-label="${l}"]`);
        i.value = String(val); i.dispatchEvent(new Event('input'));
    }, [label, v]);
    const read = () => page.evaluate(() => {
        const card = (s) => document.querySelector(`.smooth-fig [data-stage="${s}"]`);
        const med = card('median'), gau = card('gaussian');
        // The median line's point at the spike frame vs the spike dot.
        const spike = med && med.querySelector('circle.sf-spike');
        const line = med && med.querySelector('path.sf-out');
        let gap = null;
        if (spike && line) {
            const x = +spike.getAttribute('cx');
            const pts = line.getAttribute('d').slice(1).split('L').map(p => p.trim().split(' ').map(Number));
            const at = pts.reduce((b, p) => Math.abs(p[0] - x) < Math.abs(b[0] - x) ? p : b);
            gap = at[1] - +spike.getAttribute('cy');
        }
        return {
            cards: !!med && !!gau,
            charts: document.querySelectorAll('.smooth-fig svg').length,
            medTag: med && med.querySelector('small').textContent,
            gauTag: gau && gau.querySelector('small').textContent,
            medBand: med && +med.querySelector('rect.sf-band').getAttribute('width'),
            gap,
            warn: gau && !gau.querySelector('.smooth-fig-warn').hidden,
        };
    });

    console.log('1. defaults');
    const d = await read();
    check(d.cards && d.charts === 2, 'two cards with a chart each');
    check(/example with 5 frames/.test(d.medTag) && /example with 9 frames/.test(d.gauTag), `both labelled as examples (${d.medTag} | ${d.gauTag})`);
    check(!d.warn, 'no spike note with both off');

    console.log('2. median window typed');
    await type('Median window (frames)', 9);
    const m = await read();
    check(m.medTag === '9 frames', `median card relabelled (${m.medTag})`);
    check(m.medBand > d.medBand * 1.5, `shaded window widened (${d.medBand} → ${m.medBand})`);
    check(m.gap > 20, `line drops the spike (${m.gap && m.gap.toFixed(1)} px below it)`);

    console.log('3. Gaussian without the median');
    await type('Median window (frames)', 0);
    await type('Gaussian window (frames)', 15);
    const g = await read();
    check(g.gauTag === '15 frames', `Gaussian card relabelled (${g.gauTag})`);
    check(g.warn, 'note: the spike spreads into a bump');
    await type('Median window (frames)', 5);
    check(!(await read()).warn, 'note hidden once the median is on');

    console.log('4. sliders');
    const sl = await page.evaluate(async () => {
        const card = (s) => document.querySelector(`.smooth-fig [data-stage="${s}"]`);
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const field = (l) => document.querySelector(`.settings-panel[data-panel="smoothing"] input[aria-label="${l}"]`);
        const out = {};
        set(card('median').querySelector('.sf-size'), 1);
        out.oneTag = card('median').querySelector('small').textContent;
        out.oneField = field('Median window (frames)').value;
        set(card('gaussian').querySelector('.sf-size'), 11);
        out.gauField = field('Gaussian window (frames)').value;
        out.gauTag = card('gaussian').querySelector('small').textContent;
        const bandX = () => +card('median').querySelector('rect.sf-band').getAttribute('x');
        const x0 = bandX();
        set(card('median').querySelector('.sf-pos'), 30);
        out.bandMoved = bandX() > x0 + 50;
        out.faded = card('median').querySelectorAll('.sf-ahead').length;
        out.posLabel = card('median').querySelector('.sf-pos-val').textContent;
        const play = card('gaussian').querySelector('.sf-play');
        play.click();
        await new Promise(r => setTimeout(r, 500));
        out.playing = play.getAttribute('aria-pressed');
        play.click();
        const p1 = +card('gaussian').querySelector('.sf-pos').value;
        await new Promise(r => setTimeout(r, 300));
        out.advanced = p1 > 0;
        out.paused = +card('gaussian').querySelector('.sf-pos').value === p1;
        document.querySelector('.settings-btn-apply').click();
        const S = await import('/ui/settings.js');
        out.stored = S.getSmoothingParam('smoothGaussianWindow');
        return out;
    });
    check(sl.oneTag === '1 frame · no smoothing' && sl.oneField === '1', `Window slider goes down to 1 frame (${sl.oneTag}, field ${sl.oneField})`);
    check(sl.gauField === '11' && sl.gauTag === '11 frames', `Window slider sets the field and the stage (${sl.gauField}, ${sl.gauTag})`);
    check(sl.bandMoved, 'Frame slider moves the shaded window');
    check(sl.faded > 0 && sl.posLabel === '31 / 40', `output after the frame faded (${sl.faded} marks, ${sl.posLabel})`);
    check(sl.playing === 'true' && sl.advanced && sl.paused, 'play slides the window forward, a second click pauses it');
    check(sl.stored === 11, `Apply stores the slider's window (${sl.stored})`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
