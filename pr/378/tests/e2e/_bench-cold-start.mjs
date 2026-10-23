/**
 * _bench-cold-start.mjs — time a deployed LUCID's COLD start, as many times as you
 * like, through the real CDN path. An investigation tool, not an assertion.
 *
 *   node tests/e2e/_bench-cold-start.mjs https://luc3d.sleap.ai/dev/ https://luc3d.sleap.ai/pr/335/
 *
 * A real cold start happens once per deploy per Cloudflare data centre (every
 * deploy changes every `?v=` URL), so it cannot simply be repeated. This makes
 * every load cold anyway: each run adds a fresh `cb=` query to every request to the
 * page's own host, IN FLIGHT (Playwright route), so Cloudflare sees URLs it has
 * never cached and goes to the GitHub Pages origin, while the page still sees its
 * own URLs (module identity and modulepreload matching are untouched). Each run is
 * a new browser context, so the browser cache is empty too. CDN dependencies on
 * other hosts (jsdelivr) are left alone — they are shared by every build.
 *
 * Ready = `window.__lucid.state` exists and "Initializing" has left the page.
 * URLs are interleaved (and reversed every other round) so a change in network
 * conditions lands on all of them alike.
 *
 * Env: RUNS (default 5) rounds; PAUSE ms between rounds; LAT ms of extra latency
 * per request (DevTools emulation — e.g. 150 to approximate a VPN); BUST=0 to
 * measure the CDN as it is instead (cold only on a build's first visit).
 * Headless, so it does not need scripts/browser-lock.mjs.
 */
import { chromium } from 'playwright';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage: node tests/e2e/_bench-cold-start.mjs <url> [<url> …]'); process.exit(2); }
const RUNS = Number(process.env.RUNS || 5), PAUSE = Number(process.env.PAUSE || 0), LAT = Number(process.env.LAT || 0);
const BUST = process.env.BUST !== '0';
const strip = (u) => u.replace(/[?&]cb=[^&]*/, '');

const browser = await chromium.launch();
const results = new Map(urls.map(u => [u, []]));
for (let run = 0; run < RUNS; run++) {
    if (run && PAUSE) await new Promise(r => setTimeout(r, PAUSE));
    for (const url of (run % 2 ? [...urls].reverse() : urls)) {
        const host = new URL(url).host, cb = 'cb' + Date.now().toString(36) + run;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        if (LAT) {
            const cdp = await ctx.newCDPSession(page);
            await cdp.send('Network.enable');
            await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LAT, downloadThroughput: -1, uploadThroughput: -1 });
        }
        if (BUST) await page.route(u => u.host === host, r => { const u = new URL(r.request().url()); u.searchParams.set('cb', cb); r.continue({ url: u.href }); });
        const cf = new Map();
        page.on('response', r => cf.set(strip(r.url()), r.headers()['cf-cache-status'] || '-'));
        const t0 = Date.now();
        let ms = NaN;
        try {
            await page.goto(url, { timeout: 120000 });
            await page.waitForFunction(() => window.__lucid && window.__lucid.state && !document.body.innerText.includes('Initializing'), null, { timeout: 120000, polling: 50 });
            ms = Date.now() - t0;
        } catch (e) { console.log('  ' + String(e).split('\n')[0]); }
        const ents = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ n: e.name, s: e.startTime, d: e.duration })));
        const own = ents.filter(e => new URL(e.n).host === host);
        const counts = {};
        for (const v of cf.values()) counts[v] = (counts[v] || 0) + 1;
        const slow = ents.sort((a, b) => b.d - a.d).slice(0, 2)
            .map(e => `${(e.d / 1000).toFixed(2)}s ${new URL(e.n).pathname}${cf.has(strip(e.n)) ? ' ' + cf.get(strip(e.n)) : ''}`);
        console.log(`${new Date().toISOString().slice(11, 19)} run ${run + 1} ${url}: ${(ms / 1000).toFixed(2)} s — ` +
            `${own.length} own-host requests (${own.filter(e => e.d > 1000).length} over 1 s), cf ${JSON.stringify(counts)}; slowest: ${slow.join(' | ')}`);
        results.get(url).push(ms);
        await ctx.close();
    }
}
await browser.close();
console.log('');
for (const [u, a] of results) {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y);
    const med = s.length ? s[s.length >> 1] / 1000 : NaN;
    console.log(`${u}: median ${med.toFixed(2)} s, min ${(s[0] / 1000).toFixed(2)}, max ${(s.at(-1) / 1000).toFixed(2)}, ` +
        `${a.length - s.length} timed out  [${a.map(x => (x / 1000).toFixed(2)).join(', ')}]`);
}
