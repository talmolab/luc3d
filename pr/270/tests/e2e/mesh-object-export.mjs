/**
 * mesh-object-export.mjs — the two Export buttons in the 3D Mesh Objects block.
 *
 * `tests/test-mesh-export.mjs` pins the byte layouts away from the DOM. This
 * file pins what only the real app can show:
 *
 *  1. Both buttons are DISABLED until the selected object has a shape, and the
 *     tooltip says why rather than leaving a dead-looking button.
 *  2. Clicking each one downloads a real file, named after the object, and the
 *     bytes that arrive parse as the format they claim to be.
 *  3. The file describes the SAME geometry the panel's own report does — a
 *     cage whose badge says 4 faces cannot export 3.
 *  4. The defined origin reaches the file. The panel reports in that frame, so
 *     an export in the calibration frame would silently disagree with it.
 *
 * The axis claim carries its negative control, because it is the one a reader
 * of the project's "no axis conversion" rule is most likely to undo: the same
 * corner is asserted to be Z-up in the .stl AND Y-up in the .glb, so a writer
 * that treated them alike would fail one of the two whichever way it went.
 *
 * Run: node mesh-object-export.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8231);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, eps, m) => check(Math.abs(a - b) <= eps, `${m} (${a} vs ${b})`);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ acceptDownloads: true });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- a cage with a known corner, built through the real model ----------
    // (0, 0, 300) is 300mm straight UP in LUCID. Every axis assertion below
    // tracks that one corner through both writers.
    const setup = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const MO = await import('/ui/mesh-objects.js');
        const PM = await import('/import-export/plane-metadata.js');

        PM.resetPlaneState();
        // Open the panel for real. The buttons are clicked through Playwright,
        // which refuses an invisible target — so this also keeps the test
        // honest about the buttons being REACHABLE, not merely present.
        P.enterPlaneMode();
        const model = P.planeModel();
        const mk = (name, xyz) => { const n = model.addNode(name); n.setPoint3d(xyz); return n; };
        const c0 = mk('c0', [0, 0, 0]);
        const c1 = mk('c1', [200, 0, 0]);
        const c2 = mk('c2', [200, 100, 0]);
        const c3 = mk('c3', [0, 100, 0]);
        const top = mk('top', [0, 0, 300]);       // the tracked corner

        const ring = (plane, nodes) => {
            nodes.forEach(n => model.addNodeToPlane(plane, n.id));
            for (let i = 0; i < nodes.length; i++) {
                plane.addEdge(nodes[i].id, nodes[(i + 1) % nodes.length].id);
            }
        };
        const floor = P.createPlane('floor');
        const wall = P.createPlane('wall');
        ring(floor, [c0, c1, c2, c3]);
        ring(wall, [c0, c3, top]);                // shares the c0-c3 edge

        P.refreshPlanePanel();
        MO.refreshMeshObjectsPanel();
        return { planes: model.planes.length, nodes: model.pool.nodes.length };
    });
    console.log('\n§1 the buttons exist and gate on having a shape');
    check(setup.planes === 2 && setup.nodes === 5,
        `built a 2-plane cage on 5 nodes (got ${setup.planes}/${setup.nodes})`);

    const before = await page.evaluate(() => {
        const stl = document.getElementById('btnExportMeshStl');
        const glb = document.getElementById('btnExportMeshGlb');
        return {
            present: !!stl && !!glb,
            inMeshBlock: !!(stl && document.getElementById('meshObjectsDetails').contains(stl)),
            // With nothing selected the whole editor is hidden, so the buttons
            // are unreachable rather than merely disabled.
            editorHidden: document.getElementById('meshObjectEditor').style.display === 'none',
            labels: [stl && stl.textContent.trim(), glb && glb.textContent.trim()],
        };
    });
    check(before.present, 'both buttons are in the markup');
    check(before.inMeshBlock, 'and inside the 3D Mesh Objects block');
    check(before.editorHidden, 'with no object selected the editor — and so the buttons — is hidden');
    check(before.labels[0] === 'Export .stl' && before.labels[1] === 'Export .glb',
        `labelled by format (got ${JSON.stringify(before.labels)})`);

    // An object with NO planes has no triangles: the buttons must say so.
    const empty = await page.evaluate(async () => {
        const MO = await import('/ui/mesh-objects.js');
        document.getElementById('btnNewMeshObject').click();
        MO.refreshMeshObjectsPanel();
        const stl = document.getElementById('btnExportMeshStl');
        return { disabled: stl.disabled, title: stl.title };
    });
    check(empty.disabled, 'an object with no planes leaves the buttons disabled');
    check(/no triangulated faces/i.test(empty.title),
        `and the tooltip says why (got "${empty.title.slice(0, 60)}…")`);

    // Give it the two planes.
    const ready = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const MO = await import('/ui/mesh-objects.js');
        const model = P.planeModel();
        const obj = model.meshObjects.objects[0];
        model.planes.forEach(p => obj.addPlane(p.id));
        obj.name = 'cage #1';
        obj.color = '#3366cc';
        MO.refreshMeshObjectsPanel();
        const geo = MO.meshObjectGeometry(obj);
        return {
            disabled: document.getElementById('btnExportMeshStl').disabled,
            triangles: geo.triangles.length / 3,
            vertices: geo.connectivity.vertices,
            faces: geo.connectivity.faces,
        };
    });
    check(!ready.disabled, 'adding planes enables the buttons');
    check(ready.faces === 2 && ready.vertices === 5,
        `the panel reports 2 faces on 5 welded vertices (got ${ready.faces}/${ready.vertices})`);
    check(ready.triangles === 3,
        `which ear-clips to 3 triangles — a quad plus a tri (got ${ready.triangles})`);

    // ---- §2 the files --------------------------------------------------
    console.log('\n§2 both buttons download a real file');
    async function clickAndRead(id) {
        const wait = page.waitForEvent('download', { timeout: 20000 });
        await page.click('#' + id);
        const dl = await wait;
        const tmp = path.join(repoRoot, 'tests', 'e2e', '.tmp-' + dl.suggestedFilename());
        await dl.saveAs(tmp);
        const bytes = await readFile(tmp);
        await (await import('node:fs/promises')).unlink(tmp);
        return { name: dl.suggestedFilename(), bytes };
    }
    const stlFile = await clickAndRead('btnExportMeshStl');
    const glbFile = await clickAndRead('btnExportMeshGlb');

    check(stlFile.name === 'cage_#1.stl',
        `the .stl is named after the object, with the slash-unsafe bits fixed (got "${stlFile.name}")`);
    check(glbFile.name === 'cage_#1.glb', `and the .glb likewise (got "${glbFile.name}")`);

    const sv = new DataView(stlFile.bytes.buffer, stlFile.bytes.byteOffset, stlFile.bytes.byteLength);
    check(stlFile.bytes.byteLength === 84 + 3 * 50,
        `the .stl is exactly 84 + 50x3 bytes (got ${stlFile.bytes.byteLength})`);
    check(sv.getUint32(80, true) === 3,
        `and declares the same 3 triangles the panel reported (got ${sv.getUint32(80, true)})`);

    const gv = new DataView(glbFile.bytes.buffer, glbFile.bytes.byteOffset, glbFile.bytes.byteLength);
    check(gv.getUint32(0, true) === 0x46546C67, 'the .glb starts with the glTF magic');
    check(gv.getUint32(8, true) === glbFile.bytes.byteLength, 'and its declared length is the real one');
    const jsonLen = gv.getUint32(12, true);
    const doc = JSON.parse(new TextDecoder().decode(
        glbFile.bytes.subarray(20, 20 + jsonLen)));
    check(doc.accessors[0].count === 5,
        `the .glb keeps the 5 WELDED vertices, not 9 loose corners (got ${doc.accessors[0].count})`);
    check(doc.accessors[1].count === 9, `and 9 indices for 3 triangles (got ${doc.accessors[1].count})`);
    check(doc.nodes[0].name === 'cage #1',
        `the object's real name rides along inside the file (got "${doc.nodes[0].name}")`);

    // ---- §3 the axes, each with the other as its control -------------------
    console.log('\n§3 STL stays Z-up, GLB is converted to Y-up');
    // The tracked corner is the only one 300mm from the floor plane, so find it
    // by the LARGEST vertical component — not by distance from the origin,
    // which the (200,100,0) floor corner also satisfies.
    let stlTop = null;
    for (let t = 0; t < 3; t++) {
        for (let k = 0; k < 3; k++) {
            const off = 84 + t * 50 + 12 + k * 12;
            const v = [sv.getFloat32(off, true), sv.getFloat32(off + 4, true), sv.getFloat32(off + 8, true)];
            const height = Math.max(Math.abs(v[1]), Math.abs(v[2]));
            if (!stlTop || height > Math.max(Math.abs(stlTop[1]), Math.abs(stlTop[2]))) stlTop = v;
        }
    }
    check(!!stlTop, 'the 300mm corner is present in the .stl');
    near(stlTop[2], 300, 1e-3, 'the .stl keeps it on +Z — CAD gets LUCID millimetres verbatim');
    near(stlTop[1], 0, 1e-3, 'with nothing in Y');

    const binStart = 20 + jsonLen;
    const pos = new Float32Array(glbFile.bytes.buffer.slice(
        glbFile.bytes.byteOffset + binStart + 8 + doc.bufferViews[0].byteOffset,
        glbFile.bytes.byteOffset + binStart + 8 + doc.bufferViews[0].byteOffset + doc.bufferViews[0].byteLength));
    let glbTop = null;
    for (let i = 0; i < pos.length; i += 3) {
        const v = [pos[i], pos[i + 1], pos[i + 2]];
        const height = Math.max(Math.abs(v[1]), Math.abs(v[2]));
        if (!glbTop || height > Math.max(Math.abs(glbTop[1]), Math.abs(glbTop[2]))) glbTop = v;
    }
    check(!!glbTop, 'and in the .glb');
    near(glbTop[1], 300, 1e-3, 'the .glb puts it on +Y, the up axis glTF mandates');
    near(glbTop[2], 0, 1e-3, 'and leaves nothing in Z');
    check(Math.abs(stlTop[2] - glbTop[2]) > 100,
        'the two files genuinely differ on this corner — a writer treating them alike fails one of them');

    // ---- §4 the defined origin reaches the file ---------------------------
    console.log('\n§4 the export follows the defined origin, like the panel does');
    const framed = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const OF = await import('/pose/origin-frame.js');
        const MO = await import('/ui/mesh-objects.js');
        const P = await import('/ui/plane-definition.js');
        // Put the origin at the 200mm corner, +Z unchanged.
        O.originState.frame = OF.buildOriginFrame([200, 0, 0], [0, 0, 1]);
        const obj = P.planeModel().meshObjects.objects[0];
        const geo = MO.meshObjectGeometry(obj);
        // c1 = (200,0,0) is the new origin, so it must now sit at zero.
        let best = Infinity;
        for (let i = 0; i < geo.vertices.length; i += 3) {
            best = Math.min(best, Math.hypot(geo.vertices[i], geo.vertices[i + 1], geo.vertices[i + 2]));
        }
        return { closestToOrigin: best };
    });
    near(framed.closestToOrigin, 0, 1e-9,
        'with an origin set, the corner it was placed on sits at (0,0,0) in the exported geometry');

    const stl2 = await clickAndRead('btnExportMeshStl');
    const sv2 = new DataView(stl2.bytes.buffer, stl2.bytes.byteOffset, stl2.bytes.byteLength);
    let hasOrigin = false;
    for (let t = 0; t < 3; t++) {
        for (let k = 0; k < 3; k++) {
            const off = 84 + t * 50 + 12 + k * 12;
            if (Math.hypot(sv2.getFloat32(off, true), sv2.getFloat32(off + 4, true),
                sv2.getFloat32(off + 8, true)) < 1e-3) hasOrigin = true;
        }
    }
    check(hasOrigin, 'and that re-based corner is what lands in the .stl — not the calibration-frame one');

    // ---- §5 export changes nothing ----------------------------------------
    console.log('\n§5 exporting is read-only');
    const clean = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const P = await import('/ui/plane-definition.js');
        saveLoad.clearDirty();
        document.getElementById('btnExportMeshGlb').click();
        const model = P.planeModel();
        return {
            dirty: window.__lucid.state.isDirty,
            planes: model.planes.length,
            nodes: model.pool.nodes.length,
        };
    });
    await page.waitForTimeout(400);
    check(!clean.dirty, 'an export does not mark the project unsaved — it writes a file, not a change');
    check(clean.planes === 2 && clean.nodes === 5, 'and leaves the model exactly as it was');
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} failure(s)` : '\nPASS');
process.exit(fails ? 1 : 0);
