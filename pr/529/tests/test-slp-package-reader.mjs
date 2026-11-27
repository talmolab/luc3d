/**
 * test-slp-package-reader.mjs — what `loading/slp-package-reader.js` hands the app.
 *
 * Run through a stand-in for h5wasm, because these are rules about what comes out
 * of h5wasm: its int64 values are BigInt, and a row reads differently per layout.
 * The real reads are in `tests/e2e/slp-embedded-images.mjs`.
 *
 *  1. Sizes and frame numbers come out as plain numbers, from int64 or int32.
 *  2. A frame reads its own row only, never the whole video, in both layouts:
 *     variable-length rows and fixed-width rows (padding trimmed, bytes unsigned).
 *  3. A list entry finds its images by the group it names, not by position.
 *  4. The JS writer's layout, one run of bytes: by `frame_sizes`, or by where the
 *     images start in a file written before sleap-io.js recorded sizes.
 *  5. Red and blue: what a video says, else the file format's default.
 *  6. Uncompressed pixels: nothing trimmed, and the size from the dataset's shape.
 *
 * Run: node tests/run-mjs-tests.mjs slp-package-reader
 */
import assert from 'node:assert/strict';
import { SLPPackageReader, embeddedVideoForEntry } from '../loading/slp-package-reader.js';

/** A PNG-ish row whose bytes include some above 127 (negative as int8). */
const ROWS = [
    [0x89, 0x50, 0x4e, 0x47, 0xae, 0x42, 0x60, 0x82],
    [0x89, 0x50, 0xff, 0xd9],
];

function fakeDataset(shape, attrs, rowsAt) {
    const reads = [];
    return {
        type: 'Dataset',
        shape,
        attrs,
        reads,
        get value() { throw new Error('read the whole dataset'); },
        slice(ranges) {
            reads.push(ranges);
            return rowsAt(ranges[0][0]);
        },
    };
}

function fakeFile(objects) {
    return {
        get: (path) => {
            if (path === '/') return { keys: () => Object.keys(objects).filter((k) => !k.includes('/')) };
            return Object.prototype.hasOwnProperty.call(objects, path.replace(/^\//, '')) ? objects[path.replace(/^\//, '')] : null;
        },
        close() {},
    };
}

function readerOn(objects) {
    const reader = new SLPPackageReader({ FS: {}, h5wasm: {} });
    reader.openFile(fakeFile(objects));
    return reader;
}

/** A variable-length video: h5wasm gives one array per row. */
function variableLength(rows, frameNumbers, attrs) {
    return {
        video0: { type: 'Group' },
        'video0/video': fakeDataset([rows.length], attrs, (i) => [Int8Array.from(rows[i])]),
        'video0/frame_numbers': { shape: [frameNumbers.length], value: frameNumbers },
    };
}

/** A fixed-width video: h5wasm gives the row's bytes flat. */
function fixedWidth(rows, frameNumbers, attrs) {
    const width = Math.max(...rows.map((r) => r.length));
    return {
        video0: { type: 'Group' },
        'video0/video': fakeDataset([rows.length, width], attrs, (i) => {
            const out = new Int8Array(width);
            out.set(Int8Array.from(rows[i]));
            return out;
        }),
        'video0/frame_numbers': { shape: [frameNumbers.length], value: frameNumbers },
    };
}

const INT64_ATTRS = { width: { value: 384n }, height: { value: 256n }, channels: { value: 1n }, format: { value: 'png' } };

// --- 1. plain numbers

{
    const [info] = readerOn(variableLength(ROWS, BigInt64Array.from([7n, 3n]), INT64_ATTRS)).getVideos();
    assert.deepEqual([info.width, info.height, info.channels], [384, 256, 1], 'int64 sizes come out as numbers');
    assert.deepEqual(info.frameNumbers, [7, 3], 'int64 frame numbers come out as numbers, in the file\'s order');
    assert.equal(info.frameCount, 2);
    assert.equal(info.format, 'png');
}
{
    const attrs = { width: { value: 384 }, height: { value: 256 } };
    const [info] = readerOn(variableLength(ROWS, Int32Array.from([2033, 2844]), attrs)).getVideos();
    assert.deepEqual([info.width, info.height, info.channels], [384, 256, null], 'int32 sizes, and a missing one is null');
    assert.deepEqual(info.frameNumbers, [2033, 2844], 'int32 frame numbers');
}
{
    const [info] = readerOn(variableLength(ROWS, BigInt64Array.from([1n, 2n]), { width: { value: 0n } })).getVideos();
    assert.equal(info.width, null, 'a size of 0 counts as unknown, so the loader reads it from an image');
}

// --- 2. one row, either layout

for (const [name, build] of [['variable-length', variableLength], ['fixed-width', fixedWidth]]) {
    const objects = build(ROWS, BigInt64Array.from([7n, 3n]), INT64_ATTRS);
    const reader = readerOn(objects);
    for (const [row, displayFrame] of [[0, 7], [1, 3]]) {
        const frame = reader.getFrame('video0', row);
        assert.deepEqual(Array.from(frame.bytes), ROWS[row], `${name}: row ${row}'s exact bytes, padding trimmed`);
        assert.ok(frame.bytes instanceof Uint8Array, `${name}: bytes are unsigned`);
        assert.equal(frame.byteLength, ROWS[row].length);
        assert.equal(frame.displayFrame, displayFrame);
        assert.equal(frame.embeddedIdx, row);
        assert.equal(frame.bytes.byteOffset, 0, `${name}: transferring the bytes sends this row only`);
        assert.equal(frame.bytes.buffer.byteLength, ROWS[row].length, `${name}: transferring the bytes sends this row only`);
    }
    assert.deepEqual(objects['video0/video'].reads, [[[0, 1]], [[1, 2]]], `${name}: asked for one row each time`);
    assert.throws(() => reader.getFrame('video0', 2), /out of range/, `${name}: past the last row`);
    assert.throws(() => reader.getFrame('video9', 0), /not found/, `${name}: no such video`);
}

// --- 3. list entries find their images by name

{
    const videos = [{ idx: 0, datasetPath: '/video0/video' }, { idx: 1, datasetPath: '/video1/video' }, { idx: 2, datasetPath: '/video2/video' }];
    const entry = (dataset) => ({ embedded: true, dataset });
    assert.equal(embeddedVideoForEntry(videos, entry('video2/video'), 0).idx, 2, 'groups out of list order');
    assert.equal(embeddedVideoForEntry(videos, entry('video0/video'), 1).idx, 0, 'groups out of list order');
    assert.equal(embeddedVideoForEntry(videos, entry('/video1/video'), 2).idx, 1, 'a leading slash changes nothing');
    assert.equal(embeddedVideoForEntry([videos[2]], entry('video2/video'), 0).idx, 2, 'a number past the end of the list');
    assert.equal(embeddedVideoForEntry(videos, entry('video9/video'), 0), null, 'names a group that is not there');
    assert.equal(embeddedVideoForEntry(videos, { embedded: false, dataset: null }, 1), null, 'an external video');
    assert.equal(embeddedVideoForEntry(videos, { embedded: false, dataset: 'video1/video' }, 1), null, 'an external video');
    assert.equal(embeddedVideoForEntry(videos, undefined, 1), null, 'no entry');
    assert.equal(embeddedVideoForEntry(videos, entry(null), 1).idx, 1, 'no name: the group at its position');
    assert.equal(embeddedVideoForEntry(videos, entry(null), 7), null, 'no name, no such group');
}

// --- 4. one run of bytes (the JS writer)

/** PNG signature, then a body: `imageStartOffsets` looks for the signature. */
const png = (...body) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body];

function flatVideo(images, frameNumbers, sizes) {
    const all = Uint8Array.from(images.flat());
    const objects = {
        video0: { type: 'Group' },
        'video0/video': {
            type: 'Dataset',
            shape: [all.length],
            attrs: { format: { value: 'png' }, channel_order: { value: 'RGB' } },
            wholeReads: 0,
            reads: [],
            get value() { this.wholeReads++; return all; },
            slice(ranges) { this.reads.push(ranges); return all.slice(ranges[0][0], ranges[0][1]); },
        },
        'video0/frame_numbers': { shape: [frameNumbers.length], value: Int32Array.from(frameNumbers) },
    };
    if (sizes) objects['video0/frame_sizes'] = { shape: [sizes.length], value: Int32Array.from(sizes) };
    return objects;
}

{
    const images = [png(1, 2, 3), png(4), png(5, 6)];
    const objects = flatVideo(images, [5, 11, 2], images.map((b) => b.length));
    const reader = readerOn(objects);
    const [info] = reader.getVideos();
    assert.equal(info.frameCount, 3, 'three frames, not as many as there are bytes');
    assert.equal(info.flat, true);
    assert.deepEqual(info.frameOffsets, [0, 11, 20, 30], 'each frame\'s start, then the end');
    images.forEach((image, i) => {
        assert.deepEqual(Array.from(reader.getFrame('video0', i).bytes), image, `by frame_sizes: image ${i}`);
    });
    assert.equal(reader.getFrame('video0', 1).displayFrame, 11);
    assert.deepEqual(objects['video0/video'].reads.slice(0, 3), [[[0, 11]], [[11, 20]], [[20, 30]]], 'reads one image each');
    assert.equal(objects['video0/video'].wholeReads, 0, 'sizes known: the whole run is never read');
}
{
    const images = [png(1, 2, 3), png(4), png(5, 6)];
    const objects = flatVideo(images, [5, 11, 2], null);
    const reader = readerOn(objects);
    const [info] = reader.getVideos();
    assert.equal(info.flat, true, 'no sizes: still recognized');
    assert.equal(info.frameOffsets, null, 'where images start is found when one is read, not at open');
    assert.equal(objects['video0/video'].wholeReads, 0, 'opening reads no image bytes');
    images.forEach((image, i) => {
        assert.deepEqual(Array.from(reader.getFrame('video0', i).bytes), image, `by signature: image ${i}`);
    });
    assert.equal(objects['video0/video'].wholeReads, 1, 'the whole run is read once, for that');
    const short = readerOn(flatVideo([png(1), [9, 9, 9, 9, 9]], [0, 1], null));
    short.getVideos();
    assert.throws(() => short.getFrame('video0', 1), /No image 1/, 'fewer images than frames says so');
}
{
    // One frame with one byte per row can't be told from a run of one image: a row, as everywhere.
    const objects = {
        video0: { type: 'Group' },
        'video0/video': fakeDataset([0], {}, () => []),
        'video0/frame_numbers': { shape: [0] },
    };
    const [info] = readerOn(objects).getVideos();
    assert.equal(info.frameCount, 0, 'a video with no images');
    assert.equal(info.flat, false);
}

// --- 5. red and blue

{
    const order = (attr, formatId) => {
        const attrs = attr ? { channel_order: { value: attr } } : {};
        const objects = variableLength(ROWS, Int32Array.from([1, 2]), attrs);
        if (formatId !== undefined) objects.metadata = { attrs: { format_id: { value: formatId } } };
        return readerOn(objects).getVideos()[0].channelOrder;
    };
    assert.equal(order('BGR', 2.0), 'BGR', 'says BGR');
    assert.equal(order('RGB', 1.2), 'RGB', 'says RGB, whatever the format');
    assert.equal(order(null, 1.2), 'BGR', 'format 1.2 and no attribute: SLEAP stored BGR');
    assert.equal(order(null, 1.4), 'RGB', 'format 1.4 and no attribute');
    assert.equal(order(null, undefined), 'BGR', 'no format at all counts as the oldest');
}

// --- 6. uncompressed pixels

{
    const pixels = [1, 2, 3, 0];   // a dark last pixel, which padding-trimming would lose
    const objects = {
        video0: { type: 'Group' },
        'video0/video': fakeDataset([1, 2, 2, 1], { format: { value: 'hdf5' } }, () => Uint8Array.from(pixels)),
        'video0/frame_numbers': { shape: [1], value: BigInt64Array.from([4n]) },
    };
    const reader = readerOn(objects);
    const [info] = reader.getVideos();
    assert.deepEqual([info.height, info.width, info.channels], [2, 2, 1], 'the size comes from the shape, with no attributes');
    assert.equal(readerOn({
        video0: { type: 'Group' },
        'video0/video': fakeDataset([1, 2, 2, 1], {}, () => Uint8Array.from(pixels)),
        'video0/frame_numbers': { shape: [1], value: BigInt64Array.from([4n]) },
    }).getVideos()[0].format, 'hdf5', 'four dimensions and no format attribute: uncompressed, as Python reads it');
    assert.equal(readerOn(variableLength(ROWS, BigInt64Array.from([1n, 2n]), {})).getVideos()[0].format, 'png', 'rows and no format attribute: PNG');
    assert.equal(readerOn(variableLength(ROWS, BigInt64Array.from([1n, 2n]), { format: { value: 'JPG' } })).getVideos()[0].format, 'jpg', 'whatever its case');
    assert.deepEqual(Array.from(reader.getFrame('video0', 0).bytes), pixels, 'the dark last pixel stays');
}

console.log('slp-package-reader: all passed');
