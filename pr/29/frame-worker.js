/**
 * Frame extraction worker for pkg.slp files
 *
 * Uses SLPPackageReader with h5wasm lazy files for streaming via range requests.
 * This worker handles all HDF5 operations, keeping the main thread free for rendering.
 */

importScripts('https://cdn.jsdelivr.net/npm/h5wasm@0.8.8/dist/iife/h5wasm.js');
importScripts('slp-package-reader.js');

let h5wasmReady = false;
let reader = null;

// Initialize h5wasm
(async () => {
    try {
        await h5wasm.ready;
        h5wasmReady = true;
        reader = new SLPPackageReader({ FS: h5wasm.FS, h5wasm: h5wasm });
        postMessage({ type: 'ready' });
    } catch (err) {
        postMessage({ type: 'error', error: `Failed to initialize h5wasm: ${err.message}` });
    }
})();

// Message handler
onmessage = async function(e) {
    const { type, ...data } = e.data;

    if (!h5wasmReady) {
        postMessage({ type: 'error', error: 'h5wasm not ready' });
        return;
    }

    try {
        switch (type) {
            case 'loadUrl':
                await handleLoadUrl(data.url);
                break;
            case 'loadFile':
                await handleLoadFile(data.file);
                break;
            case 'getVideos':
                handleGetVideos();
                break;
            case 'getFrame':
                handleGetFrame(data.videoKey, data.embeddedIdx);
                break;
            case 'findFrame':
                handleFindFrame(data.videoKey, data.displayFrame);
                break;
            case 'close':
                handleClose();
                break;
        }
    } catch (err) {
        postMessage({ type: 'error', error: err.message });
    }
};

async function handleLoadUrl(url) {
    const filename = url.split('/').pop();
    postMessage({ type: 'log', message: `Loading: ${filename}`, level: 'info' });

    const result = await reader.open(url);

    postMessage({
        type: 'log',
        message: `File size: ${(result.fileSize / 1024 / 1024).toFixed(2)} MB`,
        level: 'info'
    });

    postMessage({
        type: 'log',
        message: result.streaming ? 'Using range requests (streaming)' : 'Downloaded entire file',
        level: result.streaming ? 'success' : 'warn'
    });

    // Get embedded videos
    const videos = reader.getVideos();

    postMessage({
        type: 'loaded',
        filename: result.filename,
        fileSize: result.fileSize,
        streaming: result.streaming,
        videos: videos
    });
}

async function handleLoadFile(file) {
    postMessage({ type: 'log', message: `Loading local file: ${file.name}`, level: 'info' });

    // Mount the file using WORKERFS
    try {
        h5wasm.FS.mkdir('/local');
    } catch (e) {
        // Directory may already exist
    }

    try {
        h5wasm.FS.unmount('/local');
    } catch (e) {
        // May not be mounted
    }

    h5wasm.FS.mount(h5wasm.FS.filesystems.WORKERFS, { files: [file] }, '/local');

    const h5file = new h5wasm.File(`/local/${file.name}`, 'r');
    reader.openFile(h5file);

    // Get embedded videos
    const videos = reader.getVideos();

    postMessage({
        type: 'loaded',
        filename: file.name,
        fileSize: file.size,
        streaming: false,
        videos: videos
    });
}

function handleGetVideos() {
    const videos = reader.getVideos();
    postMessage({ type: 'videos', videos });
}

function handleGetFrame(videoKey, embeddedIdx) {
    const startTime = performance.now();

    const result = reader.getFrame(videoKey, embeddedIdx);

    const extractTime = performance.now() - startTime;

    // Transfer the buffer (zero-copy)
    postMessage({
        type: 'frame',
        videoKey,
        embeddedIdx: result.embeddedIdx,
        displayFrame: result.displayFrame,
        pngBytes: result.bytes,
        byteLength: result.byteLength,
        format: result.format,
        extractTime,
        totalTime: extractTime
    }, [result.bytes.buffer]);
}

function handleFindFrame(videoKey, displayFrame) {
    const embeddedIdx = reader.findEmbeddedIndex(videoKey, displayFrame);
    const closest = reader.findClosestFrame(videoKey, displayFrame);

    postMessage({
        type: 'findResult',
        videoKey,
        displayFrame,
        embeddedIdx,
        closest
    });
}

function handleClose() {
    if (reader) {
        reader.close();
    }
    postMessage({ type: 'closed' });
}
