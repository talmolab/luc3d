/**
 * smoothing-windows-figure.mjs — Settings ▸ Temporal Smoothing shows what the
 * Median and Gaussian windows do, and the sketches follow the typed windows
 * (ui/smoothing-windows-figure.js).
 *
 * Asserted, in the real Settings ▸ Temporal Smoothing:
 *  1. Three cards (median, Gaussian, gaps), each with a chart; with both windows off
 *     (the default) each says off, in large text, and draws no window and no output.
 *  2. Typing a median window in Filter Parameters relabels its card and widens its
 *     shaded window; the blue line drops the spike (its point at the spike frame
 *     sits well below the red dot).
 *  3. Median off + Gaussian on feeds the Gaussian the raw 3D: the card says the
 *     spike becomes a bump; turning the median on hides that note again.
 *  4. TRYING CHANGES NOTHING: each card's sliders and text boxes redraw the sketch
 *     only (down to a 1-frame window), and Apply after only trying stores nothing
 *     new. Use sets the setting and the matching field and says it is not saved
 *     yet, and Apply stores it; Turn off sets 0; Reset sketch goes back. The Frame
 *     slider and box move the shaded window and fade the output after that frame;
 *     ▶ slides the window forward and pauses.
 *  5. The gaps card: at the default Max gap 5 / Minimum segment 5 its trace is
 *     three segments, the middle 3-frame one left as is; trying Max gap 7 merges
 *     them into one; Minimum segment 2 smooths the short one; neither changes a
 *     field until Use, which sets both.
 *  6. Layers and legends: the true movement is the first thing drawn and solid
 *     white; a grey line joins the measurements (broken at the gaps card's
 *     absences); the Gaussian card's input is a line too, green or (median off)
 *     grey; each card has its own legend, naming what it draws.
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
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
        const title = getComputedStyle(med.querySelector('.smooth-fig-name'));
        return {
            cards: !!med && !!gau,
            charts: document.querySelectorAll('.smooth-fig svg').length,
            medBig: med && med.querySelector('.fig-big').textContent,
            gauBig: gau && gau.querySelector('.fig-big').textContent,
            medNote: med && med.querySelector('small').textContent,
            gauNote: gau && gau.querySelector('small').textContent,
            bigLarger: parseFloat(getComputedStyle(med.querySelector('.fig-big')).fontSize) > parseFloat(title.fontSize),
            medBand: med && +(med.querySelector('rect.sf-band')?.getAttribute('width') || 0),
            gauBand: gau && +(gau.querySelector('rect.sf-band')?.getAttribute('width') || 0),
            medLine: !!med.querySelector('path.sf-out-median'),
            gauLine: !!gau.querySelector('path.sf-out'),
            framesOff: med.querySelector('[data-try="pos"] input[type="range"]').disabled && med.querySelector('.sf-play').disabled,
            useOffered: !med.querySelector('.fig-use').disabled,
            gauRawInput: !!gau.querySelector('path.sf-raw-line') && !gau.querySelector('path.sf-in-median') && !gau.querySelector('circle.sf-med'),
            gap,
            warn: gau && !gau.querySelector('.smooth-fig-warn').hidden,
        };
    });

    console.log('1. defaults');
    const d = await read();
    check(d.cards && d.charts === 3, 'three cards with a chart each (median, Gaussian, gaps)');
    check(d.medBig === 'off' && d.gauBig === 'off', `both say off (${d.medBig}, ${d.gauBig})`);
    check(d.bigLarger, 'the value is larger than the card title');
    check(!d.medBand && !d.gauBand, 'off: no shaded window');
    check(!d.medLine && !d.gauLine, 'off: no output line');
    check(d.gauRawInput, 'both off: the Gaussian card draws the raw trace in grey, as its legend says');
    check(d.framesOff, 'off: nothing for Frame to move, so it is disabled');
    check(!d.useOffered, 'off: no value to Use until one is tried');
    check(/try it/.test(d.medNote) && !/example/.test(d.medNote + d.gauNote), `says how to try one (${d.medNote})`);
    check(!d.warn, 'no spike note with both off');

    console.log('2. median window typed in Filter Parameters');
    await type('Median window (frames)', 9);
    const m = await read();
    check(m.medBig === '9 frames', `median card relabelled (${m.medBig})`);
    check(m.medBand > 50 && m.medLine, `a shaded window and an output line appear (${m.medBand})`);
    check(m.gap > 20, `line drops the spike (${m.gap && m.gap.toFixed(1)} px below it)`);

    console.log('3. Gaussian without the median');
    await type('Median window (frames)', 0);
    await type('Gaussian window (frames)', 15);
    const g = await read();
    check(g.gauBig === '15 frames', `Gaussian card relabelled (${g.gauBig})`);
    check(g.warn, 'note: the spike spreads into a bump');
    await type('Median window (frames)', 5);
    check(!(await read()).warn, 'note hidden once the median is on');

    console.log('4. trying changes nothing; Use does');
    const sl = await page.evaluate(async () => {
        const card = (s) => document.querySelector(`.smooth-fig [data-stage="${s}"]`);
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const field = (l) => document.querySelector(`.settings-panel[data-panel="smoothing"] input[aria-label="${l}"]`);
        const slider = (c, k) => card(c).querySelector(`[data-try="${k}"] input[type="range"]`);
        const box = (c, k) => card(c).querySelector(`[data-try="${k}"] input[type="number"]`);
        const big = (c) => card(c).querySelector('.fig-big').textContent;
        const avail = (c, cls) => !card(c).querySelector(cls).classList.contains('is-unavailable');
        const out = {};
        // Try: the setting is median 5, Gaussian 15 (typed above).
        set(slider('median', 'size'), 1);
        out.oneBig = big('median'); out.oneNote = card('median').querySelector('small').textContent;
        out.oneBox = box('median', 'size').value; out.oneField = field('Median window (frames)').value;
        set(box('gaussian', 'size'), 11);
        out.gauBig = big('gaussian'); out.gauSlider = slider('gaussian', 'size').value; out.gauField = field('Gaussian window (frames)').value;
        out.useLabel = card('gaussian').querySelector('.fig-use').textContent;
        out.settingNow = card('gaussian').querySelector('.fig-setting-now strong').textContent;
        set(box('gaussian', 'size'), 500);
        out.ignored = big('gaussian');
        // Reset.
        card('median').querySelector('.fig-reset').click();
        out.resetBig = big('median');
        // Frame.
        const bandX = () => +card('median').querySelector('rect.sf-band').getAttribute('x');
        const x0 = bandX();
        set(slider('median', 'pos'), 31);
        out.bandMoved = bandX() > x0 + 50;
        out.faded = card('median').querySelectorAll('.sf-ahead').length;
        out.posBox = box('median', 'pos').value;
        const x1 = bandX();
        set(box('median', 'pos'), 5);
        out.boxMoved = bandX() < x1 - 50 && slider('median', 'pos').value === '5';
        const play = card('gaussian').querySelector('.sf-play');
        play.click();
        await new Promise(r => setTimeout(r, 500));
        out.playing = play.getAttribute('aria-pressed');
        play.click();
        const p1 = +slider('gaussian', 'pos').value;
        await new Promise(r => setTimeout(r, 300));
        out.advanced = p1 > 1;
        out.paused = +slider('gaussian', 'pos').value === p1;
        // Apply after only trying: the working values typed above, nothing tried.
        document.querySelector('.settings-btn-apply').click();
        document.querySelector('.settings-modal-close').click();
        const S = await import('/ui/settings.js');
        out.storedTried = S.getSmoothingParam('smoothGaussianWindow');
        // Use.
        document.getElementById('menuSettings').click();
        document.querySelector('.settings-nav-item[data-panel="smoothing"]').click();
        set(box('gaussian', 'size'), 11);
        card('gaussian').querySelector('.fig-use').click();
        out.usedField = field('Gaussian window (frames)').value;
        out.usedNow = card('gaussian').querySelector('.fig-setting-now strong').textContent;
        out.usedUnsaved = avail('gaussian', '.fig-unsaved');
        card('median').querySelector('.fig-off').click();
        out.offField = field('Median window (frames)').value;
        out.offNow = card('median').querySelector('.fig-setting-now strong').textContent;
        document.querySelector('.settings-btn-apply').click();
        document.querySelector('.settings-modal-close').click();
        out.stored = S.getSmoothingParam('smoothGaussianWindow');
        out.storedMedian = S.getSmoothingParam('smoothMedianWindow');
        return out;
    });
    check(sl.oneBig === '1 frame' && sl.oneNote === 'no smoothing' && sl.oneBox === '1', `Window slider goes down to 1 frame and fills the box (${sl.oneBig}, ${sl.oneNote}, box ${sl.oneBox})`);
    check(sl.oneField === '5', `and leaves the median field alone (${sl.oneField})`);
    check(sl.gauBig === '11 frames' && sl.gauSlider === '11' && sl.gauField === '15', `the text box redraws and moves the slider, the field stays (${sl.gauBig}, slider ${sl.gauSlider}, field ${sl.gauField})`);
    check(sl.useLabel === 'Use 11 frames' && sl.settingNow === '15 frames', `offers Use, and says what the setting is (${sl.useLabel}; ${sl.settingNow})`);
    check(sl.ignored === '11 frames', 'an out-of-range entry is ignored');
    check(sl.resetBig === '5 frames', `Reset sketch goes back to the setting (${sl.resetBig})`);
    check(sl.bandMoved, 'Frame slider moves the shaded window');
    check(sl.faded > 0 && sl.posBox === '31', `output after the frame faded (${sl.faded} marks, box ${sl.posBox})`);
    check(sl.boxMoved, 'the Frame box moves it too, and the slider');
    check(sl.playing === 'true' && sl.advanced && sl.paused, 'play slides the window forward, a second click pauses it');
    check(sl.storedTried === 15, `Apply after only trying stores nothing tried (${sl.storedTried})`);
    check(sl.usedField === '11' && sl.usedNow === '11 frames' && sl.usedUnsaved, `Use sets the field and says it is not saved yet (${sl.usedField}, ${sl.usedNow})`);
    check(sl.offField === '0' && sl.offNow === 'off', `Turn off sets 0 (${sl.offField}, ${sl.offNow})`);
    check(sl.stored === 11 && sl.storedMedian === 0, `Apply stores them (${sl.stored}, ${sl.storedMedian})`);

    console.log('5. gaps card');
    await page.evaluate(() => { document.getElementById('menuSettings').click(); document.querySelector('.settings-nav-item[data-panel="smoothing"]').click(); });
    const gp = await page.evaluate(async () => {
        const card = document.querySelector('.smooth-fig [data-stage="gaps"]');
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const field = (l) => document.querySelector(`.settings-panel[data-panel="smoothing"] input[aria-label="${l}"]`);
        const slider = (k) => card.querySelector(`[data-try="${k}"] input[type="range"]`);
        const box = (k) => card.querySelector(`[data-try="${k}"] input[type="number"]`);
        const bars = () => ({ all: card.querySelectorAll('rect.sf-seg').length, short: card.querySelectorAll('rect.sf-seg-short').length });
        const out = { start: bars() };
        set(slider('gap'), 7);
        out.merged = bars(); out.gapField = field('Max gap to smooth across (frames)').value; out.gapBox = box('gap').value;
        set(slider('gap'), 5);
        set(box('minseg'), 2);
        out.minSeg2 = bars(); out.minField = field('Minimum segment length (frames)').value;
        out.big = card.querySelector('.fig-big').textContent;
        out.useLabel = card.querySelector('.fig-use').textContent;
        set(box('gap'), 6);
        card.querySelector('.fig-use').click();
        out.usedGap = field('Max gap to smooth across (frames)').value;
        out.usedSeg = field('Minimum segment length (frames)').value;
        document.querySelector('.settings-btn-apply').click();
        document.querySelector('.settings-modal-close').click();
        const S = await import('/ui/settings.js');
        out.stored = [S.getSmoothingParam('smoothMaxGap'), S.getSmoothingParam('smoothMinSegment')];
        return out;
    });
    check(gp.start.all === 3 && gp.start.short === 1, `defaults: 3 segments, 1 left as is (${JSON.stringify(gp.start)})`);
    check(gp.merged.all === 1 && gp.gapBox === '7' && gp.gapField === '5', `trying Max gap 7 merges them into one, the field stays (${JSON.stringify(gp.merged)}, ${gp.gapField})`);
    check(gp.minSeg2.all === 3 && gp.minSeg2.short === 0 && gp.minField === '5', `trying Minimum segment 2 smooths the short one, the field stays (${JSON.stringify(gp.minSeg2)}, ${gp.minField})`);
    check(gp.big === 'Max gap 5 · minimum segment 2' && gp.useLabel === 'Use max gap 5, minimum segment 2', `says what the sketch shows and offers Use (${gp.big}; ${gp.useLabel})`);
    check(gp.usedGap === '6' && gp.usedSeg === '2' && gp.stored.join() === '6,2', `Use sets both, Apply stores them (${gp.usedGap}, ${gp.usedSeg}; ${gp.stored})`);

    console.log('7. the Window slider has an off position');
    await page.evaluate(() => { document.getElementById('menuSettings').click(); document.querySelector('.settings-nav-item[data-panel="smoothing"]').click(); });
    const off = await page.evaluate(() => {
        const card = document.querySelector('.smooth-fig [data-stage="median"]');
        const ctl = card.querySelector('[data-try="size"]');
        const range = ctl.querySelector('input[type="range"]'), box = ctl.querySelector('input[type="number"]');
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const out = {};
        set(range, 1);
        out.one = [card.querySelector('.fig-big').textContent, box.value];
        set(range, range.min);
        out.off = [card.querySelector('.fig-big').textContent, box.value, !!card.querySelector('rect.sf-band')];
        set(box, 5);
        set(box, 0);
        out.typed = [range.value === range.min, card.querySelector('.fig-big').textContent];
        out.tick = ctl.querySelector('.fig-tick').textContent;
        return out;
    });
    check(off.one.join() === '1 frame,1', `one step along is 1 frame (${off.one})`);
    check(off.off.join() === 'off,0,false', `the left end is off: box 0, no window (${off.off})`);
    check(off.typed[0] && off.typed[1] === 'off', 'typing 0 puts the slider back at off');
    check(off.tick === 'off', 'the position is labelled off');

    console.log('8. the legends stay put');
    const still = await page.evaluate(() => {
        const card = (s) => document.querySelector(`.smooth-fig [data-stage="${s}"]`);
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const num = (s) => card(s).querySelector('[data-try="size"] input[type="number"]');
        // Where each legend's rows are, against its chart.
        const places = (s) => {
            const box = card(s).querySelector('svg').getBoundingClientRect();
            const leg = card(s).querySelector('.smooth-fig-legend');
            const rows = [...leg.querySelectorAll('i')].filter(i => !i.parentElement.classList.contains('sf-picked-key')).map(i => i.parentElement.getBoundingClientRect());
            return rows.map(r => [Math.round(r.left - box.left), Math.round(r.top - box.top)].join()).join(' ');
        };
        const seen = { median: new Set(), gaussian: new Set() };
        for (const [m, g] of [[0, 0], [1, 0], [5, 0], [0, 9], [5, 9], [0, 1], [31, 31]]) {
            set(num('median'), m); set(num('gaussian'), g);
            seen.median.add(places('median')); seen.gaussian.add(places('gaussian'));
        }
        return { median: seen.median.size, gaussian: seen.gaussian.size };
    });
    check(still.median === 1 && still.gaussian === 1, `every row keeps its place in all 7 states (${still.median}, ${still.gaussian} layouts)`);

    console.log('6. layers and legends');
    await page.evaluate(() => { document.getElementById('menuSettings').click(); document.querySelector('.settings-nav-item[data-panel="smoothing"]').click(); });
    const lay = await page.evaluate(() => {
        const card = (s) => document.querySelector(`.smooth-fig [data-stage="${s}"]`);
        const num = (s) => card(s).querySelector('[data-try="size"] input[type="number"]');
        const set = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); };
        const keys = (s) => [...card(s).querySelectorAll('.smooth-fig-legend i')].filter(i => i.offsetParent && getComputedStyle(i).visibility !== 'hidden').map(i => i.className.replace('sf-key-', ''));
        const pieces = (el) => el.getAttribute('d').split('M').length - 1;
        const out = { shared: !!document.querySelector('.smooth-fig > .smooth-fig-legend') };
        // The legend is in the card's top right corner, and the white line stays below it.
        out.clear = ['median', 'gaussian'].map((s) => {
            const svg = card(s).querySelector('svg'), box = svg.getBoundingClientRect();
            const leg = card(s).querySelector('.smooth-fig-legend').getBoundingClientRect();
            const scale = box.width / svg.viewBox.baseVal.width;
            const under = card(s).querySelector('.sf-true').getAttribute('d').slice(1).split('L')
                .map(p => p.trim().split(' ').map(Number))
                .filter(p => box.left + p[0] * scale >= leg.left)
                .every(p => box.top + p[1] * scale > leg.bottom);
            const cardBox = card(s).getBoundingClientRect();
            return { inside: leg.top - cardBox.top < 24 && cardBox.right - leg.right < 24 && leg.right <= cardBox.right && leg.bottom <= box.bottom, clear: under };
        });
        out.first = ['median', 'gaussian', 'gaps'].map(s => card(s).querySelector('svg').firstElementChild.getAttribute('class'));
        const t = getComputedStyle(card('median').querySelector('.sf-true'));
        out.stroke = t.stroke; out.dash = t.strokeDasharray;
        out.medRaw = !!card('median').querySelector('path.sf-raw-line');
        out.gapRawPieces = pieces(card('gaps').querySelector('path.sf-raw-line'));
        set(num('median'), 5); set(num('gaussian'), 9);
        out.gauGreen = !!card('gaussian').querySelector('path.sf-in-median') && !card('gaussian').querySelector('path.sf-raw-line');
        out.medKeys = keys('median'); out.gauKeys = keys('gaussian'); out.gapKeys = keys('gaps');
        set(num('median'), 0);
        out.gauRaw = !!card('gaussian').querySelector('path.sf-raw-line') && !card('gaussian').querySelector('path.sf-in-median');
        out.gauRawKeys = keys('gaussian');
        out.gauRawSpikeLabel = !!card('gaussian').querySelector('.sf-note-spike');
        set(num('median'), 5);
        const pos = card('median').querySelector('[data-try="pos"] input[type="number"]');
        out.pickedBefore = keys('median').includes('current');
        set(pos, 20);
        out.pickedAfter = keys('median').includes('current');
        return out;
    });
    check(!lay.shared, 'no legend shared between the cards');
    check(lay.clear.every(c => c.inside && c.clear), `the top legends sit in the card's top right corner, above the white line (${JSON.stringify(lay.clear)})`);
    check(lay.first.every(c => c === 'sf-true'), `true movement drawn first on every card (${lay.first})`);
    check(lay.stroke === 'rgb(255, 255, 255)' && lay.dash === 'none', `solid white (${lay.stroke}, ${lay.dash})`);
    check(lay.medRaw && lay.gapRawPieces === 4, `grey line joins the measurements, broken at the 3 absences (${lay.gapRawPieces} pieces)`);
    check(lay.gauGreen, 'Gaussian card: the median output has edges');
    check(lay.gauRaw && lay.gauRawKeys.includes('raw') && !lay.gauRawKeys.includes('med') && lay.gauRawSpikeLabel, `median off: its input and legend are the raw trace (${lay.gauRawKeys})`);
    const wants = (got, list) => list.every(k => got.includes(k));
    check(wants(lay.medKeys, ['true', 'raw', 'spike', 'med', 'band', 'rank', 'rank-mid']) && !lay.medKeys.includes('out'), `median legend (${lay.medKeys})`);
    check(wants(lay.gauKeys, ['true', 'med', 'out', 'band', 'weight']) && !lay.gauKeys.includes('raw'), `Gaussian legend (${lay.gauKeys})`);
    check(wants(lay.gapKeys, ['true', 'raw', 'out-line', 'left', 'hole', 'split', 'seg', 'seg-short']), `gaps legend (${lay.gapKeys})`);
    check(!lay.pickedBefore && lay.pickedAfter, 'the ring is in the legend only while a frame is picked');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
