// Screenshots of the Set Origin wizard (investigation tool, not a test).
// OUT_PREFIX=/tmp/origin node tests/e2e/_diag-origin-shot.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const repoRoot = '/Users/joshuapark/Documents/talmolab/repos/luc3d/.claude/worktrees/3d-origin-change';
const PREFIX = process.env.OUT_PREFIX || '/tmp/origin';
const PORT = 8198;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const sp = await import('/ui/sessions-panes.js');
    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
    const cams = ['camA', 'camB'].map((n, i) =>
        new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
    const s = new pd.Session(cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');
    AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
    AS.state.totalFrames = 10;
    AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
    AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
    sp.populateViewStrip();
    AS.paneManager.addAllViewsAsGrid();
});
await page.waitForFunction(() => window.__lucid.state.views.every(v => !!v.overlayCanvas));
await page.click('.menu-item[data-menu="view"]');
await page.click('#menuDefinePlanes');

const TRUTH = [[-60, -45, 210], [60, -45, 214], [66, 40, 220], [-66, 40, 226]];
await page.evaluate(async (TRUTH) => {
    const P = await import('/ui/plane-definition.js');
    const AS = await import('/ui/app-state.js');
    const sk = P.planeState.skeletons[0];
    sk.name = 'floor';
    ['fl', 'fr', 'br', 'bl'].forEach(n => sk.addNode(n));
    [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([a, b]) => sk.addEdge(a, b));
    const cams = AS.state.session.cameras;
    ['camA', 'camB'].forEach(name => {
        const cam = cams.find(c => c.name === name);
        const view = AS.state.views.find(v => v.name === name);
        P.addPlacement(sk, name, view.videoWidth / 2, view.videoHeight / 2);
        P.getPlacementOn(name, sk.id).setPointsFrom(TRUTH.map(q => cam.project(q)));
    });
    sk.filled = true;
    P.refreshPlanePanel();
}, TRUTH);
await page.click('#btnPlaneTriangulate');
await page.click('#btnPlaneFit');
await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    AS.viewport3d.fitToScene();
    document.getElementById('planeEditorDetails').open = false;
});

// Step 1: pick the corner.
await page.click('#btnSetOrigin');
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: PREFIX + '-1-pick-node.png' });

// Step 2: the two candidate arrows.
await page.evaluate(async () => {
    const O = await import('/ui/origin-definition.js');
    const P = await import('/ui/plane-definition.js');
    O.pickOriginNode(P.planeState.skeletons[0].id, 0);
});
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: PREFIX + '-2-pick-axis.png' });

// Step 3: chosen, awaiting confirmation.
await page.evaluate(async () => {
    const O = await import('/ui/origin-definition.js');
    O.pickOriginAxis('positive');
});
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: PREFIX + '-3-confirm.png' });

// Applied: re-based grid + the transform table.
await page.click('#btnOriginContinue');
await new Promise(r => setTimeout(r, 500));
await page.evaluate(() => { document.getElementById('planePanel').scrollTop = 9999; });
await new Promise(r => setTimeout(r, 200));
await page.screenshot({ path: PREFIX + '-4-applied.png' });

console.log('wrote', PREFIX + '-{1..4}-*.png');
await browser.close();
server.kill();
