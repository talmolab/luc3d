/**
 * SLPPackageReader - Extract embedded video frames from pkg.slp files
 *
 * This module handles HDF5 parsing for SLEAP package files (.pkg.slp) which
 * store video frames as PNG/JPG bytestrings within HDF5 datasets.
 *
 * IMPORTANT: This module is designed to run inside a Web Worker where h5wasm
 * is available. It requires h5wasm to be initialized before use.
 *
 * Usage:
 *   // In worker context after h5wasm.ready
 *   const reader = new SLPPackageReader();
 *   await reader.open(url);  // or reader.openFile(h5File)
 *
 *   const videos = reader.getVideos();
 *   const frame = reader.getFrame('video0', 0);
 *
 *   reader.close();
 *
 * @module slp-package-reader
 */

/**
 * Metadata for an embedded video in a pkg.slp file
 * @typedef {Object} EmbeddedVideoInfo
 * @property {number} idx - Video index (from video{N} group name)
 * @property {string} key - HDF5 group key (e.g., 'video0')
 * @property {string} datasetPath - Full path to video dataset (e.g., '/video0/video')
 * @property {number[]} shape - Dataset shape [numFrames, maxBytes] or [numFrames]
 * @property {string} format - Image format ('png' | 'jpg' | 'hdf5')
 * @property {string} channelOrder - Color channel order ('RGB' | 'BGR')
 * @property {number} width - Frame width in pixels
 * @property {number} height - Frame height in pixels
 * @property {number} channels - Number of color channels (1=grayscale, 3=color)
 * @property {number} frameCount - Number of embedded frames
 * @property {number[]} frameNumbers - Mapping from embedded index to display frame index
 */

/**
 * Result of extracting a frame from the package
 * @typedef {Object} FrameResult
 * @property {Uint8Array} bytes - Raw image bytes (PNG/JPG)
 * @property {number} byteLength - Length of image data
 * @property {string} format - Image format ('png' | 'jpg')
 * @property {number} embeddedIdx - Index within embedded frames
 * @property {number} displayFrame - Original video frame number
 */

class SLPPackageReader {
    /**
     * Create a new SLPPackageReader
     * @param {Object} [options]
     * @param {Object} [options.FS] - Emscripten filesystem (defaults to h5wasm.FS)
     * @param {typeof h5wasm} [options.h5wasm] - h5wasm module (defaults to global)
     */
    constructor(options = {}) {
        this._FS = options.FS || (typeof h5wasm !== 'undefined' ? h5wasm.FS : null);
        this._h5wasm = options.h5wasm || (typeof h5wasm !== 'undefined' ? h5wasm : null);

        /** @type {Object|null} h5wasm File object */
        this._file = null;

        /** @type {string|null} Current filename for cleanup */
        this._filename = null;

        /** @type {string|null} Mount path */
        this._mountPath = null;

        /** @type {boolean} Whether file was opened via URL (needs cleanup) */
        this._isRemote = false;

        /** @type {Map<string, EmbeddedVideoInfo>} Cached video metadata */
        this._videoCache = new Map();
    }

    /**
     * Check if h5wasm is available
     * @returns {boolean}
     */
    get isReady() {
        return this._FS !== null && this._h5wasm !== null;
    }

    /**
     * Check if a file is currently open
     * @returns {boolean}
     */
    get isOpen() {
        return this._file !== null;
    }

    /**
     * Open a pkg.slp file from a URL with streaming support
     *
     * @param {string} url - URL to the pkg.slp file
     * @returns {Promise<{filename: string, fileSize: number, streaming: boolean}>}
     * @throws {Error} If h5wasm not ready or fetch fails
     */
    async open(url) {
        if (!this.isReady) {
            throw new Error('h5wasm not initialized');
        }

        // Close any existing file
        this.close();

        const filename = url.split('/').pop().split('?')[0] || 'remote.pkg.slp';

        // Check file size and range request support
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (!headResponse.ok) {
            throw new Error(`Failed to fetch: ${headResponse.status} ${headResponse.statusText}`);
        }

        const fileSize = parseInt(headResponse.headers.get('Content-Length')) || 0;

        // Test range request support
        let supportsRanges = false;
        if (fileSize > 0) {
            try {
                const rangeTest = await fetch(url, {
                    method: 'GET',
                    headers: { 'Range': 'bytes=0-0' }
                });
                supportsRanges = rangeTest.status === 206;
            } catch (e) {
                supportsRanges = false;
            }
        }

        // Clean up previous remote mount
        this._cleanupMount();

        let filePath;
        if (supportsRanges && fileSize > 0) {
            // Use lazy file with range requests (streaming)
            try {
                this._FS.mkdir('/slp-remote');
            } catch (e) {
                // Directory may already exist
            }
            this._FS.createLazyFile('/slp-remote', filename, url, true, false);
            filePath = `/slp-remote/${filename}`;
            this._mountPath = '/slp-remote';
        } else {
            // Fall back to full download
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            this._FS.writeFile(`/${filename}`, new Uint8Array(arrayBuffer));
            filePath = `/${filename}`;
            this._mountPath = null;
        }

        this._filename = filename;
        this._isRemote = true;
        this._file = new this._h5wasm.File(filePath, 'r');
        this._videoCache.clear();

        return {
            filename,
            fileSize,
            streaming: supportsRanges && fileSize > 0
        };
    }

    /**
     * Open an already-mounted h5wasm File object
     *
     * @param {Object} h5File - h5wasm File object
     */
    openFile(h5File) {
        this.close();
        this._file = h5File;
        this._isRemote = false;
        this._videoCache.clear();
    }

    /**
     * Close the current file and clean up resources
     */
    close() {
        if (this._file) {
            try {
                this._file.close();
            } catch (e) {
                // Ignore close errors
            }
            this._file = null;
        }

        if (this._isRemote) {
            this._cleanupMount();
        }

        this._videoCache.clear();
        this._filename = null;
        this._isRemote = false;
    }

    /**
     * Clean up filesystem mount
     * @private
     */
    _cleanupMount() {
        if (!this._FS) return;

        if (this._filename) {
            try {
                this._FS.unlink(`/slp-remote/${this._filename}`);
            } catch (e) {}
            try {
                this._FS.unlink(`/${this._filename}`);
            } catch (e) {}
        }
        if (this._mountPath) {
            try {
                this._FS.rmdir(this._mountPath);
            } catch (e) {}
        }
    }

    /**
     * Discover all embedded videos in the package
     *
     * @returns {EmbeddedVideoInfo[]} Array of video metadata, sorted by index
     * @throws {Error} If no file is open
     */
    getVideos() {
        if (!this._file) {
            throw new Error('No file open');
        }

        // Return cached if available
        if (this._videoCache.size > 0) {
            return Array.from(this._videoCache.values()).sort((a, b) => a.idx - b.idx);
        }

        const root = this._file.get('/');
        const keys = root.keys();
        const videos = [];

        for (const key of keys) {
            // Match video{N} pattern
            if (!/^video\d+$/.test(key)) continue;

            const videoGroup = this._file.get(`/${key}`);
            if (!videoGroup || videoGroup.type !== 'Group') continue;

            const videoDataset = this._file.get(`/${key}/video`);
            if (!videoDataset) continue;

            const frameNumbersDs = this._file.get(`/${key}/frame_numbers`);
            const attrs = videoDataset.attrs || {};

            // Read frame_numbers mapping
            let frameNumbers = [];
            if (frameNumbersDs && frameNumbersDs.shape[0] > 0) {
                frameNumbers = Array.from(frameNumbersDs.value);
            }

            const info = {
                idx: parseInt(key.replace('video', '')),
                key: key,
                datasetPath: `/${key}/video`,
                shape: videoDataset.shape,
                format: attrs.format?.value || 'png',
                channelOrder: attrs.channel_order?.value || 'RGB',
                width: attrs.width?.value || null,
                height: attrs.height?.value || null,
                channels: attrs.channels?.value || null,
                frameCount: videoDataset.shape[0],
                frameNumbers: frameNumbers
            };

            videos.push(info);
            this._videoCache.set(key, info);
        }

        return videos.sort((a, b) => a.idx - b.idx);
    }

    /**
     * Get metadata for a specific video
     *
     * @param {string|number} videoKey - Video key ('video0') or index (0)
     * @returns {EmbeddedVideoInfo|null}
     */
    getVideoInfo(videoKey) {
        const key = typeof videoKey === 'number' ? `video${videoKey}` : videoKey;

        // Ensure cache is populated
        if (this._videoCache.size === 0) {
            this.getVideos();
        }

        return this._videoCache.get(key) || null;
    }

    /**
     * Extract a frame from an embedded video
     *
     * @param {string|number} videoKey - Video key ('video0') or index (0)
     * @param {number} embeddedIdx - Index within embedded frames (0 to frameCount-1)
     * @returns {FrameResult} Frame data with bytes and metadata
     * @throws {Error} If video not found or index out of range
     */
    getFrame(videoKey, embeddedIdx) {
        if (!this._file) {
            throw new Error('No file open');
        }

        const key = typeof videoKey === 'number' ? `video${videoKey}` : videoKey;
        const info = this.getVideoInfo(key);

        if (!info) {
            throw new Error(`Video not found: ${key}`);
        }

        if (embeddedIdx < 0 || embeddedIdx >= info.frameCount) {
            throw new Error(`Frame index out of range: ${embeddedIdx} (0-${info.frameCount - 1})`);
        }

        // Read frame data from HDF5
        const dataset = this._file.get(info.datasetPath);
        const frameData = dataset.value[embeddedIdx];

        // Convert Int8Array to Uint8Array
        let bytes;
        if (frameData instanceof Int8Array) {
            bytes = new Uint8Array(frameData.length);
            for (let i = 0; i < frameData.length; i++) {
                bytes[i] = frameData[i] & 0xFF;
            }
        } else if (Array.isArray(frameData)) {
            bytes = new Uint8Array(frameData.length);
            for (let i = 0; i < frameData.length; i++) {
                const b = frameData[i];
                bytes[i] = b < 0 ? b + 256 : b;
            }
        } else {
            bytes = new Uint8Array(frameData);
        }

        // Trim trailing zeros (padding from fixed-length storage)
        let trimEnd = bytes.length;
        while (trimEnd > 0 && bytes[trimEnd - 1] === 0) {
            trimEnd--;
        }
        bytes = bytes.slice(0, trimEnd);

        return {
            bytes: bytes,
            byteLength: bytes.length,
            format: info.format,
            embeddedIdx: embeddedIdx,
            displayFrame: info.frameNumbers[embeddedIdx] ?? embeddedIdx
        };
    }

    /**
     * Find the embedded index for a display frame number
     *
     * @param {string|number} videoKey - Video key or index
     * @param {number} displayFrame - Display frame number to find
     * @returns {number} Embedded index, or -1 if not found
     */
    findEmbeddedIndex(videoKey, displayFrame) {
        const info = this.getVideoInfo(videoKey);
        if (!info) return -1;
        return info.frameNumbers.indexOf(displayFrame);
    }

    /**
     * Find the closest embedded frame to a display frame number
     *
     * @param {string|number} videoKey - Video key or index
     * @param {number} displayFrame - Target display frame number
     * @returns {{embeddedIdx: number, displayFrame: number}|null} Closest frame info
     */
    findClosestFrame(videoKey, displayFrame) {
        const info = this.getVideoInfo(videoKey);
        if (!info || info.frameNumbers.length === 0) return null;

        const frameNumbers = info.frameNumbers;

        // Binary search for insertion point
        let lo = 0, hi = frameNumbers.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (frameNumbers[mid] < displayFrame) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        // Check neighbors to find closest
        let closestIdx;
        if (lo === 0) {
            closestIdx = 0;
        } else if (lo === frameNumbers.length) {
            closestIdx = frameNumbers.length - 1;
        } else {
            const prev = frameNumbers[lo - 1];
            const next = frameNumbers[lo];
            closestIdx = Math.abs(prev - displayFrame) <= Math.abs(next - displayFrame)
                ? lo - 1 : lo;
        }

        return {
            embeddedIdx: closestIdx,
            displayFrame: frameNumbers[closestIdx]
        };
    }

    /**
     * Check if a display frame exists in the embedded video
     *
     * @param {string|number} videoKey - Video key or index
     * @param {number} displayFrame - Display frame number
     * @returns {boolean}
     */
    hasFrame(videoKey, displayFrame) {
        return this.findEmbeddedIndex(videoKey, displayFrame) !== -1;
    }

    /**
     * Get the range of display frames for a video
     *
     * @param {string|number} videoKey - Video key or index
     * @returns {{min: number, max: number, count: number}|null}
     */
    getFrameRange(videoKey) {
        const info = this.getVideoInfo(videoKey);
        if (!info || info.frameNumbers.length === 0) return null;

        const sorted = [...info.frameNumbers].sort((a, b) => a - b);
        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            count: sorted.length
        };
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SLPPackageReader };
} else if (typeof self !== 'undefined') {
    self.SLPPackageReader = SLPPackageReader;
}
