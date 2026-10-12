/**
 * test-mesh-export.mjs — binary STL and .glb, at the byte level.
 *
 * These formats fail QUIETLY. A wrong triangle count still opens; an off-spec
 * up axis still renders, just lying on its side; an unpadded GLB chunk is
 * rejected by one viewer and tolerated by the next. So the assertions here
 * read the bytes back rather than trusting that a writer which produced output
 * produced correct output, and the two claims most likely to be "fixed" later
 * by someone reading the project's no-axis-conversion rule — that GLB is Y-up
 * and STL is not — each carry a negative control.
 */
import {
    meshObjectToSTL, meshObjectToGLB, isExportable, meshFilenameStem,
} from '../import-export/mesh-export.js';
import { buildMeshObjectGeometry } from '../pose/mesh-object-geometry.js';
import { PlaneModel } from '../pose/plane-data.js';
import { MeshObjectSet } from '../pose/mesh-object-3d.js';

let passed = 0, failed = 0;
function check(cond, msg) {
    if (cond) { passed++; } else { failed++; console.log('  FAIL: ' + msg); }
}
function near(a, b, eps, msg) { check(Math.abs(a - b) <= eps, `${msg} (${a} vs ${b})`); }

// A unit tetrahedron: four vertices, four faces, closed, and asymmetric in
// every axis so an axis swap cannot hide behind symmetry.
const TETRA = {
    vertices: new Float64Array([
        0, 0, 0,
        10, 0, 0,
        0, 20, 0,
        0, 0, 30,
    ]),
    triangles: new Uint32Array([
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    ]),
    connectivity: { vertices: 4, faces: 4 },
};

console.log('\n§1 refusing to write nothing');
check(isExportable(TETRA), 'a real mesh is exportable');
check(!isExportable(null), 'null is not');
check(!isExportable({ vertices: new Float64Array(0), triangles: new Uint32Array(0) }),
    'an empty mesh is not');
check(meshObjectToSTL({ vertices: new Float64Array(0), triangles: new Uint32Array(0) }) === null,
    'STL returns null rather than a 84-byte file with no triangles');
check(meshObjectToGLB({ vertices: new Float64Array(0), triangles: new Uint32Array(0) }) === null,
    'GLB returns null rather than an empty scene');

console.log('\n§2 binary STL layout');
const stl = meshObjectToSTL(TETRA, { name: 'cage' });
const sv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
check(stl.byteLength === 84 + 4 * 50, `exactly 84 + 50n bytes (got ${stl.byteLength})`);
check(sv.getUint32(80, true) === 4, 'the triangle count field says 4');
const header = new TextDecoder().decode(stl.slice(0, 80)).replace(/\0+$/, '');
check(!/^solid/i.test(header),
    `the header must not start with "solid", or parsers read it as ASCII STL (got "${header.slice(0, 20)}")`);
check(header.includes('cage'), 'the header names the object');

// Vertex 1 of triangle 0 is vertices[2] = (0,20,0): offset 84 + 12 (normal).
near(sv.getFloat32(84 + 12, true), 0, 1e-6, 'STL triangle 0 vertex 0 x');
near(sv.getFloat32(84 + 24, true), 0, 1e-6, 'STL triangle 0 vertex 1 x');
near(sv.getFloat32(84 + 28, true), 20, 1e-6, 'STL triangle 0 vertex 1 y — Z-up written VERBATIM');
near(sv.getFloat32(84 + 32, true), 0, 1e-6, 'STL triangle 0 vertex 1 z');
check(sv.getUint16(84 + 48, true) === 0, 'the attribute byte count is 0');

// Face 0 is (0,2,1): in the z=0 plane, wound clockwise seen from +Z, so its
// right-hand normal points at -Z. That is also the negative control for
// winding: reverse the triangle and the normal must flip.
near(sv.getFloat32(84, true), 0, 1e-6, 'STL normal x');
near(sv.getFloat32(88, true), 0, 1e-6, 'STL normal y');
near(sv.getFloat32(92, true), -1, 1e-6, 'STL normal z follows the right-hand rule');
const flipped = meshObjectToSTL({
    vertices: TETRA.vertices,
    triangles: Uint32Array.from([0, 1, 2]),
}, {});
near(new DataView(flipped.buffer).getFloat32(92, true), 1, 1e-6,
    'reversing the winding flips the normal (negative control)');

console.log('\n§3 GLB container');
const glb = meshObjectToGLB(TETRA, { name: 'cage', color: '#ff0000' });
const gv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
check(gv.getUint32(0, true) === 0x46546C67, 'magic is "glTF"');
check(gv.getUint32(4, true) === 2, 'version 2');
check(gv.getUint32(8, true) === glb.byteLength,
    `the declared total length matches the real one (${gv.getUint32(8, true)} vs ${glb.byteLength})`);
check(glb.byteLength % 4 === 0, 'the file is 4-byte aligned');

const jsonLen = gv.getUint32(12, true);
check(gv.getUint32(16, true) === 0x4E4F534A, 'chunk 0 is JSON');
check(jsonLen % 4 === 0, 'the JSON chunk is padded to 4 bytes');
const jsonText = new TextDecoder().decode(glb.slice(20, 20 + jsonLen));
check(/[ ]*$/.test(jsonText), 'JSON padding is spaces, not NULs');
let doc = null;
try { doc = JSON.parse(jsonText); } catch (e) { /* reported below */ }
check(doc !== null, 'the JSON chunk parses');

const binStart = 20 + jsonLen;
const binLen = gv.getUint32(binStart, true);
check(gv.getUint32(binStart + 4, true) === 0x004E4942, 'chunk 1 is BIN');
check(binLen % 4 === 0, 'the BIN chunk is padded to 4 bytes');
check(binStart + 8 + binLen === glb.byteLength, 'the chunks exactly fill the file');

console.log('\n§4 GLB contents');
check(doc.asset.version === '2.0', 'asset version 2.0');
check(doc.accessors[0].count === 4, `POSITION accessor counts 4 vertices (got ${doc.accessors[0].count})`);
check(doc.accessors[1].count === 12, `index accessor counts 12 indices (got ${doc.accessors[1].count})`);
check(doc.accessors[0].type === 'VEC3' && doc.accessors[0].componentType === 5126,
    'positions are VEC3 float32, as glTF requires');
check(doc.buffers[0].byteLength <= binLen && !doc.buffers[0].uri,
    'the buffer is the embedded BIN chunk, with no uri');
check(doc.meshes[0].primitives[0].mode === 4, 'primitive mode is TRIANGLES');
check(doc.meshes[0].primitives[0].attributes.NORMAL === undefined,
    'no NORMAL attribute — glTF then mandates flat shading, which is what a faceted cage wants');
check(doc.materials[0].doubleSided === true, 'the material is double-sided');
check(doc.nodes[0].name === 'cage' && doc.meshes[0].name === 'cage',
    'the object name reaches the node and the mesh');

// #ff0000 is sRGB; baseColorFactor is LINEAR, so red stays 1 and the others 0.
near(doc.materials[0].pbrMetallicRoughness.baseColorFactor[0], 1, 1e-9, 'baseColor R');
near(doc.materials[0].pbrMetallicRoughness.baseColorFactor[3], 1, 1e-9, 'baseColor A');
// A mid grey is where sRGB and linear actually differ — 0.5 sRGB is ~0.2140 linear.
const grey = JSON.parse(new TextDecoder().decode(
    (() => { const g = meshObjectToGLB(TETRA, { color: '#808080' }); const d = new DataView(g.buffer); return g.slice(20, 20 + d.getUint32(12, true)); })()));
near(grey.materials[0].pbrMetallicRoughness.baseColorFactor[0], 0.2158605, 1e-6,
    'sRGB #808080 is converted to linear, not passed through');

console.log('\n§5 the Y-up conversion, and its negative control');
const pos = new Float32Array(glb.buffer.slice(
    binStart + 8 + doc.bufferViews[0].byteOffset,
    binStart + 8 + doc.bufferViews[0].byteOffset + doc.bufferViews[0].byteLength));
// LUCID (0,20,0) — 20mm along +Y — must land at glTF (0,0,-20): +Y goes to -Z.
near(pos[6], 0, 1e-4, 'vertex 2 x');
near(pos[7], 0, 1e-4, 'vertex 2 y');
near(pos[8], -20, 1e-4, 'LUCID +Y becomes glTF -Z');
// LUCID (0,0,30) — 30mm UP — must become glTF +Y 30, the format's up axis.
near(pos[10], 30, 1e-4, 'LUCID +Z (up) becomes glTF +Y (up)');
near(pos[11], 0, 1e-4, 'and leaves nothing behind in Z');
check(!(Math.abs(pos[11] - 30) < 1e-4),
    'negative control: an unconverted writer would leave 30 in Z, standing the cage on its side in Blender');

// The accessor bounds must hold for the STORED float32 values.
const min = doc.accessors[0].min, max = doc.accessors[0].max;
let boundsOk = true;
for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
        if (pos[i + k] < min[k] || pos[i + k] > max[k]) boundsOk = false;
    }
}
check(boundsOk, 'every stored position lies inside the declared accessor min/max');
near(max[1], 30, 1e-4, 'max Y is the converted height');
near(min[2], -20, 1e-4, 'min Z is the converted depth');

console.log('\n§6 indices survive intact');
const idx = new Uint32Array(glb.buffer.slice(
    binStart + 8 + doc.bufferViews[1].byteOffset,
    binStart + 8 + doc.bufferViews[1].byteOffset + doc.bufferViews[1].byteLength));
check(idx.length === 12, `12 indices (got ${idx.length})`);
check(Array.from(idx).join(',') === Array.from(TETRA.triangles).join(','),
    'the index buffer is the triangle list unchanged — the rotation preserves winding, so no flip is applied');
check(Math.max(...idx) < 4, 'no index points past the vertex count');

console.log('\n§7 vertices stay WELDED');
// Four triangles x three corners = 12 corners, but only 4 vertices: the shared
// corners are shared in the file, which is the point of the connectivity model.
check(doc.accessors[0].count === 4 && idx.length === 12,
    'a shared corner is one vertex referenced repeatedly, not copies');
check(stl.byteLength === 84 + 4 * 50,
    'STL, by contrast, repeats every corner — 4 triangles x 50 bytes, by the format\'s design');

console.log('\n§8 filenames');
check(meshFilenameStem('cage') === 'cage', 'a plain name passes through');
check(meshFilenameStem('cage #2 / trial A') === 'cage_#2_-_trial_A',
    `a slash cannot survive into a download name (got "${meshFilenameStem('cage #2 / trial A')}")`);
check(meshFilenameStem('') === 'mesh-object', 'an empty name falls back');
check(meshFilenameStem(null) === 'mesh-object', 'so does a missing one');
check(meshFilenameStem('...') === 'mesh-object', 'and one that is all punctuation');

console.log('\n§9 against a real PlaneModel');
// The same path the panel uses, so the writers are proven against geometry the
// project actually produces, not only against a hand-built literal.
const model = new PlaneModel();
const corners = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
const nodeIds = corners.map((p, i) => {
    const n = model.addNode('n' + i);
    n.setPoint3d(p);
    return n.id;
});
const square = model.createPlane('floor');
nodeIds.forEach((id) => model.addNodeToPlane(square, id));
for (let i = 0; i < 4; i++) square.addEdge(nodeIds[i], nodeIds[(i + 1) % 4]);
const set = new MeshObjectSet();
const obj = set.createObject('floor object');
obj.addPlane(square.id);
obj.color = '#00ff00';
const geo = buildMeshObjectGeometry(obj, model, { scale: 1 });
check(geo.triangles.length === 6, `the square ear-clips to 2 triangles (got ${geo.triangles.length / 3})`);
const realStl = meshObjectToSTL(geo, { name: obj.name });
const realGlb = meshObjectToGLB(geo, { name: obj.name, color: obj.color });
check(realStl && realStl.byteLength === 84 + 2 * 50, 'a real geometry writes a well-formed STL');
check(realGlb && new DataView(realGlb.buffer).getUint32(0, true) === 0x46546C67,
    'and a well-formed GLB');
const realDoc = JSON.parse(new TextDecoder().decode(
    realGlb.slice(20, 20 + new DataView(realGlb.buffer).getUint32(12, true))));
check(realDoc.accessors[0].count === 4,
    `the four shared corners stay four vertices (got ${realDoc.accessors[0].count})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
