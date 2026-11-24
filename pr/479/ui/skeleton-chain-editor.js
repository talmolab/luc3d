// ui/skeleton-chain-editor.js — Settings ▸ Triangulation Wizard ▸ Skeleton check: the custom parts the check judges,
// built from node tiles (pose/skeleton-check-run.js, `settings.chains`).
//
// A bank holds a tile per skeleton node. Each part is a row of tiles in order along the body (Nose, Head, Neck,
// Trunk, TTI, Tail_0, ...). Drag a tile from the bank into a row (a copy: the bank keeps it), drag it within a row
// to reorder, to another row to move it, onto "New part" to start one, or back onto the bank to take it out.
// Without dragging: a click on a bank tile adds it to the end of the selected part (a row's number selects it; "New
// part" starts one), and a tile's × takes it out. Every control is a <button>, so Enter and Space work (the Settings
// modal stops keydown in the capture phase, so nothing here listens for keys).
//
// The parts are kept as the setting's text (`partsToText`: one part per line, names joined by ", "), so the check
// and its storage are unchanged. A stored name the skeleton lacks shows as a warning tile, never dropped silently.
//
// The model operations (`textToParts`, `partsToText`, `dropTile`, `appendTile`, `removeTile`) are pure and DOM-free;
// tests/test-skeleton-chain-editor.mjs runs them in Node. The DOM half is `buildSkeletonChainEditor`.

import { parseChainText } from '../pose/skeleton-check-run.js?v=e0c5253a4e00';

/** The setting's text -> parts (arrays of node names). */
export function textToParts(text) {
    return parseChainText(text);
}

/** Parts -> the setting's text: one part per line, names joined by ", "; empty parts left out. */
export function partsToText(parts) {
    return parts.filter(function (p) { return p.length > 0; }).map(function (p) { return p.join(', '); }).join('\n');
}

function copyParts(parts) {
    return parts.map(function (p) { return p.slice(); });
}

function dropEmpty(parts) {
    return parts.filter(function (p) { return p.length > 0; });
}

/**
 * A tile dropped. `from`: { name, part, index } (`part` -1 for the bank). `to`: { part, index }: a row and the place
 * to insert at, `part === parts.length` for a new part, -1 for the bank (takes a part's tile out). A tile dropped on
 * a row that already holds that node (from elsewhere) changes nothing. -> new parts (empty rows removed).
 */
export function dropTile(parts, from, to) {
    const out = copyParts(parts);
    const name = from.name;
    if (to.part < 0) {
        if (from.part >= 0 && out[from.part]) out[from.part].splice(from.index, 1);
        return dropEmpty(out);
    }
    if (to.part >= out.length) {
        if (from.part >= 0 && out[from.part]) out[from.part].splice(from.index, 1);
        out.push([name]);
        return dropEmpty(out);
    }
    const row = out[to.part];
    let at = Math.max(0, Math.min(to.index, row.length));
    if (from.part === to.part) {
        row.splice(from.index, 1);
        if (from.index < at) at--;
        row.splice(at, 0, name);
        return dropEmpty(out);
    }
    if (row.indexOf(name) >= 0) return copyParts(parts);
    if (from.part >= 0 && out[from.part]) out[from.part].splice(from.index, 1);
    row.splice(at, 0, name);
    return dropEmpty(out);
}

/** A node added to the end of part `part` (a new part when `part` is past the last). A part that already holds it is
 *  left as it is. -> { parts, part: the part it went to } */
export function appendTile(parts, name, part) {
    const out = copyParts(parts);
    if (part >= 0 && part < out.length) {
        if (out[part].indexOf(name) < 0) out[part].push(name);
        return { parts: out, part: part };
    }
    out.push([name]);
    return { parts: out, part: out.length - 1 };
}

/** A part's tile taken out (an emptied part goes). */
export function removeTile(parts, part, index) {
    const out = copyParts(parts);
    if (out[part]) out[part].splice(index, 1);
    return dropEmpty(out);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/**
 * The editor. `nodes`: the skeleton's node names (the bank; empty without a session). `text`: the setting's text.
 * `onChange(text)` after every edit. -> { el, getText() }
 */
export function buildSkeletonChainEditor(opts) {
    const nodes = (opts && opts.nodes) || [];
    const onChange = (opts && opts.onChange) || function () {};
    let parts = textToParts(opts && opts.text);
    let selected = parts.length;          // where a clicked bank tile goes; parts.length = a new part
    let dragging = null;                  // { name, part, index } while a tile is dragged

    const root = el('div', 'sk-chain-editor');
    const bankLabel = el('div', 'sk-chain-label', 'Nodes');
    const bank = el('div', 'sk-chain-bank');
    bank.setAttribute('aria-label', 'Skeleton nodes');
    const partsLabel = el('div', 'sk-chain-label', 'Parts');
    const list = el('div', 'sk-chain-parts');
    root.appendChild(bankLabel);
    root.appendChild(bank);
    root.appendChild(partsLabel);
    root.appendChild(list);

    function changed(next) {
        parts = next;
        if (selected > parts.length) selected = parts.length;
        render();
        onChange(partsToText(parts));
    }

    function startDrag(e, from) {
        dragging = from;
        try {
            e.dataTransfer.setData('text/plain', from.name);
            e.dataTransfer.effectAllowed = from.part < 0 ? 'copy' : 'move';
        } catch (err) { /* some browsers refuse data on some elements: the drag still carries `dragging` */ }
    }

    function clearMarks() {
        root.querySelectorAll('.sk-drop-before').forEach(function (t) { t.classList.remove('sk-drop-before'); });
        root.querySelectorAll('.sk-drop-end, .sk-drop-over').forEach(function (r) { r.classList.remove('sk-drop-end', 'sk-drop-over'); });
    }

    /** Where in a row a drop at (x, y) goes: before the first tile the pointer is ahead of, in reading order. */
    function insertIndex(row, x, y) {
        const tiles = row.querySelectorAll('.sk-chain-part-tile');
        for (let i = 0; i < tiles.length; i++) {
            const r = tiles[i].getBoundingClientRect();
            if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return i;
        }
        return tiles.length;
    }

    // ---- the bank
    nodes.forEach(function (name) {
        const t = el('button', 'sk-chain-tile', name);
        t.type = 'button';
        t.draggable = true;
        t.title = 'Drag into a part, or click to add it to the selected part';
        t.addEventListener('dragstart', function (e) { startDrag(e, { name: name, part: -1, index: -1 }); });
        t.addEventListener('dragend', function () { dragging = null; clearMarks(); });
        t.addEventListener('click', function () {
            const r = appendTile(parts, name, selected);
            selected = r.part;
            changed(r.parts);
        });
        bank.appendChild(t);
    });
    if (!nodes.length) bank.appendChild(el('span', 'sk-chain-empty', 'Open a session to pick its nodes.'));
    // a part's tile dropped back on the bank comes out of its part
    bank.addEventListener('dragover', function (e) {
        if (!dragging || dragging.part < 0) return;
        e.preventDefault();
        bank.classList.add('sk-drop-over');
    });
    bank.addEventListener('dragleave', function () { bank.classList.remove('sk-drop-over'); });
    bank.addEventListener('drop', function (e) {
        if (!dragging || dragging.part < 0) return;
        e.preventDefault();
        const from = dragging;
        dragging = null;
        clearMarks();
        changed(dropTile(parts, from, { part: -1, index: 0 }));
    });

    function wireDropRow(row, partIndex) {
        row.addEventListener('dragover', function (e) {
            if (!dragging) return;
            e.preventDefault();
            clearMarks();
            if (partIndex >= parts.length) { row.classList.add('sk-drop-over'); return; }
            const at = insertIndex(row, e.clientX, e.clientY);
            const tiles = row.querySelectorAll('.sk-chain-part-tile');
            if (at < tiles.length) tiles[at].classList.add('sk-drop-before');
            else row.classList.add('sk-drop-end');
        });
        row.addEventListener('dragleave', function (e) {
            if (!row.contains(e.relatedTarget)) clearMarks();
        });
        row.addEventListener('drop', function (e) {
            if (!dragging) return;
            e.preventDefault();
            const from = dragging;
            dragging = null;
            const at = partIndex >= parts.length ? 0 : insertIndex(row, e.clientX, e.clientY);
            clearMarks();
            const next = dropTile(parts, from, { part: partIndex, index: at });
            // the part it went to (a part emptied above it shifts it up one)
            const emptiedAbove = from.part >= 0 && from.part < partIndex && parts[from.part].length === 1 ? 1 : 0;
            selected = partIndex >= parts.length ? next.length - 1 : partIndex - emptiedAbove;
            changed(next);
        });
    }

    function render() {
        list.textContent = '';
        parts.forEach(function (part, p) {
            const row = el('div', 'sk-chain-part' + (p === selected ? ' sk-chain-selected' : ''));
            row.dataset.part = String(p);
            const num = el('button', 'sk-chain-part-num', String(p + 1));
            num.type = 'button';
            num.title = 'Select this part: a clicked node is added to its end';
            num.setAttribute('aria-label', 'Select part ' + (p + 1));
            num.addEventListener('click', function () { selected = p; render(); });
            row.appendChild(num);
            part.forEach(function (name, i) {
                if (i > 0) row.appendChild(el('span', 'sk-chain-sep', '›'));
                const known = nodes.indexOf(name) >= 0 || !nodes.length;
                const t = el('span', 'sk-chain-tile sk-chain-part-tile' + (known ? '' : ' sk-chain-tile-unknown'));
                t.draggable = true;
                t.title = known ? 'Drag to reorder, into another part, or back onto the nodes to take it out'
                    : 'This skeleton has no node named ' + name + ': the part is left out';
                t.appendChild(el('span', 'sk-chain-tile-name', name));
                const x = el('button', 'sk-chain-tile-x', '×');
                x.type = 'button';
                x.setAttribute('aria-label', 'Take ' + name + ' out of part ' + (p + 1));
                x.addEventListener('click', function () { changed(removeTile(parts, p, i)); });
                t.appendChild(x);
                t.addEventListener('dragstart', function (e) { startDrag(e, { name: name, part: p, index: i }); });
                t.addEventListener('dragend', function () { dragging = null; clearMarks(); });
                row.appendChild(t);
            });
            const del = el('button', 'sk-chain-part-x', 'Remove');
            del.type = 'button';
            del.setAttribute('aria-label', 'Remove part ' + (p + 1));
            del.addEventListener('click', function () {
                const next = copyParts(parts);
                next.splice(p, 1);
                if (selected > p) selected--;
                changed(next);
            });
            row.appendChild(del);
            wireDropRow(row, p);
            list.appendChild(row);
        });
        const fresh = el('button', 'sk-chain-part sk-chain-new' + (selected >= parts.length ? ' sk-chain-selected' : ''),
            '+ New part: drag a node here, or click here and then click nodes in order');
        fresh.type = 'button';
        fresh.dataset.part = String(parts.length);
        fresh.addEventListener('click', function () { selected = parts.length; render(); });
        wireDropRow(fresh, parts.length);
        list.appendChild(fresh);
    }
    render();

    return { el: root, getText: function () { return partsToText(parts); } };
}
