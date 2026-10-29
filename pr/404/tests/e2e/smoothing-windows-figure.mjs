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
 *     spikes become bumps; turning the median on hides that note again.
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
    check(g.warn, 'note: spikes spread into bumps');
    await type('Median window (frames)', 5);
    check(!(await read()).warn, 'note hidden once the median is on');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
