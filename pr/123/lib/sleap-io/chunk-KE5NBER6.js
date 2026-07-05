import {
  Edge,
  Instance,
  Node,
  PredictedInstance,
  Skeleton,
  Symmetry,
  Track,
  parseJsonAttr,
  parseJsonEntry,
  parseSkeletons,
  parseSuggestions,
  parseTracks,
  parseVideosMetadata,
  pointsFromArray,
  predictedPointsFromArray
} from "./chunk-NWJVKWIL.js";

// src/model/labeled-frame.ts
var LabeledFrame = class {
  video;
  frameIdx;
  instances;
  isNegative;
  constructor(options) {
    this.video = options.video;
    this.frameIdx = options.frameIdx;
    this.instances = options.instances ?? [];
    this.isNegative = options.isNegative ?? false;
  }
  get length() {
    return this.instances.length;
  }
  [Symbol.iterator]() {
    return this.instances[Symbol.iterator]();
  }
  at(index) {
    return this.instances[index];
  }
  get userInstances() {
    return this.instances.filter((inst) => inst instanceof Instance);
  }
  get predictedInstances() {
    return this.instances.filter((inst) => inst instanceof PredictedInstance);
  }
  get hasUserInstances() {
    return this.userInstances.length > 0;
  }
  get hasPredictedInstances() {
    return this.predictedInstances.length > 0;
  }
  numpy() {
    return this.instances.map((inst) => inst.numpy());
  }
  get image() {
    return this.video.getFrame(this.frameIdx);
  }
  get unusedPredictions() {
    const usedPredicted = /* @__PURE__ */ new Set();
    for (const inst of this.instances) {
      if (inst instanceof Instance && inst.fromPredicted) {
        usedPredicted.add(inst.fromPredicted);
      }
    }
    const tracks = this.instances.map((inst) => inst.track).filter((track) => track !== null && track !== void 0);
    if (tracks.length) {
      const usedTracks = new Set(tracks);
      return this.predictedInstances.filter((inst) => !inst.track || !usedTracks.has(inst.track));
    }
    return this.predictedInstances.filter((inst) => !usedPredicted.has(inst));
  }
  removePredictions() {
    this.instances = this.instances.filter((inst) => inst instanceof Instance);
  }
  removeEmptyInstances() {
    this.instances = this.instances.filter((inst) => !inst.isEmpty);
  }
};

// src/model/video.ts
var Video = class {
  filename;
  backend;
  backendMetadata;
  sourceVideo;
  openBackend;
  _embedded;
  _shape = null;
  _fps = null;
  constructor(options) {
    this.filename = options.filename;
    this.backend = options.backend ?? null;
    this.backendMetadata = options.backendMetadata ?? {};
    this.sourceVideo = options.sourceVideo ?? null;
    this.openBackend = options.openBackend ?? true;
    this._embedded = options.embedded ?? false;
  }
  get hasEmbeddedImages() {
    return this._embedded;
  }
  get originalVideo() {
    if (!this.sourceVideo) return null;
    let current = this.sourceVideo;
    while (current.sourceVideo) {
      current = current.sourceVideo;
    }
    return current;
  }
  get shape() {
    return this._shape ?? this.backend?.shape ?? this.backendMetadata.shape ?? null;
  }
  set shape(value) {
    this._shape = value;
  }
  get fps() {
    return this._fps ?? this.backend?.fps ?? this.backendMetadata.fps ?? null;
  }
  set fps(value) {
    this._fps = value;
  }
  async getFrame(frameIndex) {
    if (!this.backend) return null;
    return this.backend.getFrame(frameIndex);
  }
  async getFrameTimes() {
    if (!this.backend?.getFrameTimes) return null;
    return this.backend.getFrameTimes();
  }
  close() {
    this.backend?.close();
  }
  matchesPath(other, strict = true) {
    if (Array.isArray(this.filename) || Array.isArray(other.filename)) {
      return JSON.stringify(this.filename) === JSON.stringify(other.filename);
    }
    if (strict) return this.filename === other.filename;
    const basenameA = this.filename.split(/[/\\]/).pop();
    const basenameB = other.filename.split(/[/\\]/).pop();
    return basenameA === basenameB;
  }
};

// src/model/suggestions.ts
var SuggestionFrame = class {
  video;
  frameIdx;
  group;
  metadata;
  constructor(options) {
    this.video = options.video;
    this.frameIdx = options.frameIdx;
    this.group = options.group ?? (options.metadata?.group != null ? String(options.metadata.group) : "default");
    this.metadata = options.metadata ?? {};
  }
};

// src/video/mediabunny-video.ts
import {
  Input,
  UrlSource,
  BlobSource,
  VideoSampleSink,
  EncodedPacketSink,
  ALL_FORMATS
} from "mediabunny";
var MediaBunnyVideoBackend = class _MediaBunnyVideoBackend {
  filename;
  shape;
  fps;
  dataset = null;
  input = null;
  sink = null;
  _frameTimes = [];
  cache = /* @__PURE__ */ new Map();
  cacheSize;
  frameCount = 0;
  decodingPromise = null;
  constructor(filename, options = {}) {
    this.filename = filename;
    this.cacheSize = options.cacheSize ?? 120;
  }
  static async fromUrl(url, options) {
    const backend = new _MediaBunnyVideoBackend(url, options);
    backend.input = new Input({
      source: new UrlSource(url),
      formats: ALL_FORMATS
    });
    await backend.initialize();
    return backend;
  }
  static async fromBlob(blob, filename, options) {
    const backend = new _MediaBunnyVideoBackend(filename, options);
    backend.input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS
    });
    await backend.initialize();
    return backend;
  }
  async initialize() {
    if (!this.input) throw new Error("Input not set");
    const videoTrack = await this.input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("No video track found in file");
    }
    const width = videoTrack.displayWidth;
    const height = videoTrack.displayHeight;
    this.sink = new VideoSampleSink(videoTrack);
    const packetSink = new EncodedPacketSink(videoTrack);
    this._frameTimes = [];
    try {
      for await (const packet of packetSink.packets()) {
        this._frameTimes.push(packet.timestamp);
      }
    } catch (error) {
      this._frameTimes = [];
      this.sink = null;
      throw new Error(
        `Failed to build frame time index: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.frameCount = this._frameTimes.length;
    if (this.frameCount === 0) {
      throw new Error("No frames found in video track");
    }
    this.shape = [this.frameCount, height, width, 3];
    if (this._frameTimes.length >= 2) {
      const firstTimestamp = this._frameTimes[0];
      const lastTimestamp = this._frameTimes[this._frameTimes.length - 1];
      const totalDuration = lastTimestamp - firstTimestamp;
      if (totalDuration > 0) {
        this.fps = (this.frameCount - 1) / totalDuration;
      }
    }
  }
  async getFrame(frameIndex) {
    if (frameIndex < 0 || frameIndex >= this.frameCount) {
      return null;
    }
    const cached = this.cache.get(frameIndex);
    if (cached) {
      this.cache.delete(frameIndex);
      this.cache.set(frameIndex, cached);
      return cached;
    }
    if (this.decodingPromise) {
      await this.decodingPromise;
      if (this.cache.has(frameIndex)) {
        return this.cache.get(frameIndex) ?? null;
      }
    }
    return this.decodeSingleFrame(frameIndex);
  }
  async decodeSingleFrame(frameIndex) {
    if (!this.sink) throw new Error("Backend not initialized");
    const timestamp = this._frameTimes[frameIndex];
    const sample = await this.sink.getSample(timestamp);
    if (!sample) {
      return null;
    }
    const videoFrame = sample.toVideoFrame();
    const bitmap = await createImageBitmap(videoFrame);
    videoFrame.close();
    this.cacheFrame(frameIndex, bitmap);
    return bitmap;
  }
  async prefetch(startIndex, endIndex) {
    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(endIndex, this.frameCount - 1);
    if (startIndex > endIndex) return;
    const uncachedRanges = [];
    let rangeStart = null;
    for (let i = startIndex; i <= endIndex; i++) {
      if (!this.cache.has(i)) {
        if (rangeStart === null) rangeStart = i;
      } else if (rangeStart !== null) {
        uncachedRanges.push([rangeStart, i - 1]);
        rangeStart = null;
      }
    }
    if (rangeStart !== null) {
      uncachedRanges.push([rangeStart, endIndex]);
    }
    for (const [start, end] of uncachedRanges) {
      await this.decodeRange(start, end);
    }
  }
  async getFrames(startIndex, endIndex) {
    await this.prefetch(startIndex, endIndex);
    const result = /* @__PURE__ */ new Map();
    for (let i = startIndex; i <= endIndex; i++) {
      const frame = this.cache.get(i);
      if (frame) {
        result.set(i, frame);
      }
    }
    return result;
  }
  async decodeRange(startIndex, endIndex) {
    if (!this.sink) throw new Error("Backend not initialized");
    const sink = this.sink;
    this.decodingPromise = (async () => {
      try {
        const startTime = this._frameTimes[startIndex];
        const endTime = this._frameTimes[endIndex];
        const timestampToIndex = /* @__PURE__ */ new Map();
        for (let i = startIndex; i <= endIndex; i++) {
          timestampToIndex.set(this._frameTimes[i], i);
        }
        for await (const sample of sink.samples(startTime, endTime)) {
          let frameIndex = timestampToIndex.get(sample.timestamp);
          if (frameIndex === void 0) {
            let bestDiff = Infinity;
            for (const [ts, idx] of timestampToIndex) {
              const diff = Math.abs(ts - sample.timestamp);
              if (diff < bestDiff) {
                bestDiff = diff;
                frameIndex = idx;
              }
            }
          }
          if (frameIndex !== void 0 && !this.cache.has(frameIndex)) {
            const videoFrame = sample.toVideoFrame();
            const bitmap = await createImageBitmap(videoFrame);
            videoFrame.close();
            this.cacheFrame(frameIndex, bitmap);
          }
        }
      } finally {
        this.decodingPromise = null;
      }
    })();
    return this.decodingPromise;
  }
  async getFrameTimes() {
    return [...this._frameTimes];
  }
  get numFrames() {
    return this.frameCount;
  }
  close() {
    this.cache.forEach((bitmap) => {
      bitmap.close();
    });
    this.cache.clear();
    this.sink = null;
    this.input = null;
    this._frameTimes = [];
    this.frameCount = 0;
  }
  cacheFrame(frameIndex, bitmap) {
    if (this.cache.size >= this.cacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== void 0) {
        const evicted = this.cache.get(oldestKey);
        evicted?.close();
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(frameIndex, bitmap);
  }
};

// src/codecs/numpy.ts
function toNumpy(labels, options) {
  return labels.numpy({ returnConfidence: options?.returnConfidence, video: options?.video });
}
function fromNumpy(data, options) {
  if (data.length === 0 || data[0].length === void 0) {
    throw new Error("Input array must have 4 dimensions.");
  }
  const video = options.video ?? options.videos?.[0];
  if (!video) throw new Error("fromNumpy requires a video.");
  if (options.video && options.videos) {
    throw new Error("Cannot specify both video and videos.");
  }
  const skeleton = resolveSkeleton(options);
  const labels = labelsFromNumpy(data, {
    video,
    skeleton,
    trackNames: options.trackNames,
    firstFrame: options.firstFrame,
    returnConfidence: options.returnConfidence
  });
  return labels;
}
function labelsFromNumpy(data, options) {
  const frameCount = data.length;
  if (!frameCount || data[0].length === void 0) {
    throw new Error("Input array must have 4 dimensions.");
  }
  const trackCount = data[0].length;
  const nodeCount = data[0][0]?.length ?? 0;
  if (!nodeCount) {
    throw new Error("Input array must have node dimension.");
  }
  const trackNames = options.trackNames ?? Array.from({ length: trackCount }, (_, idx) => `track${idx}`);
  const tracks = trackNames.map((name) => new Track(name));
  const labeledFrames = [];
  const startFrame = options.firstFrame ?? 0;
  for (let frameIdx = 0; frameIdx < frameCount; frameIdx += 1) {
    const instances = [];
    for (let trackIdx = 0; trackIdx < trackCount; trackIdx += 1) {
      const points = data[frameIdx][trackIdx];
      if (!points) continue;
      const hasData = points.some((point) => point.some((value) => !Number.isNaN(value)));
      if (!hasData) continue;
      const arrayPoints = points.map((point) => {
        if (options.returnConfidence) {
          return [point[0], point[1], point[2] ?? Number.NaN, 1, 0];
        }
        return [point[0], point[1], 1, 0];
      });
      const instance = new PredictedInstance({
        points: predictedPointsFromArray(arrayPoints, options.skeleton.nodeNames),
        skeleton: options.skeleton,
        track: tracks[trackIdx]
      });
      instances.push(instance);
    }
    labeledFrames.push(new LabeledFrame({
      video: options.video,
      frameIdx: startFrame + frameIdx,
      instances
    }));
  }
  return new Labels({
    labeledFrames,
    videos: [options.video],
    skeletons: [options.skeleton],
    tracks
  });
}
function resolveSkeleton(options) {
  if (options.skeleton) return options.skeleton;
  if (Array.isArray(options.skeletons) && options.skeletons.length) return options.skeletons[0];
  if (options.skeletons && !Array.isArray(options.skeletons)) return options.skeletons;
  throw new Error("fromNumpy requires a skeleton.");
}

// src/model/labels.ts
var Labels = class {
  labeledFrames;
  videos;
  skeletons;
  tracks;
  suggestions;
  sessions;
  provenance;
  rois;
  masks;
  bboxes;
  identities;
  /** @internal Lazy frame list for on-demand materialization. */
  _lazyFrameList = null;
  /** @internal Lazy data store holding raw HDF5 data. */
  _lazyDataStore = null;
  constructor(options) {
    this.labeledFrames = options?.labeledFrames ?? [];
    this.videos = options?.videos ?? [];
    this.skeletons = options?.skeletons ?? [];
    this.tracks = options?.tracks ?? [];
    this.suggestions = options?.suggestions ?? [];
    this.sessions = options?.sessions ?? [];
    this.provenance = options?.provenance ?? {};
    this.rois = options?.rois ?? [];
    this.masks = options?.masks ?? [];
    this.bboxes = options?.bboxes ?? [];
    this.identities = options?.identities ?? [];
    if (!this.videos.length && this.labeledFrames.length) {
      const uniqueVideos = /* @__PURE__ */ new Map();
      for (const frame of this.labeledFrames) {
        uniqueVideos.set(frame.video, frame.video);
      }
      this.videos = Array.from(uniqueVideos.values());
    }
    if (!this.skeletons.length && this.labeledFrames.length) {
      const uniqueSkeletons = /* @__PURE__ */ new Map();
      for (const frame of this.labeledFrames) {
        for (const instance of frame.instances) {
          uniqueSkeletons.set(instance.skeleton, instance.skeleton);
        }
      }
      this.skeletons = Array.from(uniqueSkeletons.values());
    }
    if (!this.tracks.length && this.labeledFrames.length) {
      const uniqueTracks = /* @__PURE__ */ new Map();
      for (const frame of this.labeledFrames) {
        for (const instance of frame.instances) {
          if (instance.track) uniqueTracks.set(instance.track, instance.track);
        }
      }
      this.tracks = Array.from(uniqueTracks.values());
    }
  }
  /** Whether this Labels instance is in lazy mode. */
  get isLazy() {
    return this._lazyFrameList !== null;
  }
  /**
   * Materialize all lazy frames, converting to eager mode.
   * No-op if already eager.
   */
  materialize() {
    if (!this._lazyFrameList) return;
    this.labeledFrames = this._lazyFrameList.toArray();
    this._lazyFrameList = null;
    this._lazyDataStore = null;
    const allInstances = this.labeledFrames.flatMap((f) => f.instances);
    for (const roi of this.rois) {
      if (roi._instanceIdx !== null && roi._instanceIdx >= 0 && roi._instanceIdx < allInstances.length) {
        roi.instance = allInstances[roi._instanceIdx];
        roi._instanceIdx = null;
      }
    }
    for (const bbox of this.bboxes) {
      if (bbox._instanceIdx !== null && bbox._instanceIdx >= 0 && bbox._instanceIdx < allInstances.length) {
        bbox.instance = allInstances[bbox._instanceIdx];
        bbox._instanceIdx = null;
      }
    }
  }
  get negativeFrames() {
    if (this._lazyFrameList) this.materialize();
    return this.labeledFrames.filter((f) => f.isNegative);
  }
  get video() {
    if (!this.videos.length) {
      throw new Error("No videos available on Labels.");
    }
    return this.videos[0];
  }
  get length() {
    if (this._lazyFrameList) return this._lazyFrameList.length;
    return this.labeledFrames.length;
  }
  [Symbol.iterator]() {
    if (this._lazyFrameList) return this._lazyFrameList[Symbol.iterator]();
    return this.labeledFrames[Symbol.iterator]();
  }
  get instances() {
    if (this._lazyFrameList) this.materialize();
    return this.labeledFrames.flatMap((frame) => frame.instances);
  }
  find(options) {
    if (this._lazyFrameList) this.materialize();
    return this.labeledFrames.filter((frame) => {
      if (options.video && frame.video !== options.video) {
        return false;
      }
      if (options.frameIdx !== void 0 && frame.frameIdx !== options.frameIdx) {
        return false;
      }
      return true;
    });
  }
  addVideo(video) {
    if (!this.videos.includes(video)) {
      this.videos.push(video);
    }
  }
  append(frame) {
    if (this._lazyFrameList) this.materialize();
    this.labeledFrames.push(frame);
    this.addVideo(frame.video);
  }
  toDict(options) {
    if (this._lazyFrameList) this.materialize();
    return toDict(this, options);
  }
  get staticRois() {
    return this.rois.filter((roi) => roi.isStatic);
  }
  get temporalRois() {
    return this.rois.filter((roi) => !roi.isStatic);
  }
  getRois(filters) {
    if (!filters) return [...this.rois];
    let results = this.rois;
    if (filters.video !== void 0) {
      results = results.filter((r) => r.video === filters.video);
    }
    if (filters.frameIdx !== void 0) {
      results = results.filter((r) => r.frameIdx === filters.frameIdx);
    }
    if (filters.category !== void 0) {
      results = results.filter((r) => r.category === filters.category);
    }
    if (filters.track !== void 0) {
      results = results.filter((r) => r.track === filters.track);
    }
    if (filters.instance !== void 0) {
      results = results.filter((r) => r.instance === filters.instance);
    }
    return results;
  }
  getMasks(filters) {
    if (!filters) return [...this.masks];
    let results = this.masks;
    if (filters.video !== void 0) {
      results = results.filter((m) => m.video === filters.video);
    }
    if (filters.frameIdx !== void 0) {
      results = results.filter((m) => m.frameIdx === filters.frameIdx);
    }
    if (filters.category !== void 0) {
      results = results.filter((m) => m.category === filters.category);
    }
    if (filters.track !== void 0) {
      results = results.filter((m) => m.track === filters.track);
    }
    if (filters.instance !== void 0) {
      results = results.filter((m) => m.instance === filters.instance);
    }
    return results;
  }
  get staticBboxes() {
    return this.bboxes.filter((b) => b.isStatic);
  }
  get temporalBboxes() {
    return this.bboxes.filter((b) => !b.isStatic);
  }
  getBboxes(filters) {
    if (!filters) return [...this.bboxes];
    let results = this.bboxes;
    if (filters.video !== void 0) {
      results = results.filter((b) => b.video === filters.video);
    }
    if (filters.frameIdx !== void 0) {
      results = results.filter((b) => b.frameIdx === filters.frameIdx);
    }
    if (filters.category !== void 0) {
      results = results.filter((b) => b.category === filters.category);
    }
    if (filters.track !== void 0) {
      results = results.filter((b) => b.track === filters.track);
    }
    if (filters.instance !== void 0) {
      results = results.filter((b) => b.instance === filters.instance);
    }
    if (filters.predicted !== void 0) {
      results = results.filter((b) => b.isPredicted === filters.predicted);
    }
    return results;
  }
  static fromNumpy(data, options) {
    const video = options.video ?? options.videos?.[0];
    if (!video) throw new Error("fromNumpy requires a video.");
    if (options.video && options.videos) {
      throw new Error("Cannot specify both video and videos.");
    }
    const skeletons = Array.isArray(options.skeletons) ? options.skeletons : options.skeletons ? [options.skeletons] : options.skeleton ? [options.skeleton] : [];
    if (!skeletons.length) throw new Error("fromNumpy requires a skeleton.");
    return labelsFromNumpy(data, {
      video,
      skeleton: skeletons[0],
      trackNames: options.trackNames,
      firstFrame: options.firstFrame,
      returnConfidence: options.returnConfidence
    });
  }
  numpy(options) {
    if (this._lazyDataStore) {
      return this._lazyDataStore.toNumpy(options);
    }
    const targetVideo = options?.video ?? this.video;
    const frames = this.labeledFrames.filter((frame) => frame.video.matchesPath(targetVideo, true));
    if (!frames.length) return [];
    let maxFrame = Math.max(...frames.map((frame) => frame.frameIdx));
    const videoLength = targetVideo.shape?.[0] ?? 0;
    if (videoLength > 0) {
      maxFrame = Math.max(maxFrame, videoLength - 1);
    }
    const tracks = this.tracks.length ? this.tracks.length : Math.max(1, ...frames.map((frame) => frame.instances.length));
    const nodes = this.skeletons[0]?.nodes.length ?? 0;
    const channelCount = options?.returnConfidence ? 3 : 2;
    const videoArray = Array.from(
      { length: maxFrame + 1 },
      () => Array.from(
        { length: tracks },
        () => Array.from({ length: nodes }, () => Array.from({ length: channelCount }, () => Number.NaN))
      )
    );
    for (const frame of frames) {
      const frameSlot = videoArray[frame.frameIdx];
      if (!frameSlot) continue;
      frame.instances.forEach((inst, idx) => {
        const trackIndex = inst.track ? this.tracks.indexOf(inst.track) : idx;
        const resolvedTrack = trackIndex >= 0 ? trackIndex : idx;
        const trackSlot = frameSlot[resolvedTrack];
        if (!trackSlot) return;
        inst.points.forEach((point, nodeIdx) => {
          if (!trackSlot[nodeIdx]) return;
          const row = [point.xy[0], point.xy[1]];
          if (options?.returnConfidence) {
            const score = "score" in point ? point.score : Number.NaN;
            row.push(score);
          }
          trackSlot[nodeIdx] = row;
        });
      });
    }
    return videoArray;
  }
};

// src/video/media-video.ts
var isBrowser = typeof window !== "undefined";
var MediaVideoBackend = class {
  filename;
  shape;
  fps;
  dataset;
  video;
  canvas;
  ctx;
  ready;
  constructor(filename) {
    if (!isBrowser) {
      throw new Error("MediaVideoBackend requires a browser environment.");
    }
    this.filename = filename;
    this.dataset = null;
    this.video = document.createElement("video");
    this.video.src = filename;
    this.video.crossOrigin = "anonymous";
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ready = new Promise((resolve, reject) => {
      this.video?.addEventListener("loadedmetadata", () => {
        if (!this.video || !this.canvas) return;
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.fps = this.video.duration ? this.video.videoHeight ? void 0 : void 0 : void 0;
        resolve();
      });
      this.video?.addEventListener("error", () => reject(new Error("Failed to load video")));
    });
  }
  async getFrame(frameIndex) {
    if (!this.video || !this.ctx || !this.canvas) return null;
    await this.ready;
    const duration = this.video.duration;
    const frameCount = Math.floor(duration * (this.video?.playbackRate || 1) * 30) || 1;
    const fps = duration ? frameCount / duration : 30;
    const targetTime = frameIndex / fps;
    await seekVideo(this.video, targetTime);
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }
  close() {
    if (this.video) {
      this.video.pause();
      this.video.src = "";
    }
    this.video = null;
    this.canvas = null;
    this.ctx = null;
  }
};
function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Video seek failed"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = Math.max(0, time);
  });
}

// src/codecs/dictionary.ts
function toDict(labels, options) {
  const videoFilter = resolveVideoFilter(labels, options?.video);
  const videos = videoFilter ? [videoFilter.video] : labels.videos;
  const tracks = collectTracks(labels, videoFilter?.video);
  const trackIndex = new Map(tracks.map((track, idx) => [track, idx]));
  const skeletons = labels.skeletons.map((skeleton) => {
    const edges = skeleton.edges.map((edge) => [
      skeleton.index(edge.source.name),
      skeleton.index(edge.destination.name)
    ]);
    const symmetries = skeleton.symmetries.map((sym) => {
      const [left, right] = sym.nodes;
      return [skeleton.index(left.name), skeleton.index(right.name)];
    });
    return {
      name: skeleton.name ?? void 0,
      nodes: skeleton.nodeNames,
      edges,
      symmetries
    };
  });
  const labeledFrames = [];
  for (const frame of labels.labeledFrames) {
    if (videoFilter && !frame.video.matchesPath(videoFilter.video, true)) continue;
    if (options?.skipEmptyFrames && frame.instances.length === 0 && !frame.isNegative) continue;
    const videoIdx = videos.indexOf(frame.video);
    if (videoIdx < 0) continue;
    labeledFrames.push({
      frame_idx: frame.frameIdx,
      video_idx: videoIdx,
      instances: frame.instances.map((instance) => instanceToDict(instance, labels, trackIndex)),
      ...frame.isNegative ? { is_negative: true } : {}
    });
  }
  const suggestions = labels.suggestions.filter((suggestion) => !videoFilter || suggestion.video.matchesPath(videoFilter.video, true)).map((suggestion) => ({
    frame_idx: suggestion.frameIdx,
    video_idx: videos.indexOf(suggestion.video),
    ...suggestion.metadata
  }));
  const videoDicts = videos.map((video) => {
    const backendType = resolveBackendType(video);
    const backend = backendType ? { type: backendType } : void 0;
    const shape = video.shape ? Array.from(video.shape) : void 0;
    const fps = video.fps ?? void 0;
    return {
      filename: video.filename,
      shape,
      fps,
      backend
    };
  });
  return {
    version: "1.0.0",
    skeletons,
    videos: videoDicts,
    tracks: tracks.map((track) => trackToDict(track)),
    labeled_frames: labeledFrames,
    suggestions,
    provenance: labels.provenance ?? {}
  };
}
function fromDict(data) {
  validateDict(data);
  const skeletons = data.skeletons.map((skeleton) => {
    const nodes = skeleton.nodes.map((name) => new Node(name));
    const edges = skeleton.edges.map(([sourceIdx, destIdx]) => new Edge(nodes[sourceIdx], nodes[destIdx]));
    const symmetries = (skeleton.symmetries ?? []).map(
      ([leftIdx, rightIdx]) => new Symmetry([nodes[leftIdx], nodes[rightIdx]])
    );
    return new Skeleton({ name: skeleton.name, nodes, edges, symmetries });
  });
  const videos = data.videos.map((video) => new Video({ filename: video.filename }));
  const tracks = data.tracks.map((track) => new Track(String(track.name ?? "")));
  const labeledFrames = data.labeled_frames.map((frame) => {
    const video = videos[frame.video_idx];
    const instances = frame.instances.map((inst) => dictToInstance(inst, skeletons, tracks));
    return new LabeledFrame({ video, frameIdx: frame.frame_idx, instances, isNegative: frame.is_negative ?? false });
  });
  const suggestions = data.suggestions.map((suggestion) => {
    const entry = suggestion;
    const video = videos[entry.video_idx ?? 0];
    return new SuggestionFrame({ video, frameIdx: entry.frame_idx ?? 0, metadata: entry });
  });
  return new Labels({
    labeledFrames,
    videos,
    skeletons,
    tracks,
    suggestions,
    provenance: data.provenance ?? {}
  });
}
function resolveVideoFilter(labels, video) {
  if (video === void 0) return null;
  if (typeof video === "number") {
    const entry = labels.videos[video];
    if (!entry) throw new Error("Video index out of range.");
    return { video: entry };
  }
  return { video };
}
function collectTracks(labels, video) {
  const trackSet = /* @__PURE__ */ new Set();
  for (const track of labels.tracks) {
    trackSet.add(track);
  }
  for (const frame of labels.labeledFrames) {
    if (video && !frame.video.matchesPath(video, true)) continue;
    for (const instance of frame.instances) {
      if (instance.track) trackSet.add(instance.track);
    }
  }
  return Array.from(trackSet);
}
function instanceToDict(instance, labels, trackIndex) {
  const skeletonIdx = labels.skeletons.indexOf(instance.skeleton);
  const isPredicted = instance instanceof PredictedInstance;
  const points = instance.points.map((point) => {
    const payload2 = {
      x: point.xy[0],
      y: point.xy[1],
      visible: point.visible,
      complete: point.complete
    };
    if (isPredicted && "score" in point) {
      payload2.score = point.score;
    }
    return payload2;
  });
  const payload = {
    type: isPredicted ? "predicted_instance" : "instance",
    skeleton_idx: skeletonIdx,
    points
  };
  if (instance.track) {
    payload.track_idx = trackIndex.get(instance.track);
  }
  if (isPredicted) {
    payload.score = instance.score;
  }
  if (instance.trackingScore !== void 0) {
    payload.tracking_score = instance.trackingScore;
  }
  if (!isPredicted && instance.fromPredicted) {
    payload.has_from_predicted = true;
  }
  return payload;
}
function dictToInstance(data, skeletons, tracks) {
  const type = data.type === "predicted_instance" ? "predicted" : "instance";
  const skeleton = skeletons[data.skeleton_idx ?? 0] ?? skeletons[0];
  const trackIdx = data.track_idx;
  const track = trackIdx !== void 0 ? tracks[trackIdx] : void 0;
  const points = Array.isArray(data.points) ? data.points : [];
  if (type === "predicted") {
    const pointRows2 = points.map((point) => [
      Number(point.x),
      Number(point.y),
      Number(point.score ?? Number.NaN),
      point.visible ? 1 : 0,
      point.complete ? 1 : 0
    ]);
    return new PredictedInstance({
      points: predictedPointsFromArray(pointRows2, skeleton.nodeNames),
      skeleton,
      track,
      score: Number(data.score ?? 0),
      trackingScore: Number(data.tracking_score ?? 0)
    });
  }
  const pointRows = points.map((point) => [
    Number(point.x),
    Number(point.y),
    point.visible ? 1 : 0,
    point.complete ? 1 : 0
  ]);
  return new Instance({
    points: pointsFromArray(pointRows, skeleton.nodeNames),
    skeleton,
    track,
    trackingScore: Number(data.tracking_score ?? 0)
  });
}
function resolveBackendType(video) {
  if (!video.backend) return null;
  if (video.backend instanceof MediaVideoBackend) return "MediaVideo";
  if (video.backend instanceof MediaBunnyVideoBackend) return "MediaBunny";
  return video.backend.constructor?.name ?? null;
}
function trackToDict(track) {
  const payload = { name: track.name };
  const spawnedOn = track.spawned_on;
  if (spawnedOn !== void 0) {
    payload.spawned_on = spawnedOn;
  }
  return payload;
}
function validateDict(data) {
  const required = ["version", "skeletons", "videos", "tracks", "labeled_frames", "suggestions", "provenance"];
  for (const key of required) {
    if (!(key in data)) {
      throw new Error(`Missing required key: ${key}`);
    }
  }
}

// src/model/labels-set.ts
var LabelsSet = class _LabelsSet {
  labels;
  constructor(entries) {
    this.labels = new Map(Object.entries(entries ?? {}));
  }
  get size() {
    return this.labels.size;
  }
  get(key) {
    return this.labels.get(key);
  }
  set(key, value) {
    this.labels.set(key, value);
  }
  delete(key) {
    this.labels.delete(key);
  }
  keys() {
    return this.labels.keys();
  }
  values() {
    return this.labels.values();
  }
  entries() {
    return this.labels.entries();
  }
  [Symbol.iterator]() {
    return this.labels.entries();
  }
  static fromLabelsList(labelsList, keys) {
    const set = new _LabelsSet();
    for (let i = 0; i < labelsList.length; i++) {
      const key = keys?.[i] ?? `labels_${i}`;
      set.set(key, labelsList[i]);
    }
    return set;
  }
  toArray() {
    return Array.from(this.labels.values());
  }
  keyArray() {
    return Array.from(this.labels.keys());
  }
};

// src/model/camera.ts
function rodriguesTransformation(input) {
  if (input.length === 3 && Array.isArray(input[0]) === false) {
    const rvec = input;
    const theta2 = Math.hypot(rvec[0], rvec[1], rvec[2]);
    if (theta2 === 0) {
      return { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], vector: rvec };
    }
    const axis = rvec.map((v) => v / theta2);
    const [x, y, z] = axis;
    const cos = Math.cos(theta2);
    const sin = Math.sin(theta2);
    const K = [
      [0, -z, y],
      [z, 0, -x],
      [-y, x, 0]
    ];
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const KK = multiply3x3(K, K);
    const matrix2 = add3x3(add3x3(I, scale3x3(K, sin)), scale3x3(KK, 1 - cos));
    return { matrix: matrix2, vector: rvec };
  }
  const matrix = input;
  const trace = matrix[0][0] + matrix[1][1] + matrix[2][2];
  const cosTheta = Math.min(1, Math.max(-1, (trace - 1) / 2));
  const theta = Math.acos(cosTheta);
  if (theta === 0) {
    return { matrix, vector: [0, 0, 0] };
  }
  const rx = (matrix[2][1] - matrix[1][2]) / (2 * Math.sin(theta));
  const ry = (matrix[0][2] - matrix[2][0]) / (2 * Math.sin(theta));
  const rz = (matrix[1][0] - matrix[0][1]) / (2 * Math.sin(theta));
  return { matrix, vector: [rx * theta, ry * theta, rz * theta] };
}
function multiply3x3(a, b) {
  const result = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      result[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return result;
}
function add3x3(a, b) {
  return a.map((row, i) => row.map((val, j) => val + b[i][j]));
}
function scale3x3(a, scale) {
  return a.map((row) => row.map((val) => val * scale));
}
var Camera = class {
  name;
  rvec;
  tvec;
  matrix;
  distortions;
  size;
  constructor(options) {
    this.name = options.name;
    this.rvec = options.rvec;
    this.tvec = options.tvec;
    this.matrix = options.matrix;
    this.distortions = options.distortions;
    this.size = options.size;
  }
};
var CameraGroup = class {
  cameras;
  metadata;
  constructor(options) {
    this.cameras = options?.cameras ?? [];
    this.metadata = options?.metadata ?? {};
  }
};
var InstanceGroup = class {
  instanceByCamera;
  score;
  identity;
  instance3d;
  metadata;
  _points;
  constructor(options) {
    this.instanceByCamera = options.instanceByCamera instanceof Map ? options.instanceByCamera : /* @__PURE__ */ new Map();
    if (!(options.instanceByCamera instanceof Map)) {
      for (const [key, value] of Object.entries(options.instanceByCamera)) {
        const camera = key;
        this.instanceByCamera.set(camera, value);
      }
    }
    this.score = options.score;
    this.identity = options.identity;
    this.instance3d = options.instance3d;
    this._points = options.points;
    this.metadata = options.metadata ?? {};
  }
  get points() {
    if (this.instance3d?.points) return this.instance3d.points;
    return this._points;
  }
  set points(value) {
    this._points = value;
  }
  get instances() {
    return Array.from(this.instanceByCamera.values());
  }
};
var FrameGroup = class {
  frameIdx;
  instanceGroups;
  labeledFrameByCamera;
  metadata;
  constructor(options) {
    this.frameIdx = options.frameIdx;
    this.instanceGroups = options.instanceGroups;
    this.labeledFrameByCamera = options.labeledFrameByCamera instanceof Map ? options.labeledFrameByCamera : /* @__PURE__ */ new Map();
    if (!(options.labeledFrameByCamera instanceof Map)) {
      for (const [key, value] of Object.entries(options.labeledFrameByCamera)) {
        const camera = key;
        this.labeledFrameByCamera.set(camera, value);
      }
    }
    this.metadata = options.metadata ?? {};
  }
  get cameras() {
    return Array.from(this.labeledFrameByCamera.keys());
  }
  get labeledFrames() {
    return Array.from(this.labeledFrameByCamera.values());
  }
  getFrame(camera) {
    return this.labeledFrameByCamera.get(camera);
  }
};
var RecordingSession = class {
  cameraGroup;
  frameGroupByFrameIdx;
  videoByCamera;
  cameraByVideo;
  metadata;
  constructor(options) {
    this.cameraGroup = options?.cameraGroup ?? new CameraGroup();
    this.frameGroupByFrameIdx = options?.frameGroupByFrameIdx ?? /* @__PURE__ */ new Map();
    this.videoByCamera = options?.videoByCamera ?? /* @__PURE__ */ new Map();
    this.cameraByVideo = options?.cameraByVideo ?? /* @__PURE__ */ new Map();
    this.metadata = options?.metadata ?? {};
  }
  get frameGroups() {
    return this.frameGroupByFrameIdx;
  }
  get videos() {
    return Array.from(this.videoByCamera.values());
  }
  get cameras() {
    return Array.from(this.videoByCamera.keys());
  }
  addVideo(video, camera) {
    if (!this.cameraGroup.cameras.includes(camera)) {
      this.cameraGroup.cameras.push(camera);
    }
    this.videoByCamera.set(camera, video);
    this.cameraByVideo.set(video, camera);
  }
  getCamera(video) {
    return this.cameraByVideo.get(video);
  }
  getVideo(camera) {
    return this.videoByCamera.get(camera);
  }
};
function makeCameraFromDict(data) {
  return new Camera({
    name: data.name,
    rvec: data.rotation ?? [0, 0, 0],
    tvec: data.translation ?? [0, 0, 0],
    matrix: data.matrix,
    distortions: data.distortions,
    size: data.size
  });
}

// src/model/identity.ts
var Identity = class {
  name;
  color;
  metadata;
  constructor(options) {
    this.name = options?.name ?? "";
    this.color = options?.color;
    this.metadata = options?.metadata ?? {};
  }
};

// src/model/instance3d.ts
var Instance3D = class {
  points;
  skeleton;
  score;
  metadata;
  constructor(options) {
    this.points = options.points;
    this.skeleton = options.skeleton;
    this.score = options.score;
    this.metadata = options?.metadata ?? {};
  }
  get nVisible() {
    if (!this.points) return 0;
    return this.points.filter((p) => !p.some(Number.isNaN)).length;
  }
  get isEmpty() {
    return this.nVisible === 0;
  }
};
var PredictedInstance3D = class extends Instance3D {
  pointScores;
  constructor(options) {
    super(options);
    this.pointScores = options.pointScores;
  }
};

// src/model/lazy.ts
var LazyDataStore = class {
  framesData;
  instancesData;
  pointsData;
  predPointsData;
  skeletons;
  tracks;
  videos;
  formatId;
  negativeFrames;
  constructor(options) {
    this.framesData = options.framesData;
    this.instancesData = options.instancesData;
    this.pointsData = options.pointsData;
    this.predPointsData = options.predPointsData;
    this.skeletons = options.skeletons;
    this.tracks = options.tracks;
    this.videos = options.videos;
    this.formatId = options.formatId;
    this.negativeFrames = options.negativeFrames ?? /* @__PURE__ */ new Set();
  }
  /** Total number of frames in the store. */
  get frameCount() {
    return (this.framesData.frame_id ?? []).length;
  }
  /**
   * Materialize a single LabeledFrame by index.
   */
  materializeFrame(frameIdx) {
    const frameIds = this.framesData.frame_id ?? [];
    if (frameIdx < 0 || frameIdx >= frameIds.length) return null;
    const rawVideoId = Number(this.framesData.video?.[frameIdx] ?? 0);
    const videoIndex = rawVideoId;
    const frameIndex = Number(this.framesData.frame_idx?.[frameIdx] ?? 0);
    const instStart = Number(this.framesData.instance_id_start?.[frameIdx] ?? 0);
    const instEnd = Number(this.framesData.instance_id_end?.[frameIdx] ?? 0);
    const video = this.videos[videoIndex];
    if (!video) return null;
    const instances = [];
    const instanceById = /* @__PURE__ */ new Map();
    const fromPredictedPairs = [];
    for (let instIdx = instStart; instIdx < instEnd; instIdx++) {
      const instanceType = Number(this.instancesData.instance_type?.[instIdx] ?? 0);
      const skeletonId = Number(this.instancesData.skeleton?.[instIdx] ?? 0);
      const trackId = Number(this.instancesData.track?.[instIdx] ?? -1);
      const pointStart = Number(this.instancesData.point_id_start?.[instIdx] ?? 0);
      const pointEnd = Number(this.instancesData.point_id_end?.[instIdx] ?? 0);
      const score = Number(this.instancesData.score?.[instIdx] ?? 0);
      const rawTrackingScore = this.formatId < 1.2 ? 0 : Number(this.instancesData.tracking_score?.[instIdx] ?? 0);
      const trackingScore = Number.isNaN(rawTrackingScore) ? 0 : rawTrackingScore;
      const fromPredicted = Number(this.instancesData.from_predicted?.[instIdx] ?? -1);
      const skeleton = this.skeletons[skeletonId] ?? this.skeletons[0];
      const track = trackId >= 0 ? this.tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        const points = this.slicePoints(this.pointsData, pointStart, pointEnd);
        instance = new Instance({ points: pointsFromArray(points, skeleton.nodeNames), skeleton, track, trackingScore });
        if (this.formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        const points = this.slicePoints(this.predPointsData, pointStart, pointEnd, true);
        instance = new PredictedInstance({ points: predictedPointsFromArray(points, skeleton.nodeNames), skeleton, track, score, trackingScore });
        if (this.formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
      }
      instanceById.set(instIdx, instance);
      instances.push(instance);
    }
    for (const [instanceId, fromPredictedId] of fromPredictedPairs) {
      const instance = instanceById.get(instanceId);
      const predicted = instanceById.get(fromPredictedId);
      if (instance && predicted instanceof PredictedInstance && instance instanceof Instance) {
        instance.fromPredicted = predicted;
      }
    }
    const frame = new LabeledFrame({ video, frameIdx: frameIndex, instances });
    const negKey = `${videoIndex}:${frameIndex}`;
    if (this.negativeFrames.has(negKey)) {
      frame.isNegative = true;
    }
    return frame;
  }
  /**
   * Build a 4D numpy-like array directly from raw column data without
   * materializing any LabeledFrame or Instance objects.
   *
   * Returns [frames, tracks/instances, nodes, coords] where coords is
   * [x, y] or [x, y, score] when returnConfidence is true.
   */
  toNumpy(options) {
    const targetVideo = options?.video ?? this.videos[0];
    if (!targetVideo) return [];
    const targetVideoIdx = this.videos.indexOf(targetVideo);
    if (targetVideoIdx < 0) return [];
    const frameIds = this.framesData.frame_id ?? [];
    const frameVideos = this.framesData.video ?? [];
    const frameIndices = this.framesData.frame_idx ?? [];
    const instStarts = this.framesData.instance_id_start ?? [];
    const instEnds = this.framesData.instance_id_end ?? [];
    let maxFrameIdx = 0;
    const trackCount = this.tracks.length ? this.tracks.length : (() => {
      let maxInst = 1;
      for (let i = 0; i < frameIds.length; i++) {
        if (Number(frameVideos[i]) !== targetVideoIdx) continue;
        const count = Number(instEnds[i]) - Number(instStarts[i]);
        if (count > maxInst) maxInst = count;
      }
      return maxInst;
    })();
    const matchingFrames = [];
    for (let i = 0; i < frameIds.length; i++) {
      if (Number(frameVideos[i]) !== targetVideoIdx) continue;
      const fi = Number(frameIndices[i]);
      if (fi > maxFrameIdx) maxFrameIdx = fi;
      matchingFrames.push(i);
    }
    if (!matchingFrames.length) return [];
    const videoLength = targetVideo.shape?.[0] ?? 0;
    if (videoLength > 0) {
      maxFrameIdx = Math.max(maxFrameIdx, videoLength - 1);
    }
    const nodeCount = this.skeletons[0]?.nodes.length ?? 0;
    const channelCount = options?.returnConfidence ? 3 : 2;
    const output = Array.from(
      { length: maxFrameIdx + 1 },
      () => Array.from(
        { length: trackCount },
        () => Array.from({ length: nodeCount }, () => Array.from({ length: channelCount }, () => Number.NaN))
      )
    );
    const instTypes = this.instancesData.instance_type ?? [];
    const instTracks = this.instancesData.track ?? [];
    const instPointStarts = this.instancesData.point_id_start ?? [];
    const instPointEnds = this.instancesData.point_id_end ?? [];
    const instScores = this.instancesData.score ?? [];
    const px = this.pointsData.x ?? [];
    const py = this.pointsData.y ?? [];
    const ppx = this.predPointsData.x ?? [];
    const ppy = this.predPointsData.y ?? [];
    const ppScores = this.predPointsData.score ?? [];
    const coordOffset = this.formatId < 1.1 ? -0.5 : 0;
    for (const fi of matchingFrames) {
      const frameSlotIdx = Number(frameIndices[fi]);
      const frameSlot = output[frameSlotIdx];
      if (!frameSlot) continue;
      const iStart = Number(instStarts[fi]);
      const iEnd = Number(instEnds[fi]);
      let localIdx = 0;
      for (let instIdx = iStart; instIdx < iEnd; instIdx++) {
        const isPredicted = Number(instTypes[instIdx]) === 1;
        const trackId = Number(instTracks[instIdx]);
        const trackIndex = trackId >= 0 && this.tracks.length ? trackId : localIdx;
        localIdx++;
        const trackSlot = frameSlot[trackIndex];
        if (!trackSlot) continue;
        const pStart = Number(instPointStarts[instIdx]);
        const pEnd = Number(instPointEnds[instIdx]);
        const pointCount = Math.min(pEnd - pStart, nodeCount);
        if (isPredicted) {
          for (let p = 0; p < pointCount; p++) {
            const row = trackSlot[p];
            if (!row) continue;
            row[0] = Number(ppx[pStart + p]) + coordOffset;
            row[1] = Number(ppy[pStart + p]) + coordOffset;
            if (channelCount === 3) {
              row[2] = Number(ppScores[pStart + p] ?? Number.NaN);
            }
          }
        } else {
          for (let p = 0; p < pointCount; p++) {
            const row = trackSlot[p];
            if (!row) continue;
            row[0] = Number(px[pStart + p]) + coordOffset;
            row[1] = Number(py[pStart + p]) + coordOffset;
            if (channelCount === 3) {
              row[2] = Number.NaN;
            }
          }
        }
      }
    }
    return output;
  }
  /** Materialize all frames at once. */
  materializeAll() {
    const frames = [];
    for (let i = 0; i < this.frameCount; i++) {
      const frame = this.materializeFrame(i);
      if (frame) frames.push(frame);
    }
    return frames;
  }
  slicePoints(data, start, end, predicted = false) {
    const xs = data.x ?? [];
    const ys = data.y ?? [];
    const visible = data.visible ?? [];
    const complete = data.complete ?? [];
    const scores = data.score ?? [];
    const points = [];
    for (let i = start; i < end; i++) {
      if (predicted) {
        points.push([xs[i], ys[i], scores[i], visible[i], complete[i]]);
      } else {
        points.push([xs[i], ys[i], visible[i], complete[i]]);
      }
    }
    return points;
  }
};
var LazyFrameList = class {
  store;
  cache;
  constructor(store) {
    this.store = store;
    this.cache = /* @__PURE__ */ new Map();
  }
  get length() {
    return this.store.frameCount;
  }
  /** Get a frame by index, materializing it if needed. */
  at(index) {
    if (index < 0 || index >= this.length) return void 0;
    if (this.cache.has(index)) return this.cache.get(index);
    const frame = this.store.materializeFrame(index);
    if (frame) {
      this.cache.set(index, frame);
    }
    return frame ?? void 0;
  }
  /** Materialize all frames and return as a regular array. */
  toArray() {
    const result = [];
    for (let i = 0; i < this.length; i++) {
      const frame = this.at(i);
      if (frame) result.push(frame);
    }
    return result;
  }
  /** Iterator support. Skips null frames instead of stopping early. */
  [Symbol.iterator]() {
    let index = 0;
    const self = this;
    return {
      next() {
        while (index < self.length) {
          const frame = self.at(index++);
          if (frame) return { value: frame, done: false };
        }
        return { value: void 0, done: true };
      }
    };
  }
  /** Number of frames that have been materialized. */
  get materializedCount() {
    return this.cache.size;
  }
};

// src/model/roi.ts
var _maskFactory = null;
function _registerMaskFactory(factory) {
  _maskFactory = factory;
}
var AnnotationType = /* @__PURE__ */ ((AnnotationType2) => {
  AnnotationType2[AnnotationType2["DEFAULT"] = 0] = "DEFAULT";
  AnnotationType2[AnnotationType2["BOUNDING_BOX"] = 1] = "BOUNDING_BOX";
  AnnotationType2[AnnotationType2["SEGMENTATION"] = 2] = "SEGMENTATION";
  AnnotationType2[AnnotationType2["ARENA"] = 3] = "ARENA";
  AnnotationType2[AnnotationType2["ANCHOR"] = 4] = "ANCHOR";
  return AnnotationType2;
})(AnnotationType || {});
var ROI = class _ROI {
  geometry;
  name;
  category;
  source;
  video;
  frameIdx;
  track;
  instance;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  constructor(options) {
    this.geometry = options.geometry;
    this.name = options.name ?? "";
    this.category = options.category ?? "";
    this.source = options.source ?? "";
    this.video = options.video ?? null;
    this.frameIdx = options.frameIdx ?? null;
    this.track = options.track ?? null;
    this.instance = options.instance ?? null;
  }
  static fromBbox(x, y, width, height, options) {
    const geometry = {
      type: "Polygon",
      coordinates: [
        [
          [x, y],
          [x + width, y],
          [x + width, y + height],
          [x, y + height],
          [x, y]
        ]
      ]
    };
    return new _ROI({
      geometry,
      ...options
    });
  }
  static fromXyxy(x1, y1, x2, y2, options) {
    const geometry = {
      type: "Polygon",
      coordinates: [
        [
          [x1, y1],
          [x2, y1],
          [x2, y2],
          [x1, y2],
          [x1, y1]
        ]
      ]
    };
    return new _ROI({
      geometry,
      ...options
    });
  }
  static fromPolygon(coords, options) {
    const ring = [...coords];
    if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push([ring[0][0], ring[0][1]]);
    }
    const geometry = { type: "Polygon", coordinates: [ring] };
    return new _ROI({
      geometry,
      ...options
    });
  }
  static fromMultiPolygon(polygons, options) {
    return new _ROI({
      geometry: { type: "MultiPolygon", coordinates: polygons },
      ...options
    });
  }
  explode() {
    const copyFields = {
      name: this.name,
      category: this.category,
      source: this.source,
      video: this.video,
      frameIdx: this.frameIdx,
      track: this.track,
      instance: this.instance
    };
    if (this.geometry.type === "MultiPolygon") {
      return this.geometry.coordinates.map(
        (coords) => new _ROI({
          geometry: { type: "Polygon", coordinates: coords },
          ...copyFields
        })
      );
    }
    if (this.geometry.type === "GeometryCollection") {
      return this.geometry.geometries.map(
        (geom) => new _ROI({
          geometry: geom,
          ...copyFields
        })
      );
    }
    return [new _ROI({
      geometry: this.geometry,
      ...copyFields
    })];
  }
  toGeoJSON() {
    return {
      type: "Feature",
      geometry: this.geometry,
      properties: {
        name: this.name,
        category: this.category,
        source: this.source,
        frame_idx: this.frameIdx,
        roi_type: this.isStatic ? "static" : "temporal"
      }
    };
  }
  get isStatic() {
    return this.frameIdx === null;
  }
  get isBbox() {
    if (this.geometry.type !== "Polygon") return false;
    const coords = this.geometry.coordinates[0];
    if (!coords || coords.length !== 5) return false;
    for (let i = 0; i < 4; i++) {
      const dx = Math.abs(coords[i + 1][0] - coords[i][0]);
      const dy = Math.abs(coords[i + 1][1] - coords[i][1]);
      if (dx > 1e-10 && dy > 1e-10) return false;
    }
    return true;
  }
  get bounds() {
    const points = this._allPoints();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  get area() {
    if (this.geometry.type === "Point") return 0;
    if (this.geometry.type === "MultiPoint") return 0;
    if (this.geometry.type === "LineString") return 0;
    if (this.geometry.type === "Polygon") {
      return polygonArea(this.geometry.coordinates);
    }
    if (this.geometry.type === "MultiPolygon") {
      let total = 0;
      for (const poly of this.geometry.coordinates) {
        total += polygonArea(poly);
      }
      return total;
    }
    if (this.geometry.type === "GeometryCollection") {
      let total = 0;
      for (const geom of this.geometry.geometries) {
        const sub = new _ROI({ geometry: geom });
        total += sub.area;
      }
      return total;
    }
    return 0;
  }
  get centroid() {
    if (this.geometry.type === "Point") {
      return { x: this.geometry.coordinates[0], y: this.geometry.coordinates[1] };
    }
    const b = this.bounds;
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  toMask(height, width) {
    if (!_maskFactory) {
      throw new Error(
        "SegmentationMask not available. Import mask.ts before calling toMask()."
      );
    }
    const mask = rasterizeGeometry(this.geometry, height, width);
    return _maskFactory(mask, height, width, {
      name: this.name,
      category: this.category,
      source: this.source,
      video: this.video,
      frameIdx: this.frameIdx,
      track: this.track,
      instance: this.instance
    });
  }
  _allPoints() {
    if (this.geometry.type === "Point") {
      return [this.geometry.coordinates];
    }
    if (this.geometry.type === "Polygon") {
      return this.geometry.coordinates.flat();
    }
    if (this.geometry.type === "MultiPolygon") {
      return this.geometry.coordinates.flat(2);
    }
    if (this.geometry.type === "MultiPoint") {
      return this.geometry.coordinates;
    }
    if (this.geometry.type === "LineString") {
      return this.geometry.coordinates;
    }
    if (this.geometry.type === "GeometryCollection") {
      const pts = [];
      for (const geom of this.geometry.geometries) {
        const sub = new _ROI({ geometry: geom });
        pts.push(...sub._allPoints());
      }
      return pts;
    }
    return [];
  }
};
function ringArea(ring) {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}
function polygonArea(rings) {
  if (rings.length === 0) return 0;
  let area = Math.abs(ringArea(rings[0]));
  for (let i = 1; i < rings.length; i++) {
    area -= Math.abs(ringArea(rings[i]));
  }
  return Math.abs(area);
}
function rasterizeGeometry(geometry, height, width) {
  const mask = new Uint8Array(height * width);
  if (geometry.type === "Polygon") {
    scanlineFill(geometry.coordinates[0], mask, height, width, true);
    for (let i = 1; i < geometry.coordinates.length; i++) {
      scanlineFill(geometry.coordinates[i], mask, height, width, false);
    }
    return mask;
  }
  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      const polyMask = rasterizeGeometry({ type: "Polygon", coordinates: poly }, height, width);
      for (let i = 0; i < mask.length; i++) {
        if (polyMask[i]) mask[i] = 1;
      }
    }
    return mask;
  }
  if (geometry.type === "GeometryCollection") {
    for (const geom of geometry.geometries) {
      const subMask = rasterizeGeometry(geom, height, width);
      for (let i = 0; i < mask.length; i++) {
        if (subMask[i]) mask[i] = 1;
      }
    }
    return mask;
  }
  return mask;
}
function scanlineFill(coords, mask, height, width, fill) {
  if (!coords || coords.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of coords) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const startY = Math.max(0, Math.floor(minY));
  const endY = Math.min(height - 1, Math.floor(maxY));
  const n = coords.length - 1;
  for (let y = startY; y <= endY; y++) {
    const intersections = [];
    for (let i = 0; i < n; i++) {
      const y0 = coords[i][1];
      const y1 = coords[i + 1][1];
      if (y0 === y1) continue;
      const lo = Math.min(y0, y1);
      const hi = Math.max(y0, y1);
      if (lo <= y + 0.5 && y + 0.5 < hi) {
        const x0 = coords[i][0];
        const x1 = coords[i + 1][0];
        const t = (y + 0.5 - y0) / (y1 - y0);
        intersections.push(x0 + t * (x1 - x0));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let j = 0; j < intersections.length - 1; j += 2) {
      const xStart = Math.max(0, Math.floor(intersections[j]));
      const xEnd = Math.min(width, Math.ceil(intersections[j + 1]));
      const val = fill ? 1 : 0;
      for (let x = xStart; x < xEnd; x++) {
        mask[y * width + x] = val;
      }
    }
  }
}
function encodeWkb(geometry) {
  if (geometry.type === "Point") {
    const buf = new ArrayBuffer(21);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint32(1, 1, true);
    view.setFloat64(5, geometry.coordinates[0], true);
    view.setFloat64(13, geometry.coordinates[1], true);
    return new Uint8Array(buf);
  }
  if (geometry.type === "Polygon") {
    return encodeWkbPolygon(geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    const polygonBuffers = [];
    for (const poly of geometry.coordinates) {
      polygonBuffers.push(encodeWkbPolygon(poly));
    }
    const totalSize = 9 + polygonBuffers.reduce((sum, b) => sum + b.length, 0);
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint32(1, 6, true);
    view.setUint32(5, geometry.coordinates.length, true);
    let offset = 9;
    for (const pb of polygonBuffers) {
      new Uint8Array(buf, offset, pb.length).set(pb);
      offset += pb.length;
    }
    return new Uint8Array(buf);
  }
  if (geometry.type === "LineString") {
    const numPoints = geometry.coordinates.length;
    const size = 9 + numPoints * 16;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint32(1, 2, true);
    view.setUint32(5, numPoints, true);
    let offset = 9;
    for (const [x, y] of geometry.coordinates) {
      view.setFloat64(offset, x, true);
      view.setFloat64(offset + 8, y, true);
      offset += 16;
    }
    return new Uint8Array(buf);
  }
  if (geometry.type === "MultiPoint") {
    const numPoints = geometry.coordinates.length;
    const size = 9 + numPoints * 21;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint32(1, 4, true);
    view.setUint32(5, numPoints, true);
    let offset = 9;
    for (const [x, y] of geometry.coordinates) {
      view.setUint8(offset, 1);
      view.setUint32(offset + 1, 1, true);
      view.setFloat64(offset + 5, x, true);
      view.setFloat64(offset + 13, y, true);
      offset += 21;
    }
    return new Uint8Array(buf);
  }
  if (geometry.type === "GeometryCollection") {
    const subBuffers = [];
    for (const geom of geometry.geometries) {
      subBuffers.push(encodeWkb(geom));
    }
    const totalSize = 9 + subBuffers.reduce((sum, b) => sum + b.length, 0);
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint32(1, 7, true);
    view.setUint32(5, geometry.geometries.length, true);
    let offset = 9;
    for (const sb of subBuffers) {
      new Uint8Array(buf, offset, sb.length).set(sb);
      offset += sb.length;
    }
    return new Uint8Array(buf);
  }
  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}
function encodeWkbPolygon(rings) {
  let size = 9;
  for (const ring of rings) {
    size += 4 + ring.length * 16;
  }
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, 3, true);
  view.setUint32(5, rings.length, true);
  let offset = 9;
  for (const ring of rings) {
    view.setUint32(offset, ring.length, true);
    offset += 4;
    for (const [x, y] of ring) {
      view.setFloat64(offset, x, true);
      view.setFloat64(offset + 8, y, true);
      offset += 16;
    }
  }
  return new Uint8Array(buf);
}
function decodeWkb(bytes) {
  return decodeWkbInternal(bytes).geometry;
}
function decodeWkbInternal(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = view.getUint8(0);
  const le = byteOrder === 1;
  const wkbType = view.getUint32(1, le);
  if (wkbType === 1) {
    const x = view.getFloat64(5, le);
    const y = view.getFloat64(13, le);
    return { geometry: { type: "Point", coordinates: [x, y] }, bytesRead: 21 };
  }
  if (wkbType === 3) {
    const { rings, bytesRead } = decodeWkbPolygon(view, 5, le);
    return { geometry: { type: "Polygon", coordinates: rings }, bytesRead: 5 + bytesRead };
  }
  if (wkbType === 6) {
    const numPolygons = view.getUint32(5, le);
    const polygons = [];
    let offset = 9;
    for (let i = 0; i < numPolygons; i++) {
      const innerLe = view.getUint8(offset) === 1;
      offset += 5;
      const { rings, bytesRead } = decodeWkbPolygon(view, offset, innerLe);
      polygons.push(rings);
      offset += bytesRead;
    }
    return { geometry: { type: "MultiPolygon", coordinates: polygons }, bytesRead: offset };
  }
  if (wkbType === 2) {
    const numPoints = view.getUint32(5, le);
    const coords = [];
    let offset = 9;
    for (let i = 0; i < numPoints; i++) {
      const x = view.getFloat64(offset, le);
      const y = view.getFloat64(offset + 8, le);
      coords.push([x, y]);
      offset += 16;
    }
    return { geometry: { type: "LineString", coordinates: coords }, bytesRead: offset };
  }
  if (wkbType === 4) {
    const numPoints = view.getUint32(5, le);
    const coords = [];
    let offset = 9;
    for (let i = 0; i < numPoints; i++) {
      const innerLe = view.getUint8(offset) === 1;
      offset += 5;
      const x = view.getFloat64(offset, innerLe);
      const y = view.getFloat64(offset + 8, innerLe);
      coords.push([x, y]);
      offset += 16;
    }
    return { geometry: { type: "MultiPoint", coordinates: coords }, bytesRead: offset };
  }
  if (wkbType === 7) {
    const numGeometries = view.getUint32(5, le);
    const geometries = [];
    let offset = 9;
    for (let i = 0; i < numGeometries; i++) {
      const subBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
      const { geometry: geom, bytesRead } = decodeWkbInternal(subBytes);
      geometries.push(geom);
      offset += bytesRead;
    }
    return { geometry: { type: "GeometryCollection", geometries }, bytesRead: offset };
  }
  throw new Error(`Unsupported WKB type: ${wkbType}`);
}
function decodeWkbPolygon(view, offset, le) {
  const numRings = view.getUint32(offset, le);
  let pos = offset + 4;
  const rings = [];
  for (let i = 0; i < numRings; i++) {
    const numPoints = view.getUint32(pos, le);
    pos += 4;
    const ring = [];
    for (let j = 0; j < numPoints; j++) {
      const x = view.getFloat64(pos, le);
      const y = view.getFloat64(pos + 8, le);
      ring.push([x, y]);
      pos += 16;
    }
    rings.push(ring);
  }
  return { rings, bytesRead: pos - offset };
}

// src/model/mask.ts
function encodeRle(mask, height, width) {
  const total = height * width;
  if (total === 0) return new Uint32Array(0);
  const runs = [];
  let currentVal = 0;
  let count = 0;
  for (let i = 0; i < total; i++) {
    const val = mask[i] ? 1 : 0;
    if (val === currentVal) {
      count++;
    } else {
      runs.push(count);
      currentVal = val;
      count = 1;
    }
  }
  runs.push(count);
  return new Uint32Array(runs);
}
function decodeRle(rleCounts, height, width) {
  const total = height * width;
  if (rleCounts.length === 0) return new Uint8Array(total);
  const flat = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < rleCounts.length; i++) {
    const val = i % 2 === 0 ? 0 : 1;
    const count = rleCounts[i];
    if (val === 1) {
      for (let j = 0; j < count && pos + j < total; j++) {
        flat[pos + j] = 1;
      }
    }
    pos += count;
  }
  return flat;
}
var SegmentationMask = class _SegmentationMask {
  rleCounts;
  height;
  width;
  name;
  category;
  source;
  video;
  frameIdx;
  track;
  instance;
  constructor(options) {
    this.rleCounts = options.rleCounts;
    this.height = options.height;
    this.width = options.width;
    this.name = options.name ?? "";
    this.category = options.category ?? "";
    this.source = options.source ?? "";
    this.video = options.video ?? null;
    this.frameIdx = options.frameIdx ?? null;
    this.track = options.track ?? null;
    this.instance = options.instance ?? null;
  }
  static fromArray(mask, height, width, options) {
    let flat;
    if (mask instanceof Uint8Array) {
      flat = mask;
    } else {
      flat = new Uint8Array(height * width);
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          flat[r * width + c] = mask[r][c] ? 1 : 0;
        }
      }
    }
    const rleCounts = encodeRle(flat, height, width);
    return new _SegmentationMask({
      rleCounts,
      height,
      width,
      ...options
    });
  }
  get data() {
    return decodeRle(this.rleCounts, this.height, this.width);
  }
  get area() {
    let total = 0;
    for (let i = 1; i < this.rleCounts.length; i += 2) {
      total += this.rleCounts[i];
    }
    return total;
  }
  get bbox() {
    const flat = this.data;
    let minR = this.height, maxR = -1, minC = this.width, maxC = -1;
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        if (flat[r * this.width + c]) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (maxR === -1) return { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: minC,
      y: minR,
      width: maxC - minC + 1,
      height: maxR - minR + 1
    };
  }
  /** Convert the mask to a bounding-box polygon ROI. */
  toPolygon() {
    const bb = this.bbox;
    let geometry;
    if (bb.width === 0 || bb.height === 0) {
      geometry = { type: "Polygon", coordinates: [[]] };
    } else {
      const { x, y, width, height } = bb;
      geometry = {
        type: "Polygon",
        coordinates: [
          [
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height],
            [x, y]
          ]
        ]
      };
    }
    return new ROI({
      geometry,
      name: this.name,
      category: this.category,
      source: this.source,
      video: this.video,
      frameIdx: this.frameIdx,
      track: this.track,
      instance: this.instance
    });
  }
};
_registerMaskFactory(
  (mask, height, width, options) => {
    return SegmentationMask.fromArray(mask, height, width, options);
  }
);

// src/model/bbox.ts
var BoundingBox = class {
  xCenter;
  yCenter;
  width;
  height;
  angle;
  video;
  frameIdx;
  track;
  instance;
  category;
  name;
  source;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  constructor(options) {
    this.xCenter = options.xCenter;
    this.yCenter = options.yCenter;
    this.width = options.width;
    this.height = options.height;
    this.angle = options.angle ?? 0;
    this.video = options.video ?? null;
    this.frameIdx = options.frameIdx ?? null;
    this.track = options.track ?? null;
    this.instance = options.instance ?? null;
    this.category = options.category ?? "";
    this.name = options.name ?? "";
    this.source = options.source ?? "";
  }
  /** Create from corner coordinates [x1, y1, x2, y2]. */
  static fromXyxy(x1, y1, x2, y2, options) {
    return new UserBoundingBox({
      xCenter: (x1 + x2) / 2,
      yCenter: (y1 + y2) / 2,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      ...options
    });
  }
  /** Create from top-left corner + size [x, y, w, h]. */
  static fromXywh(x, y, w, h, options) {
    return new UserBoundingBox({
      xCenter: x + w / 2,
      yCenter: y + h / 2,
      width: w,
      height: h,
      ...options
    });
  }
  /** Axis-aligned bounding box as [x1, y1, x2, y2]. */
  get xyxy() {
    if (!this.isRotated) {
      return [
        this.xCenter - this.width / 2,
        this.yCenter - this.height / 2,
        this.xCenter + this.width / 2,
        this.yCenter + this.height / 2
      ];
    }
    const c = this.corners;
    const xs = c.map((p) => p[0]);
    const ys = c.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  /** Top-left x, y and size (AABB dimensions for rotated bboxes). */
  get xywh() {
    const [x1, y1, x2, y2] = this.xyxy;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  /** Four corner points of the (possibly rotated) bbox. */
  get corners() {
    const hw = this.width / 2;
    const hh = this.height / 2;
    const local = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh]
    ];
    if (!this.isRotated) {
      return local.map(([dx, dy]) => [this.xCenter + dx, this.yCenter + dy]);
    }
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return local.map(([dx, dy]) => [
      this.xCenter + dx * cos - dy * sin,
      this.yCenter + dx * sin + dy * cos
    ]);
  }
  /** Axis-aligned bounds. */
  get bounds() {
    const [x1, y1, x2, y2] = this.xyxy;
    return { minX: x1, minY: y1, maxX: x2, maxY: y2 };
  }
  /** Area of the bbox (width * height). */
  get area() {
    return this.width * this.height;
  }
  /** Center point. */
  get centroid() {
    return { x: this.xCenter, y: this.yCenter };
  }
  /** Whether this is a predicted bbox (has a score). */
  get isPredicted() {
    return false;
  }
  /** Whether the bbox has no temporal association. */
  get isStatic() {
    return this.frameIdx === null;
  }
  /** Whether the bbox is rotated (angle != 0). */
  get isRotated() {
    return this.angle !== 0;
  }
  /** Convert to a Polygon ROI. */
  toRoi() {
    const c = this.corners;
    const ring = [...c, c[0]];
    return ROI.fromPolygon(ring, {
      name: this.name,
      category: this.category,
      source: this.source,
      video: this.video,
      frameIdx: this.frameIdx,
      track: this.track,
      instance: this.instance
    });
  }
  /** Convert to a SegmentationMask by rasterizing the bbox polygon. */
  toMask(height, width) {
    return this.toRoi().toMask(height, width);
  }
};
var UserBoundingBox = class extends BoundingBox {
  get isPredicted() {
    return false;
  }
};
var PredictedBoundingBox = class extends BoundingBox {
  score;
  constructor(options) {
    super(options);
    this.score = options.score;
  }
  get isPredicted() {
    return true;
  }
};

// src/video/mp4box-video.ts
var isBrowser2 = typeof window !== "undefined" && typeof document !== "undefined";
var hasWebCodecs = isBrowser2 && typeof window.VideoDecoder !== "undefined" && typeof window.EncodedVideoChunk !== "undefined";
var MP4BOX_CDN = "https://unpkg.com/mp4box@0.5.4/dist/mp4box.all.min.js";
async function loadMp4box() {
  const globalMp4box = globalThis.MP4Box;
  if (globalMp4box) return globalMp4box;
  try {
    const module = await import("mp4box");
    return module.default ?? module;
  } catch {
    if (!isBrowser2 || typeof document === "undefined") {
      throw new Error("Failed to load mp4box");
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = MP4BOX_CDN;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load mp4box"));
      document.head.appendChild(script);
    });
    const afterLoad = globalThis.MP4Box;
    if (afterLoad) return afterLoad;
    throw new Error("Failed to load mp4box");
  }
}
var DEFAULT_CACHE_SIZE = 120;
var DEFAULT_LOOKAHEAD = 60;
var PARSE_CHUNK_SIZE = 1024 * 1024;
var Mp4BoxVideoBackend = class {
  filename;
  shape;
  fps;
  dataset;
  ready;
  mp4box;
  mp4boxFile;
  videoTrack;
  samples;
  keyframeIndices;
  cache;
  cacheSize;
  lookahead;
  decoder;
  config;
  fileSize;
  supportsRangeRequests;
  fileBlob;
  decodeQueue;
  latestRequestedFrame;
  constructor(source, options) {
    if (!hasWebCodecs) {
      throw new Error("Mp4BoxVideoBackend requires WebCodecs support.");
    }
    if (!isBrowser2) {
      throw new Error("Mp4BoxVideoBackend requires a browser environment.");
    }
    this.filename = source instanceof Blob ? source.name ?? "" : source;
    this.dataset = null;
    this.samples = [];
    this.keyframeIndices = [];
    this.cache = /* @__PURE__ */ new Map();
    this.cacheSize = options?.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.lookahead = options?.lookahead ?? DEFAULT_LOOKAHEAD;
    this.decoder = null;
    this.config = null;
    this.fileSize = 0;
    this.supportsRangeRequests = false;
    this.fileBlob = null;
    this.decodeQueue = Promise.resolve();
    this.latestRequestedFrame = null;
    if (source instanceof Blob) {
      this.fileBlob = source;
      this.fileSize = source.size;
      this.supportsRangeRequests = false;
    }
    this.ready = this.init();
  }
  async getFrame(frameIndex, signal) {
    await this.ready;
    if (frameIndex < 0 || frameIndex >= this.samples.length) return null;
    if (this.cache.has(frameIndex)) {
      const bitmap = this.cache.get(frameIndex) ?? null;
      if (bitmap) {
        this.cache.delete(frameIndex);
        this.cache.set(frameIndex, bitmap);
      }
      return bitmap;
    }
    this.latestRequestedFrame = frameIndex;
    await (this.decodeQueue = this.decodeQueue.then(async () => {
      if (this.latestRequestedFrame !== frameIndex) return;
      if (signal?.aborted) return;
      const keyframe = this.findKeyframeBefore(frameIndex);
      const end = Math.min(frameIndex + this.lookahead, this.samples.length - 1);
      await this.decodeRange(keyframe, end, frameIndex);
    }));
    return this.cache.get(frameIndex) ?? null;
  }
  async getFrameTimes() {
    await this.ready;
    return this.samples.map((sample) => sample.timestamp / 1e6);
  }
  close() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
      }
    }
    this.decoder = null;
    this.cache.forEach((bitmap) => bitmap.close());
    this.cache.clear();
    this.fileBlob = null;
  }
  async init() {
    if (!this.fileBlob) {
      await this.openSource();
    }
    this.mp4box = await loadMp4box();
    this.mp4boxFile = this.mp4box.createFile();
    const ready = new Promise((resolve, reject) => {
      this.mp4boxFile.onError = reject;
      this.mp4boxFile.onReady = resolve;
    });
    let offset = 0;
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });
    while (offset < this.fileSize && !resolved) {
      const buffer = await this.readChunk(offset, PARSE_CHUNK_SIZE);
      buffer.fileStart = offset;
      const next = this.mp4boxFile.appendBuffer(buffer);
      offset = next === void 0 ? offset + buffer.byteLength : next;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const info = await ready;
    if (!info.videoTracks.length) throw new Error("No video tracks found");
    this.videoTrack = info.videoTracks[0];
    const trak = this.mp4boxFile.getTrackById(this.videoTrack.id);
    const description = this.getCodecDescription(trak);
    const codec = this.videoTrack.codec.startsWith("vp08") ? "vp8" : this.videoTrack.codec;
    this.config = {
      codec,
      codedWidth: this.videoTrack.video.width,
      codedHeight: this.videoTrack.video.height,
      description
    };
    const support = await VideoDecoder.isConfigSupported(this.config);
    if (!support.supported) {
      throw new Error(`Codec ${codec} not supported`);
    }
    this.extractSamples();
    const duration = this.videoTrack.duration / this.videoTrack.timescale;
    this.fps = duration ? this.samples.length / duration : void 0;
    const frameCount = this.samples.length;
    const height = this.videoTrack.video.height;
    const width = this.videoTrack.video.width;
    this.shape = [frameCount, height, width, 3];
  }
  async openSource() {
    const response = await fetch(this.filename, {
      headers: { Range: "bytes=0-0" }
    });
    if (response.status === 206) {
      const contentRange = response.headers.get("Content-Range");
      const match = contentRange?.match(/\/(\d+)$/);
      if (match) {
        this.fileSize = Number.parseInt(match[1], 10);
        this.supportsRangeRequests = true;
        return;
      }
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch video: ${response.status}`);
    }
    const full = await fetch(this.filename);
    if (!full.ok) throw new Error(`Failed to fetch video: ${full.status}`);
    const blob = await full.blob();
    this.fileBlob = blob;
    this.fileSize = blob.size;
    this.supportsRangeRequests = false;
  }
  async readChunk(offset, size) {
    const end = Math.min(offset + size, this.fileSize);
    if (this.supportsRangeRequests) {
      const response = await fetch(this.filename, { headers: { Range: `bytes=${offset}-${end - 1}` } });
      return await response.arrayBuffer();
    }
    if (this.fileBlob) {
      return await this.fileBlob.slice(offset, end).arrayBuffer();
    }
    throw new Error("No video source available");
  }
  extractSamples() {
    const info = this.mp4boxFile.getTrackSamplesInfo(this.videoTrack.id);
    if (!info?.length) throw new Error("No samples");
    const ts = this.videoTrack.timescale;
    const samples = info.map((sample, index) => ({
      offset: sample.offset,
      size: sample.size,
      timestamp: sample.cts * 1e6 / ts,
      duration: sample.duration * 1e6 / ts,
      isKeyframe: sample.is_sync,
      cts: sample.cts,
      decodeIndex: index
    }));
    this.samples = samples.sort((a, b) => {
      if (a.cts === b.cts) return a.decodeIndex - b.decodeIndex;
      return a.cts - b.cts;
    });
    this.keyframeIndices = [];
    this.samples.forEach((sample, index) => {
      if (sample.isKeyframe) this.keyframeIndices.push(index);
    });
  }
  findKeyframeBefore(frameIndex) {
    let result = 0;
    for (const keyframe of this.keyframeIndices) {
      if (keyframe <= frameIndex) result = keyframe;
      else break;
    }
    return result;
  }
  getCodecDescription(trak) {
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
    const dataStream = globalThis.DataStream ?? this.mp4box?.DataStream;
    if (!dataStream) return void 0;
    for (const entry of entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      const stream = new dataStream(void 0, 0, dataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
    return void 0;
  }
  async readSampleDataByDecodeOrder(samplesToFeed) {
    const results = /* @__PURE__ */ new Map();
    let i = 0;
    while (i < samplesToFeed.length) {
      const first = samplesToFeed[i];
      let regionEnd = i;
      let regionBytes = first.sample.size;
      while (regionEnd < samplesToFeed.length - 1) {
        const current = samplesToFeed[regionEnd];
        const next = samplesToFeed[regionEnd + 1];
        if (next.sample.offset === current.sample.offset + current.sample.size) {
          regionEnd += 1;
          regionBytes += next.sample.size;
        } else {
          break;
        }
      }
      const buffer = await this.readChunk(first.sample.offset, regionBytes);
      const bufferView = new Uint8Array(buffer);
      let bufferOffset = 0;
      for (let j = i; j <= regionEnd; j += 1) {
        const { sample } = samplesToFeed[j];
        results.set(sample.decodeIndex, bufferView.slice(bufferOffset, bufferOffset + sample.size));
        bufferOffset += sample.size;
      }
      i = regionEnd + 1;
    }
    return results;
  }
  async decodeRange(start, end, target) {
    if (!this.config) throw new Error("Decoder not configured");
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
      }
    }
    let minDecodeIndex = Infinity;
    let maxDecodeIndex = -Infinity;
    for (let i = start; i <= end; i += 1) {
      minDecodeIndex = Math.min(minDecodeIndex, this.samples[i].decodeIndex);
      maxDecodeIndex = Math.max(maxDecodeIndex, this.samples[i].decodeIndex);
    }
    const toFeed = [];
    for (let i = 0; i < this.samples.length; i += 1) {
      const sample = this.samples[i];
      if (sample.decodeIndex >= minDecodeIndex && sample.decodeIndex <= maxDecodeIndex) {
        toFeed.push({ pi: i, sample });
      }
    }
    toFeed.sort((a, b) => a.sample.decodeIndex - b.sample.decodeIndex);
    const dataMap = await this.readSampleDataByDecodeOrder(toFeed);
    const timestampMap = /* @__PURE__ */ new Map();
    for (const { pi, sample } of toFeed) {
      timestampMap.set(Math.round(sample.timestamp), pi);
    }
    const halfCache = Math.floor(this.cacheSize / 2);
    const cacheStart = Math.max(start, target - halfCache);
    const cacheEnd = Math.min(end, target + halfCache);
    let decodedCount = 0;
    let resolveComplete;
    let rejectComplete;
    const completionPromise = new Promise((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const roundedTimestamp = Math.round(frame.timestamp);
        let frameIndex = timestampMap.get(roundedTimestamp);
        if (frameIndex === void 0) {
          let bestDiff = Infinity;
          for (const [ts, idx] of timestampMap) {
            const diff = Math.abs(ts - frame.timestamp);
            if (diff < bestDiff) {
              bestDiff = diff;
              frameIndex = idx;
            }
          }
        }
        const handleClose = () => {
          frame.close();
          decodedCount += 1;
          if (decodedCount >= toFeed.length) resolveComplete();
        };
        if (frameIndex !== void 0 && frameIndex >= cacheStart && frameIndex <= cacheEnd) {
          createImageBitmap(frame).then((bitmap) => {
            this.addToCache(frameIndex, bitmap);
            handleClose();
          }).catch(handleClose);
        } else {
          handleClose();
        }
      },
      error: (error) => {
        if (error.name === "AbortError") {
          resolveComplete();
        } else {
          rejectComplete(error);
        }
      }
    });
    this.decoder.configure(this.config);
    const BATCH_SIZE = 15;
    for (let i = 0; i < toFeed.length; i += BATCH_SIZE) {
      const batch = toFeed.slice(i, i + BATCH_SIZE);
      for (const { sample } of batch) {
        const data = dataMap.get(sample.decodeIndex);
        if (!data) continue;
        this.decoder.decode(
          new EncodedVideoChunk({
            type: sample.isKeyframe ? "key" : "delta",
            timestamp: sample.timestamp,
            duration: sample.duration,
            data
          })
        );
      }
      if (i + BATCH_SIZE < toFeed.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    await this.decoder.flush();
    await completionPromise;
  }
  addToCache(frameIndex, bitmap) {
    if (this.cache.size >= this.cacheSize) {
      const first = this.cache.keys().next();
      if (!first.done) {
        const evicted = this.cache.get(first.value);
        if (evicted) evicted.close();
        this.cache.delete(first.value);
      }
    }
    this.cache.set(frameIndex, bitmap);
  }
};

// src/video/streaming-hdf5-video.ts
var isBrowser3 = typeof window !== "undefined" && typeof document !== "undefined";
var PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
var JPEG_MAGIC = new Uint8Array([255, 216, 255]);
var StreamingHdf5VideoBackend = class {
  filename;
  dataset;
  shape;
  fps;
  h5file;
  datasetPath;
  frameNumberToIndex;
  format;
  channelOrder;
  cachedData;
  frameOffsets;
  // For contiguous buffer: byte offsets of each frame
  constructor(options) {
    this.filename = options.filename;
    this.h5file = options.h5file;
    this.datasetPath = options.datasetPath;
    this.dataset = options.datasetPath;
    const frameNumbers = options.frameNumbers ?? [];
    this.frameNumberToIndex = new Map(frameNumbers.map((num, idx) => [num, idx]));
    this.format = options.format ?? "png";
    this.channelOrder = options.channelOrder ?? "RGB";
    this.shape = options.shape;
    this.fps = options.fps;
    this.cachedData = null;
    this.frameOffsets = null;
  }
  async getFrame(frameIndex) {
    const index = this.frameNumberToIndex.size > 0 ? this.frameNumberToIndex.get(frameIndex) : frameIndex;
    if (index === void 0) return null;
    if (!this.cachedData) {
      try {
        const data = await this.h5file.getDatasetValue(this.datasetPath);
        this.cachedData = normalizeVideoData(data.value, data.shape);
        if (isContiguousEncodedBuffer(this.cachedData, this.format, this.shape)) {
          this.frameOffsets = findEncodedFrameOffsets(
            this.cachedData,
            this.format,
            this.shape?.[0] ?? 0
          );
        }
      } catch {
        return null;
      }
    }
    let rawBytes;
    if (this.frameOffsets && this.frameOffsets.length > index) {
      const buffer = this.cachedData;
      const start = this.frameOffsets[index];
      const end = index + 1 < this.frameOffsets.length ? this.frameOffsets[index + 1] : buffer.length;
      rawBytes = buffer.slice(start, end);
    } else {
      const entry = this.cachedData[index];
      if (entry == null) return null;
      rawBytes = toUint8Array(entry);
    }
    if (!rawBytes || rawBytes.length === 0) return null;
    if (isEncodedFormat(this.format)) {
      const decoded = await decodeImageBytes(rawBytes, this.format, this.channelOrder);
      return decoded ?? rawBytes;
    }
    const image = decodeRawFrame(rawBytes, this.shape, this.channelOrder);
    return image ?? rawBytes;
  }
  close() {
    this.cachedData = null;
    this.frameOffsets = null;
  }
};
function normalizeVideoData(value, _shape) {
  if (Array.isArray(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const arr = value;
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  return [];
}
function isContiguousEncodedBuffer(data, format, shape) {
  if (!isEncodedFormat(format)) return false;
  if (!(data instanceof Uint8Array)) return false;
  if (data.length < 8) return false;
  const isPng = matchesMagic(data, PNG_MAGIC);
  const isJpeg = matchesMagic(data, JPEG_MAGIC);
  if (!isPng && !isJpeg) return false;
  if (shape) {
    const frameCount = shape[0];
    if (frameCount > 1 && data.length > 1e4) {
      return true;
    }
  }
  return true;
}
function matchesMagic(buffer, magic) {
  if (buffer.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }
  return true;
}
function findEncodedFrameOffsets(buffer, format, expectedFrameCount) {
  const offsets = [];
  const magic = format.toLowerCase() === "png" ? PNG_MAGIC : JPEG_MAGIC;
  for (let i = 0; i <= buffer.length - magic.length; i++) {
    if (matchesMagic(buffer.subarray(i), magic)) {
      offsets.push(i);
      i += magic.length - 1;
      if (expectedFrameCount > 0 && offsets.length >= expectedFrameCount) {
        break;
      }
    }
  }
  return offsets;
}
function toUint8Array(entry) {
  if (entry instanceof Uint8Array) return entry;
  if (entry instanceof ArrayBuffer) return new Uint8Array(entry);
  if (ArrayBuffer.isView(entry)) return new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);
  if (Array.isArray(entry)) return new Uint8Array(entry.flat());
  if (entry && typeof entry === "object" && "buffer" in entry) {
    return new Uint8Array(entry.buffer);
  }
  return null;
}
function isEncodedFormat(format) {
  const normalized = format.toLowerCase();
  return normalized === "png" || normalized === "jpg" || normalized === "jpeg";
}
async function decodeImageBytes(bytes, format, channelOrder) {
  if (!isBrowser3 || typeof createImageBitmap === "undefined") return null;
  const mime = format.toLowerCase() === "png" ? "image/png" : "image/jpeg";
  const safeBytes = new Uint8Array(bytes);
  const blob = new Blob([safeBytes.buffer], { type: mime });
  const bitmap = await createImageBitmap(blob);
  const useBgr = channelOrder.toUpperCase() === "BGR";
  if (!useBgr) {
    return bitmap;
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return bitmap;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const b = data[i + 2];
    data[i] = b;
    data[i + 2] = r;
  }
  return imageData;
}
function decodeRawFrame(bytes, shape, channelOrder) {
  if (!isBrowser3 || !shape) return null;
  const [, height, width, channels] = shape;
  if (!height || !width || !channels) return null;
  const expectedLength = height * width * channels;
  if (bytes.length < expectedLength) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const useBgr = channelOrder.toUpperCase() === "BGR";
  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    const r = bytes[base + (useBgr ? 2 : 0)] ?? 0;
    const g = bytes[base + 1] ?? 0;
    const b = bytes[base + (useBgr ? 0 : 2)] ?? 0;
    const a = channels === 4 ? bytes[base + 3] ?? 255 : 255;
    const out = i * 4;
    rgba[out] = r;
    rgba[out + 1] = g;
    rgba[out + 2] = b;
    rgba[out + 3] = a;
  }
  return new ImageData(rgba, width, height);
}

// src/codecs/slp/h5-worker.ts
var H5_WORKER_CODE = `
// h5wasm streaming worker
// Handles all HDF5 operations in a Web Worker to avoid main thread blocking
// Supports: URL streaming (range requests), local files (WORKERFS), and ArrayBuffers

let h5wasmModule = null;
let FS = null;
let currentFile = null;
let mountPath = null;

self.onmessage = async function(e) {
  const { type, payload, id } = e.data;

  try {
    switch (type) {
      case 'init':
        await initH5Wasm(payload?.h5wasmUrl);
        respond(id, { success: true });
        break;

      case 'openUrl':
        const urlResult = await openRemoteFile(payload.url, payload.filename);
        respond(id, urlResult);
        break;

      case 'openLocal':
        const localResult = await openLocalFile(payload.file, payload.filename);
        respond(id, localResult);
        break;

      case 'openBuffer':
        const bufferResult = await openBufferFile(payload.buffer, payload.filename);
        respond(id, bufferResult);
        break;

      case 'getKeys':
        const keys = getKeys(payload.path);
        respond(id, { success: true, keys });
        break;

      case 'getAttr':
        const attr = getAttr(payload.path, payload.name);
        respond(id, { success: true, value: attr });
        break;

      case 'getAttrs':
        const attrs = getAttrs(payload.path);
        respond(id, { success: true, attrs });
        break;

      case 'getDatasetMeta':
        const meta = getDatasetMeta(payload.path);
        respond(id, { success: true, meta });
        break;

      case 'getDatasetValue':
        const data = getDatasetValue(payload.path, payload.slice);
        respond(id, { success: true, data }, data.transferables);
        break;

      case 'close':
        closeFile();
        respond(id, { success: true });
        break;

      default:
        respond(id, { success: false, error: 'Unknown message type: ' + type });
    }
  } catch (error) {
    // Robustly extract error message from various error types
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      // Handle Emscripten errors which may be objects with various properties
      errorMessage = error.message || error.error || error.reason || JSON.stringify(error);
    }
    respond(id, { success: false, error: errorMessage });
  }
};

function respond(id, data, transferables) {
  if (transferables) {
    self.postMessage({ id, ...data }, transferables);
  } else {
    self.postMessage({ id, ...data });
  }
}

async function initH5Wasm(h5wasmUrl) {
  if (h5wasmModule) return;

  // Default to CDN if no URL provided
  const url = h5wasmUrl || 'https://cdn.jsdelivr.net/npm/h5wasm@0.8.8/dist/iife/h5wasm.js';

  // Import h5wasm IIFE
  importScripts(url);

  // Wait for module to be ready
  await h5wasm.ready;
  h5wasmModule = h5wasm;
  // FS is exposed directly on h5wasm module after ready
  FS = h5wasm.FS;
}

async function openRemoteFile(url, filename = 'data.h5') {
  if (!h5wasmModule) {
    throw new Error('h5wasm not initialized');
  }

  // Close any existing file
  closeFile();

  // Create mount point
  mountPath = '/remote-' + Date.now();
  FS.mkdir(mountPath);

  // Create lazy file - this enables range request streaming!
  FS.createLazyFile(mountPath, filename, url, true, false);

  // Open with h5wasm
  const filePath = mountPath + '/' + filename;
  currentFile = new h5wasm.File(filePath, 'r');

  return {
    success: true,
    path: currentFile.path,
    filename: currentFile.filename,
    keys: currentFile.keys()
  };
}

async function openLocalFile(file, filename) {
  if (!h5wasmModule) {
    throw new Error('h5wasm not initialized');
  }

  // Close any existing file
  closeFile();

  // Use provided filename or file.name
  const fname = filename || file.name || 'local.h5';

  // Create mount point for WORKERFS
  mountPath = '/local-' + Date.now();
  FS.mkdir(mountPath);

  // Mount the file using WORKERFS (zero-copy access)
  FS.mount(FS.filesystems.WORKERFS, { files: [file] }, mountPath);

  // Open with h5wasm
  const filePath = mountPath + '/' + fname;
  currentFile = new h5wasm.File(filePath, 'r');

  return {
    success: true,
    path: currentFile.path,
    filename: currentFile.filename,
    keys: currentFile.keys()
  };
}

async function openBufferFile(buffer, filename = 'data.h5') {
  if (!h5wasmModule) {
    throw new Error('h5wasm not initialized');
  }

  // Close any existing file
  closeFile();

  // Write buffer to virtual filesystem
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  mountPath = '/buffer-' + Date.now() + '/' + filename;

  // Create parent directory
  const dir = mountPath.substring(0, mountPath.lastIndexOf('/'));
  FS.mkdir(dir);

  // Write file to virtual FS
  FS.writeFile(mountPath, data);

  // Open with h5wasm
  currentFile = new h5wasm.File(mountPath, 'r');

  return {
    success: true,
    path: currentFile.path,
    filename: currentFile.filename,
    keys: currentFile.keys()
  };
}

function getKeys(path) {
  if (!currentFile) throw new Error('No file open');
  const item = path === '/' || !path ? currentFile : currentFile.get(path);
  if (!item) throw new Error('Path not found: ' + path);
  return item.keys ? item.keys() : [];
}

function serializeAttrValue(attr) {
  if (!attr) return null;
  // h5wasm Attribute objects have a .value property
  const val = attr.value !== undefined ? attr.value : attr;
  // Convert Uint8Array to string for JSON attributes
  if (val instanceof Uint8Array) {
    return { value: new TextDecoder().decode(val) };
  }
  // Wrap primitive values to preserve structure
  return { value: val };
}

function getAttr(path, name) {
  if (!currentFile) throw new Error('No file open');
  const item = path === '/' || !path ? currentFile : currentFile.get(path);
  if (!item) throw new Error('Path not found: ' + path);
  const attrs = item.attrs;
  const attr = attrs?.[name];
  return serializeAttrValue(attr);
}

function getAttrs(path) {
  if (!currentFile) throw new Error('No file open');
  const item = path === '/' || !path ? currentFile : currentFile.get(path);
  if (!item) throw new Error('Path not found: ' + path);
  const rawAttrs = item.attrs || {};
  // Serialize all attributes for proper transfer through postMessage
  const serialized = {};
  for (const key of Object.keys(rawAttrs)) {
    serialized[key] = serializeAttrValue(rawAttrs[key]);
  }
  return serialized;
}

function getDatasetMeta(path) {
  if (!currentFile) throw new Error('No file open');
  const dataset = currentFile.get(path);
  if (!dataset) throw new Error('Dataset not found: ' + path);
  return {
    shape: dataset.shape,
    dtype: dataset.dtype,
    metadata: dataset.metadata
  };
}

function getDatasetValue(path, slice) {
  if (!currentFile) throw new Error('No file open');
  const dataset = currentFile.get(path);
  if (!dataset) throw new Error('Dataset not found: ' + path);

  // Get value or slice
  let value;
  if (slice && Array.isArray(slice)) {
    value = dataset.slice(slice);
  } else {
    value = dataset.value;
  }

  // Prepare for transfer
  const transferables = [];
  let transferValue = value;

  if (ArrayBuffer.isView(value)) {
    // TypedArray - transfer the underlying buffer
    transferValue = {
      type: 'typedarray',
      dtype: value.constructor.name,
      buffer: value.buffer,
      byteOffset: value.byteOffset,
      length: value.length
    };
    transferables.push(value.buffer);
  } else if (value instanceof ArrayBuffer) {
    transferValue = { type: 'arraybuffer', buffer: value };
    transferables.push(value);
  }

  return {
    value: transferValue,
    shape: dataset.shape,
    dtype: dataset.dtype,
    transferables
  };
}

function closeFile() {
  if (currentFile) {
    try { currentFile.close(); } catch (e) {}
    currentFile = null;
  }
  if (mountPath && FS) {
    try { FS.rmdir(mountPath); } catch (e) {}
    mountPath = null;
  }
}
`;
function createH5Worker() {
  const blob = new Blob([H5_WORKER_CODE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  worker.addEventListener(
    "error",
    () => {
      URL.revokeObjectURL(url);
    },
    { once: true }
  );
  return worker;
}

// src/codecs/slp/h5-streaming.ts
function reconstructValue(data) {
  if (data && typeof data === "object" && "type" in data) {
    const typed = data;
    if (typed.type === "typedarray" && typed.buffer) {
      const TypedArrayConstructor = getTypedArrayConstructor(typed.dtype || "Uint8Array");
      return new TypedArrayConstructor(typed.buffer, typed.byteOffset || 0, typed.length);
    }
    if (typed.type === "arraybuffer" && typed.buffer) {
      return typed.buffer;
    }
  }
  return data;
}
function getTypedArrayConstructor(name) {
  const constructors = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array
  };
  return constructors[name] || Uint8Array;
}
var StreamingH5File = class {
  worker;
  messageId = 0;
  pendingMessages = /* @__PURE__ */ new Map();
  _keys = [];
  _isOpen = false;
  constructor() {
    this.worker = createH5Worker();
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }
  handleMessage(e) {
    const { id, ...data } = e.data;
    const pending = this.pendingMessages.get(id);
    if (pending) {
      this.pendingMessages.delete(id);
      if (data.success) {
        pending.resolve(e.data);
      } else {
        let errorMessage = "Worker operation failed";
        if (typeof data.error === "string") {
          errorMessage = data.error;
        } else if (data.error && typeof data.error === "object") {
          errorMessage = JSON.stringify(data.error);
        }
        pending.reject(new Error(errorMessage));
      }
    }
  }
  handleError(e) {
    console.error("[StreamingH5File] Worker error:", e.message);
    for (const [id, pending] of this.pendingMessages) {
      pending.reject(new Error(`Worker error: ${e.message}`));
      this.pendingMessages.delete(id);
    }
  }
  send(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      this.pendingMessages.set(id, { resolve, reject });
      this.worker.postMessage({ type, payload, id });
    });
  }
  /**
   * Initialize the h5wasm module in the worker.
   */
  async init(options) {
    await this.send("init", { h5wasmUrl: options?.h5wasmUrl });
  }
  /**
   * Open a remote HDF5 file for streaming access via URL.
   *
   * @param url - URL to the HDF5 file (must support HTTP range requests)
   * @param options - Optional settings
   */
  async open(url, options) {
    await this.init(options);
    const filename = options?.filenameHint || url.split("/").pop()?.split("?")[0] || "data.h5";
    const result = await this.send("openUrl", { url, filename });
    this._keys = result.keys || [];
    this._isOpen = true;
  }
  /**
   * Open a local File object using WORKERFS (zero-copy).
   *
   * @param file - File object from file input or drag-and-drop
   * @param options - Optional settings
   */
  async openLocal(file, options) {
    await this.init(options);
    const filename = options?.filenameHint || file.name || "data.h5";
    const result = await this.send("openLocal", { file, filename });
    this._keys = result.keys || [];
    this._isOpen = true;
  }
  /**
   * Open an HDF5 file from an ArrayBuffer or Uint8Array.
   *
   * @param buffer - ArrayBuffer or Uint8Array containing the HDF5 file data
   * @param options - Optional settings
   */
  async openBuffer(buffer, options) {
    await this.init(options);
    const filename = options?.filenameHint || "data.h5";
    const data = buffer instanceof Uint8Array ? buffer.buffer : buffer;
    const result = await this.send("openBuffer", { buffer: data, filename });
    this._keys = result.keys || [];
    this._isOpen = true;
  }
  /**
   * Open an HDF5 file from any supported source.
   *
   * @param source - URL string, File, ArrayBuffer, or Uint8Array
   * @param options - Optional settings
   */
  async openAny(source, options) {
    if (typeof source === "string") {
      return this.open(source, options);
    }
    if (typeof File !== "undefined" && source instanceof File) {
      return this.openLocal(source, options);
    }
    if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
      return this.openBuffer(source, options);
    }
    throw new Error("Unsupported source type for StreamingH5File");
  }
  /**
   * Whether a file is currently open.
   */
  get isOpen() {
    return this._isOpen;
  }
  /**
   * Get the root-level keys in the file.
   */
  keys() {
    return this._keys;
  }
  /**
   * Get the keys (children) at a given path.
   */
  async getKeys(path) {
    const result = await this.send("getKeys", { path });
    return result.keys || [];
  }
  /**
   * Get an attribute value.
   */
  async getAttr(path, name) {
    const result = await this.send("getAttr", { path, name });
    return result.value?.value ?? result.value;
  }
  /**
   * Get all attributes at a path.
   */
  async getAttrs(path) {
    const result = await this.send("getAttrs", { path });
    return result.attrs || {};
  }
  /**
   * Get dataset metadata (shape, dtype) without reading values.
   */
  async getDatasetMeta(path) {
    const result = await this.send("getDatasetMeta", { path });
    const meta = result.meta;
    return meta;
  }
  /**
   * Read a dataset's value.
   *
   * @param path - Path to the dataset
   * @param slice - Optional slice specification (array of [start, end] pairs)
   */
  async getDatasetValue(path, slice) {
    const result = await this.send("getDatasetValue", { path, slice });
    const data = result.data;
    return {
      value: reconstructValue(data.value),
      shape: data.shape,
      dtype: data.dtype
    };
  }
  /**
   * Close the file and terminate the worker.
   */
  async close() {
    if (this._isOpen) {
      await this.send("close");
      this._isOpen = false;
    }
    this.worker.terminate();
    this._keys = [];
  }
};
function isStreamingSupported() {
  return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined";
}
async function openStreamingH5(url, options) {
  if (!isStreamingSupported()) {
    throw new Error("Streaming HDF5 requires Web Worker support");
  }
  const file = new StreamingH5File();
  await file.open(url, options);
  return file;
}
async function openH5Worker(source, options) {
  if (!isStreamingSupported()) {
    throw new Error("Web Worker HDF5 access requires Worker/Blob/URL support");
  }
  const file = new StreamingH5File();
  await file.openAny(source, options);
  return file;
}

// src/video/hdf5-video.ts
var isBrowser4 = typeof window !== "undefined" && typeof document !== "undefined";
var PNG_MAGIC2 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
var JPEG_MAGIC2 = new Uint8Array([255, 216, 255]);
var Hdf5VideoBackend = class {
  filename;
  dataset;
  shape;
  fps;
  file;
  datasetPath;
  frameNumberToIndex;
  format;
  channelOrder;
  cachedData;
  frameOffsets;
  frameSizes;
  constructor(options) {
    this.filename = options.filename;
    this.file = options.file;
    this.datasetPath = options.datasetPath;
    this.dataset = options.datasetPath;
    const frameNumbers = options.frameNumbers ?? [];
    this.frameNumberToIndex = new Map(frameNumbers.map((num, idx) => [num, idx]));
    this.format = options.format ?? "png";
    this.channelOrder = options.channelOrder ?? "RGB";
    this.shape = options.shape;
    this.fps = options.fps;
    this.cachedData = null;
    this.frameOffsets = null;
    this.frameSizes = options.frameSizes;
  }
  async getFrame(frameIndex) {
    const dataset = this.file.get(this.datasetPath);
    if (!dataset) return null;
    const index = this.frameNumberToIndex.size > 0 ? this.frameNumberToIndex.get(frameIndex) : frameIndex;
    if (index === void 0) return null;
    if (!this.cachedData) {
      const value = dataset.value;
      this.cachedData = normalizeVideoData2(value);
      if (this.frameSizes && this.frameSizes.length > 0 && this.cachedData instanceof Uint8Array) {
        this.frameOffsets = computeOffsetsFromSizes(this.frameSizes);
      } else if (isContiguousEncodedBuffer2(this.cachedData, this.format, this.shape)) {
        this.frameOffsets = findEncodedFrameOffsets2(
          this.cachedData,
          this.format,
          this.shape?.[0] ?? 0
        );
      }
    }
    let rawBytes;
    if (this.frameOffsets && this.frameOffsets.length > index) {
      const buffer = this.cachedData;
      const start = this.frameOffsets[index];
      const end = index + 1 < this.frameOffsets.length ? this.frameOffsets[index + 1] : buffer.length;
      rawBytes = buffer.slice(start, end);
    } else {
      const entry = this.cachedData[index];
      if (entry == null) return null;
      rawBytes = toUint8Array2(entry);
    }
    if (!rawBytes || rawBytes.length === 0) return null;
    if (isEncodedFormat2(this.format)) {
      const decoded = await decodeImageBytes2(rawBytes, this.format, this.channelOrder);
      return decoded ?? rawBytes;
    }
    const image = decodeRawFrame2(rawBytes, this.shape, this.channelOrder);
    return image ?? rawBytes;
  }
  close() {
    this.cachedData = null;
    this.frameOffsets = null;
  }
};
function normalizeVideoData2(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const arr = value;
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  return [];
}
function isContiguousEncodedBuffer2(data, format, shape) {
  if (!isEncodedFormat2(format)) return false;
  if (!(data instanceof Uint8Array)) return false;
  if (data.length < 8) return false;
  const isPng = matchesMagic2(data, PNG_MAGIC2);
  const isJpeg = matchesMagic2(data, JPEG_MAGIC2);
  if (!isPng && !isJpeg) return false;
  if (shape) {
    const frameCount = shape[0];
    if (frameCount > 1 && data.length > 1e4) {
      return true;
    }
  }
  return true;
}
function matchesMagic2(buffer, magic) {
  if (buffer.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }
  return true;
}
function findEncodedFrameOffsets2(buffer, format, expectedFrameCount) {
  const offsets = [];
  const magic = format.toLowerCase() === "png" ? PNG_MAGIC2 : JPEG_MAGIC2;
  for (let i = 0; i <= buffer.length - magic.length; i++) {
    if (matchesMagic2(buffer.subarray(i), magic)) {
      offsets.push(i);
      i += magic.length - 1;
      if (expectedFrameCount > 0 && offsets.length >= expectedFrameCount) {
        break;
      }
    }
  }
  return offsets;
}
function computeOffsetsFromSizes(sizes) {
  const offsets = new Array(sizes.length);
  let offset = 0;
  for (let i = 0; i < sizes.length; i++) {
    offsets[i] = offset;
    offset += sizes[i];
  }
  return offsets;
}
function toUint8Array2(entry) {
  if (entry instanceof Uint8Array) return entry;
  if (entry instanceof ArrayBuffer) return new Uint8Array(entry);
  if (ArrayBuffer.isView(entry)) return new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);
  if (Array.isArray(entry)) return new Uint8Array(entry.flat());
  if (entry?.buffer) return new Uint8Array(entry.buffer);
  return null;
}
function isEncodedFormat2(format) {
  const normalized = format.toLowerCase();
  return normalized === "png" || normalized === "jpg" || normalized === "jpeg";
}
async function decodeImageBytes2(bytes, format, channelOrder) {
  if (!isBrowser4 || typeof createImageBitmap === "undefined") return null;
  const mime = format.toLowerCase() === "png" ? "image/png" : "image/jpeg";
  const safeBytes = new Uint8Array(bytes);
  const blob = new Blob([safeBytes.buffer], { type: mime });
  const bitmap = await createImageBitmap(blob);
  const useBgr = channelOrder.toUpperCase() === "BGR";
  if (!useBgr) {
    return bitmap;
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return bitmap;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const b = data[i + 2];
    data[i] = b;
    data[i + 2] = r;
  }
  return imageData;
}
function decodeRawFrame2(bytes, shape, channelOrder) {
  if (!isBrowser4 || !shape) return null;
  const [, height, width, channels] = shape;
  if (!height || !width || !channels) return null;
  const expectedLength = height * width * channels;
  if (bytes.length < expectedLength) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const useBgr = channelOrder.toUpperCase() === "BGR";
  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    const r = bytes[base + (useBgr ? 2 : 0)] ?? 0;
    const g = bytes[base + 1] ?? 0;
    const b = bytes[base + (useBgr ? 0 : 2)] ?? 0;
    const a = channels === 4 ? bytes[base + 3] ?? 255 : 255;
    const out = i * 4;
    rgba[out] = r;
    rgba[out + 1] = g;
    rgba[out + 2] = b;
    rgba[out + 3] = a;
  }
  return new ImageData(rgba, width, height);
}

// src/codecs/slp/h5.ts
var _nodeGetModule = null;
var _nodeOpenFile = null;
function _registerNodeH5(getModule, openFile) {
  _nodeGetModule = getModule;
  _nodeOpenFile = openFile;
}
var modulePromise = null;
async function getH5Module() {
  if (_nodeGetModule) {
    return _nodeGetModule();
  }
  if (!modulePromise) {
    modulePromise = (async () => {
      const module = await import("h5wasm");
      await module.ready;
      return module;
    })();
  }
  return modulePromise;
}
async function openH5File(source, options) {
  const module = await getH5Module();
  if (_nodeOpenFile) {
    return _nodeOpenFile(module, source);
  }
  return openH5FileBrowser(module, source, options);
}
function isProbablyUrl(value) {
  return /^https?:\/\//i.test(value);
}
function isFileHandle(value) {
  return typeof value === "object" && value !== null && "getFile" in value;
}
async function openH5FileBrowser(module, source, options) {
  const fs = getH5FileSystem(module);
  if (typeof source === "string" && isProbablyUrl(source)) {
    return openFromUrl(module, fs, source, options);
  }
  if (isFileHandle(source)) {
    const file = await source.getFile();
    return openFromFile(module, fs, file, options);
  }
  if (typeof File !== "undefined" && source instanceof File) {
    return openFromFile(module, fs, source, options);
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    const data = source instanceof Uint8Array ? source : new Uint8Array(source);
    const filename = "/tmp-slp.slp";
    fs.writeFile(filename, data);
    const file = new module.File(filename, "r");
    return { file, close: () => file.close() };
  }
  if (typeof source === "string") {
    return openFromUrl(module, fs, source, options);
  }
  throw new Error("Unsupported SLP source type for browser environment.");
}
async function openFromUrl(module, fs, url, options) {
  const filename = options?.filenameHint ?? url.split("/").pop()?.split("?")[0] ?? "slp-data.slp";
  const streamMode = options?.stream ?? "auto";
  if (fs.createLazyFile && (streamMode === "auto" || streamMode === "range")) {
    const mountPath = `/slp-remote-${Date.now()}`;
    fs.mkdir?.(mountPath);
    try {
      fs.createLazyFile(mountPath, filename, url, true, false);
      const file2 = new module.File(`${mountPath}/${filename}`, "r");
      return {
        file: file2,
        close: () => {
          file2.close();
          fs.unlink?.(`${mountPath}/${filename}`);
          fs.rmdir?.(mountPath);
        }
      };
    } catch {
      fs.rmdir?.(mountPath);
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch SLP file: ${response.status} ${response.statusText}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  const localPath = "/tmp-slp.slp";
  fs.writeFile(localPath, buffer);
  const file = new module.File(localPath, "r");
  return { file, close: () => file.close() };
}
async function openFromFile(module, fs, file, options) {
  const mountPath = `/slp-local-${Date.now()}`;
  fs.mkdir?.(mountPath);
  const filename = options?.filenameHint ?? file.name ?? "local.slp";
  if (fs.mount && fs.filesystems && fs.filesystems.WORKERFS) {
    fs.mount(fs.filesystems.WORKERFS, { files: [file] }, mountPath);
    const filePath = `${mountPath}/${filename}`;
    const h5file2 = new module.File(filePath, "r");
    return {
      file: h5file2,
      close: () => {
        h5file2.close();
        fs.unmount?.(mountPath);
        fs.rmdir?.(mountPath);
      }
    };
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const localPath = "/tmp-slp.slp";
  fs.writeFile(localPath, buffer);
  const h5file = new module.File(localPath, "r");
  return { file: h5file, close: () => h5file.close() };
}
function getH5FileSystem(module) {
  const fs = module.FS;
  if (!fs) {
    throw new Error("h5wasm FS is not available.");
  }
  return fs;
}

// src/video/factory.ts
var MEDIABUNNY_EXTENSIONS = ["webm", "mkv", "ogg", "mov", "mpeg", "avi"];
async function createVideoBackend(source, options) {
  const isBlob = typeof Blob !== "undefined" && source instanceof Blob;
  const filename = isBlob ? source.name ?? "" : source;
  const normalized = filename.split("?")[0]?.toLowerCase() ?? "";
  const ext = normalized.split(".").pop() ?? "";
  if (options?.embedded || ext === "slp" || ext === "h5" || ext === "hdf5") {
    const { file } = await openH5File(isBlob ? source : filename);
    const datasetPath = options?.dataset ?? "";
    return new Hdf5VideoBackend({
      filename,
      file,
      datasetPath,
      frameNumbers: options?.frameNumbers,
      frameSizes: options?.frameSizes,
      format: options?.format,
      channelOrder: options?.channelOrder,
      shape: options?.shape,
      fps: options?.fps
    });
  }
  if (options?.backend === "mediabunny") {
    if (isBlob) return MediaBunnyVideoBackend.fromBlob(source, filename);
    return MediaBunnyVideoBackend.fromUrl(filename);
  }
  if (options?.backend === "mp4box") {
    return new Mp4BoxVideoBackend(source);
  }
  if (options?.backend === "media") {
    if (isBlob) return new MediaVideoBackend(URL.createObjectURL(source));
    return new MediaVideoBackend(filename);
  }
  const supportsWebCodecs = typeof window !== "undefined" && typeof window.VideoDecoder !== "undefined" && typeof window.EncodedVideoChunk !== "undefined";
  if (supportsWebCodecs && ext === "mp4") {
    return new Mp4BoxVideoBackend(source);
  }
  if (supportsWebCodecs && MEDIABUNNY_EXTENSIONS.includes(ext)) {
    if (isBlob) return MediaBunnyVideoBackend.fromBlob(source, filename);
    return MediaBunnyVideoBackend.fromUrl(filename);
  }
  if (isBlob) return new MediaVideoBackend(URL.createObjectURL(source));
  return new MediaVideoBackend(filename);
}

// src/codecs/slp/read-streaming.ts
async function readSlpStreaming(source, options) {
  if (!isStreamingSupported()) {
    throw new Error("Streaming HDF5 requires Web Worker support (browser environment)");
  }
  const file = await openH5Worker(source, {
    h5wasmUrl: options?.h5wasmUrl,
    filenameHint: options?.filenameHint
  });
  const openVideos = options?.openVideos ?? false;
  const sourcePath = typeof source === "string" ? source : typeof File !== "undefined" && source instanceof File ? source.name : options?.filenameHint ?? "slp-data.slp";
  try {
    return await readFromStreamingFile(file, sourcePath, options?.filenameHint, openVideos);
  } finally {
    if (!openVideos) {
      await file.close();
    }
  }
}
async function readFromStreamingFile(file, url, filenameHint, openVideos = false) {
  const metadataAttrs = await file.getAttrs("metadata");
  const formatId = Number(
    metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1
  );
  const metadataJson = parseJsonAttr(metadataAttrs["json"]);
  const labelsPath = filenameHint ?? url.split("/").pop()?.split("?")[0] ?? "slp-data.slp";
  const skeletons = parseSkeletons(metadataJson);
  const tracks = await readTracksStreaming(file);
  const videos = await readVideosStreaming(file, labelsPath, openVideos, formatId);
  const suggestions = await readSuggestionsStreaming(file, videos);
  const framesData = await readStructDatasetStreaming(file, "frames");
  const instancesData = await readStructDatasetStreaming(file, "instances");
  const pointsData = await readStructDatasetStreaming(file, "points");
  const predPointsData = await readStructDatasetStreaming(file, "pred_points");
  const labeledFrames = buildLabeledFrames({
    framesData,
    instancesData,
    pointsData,
    predPointsData,
    skeletons,
    tracks,
    videos,
    formatId
  });
  const sessions = await readSessionsStreaming(file, videos, skeletons, labeledFrames);
  return new Labels({
    labeledFrames,
    videos,
    skeletons,
    tracks,
    suggestions,
    sessions,
    provenance: metadataJson?.provenance ?? {}
  });
}
async function readTracksStreaming(file) {
  try {
    const keys = file.keys();
    if (!keys.includes("tracks_json")) return [];
    const data = await file.getDatasetValue("tracks_json");
    const values = normalizeDatasetArray(data.value);
    return parseTracks(values);
  } catch {
    return [];
  }
}
async function readVideosStreaming(file, labelsPath, openVideos = false, formatId = 1) {
  try {
    const keys = file.keys();
    if (!keys.includes("videos_json")) return [];
    const data = await file.getDatasetValue("videos_json");
    const values = normalizeDatasetArray(data.value);
    const metadataList = parseVideosMetadata(values, labelsPath);
    const videos = [];
    for (let videoIndex = 0; videoIndex < metadataList.length; videoIndex++) {
      const meta = metadataList[videoIndex];
      const shape = meta.frameCount && meta.height && meta.width && meta.channels ? [meta.frameCount, meta.height, meta.width, meta.channels] : void 0;
      let datasetPath = meta.dataset;
      if (meta.embedded && !datasetPath) {
        datasetPath = await findVideoDatasetStreaming(file, videoIndex) ?? void 0;
      }
      let format = meta.format;
      let channelOrderFromAttrs;
      if (datasetPath) {
        try {
          const attrs = await file.getAttrs(datasetPath);
          if (!format) {
            const formatAttr = attrs.format;
            if (formatAttr) {
              format = typeof formatAttr === "string" ? formatAttr : formatAttr?.value;
            }
          }
          const channelOrderAttr = attrs.channel_order;
          if (channelOrderAttr) {
            channelOrderFromAttrs = typeof channelOrderAttr === "string" ? channelOrderAttr : channelOrderAttr?.value;
          }
        } catch {
        }
      }
      const channelOrder = meta.channelOrder ?? channelOrderFromAttrs ?? (formatId < 1.4 ? "BGR" : "RGB");
      let backend = null;
      if (openVideos && meta.embedded && datasetPath) {
        const frameNumbers = await readFrameNumbersStreaming(file, datasetPath);
        backend = new StreamingHdf5VideoBackend({
          filename: meta.filename,
          h5file: file,
          datasetPath,
          frameNumbers,
          format: format ?? "png",
          channelOrder,
          shape,
          fps: meta.fps
        });
      }
      videos.push(new Video({
        filename: meta.filename,
        backend,
        backendMetadata: {
          dataset: datasetPath,
          format,
          shape,
          fps: meta.fps,
          channel_order: channelOrder
        },
        sourceVideo: meta.sourceVideo ? new Video({ filename: meta.sourceVideo.filename }) : null,
        openBackend: openVideos && meta.embedded,
        embedded: meta.embedded
      }));
    }
    return videos;
  } catch {
    return [];
  }
}
async function readFrameNumbersStreaming(file, datasetPath) {
  try {
    const groupPath = datasetPath.endsWith("/video") ? datasetPath.slice(0, -6) : datasetPath;
    const frameNumbersPath = `${groupPath}/frame_numbers`;
    const groupKeys = await file.getKeys(groupPath);
    if (!groupKeys.includes("frame_numbers")) {
      return [];
    }
    const data = await file.getDatasetValue(frameNumbersPath);
    const values = data.value;
    if (Array.isArray(values)) {
      return values.map((v) => Number(v));
    }
    if (ArrayBuffer.isView(values)) {
      return Array.from(values).map(Number);
    }
    return [];
  } catch {
    return [];
  }
}
async function findVideoDatasetStreaming(file, videoIndex) {
  try {
    const explicitPath = `video${videoIndex}/video`;
    const explicitGroupPath = `video${videoIndex}`;
    try {
      const groupKeys = await file.getKeys(explicitGroupPath);
      if (groupKeys.includes("video")) {
        return explicitPath;
      }
    } catch {
    }
    const rootKeys = file.keys();
    for (const key of rootKeys) {
      if (key.startsWith("video")) {
        try {
          const groupKeys = await file.getKeys(key);
          if (groupKeys.includes("video")) {
            const candidatePath = `${key}/video`;
            if (videoIndex === 0) {
              return candidatePath;
            }
            const keyIndex = parseInt(key.slice(5), 10);
            if (!isNaN(keyIndex) && keyIndex === videoIndex) {
              return candidatePath;
            }
          }
        } catch {
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
async function readSuggestionsStreaming(file, videos) {
  try {
    const keys = file.keys();
    if (!keys.includes("suggestions_json")) return [];
    const data = await file.getDatasetValue("suggestions_json");
    const values = normalizeDatasetArray(data.value);
    const metadataList = parseSuggestions(values);
    return metadataList.map((meta) => {
      const video = videos[meta.video];
      if (!video) return null;
      return new SuggestionFrame({
        video,
        frameIdx: meta.frameIdx,
        metadata: meta.metadata
      });
    }).filter((s) => s !== null);
  } catch {
    return [];
  }
}
async function readSessionsStreaming(file, videos, skeletons, labeledFrames) {
  try {
    const keys = file.keys();
    if (!keys.includes("sessions_json")) return [];
    const data = await file.getDatasetValue("sessions_json");
    const values = normalizeDatasetArray(data.value);
    const sessions = [];
    for (const entry of values) {
      const parsed = parseJsonEntry(entry);
      const calibration = parsed.calibration ?? {};
      const cameraGroup = new CameraGroup();
      const cameraMap = /* @__PURE__ */ new Map();
      for (const [key, data2] of Object.entries(calibration)) {
        if (key === "metadata") continue;
        const cameraData = data2;
        const camera = new Camera({
          name: cameraData.name ?? key,
          rvec: cameraData.rotation ?? [0, 0, 0],
          tvec: cameraData.translation ?? [0, 0, 0],
          matrix: cameraData.matrix,
          distortions: cameraData.distortions
        });
        cameraGroup.cameras.push(camera);
        cameraMap.set(String(key), camera);
      }
      const session = new RecordingSession({ cameraGroup, metadata: parsed.metadata ?? {} });
      const map = parsed.camcorder_to_video_idx_map ?? {};
      for (const [cameraKey, videoIdx] of Object.entries(map)) {
        const camera = cameraMap.get(cameraKey);
        const video = videos[Number(videoIdx)];
        if (camera && video) {
          session.addVideo(video, camera);
        }
      }
      const frameGroups = Array.isArray(parsed.frame_group_dicts) ? parsed.frame_group_dicts : [];
      for (const group of frameGroups) {
        const groupRecord = group;
        const frameIdx = groupRecord.frame_idx ?? groupRecord.frameIdx ?? 0;
        const instanceGroups = [];
        const instanceGroupList = Array.isArray(groupRecord.instance_groups) ? groupRecord.instance_groups : [];
        for (const instanceGroup of instanceGroupList) {
          const instanceGroupRecord = instanceGroup;
          const instanceByCamera = /* @__PURE__ */ new Map();
          const instancesRecord = instanceGroupRecord.instances ?? {};
          for (const [cameraKey, points] of Object.entries(instancesRecord)) {
            const camera = cameraMap.get(cameraKey);
            if (!camera) continue;
            const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
            instanceByCamera.set(camera, new Instance({ points, skeleton }));
          }
          const rawPoints = instanceGroupRecord.points;
          const pointsValue = Array.isArray(rawPoints) ? rawPoints : void 0;
          instanceGroups.push(
            new InstanceGroup({
              instanceByCamera,
              score: instanceGroupRecord.score,
              points: pointsValue,
              metadata: instanceGroupRecord.metadata ?? {}
            })
          );
        }
        const labeledFrameByCamera = /* @__PURE__ */ new Map();
        const labeledFrameMap = groupRecord.labeled_frame_by_camera ?? {};
        for (const [cameraKey, labeledFrameIdx] of Object.entries(labeledFrameMap)) {
          const camera = cameraMap.get(cameraKey);
          const labeledFrame = labeledFrames[Number(labeledFrameIdx)];
          if (camera && labeledFrame) {
            labeledFrameByCamera.set(camera, labeledFrame);
          }
        }
        session.frameGroups.set(
          Number(frameIdx),
          new FrameGroup({
            frameIdx: Number(frameIdx),
            instanceGroups,
            labeledFrameByCamera,
            metadata: groupRecord.metadata ?? {}
          })
        );
      }
      sessions.push(session);
    }
    return sessions;
  } catch {
    return [];
  }
}
async function readStructDatasetStreaming(file, path) {
  try {
    const keys = file.keys();
    if (!keys.includes(path)) return {};
    const meta = await file.getDatasetMeta(path);
    const data = await file.getDatasetValue(path);
    const fieldNames = getFieldNamesFromMeta(meta);
    return normalizeStructData(data.value, data.shape, fieldNames);
  } catch {
    return {};
  }
}
function getFieldNamesFromMeta(meta) {
  const dtype = meta.dtype;
  if (typeof dtype === "string") {
    const namesMatch = dtype.match(/'names':\s*\[([^\]]+)\]/);
    if (namesMatch) {
      const namesStr = namesMatch[1];
      const names = namesStr.match(/'([^']+)'/g);
      if (names) {
        return names.map((n) => n.replace(/'/g, ""));
      }
    }
  }
  if (typeof dtype === "object" && dtype !== null) {
    const dtypeObj = dtype;
    if (dtypeObj.compound_type && typeof dtypeObj.compound_type === "object") {
      const compound = dtypeObj.compound_type;
      if (compound.members) {
        return compound.members.map((m) => m.name).filter((n) => !!n);
      }
    }
  }
  return [];
}
function normalizeStructData(value, shape, fieldNames) {
  if (!value) return {};
  if (value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
    const obj = value;
    const firstKey = Object.keys(obj)[0];
    if (firstKey && Array.isArray(obj[firstKey])) {
      return obj;
    }
  }
  if (ArrayBuffer.isView(value) && shape.length === 2) {
    const [rowCount, colCount] = shape;
    const arr = value;
    if (fieldNames.length === colCount) {
      const result = {};
      for (let col = 0; col < colCount; col++) {
        const colData = [];
        for (let row = 0; row < rowCount; row++) {
          colData.push(arr[row * colCount + col]);
        }
        result[fieldNames[col]] = colData;
      }
      return result;
    }
  }
  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    const rows = value;
    if (fieldNames.length) {
      const result = {};
      fieldNames.forEach((field, colIdx) => {
        result[field] = rows.map((row) => row[colIdx]);
      });
      return result;
    }
  }
  return {};
}
function normalizeDatasetArray(value) {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Array.from(value);
  }
  return [];
}
function buildLabeledFrames(options) {
  const frames = [];
  const { framesData, instancesData, pointsData, predPointsData, skeletons, tracks, videos, formatId } = options;
  const frameIds = framesData.frame_id ?? [];
  const videoIdToIndex = buildVideoIdMap(framesData, videos);
  const instanceById = /* @__PURE__ */ new Map();
  const fromPredictedPairs = [];
  for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
    const rawVideoId = Number(framesData.video?.[frameIdx] ?? 0);
    const videoIndex = videoIdToIndex.get(rawVideoId) ?? rawVideoId;
    const frameIndex = Number(framesData.frame_idx?.[frameIdx] ?? 0);
    const instStart = Number(framesData.instance_id_start?.[frameIdx] ?? 0);
    const instEnd = Number(framesData.instance_id_end?.[frameIdx] ?? 0);
    const video = videos[videoIndex];
    if (!video) continue;
    const instances = [];
    for (let instIdx = instStart; instIdx < instEnd; instIdx += 1) {
      const instanceType = Number(instancesData.instance_type?.[instIdx] ?? 0);
      const skeletonId = Number(instancesData.skeleton?.[instIdx] ?? 0);
      const trackId = Number(instancesData.track?.[instIdx] ?? -1);
      const pointStart = Number(instancesData.point_id_start?.[instIdx] ?? 0);
      const pointEnd = Number(instancesData.point_id_end?.[instIdx] ?? 0);
      const score = Number(instancesData.score?.[instIdx] ?? 0);
      const rawTrackingScore = formatId < 1.2 ? 0 : Number(instancesData.tracking_score?.[instIdx] ?? 0);
      const trackingScore = Number.isNaN(rawTrackingScore) ? 0 : rawTrackingScore;
      const fromPredicted = Number(instancesData.from_predicted?.[instIdx] ?? -1);
      const skeleton = skeletons[skeletonId] ?? skeletons[0] ?? new Skeleton({ nodes: [] });
      const track = trackId >= 0 ? tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        const points = slicePoints(pointsData, pointStart, pointEnd);
        instance = new Instance({ points: pointsFromArray(points, skeleton.nodeNames), skeleton, track, trackingScore });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        const points = slicePoints(predPointsData, pointStart, pointEnd, true);
        instance = new PredictedInstance({ points: predictedPointsFromArray(points, skeleton.nodeNames), skeleton, track, score, trackingScore });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
      }
      instanceById.set(instIdx, instance);
      instances.push(instance);
    }
    frames.push(new LabeledFrame({ video, frameIdx: frameIndex, instances }));
  }
  for (const [instanceId, fromPredictedId] of fromPredictedPairs) {
    const instance = instanceById.get(instanceId);
    const predicted = instanceById.get(fromPredictedId);
    if (instance && predicted instanceof PredictedInstance && instance instanceof Instance) {
      instance.fromPredicted = predicted;
    }
  }
  return frames;
}
function buildVideoIdMap(framesData, videos) {
  const videoIds = /* @__PURE__ */ new Set();
  for (const value of framesData.video ?? []) {
    videoIds.add(Number(value));
  }
  if (!videoIds.size) return /* @__PURE__ */ new Map();
  const maxId = Math.max(...Array.from(videoIds));
  if (videoIds.size === videos.length && maxId === videos.length - 1) {
    const identity = /* @__PURE__ */ new Map();
    for (let i = 0; i < videos.length; i += 1) {
      identity.set(i, i);
    }
    return identity;
  }
  const map = /* @__PURE__ */ new Map();
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const dataset = video.backendMetadata?.dataset ?? "";
    const parsedId = parseVideoIdFromDataset(dataset);
    if (parsedId != null) {
      map.set(parsedId, index);
    }
  }
  return map;
}
function parseVideoIdFromDataset(dataset) {
  if (!dataset) return null;
  const group = dataset.split("/")[0];
  if (!group.startsWith("video")) return null;
  const id = Number(group.slice(5));
  return Number.isNaN(id) ? null : id;
}
function slicePoints(data, start, end, predicted = false) {
  const xs = data.x ?? [];
  const ys = data.y ?? [];
  const visible = data.visible ?? [];
  const complete = data.complete ?? [];
  const scores = data.score ?? [];
  const points = [];
  for (let i = start; i < end; i += 1) {
    if (predicted) {
      points.push([xs[i], ys[i], scores[i], visible[i], complete[i]]);
    } else {
      points.push([xs[i], ys[i], visible[i], complete[i]]);
    }
  }
  return points;
}

// src/codecs/slp/write.ts
var _writeToFile = null;
function _registerFileWriter(writer) {
  _writeToFile = writer;
}
var FORMAT_ID = 1.4;
var textEncoder = new TextEncoder();
function setStringAttr(target, name, value) {
  const byteLength = textEncoder.encode(value).length;
  target.create_attribute(name, value, null, `S${byteLength}`);
}
var SPAWNED_ON = 0;
function writeSlpToFile(file, labels, embeddedVideoData) {
  writeMetadata(file, labels);
  if (embeddedVideoData && embeddedVideoData.size > 0) {
    writeEmbeddedVideos(file, labels, embeddedVideoData);
  } else {
    writeVideos(file, labels.videos);
  }
  writeTracks(file, labels.tracks);
  writeSuggestions(file, labels.suggestions, labels.videos);
  writeIdentities(file, labels.identities);
  writeSessions(file, labels.sessions, labels.videos, labels.labeledFrames, labels.identities);
  writeLabeledFrames(file, labels);
  writeNegativeFrames(file, labels);
  const allInstances = labels.labeledFrames.flatMap((f) => f.instances);
  writeRois(file, labels.rois, labels.videos, labels.tracks, allInstances);
  writeMasks(file, labels.masks, labels.videos, labels.tracks);
  writeBboxes(file, labels.bboxes, labels.videos, labels.tracks, allInstances);
}
async function saveSlpToBytes(labels, options) {
  const embedMode = options?.embed ?? false;
  let writeLabels = labels;
  if (embedMode === "source") {
    const restoredVideos = labels.videos.map((video) => {
      if (video.sourceVideo) return video.sourceVideo;
      return video;
    });
    writeLabels = new Labels({
      labeledFrames: labels.labeledFrames.map((frame) => {
        const videoIdx = labels.videos.indexOf(frame.video);
        const restoredVideo = videoIdx >= 0 ? restoredVideos[videoIdx] : frame.video;
        return new LabeledFrame({ video: restoredVideo, frameIdx: frame.frameIdx, instances: frame.instances });
      }),
      videos: restoredVideos,
      skeletons: labels.skeletons,
      tracks: labels.tracks,
      suggestions: labels.suggestions,
      sessions: labels.sessions,
      provenance: labels.provenance,
      identities: labels.identities
    });
  }
  const module = await getH5Module();
  const memPath = `/tmp/sleap_output_${Date.now()}_${Math.random().toString(16).slice(2)}.slp`;
  let embeddedVideoData = null;
  if (embedMode && embedMode !== "source") {
    embeddedVideoData = await collectFramesForEmbedding(labels, embedMode);
  }
  const file = new module.File(memPath, "w");
  try {
    writeSlpToFile(file, writeLabels, embeddedVideoData);
  } finally {
    file.close();
  }
  const fs = getH5FileSystem(module);
  const bytes = fs.readFile(memPath);
  fs.unlink(memPath);
  return bytes;
}
async function writeSlp(filename, labels, options) {
  const bytes = await saveSlpToBytes(labels, options);
  if (_writeToFile) {
    await _writeToFile(filename, bytes);
  } else {
    throw new Error(
      "writeSlp requires a Node.js environment for file I/O. Use saveSlpToBytes() to get the SLP data as a Uint8Array in the browser."
    );
  }
}
function writeMetadata(file, labels) {
  const { skeletons, nodes } = serializeSkeletons(labels.skeletons);
  const metadata = {
    version: "2.0.0",
    skeletons,
    nodes,
    videos: [],
    tracks: [],
    suggestions: [],
    negative_anchors: {},
    provenance: labels.provenance ?? {}
  };
  const hasRoiInstance = labels.rois.some((roi) => roi.instance !== null);
  const hasIdentities = (labels.identities?.length ?? 0) > 0;
  let formatId = (labels.bboxes?.length ?? 0) > 0 ? 1.7 : hasRoiInstance ? 1.6 : labels.rois.length > 0 || labels.masks.length > 0 ? 1.5 : FORMAT_ID;
  if (hasIdentities) {
    formatId = Math.max(formatId, 1.9);
  }
  file.create_group("metadata");
  const metadataGroup = file.get("metadata");
  metadataGroup.create_attribute("format_id", formatId);
  setStringAttr(metadataGroup, "json", JSON.stringify(metadata));
}
function serializeSkeletons(skeletons) {
  const nodes = [];
  const nodeIndex = /* @__PURE__ */ new Map();
  for (const skeleton of skeletons) {
    for (const nodeName of skeleton.nodeNames) {
      if (!nodeIndex.has(nodeName)) {
        nodeIndex.set(nodeName, nodes.length);
        nodes.push({ name: nodeName });
      }
    }
  }
  const serialized = skeletons.map((skeleton) => {
    const links = [];
    const edgeTypePyId = {};
    let nextPyId = 1;
    let edgeInsertIdx = 0;
    function makeEdgeType(typeVal) {
      if (edgeTypePyId[typeVal] != null) {
        return { "py/id": edgeTypePyId[typeVal] };
      }
      edgeTypePyId[typeVal] = nextPyId++;
      return {
        "py/reduce": [
          { "py/type": "sleap.skeleton.EdgeType" },
          { "py/tuple": [typeVal] }
        ]
      };
    }
    for (const edge of skeleton.edges) {
      const source = nodeIndex.get(edge.source.name) ?? 0;
      const target = nodeIndex.get(edge.destination.name) ?? 0;
      links.push({
        edge_insert_idx: edgeInsertIdx++,
        key: 0,
        source,
        target,
        type: makeEdgeType(1)
      });
    }
    for (const [left, right] of skeleton.symmetryNames) {
      const source = nodeIndex.get(left) ?? 0;
      const target = nodeIndex.get(right) ?? 0;
      links.push({ key: 0, source, target, type: makeEdgeType(2) });
    }
    const skeletonNodeIds = skeleton.nodeNames.map((name) => nodeIndex.get(name) ?? 0);
    return {
      directed: true,
      graph: {
        name: skeleton.name ?? "",
        num_edges_inserted: skeleton.edges.length
      },
      links,
      multigraph: true,
      nodes: skeletonNodeIds.map((id) => ({ id }))
    };
  });
  return { skeletons: serialized, nodes };
}
function writeVideos(file, videos) {
  const payload = videos.map((video) => JSON.stringify(serializeVideo(video)));
  file.create_dataset({ name: "videos_json", data: payload });
}
function serializeVideo(video) {
  const backend = { ...video.backendMetadata ?? {} };
  if (backend.filename == null) backend.filename = video.filename;
  if (backend.dataset == null && video.backend?.dataset) backend.dataset = video.backend.dataset;
  if (backend.shape == null && video.backend?.shape) backend.shape = video.backend.shape;
  if (backend.fps == null && video.backend?.fps != null) backend.fps = video.backend.fps;
  const entry = {
    filename: video.filename,
    backend
  };
  if (video.sourceVideo) {
    entry.source_video = { filename: video.sourceVideo.filename };
  }
  return entry;
}
function writeTracks(file, tracks) {
  const payload = tracks.map((track) => JSON.stringify([SPAWNED_ON, track.name]));
  file.create_dataset({ name: "tracks_json", data: payload });
}
function writeSuggestions(file, suggestions, videos) {
  const payload = suggestions.map(
    (suggestion) => JSON.stringify({
      video: String(videos.indexOf(suggestion.video)),
      frame_idx: suggestion.frameIdx,
      group: suggestion.group ?? "default"
    })
  );
  file.create_dataset({ name: "suggestions_json", data: payload });
}
function writeIdentities(file, identities) {
  if (!identities.length) return;
  const payload = identities.map((identity) => {
    const d = { name: identity.name };
    if (identity.color != null) d.color = identity.color;
    Object.assign(d, identity.metadata);
    return JSON.stringify(d);
  });
  file.create_dataset({ name: "identities_json", data: payload });
}
function writeSessions(file, sessions, videos, labeledFrames, identities) {
  const labeledFrameIndex = /* @__PURE__ */ new Map();
  labeledFrames.forEach((lf, idx) => labeledFrameIndex.set(lf, idx));
  const payload = sessions.map((session) => JSON.stringify(serializeSession(session, videos, labeledFrameIndex, identities)));
  file.create_dataset({ name: "sessions_json", data: payload });
}
function serializeSession(session, videos, labeledFrameIndex, identities) {
  const calibration = { metadata: session.cameraGroup.metadata ?? {} };
  session.cameraGroup.cameras.forEach((camera, idx) => {
    const key = camera.name ?? String(idx);
    const camData = {
      name: camera.name ?? key,
      rotation: camera.rvec,
      translation: camera.tvec,
      matrix: camera.matrix,
      distortions: camera.distortions
    };
    if (camera.size) camData.size = camera.size;
    calibration[key] = camData;
  });
  const camcorder_to_video_idx_map = {};
  for (const [camera, video] of session.videoByCamera.entries()) {
    const cameraIndex = session.cameraGroup.cameras.indexOf(camera);
    const videoIndex = videos.indexOf(video);
    if (cameraIndex >= 0 && videoIndex >= 0) {
      camcorder_to_video_idx_map[String(cameraIndex)] = videoIndex;
    }
  }
  const frame_group_dicts = [];
  for (const frameGroup of session.frameGroups.values()) {
    if (!frameGroup.instanceGroups.length) continue;
    frame_group_dicts.push(serializeFrameGroup(frameGroup, session, labeledFrameIndex, identities));
  }
  return {
    calibration,
    camcorder_to_video_idx_map,
    frame_group_dicts,
    metadata: session.metadata ?? {}
  };
}
function serializeFrameGroup(frameGroup, session, labeledFrameIndex, identities) {
  const instance_groups = frameGroup.instanceGroups.map((group) => serializeInstanceGroup(group, session, identities));
  const labeled_frame_by_camera = {};
  for (const [camera, labeledFrame] of frameGroup.labeledFrameByCamera.entries()) {
    const cameraKey = cameraKeyForSession(camera, session);
    const index = labeledFrameIndex.get(labeledFrame);
    if (index !== void 0) {
      labeled_frame_by_camera[cameraKey] = index;
    }
  }
  return {
    frame_idx: frameGroup.frameIdx,
    instance_groups,
    labeled_frame_by_camera,
    metadata: frameGroup.metadata ?? {}
  };
}
function serializeInstanceGroup(group, session, identities) {
  const instances = {};
  for (const [camera, instance] of group.instanceByCamera.entries()) {
    const cameraKey = cameraKeyForSession(camera, session);
    instances[cameraKey] = pointsToDict(instance);
  }
  const payload = {
    instances
  };
  if (group.score != null) payload.score = group.score;
  if (group.instance3d) {
    if (group.instance3d.points) {
      payload.points = group.instance3d.points;
    }
    if (group.instance3d.score != null) {
      payload.instance_3d_score = group.instance3d.score;
    }
    if (group.instance3d instanceof PredictedInstance3D && group.instance3d.pointScores) {
      payload.instance_3d_point_scores = group.instance3d.pointScores;
    }
  } else if (group.points != null) {
    payload.points = group.points;
  }
  if (group.identity && identities) {
    const identityIdx = identities.indexOf(group.identity);
    if (identityIdx >= 0) {
      payload.identity_idx = identityIdx;
    }
  }
  if (group.metadata && Object.keys(group.metadata).length) payload.metadata = group.metadata;
  return payload;
}
function pointsToDict(instance) {
  const names = instance.skeleton.nodeNames;
  const dict = {};
  instance.points.forEach((point, idx) => {
    const name = point.name ?? names[idx] ?? String(idx);
    const row = [
      point.xy[0],
      point.xy[1],
      point.visible ? 1 : 0,
      point.complete ? 1 : 0
    ];
    if (point.score != null) {
      row.push(point.score);
    }
    dict[name] = row;
  });
  return dict;
}
function cameraKeyForSession(camera, session) {
  const index = session.cameraGroup.cameras.indexOf(camera);
  return camera.name ?? String(index);
}
function writeLabeledFrames(file, labels) {
  const frames = [];
  const instances = [];
  const points = [];
  const predPoints = [];
  const instanceIndex = /* @__PURE__ */ new Map();
  const predictedLinks = [];
  for (const labeledFrame of labels.labeledFrames) {
    const frameId = frames.length;
    const instanceStart = instances.length;
    const videoIndex = Math.max(0, labels.videos.indexOf(labeledFrame.video));
    for (const instance of labeledFrame.instances) {
      const instanceId = instances.length;
      instanceIndex.set(instance, instanceId);
      const skeletonId = Math.max(0, labels.skeletons.indexOf(instance.skeleton));
      const trackId = instance.track ? labels.tracks.indexOf(instance.track) : -1;
      const trackingScore = instance.trackingScore ?? 0;
      let fromPredicted = -1;
      let score = 0;
      let pointStart = 0;
      let pointEnd = 0;
      if (instance instanceof PredictedInstance) {
        score = instance.score ?? 0;
        pointStart = predPoints.length;
        for (const point of instance.points) {
          predPoints.push([
            point.xy[0],
            point.xy[1],
            point.visible ? 1 : 0,
            point.complete ? 1 : 0,
            point.score ?? 0
          ]);
        }
        pointEnd = predPoints.length;
      } else {
        pointStart = points.length;
        for (const point of instance.points) {
          points.push([
            point.xy[0],
            point.xy[1],
            point.visible ? 1 : 0,
            point.complete ? 1 : 0
          ]);
        }
        pointEnd = points.length;
        if (instance.fromPredicted) {
          predictedLinks.push([instanceId, instance.fromPredicted]);
        }
      }
      instances.push([
        instanceId,
        instance instanceof PredictedInstance ? 1 : 0,
        frameId,
        skeletonId,
        trackId,
        fromPredicted,
        score,
        pointStart,
        pointEnd,
        trackingScore
      ]);
    }
    const instanceEnd = instances.length;
    frames.push([frameId, videoIndex, labeledFrame.frameIdx, instanceStart, instanceEnd]);
  }
  for (const [instanceId, fromPredictedInstance] of predictedLinks) {
    const fromIndex = instanceIndex.get(fromPredictedInstance);
    if (fromIndex != null) {
      instances[instanceId][5] = fromIndex;
    } else {
      instances[instanceId][5] = -1;
    }
  }
  createMatrixDataset(file, "frames", frames, ["frame_id", "video", "frame_idx", "instance_id_start", "instance_id_end"], "<i8");
  createMatrixDataset(
    file,
    "instances",
    instances,
    [
      "instance_id",
      "instance_type",
      "frame_id",
      "skeleton",
      "track",
      "from_predicted",
      "score",
      "point_id_start",
      "point_id_end",
      "tracking_score"
    ],
    "<f8"
  );
  createMatrixDataset(file, "points", points, ["x", "y", "visible", "complete"], "<f8");
  createMatrixDataset(file, "pred_points", predPoints, ["x", "y", "visible", "complete", "score"], "<f8");
}
function writeNegativeFrames(file, labels) {
  const negativeFrames = labels.labeledFrames.filter((f) => f.isNegative);
  if (!negativeFrames.length) return;
  const rows = [];
  for (const frame of negativeFrames) {
    const videoIndex = Math.max(0, labels.videos.indexOf(frame.video));
    rows.push([videoIndex, frame.frameIdx]);
  }
  createMatrixDataset(file, "negative_frames", rows, ["video_id", "frame_idx"], "<i8");
}
async function collectFramesForEmbedding(labels, embedMode) {
  const result = /* @__PURE__ */ new Map();
  const framesByVideo = /* @__PURE__ */ new Map();
  const mode = embedMode === true ? "all" : String(embedMode).toLowerCase();
  for (const frame of labels.labeledFrames) {
    const videoIndex = labels.videos.indexOf(frame.video);
    if (videoIndex < 0) continue;
    let include = false;
    if (mode === "all") {
      include = true;
    } else if (mode === "user") {
      include = frame.hasUserInstances;
    } else if (mode === "suggestions") {
      include = false;
    } else if (mode === "user+suggestions") {
      include = frame.hasUserInstances;
    }
    if (include) {
      if (!framesByVideo.has(videoIndex)) framesByVideo.set(videoIndex, /* @__PURE__ */ new Set());
      framesByVideo.get(videoIndex).add(frame.frameIdx);
    }
  }
  if (mode === "suggestions" || mode === "user+suggestions") {
    for (const suggestion of labels.suggestions) {
      const videoIndex = labels.videos.indexOf(suggestion.video);
      if (videoIndex < 0) continue;
      if (!framesByVideo.has(videoIndex)) framesByVideo.set(videoIndex, /* @__PURE__ */ new Set());
      framesByVideo.get(videoIndex).add(suggestion.frameIdx);
    }
  }
  for (const [videoIndex, frameIndices] of framesByVideo) {
    const video = labels.videos[videoIndex];
    if (!video || !video.backend) continue;
    const sortedFrames = Array.from(frameIndices).sort((a, b) => a - b);
    const frameData = /* @__PURE__ */ new Map();
    for (const frameIdx of sortedFrames) {
      const frame = await video.getFrame(frameIdx);
      if (frame) {
        const bytes = frameToBytes(frame);
        if (bytes) {
          frameData.set(frameIdx, bytes);
        }
      }
    }
    if (frameData.size > 0) {
      const backendFormat = video.backendMetadata?.format ?? "png";
      const backendChannelOrder = video.backendMetadata?.channel_order ?? "RGB";
      result.set(videoIndex, {
        videoIndex,
        frameNumbers: sortedFrames.filter((f) => frameData.has(f)),
        frameData,
        format: backendFormat,
        channelOrder: backendChannelOrder
      });
    }
  }
  return result;
}
function frameToBytes(frame) {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  if (ArrayBuffer.isView(frame)) {
    const view = frame;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
function writeEmbeddedVideos(file, labels, embeddedVideoData) {
  const payload = labels.videos.map((video, videoIndex) => {
    const embedData = embeddedVideoData.get(videoIndex);
    if (embedData) {
      const backend = {
        filename: ".",
        dataset: `video${videoIndex}/video`,
        format: embedData.format,
        channel_order: embedData.channelOrder
      };
      if (video.backend?.shape) backend.shape = video.backend.shape;
      if (video.backend?.fps != null) backend.fps = video.backend.fps;
      const entry = {
        filename: ".",
        backend
      };
      if (video.sourceVideo) {
        entry.source_video = { filename: video.sourceVideo.filename };
      } else if (!video.hasEmbeddedImages) {
        entry.source_video = { filename: Array.isArray(video.filename) ? video.filename[0] : video.filename };
      }
      return JSON.stringify(entry);
    } else {
      return JSON.stringify(serializeVideo(video));
    }
  });
  file.create_dataset({ name: "videos_json", data: payload });
  for (const [videoIndex, embedData] of embeddedVideoData) {
    const groupName = `video${videoIndex}`;
    file.create_group(groupName);
    const frameBytes = [];
    for (const frameNum of embedData.frameNumbers) {
      const data = embedData.frameData.get(frameNum);
      if (data) frameBytes.push(data);
    }
    const totalSize = frameBytes.reduce((sum, b) => sum + b.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const bytes of frameBytes) {
      combined.set(bytes, offset);
      offset += bytes.length;
    }
    file.create_dataset({
      name: `${groupName}/video`,
      data: combined,
      shape: [combined.length],
      dtype: "<B"
    });
    const videoDs = file.get(`${groupName}/video`);
    if (videoDs) {
      setStringAttr(videoDs, "format", embedData.format);
      setStringAttr(videoDs, "channel_order", embedData.channelOrder);
    }
    file.create_dataset({
      name: `${groupName}/frame_numbers`,
      data: embedData.frameNumbers,
      shape: [embedData.frameNumbers.length],
      dtype: "<i4"
    });
    const frameSizes = frameBytes.map((b) => b.length);
    file.create_dataset({
      name: `${groupName}/frame_sizes`,
      data: frameSizes,
      shape: [frameSizes.length],
      dtype: "<i4"
    });
  }
}
function createMatrixDataset(file, name, rows, fieldNames, dtype) {
  const rowCount = rows.length;
  const colCount = fieldNames.length;
  const TypedArray = dtype.includes("i") ? dtype.includes("4") ? Int32Array : Float64Array : Float64Array;
  const data = new TypedArray(rowCount * colCount);
  for (let i = 0; i < rowCount; i++) {
    const row = rows[i];
    const offset = i * colCount;
    for (let j = 0; j < colCount; j++) {
      data[offset + j] = row[j];
    }
  }
  file.create_dataset({ name, data, shape: [rowCount, colCount], dtype });
  const dataset = file.get(name);
  setStringAttr(dataset, "field_names", JSON.stringify(fieldNames));
}
function writeRois(file, rois, videos, tracks, instances) {
  if (!rois.length) return;
  const rows = [];
  const wkbChunks = [];
  let wkbOffset = 0;
  const categories = [];
  const names = [];
  const sources = [];
  const hasInstances = instances && instances.length > 0;
  for (const roi of rois) {
    const wkb = encodeWkb(roi.geometry);
    const wkbStart = wkbOffset;
    const wkbEnd = wkbOffset + wkb.length;
    wkbChunks.push(wkb);
    wkbOffset = wkbEnd;
    const videoIdx = roi.video ? videos.indexOf(roi.video) : -1;
    const frameIdx = roi.frameIdx ?? -1;
    const trackIdx = roi.track ? tracks.indexOf(roi.track) : -1;
    const instanceIdx = hasInstances && roi.instance ? instances.indexOf(roi.instance) : -1;
    rows.push([0, videoIdx, frameIdx, trackIdx, Number.NaN, wkbStart, wkbEnd, instanceIdx]);
    categories.push(roi.category);
    names.push(roi.name);
    sources.push(roi.source);
  }
  createMatrixDataset(
    file,
    "rois",
    rows,
    ["annotation_type", "video", "frame_idx", "track", "score", "wkb_start", "wkb_end", "instance"],
    "<f8"
  );
  const roisDs = file.get("rois");
  setStringAttr(roisDs, "categories", JSON.stringify(categories));
  setStringAttr(roisDs, "names", JSON.stringify(names));
  setStringAttr(roisDs, "sources", JSON.stringify(sources));
  const totalWkb = wkbChunks.reduce((sum, c) => sum + c.length, 0);
  const wkbFlat = new Uint8Array(totalWkb);
  let offset = 0;
  for (const chunk of wkbChunks) {
    wkbFlat.set(chunk, offset);
    offset += chunk.length;
  }
  file.create_dataset({ name: "roi_wkb", data: wkbFlat, shape: [wkbFlat.length], dtype: "<B" });
}
function writeMasks(file, masks, videos, tracks) {
  if (!masks.length) return;
  const rows = [];
  const rleChunks = [];
  let rleOffset = 0;
  const categories = [];
  const names = [];
  const sources = [];
  for (const mask of masks) {
    const rleBytes = new Uint8Array(mask.rleCounts.length * 4);
    const view = new DataView(rleBytes.buffer);
    for (let j = 0; j < mask.rleCounts.length; j++) {
      view.setUint32(j * 4, mask.rleCounts[j], true);
    }
    const rleStart = rleOffset;
    const rleEnd = rleOffset + rleBytes.length;
    rleChunks.push(rleBytes);
    rleOffset = rleEnd;
    const videoIdx = mask.video ? videos.indexOf(mask.video) : -1;
    const frameIdx = mask.frameIdx ?? -1;
    const trackIdx = mask.track ? tracks.indexOf(mask.track) : -1;
    rows.push([mask.height, mask.width, 2, videoIdx, frameIdx, trackIdx, Number.NaN, rleStart, rleEnd]);
    categories.push(mask.category);
    names.push(mask.name);
    sources.push(mask.source);
  }
  createMatrixDataset(
    file,
    "masks",
    rows,
    ["height", "width", "annotation_type", "video", "frame_idx", "track", "score", "rle_start", "rle_end"],
    "<f8"
  );
  const masksDs = file.get("masks");
  setStringAttr(masksDs, "categories", JSON.stringify(categories));
  setStringAttr(masksDs, "names", JSON.stringify(names));
  setStringAttr(masksDs, "sources", JSON.stringify(sources));
  const totalRle = rleChunks.reduce((sum, c) => sum + c.length, 0);
  const rleFlat = new Uint8Array(totalRle);
  let offset = 0;
  for (const chunk of rleChunks) {
    rleFlat.set(chunk, offset);
    offset += chunk.length;
  }
  file.create_dataset({ name: "mask_rle", data: rleFlat, shape: [rleFlat.length], dtype: "<B" });
}
function writeBboxes(file, bboxes, videos, tracks, instances) {
  if (!bboxes.length) return;
  const rows = [];
  const categories = [];
  const names = [];
  const sources = [];
  for (const bbox of bboxes) {
    const videoIdx = bbox.video ? videos.indexOf(bbox.video) : -1;
    const frameIdx = bbox.frameIdx ?? -1;
    const trackIdx = bbox.track ? tracks.indexOf(bbox.track) : -1;
    const score = bbox.isPredicted ? bbox.score : Number.NaN;
    const instanceIdx = bbox.instance ? instances.indexOf(bbox.instance) : -1;
    rows.push([
      bbox.xCenter,
      bbox.yCenter,
      bbox.width,
      bbox.height,
      bbox.angle,
      videoIdx,
      frameIdx,
      trackIdx,
      score,
      instanceIdx
    ]);
    categories.push(bbox.category);
    names.push(bbox.name);
    sources.push(bbox.source);
  }
  createMatrixDataset(
    file,
    "bboxes",
    rows,
    ["x_center", "y_center", "width", "height", "angle", "video", "frame_idx", "track", "score", "instance"],
    "<f8"
  );
  const bboxesDs = file.get("bboxes");
  setStringAttr(bboxesDs, "categories", JSON.stringify(categories));
  setStringAttr(bboxesDs, "names", JSON.stringify(names));
  setStringAttr(bboxesDs, "sources", JSON.stringify(sources));
}

// src/codecs/slp/read.ts
var textDecoder = new TextDecoder();
async function readSlp(source, options) {
  const { file, close } = await openH5File(source, options?.h5);
  try {
    const metadataGroup = file.get("metadata");
    if (!metadataGroup) {
      throw new Error("Missing /metadata group in SLP file");
    }
    const metadataAttrs = metadataGroup.attrs ?? {};
    const formatId = Number(metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1);
    const metadataJson = parseJsonAttr(metadataAttrs["json"]);
    const labelsPath = typeof source === "string" ? source : options?.h5?.filenameHint ?? "slp-data.slp";
    const skeletons = parseSkeletons(metadataJson);
    const tracks = readTracks(file.get("tracks_json"));
    const videos = await readVideos(file.get("videos_json"), labelsPath, options?.openVideos ?? true, file, formatId);
    const suggestions = readSuggestions(file.get("suggestions_json"), videos);
    const framesData = normalizeStructDataset(file.get("frames"));
    const instancesData = normalizeStructDataset(file.get("instances"));
    const pointsData = normalizeStructDataset(file.get("points"));
    const predPointsData = normalizeStructDataset(file.get("pred_points"));
    const labeledFrames = buildLabeledFrames2({
      framesData,
      instancesData,
      pointsData,
      predPointsData,
      skeletons,
      tracks,
      videos,
      formatId
    });
    const negativeFramesDs = file.get("negative_frames");
    if (negativeFramesDs) {
      const negData = normalizeStructDataset(negativeFramesDs);
      const videoIds = negData.video_id ?? negData.video ?? [];
      const frameIdxs = negData.frame_idx ?? [];
      const negativeSet = /* @__PURE__ */ new Set();
      for (let i = 0; i < frameIdxs.length; i++) {
        negativeSet.add(`${Number(videoIds[i])}:${Number(frameIdxs[i])}`);
      }
      for (const frame of labeledFrames) {
        const videoIndex = Math.max(0, videos.indexOf(frame.video));
        if (negativeSet.has(`${videoIndex}:${frame.frameIdx}`)) {
          frame.isNegative = true;
        }
      }
    }
    const identities = readIdentities(file.get("identities_json"));
    const sessions = readSessions(file.get("sessions_json"), videos, skeletons, labeledFrames, identities);
    const allInstances = labeledFrames.flatMap((f) => f.instances);
    const { rois, bboxes } = readRoisAndBboxes(file, videos, tracks, allInstances);
    const masks = readMasks(file, videos, tracks);
    return new Labels({
      labeledFrames,
      videos,
      skeletons,
      tracks,
      suggestions,
      sessions,
      identities,
      provenance: metadataJson?.provenance ?? {},
      rois,
      masks,
      bboxes
    });
  } finally {
    close();
  }
}
async function readSlpLazy(source, options) {
  const { file, close } = await openH5File(source, options?.h5);
  try {
    const metadataGroup = file.get("metadata");
    if (!metadataGroup) {
      throw new Error("Missing /metadata group in SLP file");
    }
    const metadataAttrs = metadataGroup.attrs ?? {};
    const formatId = Number(metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1);
    const metadataJson = parseJsonAttr(metadataAttrs["json"]);
    const labelsPath = typeof source === "string" ? source : options?.h5?.filenameHint ?? "slp-data.slp";
    const skeletons = parseSkeletons(metadataJson);
    const tracks = readTracks(file.get("tracks_json"));
    const videos = await readVideos(file.get("videos_json"), labelsPath, options?.openVideos ?? true, file, formatId);
    const suggestions = readSuggestions(file.get("suggestions_json"), videos);
    const framesData = normalizeStructDataset(file.get("frames"));
    const instancesData = normalizeStructDataset(file.get("instances"));
    const pointsData = normalizeStructDataset(file.get("points"));
    const predPointsData = normalizeStructDataset(file.get("pred_points"));
    const negativeFrames = /* @__PURE__ */ new Set();
    const negativeFramesDs = file.get("negative_frames");
    if (negativeFramesDs) {
      const negData = normalizeStructDataset(negativeFramesDs);
      const videoIds = negData.video_id ?? negData.video ?? [];
      const frameIdxs = negData.frame_idx ?? [];
      for (let i = 0; i < frameIdxs.length; i++) {
        negativeFrames.add(`${Number(videoIds[i])}:${Number(frameIdxs[i])}`);
      }
    }
    const store = new LazyDataStore({
      framesData,
      instancesData,
      pointsData,
      predPointsData,
      skeletons,
      tracks,
      videos,
      formatId,
      negativeFrames
    });
    const lazyFrames = new LazyFrameList(store);
    const identities = readIdentities(file.get("identities_json"));
    const sessions = readSessions(file.get("sessions_json"), videos, skeletons, [], identities);
    const { rois, bboxes } = readRoisAndBboxes(file, videos, tracks);
    const masks = readMasks(file, videos, tracks);
    const labels = new Labels({
      videos,
      skeletons,
      tracks,
      suggestions,
      sessions,
      identities,
      provenance: metadataJson?.provenance ?? {},
      rois,
      masks,
      bboxes
    });
    labels._lazyFrameList = lazyFrames;
    labels._lazyDataStore = store;
    return labels;
  } finally {
    close();
  }
}
function readTracks(dataset) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const tracks = [];
  for (const entry of values) {
    let parsed = entry;
    if (typeof entry === "string") {
      try {
        parsed = JSON.parse(entry);
      } catch {
        parsed = entry;
      }
    }
    if (Array.isArray(parsed)) {
      tracks.push(new Track(String(parsed[1] ?? parsed[0])));
    } else if (parsed?.name) {
      tracks.push(new Track(String(parsed.name)));
    } else {
      tracks.push(new Track(String(parsed)));
    }
  }
  return tracks;
}
async function readVideos(dataset, labelsPath, openVideos, file, formatId) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const videos = [];
  for (let videoIndex = 0; videoIndex < values.length; videoIndex++) {
    const entry = values[videoIndex];
    if (!entry) continue;
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder.decode(entry));
    const backendMeta = parsed.backend ?? {};
    let filename = backendMeta.filename ?? parsed.filename ?? "";
    let datasetPath = backendMeta.dataset ?? null;
    let embedded = false;
    if (filename === ".") {
      embedded = true;
      filename = labelsPath;
    }
    if (embedded && !datasetPath) {
      datasetPath = findVideoDataset(file, videoIndex);
    }
    let format = backendMeta.format;
    let channelOrderFromAttrs;
    if (datasetPath) {
      const videoDs = file.get(datasetPath);
      if (videoDs) {
        const attrs = videoDs.attrs ?? {};
        if (!format) {
          const rawFormat = attrs.format?.value ?? attrs.format;
          format = rawFormat instanceof Uint8Array ? textDecoder.decode(rawFormat) : rawFormat;
        }
        if (attrs.channel_order) {
          const rawCo = attrs.channel_order?.value ?? attrs.channel_order;
          channelOrderFromAttrs = rawCo instanceof Uint8Array ? textDecoder.decode(rawCo) : rawCo;
        }
      }
    }
    const channelOrder = backendMeta.channel_order ?? channelOrderFromAttrs ?? (formatId < 1.4 ? "BGR" : "RGB");
    let backend = null;
    if (openVideos) {
      backend = await createVideoBackend(filename, {
        dataset: datasetPath ?? void 0,
        embedded,
        frameNumbers: readFrameNumbers(file, datasetPath),
        frameSizes: readFrameSizes(file, datasetPath),
        format,
        channelOrder,
        shape: backendMeta.shape,
        fps: backendMeta.fps
      });
    }
    const sourceVideo = parsed.source_video ? new Video({ filename: parsed.source_video.filename ?? "" }) : null;
    videos.push(
      new Video({
        filename,
        backend,
        backendMetadata: backendMeta,
        sourceVideo,
        openBackend: openVideos,
        embedded
      })
    );
  }
  return videos;
}
function readFrameNumbers(file, datasetPath) {
  if (!datasetPath) return [];
  const groupPath = datasetPath.endsWith("/video") ? datasetPath.slice(0, -6) : datasetPath;
  const frameDataset = file.get(`${groupPath}/frame_numbers`);
  if (!frameDataset) return [];
  const values = frameDataset.value ?? [];
  return Array.from(values).map((v) => Number(v));
}
function readFrameSizes(file, datasetPath) {
  if (!datasetPath) return void 0;
  const groupPath = datasetPath.endsWith("/video") ? datasetPath.slice(0, -6) : datasetPath;
  const sizesDataset = file.get(`${groupPath}/frame_sizes`);
  if (!sizesDataset) return void 0;
  const values = sizesDataset.value ?? [];
  return Array.from(values).map((v) => Number(v));
}
function findVideoDataset(file, videoIndex) {
  const explicitPath = `video${videoIndex}/video`;
  if (file.get(explicitPath)) {
    return explicitPath;
  }
  const keys = file.keys?.() ?? [];
  for (const key of keys) {
    if (key.startsWith("video")) {
      const candidatePath = `${key}/video`;
      if (file.get(candidatePath)) {
        if (videoIndex === 0) {
          return candidatePath;
        }
        const keyIndex = parseInt(key.slice(5), 10);
        if (!isNaN(keyIndex) && keyIndex === videoIndex) {
          return candidatePath;
        }
      }
    }
  }
  return null;
}
function readSuggestions(dataset, videos) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const suggestions = [];
  for (const entry of values) {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder.decode(entry));
    const videoIndex = Number(parsed.video ?? 0);
    const video = videos[videoIndex];
    if (!video) continue;
    suggestions.push(new SuggestionFrame({ video, frameIdx: parsed.frame_idx ?? parsed.frameIdx ?? 0, group: parsed.group != null ? String(parsed.group) : void 0, metadata: parsed }));
  }
  return suggestions;
}
function readIdentities(dataset) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const identities = [];
  for (const entry of values) {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder.decode(entry));
    const { name, color, ...rest } = parsed;
    identities.push(new Identity({
      name: name ?? "",
      color: color ?? void 0,
      metadata: rest
    }));
  }
  return identities;
}
function readSessions(dataset, videos, skeletons, labeledFrames, identities) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const sessions = [];
  for (const entry of values) {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder.decode(entry));
    const cameraGroup = new CameraGroup();
    const cameraMap = /* @__PURE__ */ new Map();
    const calibration = asRecord(parsed.calibration);
    for (const [key, data] of Object.entries(calibration)) {
      if (key === "metadata") continue;
      const cameraData = asRecord(data);
      const camera = new Camera({
        name: cameraData.name ?? key,
        rvec: cameraData.rotation ?? [0, 0, 0],
        tvec: cameraData.translation ?? [0, 0, 0],
        matrix: cameraData.matrix,
        distortions: cameraData.distortions,
        size: cameraData.size
      });
      cameraGroup.cameras.push(camera);
      cameraMap.set(String(key), camera);
    }
    const session = new RecordingSession({ cameraGroup, metadata: parsed.metadata ?? {} });
    const map = asRecord(parsed.camcorder_to_video_idx_map);
    for (const [cameraKey, videoIdx] of Object.entries(map)) {
      let camera = cameraMap.get(cameraKey);
      if (!camera) {
        const idx = Number(cameraKey);
        if (!isNaN(idx) && idx >= 0 && idx < cameraGroup.cameras.length) {
          camera = cameraGroup.cameras[idx];
        }
      }
      const video = videos[Number(videoIdx)];
      if (camera && video) {
        session.addVideo(video, camera);
      }
    }
    const frameGroups = Array.isArray(parsed.frame_group_dicts) ? parsed.frame_group_dicts : [];
    for (const group of frameGroups) {
      const groupRecord = asRecord(group);
      const frameIdx = groupRecord.frame_idx ?? groupRecord.frameIdx ?? 0;
      const instanceGroups = [];
      const instanceGroupList = Array.isArray(groupRecord.instance_groups) ? groupRecord.instance_groups : [];
      for (const instanceGroup of instanceGroupList) {
        const instanceGroupRecord = asRecord(instanceGroup);
        const instanceByCamera = /* @__PURE__ */ new Map();
        const instancesRecord = asRecord(instanceGroupRecord.instances);
        for (const [cameraKey, points] of Object.entries(instancesRecord)) {
          const camera = cameraMap.get(cameraKey);
          if (!camera) continue;
          const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
          instanceByCamera.set(camera, new Instance({ points, skeleton }));
        }
        let instance3d;
        const rawPoints = instanceGroupRecord.points;
        const pointsValue = Array.isArray(rawPoints) ? rawPoints : void 0;
        if (pointsValue) {
          const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
          const inst3dScore = instanceGroupRecord.instance_3d_score;
          const pointScores = instanceGroupRecord.instance_3d_point_scores;
          if (pointScores) {
            instance3d = new PredictedInstance3D({
              points: pointsValue,
              skeleton,
              score: inst3dScore,
              pointScores
            });
          } else {
            instance3d = new Instance3D({
              points: pointsValue,
              skeleton,
              score: inst3dScore
            });
          }
        }
        let identity;
        const identityIdx = instanceGroupRecord.identity_idx;
        if (identityIdx != null && identities) {
          identity = identities[Number(identityIdx)];
        }
        instanceGroups.push(
          new InstanceGroup({
            instanceByCamera,
            score: instanceGroupRecord.score,
            instance3d,
            identity,
            metadata: instanceGroupRecord.metadata ?? {}
          })
        );
      }
      const labeledFrameByCamera = /* @__PURE__ */ new Map();
      const labeledFrameMap = asRecord(groupRecord.labeled_frame_by_camera);
      for (const [cameraKey, labeledFrameIdx] of Object.entries(labeledFrameMap)) {
        const camera = cameraMap.get(cameraKey);
        const labeledFrame = labeledFrames[Number(labeledFrameIdx)];
        if (camera && labeledFrame) {
          labeledFrameByCamera.set(camera, labeledFrame);
        }
      }
      session.frameGroups.set(
        Number(frameIdx),
        new FrameGroup({
          frameIdx: Number(frameIdx),
          instanceGroups,
          labeledFrameByCamera,
          metadata: groupRecord.metadata ?? {}
        })
      );
    }
    sessions.push(session);
  }
  return sessions;
}
function asRecord(value) {
  if (value && typeof value === "object") {
    return value;
  }
  return {};
}
function readAttrString(dataset, name) {
  const attrs = dataset.attrs ?? {};
  const raw = attrs[name];
  if (!raw) return [];
  const value = raw.value ?? raw;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(textDecoder.decode(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.map(String);
  return [];
}
function readRoisAndBboxes(file, videos, tracks, instances) {
  const { rois, migratedBboxes } = readRoisWithMigration(file, videos, tracks, instances);
  let bboxes = readBboxes(file, videos, tracks);
  if (bboxes.length === 0 && migratedBboxes.length > 0) {
    bboxes = migratedBboxes;
  }
  return { rois, bboxes };
}
function readRoisWithMigration(file, videos, tracks, instances) {
  const roisDs = file.get("rois");
  if (!roisDs) return { rois: [], migratedBboxes: [] };
  const roisData = normalizeStructDataset(roisDs);
  const annotationTypes = roisData.annotation_type ?? [];
  if (!annotationTypes.length) return { rois: [], migratedBboxes: [] };
  const wkbDs = file.get("roi_wkb");
  if (!wkbDs) return { rois: [], migratedBboxes: [] };
  const wkbFlat = wkbDs.value instanceof Uint8Array ? wkbDs.value : new Uint8Array(wkbDs.value ?? []);
  const categories = readAttrString(roisDs, "categories");
  const names = readAttrString(roisDs, "names");
  const sources = readAttrString(roisDs, "sources");
  const videoIndices = roisData.video ?? [];
  const frameIndices = roisData.frame_idx ?? [];
  const trackIndices = roisData.track ?? [];
  const scores = roisData.score ?? [];
  const wkbStarts = roisData.wkb_start ?? [];
  const wkbEnds = roisData.wkb_end ?? [];
  const instanceIndices = roisData.instance ?? [];
  const rois = [];
  const migratedBboxes = [];
  for (let i = 0; i < annotationTypes.length; i++) {
    const wkbStart = Number(wkbStarts[i]);
    const wkbEnd = Number(wkbEnds[i]);
    const wkbBytes = wkbFlat.slice(wkbStart, wkbEnd);
    const geometry = decodeWkb(wkbBytes);
    const videoIdx = Number(videoIndices[i]);
    const video = videoIdx >= 0 && videoIdx < videos.length ? videos[videoIdx] : null;
    const frameIdxVal = Number(frameIndices[i]);
    const frameIdx = frameIdxVal === -1 ? null : frameIdxVal;
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const annotType = Number(annotationTypes[i]);
    if (annotType === 1 /* BOUNDING_BOX */) {
      const tmpRoi = new ROI({ geometry, name: names[i] ?? "", category: categories[i] ?? "", source: sources[i] ?? "", video, frameIdx, track });
      const b = tmpRoi.bounds;
      const scoreVal = Number(scores[i]);
      const bboxScore = Number.isNaN(scoreVal) ? null : scoreVal;
      const bboxOptions = {
        xCenter: (b.minX + b.maxX) / 2,
        yCenter: (b.minY + b.maxY) / 2,
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
        video,
        frameIdx,
        track,
        category: categories[i] ?? "",
        name: names[i] ?? "",
        source: sources[i] ?? ""
      };
      if (bboxScore !== null) {
        migratedBboxes.push(new PredictedBoundingBox({ ...bboxOptions, score: bboxScore }));
      } else {
        migratedBboxes.push(new UserBoundingBox(bboxOptions));
      }
    } else {
      const roi = new ROI({
        geometry,
        name: names[i] ?? "",
        category: categories[i] ?? "",
        source: sources[i] ?? "",
        video,
        frameIdx,
        track
      });
      if (instanceIndices.length > 0) {
        const instIdx = Number(instanceIndices[i]);
        if (instances && instIdx >= 0 && instIdx < instances.length) {
          roi.instance = instances[instIdx];
        } else if (instIdx >= 0) {
          roi._instanceIdx = instIdx;
        }
      }
      rois.push(roi);
    }
  }
  return { rois, migratedBboxes };
}
function readBboxes(file, videos, tracks) {
  const bboxesDs = file.get("bboxes");
  if (!bboxesDs) return [];
  const bboxesData = normalizeStructDataset(bboxesDs);
  const xCenters = bboxesData.x_center ?? [];
  if (!xCenters.length) return [];
  const categories = readAttrString(bboxesDs, "categories");
  const names = readAttrString(bboxesDs, "names");
  const sources = readAttrString(bboxesDs, "sources");
  const yCenters = bboxesData.y_center ?? [];
  const widths = bboxesData.width ?? [];
  const heights = bboxesData.height ?? [];
  const angles = bboxesData.angle ?? [];
  const videoIndices = bboxesData.video ?? [];
  const frameIndices = bboxesData.frame_idx ?? [];
  const trackIndices = bboxesData.track ?? [];
  const bboxScores = bboxesData.score ?? [];
  const instanceIndices = bboxesData.instance ?? [];
  const bboxes = [];
  for (let i = 0; i < xCenters.length; i++) {
    const videoIdx = Number(videoIndices[i]);
    const video = videoIdx >= 0 && videoIdx < videos.length ? videos[videoIdx] : null;
    const frameIdxVal = Number(frameIndices[i]);
    const frameIdx = frameIdxVal === -1 ? null : frameIdxVal;
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const scoreVal = Number(bboxScores[i]);
    const instanceIdx = Number(instanceIndices[i]);
    const options = {
      xCenter: Number(xCenters[i]),
      yCenter: Number(yCenters[i]),
      width: Number(widths[i]),
      height: Number(heights[i]),
      angle: Number(angles[i]),
      video,
      frameIdx,
      track,
      category: categories[i] ?? "",
      name: names[i] ?? "",
      source: sources[i] ?? ""
    };
    let bbox;
    if (Number.isNaN(scoreVal)) {
      bbox = new UserBoundingBox(options);
    } else {
      bbox = new PredictedBoundingBox({ ...options, score: scoreVal });
    }
    if (instanceIdx >= 0) {
      bbox._instanceIdx = instanceIdx;
    }
    bboxes.push(bbox);
  }
  return bboxes;
}
function readMasks(file, videos, tracks) {
  const masksDs = file.get("masks");
  if (!masksDs) return [];
  const masksData = normalizeStructDataset(masksDs);
  const heights = masksData.height ?? [];
  if (!heights.length) return [];
  const rleDs = file.get("mask_rle");
  if (!rleDs) return [];
  const rleFlat = rleDs.value instanceof Uint8Array ? rleDs.value : new Uint8Array(rleDs.value ?? []);
  const categories = readAttrString(masksDs, "categories");
  const names = readAttrString(masksDs, "names");
  const sources = readAttrString(masksDs, "sources");
  const widths = masksData.width ?? [];
  const videoIndices = masksData.video ?? [];
  const frameIndices = masksData.frame_idx ?? [];
  const trackIndices = masksData.track ?? [];
  const rleStarts = masksData.rle_start ?? [];
  const rleEnds = masksData.rle_end ?? [];
  const masks = [];
  for (let i = 0; i < heights.length; i++) {
    const rleStart = Number(rleStarts[i]);
    const rleEnd = Number(rleEnds[i]);
    const rleRaw = rleFlat.slice(rleStart, rleEnd);
    const numCounts = rleRaw.byteLength / 4;
    const rleCounts = new Uint32Array(numCounts);
    const rleView = new DataView(rleRaw.buffer, rleRaw.byteOffset, rleRaw.byteLength);
    for (let j = 0; j < numCounts; j++) {
      rleCounts[j] = rleView.getUint32(j * 4, true);
    }
    const videoIdx = Number(videoIndices[i]);
    const video = videoIdx >= 0 && videoIdx < videos.length ? videos[videoIdx] : null;
    const frameIdxVal = Number(frameIndices[i]);
    const frameIdx = frameIdxVal === -1 ? null : frameIdxVal;
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    masks.push(new SegmentationMask({
      rleCounts,
      height: Number(heights[i]),
      width: Number(widths[i]),
      name: names[i] ?? "",
      category: categories[i] ?? "",
      source: sources[i] ?? "",
      video,
      frameIdx,
      track
    }));
  }
  return masks;
}
function normalizeStructDataset(dataset) {
  if (!dataset) return {};
  const raw = dataset.value;
  if (!raw) return {};
  const fieldNames = getFieldNames(dataset);
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    return mapStructuredRows(raw, fieldNames);
  }
  if (raw && ArrayBuffer.isView(raw) && Array.isArray(dataset.shape) && dataset.shape.length === 2) {
    const [rowCount, colCount] = dataset.shape;
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) {
      const start = i * colCount;
      const end = start + colCount;
      const slice = Array.from(raw.slice(start, end));
      rows.push(slice);
    }
    return mapStructuredRows(rows, fieldNames);
  }
  if (raw && typeof raw === "object") {
    return raw;
  }
  return {};
}
function mapStructuredRows(rows, fieldNames) {
  if (!fieldNames.length) {
    return rows.reduce((acc, row, idx) => {
      acc[String(idx)] = row;
      return acc;
    }, {});
  }
  const data = {};
  fieldNames.forEach((field, idx) => {
    data[field] = rows.map((row) => row[idx]);
  });
  return data;
}
function getFieldNames(dataset) {
  const fields = dataset.dtype?.fields ? Object.keys(dataset.dtype.fields) : [];
  if (fields.length) return fields;
  const compoundMembers = dataset.metadata?.compound_type?.members;
  if (Array.isArray(compoundMembers) && compoundMembers.length) {
    const names = compoundMembers.map((member) => member.name).filter((name) => !!name);
    if (names.length) return names;
  }
  const attr = dataset.attrs?.field_names ?? dataset.attrs?.fieldNames;
  if (!attr) return [];
  const value = attr.value ?? attr;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  if (value instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(textDecoder.decode(value));
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      return [];
    }
  }
  return [];
}
function buildLabeledFrames2(options) {
  const frames = [];
  const { framesData, instancesData, pointsData, predPointsData, skeletons, tracks, videos, formatId } = options;
  const frameIds = framesData.frame_id ?? [];
  const videoIdToIndex = buildVideoIdMap2(framesData, videos);
  const instanceById = /* @__PURE__ */ new Map();
  const fromPredictedPairs = [];
  for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
    const rawVideoId = Number(framesData.video?.[frameIdx] ?? 0);
    const videoIndex = videoIdToIndex.get(rawVideoId) ?? rawVideoId;
    const frameIndex = Number(framesData.frame_idx?.[frameIdx] ?? 0);
    const instStart = Number(framesData.instance_id_start?.[frameIdx] ?? 0);
    const instEnd = Number(framesData.instance_id_end?.[frameIdx] ?? 0);
    const video = videos[videoIndex];
    if (!video) continue;
    const instances = [];
    for (let instIdx = instStart; instIdx < instEnd; instIdx += 1) {
      const instanceType = Number(instancesData.instance_type?.[instIdx] ?? 0);
      const skeletonId = Number(instancesData.skeleton?.[instIdx] ?? 0);
      const trackId = Number(instancesData.track?.[instIdx] ?? -1);
      const pointStart = Number(instancesData.point_id_start?.[instIdx] ?? 0);
      const pointEnd = Number(instancesData.point_id_end?.[instIdx] ?? 0);
      const score = Number(instancesData.score?.[instIdx] ?? 0);
      const rawTrackingScore = formatId < 1.2 ? 0 : Number(instancesData.tracking_score?.[instIdx] ?? 0);
      const trackingScore = Number.isNaN(rawTrackingScore) ? 0 : rawTrackingScore;
      const fromPredicted = Number(instancesData.from_predicted?.[instIdx] ?? -1);
      const skeleton = skeletons[skeletonId] ?? skeletons[0];
      const track = trackId >= 0 ? tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        const points = slicePoints2(pointsData, pointStart, pointEnd);
        instance = new Instance({ points: pointsFromArray(points, skeleton.nodeNames), skeleton, track, trackingScore });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        const points = slicePoints2(predPointsData, pointStart, pointEnd, true);
        instance = new PredictedInstance({ points: predictedPointsFromArray(points, skeleton.nodeNames), skeleton, track, score, trackingScore });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
      }
      instanceById.set(instIdx, instance);
      instances.push(instance);
    }
    frames.push(new LabeledFrame({ video, frameIdx: frameIndex, instances }));
  }
  for (const [instanceId, fromPredictedId] of fromPredictedPairs) {
    const instance = instanceById.get(instanceId);
    const predicted = instanceById.get(fromPredictedId);
    if (instance && predicted instanceof PredictedInstance && instance instanceof Instance) {
      instance.fromPredicted = predicted;
    }
  }
  return frames;
}
function buildVideoIdMap2(framesData, videos) {
  const videoIds = /* @__PURE__ */ new Set();
  for (const value of framesData.video ?? []) {
    videoIds.add(Number(value));
  }
  if (!videoIds.size) return /* @__PURE__ */ new Map();
  const maxId = Math.max(...Array.from(videoIds));
  if (videoIds.size === videos.length && maxId === videos.length - 1) {
    const identity = /* @__PURE__ */ new Map();
    for (let i = 0; i < videos.length; i += 1) {
      identity.set(i, i);
    }
    return identity;
  }
  const map = /* @__PURE__ */ new Map();
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const dataset = video.backend?.dataset ?? video.backendMetadata?.dataset ?? "";
    const parsedId = parseVideoIdFromDataset2(dataset);
    if (parsedId != null) {
      map.set(parsedId, index);
    }
  }
  return map;
}
function parseVideoIdFromDataset2(dataset) {
  if (!dataset) return null;
  const group = dataset.split("/")[0];
  if (!group.startsWith("video")) return null;
  const id = Number(group.slice(5));
  return Number.isNaN(id) ? null : id;
}
function slicePoints2(data, start, end, predicted = false) {
  const xs = data.x ?? [];
  const ys = data.y ?? [];
  const visible = data.visible ?? [];
  const complete = data.complete ?? [];
  const scores = data.score ?? [];
  const points = [];
  for (let i = start; i < end; i += 1) {
    if (predicted) {
      points.push([xs[i], ys[i], scores[i], visible[i], complete[i]]);
    } else {
      points.push([xs[i], ys[i], visible[i], complete[i]]);
    }
  }
  return points;
}

// src/io/main.ts
function isNode() {
  return typeof process !== "undefined" && !!process.versions?.node;
}
function isBrowserWithWorkerSupport() {
  return typeof window !== "undefined" && isStreamingSupported();
}
async function loadSlp(source, options) {
  const streamMode = options?.h5?.stream ?? "auto";
  const openVideos = options?.openVideos ?? true;
  const lazy = options?.lazy ?? false;
  if (isBrowserWithWorkerSupport() && !isNode() && streamMode !== "download") {
    let streamingSource;
    if (typeof source === "string") {
      streamingSource = source;
    } else if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
      streamingSource = source;
    } else if (typeof File !== "undefined" && source instanceof File) {
      streamingSource = source;
    } else if (typeof FileSystemFileHandle !== "undefined" && "getFile" in source) {
      streamingSource = await source.getFile();
    } else {
      streamingSource = null;
    }
    if (streamingSource !== null) {
      try {
        return await readSlpStreaming(streamingSource, {
          filenameHint: options?.h5?.filenameHint,
          openVideos
        });
      } catch (e) {
        if (streamMode === "auto") {
          console.warn("[sleap-io] Worker-based loading failed, falling back to main thread:", e);
        } else {
          throw e;
        }
      }
    }
  }
  if (lazy) {
    return readSlpLazy(source, { openVideos, h5: options?.h5 });
  }
  return readSlp(source, { openVideos, h5: options?.h5 });
}
async function saveSlp(labels, filename, options) {
  await writeSlp(filename, labels, {
    embed: options?.embed ?? false,
    restoreOriginalVideos: options?.restoreOriginalVideos ?? true
  });
}
async function loadSlpSet(sources, options) {
  const set = new LabelsSet();
  if (Array.isArray(sources)) {
    const results = await Promise.all(sources.map((src) => loadSlp(src, options)));
    for (let i = 0; i < sources.length; i++) {
      set.set(sources[i], results[i]);
    }
  } else {
    const entries = Object.entries(sources);
    const results = await Promise.all(entries.map(([, src]) => loadSlp(src, options)));
    for (let i = 0; i < entries.length; i++) {
      set.set(entries[i][0], results[i]);
    }
  }
  return set;
}
async function saveSlpSet(labelsSet, options) {
  const promises = [];
  for (const [filename, labels] of labelsSet) {
    promises.push(saveSlp(labels, filename, options));
  }
  await Promise.all(promises);
}
async function loadVideo(source, options) {
  const filename = typeof source === "string" ? source : source.name;
  const backend = await createVideoBackend(source, {
    dataset: options?.dataset,
    backend: options?.backend
  });
  return new Video({ filename, backend, openBackend: options?.openBackend ?? true });
}

// src/io/geojson.ts
function roisToGeoJSON(rois) {
  return {
    type: "FeatureCollection",
    features: rois.map((roi) => roi.toGeoJSON())
  };
}
function roisFromGeoJSON(geojson) {
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  return features.map((feature) => {
    const props = feature.properties ?? {};
    return new ROI({
      geometry: feature.geometry,
      name: String(props.name ?? ""),
      category: String(props.category ?? ""),
      source: String(props.source ?? ""),
      frameIdx: typeof props.frame_idx === "number" ? props.frame_idx : null
    });
  });
}
function writeGeoJSON(rois) {
  return JSON.stringify(roisToGeoJSON(rois), null, 2);
}
function readGeoJSON(json) {
  return roisFromGeoJSON(JSON.parse(json));
}

// src/codecs/skeleton-yaml.ts
import YAML from "yaml";
function getNodeName(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.name === "string") return entry.name;
  throw new Error("Invalid node entry in skeleton YAML.");
}
function resolveName(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.name === "string") return value.name;
  throw new Error("Invalid name reference in skeleton YAML.");
}
function decodeSkeleton(data, fallbackName) {
  if (!data?.nodes) throw new Error("Skeleton YAML missing nodes.");
  const nodes = data.nodes.map((entry) => new Node(getNodeName(entry)));
  const edges = (data.edges ?? []).map((edge) => {
    if (Array.isArray(edge)) {
      const [source2, destination] = edge;
      return new Edge(nodes[Number(source2)], nodes[Number(destination)]);
    }
    const sourceName = resolveName(edge.source);
    const destName = resolveName(edge.destination);
    const source = nodes.find((node) => node.name === sourceName);
    const dest = nodes.find((node) => node.name === destName);
    if (!source || !dest) throw new Error("Edge references unknown node.");
    return new Edge(source, dest);
  });
  const symmetries = (data.symmetries ?? []).map((symmetry) => {
    if (!Array.isArray(symmetry) || symmetry.length !== 2) {
      throw new Error("Symmetry must contain exactly 2 nodes.");
    }
    const [left, right] = symmetry;
    const leftName = resolveName(left);
    const rightName = resolveName(right);
    const leftNode = nodes.find((node) => node.name === leftName);
    const rightNode = nodes.find((node) => node.name === rightName);
    if (!leftNode || !rightNode) throw new Error("Symmetry references unknown node.");
    return new Symmetry([leftNode, rightNode]);
  });
  return new Skeleton({
    name: data.name ?? fallbackName,
    nodes,
    edges,
    symmetries
  });
}
function decodeYamlSkeleton(yamlData) {
  const parsed = YAML.parse(yamlData);
  if (!parsed) throw new Error("Empty skeleton YAML.");
  if (Object.prototype.hasOwnProperty.call(parsed, "nodes")) {
    return decodeSkeleton(parsed);
  }
  return Object.entries(parsed).map(
    ([name, skeletonData]) => decodeSkeleton(skeletonData, name)
  );
}
function encodeYamlSkeleton(skeletons) {
  const list = Array.isArray(skeletons) ? skeletons : [skeletons];
  const payload = {};
  list.forEach((skeleton, index) => {
    const name = skeleton.name ?? `Skeleton-${index}`;
    const nodes = skeleton.nodes.map((node) => ({ name: node.name }));
    const edges = skeleton.edges.map((edge) => ({
      source: { name: edge.source.name },
      destination: { name: edge.destination.name }
    }));
    const symmetries = skeleton.symmetries.map((symmetry) => {
      const pair = Array.from(symmetry.nodes);
      return [{ name: pair[0].name }, { name: pair[1].name }];
    });
    payload[name] = { nodes, edges, symmetries };
  });
  return YAML.stringify(payload);
}

// src/codecs/skeleton-json.ts
function readSkeletonJson(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const globalRegistry = /* @__PURE__ */ new Map();
  let globalCounter = 0;
  const usesSharedNodeRefs = data.links.some(
    (link) => link.source["py/id"] !== void 0 || link.target["py/id"] !== void 0
  );
  const edgeTypeRegistry = /* @__PURE__ */ new Map();
  let edgeTypeCounter = 0;
  function resolveNode(obj) {
    if (obj["py/object"]) {
      const name = obj["py/state"]["py/tuple"][0];
      if (usesSharedNodeRefs) {
        globalCounter += 1;
        globalRegistry.set(globalCounter, name);
      }
      return name;
    }
    if (obj["py/id"] !== void 0) {
      return globalRegistry.get(obj["py/id"]);
    }
    throw new Error("Cannot resolve jsonpickle node reference");
  }
  function resolveEdgeTypeValue(obj) {
    if (obj["py/reduce"]) {
      const value = obj["py/reduce"][1]["py/tuple"][0];
      if (usesSharedNodeRefs) {
        globalCounter += 1;
        globalRegistry.set(globalCounter, value);
      } else {
        edgeTypeCounter += 1;
        edgeTypeRegistry.set(edgeTypeCounter, value);
      }
      return value;
    }
    if (obj["py/id"] !== void 0) {
      if (usesSharedNodeRefs) {
        return globalRegistry.get(obj["py/id"]);
      }
      return edgeTypeRegistry.get(obj["py/id"]);
    }
    return 1;
  }
  const edgePairs = [];
  const symmetryPairs = [];
  const allNodeNames = [];
  const nodeNameSet = /* @__PURE__ */ new Set();
  for (const link of data.links) {
    const sourceName = resolveNode(link.source);
    const targetName = resolveNode(link.target);
    const edgeType = resolveEdgeTypeValue(link.type);
    if (!nodeNameSet.has(sourceName)) {
      nodeNameSet.add(sourceName);
      allNodeNames.push(sourceName);
    }
    if (!nodeNameSet.has(targetName)) {
      nodeNameSet.add(targetName);
      allNodeNames.push(targetName);
    }
    if (edgeType === 1) {
      edgePairs.push([sourceName, targetName]);
    } else if (edgeType === 2) {
      symmetryPairs.push([sourceName, targetName]);
    }
  }
  let nodeNames;
  if (usesSharedNodeRefs && data.nodes.length > 0) {
    const orderedNames = [];
    for (const nodeEntry of data.nodes) {
      const nodeObj = nodeEntry.id;
      if (nodeObj["py/object"]) {
        globalCounter += 1;
        const name = nodeObj["py/state"]["py/tuple"][0];
        globalRegistry.set(globalCounter, name);
        orderedNames.push(name);
      } else if (nodeObj["py/id"] !== void 0) {
        const resolved = globalRegistry.get(nodeObj["py/id"]);
        if (typeof resolved === "string") {
          orderedNames.push(resolved);
        }
      }
    }
    nodeNames = orderedNames.length === nodeNameSet.size ? orderedNames : allNodeNames;
  } else {
    for (const nodeEntry of data.nodes) {
      const nodeObj = nodeEntry.id;
      if (nodeObj["py/object"]) {
        const name = nodeObj["py/state"]["py/tuple"][0];
        if (!nodeNameSet.has(name)) {
          nodeNameSet.add(name);
          allNodeNames.push(name);
        }
      }
    }
    nodeNames = allNodeNames;
  }
  const nodes = nodeNames.map((name) => new Node(name));
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const edges = edgePairs.map(
    ([src, dst]) => new Edge(nodeMap.get(src), nodeMap.get(dst))
  );
  const seenSymmetries = /* @__PURE__ */ new Set();
  const symmetries = [];
  for (const [a, b] of symmetryPairs) {
    const key = [a, b].sort().join("\0");
    if (!seenSymmetries.has(key)) {
      seenSymmetries.add(key);
      symmetries.push(new Symmetry([nodeMap.get(a), nodeMap.get(b)]));
    }
  }
  return new Skeleton({ nodes, edges, symmetries, name: data.graph?.name });
}

// src/codecs/training-config.ts
function readTrainingConfigSkeletons(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const dataSection = data.data;
  const labels = dataSection?.labels;
  const skeletonsList = labels?.skeletons;
  if (!skeletonsList || !skeletonsList.length) {
    throw new Error("No skeletons found in training config");
  }
  return skeletonsList.map((skeletonData) => readSkeletonJson(skeletonData));
}
function readTrainingConfigSkeleton(json) {
  const skeletons = readTrainingConfigSkeletons(json);
  return skeletons[0];
}
function isTrainingConfig(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  return !!(data.data && data.data.labels);
}

// src/rendering/colors.ts
var NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  brown: [139, 69, 19]
};
var PALETTES = {
  // MATLAB default colors
  standard: [
    [0, 114, 189],
    [217, 83, 25],
    [237, 177, 32],
    [126, 47, 142],
    [119, 172, 48],
    [77, 190, 238],
    [162, 20, 47]
  ],
  // Tableau 10
  tableau10: [
    [31, 119, 180],
    [255, 127, 14],
    [44, 160, 44],
    [214, 39, 40],
    [148, 103, 189],
    [140, 86, 75],
    [227, 119, 194],
    [127, 127, 127],
    [188, 189, 34],
    [23, 190, 207]
  ],
  // High-contrast distinct colors (Glasbey-inspired, for many instances)
  distinct: [
    [230, 25, 75],
    [60, 180, 75],
    [255, 225, 25],
    [67, 99, 216],
    [245, 130, 49],
    [145, 30, 180],
    [66, 212, 244],
    [240, 50, 230],
    [191, 239, 69],
    [250, 190, 212],
    [70, 153, 144],
    [220, 190, 255],
    [154, 99, 36],
    [255, 250, 200],
    [128, 0, 0],
    [170, 255, 195],
    [128, 128, 0],
    [255, 216, 177],
    [0, 0, 117],
    [169, 169, 169]
  ],
  // Viridis (10 samples)
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [181, 222, 43],
    [253, 231, 37]
  ],
  // Rainbow for node coloring
  rainbow: [
    [255, 0, 0],
    [255, 127, 0],
    [255, 255, 0],
    [127, 255, 0],
    [0, 255, 0],
    [0, 255, 127],
    [0, 255, 255],
    [0, 127, 255],
    [0, 0, 255],
    [127, 0, 255],
    [255, 0, 255],
    [255, 0, 127]
  ],
  // Warm colors
  warm: [
    [255, 89, 94],
    [255, 146, 76],
    [255, 202, 58],
    [255, 154, 0],
    [255, 97, 56],
    [255, 50, 50]
  ],
  // Cool colors
  cool: [
    [67, 170, 139],
    [77, 144, 142],
    [87, 117, 144],
    [97, 90, 147],
    [107, 63, 149],
    [117, 36, 152]
  ],
  // Pastel colors
  pastel: [
    [255, 179, 186],
    [255, 223, 186],
    [255, 255, 186],
    [186, 255, 201],
    [186, 225, 255],
    [219, 186, 255]
  ],
  // Seaborn-inspired
  seaborn: [
    [76, 114, 176],
    [221, 132, 82],
    [85, 168, 104],
    [196, 78, 82],
    [129, 114, 179],
    [147, 120, 96],
    [218, 139, 195],
    [140, 140, 140],
    [204, 185, 116],
    [100, 181, 205]
  ]
};
function getPalette(name, n) {
  const palette = PALETTES[name];
  if (!palette) {
    throw new Error(`Unknown palette: ${name}`);
  }
  if (n <= palette.length) {
    return palette.slice(0, n);
  }
  return Array.from({ length: n }, (_, i) => palette[i % palette.length]);
}
function resolveColor(color) {
  if (Array.isArray(color)) {
    if (color.length >= 3) {
      return [color[0], color[1], color[2]];
    }
    throw new Error(`Invalid color array: ${color}`);
  }
  if (typeof color === "number") {
    const v = Math.round(color);
    return [v, v, v];
  }
  if (typeof color === "string") {
    const s = color.trim().toLowerCase();
    if (s in NAMED_COLORS) {
      return NAMED_COLORS[s];
    }
    if (s.startsWith("#")) {
      return hexToRgb(s);
    }
    const paletteMatch = s.match(/^(\w+)\[(\d+)\]$/);
    if (paletteMatch) {
      const [, paletteName, indexStr] = paletteMatch;
      const palette = PALETTES[paletteName];
      if (palette) {
        const index = parseInt(indexStr, 10) % palette.length;
        return palette[index];
      }
    }
    const rgbMatch = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgbMatch) {
      return [
        parseInt(rgbMatch[1], 10),
        parseInt(rgbMatch[2], 10),
        parseInt(rgbMatch[3], 10)
      ];
    }
  }
  throw new Error(`Cannot resolve color: ${color}`);
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ];
  }
  if (h.length === 6) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }
  throw new Error(`Invalid hex color: ${hex}`);
}
function rgbToCSS(rgb, alpha = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
function determineColorScheme(scheme, hasTracks, isSingleImage) {
  if (scheme !== "auto") {
    return scheme;
  }
  if (hasTracks) {
    return "track";
  }
  if (isSingleImage) {
    return "instance";
  }
  return "node";
}

// src/rendering/shapes.ts
function drawCircle(ctx, x, y, size, fillColor, edgeColor, edgeWidth = 1) {
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.stroke();
  }
}
function drawSquare(ctx, x, y, size, fillColor, edgeColor, edgeWidth = 1) {
  const half = size;
  ctx.fillStyle = fillColor;
  ctx.fillRect(x - half, y - half, half * 2, half * 2);
  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.strokeRect(x - half, y - half, half * 2, half * 2);
  }
}
function drawDiamond(ctx, x, y, size, fillColor, edgeColor, edgeWidth = 1) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.stroke();
  }
}
function drawTriangle(ctx, x, y, size, fillColor, edgeColor, edgeWidth = 1) {
  const h = size * 0.866;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y + h);
  ctx.lineTo(x - size, y + h);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = edgeWidth;
    ctx.stroke();
  }
}
function drawCross(ctx, x, y, size, fillColor, _edgeColor, edgeWidth = 2) {
  ctx.strokeStyle = fillColor;
  ctx.lineWidth = edgeWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.stroke();
}
var MARKER_FUNCTIONS = {
  circle: drawCircle,
  square: drawSquare,
  diamond: drawDiamond,
  triangle: drawTriangle,
  cross: drawCross
};
function getMarkerFunction(shape) {
  return MARKER_FUNCTIONS[shape];
}

// src/rendering/context.ts
var RenderContext = class {
  constructor(canvas, frameIdx, frameSize, instances, skeletonEdges, nodeNames, scale = 1, offset = [0, 0]) {
    this.canvas = canvas;
    this.frameIdx = frameIdx;
    this.frameSize = frameSize;
    this.instances = instances;
    this.skeletonEdges = skeletonEdges;
    this.nodeNames = nodeNames;
    this.scale = scale;
    this.offset = offset;
  }
  /**
   * Transform world coordinates to canvas coordinates.
   */
  worldToCanvas(x, y) {
    return [
      (x - this.offset[0]) * this.scale,
      (y - this.offset[1]) * this.scale
    ];
  }
};
var InstanceContext = class {
  constructor(canvas, instanceIdx, points, skeletonEdges, nodeNames, trackIdx = null, trackName = null, confidence = null, scale = 1, offset = [0, 0]) {
    this.canvas = canvas;
    this.instanceIdx = instanceIdx;
    this.points = points;
    this.skeletonEdges = skeletonEdges;
    this.nodeNames = nodeNames;
    this.trackIdx = trackIdx;
    this.trackName = trackName;
    this.confidence = confidence;
    this.scale = scale;
    this.offset = offset;
  }
  /**
   * Transform world coordinates to canvas coordinates.
   */
  worldToCanvas(x, y) {
    return [
      (x - this.offset[0]) * this.scale,
      (y - this.offset[1]) * this.scale
    ];
  }
  /**
   * Get centroid of valid (non-NaN) points.
   */
  getCentroid() {
    let sumX = 0, sumY = 0, count = 0;
    for (const pt of this.points) {
      const x = pt[0];
      const y = pt[1];
      if (!isNaN(x) && !isNaN(y)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
    if (count === 0) return null;
    return [sumX / count, sumY / count];
  }
  /**
   * Get bounding box of valid points.
   * Returns [x1, y1, x2, y2] or null if no valid points.
   */
  getBbox() {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    let hasValid = false;
    for (const pt of this.points) {
      const x = pt[0];
      const y = pt[1];
      if (!isNaN(x) && !isNaN(y)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hasValid = true;
      }
    }
    if (!hasValid) return null;
    return [minX, minY, maxX, maxY];
  }
};

export {
  LabeledFrame,
  Video,
  SuggestionFrame,
  MediaBunnyVideoBackend,
  toDict,
  fromDict,
  toNumpy,
  fromNumpy,
  labelsFromNumpy,
  Labels,
  LabelsSet,
  rodriguesTransformation,
  Camera,
  CameraGroup,
  InstanceGroup,
  FrameGroup,
  RecordingSession,
  makeCameraFromDict,
  Identity,
  Instance3D,
  PredictedInstance3D,
  LazyDataStore,
  LazyFrameList,
  _registerMaskFactory,
  AnnotationType,
  ROI,
  rasterizeGeometry,
  encodeWkb,
  decodeWkb,
  encodeRle,
  decodeRle,
  SegmentationMask,
  BoundingBox,
  UserBoundingBox,
  PredictedBoundingBox,
  Mp4BoxVideoBackend,
  StreamingHdf5VideoBackend,
  StreamingH5File,
  isStreamingSupported,
  openStreamingH5,
  openH5Worker,
  _registerNodeH5,
  createVideoBackend,
  readSlpStreaming,
  _registerFileWriter,
  saveSlpToBytes,
  loadSlp,
  saveSlp,
  loadSlpSet,
  saveSlpSet,
  loadVideo,
  roisToGeoJSON,
  roisFromGeoJSON,
  writeGeoJSON,
  readGeoJSON,
  decodeYamlSkeleton,
  encodeYamlSkeleton,
  readSkeletonJson,
  readTrainingConfigSkeletons,
  readTrainingConfigSkeleton,
  isTrainingConfig,
  NAMED_COLORS,
  PALETTES,
  getPalette,
  resolveColor,
  rgbToCSS,
  determineColorScheme,
  drawCircle,
  drawSquare,
  drawDiamond,
  drawTriangle,
  drawCross,
  MARKER_FUNCTIONS,
  getMarkerFunction,
  RenderContext,
  InstanceContext
};
