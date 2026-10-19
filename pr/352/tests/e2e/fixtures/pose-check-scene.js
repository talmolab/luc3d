/**
 * pose-check-scene.js — the planted-outlier scene the 2D pose check's e2e tests
 * share (tests/e2e/track-all-pose-check.mjs, tests/e2e/check-poses-command.mjs),
 * and the probes they read it with.
 *
 * Two articulated animals (head and tail swing, pixel noise) in front of three
 * calibrated cameras for 65 s at 30 fps, every prediction ungrouped as a load
 * leaves it. Planted in it, four outlier predictions (`PLANTED`, each tagged
 * `__planted` on its Instance): animal 0's back half drawn on animal 1 in c0 at
 * frames 300, 900 and 1,500, and animal 1's nodes scattered over its box in c1
 * at 1,200. (c2 sees both animals off-image, so nothing is planted there.)
 *
 * Node-side (Playwright): `installPoseCheckScene(page)` defines
 * `window.__build()` in the page, which (re)builds the session and sets its
 * animal count to 2, so Track All asks nothing.
 */

export const PLANTED = [{ cam: 'c0', frame: 300, animal: 0 }, { cam: 'c0', frame: 900, animal: 0 },
    { cam: 'c0', frame: 1500, animal: 0 }, { cam: 'c1', frame: 1200, animal: 1 }];

/** Define `window.__build()` in the page (see the module comment). */
export async function installPoseCheckScene(page) {
    await page.evaluate(async (PLANTED) => {
        window.__build = async () => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const HEAD = ['Nose', 'Ear_R', 'Ear_L', 'Head'], TAIL = ['Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
            const BACK = ['TTI', 'Haunch_left', 'Haunch_right', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
            let seed = 7;
            const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], 'pose');
            const FRAMES = 65 * 30, SC = [0.05, 0.06];
            // Rotate a body-frame point about a pivot in the xy plane (head and tail swing).
            const swing = (p, piv, a) => { const c = Math.cos(a), sn = Math.sin(a), x = p[0] - piv[0], y = p[1] - piv[1]; return [piv[0] + c * x - sn * y, piv[1] + sn * x + c * y, p[2]]; };
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                const proj = [[], []];
                [[-8, 0, 48], [8, 0, 48]].forEach((c0, ai) => {
                    const ctr = [c0[0] + 0.6 * Math.sin(f / 90 + ai), c0[1] + 0.6 * Math.cos(f / 70 + ai), c0[2]];
                    const h = f / 200 + ai * 2, ch = Math.cos(h), sh = Math.sin(h);
                    const tailA = 0.5 * Math.sin(f / 37 + ai), headA = 0.35 * Math.sin(f / 53 + 2 * ai);
                    const pts3 = NODES.map(n => {
                        let b = T[n];
                        if (TAIL.includes(n)) b = swing(b, T.TTI, tailA);
                        if (HEAD.includes(n)) b = swing(b, T.Neck, headA);
                        const [x, y, z] = b.map(v => v * SC[ai]);
                        return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z];
                    });
                    CAMS.forEach((c, ci) => { proj[ai][ci] = pts3.map(p => { const q = c.project(p); return [q[0] + 0.5 * gauss(), q[1] + 0.5 * gauss()]; }); });
                });
                for (const pl of PLANTED) {
                    if (pl.frame !== f) continue;
                    const ci = CAMS.findIndex(c => c.name === pl.cam), own = proj[pl.animal][ci], other = proj[1 - pl.animal][ci];
                    if (pl.cam === 'c0') {
                        BACK.forEach(n => { const k = NODES.indexOf(n); own[k] = other[k].slice(); });   // back half on the other animal
                    } else {
                        const xs = own.map(p => p[0]), ys = own.map(p => p[1]);
                        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
                        for (let k = 0; k < own.length; k++) own[k] = [x0 + (x1 - x0) * rnd(), y0 + (y1 - y0) * rnd()];
                    }
                }
                CAMS.forEach((c, ci) => [0, 1].forEach(ai => {
                    const inst = new pd.Instance(proj[ai][ci], ai, 'predicted', 1.0);
                    if (PLANTED.some(pl => pl.frame === f && pl.cam === c.name && pl.animal === ai)) inst.__planted = true;
                    fg.addUnlinkedInstance(c.name, new pd.UnlinkedInstance(inst, c.name));   // as a load leaves predictions: ungrouped
                }));
                s.addFrameGroup(fg);
            }
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
            AS.state.triangulationResults = new Map();
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            (await import('/pose/tracker.js')).setTrackerNumAnimals(2);
        };
    }, PLANTED);
}

export const RED = '#ff3b30', AMBER = '#ffb300';

// Where each planted detection ended up: in a group (its identity) or in the ungrouped pool.
export const planted = (page) => page.evaluate(() => {
    const s = window.__lucid.state.session, out = [];
    for (const fi of s.frameIndices) {
        const fg = s.getFrameGroup(fi);
        for (const cam of ['c0', 'c1', 'c2']) {
            const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
            for (const inst of all) {
                if (!inst.__planted) continue;
                const groups = s.instanceGroups.get(fi) || [];
                const g = groups.find(gr => gr.getInstance(cam) === inst);
                // the planted animal's group in the other views this frame
                const others = groups.filter(gr => gr !== g && ['c0', 'c1', 'c2'].filter(c => c !== cam).some(c => gr.getInstance(c) && gr.getInstance(c).trackIdx === inst.trackIdx));
                out.push({ frame: fi, cam, grouped: !!g, unlinked: (fg.getUnlinkedInstances(cam) || []).some(u => u.instance === inst),
                    trackedElsewhere: others.length > 0 });
            }
        }
    }
    return out;
});

// One view per camera on screen (the scene has no videos), redrawn on `frame`.
export const showViews = (page, frame) => page.evaluate(async (frame) => {
    const AS = await import('/ui/app-state.js'), sp = await import('/ui/sessions-panes.js'), R = await import('/ui/rendering.js');
    const cams = ['c0', 'c1', 'c2'];
    AS.state.currentFrame = frame; AS.state.isPlaying = false;
    AS.state.views = cams.map(n => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: 1950, canvas: null }));
    AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
    AS.state.viewMode = 'grid'; AS.state.singleViewIndex = 0;
    AS.paneManager.clearAll(); sp.populateViewStrip(); AS.paneManager.addAllViewsAsGrid();
    await new Promise(r => requestAnimationFrame(r));
    sp.refreshPaneInteractions();
    await new Promise(r => requestAnimationFrame(r));
    R.drawAllOverlays(frame);
}, frame);
// Pixels of a badge color in a box just outside the planted (or a clean) pose's bottom-right corner.
export const badgePixels = (page, cam, frame, which, color) => page.evaluate(async ([cam, frame, which, color]) => {
    const AS = await import('/ui/app-state.js'), R = await import('/ui/rendering.js');
    AS.state.currentFrame = frame; R.drawAllOverlays(frame);
    const v = AS.state.views.find(w => w.name === cam), cv = v.overlayCanvas;
    const fg = AS.state.session.getFrameGroup(frame);
    const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
    const inst = which === 'planted' ? all.find(i => i.__planted) : all.find(i => !i.__planted);
    const sx = cv.width / v.videoWidth, sy = cv.height / v.videoHeight;
    let x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < inst.numNodes; k++) { x1 = Math.max(x1, inst.getX(k) * sx); y1 = Math.max(y1, inst.getY(k) * sy); }
    const R0 = 40, data = cv.getContext('2d').getImageData(Math.round(x1 - 6), Math.round(y1 - 6), R0, R0).data;
    const [cr, cg, cb] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && Math.abs(data[i] - cr) < 12 && Math.abs(data[i + 1] - cg) < 12 && Math.abs(data[i + 2] - cb) < 12) n++;
    return n;
}, [cam, frame, which, color]);
// The node tooltip after real mouse moves onto a node of the planted (or a clean) pose.
export const tipOn = async (page, cam, frame, which) => {
    const xy = await page.evaluate(async ([cam, frame, which]) => {
        const AS = await import('/ui/app-state.js'), R = await import('/ui/rendering.js');
        AS.state.currentFrame = frame; R.drawAllOverlays(frame);
        const v = AS.state.views.find(w => w.name === cam);
        const fg = AS.state.session.getFrameGroup(frame);
        const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
        const inst = which === 'planted' ? all.find(i => i.__planted) : all.find(i => !i.__planted);
        const k = 5;   // Head: on the planted c0 poses it is the animal's own (the tip names whichever node is nearest)
        const r = v.overlayCanvas.getBoundingClientRect();
        return [r.left + inst.getX(k) / v.videoWidth * r.width, r.top + inst.getY(k) / v.videoHeight * r.height];
    }, [cam, frame, which]);
    await page.mouse.move(xy[0] + 30, xy[1] + 30);
    await page.mouse.move(xy[0], xy[1]);
    await page.waitForTimeout(900);
    const t = await page.evaluate(() => { const el = document.getElementById('nodeTip'); return el && !el.hidden ? el.innerText : ''; });
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    return t;
};
