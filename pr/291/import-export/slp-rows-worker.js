/**
 * slp-rows-worker.js — writes and gzips ONE exported .slp's four big tables
 * (`frames`, `instances`, `points`, `pred_points`), so By Cam's store copy
 * compresses every camera at once instead of all of them on the main thread
 * (`exportCamerasFromSharedStore`, import-export/file-io.js; gzip was ~74% of
 * that copy).
 *
 * The main thread opens a sleap-io.js writer for the camera, closes it at once
 * (the "shell": the header and the four empty, chunked, gzip tables), and sends
 * those bytes here; its working writer then hands every row to this worker
 * (the bundle's `(row divert)` patch) instead of its own file. Rows arrive in
 * the order the writer produced them and are carried into whole column chunks
 * exactly as the bundle's `(column chunks)` patch does (chunk height read from
 * the dataset itself), so the values, shapes, dtypes and chunking are the same
 * as a file the writer finishes itself.
 *
 * In:  { type: 'open', shell: ArrayBuffer }           → { type: 'ready' }
 *      { type: 'rows', name, data: Float64Array, rows, cols } → { type: 'ack' }
 *      { type: 'create', spec, data, attrs }           → { type: 'ack' }
 *        (a whole table the bundle's `(deferred tables)` patch held back from a
 *        per-camera rewrite: `create_dataset({...spec, data})`, then each
 *        `[name, value, dtype]` attribute, exactly as the bundle would have)
 *      { type: 'finish' }                              → { type: 'done', bytes }
 * Any failure → { type: 'error', message } (the file is dropped).
 *
 * Imports h5wasm by relative path: a worker has no import map.
 */
import * as h5 from '../lib/h5wasm/hdf5_hl.js?v=7ee16183c88d';

let file = null;
let path = null;
const carries = new Map();   // table name → { buf, rows, written, cols, chunkRows }

function carryFor(name, cols) {
    let st = carries.get(name);
    if (!st) {
        const ds = file.get(name);
        if (!ds) throw new Error('the file has no ' + name + ' table');
        const chunks = ds.metadata && ds.metadata.chunks;
        const chunkRows = (chunks && chunks[0] > 0) ? chunks[0] : 65536;
        st = { ds, buf: new Float64Array(chunkRows * cols), rows: 0, written: Number(ds.shape[0]) || 0, cols, chunkRows };
        carries.set(name, st);
    }
    if (st.cols !== cols) throw new Error(name + ': ' + cols + ' columns, the table has ' + st.cols);
    return st;
}

function writeCarry(st) {
    if (st.rows === 0) return;
    const data = st.buf.subarray(0, st.rows * st.cols);
    st.ds.resize([st.written + st.rows, st.cols]);
    st.ds.write_slice([[st.written, st.written + st.rows], [0, st.cols]], data);
    st.written += st.rows;
    st.rows = 0;
}

function appendRows(name, flat, rowCount, cols) {
    const st = carryFor(name, cols);
    let src = 0;
    while (src < rowCount) {
        const take = Math.min(rowCount - src, st.chunkRows - st.rows);
        st.buf.set(flat.subarray(src * cols, (src + take) * cols), st.rows * cols);
        st.rows += take;
        src += take;
        if (st.rows === st.chunkRows) writeCarry(st);
    }
}

function drop() {
    try { if (file) file.close(); } catch (e) { /* ignore */ }
    try { if (path) h5.FS.unlink(path); } catch (e) { /* ignore */ }
    file = null;
    path = null;
    carries.clear();
}

self.onmessage = async (ev) => {
    const m = ev.data;
    try {
        if (m.type === 'open') {
            await h5.ready;
            try { h5.FS.mkdir('/work'); } catch (e) { /* exists */ }
            path = '/work/camera.slp';
            h5.FS.writeFile(path, new Uint8Array(m.shell));
            file = new h5.File(path, 'a');
            self.postMessage({ type: 'ready' });
        } else if (m.type === 'rows') {
            if (!file) throw new Error('rows before open');
            appendRows(m.name, m.data, m.rows, m.cols);
            self.postMessage({ type: 'ack' });
        } else if (m.type === 'create') {
            if (!file) throw new Error('create before open');
            file.create_dataset(Object.assign({}, m.spec, { data: m.data }));
            const ds = file.get(m.spec.name);
            for (const [name, value, dtype] of (m.attrs || [])) ds.create_attribute(name, value, null, dtype);
            self.postMessage({ type: 'ack' });
        } else if (m.type === 'finish') {
            if (!file) throw new Error('finish before open');
            for (const st of carries.values()) writeCarry(st);
            carries.clear();
            file.close();
            file = null;
            const bytes = h5.FS.readFile(path);
            h5.FS.unlink(path);
            path = null;
            self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
        }
    } catch (err) {
        drop();
        self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
};
