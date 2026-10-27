/**
 * video-codec-notice.mjs — the note a load leaves when its H.265 videos can't
 * play, saying why and what to change (ui/video-codec-notice.js).
 *
 * The case it was written for: H.265 recordings opened in Chrome on a Windows
 * virtual machine with no GPU. Chrome has no H.265 decoder of its own and plays
 * it only on the GPU, so every view stayed black while the poses loaded, and the
 * only explanation was cut off at the end of a long status line.
 *
 * The test browser is made to look like that machine: an init script hides
 * H.265 from canPlayType and reports WebGL's renderer as "Microsoft Basic Render
 * Driver" (both as measured there). Videos go in through the real File ▸ Load
 * Videos path (`handleLoadVideos`, Playwright's file chooser), as MP4s whose
 * sample description names the codec but holds no media, so the <video>
 * element always rejects them whatever this browser can decode.
 *
 *  1. Basic Render Driver + H.265: the "no GPU" note, its steps and the ffmpeg
 *     command, counted over all the failed files (one note, not one per file).
 *  2. Esc closes it.
 *  3. It waits for another open dialog to close instead of stacking on it.
 *  4. SwiftShader (Chrome's acceleration switched off): the acceleration note.
 *  5. A file that is not a video: status line only, no note.
 *
 * Run: node tests/e2e/video-codec-notice.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8273);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

// ---- MP4s naming a codec, with no decodable media (moov at the end) ----------
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const str = s => [...s].map(c => c.charCodeAt(0));
const box = (type, payload) => u32(8 + payload.length).concat(str(type), payload);
const stsd = t => box('stsd', [0, 0, 0, 0].concat(u32(1), u32(16), str(t), [0, 0, 0, 0, 0, 0, 0, 0]));
function mp4(videoType) {
    const ftyp = box('ftyp', str('isom').concat(u32(512), str('isomiso2')));
    const mdat = box('mdat', new Array(4096).fill(0));
    const moov = box('moov', box('trak', stsd('mp4a')).concat(box('trak', stsd(videoType))));
    return Buffer.from(ftyp.concat(mdat, moov));
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luc3d-codec-notice-'));
const CAMS = ['Camera0_topB', 'Camera1_topC', 'Camera2_sideL'];
const hevcFiles = CAMS.map(c => {
    const p = path.join(dir, c + '.mp4');
    fs.writeFileSync(p, mp4('hvc1'));
    return p;
});
const junk = path.join(dir, 'notes.mp4');
fs.writeFileSync(junk, Buffer.from('not a video at all, just text'));

// What the Windows VM's Chrome reported (Chrome 155, no GPU).
const BASIC = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

function machine(renderer) {
    return `(() => {
        const orig = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (t) {
            return /hvc1|hev1/.test(String(t)) ? '' : orig.call(this, t);
        };
        for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
            if (!C) continue;
            const get = C.prototype.getParameter;
            C.prototype.getParameter = function (p) {
                return p === 0x9246 ? ${JSON.stringify(renderer)} : get.call(this, p);
            };
        }
    })();`;
}

async function openApp(browser, renderer) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.addInitScript(machine(renderer));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    return page;
}

async function loadVideos(page, files) {
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.evaluate(async () => {
            const sl = await import('/loading/session-loader.js');
            window.__loadDone = sl.handleLoadVideos().then(() => true);
        }),
    ]);
    await chooser.setFiles(files);
    await page.evaluate(() => window.__loadDone);
}

const notice = page => page.evaluate(() => {
    const ov = document.getElementById('videoCodecNoticeOverlay');
    if (!ov) return null;
    const btn = document.getElementById('btnVideoCodecNoticeOk');
    const r = btn.getBoundingClientRect();
    return {
        title: ov.querySelector('h3').textContent,
        files: document.getElementById('videoCodecNoticeFiles').textContent,
        why: document.getElementById('videoCodecNoticeWhy').textContent,
        steps: Array.from(ov.querySelectorAll('#videoCodecNoticeSteps li')).map(li => li.textContent),
        command: (ov.querySelector('.video-codec-notice-command') || {}).textContent || '',
        buttonVisible: r.bottom <= window.innerHeight && r.height > 0,
    };
});

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();

    console.log('1. no GPU (Basic Render Driver) + H.265');
    let page = await openApp(browser, BASIC);
    await loadVideos(page, hevcFiles);
    await page.waitForSelector('#videoCodecNoticeOverlay', { timeout: 10000 }).catch(() => {});
    let n = await notice(page);
    check(!!n, 'the note opened');
    if (n) {
        check(n.title === 'This computer has no GPU to play H.265 video', 'title: ' + n.title);
        check(/^3 videos could not be played: Camera0_topB\.mp4, Camera1_topC\.mp4, Camera2_sideL\.mp4\.$/.test(n.files),
            'one note for all three files: ' + n.files);
        check(/no H\.265 decoder of their own/.test(n.why) && /"Microsoft Basic Render Driver"/.test(n.why),
            'why: Chrome needs the GPU, and names the adapter without ANGLE\'s wrapping');
        check(/GPU that decodes H\.265/.test(n.steps[0]) && /driver/.test(n.steps[0]), 'step 1: add a GPU and its driver');
        check(n.steps.some(s => /Remote Desktop/.test(s)), 'Remote Desktop policy step');
        check(n.steps.some(s => /Mac/.test(s)), 'open-elsewhere step');
        check(/^ffmpeg -i "Camera0_topB\.mp4" -c:v libx264 .*-fps_mode passthrough "Camera0_topB_h264\.mp4"$/.test(n.command),
            'ffmpeg command as code: ' + n.command);
        check(n.buttonVisible, 'Got it is on screen');
    }
    const status = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/can only play on a GPU/.test(status), 'status line carries the one-line form (' + status.slice(0, 80) + '…)');
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

    console.log('2. Esc closes it');
    await page.keyboard.press('Escape');
    check(!(await notice(page)), 'closed');
    await page.close();

    console.log('3. waits for another dialog');
    page = await openApp(browser, BASIC);
    await page.evaluate(() => {
        const o = document.createElement('div');
        o.className = 'plane-confirm-overlay';
        o.id = 'someOtherDialog';
        document.body.appendChild(o);
    });
    await loadVideos(page, hevcFiles.slice(0, 1));
    await page.waitForTimeout(300);
    check(!(await notice(page)), 'not stacked on the open dialog');
    await page.evaluate(() => document.getElementById('someOtherDialog').remove());
    await page.waitForSelector('#videoCodecNoticeOverlay', { timeout: 5000 }).catch(() => {});
    n = await notice(page);
    check(!!n && /^1 video could not be played: Camera0_topB\.mp4\.$/.test(n.files), 'opens once it closes: ' + (n && n.files));
    await page.click('#btnVideoCodecNoticeOk');
    check(!(await notice(page)), 'Got it closes it');
    await page.close();

    console.log('4. SwiftShader (acceleration off) + H.265');
    page = await openApp(browser, SWIFTSHADER);
    await loadVideos(page, hevcFiles.slice(0, 2));
    await page.waitForSelector('#videoCodecNoticeOverlay', { timeout: 10000 }).catch(() => {});
    n = await notice(page);
    check(!!n && n.title === 'This browser isn\'t decoding H.265 on the GPU', 'title: ' + (n && n.title));
    check(!!n && /SwiftShader/.test(n.why), 'why names software rendering');
    check(!!n && /graphics acceleration/.test(n.steps[0]), 'step 1: turn on graphics acceleration');
    await page.close();

    console.log('5. not a video: no note');
    page = await openApp(browser, BASIC);
    await loadVideos(page, [junk]);
    await page.waitForTimeout(500);
    check(!(await notice(page)), 'no note for an undiagnosed failure');
    await page.close();
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
