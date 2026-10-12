/**
 * plane-section-info.mjs — a major section's explanation is an ⓘ beside its
 * HEADING, not a paragraph under its table.
 *
 * Each of Nodes, Node Connections, Planes and 3D Mesh Objects used to end in a
 * `.plane-hint` block of prose. In a ~300px column that is a wall of text
 * permanently wedged between one table and the next, read once and then scenery
 * forever — and it is at the FOOT of the section, so it answers "what is this?"
 * after the user has already scrolled past whatever they were unsure about.
 *
 * As an ⓘ in the `<summary>` the same sentence costs 16px, sits where the
 * question is asked, and is reachable while the section is COLLAPSED, which is
 * exactly when "what was this one again?" comes up.
 *
 * Five things this pins:
 *
 *  1. The four majors carry their ⓘ, with the right text, and the paragraphs
 *     are GONE — moving the text and leaving the block behind would double it.
 *  2. Clicking an ⓘ does NOT fold the section it heads — while the heading
 *     BESIDE it still does. The icon sits inside the <summary> that folds the
 *     very section being asked about, so the two have to be told apart.
 *  3. The sections that were told to LOSE their text have neither a paragraph
 *     nor an ⓘ: Danger Zone, and the "+ Add" line under Nodes In This Plane.
 *  4. The Planes section has exactly ONE labelled row and it says "Name", with
 *     `+ New Plane` above it — no plane dropdown survives anywhere in the
 *     section, because the roster is what selects.
 *  5. The member-node names are indented off the table's left edge, clear of
 *     the 2px accent bar `.plane-node-shared` paints inside the row.
 * The connectivity report's own de-prosing — it no longer discusses normals,
 * since winding is DERIVED (`pose/mesh-object-geometry.js`) and so was the
 * longest line in the box and the one nobody could act on — is pinned in
 * `tests/e2e/mesh-object-roundtrip.mjs` §2 instead, which has a real three-plane
 * cage to report on. Asserting it here, where no object has triangulated nodes,
 * would pass against "Nothing to build yet" and mean nothing.
 *
 * Run: node plane-section-info.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8248);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Plane Mode, with a node and a plane so every section has real content —
    // Node Connections is part of the selected plane and is not rendered at all
    // until there is one.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        document.getElementById('planeNodeNameInput').value = 'corner';
        document.getElementById('btnAddPlaneNode').click();
        P.createPlane('floor');
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(300);

    const tip = () => page.evaluate(() => {
        const el = document.getElementById('infoTip');
        if (!el) return { exists: false };
        return { exists: true, shown: !el.hidden, text: el.textContent };
    });

    const infoOf = id => page.evaluate(i => {
        const el = document.getElementById(i);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
            text: el.dataset.infotip || '',
            title: el.getAttribute('title'),
            aria: el.getAttribute('aria-label'),
            hasIcon: !!el.querySelector('svg'),
            inSummary: !!el.closest('summary'),
            section: el.closest('details') ? el.closest('details').id : null,
            w: b.width, h: b.height,
        };
    }, id);

    // =========================================================
    console.log('\n--- 1. Every major section has its ⓘ, in its heading ---');
    // =========================================================
    const EXPECT = {
        planeNodesInfo: { section: 'planeNodesDetails', must: /Define nodes here/ },
        planeEdgesInfo: { section: 'planeEdgesDetails', must: /purely for visual representation/ },
        planePlanesInfo: { section: 'planePlanesDetails', must: /Place a plane into a video view/ },
        meshObjectsInfo: { section: 'meshObjectsDetails', must: /group of planes/ },
    };
    for (const id of Object.keys(EXPECT)) {
        const got = await infoOf(id);
        check(got !== null, `#${id} exists`);
        if (!got) continue;
        check(got.hasIcon === true, `  it draws the ⓘ glyph`);
        check(got.inSummary === true, `  and sits in the <summary>, so a folded section still has it`);
        check(got.section === EXPECT[id].section, `  in ${EXPECT[id].section} (got ${got.section})`);
        check(EXPECT[id].must.test(got.text), `  with its text: ${JSON.stringify(got.text.slice(0, 45))}`);
        check(got.title === null, `  and no native title to say it twice`);
        check(!!got.aria && got.aria.length > 0, `  while aria-label keeps it reachable`);
        check(got.w > 0 && got.h > 0, `  and it has a box to hover`);
    }

    // =========================================================
    console.log('\n--- 2. The paragraphs are GONE ---');
    // =========================================================
    const hints = await page.evaluate(() => {
        // Only hints with STANDING text. `planeAddNodeHint` and
        // `meshObjectAddPlaneHint` are empty-state lines that are blank in the
        // ordinary case, and "Planes in this object" is a list label.
        return [...document.querySelectorAll('.plane-panel .plane-hint')]
            .map(el => ({ id: el.id, text: el.textContent.trim() }))
            .filter(h => h.text.length > 0);
    });
    check(!hints.some(h => /Nodes are project-wide/.test(h.text)),
        'the Nodes paragraph is not also still under the table');
    check(!hints.some(h => /Connections are OPTIONAL/.test(h.text)),
        'nor the Node Connections one');
    check(!hints.some(h => /Drag a row onto a video view/.test(h.text)),
        'nor the Planes one');
    check(!hints.some(h => /shape comes from the nodes they SHARE/.test(h.text)),
        'nor the 3D Mesh Objects one');
    check(hints.length <= 1,
        'and what remains is at most the list label: ' + JSON.stringify(hints.map(h => h.text.slice(0, 30))));

    // =========================================================
    console.log('\n--- 3. Hovering an ⓘ shows it; leaving hides it ---');
    // =========================================================
    // The plane panel scrolls, and a section low in it has a bounding box
    // outside the viewport — a click there lands on nothing and every assertion
    // afterwards would pass for the wrong reason.
    const boxOf = async sel => {
        const h = await page.$(sel);
        await h.scrollIntoViewIfNeeded();
        await page.waitForTimeout(120);
        return h.boundingBox();
    };

    const box = await boxOf('#planeNodesInfo');
    check(box !== null && box.width > 0, 'the Nodes ⓘ has a hoverable box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
    const hov = await tip();
    check(hov.shown === true, 'hovering shows the tip');
    check(/Define nodes here/.test(hov.text), 'with the section\'s text');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 200);
    await page.waitForTimeout(150);
    check((await tip()).shown === false, 'and leaving puts it away');

    // =========================================================
    console.log('\n--- 4. Clicking an ⓘ does NOT fold its section ---');
    // =========================================================
    // Asserted as BEHAVIOUR, not as a mechanism. Today it falls out of the ⓘ
    // being a <button>: the button is the click's activation target, so the
    // <summary> ancestor's fold never runs, and `ui/info-tip.js`'s
    // `stopPropagation` handles the listeners. Change the icon to a <span> and
    // that stops being true — which is what this is here to catch.
    for (const [btnId, detId] of [
        ['planeNodesInfo', 'planeNodesDetails'],
        ['planePlanesInfo', 'planePlanesDetails'],
        ['meshObjectsInfo', 'meshObjectsDetails'],
    ]) {
        const openBefore = await page.evaluate(i => document.getElementById(i).open, detId);
        const b = await boxOf('#' + btnId);
        check(b !== null && b.y > 0 && b.y < 900,
            `#${btnId} is on screen to be clicked`);
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(150);
        const openAfter = await page.evaluate(i => document.getElementById(i).open, detId);
        check(openAfter === openBefore,
            `clicking #${btnId} leaves ${detId} ${openBefore ? 'open' : 'closed'}`);
        check((await tip()).shown === true, `  and it answers the question instead`);
        await page.mouse.move(b.x, b.y + 260);
        await page.waitForTimeout(100);
    }

    // The heading ITSELF must still fold — the icon is an exception, not a
    // dead zone over the whole summary.
    const headingHandle = await page.$('#planeNodesDetails > summary');
    await headingHandle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    const hb = await headingHandle.boundingBox();
    const headingBox = { x: hb.x, y: hb.y, w: hb.width, h: hb.height };
    const wasOpen = await page.evaluate(() => document.getElementById('planeNodesDetails').open);
    await page.mouse.click(headingBox.x + headingBox.w - 12, headingBox.y + headingBox.h / 2);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => document.getElementById('planeNodesDetails').open)) === !wasOpen,
        'clicking the heading beside the icon still folds the section');
    await page.mouse.click(headingBox.x + headingBox.w - 12, headingBox.y + headingBox.h / 2);
    await page.waitForTimeout(200);

    // =========================================================
    console.log('\n--- 5. The sections told to lose their text have NO ⓘ either ---');
    // =========================================================
    const danger = await page.evaluate(() => {
        const d = document.getElementById('originDangerDetails');
        if (!d) return null;
        return {
            hints: [...d.querySelectorAll('.plane-hint')].map(e => e.textContent.trim()),
            infos: d.querySelectorAll('[data-infotip]').length,
            applyText: d.textContent,
        };
    });
    check(danger !== null, 'the Danger Zone section is in the DOM');
    check(danger.hints.length === 0, 'it carries no standing paragraph');
    check(danger.infos === 0,
        'and no ⓘ replacing it — the warning belongs in the dialogs that actually fire');
    check(/Set as New Calibration/.test(danger.applyText),
        'while its actions are untouched');

    const addHint = await page.evaluate(() => {
        const el = document.getElementById('planeAddNodeHint');
        return el ? el.textContent.trim() : null;
    });
    check(addHint === '',
        '"+ Add" says nothing while the picker has candidates (was a paragraph): ' +
        JSON.stringify(addHint));

    // But the two EMPTY-STATE lines are real dead ends and must survive: the
    // dropdown is empty and the reason is not otherwise on screen.
    const emptyHint = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        // Put every pool node into the plane, so the picker empties.
        const sel = document.getElementById('planeAddNodeSelect');
        for (let guard = 0; guard < 20 && sel.options.length; guard++) {
            document.getElementById('btnAddExistingPlaneNode').click();
            P.refreshPlanePanel();
        }
        return document.getElementById('planeAddNodeHint').textContent.trim();
    });
    check(/already in/.test(emptyHint),
        'but an EMPTY picker still says why: ' + JSON.stringify(emptyHint.slice(0, 50)));

    // =========================================================
    console.log('\n--- 6. Planes has one labelled row, and it says Name ---');
    // =========================================================
    // There used to be TWO stacked rows doing different things — a
    // "Select Plane" dropdown above an "Edit Name" field — and the labels had
    // to be verbose to tell them apart. Selection is a roster row click now (as
    // with 3D Mesh Objects), so one row is left and it is plainly "Name".
    const labels = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#planePlanesDetails .plane-name-row')];
        const newBtn = document.getElementById('btnNewPlaneSkeleton');
        const nameInput = document.getElementById('planeSkeletonName');
        return {
            rows: rows.map(r => {
                const span = r.querySelector('span');
                const ctrl = r.querySelector('select, input');
                return {
                    text: span ? span.textContent.trim() : null,
                    clipped: span ? span.scrollWidth > span.clientWidth + 1 : null,
                    ctrlId: ctrl ? ctrl.id : null,
                };
            }),
            // No plane <select> ANYWHERE in the section. The three pickers
            // inside the sub-sections (add-node, and the two edge ends) are
            // not selectors for a plane and are excluded by name, not by
            // nesting depth — a depth-limited walk would pass on a build that
            // simply moved the dropdown one level in.
            selects: [...document.querySelectorAll('#planePlanesDetails select')]
                .map(s => s.id)
                .filter(id => !/AddNode|EdgeSrc|EdgeDst/.test(id)),
            newLabel: newBtn ? newBtn.textContent.trim() : null,
            // The create button comes FIRST, above the name it will need.
            newBeforeName: !!(newBtn.compareDocumentPosition(nameInput) &
                Node.DOCUMENT_POSITION_FOLLOWING),
        };
    });
    const rename = labels.rows.find(l => l.ctrlId === 'planeSkeletonName');
    check(labels.rows.length === 1,
        'Planes has ONE labelled row, not a picker stacked on a renamer (got ' +
        labels.rows.length + ': ' + JSON.stringify(labels.rows.map(r => r.text)) + ')');
    check(rename && rename.text === 'Name',
        'and it is labelled "Name" (got ' + JSON.stringify(rename && rename.text) + ')');
    check(rename.clipped === false, 'the label is not clipped by the fixed label column');
    check(labels.selects.length === 0,
        'no plane dropdown survives anywhere in the section (got ' +
        JSON.stringify(labels.selects) + ')');
    check(labels.newLabel === '+ New Plane',
        'the create button reads "+ New Plane" (got ' + JSON.stringify(labels.newLabel) + ')');
    check(labels.newBeforeName, 'and sits above the Name field, as 3D Mesh Objects does');

    // =========================================================
    console.log('\n--- 7. Member node names are indented off the table edge ---');
    // =========================================================
    // `.plane-node-shared` paints a 2px accent bar INSIDE the row, so at the
    // table's inherited 6px a shared node's name cleared it by four pixels and
    // read as flush with the edge.
    const indent = await page.evaluate(() => {
        const td = document.querySelector('#planeMembersTable tbody td');
        const th = document.querySelector('#planeMembersTable thead th');
        const table = document.getElementById('planeMembersTable');
        return {
            tdPad: td ? parseFloat(getComputedStyle(td).paddingLeft) : null,
            thPad: th ? parseFloat(getComputedStyle(th).paddingLeft) : null,
            tableLeft: Math.round(table.getBoundingClientRect().left),
            firstNameLeft: td ? Math.round(td.getBoundingClientRect().left + parseFloat(getComputedStyle(td).paddingLeft)) : null,
        };
    });
    check(indent.tdPad >= 10,
        'the name cell is indented from the table edge (padding-left ' + indent.tdPad + 'px)');
    check(indent.thPad === indent.tdPad,
        'and the NAME header matches it, so label and values line up (' +
        indent.thPad + ' vs ' + indent.tdPad + ')');
    check(indent.firstNameLeft - indent.tableLeft >= 10,
        'so the text starts at least 10px in from the table\'s left edge (got ' +
        (indent.firstNameLeft - indent.tableLeft) + 'px)');

    console.log(`\n${fails === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${fails} CHECK(S) FAILED`}`);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
