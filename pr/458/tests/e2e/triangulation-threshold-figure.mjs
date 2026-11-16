/**
 * triangulation-threshold-figure.mjs — Settings ▸ Triangulation Wizard shows
 * the reprojection error threshold on the four cameras of its sketches, and
 * trying a value there never changes a setting (ui/triangulation-methods-figure.js,
 * ui/figure-try-controls.js; the keep/drop rule and the numbers are pinned to the
 * solvers by tests/test-triangulation-threshold-figure.mjs).
 *
 * Asserted, in the real Settings modal:
 *  1. With the threshold off (the default) the sketch opens at off, "Your setting"
 *     says off, and the large value is what the sketch shows. At 15 px, DLT's first
 *     solve misses all three cameras by more; only the worst is dropped.
 *  2. A value typed in the Tracking Wizard is the setting, and the sketch follows.
 *  3. Picking a method follows too. Refined at 15 px drops the stray and reaches
 *     the true position; at 60 px nothing is dropped and it stays close; at 5 px the
 *     node loses its 3D. DLT at 5 px keeps it, and at 40 px stays far off.
 *  4. The card keeps one size whatever is tried, and the sketch of a step not
 *     reached stays in place with no verdict showing through.
 *  5. TRYING CHANGES NOTHING: the slider, the text box and the DLT/Refined switch
 *     redraw the sketch only. The wizard field, the picked method and what Apply
 *     stores stay as they were. A typed value past the slider's end works; out of
 *     range is ignored. The slider's left end is off: every camera counts.
 *  6. Use sets the working value and the wizard field and says "not saved until
 *     you click Apply"; Apply stores it. Turn off sets 0. Reset sketch goes back.
 *  7. The method cards still pick the method; the threshold card is not one of them.
 *  8. Each line of sight starts at its camera, the stray label sits by its line,
 *     the projection marker lets the target show through, each sketch's legend names
 *     its marks, and the legend below explains the lines.
 *  9. Bars at each sketch's bottom right stack the cameras' errors above their sum,
 *     at one scale, so DLT's longer sum can be seen against Refined's.
 *
 * Run: node tests/e2e/triangulation-threshold-figure.mjs   (PORT=… to move the server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8319);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const FIELD = '.settings-panel[data-panel="wizard"] input[aria-label="Reprojection error threshold (px)"]';
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    const open = () => page.evaluate(() => {
        document.getElementById('menuSettings').click();
        document.querySelector('.settings-nav-item[data-panel="triangulation"]').click();
    });
    await open();

    // The real setting, from the Tracking Wizard's field.
    const type = (v) => page.evaluate(([f, val]) => {
        const i = document.querySelector(f);
        i.value = String(val); i.dispatchEvent(new Event('input'));
    }, [FIELD, v]);
    // Trying, from the card.
    const tryBox = (v) => page.evaluate((val) => {
        const i = document.querySelector('.tri-thr [data-try="threshold"] input[type="number"]');
        i.value = String(val); i.dispatchEvent(new Event('input'));
    }, v);
    // `v` in px, moved to the slider's position for it.
    const trySlider = (v) => page.evaluate(async (val) => {
        const F = await import('/ui/triangulation-methods-figure.js');
        const i = document.querySelector('.tri-thr [data-try="threshold"] input[type="range"]');
        i.value = String(F.thresholdSliderPos(val)); i.dispatchEvent(new Event('input'));
    }, v);
    const sliderPos = (v) => page.evaluate(async (val) => (await import('/ui/triangulation-methods-figure.js')).thresholdSliderPos(val), v);
    const read = () => page.evaluate((f) => {
        const card = document.querySelector('.tri-methods .tri-thr');
        const step = (n) => card.querySelector(`.tri-thr-step[data-step="${n}"]`);
        const rows = (n) => Array.from(step(n).querySelectorAll('.tri-thr-verdicts li'));
        const states = (n) => step(n).classList.contains('is-idle') ? '' : rows(n).map(li => (li.className.match(/is-(\w+)/) || [])[1]).join(',');
        const shown = (el) => { const on = el.querySelector('.tri-thr-stack > .on'); return (on || el).textContent; };
        const res = card.querySelector('.tri-thr-result');
        const box = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
        const bottomBand = Array.from(step(1).querySelectorAll('line.tm-band')).find(l => l.getAttribute('y1') === '188');
        const avail = (cls) => !card.querySelector(cls).classList.contains('is-unavailable');
        return {
            big: card.querySelector('.fig-big').textContent,
            setting: card.querySelector('.fig-setting-now strong').textContent,
            unsaved: avail('.fig-unsaved'),
            use: avail('.fig-use') ? card.querySelector('.fig-use').textContent : null,
            off: avail('.fig-off'),
            reset: avail('.fig-reset'),
            num: card.querySelector('[data-try="threshold"] input[type="number"]').value,
            slider: card.querySelector('[data-try="threshold"] input[type="range"]').value,
            name1: shown(step(1).querySelector('.tri-thr-step-name')),
            name2: shown(step(2).querySelector('.tri-thr-step-name')),
            name3: shown(step(3).querySelector('.tri-thr-step-name')),
            s1: states(1), s2: states(2), s3: states(3),
            kind: res.dataset.kind,
            result: shown(res),
            lost: res.classList.contains('tri-thr-lost'),
            bandLen: bottomBand ? Math.abs(+bottomBand.getAttribute('x2') - +bottomBand.getAttribute('x1')) : null,
            bands2: step(2).querySelectorAll('line.tm-band').length,
            dropped: [1, 2, 3].map(n => Array.from(step(n).querySelectorAll('.tm-dropped .tm-camera-number')).map(t => t.textContent).join()),
            droppedParts: Array.from(step(2).querySelectorAll('.tm-dropped')).map(g => g.firstElementChild.getAttribute('class') || g.firstElementChild.tagName).join(),
            droppedOpacity: (() => { const g = step(2).querySelector('.tm-dropped'); return g ? +getComputedStyle(g).opacity : null; })(),
            sketches: card.querySelectorAll('.tri-thr-sketch svg:not(.tm-legend):not(.tm-totals)').length,
            cameras: step(1).querySelectorAll('.tm-plane').length,
            errText: rows(1).map(li => shown(li)),
            idleLeak: Array.from(card.querySelectorAll('.tri-thr-step.is-idle .tri-thr-verdicts .tri-thr-stack > span')).some(s => getComputedStyle(s).visibility === 'visible'),
            size: box(card) + ' ' + Array.from(card.querySelectorAll('.tri-thr-step')).map(box).join(' '),
            inRadio: !!card.closest('[role="radiogroup"]') || card.classList.contains('tri-method-choice'),
            field: document.querySelector(f).value,
            picked: Array.from(document.querySelectorAll('.tri-method-choice')).filter(c => c.getAttribute('aria-checked') === 'true').map(c => c.dataset.method).join(),
            methodCardSketches: Array.from(document.querySelectorAll('.tri-method-choice svg:not(.tm-legend):not(.tm-totals)')).map(s => s.querySelectorAll('.tm-plane').length).join(),
        };
    }, FIELD);

    console.log('1. threshold off (default)');
    let r = await read();
    check(r.setting === 'off' && r.field === '0', `"Your setting" says off (${r.setting}, field ${r.field})`);
    check(r.big === 'off' && r.num === '0' && r.slider === '0', `the sketch opens at off, in large text (${r.big})`);
    check(r.s1 === 'off,off,off,off' && r.s2 === '' && r.kind === 'offFar', `at off every camera counts, nothing dropped (${r.s1})`);
    check(r.use === null && !r.off && !r.unsaved && !r.reset, 'nothing to use, turn off, reset or save');
    await tryBox(15);
    r = await read();
    check(r.big === '15 px' && r.use === 'Use 15 px' && r.reset && r.setting === 'off', `trying 15 px offers Use and Reset sketch; the setting stays off (${r.use})`);
    check(r.cameras === 4 && r.methodCardSketches === '4,4', `four cameras in every sketch (${r.cameras}; cards ${r.methodCardSketches})`);
    check(r.sketches === 3, 'one sketch per solve: three steps');
    check(r.name1.includes('DLT') && r.s1 === 'in,in,over,drop', `DLT first solve: two over, only the worst dropped (${r.s1})`);
    check(/^12\.6 px/.test(r.errText[0]) && /^12\.1 px/.test(r.errText[1]) && /^43\.1 px/.test(r.errText[2]) && /^53\.5 px.*dropped/.test(r.errText[3]), `errors from the real solver (${r.errText.join(' | ')})`);
    check(r.s2 === 'in,in,in,out' && r.s3 === '', `solved again: the other three within; no third solve (${r.s2})`);
    check(/^2 · Second solve \(DLT\), without camera 3$/.test(r.name2) && /Not reached/.test(r.name3), `the second solve's title names the method (${r.name2})`);
    check(r.bands2 === 3, `step 2 draws a band only on the cameras still counted (${r.bands2})`);
    check(r.kind === 'one' && /^With 15 px, camera 3 is left out/.test(r.result), `result says so (${r.result.slice(0, 50)}…)`);
    check(!r.inRadio, 'the threshold card is not one of the method choices');

    console.log('2. the setting, typed in the Tracking Wizard');
    await type(25);
    r = await read();
    check(r.setting === '25 px' && r.big === '25 px' && r.num === '25', `setting and sketch follow (${r.setting}, ${r.big})`);
    check(r.s1 === 'in,in,over,drop', `camera 2 over too, the stray dropped (${r.s1})`);
    check(Math.abs(r.bandLen - 25 * 2 / 3) < 0.11, `bands drawn 25 px either side of the detection (bottom camera: ${r.bandLen} units at 3 px per unit)`);

    console.log('3. Refined, and what the threshold does for it');
    await page.click('.tri-method-choice[data-method="ba"]');
    await type(15);
    r = await read();
    check(r.name1.includes('Refined') && r.s1 === 'over,in,in,drop', `Refined's first solve: the worst is dropped (${r.s1})`);
    check(/^2 · Second solve \(Refined\), without camera 3$/.test(r.name2), `every solve's title names the method (${r.name2})`);
    check(r.s2 === 'in,in,in,out' && r.kind === 'one' && /near the target, but still a little wrong/.test(r.result), `dropping it lands near the target (${r.result.slice(0, 60)}…)`);
    const noted = await page.evaluate(() => [1, 2].map(n => Array.from(document.querySelectorAll(`.tri-thr-step[data-step="${n}"] .tm-sketch text`)).map(t => t.textContent).join(' ')));
    check(/stray/.test(noted[0]) && /dropped/.test(noted[0]), `the first solve says "stray, dropped" (${/stray/.test(noted[0])})`);
    check(!/stray/.test(noted[1]), `the second has no stray note: the faded camera says it (${/stray/.test(noted[1])})`);
    const outs = await page.evaluate(() => [1, 2, 3].map(n => document.querySelectorAll(`.tri-thr-step[data-step="${n}"] .tm-det-out`).length));
    const hues = await page.evaluate(() => {
        const list = document.querySelector('.tri-thr-step[data-step="1"]');
        const colour = (sel, prop) => { const e = list.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
        const sample = document.createElement('span');
        return {
            stray: colour('.tm-ray-head.tm-ray-stray', 'fill'),
            dropText: colour('.tri-thr-verdicts li.is-drop > span:last-child', 'color'),
            dropNote: colour('.tm-note-drop', 'fill'),
            dropBand: colour('.is-drop.tm-band', 'stroke'),
        };
    });
    check(hues.stray && new Set(Object.values(hues)).size === 1, `stray and dropped are one colour (${JSON.stringify(hues)})`);
    check(outs[0] === 0 && outs[1] === 1, `in the second solve the dropped camera's prediction is orange, none in the first (${outs})`);
    check(r.dropped[0] === '' && r.dropped[1] === '3' && r.droppedOpacity < 0.5, `in the second solve the dropped camera 3 is faded, none in the first (${JSON.stringify(r.dropped)}, opacity ${r.droppedOpacity})`);
    check(/tm-ray/.test(r.droppedParts) && /tm-plane/.test(r.droppedParts) && /tm-det/.test(r.droppedParts), `its line of sight, image plane and prediction fade too (${r.droppedParts})`);
    await type(75);
    r = await read();
    check(r.kind === 'close' && r.s2 === '' && /closer to the target/.test(r.result), `75 px drops nothing (${r.s1})`);
    await type(8);
    r = await read();
    check(r.kind === 'two' && r.s2 === 'drop,over,in,out' && r.s3 === 'out,in,in,out', `too low: a camera only a little off goes too (${r.s2} → ${r.s3})`);
    check(r.dropped[2] === '0,3', `in the third solve both dropped cameras are faded (${r.dropped[2]})`);
    check(/^3 · Third solve \(Refined\), without cameras 3 and 0$/.test(r.name3), `the third title names the method and both cameras (${r.name3})`);
    await type(3);
    r = await read();
    check(r.lost && /no 3D point/.test(r.result), 'Refined at 3 px: the last two still miss, no 3D');
    await page.click('.tri-method-choice[data-method="dlt"]');
    r = await read();
    check(!r.lost && r.kind === 'two' && /without cameras 3 and 1/.test(r.name3), `DLT at 3 px keeps it: another camera goes (${r.name3})`);
    await type(50);
    r = await read();
    check(r.s1 === 'in,in,in,drop' && r.s2 === 'in,in,in,out' && r.kind === 'one' && /^2 · Second solve \(DLT\), without camera 3$/.test(r.name2), `DLT at 50 px drops camera 3 and solves again (${r.s1} → ${r.s2}; ${r.name2})`);
    await type(60);
    r = await read();
    check(r.kind === 'far' && /far from the target/.test(r.result), 'DLT at 60 px drops nothing and stays far off');
    await type(0);

    console.log('4. one size whatever is tried');
    const sizes = new Set();
    let leak = false;
    for (const m of ['dlt', 'ba']) {
        await page.click(`.tri-thr [data-demo-method="${m}"]`);
        for (const t of [0, 1, 2, 3, 4, 5, 6, 12, 15, 20, 30, 36, 58, 59, 80, 200, 640]) {
            await tryBox(t);
            const s = await read();
            sizes.add(s.size);
            leak = leak || s.idleLeak;
        }
    }
    check(sizes.size === 1, `one size for the card and every step across 34 states (${[...sizes].join(' | ')})`);
    check(!leak, 'no verdict shows through a step not reached');

    console.log('5. trying changes nothing');
    await page.click('.tri-thr .fig-reset');
    r = await read();
    check(r.big === 'off' && r.setting === 'off', `Reset sketch goes back to the setting (${r.big})`);
    await trySlider(40);
    r = await read();
    check(r.big === '40 px' && r.num === '40' && r.field === '0' && r.setting === 'off', `the slider redraws the sketch and fills the box, the setting stays off (${r.big}, field ${r.field})`);
    await tryBox(33);
    r = await read();
    check(r.big === '33 px' && Number(r.slider) === await sliderPos(33) && r.field === '0', `the text box moves the slider, the setting stays off (${r.big})`);
    await tryBox(200);
    r = await read();
    check(r.big === '200 px' && Number(r.slider) === await sliderPos(200) && r.field === '0', `a typed value moves the slider on its log scale (${r.big}, position ${r.slider})`);
    await tryBox(700);
    check((await read()).big === '200 px', 'out of range is ignored');
    await trySlider(0);
    r = await read();
    check(r.big === 'off' && r.num === '0' && r.slider === '0', `the slider's left end is off (${r.big}, box ${r.num})`);
    check(r.s1 === 'off,off,off,off' && r.s2 === '' && r.bands2 === 0 && r.kind === 'offFar' && /every camera counts/.test(r.result), `off: every camera counts, nothing dropped (${r.s1}; ${r.result.slice(0, 40)}…)`);
    check(r.bandLen === null && /^12\.6 px · counted/.test(r.errText[0]), `no bands, and no verdict against a threshold (${r.errText[0]})`);
    check(r.use === null && r.field === '0', 'off offers no Use; the setting stays off');
    await tryBox(40);
    await tryBox(0);
    r = await read();
    check(r.big === 'off' && r.slider === '0', 'typing 0 is off too');
    await page.click('.tri-thr [data-demo-method="ba"]');
    r = await read();
    check(r.name1.includes('Refined') && r.picked === 'dlt', `the DLT/Refined switch redraws, the picked method stays (${r.picked})`);
    await page.evaluate(() => document.querySelector('.settings-modal-close').click());
    const stored = () => page.evaluate(async () => {
        const S = await import('/ui/settings.js');
        return { threshold: S.getTrackingThreshold('reprojErrorThreshold'), method: S.getDefaultTriangulationMethod() };
    });
    let st = await stored();
    check(st.threshold === 0 && st.method === 'dlt', `closing after only trying stores nothing new (${JSON.stringify(st)})`);

    console.log('5b. the slider: off, 640 px, a log scale, a recommended zone');
    await open();
    const heads = await page.evaluate(() => Array.from(document.querySelectorAll('.tri-methods svg')).filter(v => v.querySelector('.tm-ray')).map(v => {
        const rays = v.querySelectorAll('.tm-ray').length, all = v.querySelectorAll('.tm-ray-head').length, orange = v.querySelectorAll('.tm-ray-head.tm-ray-stray').length;
        return rays + '/' + all + '/' + orange;
    }));
    check(heads.length >= 5 && heads.every(h => h === '4/4/1'), `every line of sight ends in an arrowhead, the stray's orange (${heads})`);
    const headTip = await page.evaluate(() => {
        const v = document.querySelector('.tri-method-choice svg');
        const c = window.getComputedStyle(v.querySelector('.tm-ray-head.tm-ray-stray')).fill, g = window.getComputedStyle(v.querySelector('.tm-ray-head:not(.tm-ray-stray)')).fill;
        return { c, g };
    });
    check(headTip.c !== headTip.g, `in the two colours (${headTip.c}, ${headTip.g})`);
    const scale = await page.evaluate(() => {
        const c = document.querySelector('.tri-thr [data-try="threshold"]'), zone = c.querySelector('.fig-zone');
        return { ticks: Array.from(c.querySelectorAll('.fig-tick')).map(t => t.textContent).join(), label: c.querySelector('.fig-zone-label').textContent,
            from: +getComputedStyle(zone).getPropertyValue('--a'), to: +getComputedStyle(zone).getPropertyValue('--b') };
    });
    check(scale.ticks === 'off,640,100,15,1', `marked off, 640, 100, 15, 1 (${scale.ticks})`);
    const [p100, p15] = [await sliderPos(100), await sliderPos(15)];
    check(scale.label === 'recommended' && Math.abs(scale.from * 1000 - p100) < 1 && Math.abs(scale.to * 1000 - p15) < 1, `a recommended zone from 100 to 15 px (${scale.from}-${scale.to})`);
    // Moving the slider right with DLT: nothing, then camera 3 drops, in the zone.
    await page.click('.tri-thr [data-demo-method="dlt"]');
    const sweep = [];
    for (let pos = 0; pos <= 1000; pos += 10) {
        const seen = await page.evaluate((p) => {
            const i = document.querySelector('.tri-thr [data-try="threshold"] input[type="range"]');
            i.value = String(p); i.dispatchEvent(new Event('input'));
            return document.querySelector('.tri-thr-result').dataset.kind;
        }, pos);
        if (!sweep.length || sweep[sweep.length - 1].kind !== seen) sweep.push({ pos, kind: seen });
    }
    check(sweep.map(x => x.kind).join() === 'offFar,far,one,two,lost', `moving right with DLT: off, nothing, camera 3 drops, then a good camera, then no 3D (${JSON.stringify(sweep)})`);
    const dropAt = sweep[2].pos, goodAt = sweep[3].pos;
    check(dropAt > p100 && dropAt < p15, `camera 3 drops inside the recommended zone (position ${dropAt})`);
    check(goodAt > p15, `a good camera only goes past it (position ${goodAt})`);
    await page.click('.settings-btn-cancel');

    console.log('6. Use, Apply, Turn off');
    await open();
    await tryBox(25);
    r = await read();
    check(r.use === 'Use 25 px' && r.reset, `offers Use 25 px and Reset sketch (${r.use})`);
    await page.click('.tri-thr .fig-use');
    r = await read();
    check(r.setting === '25 px' && r.field === '25' && r.unsaved && r.use === null, `Use sets the working value and the wizard field, and says it is not saved yet (${r.setting}, ${r.field})`);
    await page.evaluate(() => document.querySelector('.settings-btn-apply').click());
    st = await stored();
    check(st.threshold === 25, `Apply stores it (${st.threshold})`);
    r = await read();
    check(r.setting === '25 px' && !r.unsaved, `Apply clears "not saved until you click Apply", with the window still open (${r.setting}, ${r.unsaved})`);
    await page.click('.settings-modal-close');
    await open();
    r = await read();
    check(r.setting === '25 px' && !r.unsaved && r.off, `reopened Settings shows the stored threshold (${r.setting})`);
    await page.click('.tri-thr .fig-off');
    r = await read();
    check(r.setting === 'off' && r.field === '0' && r.unsaved, `Turn off sets 0 (${r.setting}, ${r.field})`);
    await page.click('.settings-btn-cancel');
    st = await stored();
    check(st.threshold === 25, `Cancel keeps what was stored (${st.threshold})`);
    await open();

    console.log('7. the method cards still pick the method');
    await page.click('.tri-method-choice[data-method="ba"]');
    r = await read();
    check(r.picked === 'ba' && r.name1.includes('Refined'), `clicking Refined picks it and the sketch follows (${r.picked})`);

    console.log('8. the lines of sight can be read');
    const lines = await page.evaluate(() => {
        const svg = document.querySelector('.tri-method-choice[data-method="dlt"] svg');
        const cams = Array.from(svg.querySelectorAll('g[transform]')).map(g => g.getAttribute('transform').match(/translate\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number));
        const rays = Array.from(svg.querySelectorAll('line.tm-ray')).map(l => ['x1', 'y1', 'x2', 'y2'].map(a => +l.getAttribute(a)).concat(l.classList.contains('tm-ray-stray')));
        const dist = (p, r) => { const dx = r[2] - r[0], dy = r[3] - r[1], t = Math.max(0, ((p[0] - r[0]) * dx + (p[1] - r[1]) * dy) / (dx * dx + dy * dy)); return Math.hypot(r[0] + t * dx - p[0], r[1] + t * dy - p[1]); };
        const labels = Array.from(svg.querySelectorAll('text.tm-note-stray')).map(t => { const b = t.getBBox(); return [b.x + b.width / 2, b.y + b.height / 2]; });
        return {
            fromCamera: rays.length === 4 && rays.every((r, i) => r[0] === cams[i][0] && r[1] === cams[i][1]),
            strayFlags: rays.map(r => r[4]).join(),
            labelDist: labels.length === 1 ? Math.round(dist(labels[0], rays[3])) : Infinity,
            legend: document.querySelector('.tri-methods-legend').textContent,
        };
    });
    check(lines.fromCamera && lines.strayFlags === 'false,false,false,true', `four lines of sight, each from its camera; camera 3's orange (${lines.strayFlags})`);
    check(lines.labelDist < 20, `the stray label sits by its own line (${lines.labelDist} units)`);
    const marker = await page.evaluate(() => {
        const svg = document.querySelector('.tri-method-choice[data-method="ba"] svg');
        const kids = Array.from(svg.children), point = svg.querySelector('circle.tm-point');
        return {
            opacity: +getComputedStyle(point).fillOpacity,
            overCross: kids.indexOf(point) > kids.indexOf(svg.querySelector('line.tm-true')),
        };
    });
    check(marker.opacity < 0.6 && marker.overCross, `the 3D marker is translucent, over the cross, so the cross shows through (fill opacity ${marker.opacity})`);
    const defined = await page.evaluate(() => {
        const says = (el) => /distance on .*2D image between the prediction and the reprojection/.test(el.textContent);
        return says(document.querySelector('.tri-methods-lead')) && says(document.querySelector('.tri-thr'));
    });
    check(defined, 'the text says the reprojection error is the distance on the 2D image between prediction and reprojection');
    const totals = await page.evaluate(() => {
        const read = (root) => {
            const svg = root.querySelector('.tm-totals');
            const rows = Array.from(svg.querySelectorAll('g'));
            const width = (g) => Array.from(g.querySelectorAll('rect')).reduce((sum, r) => sum + +r.getAttribute('width'), 0);
            return { svg, labels: rows.map(g => g.querySelector('text').textContent), values: rows.map(g => g.querySelector('text:last-of-type').textContent), widths: rows.map(width) };
        };
        const dlt = read(document.querySelector('.tri-method-choice[data-method="dlt"]'));
        const ba = read(document.querySelector('.tri-method-choice[data-method="ba"]'));
        const wrap = document.querySelector('.tri-method-choice[data-method="dlt"] .tm-sketch');
        const box = dlt.svg.getBoundingClientRect(), cams = Array.from(wrap.querySelector('svg').querySelectorAll('g[transform]')).map(g => g.getBoundingClientRect());
        const clear = (c) => box.left > c.right || box.top > c.bottom;
        const label = dlt.svg.querySelector('g text').getBBox(), firstBar = dlt.svg.querySelector('g rect');
        return { dlt: { labels: dlt.labels, values: dlt.values, widths: dlt.widths }, ba: { values: ba.values, widths: ba.widths },
            right: Math.abs(box.right - wrap.getBoundingClientRect().right) < 1, clear: cams.every(clear),
            barsClearOfLabels: label.x + label.width < +firstBar.getAttribute('x'),
            sumClearOfValue: [4, 5].every((n) => { const row = dlt.svg.querySelectorAll('g')[n], rects = row.querySelectorAll('rect'), last = rects[rects.length - 1], name = row.querySelector('text').getBBox(); return +last.getAttribute('x') + +last.getAttribute('width') + 1 < row.querySelector('text:last-of-type').getBBox().x && name.x + name.width < +rects[0].getAttribute('x'); }),
            numbers: Array.from(wrap.querySelectorAll('.tm-camera-number')).map(t => t.textContent).join(),
            onBodies: Array.from(wrap.querySelectorAll('.tm-camera-number')).every((t, i) => { const b = t.getBoundingClientRect(), c = cams[i]; const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2; return x > c.left && x < c.right && y > c.top && y < c.bottom; }),
            numberStyle: (() => { const cs = getComputedStyle(wrap.querySelector('.tm-camera-number')); return cs.fill + ' ' + cs.fontWeight; })() };
    });
    check(totals.dlt.labels.join() === 'camera 0,camera 1,camera 2,camera 3,sum,ground truth', `totals: a row per camera, the sum, the ground truth error (${totals.dlt.labels.join()})`);
    check(totals.dlt.values[4] === '121.3 px' && totals.ba.values[4] === '95.7 px', `the sums are the errors added up (DLT ${totals.dlt.values[4]}, Refined ${totals.ba.values[4]})`);
    check(totals.dlt.widths[4] > totals.ba.widths[4], `DLT's sum bar is longer than Refined's (${totals.dlt.widths[4].toFixed(1)} vs ${totals.ba.widths[4].toFixed(1)})`);
    check(Math.abs(totals.dlt.widths[4] / 121.3 - totals.ba.widths[4] / 95.7) < 0.02, 'one scale in both sketches');
    check(Math.abs(totals.dlt.widths[3] - 53.5 * totals.dlt.widths[4] / 121.3) < 0.2, 'each bar is in proportion to its error');
    check(totals.right && totals.clear, 'the totals sit at the bottom-right, clear of the cameras');
    check(totals.dlt.values[5] === '52.3 mm' && totals.ba.values[5] === '20 mm' && totals.dlt.widths[5] > totals.ba.widths[5] * 1.5, `the ground truth error shrinks from DLT to Refined (${totals.dlt.values[5]} to ${totals.ba.values[5]})`);
    const truthLine = await page.evaluate(() => {
        const svg = document.querySelector('.tri-method-choice[data-method="dlt"] svg');
        const kids = Array.from(svg.children), at = (el) => kids.indexOf(el);
        const lineEl = svg.querySelector('line.tm-truth-gap');
        const lastLine = Math.max(...Array.from(svg.querySelectorAll(':scope > line:not(.tm-truth-gap):not(.tm-true)')).map(at));
        const firstMarker = Math.min(...['circle.tm-det', 'circle.tm-proj', 'circle.tm-point', 'line.tm-true'].map(q => at(svg.querySelector(q))));
        const ba = document.querySelector('.tri-method-choice[data-method="ba"] svg');
        const baLine = ba.querySelector('line.tm-truth-gap'), marker = ba.querySelector('circle.tm-point');
        const len = Math.hypot(+baLine.getAttribute('x2') - +baLine.getAttribute('x1'), +baLine.getAttribute('y2') - +baLine.getAttribute('y1'));
        return { overLines: at(lineEl) > lastLine, underMarkers: at(lineEl) < firstMarker, stroke: getComputedStyle(lineEl).stroke, diameters: len / (2 * +marker.getAttribute('r')) };
    });
    check(truthLine.overLines && truthLine.underMarkers, 'the ground truth line is over every other line and under the markers');
    check(Math.abs(truthLine.diameters - 2) < 0.1, `Refined's is twice the projection marker's diameter (${truthLine.diameters.toFixed(2)})`);
    check(truthLine.stroke === 'rgb(168, 28, 28)', `it is a dark red solid line (${truthLine.stroke})`);
    check(totals.barsClearOfLabels && totals.sumClearOfValue, 'the bars do not touch the labels or the values');
    check(totals.numbers === '0,1,2,3' && totals.onBodies, 'each camera body is numbered, 0 to 3 from left to right, to match the rows');
    check(totals.numberStyle === 'rgb(255, 255, 255) 700', `the numbers are bold and white (${totals.numberStyle})`);
    const titles = await page.evaluate(() => Array.from(document.querySelectorAll('.tri-methods .tri-methods-name')).map(n => n.firstChild.textContent).join(' | '));
    check(titles === 'Direct Linear Transformation (DLT), per node | Refined (Bundle adjustment), per node | Reprojection error threshold (RPE), per node', `each card's title says it is per node (${titles})`);
    const planes = await page.evaluate(() => Array.from(document.querySelector('.tri-method-choice[data-method="dlt"] svg').querySelectorAll('line.tm-plane')).map(l => Math.round(Math.hypot(+l.getAttribute('x2') - +l.getAttribute('x1'), +l.getAttribute('y2') - +l.getAttribute('y1')))));
    check(planes.length === 4 && new Set(planes).size === 1, `every camera's image plane is the same width (${planes})`);
    const legend = await page.evaluate(() => {
        const sketches = Array.from(document.querySelectorAll('.tri-methods .tm-sketch')).filter(s => !s.querySelector('.tm-idle'));
        const wrap = sketches[0], svg = wrap.querySelector('svg');
        const box = wrap.querySelector('.tm-legend').getBoundingClientRect(), view = svg.getBoundingClientRect();
        const camera = svg.querySelector('g[transform]').getBoundingClientRect();
        return {
            everySketch: sketches.length >= 3 && sketches.every(s => Array.from(s.querySelectorAll('.tm-legend text')).map(t => t.textContent).join() === 'target,projection,prediction,reprojection,reprojection error,ground truth error'),
            white: getComputedStyle(svg.querySelector('circle.tm-det')).fill,
            bottomLeft: Math.abs(box.left - wrap.getBoundingClientRect().left) < 1 && box.bottom <= view.bottom + 1 && box.top - view.top > view.height / 2,
            clearOfScene: box.right < camera.left || box.top > camera.bottom,
            notClipped: (() => { const leg = wrap.querySelector('.tm-legend'), vb = leg.viewBox.baseVal; return Array.from(leg.querySelectorAll('text')).every(t => { const b = t.getBBox(); return b.x + b.width <= vb.x + vb.width; }); })(),
            outer: document.querySelector('.tri-methods-legend').textContent,
        };
    });
    check(legend.everySketch, 'every sketch has the legend, with its labels in order');
    check(legend.bottomLeft, 'it sits at the bottom-left of the card');
    check(legend.clearOfScene, 'it does not overlap the left camera');
    check(legend.notClipped, 'no label is clipped');
    check(legend.white === 'rgb(255, 255, 255)', `predictions are white (${legend.white})`);
    check(!/prediction|reprojection error/.test(legend.outer), 'the legend below the figures no longer repeats them');
    check(/line of sight/.test(lines.legend) && /line from the camera to the projection/.test(lines.legend), 'the legend explains the lines');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
