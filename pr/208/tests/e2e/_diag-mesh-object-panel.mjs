/**
 * _diag-mesh-object-panel.mjs — screenshot the 3D Mesh Objects table.
 * Investigation tool, not an assertion. OUT=<path> to choose the file.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8231);
const OUT = process.env.OUT || '/tmp/mesh-object-panel.png';

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const P = await import('/ui/plane-definition.js');
    const MO = await import('/ui/mesh-objects.js');
    const pd = await import('/pose/pose-data.js');
    AS.state.session = new pd.Session([], new pd.Skeleton('s', ['a'], []), ['t'], 'demo');
    AS.state.sessions = [AS.state.session];
    const m = P.planeModel();
    const mk = (n, p) => { const x = m.addNode(n); x.setPoint3d(p); return x; };
    const c = [mk('c0',[0,0,0]),mk('c1',[1,0,0]),mk('c2',[1,1,0]),mk('c3',[0,1,0]),
               mk('c4',[0,1,1]),mk('c5',[1,1,1]),mk('c6',[0,0,1])];
    const ring = (pl, ns) => { ns.forEach(n=>m.addNodeToPlane(pl,n.id));
        for (let i=0;i<ns.length;i++) pl.addEdge(ns[i].id, ns[(i+1)%ns.length].id); };
    ring(P.createPlane('floor'), [c[0],c[1],c[2],c[3]]);
    ring(P.createPlane('back'),  [c[3],c[2],c[5],c[4]]);
    ring(P.createPlane('side'),  [c[0],c[3],c[4],c[6]]);
    const lone = P.createPlane('lonely');
    ring(lone, [mk('l0',[9,9,0]), mk('l1',[10,9,0]), mk('l2',[10,10,0])]);

    const cage = m.meshObjects.createObject('cage');
    m.planes.slice(0,3).forEach(p => cage.addPlane(p.id));
    const bad = m.meshObjects.createObject('not joined');
    bad.addPlane(m.planes[0].id); bad.addPlane(lone.id);

    document.getElementById('planePanel').style.display = '';
    document.getElementById('meshObjectsDetails').open = true;
    document.getElementById('planeNodesDetails').open = false;
    document.getElementById('planeEditorDetails').open = false;
    document.getElementById('planePlanesDetails').open = false;
    MO.meshObjectState.selectedObjectId = cage.id;
    P.refreshPlanePanel();
});
await new Promise(r => setTimeout(r, 400));
const dims = await page.evaluate(() => {
    const m = document.getElementById('meshObjectMembers');
    return { rows: m.children.length, clientH: m.clientHeight, scrollH: m.scrollHeight };
});
console.log('members', JSON.stringify(dims));
const target = process.env.SEL || '#meshObjectsDetails';
const el = await page.$(target);
await el.screenshot({ path: OUT });
console.log('wrote ' + OUT);
await browser.close(); server.kill();
