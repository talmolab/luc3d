// src/model/instance.ts
var _centroidFactory = null;
function _registerCentroidFactory(factory) {
  _centroidFactory = factory;
}
var Track = class {
  name;
  constructor(name = "") {
    this.name = name;
  }
  matches(other, method = "name") {
    if (method === "name") {
      return this.name === other.name;
    }
    if (method === "identity") {
      return this === other;
    }
    throw new Error("Unknown matching method: " + method);
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
  /** Mean of visible point coordinates as `[x, y]`, or `null` if no points visible. */
  get centroidXy() {
    let sumX = 0, sumY = 0, count = 0;
    for (const point of this.points) {
      if (point.visible && !Number.isNaN(point.xy[0]) && !Number.isNaN(point.xy[1])) {
        sumX += point.xy[0];
        sumY += point.xy[1];
        count++;
      }
    }
    if (count === 0) return null;
    return [sumX / count, sumY / count];
  }
  /**
   * Create a Centroid from this instance.
   *
   * @param method - "centerOfMass" (default), "bboxCenter", or "anchor".
   * @param node - Node specification for "anchor" method.
   * @returns UserCentroid or PredictedCentroid depending on instance type.
   */
  toCentroid(method, node) {
    if (!_centroidFactory) {
      throw new Error(
        "Centroid not available. Import centroid.ts before calling toCentroid()."
      );
    }
    return _centroidFactory(this, { method, node });
  }
  get isEmpty() {
    return this.points.every((point) => !point.visible || Number.isNaN(point.xy[0]));
  }
  /**
   * Check if this instance has the same pose as another instance.
   *
   * Mirrors Python `Instance.same_pose_as` (instance.py:699-753).
   *
   * @param other - Another instance to compare with.
   * @param tolerance - Maximum distance (in pixels) between corresponding points
   *   for them to be considered the same. If `null`/`undefined`, uses exact
   *   comparison including NaN==NaN handling.
   * @returns `true` if the instances have the same pose within tolerance.
   */
  samePoseAs(other, tolerance) {
    if (!this.skeleton.matches(other.skeleton)) return false;
    const a = this.numpy();
    const b = other.numpy();
    if (tolerance == null) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        for (let j = 0; j < 2; j += 1) {
          const av = a[i][j];
          const bv = b[i][j];
          const aNaN = Number.isNaN(av);
          const bNaN = Number.isNaN(bv);
          if (aNaN !== bNaN) return false;
          if (!aNaN && av !== bv) return false;
        }
      }
      return true;
    }
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        if (Number.isNaN(a[i][j]) !== Number.isNaN(b[i][j])) return false;
      }
    }
    const aVals = [];
    const bVals = [];
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        if (!Number.isNaN(a[i][j])) {
          aVals.push(a[i][j]);
          bVals.push(b[i][j]);
        }
      }
    }
    if (aVals.length === 0) return true;
    for (let k = 0; k < aVals.length; k += 2) {
      const dx = aVals[k] - bVals[k];
      const dy = aVals[k + 1] - bVals[k + 1];
      const distance = Math.hypot(dx, dy);
      if (!(distance <= tolerance)) return false;
    }
    return true;
  }
  /**
   * Check if this instance has the same identity (track) as another instance.
   *
   * Mirrors Python `Instance.same_identity_as` (instance.py:755-770). Compares
   * tracks by reference identity, not by name.
   *
   * @param other - Another instance to compare with.
   * @returns `true` if both instances share the same `Track` object.
   */
  sameIdentityAs(other) {
    if (this.track == null || other.track == null) return false;
    return this.track === other.track;
  }
  /**
   * Check if this instance overlaps with another by bounding-box IoU.
   *
   * Mirrors Python `Instance.overlaps_with` (instance.py:772-830). Bounding
   * boxes are computed over VISIBLE points; if either has none, returns false.
   * If the boxes do not STRICTLY intersect on both axes (touching edges count
   * as no overlap), returns false regardless of `iouThreshold` — this matches
   * Python's `np.any(intersection_min >= intersection_max) -> False`
   * short-circuit, which runs before the threshold comparison.
   *
   * @param other - Another instance to compare with.
   * @param iouThreshold - Minimum IoU to count as overlapping (inclusive `>=`).
   */
  overlapsWith(other, iouThreshold = 0.5) {
    const boxA = this.boundingBox();
    const boxB = other.boundingBox();
    if (!boxA || !boxB) return false;
    const interMinX = Math.max(boxA[0][0], boxB[0][0]);
    const interMinY = Math.max(boxA[0][1], boxB[0][1]);
    const interMaxX = Math.min(boxA[1][0], boxB[1][0]);
    const interMaxY = Math.min(boxA[1][1], boxB[1][1]);
    if (interMinX >= interMaxX || interMinY >= interMaxY) return false;
    const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
    const areaA = (boxA[1][0] - boxA[0][0]) * (boxA[1][1] - boxA[0][1]);
    const areaB = (boxB[1][0] - boxB[0][0]) * (boxB[1][1] - boxB[0][1]);
    const union = areaA + areaB - interArea;
    const iou = union > 0 ? interArea / union : 0;
    return iou >= iouThreshold;
  }
  /**
   * Get the bounding box of visible points.
   *
   * Mirrors Python `Instance.bounding_box` (instance.py:832-849).
   *
   * @returns `[[minX, minY], [maxX, maxY]]` over visible points, or `null` if
   *   there are no visible points.
   */
  boundingBox() {
    const xs = [];
    const ys = [];
    for (const point of this.points) {
      if (!point.visible) continue;
      xs.push(point.xy[0]);
      ys.push(point.xy[1]);
    }
    if (!xs.length) return null;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return [[minX, minY], [maxX, maxY]];
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
var NAME_DELIM = "\0";
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}
function edgeKey(source, destination) {
  return source + NAME_DELIM + destination;
}
function symmetryKey(symmetry) {
  const names = Array.from(symmetry.nodes).map((node) => node.name);
  names.sort();
  return names.join(NAME_DELIM);
}
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
  /**
   * Check if this skeleton matches another skeleton's structure.
   *
   * Two skeletons match if they have the same nodes (by name), the same edges
   * (by directed source/destination name pairs), and the same symmetries (by
   * unordered node-name pairs). All comparisons are by node NAME, never by Node
   * identity. Two empty skeletons match.
   *
   * @param other Another skeleton to compare with.
   * @param opts.requireSameOrder If true, node names must be in the same order;
   *   if false (default), only the set of node names must match. Affects ONLY
   *   the node-name check — edges and symmetries are always compared as
   *   unordered sets.
   * @returns True if the skeletons match, false otherwise.
   */
  matches(other, opts = {}) {
    const requireSameOrder = opts.requireSameOrder ?? false;
    if (this.nodes.length !== other.nodes.length) return false;
    const selfNames = this.nodeNames;
    const otherNames = other.nodeNames;
    if (requireSameOrder) {
      for (let i = 0; i < selfNames.length; i += 1) {
        if (selfNames[i] !== otherNames[i]) return false;
      }
    } else {
      if (!setsEqual(new Set(selfNames), new Set(otherNames))) return false;
    }
    if (this.edges.length !== other.edges.length) return false;
    const selfEdgeSet = new Set(
      this.edges.map((edge) => edgeKey(edge.source.name, edge.destination.name))
    );
    const otherEdgeSet = new Set(
      other.edges.map((edge) => edgeKey(edge.source.name, edge.destination.name))
    );
    if (!setsEqual(selfEdgeSet, otherEdgeSet)) return false;
    if (this.symmetries.length !== other.symmetries.length) return false;
    const selfSymSet = new Set(this.symmetries.map(symmetryKey));
    const otherSymSet = new Set(other.symmetries.map(symmetryKey));
    return setsEqual(selfSymSet, otherSymSet);
  }
  /**
   * Calculate node overlap metrics with another skeleton.
   *
   * Node names are de-duplicated to sets first.
   *
   * @param other Another skeleton to compare with.
   * @returns An object with similarity metrics:
   *   - `nCommon`: Number of nodes in common.
   *   - `nSelfOnly`: Number of nodes only in this skeleton.
   *   - `nOtherOnly`: Number of nodes only in the other skeleton.
   *   - `jaccard`: Jaccard similarity (intersection/union), 0 if union empty.
   *   - `dice`: Dice coefficient (2*intersection/(nSelf+nOther)), 0 if both empty.
   */
  nodeSimilarities(other) {
    const selfNodes = new Set(this.nodeNames);
    const otherNodes = new Set(other.nodeNames);
    let nCommon = 0;
    for (const name of selfNodes) {
      if (otherNodes.has(name)) nCommon += 1;
    }
    const sizeSelf = selfNodes.size;
    const sizeOther = otherNodes.size;
    const nSelfOnly = sizeSelf - nCommon;
    const nOtherOnly = sizeOther - nCommon;
    const nUnion = sizeSelf + sizeOther - nCommon;
    const jaccard = nUnion > 0 ? nCommon / nUnion : 0;
    const dice = sizeSelf + sizeOther > 0 ? 2 * nCommon / (sizeSelf + sizeOther) : 0;
    return { nCommon, nSelfOnly, nOtherOnly, jaccard, dice };
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
function attrToString(attr) {
  if (attr === void 0 || attr === null) return void 0;
  if (typeof attr === "string") return trimHdf5String(attr);
  if (attr instanceof Uint8Array) return trimHdf5String(textDecoder.decode(attr));
  if (typeof attr === "object" && "value" in attr) {
    const v = attr.value;
    if (typeof v === "string") return trimHdf5String(v);
    if (v instanceof Uint8Array) return trimHdf5String(textDecoder.decode(v));
  }
  return void 0;
}
function attrToNumber(attr) {
  if (attr === void 0 || attr === null) return void 0;
  let raw = attr;
  if (typeof attr === "object" && "value" in attr) {
    raw = attr.value;
  }
  if (typeof raw !== "number" && typeof raw !== "bigint" && typeof raw !== "string") {
    return void 0;
  }
  const num = typeof raw === "bigint" ? Number(raw) : Number(raw);
  return Number.isFinite(num) ? num : void 0;
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
function resolveVideoFilename(backendMeta, parsed) {
  const filenames = backendMeta.filenames;
  if (Array.isArray(filenames) && filenames.length > 0) {
    return filenames;
  }
  return backendMeta.filename ?? parsed.filename ?? "";
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
    let filename = resolveVideoFilename(backendMeta, parsed);
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
function resolveCameraKey(cameraKey, cameraMap, cameras) {
  let camera = cameraMap.get(cameraKey);
  if (!camera) {
    const idx = Number(cameraKey);
    if (!isNaN(idx) && idx >= 0 && idx < cameras.length) {
      camera = cameras[idx];
    }
  }
  return camera;
}
function reconstructInstance3D(record, skeletons) {
  const rawPoints = record.points;
  const pointsValue = Array.isArray(rawPoints) ? rawPoints : void 0;
  if (!pointsValue) return void 0;
  const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
  const score = record.instance_3d_score;
  const pointScores = record.instance_3d_point_scores;
  if (pointScores) {
    return new PredictedInstance3D({ points: pointsValue, skeleton, score, pointScores });
  }
  return new Instance3D({ points: pointsValue, skeleton, score });
}
function resolveIdentity(record, identities) {
  const identityIdx = record.identity_idx;
  if (identityIdx == null || !identities) return void 0;
  const idx = Number(identityIdx);
  if (idx >= 0 && idx < identities.length) {
    return identities[idx];
  }
  console.warn(`identity_idx ${idx} is out of bounds (${identities.length} identities available) \u2014 skipping identity for this instance group.`);
  return void 0;
}

export {
  _registerCentroidFactory,
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
  Instance3D,
  PredictedInstance3D,
  parseJsonAttr,
  attrToString,
  attrToNumber,
  parseJsonEntry,
  parseSkeletons,
  parseTracks,
  resolveVideoFilename,
  parseVideosMetadata,
  parseSuggestions,
  parseSessionsMetadata,
  resolveCameraKey,
  reconstructInstance3D,
  resolveIdentity
};
