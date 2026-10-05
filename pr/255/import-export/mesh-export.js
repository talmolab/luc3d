/**
 * mesh-export.js — a 3D mesh object as a file another program can open.
 *
 * Two formats, because two audiences: **binary STL** for CAD, and **binary
 * glTF (.glb)** for Blender and every other modern 3D viewer. Both take the
 * SAME input — the `MeshObjectGeometry` that `pose/mesh-object-geometry.js`
 * derives — so neither format re-derives anything, and a shape that is wrong
 * in one is wrong in both rather than wrong in different ways.
 *
 * DOM-free and pure: geometry in, bytes out. The download half lives in
 * `ui/mesh-objects.js`, which owns the buttons.
 *
 * ## The one place an axis conversion IS correct
 *
 * The project rule is that LUCID's world is Z-up right-handed, Blender's is
 * too, and no axis conversion belongs in the plane/mesh pipeline. That rule is
 * about the PIPELINE. It does not survive contact with glTF, whose
 * specification fixes the up axis: "+Y up, right-handed" (glTF 2.0 §3.5). So:
 *
 *   - **STL is written verbatim.** The format defines no up axis at all, and
 *     CAD tools conventionally treat Z as up, which is already what we have.
 *   - **GLB is converted to Y-up** on the way out: `(x, y, z)` becomes
 *     `(x, z, -y)`. Blender's glTF importer applies the inverse rotation on
 *     the way in, so the object lands back in Z-up exactly as annotated. Write
 *     Z-up into a .glb instead and the file is off-spec: Blender still rotates
 *     it, so the cage arrives lying on its side, and every conformant viewer
 *     (three.js, Babylon, Sketchfab, QuickLook) shows it tipped over too.
 *
 * The conversion is a −90° rotation about X. Its determinant is +1, so it is a
 * rotation and NOT a mirror: triangle winding, and therefore which side is
 * "out", survives untouched. That is why no winding flip accompanies it — and
 * why adding one later would silently invert every normal.
 *
 * ## Precision
 *
 * Both formats store positions as float32; that is not a choice, it is what
 * the formats define (glTF POSITION must be float32, and binary STL is a
 * packed array of them). LUCID's coordinates are float64 millimetres, so an
 * ~1e3 mm coordinate keeps ~1e-4 mm of resolution. Below annotation noise, but
 * it does mean a re-imported mesh is not bit-identical to the project's own
 * numbers — the project file stays the source of truth.
 */

/** glTF component/type constants, named so the JSON below reads as itself. */
var FLOAT = 5126;
var UNSIGNED_INT = 5125;
var TRIANGLES = 4;
var ARRAY_BUFFER = 34962;
var ELEMENT_ARRAY_BUFFER = 34963;

/**
 * Does this geometry have anything to write?
 *
 * An empty file is worse than a refusal: it opens, it shows nothing, and the
 * user concludes their annotation is broken rather than that they exported an
 * object with no triangulated faces yet.
 *
 * @param {Object} geometry - from `buildMeshObjectGeometry`
 * @returns {boolean}
 */
export function isExportable(geometry) {
    return !!(geometry && geometry.triangles && geometry.triangles.length >= 3 &&
        geometry.vertices && geometry.vertices.length >= 9);
}

/**
 * Unit normal of a triangle, by the right-hand rule on its winding.
 *
 * Returns [0,0,0] for a degenerate triangle, which binary STL defines as
 * "derive it from the winding" — the honest answer when the cross product has
 * no direction to report.
 * @private
 */
function triangleNormal(v, a, b, c) {
    var ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
    var ux = v[b * 3] - ax, uy = v[b * 3 + 1] - ay, uz = v[b * 3 + 2] - az;
    var wx = v[c * 3] - ax, wy = v[c * 3 + 1] - ay, wz = v[c * 3 + 2] - az;
    var nx = uy * wz - uz * wy;
    var ny = uz * wx - ux * wz;
    var nz = ux * wy - uy * wx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0) || !isFinite(len)) return [0, 0, 0];
    return [nx / len, ny / len, nz / len];
}

/**
 * Binary STL bytes for a mesh object.
 *
 * Binary rather than ASCII: it is ~5x smaller, exact to the last float32 bit
 * (no decimal formatting to argue about) and is what CAD writes by default.
 * The 80-byte header deliberately does NOT begin with "solid", because a
 * binary file that starts with that word is what makes lenient parsers guess
 * ASCII and read garbage.
 *
 * STL carries triangles and nothing else: no colour, no units, no vertex
 * sharing (each triangle repeats its three corners in full). The welding this
 * project does at the node level is therefore invisible in the file — by the
 * format's design, not by omission.
 *
 * @param {Object} geometry - from `buildMeshObjectGeometry`
 * @param {{name?:string}} [opts]
 * @returns {Uint8Array|null} null when there is nothing to write
 */
export function meshObjectToSTL(geometry, opts) {
    if (!isExportable(geometry)) return null;
    var o = opts || {};
    var v = geometry.vertices;
    var tris = geometry.triangles;
    var nTri = Math.floor(tris.length / 3);

    var buf = new ArrayBuffer(84 + nTri * 50);
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);

    // Header: ASCII, truncated to 80 bytes, never starting with "solid".
    var header = 'LUCID 3D mesh object: ' + (o.name || 'object');
    for (var h = 0; h < 80 && h < header.length; h++) {
        var code = header.charCodeAt(h);
        bytes[h] = (code >= 32 && code < 127) ? code : 63; // '?' for non-ASCII
    }
    view.setUint32(80, nTri, true);

    var off = 84;
    for (var t = 0; t < nTri; t++) {
        var a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
        var n = triangleNormal(v, a, b, c);
        view.setFloat32(off, n[0], true);
        view.setFloat32(off + 4, n[1], true);
        view.setFloat32(off + 8, n[2], true);
        off += 12;
        var idx = [a, b, c];
        for (var k = 0; k < 3; k++) {
            var base = idx[k] * 3;
            view.setFloat32(off, v[base], true);
            view.setFloat32(off + 4, v[base + 1], true);
            view.setFloat32(off + 8, v[base + 2], true);
            off += 12;
        }
        view.setUint16(off, 0, true);   // attribute byte count, unused
        off += 2;
    }
    return bytes;
}

/**
 * One sRGB hex colour as glTF's linear `baseColorFactor`.
 *
 * glTF states baseColorFactor is LINEAR, while a CSS hex from the colour
 * picker is sRGB-encoded. Handing the hex over unconverted makes every export
 * noticeably paler than the swatch the user chose.
 * @private
 */
function hexToLinearRGBA(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [0.8, 0.8, 0.8, 1];
    var int = parseInt(m[1], 16);
    var out = [];
    for (var shift = 16; shift >= 0; shift -= 8) {
        var s = ((int >> shift) & 255) / 255;
        out.push(s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    }
    out.push(1);
    return out;
}

/** Pad a byte length up to the next 4-byte boundary, as GLB requires. @private */
function pad4(n) { return (n + 3) & ~3; }

/**
 * Binary glTF (.glb) bytes for a mesh object.
 *
 * One self-contained file: JSON chunk + binary chunk, no sidecars. Vertices
 * stay WELDED (shared corners are one vertex, indexed), which is the whole
 * point of the connectivity model and is what lets Blender's edge tools see
 * the cage as one surface rather than a pile of loose faces.
 *
 * **No NORMAL attribute, deliberately.** glTF says a primitive without normals
 * MUST be shaded flat, which is exactly right for a faceted annotation cage;
 * supplying normals would mean either splitting every shared vertex (undoing
 * the welding) or smoothing across hard edges that are real.
 *
 * @param {Object} geometry - from `buildMeshObjectGeometry`
 * @param {{name?:string, color?:string}} [opts]
 * @returns {Uint8Array|null} null when there is nothing to write
 */
export function meshObjectToGLB(geometry, opts) {
    if (!isExportable(geometry)) return null;
    var o = opts || {};
    var name = o.name || 'object';
    var src = geometry.vertices;
    var nVert = Math.floor(src.length / 3);
    var tris = geometry.triangles;

    // Positions, Z-up -> Y-up. See the header: this is the one sanctioned
    // axis conversion in the project, and it is the FORMAT's requirement.
    var pos = new Float32Array(nVert * 3);
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < nVert; i++) {
        var x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
        var p = [x, z, -y];
        for (var k = 0; k < 3; k++) {
            pos[i * 3 + k] = p[k];
            // min/max are read back from the FLOAT32 values, not the doubles:
            // glTF requires the accessor bounds to hold for the stored data,
            // and a f64 bound can fall inside its own rounded f32 value.
            var f = pos[i * 3 + k];
            if (f < min[k]) min[k] = f;
            if (f > max[k]) max[k] = f;
        }
    }
    var idx = Uint32Array.from(tris);

    var posBytes = pos.byteLength;
    var idxOffset = pad4(posBytes);
    var binLength = idxOffset + idx.byteLength;

    var json = {
        asset: { version: '2.0', generator: 'LUCID' },
        scene: 0,
        scenes: [{ nodes: [0], name: name }],
        nodes: [{ mesh: 0, name: name }],
        meshes: [{
            name: name,
            primitives: [{
                attributes: { POSITION: 0 },
                indices: 1,
                material: 0,
                mode: TRIANGLES,
            }],
        }],
        materials: [{
            name: name,
            pbrMetallicRoughness: {
                baseColorFactor: hexToLinearRGBA(o.color),
                metallicFactor: 0,
                roughnessFactor: 0.9,
            },
            // An annotation cage is a surface, not a solid: an OPEN object has
            // no inside to cull, and a closed one is no worse for being
            // visible from within.
            doubleSided: true,
        }],
        accessors: [
            {
                bufferView: 0, componentType: FLOAT, count: nVert,
                type: 'VEC3', min: min, max: max,
            },
            {
                bufferView: 1, componentType: UNSIGNED_INT, count: idx.length,
                type: 'SCALAR',
            },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: posBytes, target: ARRAY_BUFFER },
            { buffer: 0, byteOffset: idxOffset, byteLength: idx.byteLength, target: ELEMENT_ARRAY_BUFFER },
        ],
        buffers: [{ byteLength: binLength }],
    };

    var jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    var jsonPadded = pad4(jsonBytes.length);
    var binPadded = pad4(binLength);
    var total = 12 + 8 + jsonPadded + 8 + binPadded;

    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true);      // 'glTF'
    dv.setUint32(4, 2, true);               // version
    dv.setUint32(8, total, true);

    // JSON chunk — padded with SPACES, per the spec, so the chunk stays
    // parseable text rather than JSON followed by NULs.
    dv.setUint32(12, jsonPadded, true);
    dv.setUint32(16, 0x4E4F534A, true);     // 'JSON'
    out.set(jsonBytes, 20);
    for (var s = 20 + jsonBytes.length; s < 20 + jsonPadded; s++) out[s] = 0x20;

    // BIN chunk — padded with zeros.
    var binChunk = 20 + jsonPadded;
    dv.setUint32(binChunk, binPadded, true);
    dv.setUint32(binChunk + 4, 0x004E4942, true);   // 'BIN\0'
    out.set(new Uint8Array(pos.buffer, 0, posBytes), binChunk + 8);
    out.set(new Uint8Array(idx.buffer, 0, idx.byteLength), binChunk + 8 + idxOffset);

    return out;
}

/**
 * A mesh object's name as a safe filename stem.
 *
 * Names are free text ("cage #2 / trial A"), and a slash in a download name is
 * a path the browser will not write.
 *
 * @param {string} name @returns {string}
 */
export function meshFilenameStem(name) {
    var stem = String(name == null ? '' : name)
        .replace(/[\\/:*?"<>|]+/g, '-')     // reserved on Windows and/or POSIX
        .replace(/\s+/g, '_')
        .replace(/^[.\-_]+|[.\-_]+$/g, '')
        .slice(0, 80);
    return stem || 'mesh-object';
}
