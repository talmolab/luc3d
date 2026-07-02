// src/model/instance.ts
var Track = class {
  name;
  constructor(name) {
    this.name = name;
  }
};
function pointsEmpty(length, names) {
  const pts = [];
  for (let i = 0; i < length; i += 1) {
    pts.push({
      xy: [Number.NaN, Number.NaN],
      visible: false,
      complete: false,
      name: names?.[i]
    });
  }
  return pts;
}
function predictedPointsEmpty(length, names) {
  const pts = [];
  for (let i = 0; i < length; i += 1) {
    pts.push({
      xy: [Number.NaN, Number.NaN],
      visible: false,
      complete: false,
      score: Number.NaN,
      name: names?.[i]
    });
  }
  return pts;
}
function pointsFromArray(array, names) {
  const pts = [];
  for (let i = 0; i < array.length; i += 1) {
    const row = array[i] ?? [Number.NaN, Number.NaN];
    const visible = row.length > 2 ? Boolean(row[2]) : !Number.isNaN(row[0]);
    const complete = row.length > 3 ? Boolean(row[3]) : false;
    pts.push({ xy: [row[0] ?? Number.NaN, row[1] ?? Number.NaN], visible, complete, name: names?.[i] });
  }
  return pts;
}
function predictedPointsFromArray(array, names) {
  const pts = [];
  for (let i = 0; i < array.length; i += 1) {
    const row = array[i] ?? [Number.NaN, Number.NaN, Number.NaN];
    const visible = row.length > 3 ? Boolean(row[3]) : !Number.isNaN(row[0]);
    const complete = row.length > 4 ? Boolean(row[4]) : false;
    pts.push({
      xy: [row[0] ?? Number.NaN, row[1] ?? Number.NaN],
      score: row[2] ?? Number.NaN,
      visible,
      complete,
      name: names?.[i]
    });
  }
  return pts;
}
var Instance = class _Instance {
  points;
  skeleton;
  track;
  fromPredicted;
  trackingScore;
  constructor(options) {
    this.skeleton = options.skeleton;
    this.track = options.track ?? null;
    this.fromPredicted = options.fromPredicted ?? null;
    this.trackingScore = options.trackingScore ?? 0;
    if (Array.isArray(options.points)) {
      this.points = options.points;
    } else {
      this.points = pointsFromDict(options.points, options.skeleton);
    }
  }
  static fromArray(points, skeleton) {
    return new _Instance({ points: pointsFromArray(points, skeleton.nodeNames), skeleton });
  }
  static fromNumpy(options) {
    return new _Instance({
      points: pointsFromArray(options.pointsData, options.skeleton.nodeNames),
      skeleton: options.skeleton,
      track: options.track ?? null,
      fromPredicted: options.fromPredicted ?? null,
      trackingScore: options.trackingScore
    });
  }
  static empty(options) {
    return new _Instance({ points: pointsEmpty(options.skeleton.nodeNames.length, options.skeleton.nodeNames), skeleton: options.skeleton });
  }
  get length() {
    return this.points.length;
  }
  get nVisible() {
    return this.points.filter((point) => point.visible).length;
  }
  getPoint(target) {
    if (typeof target === "number") {
      if (target < 0 || target >= this.points.length) throw new Error("Point index out of range.");
      return this.points[target];
    }
    if (typeof target === "string") {
      const index2 = this.skeleton.index(target);
      return this.points[index2];
    }
    const index = this.skeleton.index(target.name);
    return this.points[index];
  }
  numpy(options) {
    const invisibleAsNaN = options?.invisibleAsNaN ?? true;
    return this.points.map((point) => {
      if (invisibleAsNaN && !point.visible) {
        return [Number.NaN, Number.NaN];
      }
      return [point.xy[0], point.xy[1]];
    });
  }
  toString() {
    const trackName = this.track ? `"${this.track.name}"` : "None";
    return `Instance(points=${JSON.stringify(this.numpy({ invisibleAsNaN: false }))}, track=${trackName})`;
  }
  get isEmpty() {
    return this.points.every((point) => !point.visible || Number.isNaN(point.xy[0]));
  }
  overlapsWith(other, iouThreshold = 0.1) {
    const boxA = this.boundingBox();
    const boxB = other.boundingBox();
    if (!boxA || !boxB) return false;
    const iou = intersectionOverUnion(boxA, boxB);
    return iou >= iouThreshold;
  }
  boundingBox() {
    const xs = [];
    const ys = [];
    for (const point of this.points) {
      if (Number.isNaN(point.xy[0]) || Number.isNaN(point.xy[1])) continue;
      xs.push(point.xy[0]);
      ys.push(point.xy[1]);
    }
    if (!xs.length || !ys.length) return null;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return [minX, minY, maxX, maxY];
  }
};
var PredictedInstance = class _PredictedInstance extends Instance {
  score;
  constructor(options) {
    const { score = 0, ...rest } = options;
    const pts = Array.isArray(rest.points) ? rest.points : predictedPointsFromDict(rest.points, rest.skeleton);
    super({
      points: pts,
      skeleton: rest.skeleton,
      track: rest.track,
      trackingScore: rest.trackingScore
    });
    this.score = score;
  }
  static fromArray(points, skeleton, score) {
    return new _PredictedInstance({
      points: predictedPointsFromArray(points, skeleton.nodeNames),
      skeleton,
      score
    });
  }
  static fromNumpy(options) {
    return new _PredictedInstance({
      points: predictedPointsFromArray(options.pointsData, options.skeleton.nodeNames),
      skeleton: options.skeleton,
      track: options.track ?? null,
      score: options.score,
      trackingScore: options.trackingScore
    });
  }
  static empty(options) {
    return new _PredictedInstance({ points: predictedPointsEmpty(options.skeleton.nodeNames.length, options.skeleton.nodeNames), skeleton: options.skeleton });
  }
  numpy(options) {
    const invisibleAsNaN = options?.invisibleAsNaN ?? true;
    return this.points.map((point) => {
      const xy = invisibleAsNaN && !point.visible ? [Number.NaN, Number.NaN] : [point.xy[0], point.xy[1]];
      if (options?.scores) {
        return [xy[0], xy[1], point.score ?? 0];
      }
      return xy;
    });
  }
  toString() {
    const trackName = this.track ? `"${this.track.name}"` : "None";
    return `PredictedInstance(points=${JSON.stringify(this.numpy({ invisibleAsNaN: false }))}, track=${trackName}, score=${this.score.toFixed(2)}, tracking_score=${this.trackingScore ?? "None"})`;
  }
};
function pointsFromDict(pointsDict, skeleton) {
  const points = pointsEmpty(skeleton.nodeNames.length, skeleton.nodeNames);
  for (const [nodeName, data] of Object.entries(pointsDict)) {
    const index = skeleton.index(nodeName);
    points[index] = {
      xy: [data[0] ?? Number.NaN, data[1] ?? Number.NaN],
      visible: data.length > 2 ? Boolean(data[2]) : !Number.isNaN(data[0]),
      complete: data.length > 3 ? Boolean(data[3]) : false,
      name: nodeName
    };
  }
  return points;
}
function predictedPointsFromDict(pointsDict, skeleton) {
  const points = predictedPointsEmpty(skeleton.nodeNames.length, skeleton.nodeNames);
  for (const [nodeName, data] of Object.entries(pointsDict)) {
    const index = skeleton.index(nodeName);
    points[index] = {
      xy: [data[0] ?? Number.NaN, data[1] ?? Number.NaN],
      score: data[2] ?? Number.NaN,
      visible: data.length > 3 ? Boolean(data[3]) : !Number.isNaN(data[0]),
      complete: data.length > 4 ? Boolean(data[4]) : false,
      name: nodeName
    };
  }
  return points;
}
function intersectionOverUnion(boxA, boxB) {
  const [ax1, ay1, ax2, ay2] = boxA;
  const [bx1, by1, bx2, by2] = boxB;
  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);
  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
  const union = areaA + areaB - interArea;
  if (union === 0) return 0;
  return interArea / union;
}

// src/model/skeleton.ts
var Node = class {
  name;
  constructor(name) {
    this.name = name;
  }
};
var Edge = class {
  source;
  destination;
  constructor(source, destination) {
    this.source = source;
    this.destination = destination;
  }
  at(index) {
    if (index === 0) return this.source;
    if (index === 1) return this.destination;
    throw new Error("Edge only has 2 nodes (source and destination).");
  }
};
var Symmetry = class {
  nodes;
  constructor(nodes) {
    const set = new Set(nodes);
    if (set.size !== 2) {
      throw new Error("Symmetry must contain exactly 2 nodes.");
    }
    this.nodes = set;
  }
  at(index) {
    let i = 0;
    for (const node of this.nodes) {
      if (i === index) return node;
      i += 1;
    }
    throw new Error("Symmetry index out of range.");
  }
};
var Skeleton = class {
  nodes;
  edges;
  symmetries;
  name;
  nameToNode;
  nodeToIndex;
  constructor(options) {
    const resolved = Array.isArray(options) ? { nodes: options } : options;
    this.nodes = resolved.nodes.map((node) => typeof node === "string" ? new Node(node) : node);
    this.edges = [];
    this.symmetries = [];
    this.name = resolved.name;
    this.nameToNode = /* @__PURE__ */ new Map();
    this.nodeToIndex = /* @__PURE__ */ new Map();
    this.rebuildCache();
    if (resolved.edges) {
      this.edges = resolved.edges.map((edge) => edge instanceof Edge ? edge : this.edgeFrom(edge));
    }
    if (resolved.symmetries) {
      this.symmetries = resolved.symmetries.map(
        (symmetry) => symmetry instanceof Symmetry ? symmetry : this.symmetryFrom(symmetry)
      );
    }
  }
  rebuildCache(nodes = this.nodes) {
    this.nameToNode = new Map(nodes.map((node) => [node.name, node]));
    this.nodeToIndex = new Map(nodes.map((node, index) => [node, index]));
  }
  get nodeNames() {
    return this.nodes.map((node) => node.name);
  }
  index(node) {
    if (typeof node === "number") return node;
    if (typeof node === "string") {
      const found = this.nameToNode.get(node);
      if (!found) throw new Error(`Node '${node}' not found in skeleton.`);
      return this.nodeToIndex.get(found) ?? -1;
    }
    const idx = this.nodeToIndex.get(node);
    if (idx === void 0) throw new Error("Node not found in skeleton.");
    return idx;
  }
  node(node) {
    if (node instanceof Node) return node;
    if (typeof node === "number") return this.nodes[node];
    const found = this.nameToNode.get(node);
    if (!found) throw new Error(`Node '${node}' not found in skeleton.`);
    return found;
  }
  get edgeIndices() {
    return this.edges.map((edge) => [this.index(edge.source), this.index(edge.destination)]);
  }
  get symmetryNames() {
    return this.symmetries.map((symmetry) => {
      const nodes = Array.from(symmetry.nodes).map((node) => node.name);
      return [nodes[0], nodes[1]];
    });
  }
  matches(other) {
    if (this.nodeNames.length !== other.nodeNames.length) return false;
    for (let i = 0; i < this.nodeNames.length; i += 1) {
      if (this.nodeNames[i] !== other.nodeNames[i]) return false;
    }
    return true;
  }
  addEdge(source, destination) {
    this.edges.push(new Edge(this.node(source), this.node(destination)));
  }
  addSymmetry(left, right) {
    this.symmetries.push(new Symmetry([this.node(left), this.node(right)]));
  }
  edgeFrom(edge) {
    const [source, destination] = edge;
    return new Edge(this.node(source), this.node(destination));
  }
  symmetryFrom(symmetry) {
    const [a, b] = symmetry;
    return new Symmetry([this.node(a), this.node(b)]);
  }
};

// src/codecs/slp/parsers.ts
var textDecoder = new TextDecoder();
function parseJsonAttr(attr) {
  if (!attr) return null;
  const value = attr.value ?? attr;
  if (typeof value === "string") return JSON.parse(value);
  if (value instanceof Uint8Array) return JSON.parse(textDecoder.decode(value));
  if (value && typeof value === "object" && "buffer" in value) {
    return JSON.parse(textDecoder.decode(new Uint8Array(value.buffer)));
  }
  if (value && typeof value === "object") {
    return value;
  }
  return JSON.parse(String(value));
}
function trimHdf5String(str) {
  return str.trim().replace(/\0+$/, "");
}
function parseJsonEntry(entry) {
  if (typeof entry === "string") return JSON.parse(trimHdf5String(entry));
  if (entry instanceof Uint8Array) return JSON.parse(trimHdf5String(textDecoder.decode(entry)));
  if (entry && typeof entry === "object" && "buffer" in entry) {
    return JSON.parse(trimHdf5String(textDecoder.decode(new Uint8Array(entry.buffer))));
  }
  return entry;
}
function resolveEdgeType(edgeType, cache, state) {
  if (!edgeType || typeof edgeType !== "object") return 1;
  const et = edgeType;
  if (et["py/reduce"]) {
    const reduce = et["py/reduce"];
    const tuple = reduce[1]?.["py/tuple"];
    const typeId = tuple?.[0] ?? 1;
    cache.set(state.nextId, typeId);
    state.nextId += 1;
    return typeId;
  }
  if (et["py/tuple"]) {
    const tuple = et["py/tuple"];
    const typeId = tuple[0] ?? 1;
    cache.set(state.nextId, typeId);
    state.nextId += 1;
    return typeId;
  }
  if (et["py/id"]) {
    const pyId = et["py/id"];
    return cache.get(pyId) ?? pyId;
  }
  return 1;
}
function parseSkeletons(metadataJson) {
  if (!metadataJson || typeof metadataJson !== "object") return [];
  const meta = metadataJson;
  const nodeNames = (meta.nodes ?? []).map(
    (node) => typeof node === "object" ? node.name ?? "" : String(node)
  );
  const skeletonEntries = meta.skeletons ?? [];
  const skeletons = [];
  for (const entry of skeletonEntries) {
    const edges = [];
    const symmetries = [];
    const typeCache = /* @__PURE__ */ new Map();
    const typeState = { nextId: 1 };
    const entryNodes = entry.nodes ?? [];
    const skeletonNodeIds = entryNodes.map(
      (node) => Number(typeof node === "object" ? node.id ?? 0 : node)
    );
    const nodeOrder = skeletonNodeIds.length ? skeletonNodeIds : nodeNames.map((_, index) => index);
    const nodes = nodeOrder.map((nodeId) => nodeNames[nodeId]).filter((name) => name !== void 0).map((name) => new Node(name));
    const nodeIndexById = /* @__PURE__ */ new Map();
    nodeOrder.forEach((nodeId, index) => {
      nodeIndexById.set(Number(nodeId), index);
    });
    const links = entry.links ?? [];
    for (const link of links) {
      const source = Number(link.source);
      const target = Number(link.target);
      const edgeType = resolveEdgeType(link.type, typeCache, typeState);
      if (edgeType === 2) {
        symmetries.push([source, target]);
      } else {
        edges.push([source, target]);
      }
    }
    const remapPair = (pair) => {
      const sourceIndex = nodeIndexById.get(pair[0]);
      const targetIndex = nodeIndexById.get(pair[1]);
      if (sourceIndex === void 0 || targetIndex === void 0) return null;
      return [sourceIndex, targetIndex];
    };
    const mappedEdges = edges.map(remapPair).filter((pair) => pair !== null);
    const seenSymmetries = /* @__PURE__ */ new Set();
    const mappedSymmetries = symmetries.map(remapPair).filter((pair) => pair !== null).filter(([a, b]) => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seenSymmetries.has(key)) return false;
      seenSymmetries.add(key);
      return true;
    });
    const graph = entry.graph;
    const skeleton = new Skeleton({
      nodes,
      edges: mappedEdges,
      symmetries: mappedSymmetries,
      name: graph?.name ?? entry.name
    });
    skeletons.push(skeleton);
  }
  return skeletons;
}
function parseTracks(values) {
  const tracks = [];
  for (const entry of values) {
    let parsed = entry;
    if (typeof entry === "string") {
      try {
        parsed = JSON.parse(trimHdf5String(entry));
      } catch {
        parsed = trimHdf5String(entry);
      }
    } else if (entry instanceof Uint8Array) {
      try {
        parsed = JSON.parse(trimHdf5String(textDecoder.decode(entry)));
      } catch {
        parsed = trimHdf5String(textDecoder.decode(entry));
      }
    }
    if (Array.isArray(parsed)) {
      tracks.push(new Track(String(parsed[1] ?? parsed[0])));
    } else if (parsed && typeof parsed === "object" && "name" in parsed) {
      tracks.push(new Track(String(parsed.name)));
    } else {
      tracks.push(new Track(String(parsed)));
    }
  }
  return tracks;
}
function parseVideosMetadata(values, labelsPath) {
  const videos = [];
  for (const entry of values) {
    if (!entry) continue;
    let parsed;
    if (typeof entry === "string") {
      parsed = JSON.parse(trimHdf5String(entry));
    } else if (entry instanceof Uint8Array) {
      parsed = JSON.parse(trimHdf5String(textDecoder.decode(entry)));
    } else {
      parsed = entry;
    }
    const backendMeta = parsed.backend ?? {};
    let filename = backendMeta.filename ?? parsed.filename ?? "";
    const dataset = backendMeta.dataset ?? null;
    let embedded = false;
    if (filename === ".") {
      embedded = true;
      filename = labelsPath ?? "embedded";
    }
    const shape = backendMeta.shape;
    videos.push({
      filename,
      dataset: dataset ?? void 0,
      format: backendMeta.format,
      width: shape?.[2],
      height: shape?.[1],
      channels: shape?.[3],
      frameCount: shape?.[0],
      fps: backendMeta.fps,
      channelOrder: backendMeta.channel_order,
      embedded,
      sourceVideo: parsed.source_video
    });
  }
  return videos;
}
function parseSuggestions(values) {
  const suggestions = [];
  for (const entry of values) {
    const parsed = parseJsonEntry(entry);
    suggestions.push({
      video: Number(parsed.video ?? 0),
      frameIdx: parsed.frame_idx ?? parsed.frameIdx ?? 0,
      metadata: parsed
    });
  }
  return suggestions;
}
function parseSessionsMetadata(values) {
  const sessions = [];
  for (const entry of values) {
    const parsed = parseJsonEntry(entry);
    const calibration = parsed.calibration ?? {};
    const cameras = [];
    for (const [key, data] of Object.entries(calibration)) {
      if (key === "metadata") continue;
      const cameraData = data;
      cameras.push({
        name: cameraData.name ?? key,
        rvec: cameraData.rotation ?? [0, 0, 0],
        tvec: cameraData.translation ?? [0, 0, 0],
        matrix: cameraData.matrix,
        distortions: cameraData.distortions
      });
    }
    const videosByCamera = {};
    const map = parsed.camcorder_to_video_idx_map ?? {};
    for (const [cameraKey, videoIdx] of Object.entries(map)) {
      videosByCamera[cameraKey] = Number(videoIdx);
    }
    sessions.push({
      cameras,
      videosByCamera,
      metadata: parsed.metadata
    });
  }
  return sessions;
}

export {
  Track,
  pointsEmpty,
  predictedPointsEmpty,
  pointsFromArray,
  predictedPointsFromArray,
  Instance,
  PredictedInstance,
  pointsFromDict,
  predictedPointsFromDict,
  Node,
  Edge,
  Symmetry,
  Skeleton,
  parseJsonAttr,
  parseJsonEntry,
  parseSkeletons,
  parseTracks,
  parseVideosMetadata,
  parseSuggestions,
  parseSessionsMetadata
};
