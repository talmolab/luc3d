/**
 * import-export/volume3d-file.js — File ▸ Load Volume 3D: read a volumetric model's output for the active
 * session (pose/volume3d.js keeps it, pose/volume-fusion.js uses it when Triangulate runs).
 *
 * The file (`<name>.vol3d.h5`, written by scripts/export_volume3d.py) — one row per animal per frame:
 *   /frame_indices  int     (R,)        the session's frame index of each row
 *   /means          float32 (R, J, 3)   each node's 3D mean, in the calibration's world frame (mm)
 *   /covs           float32 (R, J, 6)   each node's covariance [xx, xy, xz, yy, yz, zz] (mm^2), as the model
 *                                       gives it (the gate uses it as is; fusion scales it by cov_scale)
 *   /node_names     string  (J,)        matched to the skeleton by name
 *   root attributes: format = "lucid-volume3d/1", cov_scale (float, default 1), source (string, optional),
 *                    skeleton_chains (optional JSON string: [{ name, bones: [[a, b], ...], nodes: [...] }] by
 *                    node name; the chains the skeleton check guards, e.g. the tail and the head)
 * Rows carry no identity: each Triangulate solve matches its group to the frame's rows by 3D distance.
 */
import { initH5wasm, pickFiles } from './file-io.js';
import { readBlobArrayBuffer } from '../loading/cold-read-guard.js';
import { showLoading, hideLoading, setStatus } from './save-load.js';
import { state } from '../ui/app-state.js';
import { setSessionVolume, volumeNodeCoverage, volumeChains, getVolumeSettings } from '../pose/volume3d.js';

export const VOLUME3D_FORMAT = 'lucid-volume3d/1';

function attr(f, name) {
    try {
        const a = f.attrs && f.attrs[name];
        if (a == null) return undefined;
        const v = (a.value !== undefined) ? a.value : a;
        return (v && v.length === 1 && typeof v !== 'string') ? v[0] : v;
    } catch (e) { return undefined; }
}

/** The optional `skeleton_chains` attribute (JSON: [{ name, bones: [[a, b], ...], nodes: [...] }], by node
 *  name) -> that array, or [] (absent or unreadable: no skeleton check, never a failed load). */
function readChains(f) {
    const raw = attr(f, 'skeleton_chains');
    if (raw == null || raw === '') return [];
    try {
        const v = JSON.parse(String(raw));
        return Array.isArray(v) ? v : [];
    } catch (e) {
        console.warn('volume file: skeleton_chains is not JSON; no skeleton check', e);
        return [];
    }
}

/**
 * Parse a .vol3d.h5 file.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{nodeNames: string[], frameIndices: Int32Array, means: Float32Array, covs: Float32Array,
 *          covScale: number, chains: object[], source: string, format: string}>}
 */
export async function parseVolume3dH5(arrayBuffer) {
    const mod = await initH5wasm();
    const fname = '_import_vol3d_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.h5';
    mod.FS.writeFile(fname, new Uint8Array(arrayBuffer));
    let f = null;
    try {
        f = new mod.File(fname, 'r');
        const need = function (k) {
            const d = f.get(k);
            if (!d) throw new Error('not a volume file: no /' + k + ' dataset');
            return d;
        };
        const fi = need('frame_indices'), mu = need('means'), cv = need('covs'), nn = need('node_names');
        const nodeNames = Array.from(nn.value, String);
        const J = nodeNames.length;
        const R = fi.shape[0];
        if (mu.shape.length !== 3 || mu.shape[0] !== R || mu.shape[1] !== J || mu.shape[2] !== 3) {
            throw new Error('volume file: /means is ' + JSON.stringify(mu.shape) + ', expected [' + R + ', ' + J + ', 3]');
        }
        if (cv.shape.length !== 3 || cv.shape[0] !== R || cv.shape[1] !== J || cv.shape[2] !== 6) {
            throw new Error('volume file: /covs is ' + JSON.stringify(cv.shape) + ', expected [' + R + ', ' + J + ', 6]');
        }
        const fiv = fi.value;
        const frameIndices = new Int32Array(R);
        for (let i = 0; i < R; i++) frameIndices[i] = Number(fiv[i]);
        const means = Float32Array.from(mu.value);
        const covs = Float32Array.from(cv.value);
        const cs = Number(attr(f, 'cov_scale'));
        return {
            nodeNames: nodeNames, frameIndices: frameIndices, means: means, covs: covs,
            covScale: Number.isFinite(cs) && cs > 0 ? cs : 1,
            chains: readChains(f),
            source: String(attr(f, 'source') || ''), format: String(attr(f, 'format') || ''),
        };
    } finally {
        try { if (f) f.close(); } catch (e) { /* already closed */ }
        try { mod.FS.unlink(fname); } catch (e) { /* not written */ }
    }
}

/** File ▸ Load Volume 3D: pick a .vol3d.h5 and attach it to the active session. */
export async function handleLoadVolume3d(file) {
    const session = state.session;
    if (!session || !session.skeleton || !session.skeleton.nodes || !session.skeleton.nodes.length) {
        setStatus('Load a project (with its skeleton) before a volume', 'error');
        return null;
    }
    try {
        if (!file) {
            const files = await pickFiles({ accept: '.h5,.hdf5' });
            if (!files.length) { setStatus('No file selected', 'warning'); return null; }
            file = files[0];
        }
        showLoading('Reading volume file...');
        // Not file.arrayBuffer(): a cloud file still downloading reads back with zeroed pages (cold-read-guard.js)
        const buf = await readBlobArrayBuffer(file);
        const data = await parseVolume3dH5(buf);
        data.fileName = file.name || '';
        setSessionVolume(session, data);
        const cov = volumeNodeCoverage(session);
        const frames = new Set(data.frameIndices).size;
        if (cov.matched < 3) {
            setStatus('Volume file ' + data.fileName + ': only ' + cov.matched + ' of the skeleton\'s nodes are in it — ' +
                'node names must match', 'error');
        } else {
            const chains = volumeChains(session);
            const skipped = chains.skipped.map(function (c) { return c.name + ' (' + c.reason + ')'; });
            setStatus('Volume 3D loaded: ' + data.frameIndices.length.toLocaleString('en-US') + ' animal-frames on ' +
                frames.toLocaleString('en-US') + ' frames, ' + cov.matched + ' of ' + cov.total + ' nodes' +
                (cov.missing.length ? ' (no ' + cov.missing.join(', ') + ')' : '') + '. Triangulate ' +
                (getVolumeSettings().enabled ? 'fuses it' : 'ignores it while "Fuse with volume" is off') + '.' +
                (chains.length ? ' Its chains for Triangulate ▸ Skeleton check: ' + chains.map(function (c) { return c.name; }).join(', ') + '.' : '') +
                (skipped.length ? ' Not used: ' + skipped.join('; ') + '.' : ''), 'success');
        }
        document.dispatchEvent(new CustomEvent('lucid:volume3d-changed'));
        return data;
    } catch (err) {
        console.error('Failed to load volume file:', err);
        setStatus('Failed to load volume file: ' + (err && err.message || err), 'error');
        return null;
    } finally {
        hideLoading();
    }
}
