/**
 * Rasterize a figure SVG through headless Chromium: PNG at a chosen DPI, plus PDF.
 *
 * Chromium is the renderer because the SVGs reference the exported PNG tiles by
 * relative URL (kept out of the SVG so the file stays small and the crops stay
 * editable) -- so they must be fetched over the dev server, not read from a
 * standalone rasterizer. It is also the same engine that produced the tiles.
 *
 * Usage: node figs/render.mjs figs/out/fig1.svg [dpi]      (default 600 dpi)
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { serve, repoRoot, log } from './_drive.mjs';

const svgArg = process.argv[2];
if (!svgArg) { console.error('usage: node figs/render.mjs <file.svg> [dpi]'); process.exit(2); }
const DPI = Number(process.argv[3] || 600);
const PORT = Number(process.env.PORT || 8086);

const svgPath = path.resolve(svgArg);
const rel = path.relative(repoRoot, svgPath).split(path.sep).join('/');
const svg = fs.readFileSync(svgPath, 'utf8');
const mm = svg.match(/width="([\d.]+)mm"\s+height="([\d.]+)mm"/);
if (!mm) { console.error('SVG has no mm width/height'); process.exit(2); }
const [wMM, hMM] = [Number(mm[1]), Number(mm[2])];
const scale = DPI / 25.4;                 // css px per mm at 96 dpi is 96/25.4
const cssW = Math.round(wMM * 96 / 25.4);
const cssH = Math.round(hMM * 96 / 25.4);
const dsf = DPI / 96;

const server = await serve(PORT);
const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
try {
    const page = await browser.newPage({
        viewport: { width: cssW, height: cssH },
        deviceScaleFactor: dsf,
    });
    page.on('requestfailed', r => log('  [missing] ' + r.url()));
    // Inline the SVG into an HTML page that sits NEXT TO the tiles: an <img
    // src="...svg"> refuses to load the SVG's external image hrefs, and navigating
    // straight to the .svg gives a document with no <body> to style. Writing the
    // wrapper into the same directory makes the relative hrefs resolve.
    const htmlPath = svgPath.replace(/\.svg$/, '.render.html');
    fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style>` + svg);
    const htmlRel = path.relative(repoRoot, htmlPath).split(path.sep).join('/');
    await page.goto(`http://localhost:${PORT}/${htmlRel}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    const png = svgPath.replace(/\.svg$/, `.png`);
    const el = await page.$('svg');
    await (el || page).screenshot({ path: png });
    log(`[png] ${path.relative(repoRoot, png)}  ${wMM}x${hMM} mm @ ${DPI} dpi ` +
        `(${Math.round(cssW * dsf)}x${Math.round(cssH * dsf)} px)  ` +
        `${(fs.statSync(png).size / 1024).toFixed(0)} KB`);

    const pdf = svgPath.replace(/\.svg$/, '.pdf');
    await page.pdf({ path: pdf, width: `${wMM}mm`, height: `${hMM}mm`,
                     printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    log(`[pdf] ${path.relative(repoRoot, pdf)}  ${(fs.statSync(pdf).size / 1024).toFixed(0)} KB`);
} finally {
    await browser.close();
    if (server) server.kill();
}
