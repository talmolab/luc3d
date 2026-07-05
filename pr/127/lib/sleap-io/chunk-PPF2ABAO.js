import {
  Edge,
  Instance,
  Node,
  PredictedInstance,
  PredictedInstance3D,
  Skeleton,
  Symmetry,
  Track,
  _registerCentroidFactory,
  attrToNumber,
  attrToString,
  clonePoint,
  missingMetadataJsonError,
  parseJsonEntry,
  parseMetadataJson,
  parseSkeletons,
  parseSuggestions,
  parseTracks,
  parseVideosMetadata,
  pointsFromArray,
  predictedPointsFromArray,
  reconstructInstance3D,
  resolveCameraKey,
  resolveIdentity,
  resolveVideoFilename
} from "./chunk-NIFGJKOL.js";
import {
  RemoteIOError,
  fetchRetrying,
  headOrRangeProbe,
  identityHeaders,
  isUrl,
  openGdrive,
  redactUrl,
  redactedCauseSummary,
  resolveUrl,
  statusToMessage
} from "./chunk-YS7Q6CO6.js";

// src/model/centroid.ts
var _centroidSkeleton = null;
function getCentroidSkeleton() {
  if (!_centroidSkeleton) {
    _centroidSkeleton = new Skeleton({ nodes: ["centroid"], name: "centroid" });
  }
  return _centroidSkeleton;
}
var CENTROID_SKELETON = /* @__PURE__ */ (() => getCentroidSkeleton())();
var Centroid = class _Centroid {
  x;
  y;
  z;
  track;
  trackingScore;
  instance;
  category;
  name;
  source;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  constructor(options) {
    if (new.target === _Centroid) {
      throw new TypeError(
        "Centroid is abstract. Use UserCentroid or PredictedCentroid."
      );
    }
    this.x = options.x;
    this.y = options.y;
    this.z = options.z ?? null;
    this.track = options.track ?? null;
    this.trackingScore = options.trackingScore ?? null;
    this.instance = options.instance ?? null;
    this.category = options.category ?? "";
    this.name = options.name ?? "";
    this.source = options.source ?? "";
  }
  /** Coordinates as `[x, y]`. */
  get xy() {
    return [this.x, this.y];
  }
  /** Coordinates as `[y, x]` (row, col order). */
  get yx() {
    return [this.y, this.x];
  }
  /** Coordinates as `[x, y, z]`. */
  get xyz() {
    return [this.x, this.y, this.z];
  }
  /** Whether this is a predicted centroid (has a score). */
  get isPredicted() {
    return false;
  }
  /**
   * Convert this centroid to a single-node Instance.
   *
   * @param skeleton - Skeleton to use. Must have exactly one node.
   *   Defaults to the shared CENTROID_SKELETON.
   * @returns Instance or PredictedInstance depending on this centroid's type.
   */
  toInstance(skeleton) {
    const skel = skeleton ?? getCentroidSkeleton();
    if (skel.nodes.length > 1) {
      throw new Error(
        `Skeleton must have exactly 1 node for centroid conversion, got ${skel.nodes.length}.`
      );
    }
    const point = {
      xy: [this.x, this.y],
      visible: true,
      complete: true,
      name: skel.nodeNames[0]
    };
    if (this instanceof PredictedCentroid) {
      return new PredictedInstance({
        points: [{ ...point, score: this.score }],
        skeleton: skel,
        track: this.track,
        score: this.score,
        trackingScore: this.trackingScore ?? void 0
      });
    }
    return new Instance({
      points: [point],
      skeleton: skel,
      track: this.track,
      trackingScore: this.trackingScore ?? void 0
    });
  }
  /**
   * Create a centroid from an Instance.
   *
   * @param instance - Source instance.
   * @param options - Options for centroid extraction.
   * @param options.method - "centerOfMass" (default), "bboxCenter", or "anchor".
   * @param options.node - Node name or index for "anchor" method.
   * @returns UserCentroid or PredictedCentroid depending on instance type.
   */
  static fromInstance(instance, options) {
    const method = options?.method ?? "centerOfMass";
    const visiblePoints = [];
    for (const point of instance.points) {
      if (point.visible && !Number.isNaN(point.xy[0]) && !Number.isNaN(point.xy[1])) {
        visiblePoints.push(point.xy);
      }
    }
    let x;
    let y;
    if (method === "centerOfMass") {
      if (!visiblePoints.length) {
        throw new Error("No visible points for centerOfMass.");
      }
      x = visiblePoints.reduce((sum, p) => sum + p[0], 0) / visiblePoints.length;
      y = visiblePoints.reduce((sum, p) => sum + p[1], 0) / visiblePoints.length;
    } else if (method === "bboxCenter") {
      if (!visiblePoints.length) {
        throw new Error("No visible points for bboxCenter.");
      }
      const xs = visiblePoints.map((p) => p[0]);
      const ys = visiblePoints.map((p) => p[1]);
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    } else if (method === "anchor") {
      const node = options?.node;
      if (node === void 0 || node === null) {
        throw new Error("Must specify 'node' for anchor method.");
      }
      let nodeIdx;
      if (typeof node === "string") {
        nodeIdx = instance.skeleton.index(node);
      } else {
        nodeIdx = node;
      }
      const pt = instance.points[nodeIdx];
      if (!pt || Number.isNaN(pt.xy[0])) {
        throw new Error(
          `Anchor node ${JSON.stringify(node)} is not visible in this instance.`
        );
      }
      x = pt.xy[0];
      y = pt.xy[1];
    } else {
      throw new Error(
        `Unknown method ${JSON.stringify(method)}. Expected 'centerOfMass', 'bboxCenter', or 'anchor'.`
      );
    }
    const { method: _, node: __, ...extraOptions } = options ?? {};
    const centroidOptions = {
      x,
      y,
      track: instance.track ?? null,
      trackingScore: instance.trackingScore ?? null,
      instance,
      source: method === "anchor" ? `anchor:${options?.node}` : method,
      ...extraOptions
    };
    if ("score" in instance && typeof instance.score === "number") {
      return new PredictedCentroid({
        ...centroidOptions,
        score: instance.score
      });
    }
    return new UserCentroid(centroidOptions);
  }
};
var UserCentroid = class extends Centroid {
};
var PredictedCentroid = class extends Centroid {
  score;
  constructor(options) {
    super(options);
    this.score = options.score;
  }
  get isPredicted() {
    return true;
  }
};
_registerCentroidFactory(
  (instance, options) => Centroid.fromInstance(instance, options)
);

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
  track;
  trackingScore = null;
  instance;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  constructor(options) {
    if (new.target === _ROI) {
      throw new TypeError("ROI is abstract. Use UserROI or PredictedROI.");
    }
    this.geometry = options.geometry;
    this.name = options.name ?? "";
    this.category = options.category ?? "";
    this.source = options.source ?? "";
    this.video = options.video ?? null;
    this.track = options.track ?? null;
    this.trackingScore = options.trackingScore ?? null;
    this.instance = options.instance ?? null;
  }
  /** @deprecated Use BoundingBox.fromXywh() instead. */
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
    return new UserROI({
      geometry,
      ...options
    });
  }
  /** @deprecated Use BoundingBox.fromXyxy() instead. */
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
    return new UserROI({
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
    return new UserROI({
      geometry,
      ...options
    });
  }
  static fromMultiPolygon(polygons, options) {
    return new UserROI({
      geometry: { type: "MultiPolygon", coordinates: polygons },
      ...options
    });
  }
  /** Whether this is a predicted ROI (has a score). */
  get isPredicted() {
    return false;
  }
  explode() {
    const Ctor = this.constructor;
    const copyFields = {
      name: this.name,
      category: this.category,
      source: this.source,
      video: this.video,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance
    };
    if (this.isPredicted && "score" in this) {
      copyFields.score = this.score;
    }
    if (this.geometry.type === "MultiPolygon") {
      return this.geometry.coordinates.map(
        (coords) => new Ctor({
          geometry: { type: "Polygon", coordinates: coords },
          ...copyFields
        })
      );
    }
    if (this.geometry.type === "GeometryCollection") {
      return this.geometry.geometries.map(
        (geom) => new Ctor({
          geometry: geom,
          ...copyFields
        })
      );
    }
    return [
      new Ctor({
        geometry: this.geometry,
        ...copyFields
      })
    ];
  }
  toGeoJSON() {
    return {
      type: "Feature",
      geometry: this.geometry,
      properties: {
        name: this.name,
        category: this.category,
        source: this.source
      }
    };
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
        const sub = new UserROI({ geometry: geom });
        total += sub.area;
      }
      return total;
    }
    return 0;
  }
  /** Centroid of the geometry as `[x, y]`. */
  get centroidXy() {
    if (this.geometry.type === "Point") {
      return [this.geometry.coordinates[0], this.geometry.coordinates[1]];
    }
    const b = this.bounds;
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  /** @deprecated Use `centroidXy` instead. */
  get centroid() {
    if (this.geometry.type === "Point") {
      return {
        x: this.geometry.coordinates[0],
        y: this.geometry.coordinates[1]
      };
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
    const options = {
      name: this.name,
      category: this.category,
      source: this.source,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance
    };
    if (this instanceof PredictedROI) {
      options.score = this.score;
    }
    const result = _maskFactory(mask, height, width, options);
    result._instanceIdx = this._instanceIdx;
    return result;
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
        const sub = new UserROI({ geometry: geom });
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
      const polyMask = rasterizeGeometry(
        { type: "Polygon", coordinates: poly },
        height,
        width
      );
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
    return {
      geometry: { type: "Polygon", coordinates: rings },
      bytesRead: 5 + bytesRead
    };
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
    return {
      geometry: { type: "MultiPolygon", coordinates: polygons },
      bytesRead: offset
    };
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
    return {
      geometry: { type: "LineString", coordinates: coords },
      bytesRead: offset
    };
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
    return {
      geometry: { type: "MultiPoint", coordinates: coords },
      bytesRead: offset
    };
  }
  if (wkbType === 7) {
    const numGeometries = view.getUint32(5, le);
    const geometries = [];
    let offset = 9;
    for (let i = 0; i < numGeometries; i++) {
      const subBytes = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset + offset,
        bytes.byteLength - offset
      );
      const { geometry: geom, bytesRead } = decodeWkbInternal(subBytes);
      geometries.push(geom);
      offset += bytesRead;
    }
    return {
      geometry: { type: "GeometryCollection", geometries },
      bytesRead: offset
    };
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
var UserROI = class extends ROI {
};
var PredictedROI = class extends ROI {
  score;
  constructor(options) {
    super(options);
    this.score = options.score;
  }
  get isPredicted() {
    return true;
  }
};

// src/model/bbox.ts
var BoundingBox = class _BoundingBox {
  x1;
  y1;
  x2;
  y2;
  angle;
  track;
  trackingScore;
  instance;
  category;
  name;
  source;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  constructor(options) {
    if (new.target === _BoundingBox) {
      throw new TypeError(
        "BoundingBox is abstract. Use UserBoundingBox or PredictedBoundingBox."
      );
    }
    this.x1 = options.x1;
    this.y1 = options.y1;
    this.x2 = options.x2;
    this.y2 = options.y2;
    this.angle = options.angle ?? 0;
    this.track = options.track ?? null;
    this.trackingScore = options.trackingScore ?? null;
    this.instance = options.instance ?? null;
    this.category = options.category ?? "";
    this.name = options.name ?? "";
    this.source = options.source ?? "";
  }
  /** Create from corner coordinates [x1, y1, x2, y2]. */
  static fromXyxy(x1, y1, x2, y2, options) {
    return new UserBoundingBox({ x1, y1, x2, y2, ...options });
  }
  /** Create from top-left corner + size [x, y, w, h]. */
  static fromXywh(x, y, w, h, options) {
    return new UserBoundingBox({
      x1: x,
      y1: y,
      x2: x + w,
      y2: y + h,
      ...options
    });
  }
  /** Center X coordinate (computed from x1, x2). */
  get xCenter() {
    return (this.x1 + this.x2) / 2;
  }
  /** Center Y coordinate (computed from y1, y2). */
  get yCenter() {
    return (this.y1 + this.y2) / 2;
  }
  /** Width of the bbox (computed from x1, x2). */
  get width() {
    return Math.abs(this.x2 - this.x1);
  }
  /** Height of the bbox (computed from y1, y2). */
  get height() {
    return Math.abs(this.y2 - this.y1);
  }
  /** Axis-aligned bounding box as [x1, y1, x2, y2]. */
  get xyxy() {
    if (!this.isRotated) {
      return [this.x1, this.y1, this.x2, this.y2];
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
  /** Center point as `[x, y]`. */
  get centroidXy() {
    return [this.xCenter, this.yCenter];
  }
  /** @deprecated Use `centroidXy` instead. */
  get centroid() {
    return { x: this.xCenter, y: this.yCenter };
  }
  /** Whether this is a predicted bbox (has a score). */
  get isPredicted() {
    return false;
  }
  /** Whether the bbox is rotated (angle != 0). */
  get isRotated() {
    return this.angle !== 0;
  }
  /** Convert to a Polygon ROI. */
  toRoi() {
    const c = this.corners;
    const ring = [...c, c[0]];
    const roi = ROI.fromPolygon(ring, {
      name: this.name,
      category: this.category,
      source: this.source,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance
    });
    roi._instanceIdx = this._instanceIdx;
    return roi;
  }
  /** Convert to a SegmentationMask by rasterizing the bbox polygon. */
  toMask(height, width) {
    return this.toRoi().toMask(height, width);
  }
};
var UserBoundingBox = class extends BoundingBox {
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
function resizeNearest(data, srcH, srcW, dstH, dstW) {
  const Ctor = data.constructor;
  const result = new Ctor(dstH * dstW);
  for (let r = 0; r < dstH; r++) {
    const srcR = Math.min(Math.floor(r * srcH / dstH), srcH - 1);
    for (let c = 0; c < dstW; c++) {
      const srcC = Math.min(Math.floor(c * srcW / dstW), srcW - 1);
      result[r * dstW + c] = data[srcR * srcW + srcC];
    }
  }
  return result;
}
function traceMaskContours(raster, height, width) {
  const edges = /* @__PURE__ */ new Map();
  const addEdge = (ax, ay, bx, by) => {
    const rev = `${bx},${by}>${ax},${ay}`;
    if (edges.has(rev)) {
      edges.delete(rev);
    } else {
      edges.set(`${ax},${ay}>${bx},${by}`, [ax, ay, bx, by]);
    }
  };
  for (let r = 0; r < height; r++) {
    const rowBase = r * width;
    for (let c = 0; c < width; c++) {
      if (!raster[rowBase + c]) continue;
      const x0 = c;
      const y0 = r;
      const x1 = c + 1;
      const y1 = r + 1;
      addEdge(x0, y0, x1, y0);
      addEdge(x1, y0, x1, y1);
      addEdge(x1, y1, x0, y1);
      addEdge(x0, y1, x0, y0);
    }
  }
  if (edges.size === 0) return [];
  const outAdj = /* @__PURE__ */ new Map();
  for (const [, [ax, ay, bx, by]] of edges) {
    const from = `${ax},${ay}`;
    const to = `${bx},${by}`;
    const list = outAdj.get(from);
    if (list) list.push(to);
    else outAdj.set(from, [to]);
  }
  const parseKey = (k) => {
    const i = k.indexOf(",");
    return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
  };
  const rings = [];
  for (const startKey of outAdj.keys()) {
    let avail = outAdj.get(startKey);
    while (avail?.length) {
      const ring = [];
      let curKey = startKey;
      let curXY = parseKey(curKey);
      let prevXY = null;
      while (true) {
        const outs = outAdj.get(curKey);
        if (!outs || outs.length === 0) break;
        let pick = outs.length - 1;
        if (outs.length > 1 && prevXY) {
          const dinX = curXY[0] - prevXY[0];
          const dinY = curXY[1] - prevXY[1];
          let best = Number.NEGATIVE_INFINITY;
          for (let i = 0; i < outs.length; i++) {
            const nXY = parseKey(outs[i]);
            const cross = dinX * (nXY[1] - curXY[1]) - dinY * (nXY[0] - curXY[0]);
            if (cross > best) {
              best = cross;
              pick = i;
            }
          }
        }
        const nextKey = outs.splice(pick, 1)[0];
        ring.push([curXY[0], curXY[1]]);
        if (nextKey === startKey) break;
        prevXY = curXY;
        curKey = nextKey;
        curXY = parseKey(nextKey);
      }
      if (ring.length >= 3) {
        ring.push([ring[0][0], ring[0][1]]);
        rings.push(simplifyCollinear(ring));
      }
      avail = outAdj.get(startKey);
    }
  }
  return rings;
}
function simplifyCollinear(ring) {
  const pts = ring.slice(0, -1);
  const n = pts.length;
  if (n <= 2) return ring;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross !== 0) keep.push(b);
  }
  if (keep.length < 3) return ring;
  keep.push([keep[0][0], keep[0][1]]);
  return keep;
}
function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
function groupRingsIntoPolygons(rings) {
  if (rings.length === 0) return [];
  if (rings.length === 1) return [[rings[0]]];
  const areas = rings.map(ringSignedArea);
  let maxI = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[maxI])) maxI = i;
  }
  const outerSign = Math.sign(areas[maxI]) || 1;
  const polys = [];
  const holes = [];
  rings.forEach((ring, i) => {
    const absArea = Math.abs(areas[i]);
    if (Math.sign(areas[i]) === outerSign) {
      polys.push({ rings: [ring], area: absArea });
    } else {
      holes.push({ ring, area: absArea });
    }
  });
  for (const hole of holes) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < polys.length; i++) {
      if (polys[i].area < bestArea && pointInRing(hole.ring[0], polys[i].rings[0])) {
        best = i;
        bestArea = polys[i].area;
      }
    }
    if (best >= 0) polys[best].rings.push(hole.ring);
  }
  return polys.map((p) => p.rings);
}
var SegmentationMask = class _SegmentationMask {
  rleCounts;
  height;
  width;
  name;
  category;
  source;
  track;
  trackingScore = null;
  instance;
  /** Spatial scale factor: image_coord = mask_coord / scale + offset. Default [1, 1]. */
  scale;
  /** Spatial offset: image_coord = mask_coord / scale + offset. Default [0, 0]. */
  offset;
  /** @internal Deferred instance index for lazy resolution. */
  _instanceIdx = null;
  /**
   * @internal Memoized decoded raster and the `rleCounts` it was decoded from.
   * `get data()` returns the cached buffer when `rleCounts` is unchanged, so
   * repeated reads (rendering, contour tracing, bbox) decode the RLE once. The
   * returned buffer is shared — treat it as read-only.
   */
  _dataCache = null;
  _dataCacheKey = null;
  constructor(options) {
    if (new.target === _SegmentationMask) {
      throw new TypeError(
        "SegmentationMask is abstract. Use UserSegmentationMask or PredictedSegmentationMask."
      );
    }
    const scale = options.scale ?? [1, 1];
    if (scale[0] <= 0 || scale[1] <= 0) {
      throw new Error(
        `Scale must be positive, got [${scale[0]}, ${scale[1]}].`
      );
    }
    this.rleCounts = options.rleCounts;
    this.height = options.height;
    this.width = options.width;
    this.name = options.name ?? "";
    this.category = options.category ?? "";
    this.source = options.source ?? "";
    this.track = options.track ?? null;
    this.trackingScore = options.trackingScore ?? null;
    this.instance = options.instance ?? null;
    this.scale = scale;
    this.offset = options.offset ?? [0, 0];
  }
  static fromArray(mask, height, width, options) {
    let flat;
    if (mask instanceof Uint8Array) {
      const distinct = /* @__PURE__ */ new Set();
      let hasMore = false;
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i];
        if (v === 0 || distinct.has(v)) continue;
        if (distinct.size >= 3) {
          hasMore = true;
          break;
        }
        distinct.add(v);
      }
      if (distinct.size > 1) {
        const sample = Array.from(distinct).join(", ");
        const more = hasMore ? "+" : "";
        throw new Error(
          `SegmentationMask is binary (one object per mask) but got an array with ${distinct.size}${more} distinct non-zero values (e.g. [${sample}]). Use UserLabelImage.fromArray(array) to keep all classes in one dense array, or UserLabelImage.fromBinaryMasks([...]) to split per-class binaries. To opt in to binarization explicitly, pre-binarize with Uint8Array.from(arr, v => v ? 1 : 0).`
        );
      }
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
    const stride = options?.stride;
    const scaleFromStride = stride != null ? [1 / stride, 1 / stride] : void 0;
    return new UserSegmentationMask({
      rleCounts,
      height,
      width,
      ...options,
      scale: options?.scale ?? scaleFromStride
    });
  }
  get data() {
    if (this._dataCache !== null && this._dataCacheKey === this.rleCounts) {
      return this._dataCache;
    }
    const decoded = decodeRle(this.rleCounts, this.height, this.width);
    this._dataCache = decoded;
    this._dataCacheKey = this.rleCounts;
    return decoded;
  }
  get area() {
    let total = 0;
    for (let i = 1; i < this.rleCounts.length; i += 2) {
      total += this.rleCounts[i];
    }
    return total;
  }
  /** Whether scale != [1,1] or offset != [0,0]. */
  get hasSpatialTransform() {
    return this.scale[0] !== 1 || this.scale[1] !== 1 || this.offset[0] !== 0 || this.offset[1] !== 0;
  }
  /** The image-space extent of this mask (accounting for scale). */
  get imageExtent() {
    return {
      height: Math.floor(this.height / this.scale[1]),
      width: Math.floor(this.width / this.scale[0])
    };
  }
  get isPredicted() {
    return false;
  }
  /**
   * Create a resampled copy of this mask at the target dimensions.
   * The returned mask has scale=[1,1] and offset=[0,0].
   */
  resampled(targetHeight, targetWidth) {
    const srcData = this.data;
    const resized = resizeNearest(
      srcData,
      this.height,
      this.width,
      targetHeight,
      targetWidth
    );
    const rleCounts = encodeRle(resized, targetHeight, targetWidth);
    const baseOpts = {
      rleCounts,
      height: targetHeight,
      width: targetWidth,
      name: this.name,
      category: this.category,
      source: this.source,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance,
      scale: [1, 1],
      offset: [0, 0]
    };
    let resampled;
    if (this instanceof PredictedSegmentationMask) {
      const pm = this;
      let resampledScoreMap = null;
      if (pm.scoreMap) {
        resampledScoreMap = resizeNearest(
          pm.scoreMap,
          this.height,
          this.width,
          targetHeight,
          targetWidth
        );
      }
      resampled = new PredictedSegmentationMask({
        ...baseOpts,
        score: pm.score,
        scoreMap: resampledScoreMap
      });
    } else {
      resampled = new UserSegmentationMask({
        ...baseOpts,
        fromPredicted: this instanceof UserSegmentationMask ? this.fromPredicted : null
      });
    }
    resampled._instanceIdx = this._instanceIdx;
    return resampled;
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
    const [sx, sy] = this.scale;
    const [ox, oy] = this.offset;
    return {
      x: minC / sx + ox,
      y: minR / sy + oy,
      width: (maxC - minC + 1) / sx,
      height: (maxR - minR + 1) / sy
    };
  }
  /** Convert to a `BoundingBox` object with metadata.
   *
   * Returns a `UserBoundingBox` or `PredictedBoundingBox` depending on whether
   * this mask is predicted. Coordinates are in image space (respecting
   * scale/offset).
   */
  toBbox() {
    const { x, y, width, height } = this.bbox;
    const opts = {
      x1: x,
      y1: y,
      x2: x + width,
      y2: y + height,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance,
      category: this.category,
      name: this.name,
      source: this.source
    };
    const bb = this instanceof PredictedSegmentationMask ? new PredictedBoundingBox({ ...opts, score: this.score }) : new UserBoundingBox(opts);
    bb._instanceIdx = this._instanceIdx;
    return bb;
  }
  /**
   * Trace the mask's boundary as closed polygon rings in image space.
   *
   * Returns an array of rings (`[x, y]` vertices, each closed so the last point
   * equals the first), honoring the mask's `scale`/`offset`. Disjoint blobs and
   * holes each produce their own ring; an empty mask returns `[]`. The outlines
   * are exact, axis-aligned ("staircase") boundaries — consumers wanting smooth
   * curves can post-process (e.g. Chaikin subdivision). For a GeoJSON polygon
   * with holes nested as interior rings, use {@link toPolygon}.
   *
   * Browser-safe (pure data, no canvas), enabling interactive UIs to draw real
   * mask outlines instead of just the bounding box.
   */
  contours() {
    const rings = traceMaskContours(this.data, this.height, this.width);
    const [sx, sy] = this.scale;
    const [ox, oy] = this.offset;
    if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return rings;
    return rings.map(
      (ring) => ring.map(([x, y]) => [x / sx + ox, y / sy + oy])
    );
  }
  /**
   * Convert the mask to a polygon ROI tracing its actual boundary.
   *
   * Builds a `Polygon` (single blob, holes nested as interior rings) or a
   * `MultiPolygon` (disjoint blobs) from {@link contours}. An empty mask yields
   * an empty `Polygon`. Returns a `PredictedROI` (carrying `score`) for a
   * predicted mask, else a `UserROI`. Metadata (`name`, `category`, `source`,
   * `track`, `instance`) is carried over.
   *
   * Use {@link toBbox} or the `bbox` getter for the axis-aligned bounding box.
   */
  toPolygon() {
    const rings = this.contours();
    let geometry;
    if (rings.length === 0) {
      geometry = { type: "Polygon", coordinates: [[]] };
    } else {
      const polys = groupRingsIntoPolygons(rings);
      geometry = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
    }
    const options = {
      geometry,
      name: this.name,
      category: this.category,
      source: this.source,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance
    };
    const roi = this instanceof PredictedSegmentationMask ? new PredictedROI({ ...options, score: this.score }) : new UserROI(options);
    roi._instanceIdx = this._instanceIdx;
    return roi;
  }
};
var UserSegmentationMask = class extends SegmentationMask {
  /**
   * Provenance link to the `PredictedSegmentationMask` this user mask was
   * adopted from, set by {@link PredictedSegmentationMask.toUser}.
   *
   * Mirroring `Instance.fromPredicted`, this link is persisted to the SLP
   * format as an index into the saved mask list. It survives a save/load
   * round-trip as long as the source prediction is also saved (in the same or
   * another frame). Files written before this column existed load it as `null`.
   */
  fromPredicted;
  constructor(options) {
    super(options);
    this.fromPredicted = options.fromPredicted ?? null;
  }
};
var PredictedSegmentationMask = class extends SegmentationMask {
  score;
  scoreMap;
  /** Spatial scale for the score map. Default [1, 1]. */
  scoreMapScale;
  /** Spatial offset for the score map. Default [0, 0]. */
  scoreMapOffset;
  constructor(options) {
    super(options);
    this.score = options.score;
    this.scoreMap = options.scoreMap ?? null;
    this.scoreMapScale = options.scoreMapScale ?? [1, 1];
    this.scoreMapOffset = options.scoreMapOffset ?? [0, 0];
  }
  get isPredicted() {
    return true;
  }
  /**
   * Adopt this predicted mask as a user-annotated mask (human-in-the-loop).
   *
   * Returns a NEW {@link UserSegmentationMask} that carries an independent
   * COPY of the RLE raster (via `rleCounts.slice()`) plus the metadata
   * (`name`, `category`, `source`, `track`, `trackingScore`, `instance`,
   * `scale`, `offset`). Prediction-only fields (`score`, `scoreMap`,
   * `scoreMapScale`, `scoreMapOffset`) are dropped. The internal
   * `_instanceIdx` is carried over.
   *
   * The `track` and `instance` references are SHARED (not deep-copied), while
   * the RLE raster and the `scale`/`offset` tuples are copied so the user mask
   * owns independent buffers.
   *
   * Mirrors `Instance.fromPredicted` semantics: the resulting `fromPredicted`
   * link is persisted to the SLP format as an index into the saved mask list,
   * and survives a save/load round-trip as long as the source prediction is
   * also saved. Files written before this column existed load it as `null`.
   *
   * @param link - When `true` (default), set the returned mask's
   *   `fromPredicted` to this predicted mask. When `false`, leave it `null`.
   */
  toUser(link = true) {
    const user = new UserSegmentationMask({
      rleCounts: this.rleCounts.slice(),
      height: this.height,
      width: this.width,
      name: this.name,
      category: this.category,
      source: this.source,
      track: this.track,
      trackingScore: this.trackingScore,
      instance: this.instance,
      scale: [this.scale[0], this.scale[1]],
      offset: [this.offset[0], this.offset[1]],
      fromPredicted: link ? this : null
    });
    user._instanceIdx = this._instanceIdx;
    return user;
  }
};
_registerMaskFactory(
  (mask, height, width, options) => {
    const { score, ...rest } = options;
    const rleCounts = encodeRle(mask, height, width);
    if (score !== void 0) {
      return new PredictedSegmentationMask({
        rleCounts,
        height,
        width,
        ...rest,
        score
      });
    }
    return new UserSegmentationMask({ rleCounts, height, width, ...rest });
  }
);

// src/model/label-image.ts
var LabelImage = class _LabelImage {
  /** Flat (H*W) Int32Array, row-major. 0 = background, positive = object ID. */
  data;
  height;
  width;
  /** Map from label ID (positive int) to object metadata. */
  objects;
  source;
  /** Spatial scale factor: image_coord = li_coord / scale + offset. Default [1, 1]. */
  scale;
  /** Spatial offset: image_coord = li_coord / scale + offset. Default [0, 0]. */
  offset;
  /** @internal Deferred instance indices for lazy resolution. Map<label_id, instance_idx> */
  _objectInstanceIdxs = null;
  constructor(options) {
    if (new.target === _LabelImage) {
      throw new TypeError(
        "LabelImage is abstract. Use UserLabelImage or PredictedLabelImage."
      );
    }
    const scale = options.scale ?? [1, 1];
    if (scale[0] <= 0 || scale[1] <= 0) {
      throw new Error(
        `Scale must be positive, got [${scale[0]}, ${scale[1]}].`
      );
    }
    this.data = options.data;
    this.height = options.height;
    this.width = options.width;
    this.objects = options.objects ?? /* @__PURE__ */ new Map();
    this.source = options.source ?? "";
    this.scale = scale;
    this.offset = options.offset ?? [0, 0];
  }
  // --- Computed properties ---
  /** Number of objects in the label image metadata. */
  get nObjects() {
    return this.objects.size;
  }
  /** Sorted unique non-zero label IDs present in the data.
   *  Note: Scans the full pixel array on every call. Cache the result if needed multiple times. */
  get labelIds() {
    const ids = /* @__PURE__ */ new Set();
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] > 0) ids.add(this.data[i]);
    }
    return Array.from(ids).sort((a, b) => a - b);
  }
  /** Non-null tracks from objects, sorted by label ID. */
  get tracks() {
    const result = [];
    for (const lid of Array.from(this.objects.keys()).sort((a, b) => a - b)) {
      const info = this.objects.get(lid);
      if (info.track !== null) result.push(info.track);
    }
    return result;
  }
  /** Unique non-empty category strings across all objects. */
  get categories() {
    const cats = /* @__PURE__ */ new Set();
    for (const info of this.objects.values()) {
      if (info.category !== "") cats.add(info.category);
    }
    return cats;
  }
  /** Whether this is a predicted label image (has a score). */
  get isPredicted() {
    return false;
  }
  /** Whether scale != [1,1] or offset != [0,0]. */
  get hasSpatialTransform() {
    return this.scale[0] !== 1 || this.scale[1] !== 1 || this.offset[0] !== 0 || this.offset[1] !== 0;
  }
  /** The image-space extent of this label image (accounting for scale). */
  get imageExtent() {
    return {
      height: Math.floor(this.height / this.scale[1]),
      width: Math.floor(this.width / this.scale[0])
    };
  }
  /**
   * Create a resampled copy of this label image at the target dimensions.
   * The returned label image has scale=[1,1] and offset=[0,0].
   */
  resampled(targetHeight, targetWidth) {
    const resizedData = resizeNearest(
      this.data,
      this.height,
      this.width,
      targetHeight,
      targetWidth
    );
    const baseOpts = {
      data: resizedData,
      height: targetHeight,
      width: targetWidth,
      objects: new Map(this.objects),
      source: this.source,
      scale: [1, 1],
      offset: [0, 0]
    };
    if (this instanceof PredictedLabelImage) {
      const pli = this;
      let resampledScoreMap = null;
      if (pli.scoreMap) {
        resampledScoreMap = resizeNearest(
          pli.scoreMap,
          this.height,
          this.width,
          targetHeight,
          targetWidth
        );
      }
      return new PredictedLabelImage({
        ...baseOpts,
        score: pli.score,
        scoreMap: resampledScoreMap
      });
    }
    return new UserLabelImage(baseOpts);
  }
  // --- Mask extraction ---
  /** Get a binary mask (Uint8Array) for a specific label ID. */
  getObjectMask(labelId) {
    const mask = new Uint8Array(this.height * this.width);
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] === labelId) mask[i] = 1;
    }
    return mask;
  }
  /** Get a binary mask for all objects associated with a given track. */
  getTrackMask(track) {
    const matchingIds = [];
    for (const [lid, info] of this.objects) {
      if (info.track === track) matchingIds.push(lid);
    }
    if (matchingIds.length === 0) {
      throw new Error(`Track "${track.name}" not found in this LabelImage.`);
    }
    const idSet = new Set(matchingIds);
    const mask = new Uint8Array(this.height * this.width);
    for (let i = 0; i < this.data.length; i++) {
      if (idSet.has(this.data[i])) mask[i] = 1;
    }
    return mask;
  }
  /** Get a binary mask for all objects with a given category. Throws if category not found. */
  getCategoryMask(category) {
    const matchingIds = [];
    for (const [lid, info] of this.objects) {
      if (info.category === category) matchingIds.push(lid);
    }
    if (matchingIds.length === 0) {
      throw new Error(`Category "${category}" not found in this LabelImage.`);
    }
    const idSet = new Set(matchingIds);
    const mask = new Uint8Array(this.height * this.width);
    for (let i = 0; i < this.data.length; i++) {
      if (idSet.has(this.data[i])) mask[i] = 1;
    }
    return mask;
  }
  // --- Iterator ---
  /** Iterate over objects as [track, category, binaryMask] tuples in sorted label ID order. */
  *items() {
    const ids = this.labelIds;
    const maskMap = /* @__PURE__ */ new Map();
    for (const lid of ids) {
      maskMap.set(lid, new Uint8Array(this.height * this.width));
    }
    for (let i = 0; i < this.data.length; i++) {
      const mask = maskMap.get(this.data[i]);
      if (mask) mask[i] = 1;
    }
    for (const lid of ids) {
      const info = this.objects.get(lid) ?? {
        track: null,
        category: "",
        name: "",
        instance: null
      };
      yield [info.track, info.category, maskMap.get(lid)];
    }
  }
  // --- Factories ---
  /**
   * Create a LabelImage from a flat Int32Array or 2D number array.
   *
   * Tracks are NOT created by default (mirrors Python `LabelImage.from_numpy`
   * after sleap-io PR #387): pure segmentation workflows (e.g. Cellpose) produce
   * instances that don't need tracking. Pass `createTracks: true` to auto-create
   * one Track per unique non-zero label ID, or provide `tracks` explicitly. When
   * provided as an array, tracks are assigned positionally starting at label
   * ID 1; as a `Map`, by label ID. Providing `tracks` takes precedence over
   * `createTracks`.
   */
  static fromArray(data, height, width, options) {
    let flat;
    if (data instanceof Int32Array) {
      flat = data;
    } else {
      flat = new Int32Array(height * width);
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          flat[r * width + c] = data[r][c];
        }
      }
    }
    const uniqueIds = /* @__PURE__ */ new Set();
    for (let i = 0; i < flat.length; i++) {
      if (flat[i] > 0) uniqueIds.add(flat[i]);
    }
    const sortedIds = Array.from(uniqueIds).sort((a, b) => a - b);
    const trackMap = /* @__PURE__ */ new Map();
    const tracks = options?.tracks;
    if (tracks === void 0) {
      if (options?.createTracks) {
        for (const lid of sortedIds) {
          trackMap.set(lid, new Track(String(lid)));
        }
      }
    } else if (Array.isArray(tracks)) {
      for (let i = 0; i < tracks.length; i++) {
        trackMap.set(i + 1, tracks[i]);
      }
    } else {
      for (const [k, v] of tracks) {
        trackMap.set(k, v);
      }
    }
    const catMap = /* @__PURE__ */ new Map();
    const cats = options?.categories;
    if (cats !== void 0) {
      if (Array.isArray(cats)) {
        for (let i = 0; i < cats.length; i++) {
          catMap.set(i + 1, cats[i]);
        }
      } else {
        for (const [k, v] of cats) {
          catMap.set(k, v);
        }
      }
    }
    const allIds = /* @__PURE__ */ new Set([
      ...sortedIds,
      ...trackMap.keys(),
      ...catMap.keys()
    ]);
    const objects = /* @__PURE__ */ new Map();
    for (const lid of Array.from(allIds).sort((a, b) => a - b)) {
      objects.set(lid, {
        track: trackMap.get(lid) ?? null,
        category: catMap.get(lid) ?? "",
        name: "",
        instance: null
      });
    }
    return new UserLabelImage({
      data: flat,
      height,
      width,
      objects,
      source: options?.source ?? ""
    });
  }
  /** Create a LabelImage by compositing an array of SegmentationMasks. */
  static fromMasks(masks, options) {
    if (masks.length === 0) {
      throw new Error("Cannot create LabelImage from empty mask list.");
    }
    const height = masks[0].height;
    const width = masks[0].width;
    const scale = [...masks[0].scale];
    const offset = [...masks[0].offset];
    for (const m of masks.slice(1)) {
      if (m.height !== height || m.width !== width) {
        throw new Error(
          `All masks must have the same shape. Expected (${height}, ${width}), got (${m.height}, ${m.width}).`
        );
      }
      if (m.scale[0] !== scale[0] || m.scale[1] !== scale[1]) {
        throw new Error(
          `All masks must have the same scale. Expected [${scale[0]}, ${scale[1]}], got [${m.scale[0]}, ${m.scale[1]}].`
        );
      }
      if (m.offset[0] !== offset[0] || m.offset[1] !== offset[1]) {
        throw new Error(
          `All masks must have the same offset. Expected [${offset[0]}, ${offset[1]}], got [${m.offset[0]}, ${m.offset[1]}].`
        );
      }
    }
    const data = new Int32Array(height * width);
    const objects = /* @__PURE__ */ new Map();
    for (let i = 0; i < masks.length; i++) {
      const labelId = i + 1;
      const maskData = masks[i].data;
      for (let j = 0; j < maskData.length; j++) {
        if (maskData[j]) data[j] = labelId;
      }
      objects.set(labelId, {
        track: masks[i].track,
        category: masks[i].category,
        name: masks[i].name,
        instance: masks[i].instance
      });
    }
    return new UserLabelImage({
      data,
      height,
      width,
      objects,
      source: options?.source ?? "",
      scale,
      offset
    });
  }
  /**
   * Create a list of LabelImages from a stack of 2D arrays (one per frame).
   *
   * Shared Track objects are created once and reused across frames.
   *
   * @param options.data - Array of flat Int32Arrays or 2D number arrays, one per frame.
   * @param options.tracks - Track objects to assign. Array (1-indexed) or Map<labelId, Track>.
   * @param options.categories - Category strings. Array (1-indexed) or Map<labelId, string>.
   * @param options.createTracks - If true and tracks is not provided, auto-create one Track
   *   per unique non-zero label ID found across ALL frames.
   * @param options.source - Source string shared across all frames.
   */
  static fromStack(options) {
    const { data, source } = options;
    if (data.length === 0) return [];
    const first = data[0];
    const height = first.length;
    const width = first[0]?.length ?? 0;
    const allIds = /* @__PURE__ */ new Set();
    for (const frame of data) {
      if (Array.isArray(frame)) {
        for (const row of frame) {
          for (const val of row) {
            if (val > 0) allIds.add(val);
          }
        }
      }
    }
    const sortedIds = Array.from(allIds).sort((a, b) => a - b);
    let trackMap;
    if (options.tracks != null) {
      trackMap = /* @__PURE__ */ new Map();
      if (Array.isArray(options.tracks)) {
        for (let i = 0; i < options.tracks.length; i++) {
          trackMap.set(i + 1, options.tracks[i]);
        }
      } else {
        for (const [k, v] of options.tracks) {
          trackMap.set(k, v);
        }
      }
    } else if (options.createTracks) {
      trackMap = /* @__PURE__ */ new Map();
      for (const lid of sortedIds) {
        trackMap.set(lid, new Track(String(lid)));
      }
    }
    let catMap;
    if (options.categories != null) {
      catMap = /* @__PURE__ */ new Map();
      if (Array.isArray(options.categories)) {
        for (let i = 0; i < options.categories.length; i++) {
          catMap.set(i + 1, options.categories[i]);
        }
      } else {
        for (const [k, v] of options.categories) {
          catMap.set(k, v);
        }
      }
    }
    const result = [];
    for (let t = 0; t < data.length; t++) {
      const frameData = data[t];
      result.push(
        _LabelImage.fromArray(frameData, height, width, {
          tracks: trackMap,
          categories: catMap,
          source
        })
      );
    }
    return result;
  }
  /**
   * Create a LabelImage from per-object binary mask arrays.
   *
   * This is a convenience factory for workflows that produce per-object boolean
   * masks (e.g., SAM, Mask R-CNN) without going through SegmentationMask/RLE.
   *
   * Overlapping pixels are assigned to the last mask (same as fromMasks).
   *
   * @param masks - Binary masks as:
   *   - `number[][]` — single 2D mask (rows of pixel values)
   *   - `number[][][]` — array of 2D masks
   *   - `(Uint8Array | number[][])[]` — array of flat or 2D masks
   * @param options.height - Required when masks are flat Uint8Array.
   * @param options.width - Required when masks are flat Uint8Array.
   * @param options.labelIds - Explicit pixel values per mask. Must be positive and unique.
   *   Defaults to sequential [1, 2, ..., N].
   * @param options.tracks - Track objects per mask (positional).
   * @param options.categories - Category strings per mask (positional).
   * @param options.names - Name strings per mask (positional).
   * @param options.scores - Confidence scores per mask (positional).
   * @param options.createTracks - Auto-create Track objects named by label ID.
   */
  static fromBinaryMasks(masks, options) {
    let maskList;
    if (masks.length === 0) {
      throw new Error("Cannot create LabelImage from empty mask list.");
    }
    const first = masks[0];
    if (first instanceof Uint8Array) {
      maskList = masks;
    } else if (Array.isArray(first)) {
      if (first.length > 0 && typeof first[0] === "number") {
        maskList = [masks];
      } else if (first.length > 0 && Array.isArray(first[0])) {
        maskList = masks;
      } else {
        maskList = [masks];
      }
    } else {
      throw new Error("Unsupported mask format.");
    }
    const n = maskList.length;
    let height = options?.height;
    let width = options?.width;
    for (const m of maskList) {
      if (Array.isArray(m)) {
        height = height ?? m.length;
        width = width ?? m[0]?.length ?? 0;
        break;
      }
    }
    if (height === void 0 || width === void 0) {
      throw new Error(
        "Cannot determine mask dimensions. Provide height and width in options when using flat Uint8Array masks."
      );
    }
    const pixelCount = height * width;
    const flatMasks = [];
    for (let i = 0; i < n; i++) {
      const m = maskList[i];
      if (m instanceof Uint8Array) {
        if (m.length !== pixelCount) {
          throw new Error(
            `Mask ${i} has length ${m.length}, expected ${pixelCount} (${height}x${width}).`
          );
        }
        flatMasks.push(m);
      } else {
        if (m.length !== height || (m[0]?.length ?? 0) !== width) {
          throw new Error(
            `Mask ${i} has shape (${m.length}, ${m[0]?.length ?? 0}), expected (${height}, ${width}).`
          );
        }
        const flat = new Uint8Array(pixelCount);
        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            if (m[r][c]) flat[r * width + c] = 1;
          }
        }
        flatMasks.push(flat);
      }
    }
    const labelIds = [];
    if (options?.labelIds != null) {
      if (options.labelIds.length !== n) {
        throw new Error(
          `labelIds length (${options.labelIds.length}) must match number of masks (${n}).`
        );
      }
      const seen = /* @__PURE__ */ new Set();
      for (const id of options.labelIds) {
        if (id <= 0) {
          throw new Error(`All labelIds must be positive, got ${id}.`);
        }
        if (seen.has(id)) {
          throw new Error(`Duplicate labelId: ${id}.`);
        }
        seen.add(id);
        labelIds.push(id);
      }
    } else {
      for (let i = 0; i < n; i++) {
        labelIds.push(i + 1);
      }
    }
    if (options?.tracks != null && options.tracks.length !== n) {
      throw new Error(
        `tracks length (${options.tracks.length}) must match number of masks (${n}).`
      );
    }
    if (options?.categories != null && options.categories.length !== n) {
      throw new Error(
        `categories length (${options.categories.length}) must match number of masks (${n}).`
      );
    }
    if (options?.names != null && options.names.length !== n) {
      throw new Error(
        `names length (${options.names.length}) must match number of masks (${n}).`
      );
    }
    if (options?.scores != null && options.scores.length !== n) {
      throw new Error(
        `scores length (${options.scores.length}) must match number of masks (${n}).`
      );
    }
    let trackList;
    if (options?.tracks != null) {
      trackList = options.tracks;
    } else if (options?.createTracks) {
      trackList = labelIds.map((id) => new Track(String(id)));
    } else {
      trackList = new Array(n).fill(null);
    }
    const data = new Int32Array(pixelCount);
    const objects = /* @__PURE__ */ new Map();
    for (let i = 0; i < n; i++) {
      const labelId = labelIds[i];
      const maskData = flatMasks[i];
      for (let j = 0; j < maskData.length; j++) {
        if (maskData[j]) data[j] = labelId;
      }
      objects.set(labelId, {
        track: trackList[i],
        category: options?.categories?.[i] ?? "",
        name: options?.names?.[i] ?? "",
        instance: null,
        score: options?.scores?.[i] ?? void 0
      });
    }
    return new UserLabelImage({
      data,
      height,
      width,
      objects,
      source: options?.source ?? "",
      scale: options?.scale,
      offset: options?.offset
    });
  }
  // --- Conversion ---
  /** Decompose this LabelImage into individual SegmentationMask objects. */
  toMasks() {
    const ids = this.labelIds;
    const maskMap = /* @__PURE__ */ new Map();
    for (const lid of ids) {
      maskMap.set(lid, new Uint8Array(this.height * this.width));
    }
    for (let i = 0; i < this.data.length; i++) {
      const mask = maskMap.get(this.data[i]);
      if (mask) mask[i] = 1;
    }
    const result = [];
    for (const lid of ids) {
      const info = this.objects.get(lid) ?? {
        track: null,
        category: "",
        name: "",
        instance: null
      };
      const rleCounts = encodeRle(maskMap.get(lid), this.height, this.width);
      const baseOpts = {
        rleCounts,
        height: this.height,
        width: this.width,
        track: info.track,
        category: info.category,
        name: info.name,
        instance: info.instance,
        source: this.source,
        scale: [...this.scale],
        offset: [...this.offset]
      };
      if (this instanceof PredictedLabelImage) {
        const pli = this;
        result.push(
          new PredictedSegmentationMask({
            ...baseOpts,
            score: info.score ?? pli.score
          })
        );
      } else {
        result.push(new UserSegmentationMask(baseOpts));
      }
    }
    return result;
  }
  /** Extract tight bounding boxes for each object in the label image.
   *
   * Returns `UserBoundingBox` or `PredictedBoundingBox` objects depending on
   * whether this label image is predicted. Each bounding box inherits track,
   * category, name, instance, and score from the corresponding object entry.
   *
   * Bounding boxes are in image coordinates (respecting scale/offset).
   * Label IDs present in `objects` but with no pixels in the data are skipped.
   */
  toBboxes() {
    const data = this.data;
    const h = this.height;
    const w = this.width;
    const labelBounds = /* @__PURE__ */ new Map();
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const v = data[r * w + c];
        if (v <= 0) continue;
        const bounds = labelBounds.get(v);
        if (!bounds) {
          labelBounds.set(v, { minR: r, maxR: r, minC: c, maxC: c });
        } else {
          if (r < bounds.minR) bounds.minR = r;
          if (r > bounds.maxR) bounds.maxR = r;
          if (c < bounds.minC) bounds.minC = c;
          if (c > bounds.maxC) bounds.maxC = c;
        }
      }
    }
    if (labelBounds.size === 0) return [];
    const [sx, sy] = this.scale;
    const [ox, oy] = this.offset;
    const isPredicted = this instanceof PredictedLabelImage;
    const bboxes = [];
    for (const [lid, info] of this.objects) {
      const bounds = labelBounds.get(lid);
      if (!bounds) continue;
      const x1 = bounds.minC / sx + ox;
      const y1 = bounds.minR / sy + oy;
      const x2 = (bounds.maxC + 1) / sx + ox;
      const y2 = (bounds.maxR + 1) / sy + oy;
      const opts = {
        x1,
        y1,
        x2,
        y2,
        track: info.track,
        instance: info.instance,
        category: info.category,
        name: info.name,
        source: this.source
      };
      if (isPredicted) {
        const pli = this;
        bboxes.push(
          new PredictedBoundingBox({
            ...opts,
            score: info.score ?? pli.score
          })
        );
      } else {
        bboxes.push(new UserBoundingBox(opts));
      }
    }
    return bboxes;
  }
};
var UserLabelImage = class extends LabelImage {
};
var PredictedLabelImage = class extends LabelImage {
  score;
  scoreMap;
  /** Spatial scale for the score map. Default [1, 1]. */
  scoreMapScale;
  /** Spatial offset for the score map. Default [0, 0]. */
  scoreMapOffset;
  constructor(options) {
    super(options);
    this.score = options.score;
    this.scoreMap = options.scoreMap ?? null;
    this.scoreMapScale = options.scoreMapScale ?? [1, 1];
    this.scoreMapOffset = options.scoreMapOffset ?? [0, 0];
  }
  get isPredicted() {
    return true;
  }
};
function normalizeLabelIds(labelImages, options) {
  const by = options?.by ?? "track";
  if (by === "track") {
    return normalizeLabelIdsByTrack(labelImages);
  } else {
    return normalizeLabelIdsByCategory(labelImages);
  }
}
function normalizeLabelIdsByTrack(labelImages) {
  const trackToId = /* @__PURE__ */ new Map();
  let nextId = 1;
  for (const li of labelImages) {
    const sortedKeys = Array.from(li.objects.keys()).sort((a, b) => a - b);
    for (const oldId of sortedKeys) {
      const info = li.objects.get(oldId);
      if (info.track !== null && !trackToId.has(info.track)) {
        trackToId.set(info.track, nextId++);
      }
    }
  }
  for (const li of labelImages) {
    const sortedKeys = Array.from(li.objects.keys()).sort((a, b) => a - b);
    let maxOld = 0;
    for (const k of sortedKeys) {
      if (k > maxOld) maxOld = k;
    }
    const lut = new Int32Array(maxOld + 1);
    const newObjects = /* @__PURE__ */ new Map();
    for (const oldId of sortedKeys) {
      const info = li.objects.get(oldId);
      let newId;
      if (info.track !== null) {
        newId = trackToId.get(info.track);
      } else {
        newId = nextId++;
      }
      lut[oldId] = newId;
      newObjects.set(newId, info);
    }
    const newData = new Int32Array(li.data.length);
    for (let j = 0; j < li.data.length; j++) {
      const v = li.data[j];
      newData[j] = v > 0 && v <= maxOld ? lut[v] : 0;
    }
    li.data = newData;
    li.objects = newObjects;
  }
  return trackToId;
}
function normalizeLabelIdsByCategory(labelImages) {
  const categoryToId = /* @__PURE__ */ new Map();
  let nextId = 1;
  for (const li of labelImages) {
    const sortedKeys = Array.from(li.objects.keys()).sort((a, b) => a - b);
    for (const oldId of sortedKeys) {
      const info = li.objects.get(oldId);
      const cat = info.category ?? "";
      if (!categoryToId.has(cat)) {
        categoryToId.set(cat, nextId++);
      }
    }
  }
  for (const li of labelImages) {
    const sortedKeys = Array.from(li.objects.keys()).sort((a, b) => a - b);
    let maxOld = 0;
    for (const k of sortedKeys) {
      if (k > maxOld) maxOld = k;
    }
    const lut = new Int32Array(maxOld + 1);
    const newObjects = /* @__PURE__ */ new Map();
    for (const oldId of sortedKeys) {
      const info = li.objects.get(oldId);
      const cat = info.category ?? "";
      const newId = categoryToId.get(cat);
      lut[oldId] = newId;
      if (!newObjects.has(newId)) {
        newObjects.set(newId, info);
      }
    }
    const newData = new Int32Array(li.data.length);
    for (let j = 0; j < li.data.length; j++) {
      const v = li.data[j];
      newData[j] = v > 0 && v <= maxOld ? lut[v] : 0;
    }
    li.data = newData;
    li.objects = newObjects;
  }
  return categoryToId;
}

// src/model/matching.ts
var SkeletonMatchMethod = {
  EXACT: "exact",
  STRUCTURE: "structure",
  OVERLAP: "overlap",
  SUBSET: "subset"
};
var InstanceMatchMethod = {
  SPATIAL: "spatial",
  IDENTITY: "identity",
  IOU: "iou"
};
var TrackMatchMethod = {
  NAME: "name",
  IDENTITY: "identity"
};
var VideoMatchMethod = {
  PATH: "path",
  BASENAME: "basename",
  CONTENT: "content",
  AUTO: "auto",
  IMAGE_DEDUP: "image_dedup",
  SHAPE: "shape"
};
var FrameStrategy = {
  AUTO: "auto",
  KEEP_ORIGINAL: "keep_original",
  KEEP_NEW: "keep_new",
  KEEP_BOTH: "keep_both",
  UPDATE_TRACKS: "update_tracks",
  REPLACE_PREDICTIONS: "replace_predictions"
};
var ErrorMode = {
  CONTINUE: "continue",
  STRICT: "strict",
  WARN: "warn"
};
function coerceEnum(enumObj, value, label) {
  for (const member in enumObj) {
    if (enumObj[member] === value) {
      return enumObj[member];
    }
  }
  throw new Error(`'${value}' is not a valid ${label}`);
}
function toSkeletonMatchMethod(value) {
  return coerceEnum(SkeletonMatchMethod, value, "SkeletonMatchMethod");
}
function toInstanceMatchMethod(value) {
  return coerceEnum(InstanceMatchMethod, value, "InstanceMatchMethod");
}
function toTrackMatchMethod(value) {
  return coerceEnum(TrackMatchMethod, value, "TrackMatchMethod");
}
function toVideoMatchMethod(value) {
  return coerceEnum(VideoMatchMethod, value, "VideoMatchMethod");
}
function toErrorMode(value) {
  return coerceEnum(ErrorMode, value, "ErrorMode");
}
var ConflictResolution = class {
  frame;
  conflictType;
  originalData;
  newData;
  resolution;
  constructor(frame, conflictType, originalData, newData, resolution) {
    this.frame = frame;
    this.conflictType = conflictType;
    this.originalData = originalData;
    this.newData = newData;
    this.resolution = resolution;
  }
};
var MergeError = class extends Error {
  details;
  constructor(message, details) {
    super(message);
    this.name = "MergeError";
    this.details = details ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var SkeletonMismatchError = class extends MergeError {
  constructor(message, details) {
    super(message, details);
    this.name = "SkeletonMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var MergeResult = class {
  successful;
  framesMerged;
  instancesAdded;
  instancesUpdated;
  instancesSkipped;
  conflicts;
  errors;
  constructor(successful, options = {}) {
    this.successful = successful;
    this.framesMerged = options.framesMerged ?? 0;
    this.instancesAdded = options.instancesAdded ?? 0;
    this.instancesUpdated = options.instancesUpdated ?? 0;
    this.instancesSkipped = options.instancesSkipped ?? 0;
    this.conflicts = options.conflicts ?? [];
    this.errors = options.errors ?? [];
  }
  /**
   * Generate a human-readable summary of the merge result (matching.py:1214-1242).
   *
   * Byte-exact: U+2713 (checkmark) / U+2717 (ballot X) prefix; 2-space indents
   * for counts, 4-space "- " indents for error lines; optional int lines gated
   * on `!== 0`; list lines gated on `.length > 0`; first-5 errors + overflow
   * line. No trailing newline.
   */
  summary() {
    const lines = [];
    if (this.successful) {
      lines.push("\u2713 Merge completed successfully");
    } else {
      lines.push("\u2717 Merge completed with errors");
    }
    lines.push(`  Frames merged: ${this.framesMerged}`);
    lines.push(`  Instances added: ${this.instancesAdded}`);
    if (this.instancesUpdated !== 0) {
      lines.push(`  Instances updated: ${this.instancesUpdated}`);
    }
    if (this.instancesSkipped !== 0) {
      lines.push(`  Instances skipped: ${this.instancesSkipped}`);
    }
    if (this.conflicts.length) {
      lines.push(`  Conflicts resolved: ${this.conflicts.length}`);
    }
    if (this.errors.length) {
      lines.push(`  Errors encountered: ${this.errors.length}`);
      for (const error of this.errors.slice(0, 5)) {
        lines.push(`    - ${error.message}`);
      }
      if (this.errors.length > 5) {
        lines.push(`    ... and ${this.errors.length - 5} more`);
      }
    }
    return lines.join("\n");
  }
};
var MatchResult = class {
  videoMap;
  skeletonMap;
  trackMap;
  constructor(options = {}) {
    this.videoMap = options.videoMap ?? /* @__PURE__ */ new Map();
    this.skeletonMap = options.skeletonMap ?? /* @__PURE__ */ new Map();
    this.trackMap = options.trackMap ?? /* @__PURE__ */ new Map();
  }
  /** Videos from `other` that had no match in `self` (insertion order). */
  get unmatchedVideos() {
    const out = [];
    for (const [v, match] of this.videoMap) {
      if (match == null) out.push(v);
    }
    return out;
  }
  /** Skeletons from `other` that had no match in `self` (insertion order). */
  get unmatchedSkeletons() {
    const out = [];
    for (const [s, match] of this.skeletonMap) {
      if (match == null) out.push(s);
    }
    return out;
  }
  /** Tracks from `other` that had no match in `self` (insertion order). */
  get unmatchedTracks() {
    const out = [];
    for (const [t, match] of this.trackMap) {
      if (match == null) out.push(t);
    }
    return out;
  }
  /** True if all videos from `other` were matched (empty map => true). */
  get allVideosMatched() {
    return this.unmatchedVideos.length === 0;
  }
  /** True if all skeletons from `other` were matched (empty map => true). */
  get allSkeletonsMatched() {
    return this.unmatchedSkeletons.length === 0;
  }
  /** True if all tracks from `other` were matched (empty map => true). */
  get allTracksMatched() {
    return this.unmatchedTracks.length === 0;
  }
  /** Number of videos successfully matched (counts `value != null`). */
  get nVideosMatched() {
    let n = 0;
    for (const v of this.videoMap.values()) {
      if (v != null) n += 1;
    }
    return n;
  }
  /** Number of skeletons successfully matched (counts `value != null`). */
  get nSkeletonsMatched() {
    let n = 0;
    for (const s of this.skeletonMap.values()) {
      if (s != null) n += 1;
    }
    return n;
  }
  /** Number of tracks successfully matched (counts `value != null`). */
  get nTracksMatched() {
    let n = 0;
    for (const t of this.trackMap.values()) {
      if (t != null) n += 1;
    }
    return n;
  }
  /**
   * Generate a human-readable summary of the match result (matching.py:1319-1336).
   *
   * Three always-present count lines (no leading space). Only videos get an
   * unmatched listing (first 5 + overflow), 2-space "- " indents. No trailing
   * newline.
   */
  summary() {
    const lines = [];
    lines.push(`Videos: ${this.nVideosMatched}/${this.videoMap.size} matched`);
    lines.push(
      `Skeletons: ${this.nSkeletonsMatched}/${this.skeletonMap.size} matched`
    );
    lines.push(`Tracks: ${this.nTracksMatched}/${this.trackMap.size} matched`);
    const unmatchedVideos = this.unmatchedVideos;
    if (unmatchedVideos.length) {
      lines.push("Unmatched videos:");
      for (const v of unmatchedVideos.slice(0, 5)) {
        const fn = typeof v.filename === "string" ? v.filename : v.filename[0];
        lines.push(`  - ${fn}`);
      }
      if (unmatchedVideos.length > 5) {
        lines.push(`  ... and ${unmatchedVideos.length - 5} more`);
      }
    }
    return lines.join("\n");
  }
};
var MergeProgressBar = class {
  desc;
  leave;
  pbar;
  constructor(desc = "Merging", leave = true) {
    this.desc = desc;
    this.leave = leave;
    this.pbar = null;
  }
  /** Context-manager enter: returns self. */
  enter() {
    return this;
  }
  /** Context-manager exit: closes the (stub) bar. */
  exit() {
    this.pbar = null;
  }
  /** `using` support: dispose closes the (stub) bar. */
  [Symbol.dispose]() {
    this.exit();
  }
  /**
   * Progress callback for merge operations. Creates the (stub) bar lazily only
   * when `total` is truthy (nonzero), then records absolute progress. No-op
   * presentation.
   */
  callback(current, total, message = "") {
    if (this.pbar == null && total) {
      this.pbar = { total, n: 0, desc: this.desc, leave: this.leave };
    }
    if (this.pbar != null) {
      const bar = this.pbar;
      bar.desc = message ? `${this.desc}: ${message}` : this.desc;
      bar.n = current;
    }
  }
};
var _fsResolver = null;
var _defaultFsResolver = null;
function setFsResolver(resolver) {
  _fsResolver = resolver;
}
function setDefaultFsResolver(resolver) {
  _defaultFsResolver = resolver;
}
function getFsResolver() {
  return _fsResolver ?? _defaultFsResolver;
}
function _getRootVideo(video) {
  return video.originalVideo ?? video;
}
function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function _getEffectiveShape(video) {
  const source = video.sourceVideo;
  if (source != null) {
    const sourceShape = _getEffectiveShape(source);
    if (sourceShape != null) {
      return sourceShape;
    }
  }
  if (hasKey(video.backendMetadata, "shape")) {
    return video.backendMetadata.shape;
  }
  return video.shape;
}
function shapesCompatible(video1, video2) {
  const shape1 = _getEffectiveShape(video1);
  const shape2 = _getEffectiveShape(video2);
  if (shape1 == null || shape2 == null) {
    return null;
  }
  return shape1[0] === shape2[0] && // frames
  shape1[1] === shape2[1] && // height
  shape1[2] === shape2[2];
}
function basename(path) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}
function sanitizeFilename(filename) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filename)) {
    return filename;
  }
  let p = filename.replace(/\\/g, "/");
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}
function posixParts(path) {
  if (path === "") return [];
  const isAbsolute = path.startsWith("/");
  const segments = path.split("/").filter((seg) => seg !== "");
  if (isAbsolute) {
    return ["/", ...segments];
  }
  return segments;
}
function getPathParts(video) {
  const root = _getRootVideo(video);
  let fn = root.filename;
  if (Array.isArray(fn)) {
    fn = fn[0];
  }
  return posixParts(sanitizeFilename(fn));
}
async function _fileExists(filename) {
  const fs = getFsResolver();
  if (fs == null) {
    return false;
  }
  if (Array.isArray(filename)) {
    for (const f of filename) {
      if (!await fs.exists(f)) return false;
    }
    return true;
  }
  return fs.exists(filename);
}
function videoDataset(video) {
  const fromBackend = video.backend?.dataset;
  if (fromBackend != null) return fromBackend;
  const fromMeta = video.backendMetadata.dataset;
  return typeof fromMeta === "string" ? fromMeta : null;
}
async function _isSameFileDirect(video1, video2) {
  const fn1 = video1.filename;
  const fn2 = video2.filename;
  if (Array.isArray(fn1) && Array.isArray(fn2)) {
    if (fn1.length !== fn2.length) return false;
    for (let i = 0; i < fn1.length; i += 1) {
      if (fn1[i] !== fn2[i]) return false;
    }
    return true;
  }
  if (Array.isArray(fn1) || Array.isArray(fn2)) {
    return false;
  }
  const path1 = fn1;
  const path2 = fn2;
  const fs = getFsResolver();
  let filesMatch = false;
  if (fs != null) {
    try {
      if (await fs.exists(path1) && await fs.exists(path2)) {
        filesMatch = await fs.sameFile(path1, path2);
      }
    } catch {
    }
  }
  if (!filesMatch && fs != null) {
    try {
      if (await fs.realpath(path1) === await fs.realpath(path2)) {
        filesMatch = true;
      }
    } catch {
    }
  }
  if (!filesMatch) {
    filesMatch = sanitizeFilename(path1) === sanitizeFilename(path2);
  }
  if (!filesMatch) {
    return false;
  }
  const backend1 = video1.backend;
  const backend2 = video2.backend;
  if (backend1 != null && backend2 != null) {
    const dataset1 = videoDataset(video1);
    const dataset2 = videoDataset(video2);
    if (dataset1 != null && dataset2 != null) {
      return dataset1 === dataset2;
    }
  }
  return true;
}
function _cropKey(video) {
  const fn = video._cropTuple;
  if (typeof fn !== "function") {
    return null;
  }
  const crop = fn.call(video);
  return crop != null ? [...crop] : null;
}
function _cropKeysEqual(key1, key2) {
  if (key1 == null || key2 == null) {
    return key1 === key2;
  }
  return key1[0] === key2[0] && key1[1] === key2[1] && key1[2] === key2[2] && key1[3] === key2[3];
}
async function isSameFile(video1, video2) {
  const root1 = _getRootVideo(video1);
  const root2 = _getRootVideo(video2);
  if (!await _isSameFileDirect(root1, root2)) {
    return false;
  }
  return _cropKeysEqual(_cropKey(video1), _cropKey(video2));
}
async function originalVideosConflict(video1, video2) {
  const root1 = _getRootVideo(video1);
  const root2 = _getRootVideo(video2);
  const hasProvenance1 = video1.originalVideo != null || video1.sourceVideo != null;
  const hasProvenance2 = video2.originalVideo != null || video2.sourceVideo != null;
  if (!(hasProvenance1 && hasProvenance2)) {
    return false;
  }
  if (await _isSameFileDirect(root1, root2)) {
    return false;
  }
  if (!await _fileExists(root1.filename) && !await _fileExists(root2.filename)) {
    return false;
  }
  return true;
}
async function _sameFileDifferentCrop(video1, video2) {
  if (_cropKeysEqual(_cropKey(video1), _cropKey(video2))) {
    return false;
  }
  const root1 = _getRootVideo(video1);
  const root2 = _getRootVideo(video2);
  if (await _isSameFileDirect(root1, root2)) {
    return true;
  }
  const fn1 = root1.filename;
  const fn2 = root2.filename;
  if (Array.isArray(fn1) || Array.isArray(fn2)) {
    return false;
  }
  return basename(fn1) === basename(fn2);
}
function _getFrameInstances(labels, video, includePredictions) {
  const result = /* @__PURE__ */ new Map();
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) {
      continue;
    }
    const instances = [];
    for (const inst of lf.instances) {
      if (includePredictions || !(inst instanceof PredictedInstance)) {
        instances.push(inst);
      }
    }
    if (instances.length) {
      result.set(lf.frameIdx, instances);
    }
  }
  return result;
}
function _videoHasUserInstances(labels, video) {
  for (const lf of labels.labeledFrames) {
    if (lf.video !== video) {
      continue;
    }
    for (const inst of lf.instances) {
      if (!(inst instanceof PredictedInstance)) {
        return true;
      }
    }
  }
  return false;
}
function _resolveComparePredictions(comparePredictions, labels, video) {
  if (comparePredictions === "auto") {
    return !_videoHasUserInstances(labels, video);
  }
  return Boolean(comparePredictions);
}
function _frameHasMatchingPose(instancesA, instancesB) {
  for (const instA of instancesA) {
    const ptsA = instA.numpy();
    for (const instB of instancesB) {
      const ptsB = instB.numpy();
      if (_posesIdentical(ptsA, ptsB)) {
        return true;
      }
    }
  }
  return false;
}
function _posesIdentical(ptsA, ptsB) {
  if (ptsA.length !== ptsB.length) return false;
  for (let i = 0; i < ptsA.length; i += 1) {
    if (ptsA[i].length !== ptsB[i].length) return false;
  }
  let anyValid = false;
  for (let i = 0; i < ptsA.length; i += 1) {
    for (let j = 0; j < ptsA[i].length; j += 1) {
      const aNaN = Number.isNaN(ptsA[i][j]);
      const bNaN = Number.isNaN(ptsB[i][j]);
      if (aNaN !== bNaN) return false;
      if (!aNaN) {
        anyValid = true;
        if (ptsA[i][j] !== ptsB[i][j]) return false;
      }
    }
  }
  if (!anyValid) return false;
  return true;
}
function _sampleFrameIndices(indices, maxSamples) {
  const list = [...indices].sort((a, b) => a - b);
  if (list.length <= maxSamples) {
    return list;
  }
  const step = list.length / maxSamples;
  const out = [];
  for (let i = 0; i < maxSamples; i += 1) {
    out.push(list[Math.trunc(i * step)]);
  }
  return out;
}
function _getEmbeddedFrameIndices(video) {
  const backend = video.backend;
  if (backend == null) {
    return null;
  }
  if ("embedded_frame_inds" in backend && backend.embedded_frame_inds != null) {
    return [...backend.embedded_frame_inds];
  }
  if ("frame_map" in backend && backend.frame_map) {
    const fm = backend.frame_map;
    const keys = fm instanceof Map ? [...fm.keys()] : Object.keys(fm).map((k) => Number(k));
    if (keys.length) {
      return keys;
    }
    return null;
  }
  return null;
}
function _getCommonEmbeddedIndices(video1, video2) {
  const inds1 = _getEmbeddedFrameIndices(video1);
  const inds2 = _getEmbeddedFrameIndices(video2);
  if (inds1 == null || inds2 == null) {
    return /* @__PURE__ */ new Set();
  }
  const set2 = new Set(inds2);
  const out = /* @__PURE__ */ new Set();
  for (const i of inds1) {
    if (set2.has(i)) out.add(i);
  }
  return out;
}
function _toGrayscaleFloat(frame) {
  const img = frame;
  if (typeof img.width === "number" && typeof img.height === "number" && img.data != null) {
    const width = img.width;
    const height = img.height;
    const src = img.data;
    const n = width * height;
    const channels = src.length / n;
    const out = new Float32Array(n);
    if (channels === 1) {
      for (let i = 0; i < n; i += 1) {
        out[i] = src[i] / 255;
      }
    } else if (channels >= 3) {
      for (let i = 0; i < n; i += 1) {
        const base = i * channels;
        const r = src[base];
        const g = src[base + 1];
        const b = src[base + 2];
        out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      }
    } else if (channels === 2) {
      for (let i = 0; i < n; i += 1) {
        out[i] = src[i * 2] / 255;
      }
    } else {
      throw new Error(
        `Unexpected frame shape: [${height}, ${width}, ${channels}]`
      );
    }
    return { width, height, data: out };
  }
  throw new Error("Unexpected frame shape: <unstructured frame>");
}
async function _framesSimilarByImage(video1, video2, frameIdx, threshold) {
  try {
    const frame1 = await video1.getFrame(frameIdx);
    const frame2 = await video2.getFrame(frameIdx);
    if (frame1 == null || frame2 == null) {
      return false;
    }
    const gray1 = _toGrayscaleFloat(frame1);
    const gray2 = _toGrayscaleFloat(frame2);
    if (gray1.width !== gray2.width || gray1.height !== gray2.height) {
      return false;
    }
    const n = gray1.data.length;
    if (n === 0) {
      return false;
    }
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += Math.abs(gray1.data[i] - gray2.data[i]);
    }
    const diff = sum / n;
    return diff <= threshold;
  } catch {
    return false;
  }
}
var SkeletonMatcher = class {
  method;
  requireSameOrder;
  minOverlap;
  /**
   * @param method - The matching method (default STRUCTURE). A bare string is
   *   coerced to the enum value and validated (throws on unknown).
   * @param options - `requireSameOrder` (default `false`), `minOverlap`
   *   (default `0.5`).
   */
  constructor(method = SkeletonMatchMethod.STRUCTURE, options = {}) {
    this.method = typeof method === "string" ? toSkeletonMatchMethod(method) : method;
    this.requireSameOrder = options.requireSameOrder ?? false;
    this.minOverlap = options.minOverlap ?? 0.5;
  }
  /**
   * Check if two skeletons match according to the configured method
   * (matching.py:667-684). Dispatch order is load-bearing.
   */
  match(skeleton1, skeleton2) {
    if (this.method === SkeletonMatchMethod.EXACT) {
      return skeleton1.matches(skeleton2, { requireSameOrder: true });
    } else if (this.method === SkeletonMatchMethod.STRUCTURE) {
      return skeleton1.matches(skeleton2, {
        requireSameOrder: this.requireSameOrder
      });
    } else if (this.method === SkeletonMatchMethod.OVERLAP) {
      const metrics = skeleton1.nodeSimilarities(skeleton2);
      return metrics.jaccard >= this.minOverlap;
    } else if (this.method === SkeletonMatchMethod.SUBSET) {
      const nodes1 = new Set(skeleton1.nodeNames);
      const nodes2 = new Set(skeleton2.nodeNames);
      for (const name of nodes1) {
        if (!nodes2.has(name)) return false;
      }
      return true;
    } else {
      throw new Error(`Unknown skeleton match method: ${this.method}`);
    }
  }
};
var InstanceMatcher = class {
  method;
  threshold;
  /**
   * @param method - The matching method (default SPATIAL). A bare string is
   *   coerced + validated.
   * @param options - `threshold` (default `5.0`).
   */
  constructor(method = InstanceMatchMethod.SPATIAL, options = {}) {
    this.method = typeof method === "string" ? toInstanceMatchMethod(method) : method;
    this.threshold = options.threshold ?? 5;
  }
  /**
   * Check if two instances match according to the configured method
   * (matching.py:705-714).
   */
  match(instance1, instance2) {
    if (this.method === InstanceMatchMethod.SPATIAL) {
      return instance1.samePoseAs(instance2, this.threshold);
    } else if (this.method === InstanceMatchMethod.IDENTITY) {
      return instance1.sameIdentityAs(instance2);
    } else if (this.method === InstanceMatchMethod.IOU) {
      return instance1.overlapsWith(instance2, this.threshold);
    } else {
      throw new Error(`Unknown instance match method: ${this.method}`);
    }
  }
  /**
   * Find all matching instances between two lists (matching.py:716-771).
   *
   * Returns the FULL Cartesian product of `[idx1, idx2, score]` triples for
   * matching pairs (NOT greedy/one-to-one). Output order = nested-loop encounter
   * order (`i` outer, `j` inner). The gate ({@link match}) and the score are
   * computed by SEPARATE code paths, so a subclass that overrides `match()` to
   * always-true still gets a correct (or zero) score.
   */
  findMatches(instances1, instances2) {
    const matches = [];
    for (let i = 0; i < instances1.length; i += 1) {
      const inst1 = instances1[i];
      for (let j = 0; j < instances2.length; j += 1) {
        const inst2 = instances2[j];
        if (this.match(inst1, inst2)) {
          let score;
          if (this.method === InstanceMatchMethod.SPATIAL) {
            const pts1 = inst1.numpy();
            const pts2 = inst2.numpy();
            const distances = [];
            const n = Math.min(pts1.length, pts2.length);
            for (let k = 0; k < n; k += 1) {
              const valid = !Number.isNaN(pts1[k][0]) && !Number.isNaN(pts2[k][0]);
              if (valid) {
                const dx = pts1[k][0] - pts2[k][0];
                const dy = pts1[k][1] - pts2[k][1];
                distances.push(Math.hypot(dx, dy));
              }
            }
            if (distances.length) {
              let sum = 0;
              for (const d of distances) sum += d;
              const mean = sum / distances.length;
              score = 1 / (1 + mean);
            } else {
              score = 0;
            }
          } else if (this.method === InstanceMatchMethod.IOU) {
            const bbox1 = inst1.boundingBox();
            const bbox2 = inst2.boundingBox();
            if (bbox1 != null && bbox2 != null) {
              const interMinX = Math.max(bbox1[0][0], bbox2[0][0]);
              const interMinY = Math.max(bbox1[0][1], bbox2[0][1]);
              const interMaxX = Math.min(bbox1[1][0], bbox2[1][0]);
              const interMaxY = Math.min(bbox1[1][1], bbox2[1][1]);
              if (interMinX < interMaxX && interMinY < interMaxY) {
                const interArea = (interMaxX - interMinX) * (interMaxY - interMinY);
                const area1 = (bbox1[1][0] - bbox1[0][0]) * (bbox1[1][1] - bbox1[0][1]);
                const area2 = (bbox2[1][0] - bbox2[0][0]) * (bbox2[1][1] - bbox2[0][1]);
                const unionArea = area1 + area2 - interArea;
                score = unionArea > 0 ? interArea / unionArea : 0;
              } else {
                score = 0;
              }
            } else {
              score = 0;
            }
          } else {
            score = 1;
          }
          matches.push([i, j, score]);
        }
      }
    }
    return matches;
  }
};
var TrackMatcher = class {
  method;
  /**
   * @param method - The matching method (default IDENTITY — matches only the
   *   same Track object; correctness-first). Use NAME to match by track name. A
   *   bare string is coerced + validated.
   */
  constructor(method = TrackMatchMethod.IDENTITY) {
    this.method = typeof method === "string" ? toTrackMatchMethod(method) : method;
  }
  /** Check if two tracks match according to the configured method. */
  match(track1, track2) {
    return track1.matches(track2, this.method);
  }
};
var VideoMatcher = class {
  method;
  strict;
  contentFrames;
  comparePredictions;
  compareImages;
  imageSimilarityThreshold;
  /** Fresh, reference-keyed per matcher; NOT a constructor argument. */
  _frameCache;
  /**
   * @param method - The matching method (default AUTO). A bare string is coerced
   *   + validated.
   * @param options - `strict` (default `false`), `contentFrames` (default `3`),
   *   `comparePredictions` (default `"auto"`), `compareImages` (default
   *   `false`), `imageSimilarityThreshold` (default `0.05`).
   */
  constructor(method = VideoMatchMethod.AUTO, options = {}) {
    this.method = typeof method === "string" ? toVideoMatchMethod(method) : method;
    this.strict = options.strict ?? false;
    this.contentFrames = options.contentFrames ?? 3;
    this.comparePredictions = options.comparePredictions ?? "auto";
    this.compareImages = options.compareImages ?? false;
    this.imageSimilarityThreshold = options.imageSimilarityThreshold ?? 0.05;
    this._frameCache = /* @__PURE__ */ new Map();
  }
  /**
   * Get frame instances with reference-keyed caching (matching.py:834-850).
   * Avoids recomputing the per-video frame map during a merge.
   */
  _getCachedFrameInstances(labels, video, includePredictions) {
    let byVideo = this._frameCache.get(labels);
    if (byVideo == null) {
      byVideo = /* @__PURE__ */ new Map();
      this._frameCache.set(labels, byVideo);
    }
    let byPred = byVideo.get(video);
    if (byPred == null) {
      byPred = /* @__PURE__ */ new Map();
      byVideo.set(video, byPred);
    }
    let result = byPred.get(includePredictions);
    if (result == null) {
      result = _getFrameInstances(labels, video, includePredictions);
      byPred.set(includePredictions, result);
    }
    return result;
  }
  /**
   * Check if two videos match according to the configured method
   * (matching.py:852-897) — PAIRWISE (NOT the full AUTO cascade).
   *
   * For AUTO this performs rejection checks + definitive identity + path match;
   * for the full AUTO matching with leaf-uniqueness use {@link findMatch}.
   *
   * Async because the AUTO branch awaits `isSameFile` / `originalVideosConflict`.
   */
  async match(video1, video2) {
    if (this.method === VideoMatchMethod.AUTO) {
      if (shapesCompatible(video1, video2) === false) {
        return false;
      }
      if (await originalVideosConflict(video1, video2)) {
        return false;
      }
      if (await _sameFileDifferentCrop(video1, video2)) {
        return false;
      }
      if (await isSameFile(video1, video2)) {
        return true;
      }
      if (video1.matchesPath(video2, true)) {
        return true;
      }
      if (video1.matchesPath(video2, false)) {
        return true;
      }
      return false;
    } else if (this.method === VideoMatchMethod.PATH) {
      return video1.matchesPath(video2, this.strict);
    } else if (this.method === VideoMatchMethod.BASENAME) {
      return video1.matchesPath(video2, false);
    } else if (this.method === VideoMatchMethod.CONTENT) {
      return video1.matchesContent(video2);
    } else if (this.method === VideoMatchMethod.IMAGE_DEDUP) {
      return video1.hasOverlappingImages(video2);
    } else if (this.method === VideoMatchMethod.SHAPE) {
      return video1.matchesShape(video2);
    } else {
      throw new Error(`Unknown video match method: ${this.method}`);
    }
  }
  /**
   * Find a matching video from `candidates` using the configured method
   * (matching.py:899-1031). Returns a `Video` from `candidates` (by reference)
   * or `null`.
   *
   * Non-AUTO: first candidate where `this.match(candidate, incoming)` is true.
   * AUTO: the exact 6-stage safe cascade (file identity → strict path → leaf-path
   * uniqueness at increasing depth → pose matching → image matching → null).
   *
   * Async (DECISIONS D8): awaits FS + pixel helpers throughout.
   */
  async findMatch(incoming, candidates, opts = {}) {
    const labelsIncoming = opts.labelsIncoming ?? null;
    const labelsBase = opts.labelsBase ?? null;
    if (this.method !== VideoMatchMethod.AUTO) {
      for (const candidate of candidates) {
        if (await this.match(candidate, incoming)) {
          return candidate;
        }
      }
      return null;
    }
    const viable = [];
    for (const candidate of candidates) {
      if (shapesCompatible(candidate, incoming) === false) {
        continue;
      }
      if (await originalVideosConflict(candidate, incoming)) {
        continue;
      }
      if (await _sameFileDifferentCrop(candidate, incoming)) {
        continue;
      }
      viable.push(candidate);
    }
    for (const candidate of viable) {
      if (await isSameFile(candidate, incoming)) {
        return candidate;
      }
    }
    for (const candidate of viable) {
      if (candidate.matchesPath(incoming, true)) {
        return candidate;
      }
    }
    if (viable.length) {
      const incomingParts = getPathParts(incoming);
      const candidateParts = viable.map((v) => [
        v,
        getPathParts(v)
      ]);
      const allParts = candidates.map((v) => [
        v,
        getPathParts(v)
      ]);
      let maxAllLen = 0;
      for (const [, p] of allParts) {
        if (p.length > maxAllLen) maxAllLen = p.length;
      }
      const maxDepth = Math.max(incomingParts.length, maxAllLen);
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        if (incomingParts.length < depth) continue;
        const incomingLeaf = incomingParts.slice(-depth).join("/");
        const matchesAtDepth = [];
        for (const [candidate, parts] of candidateParts) {
          if (parts.length < depth) continue;
          const candidateLeaf = parts.slice(-depth).join("/");
          if (candidateLeaf === incomingLeaf) {
            matchesAtDepth.push(candidate);
          }
        }
        if (matchesAtDepth.length === 1) {
          return matchesAtDepth[0];
        }
      }
    }
    if (labelsIncoming != null && labelsBase != null) {
      const m = await this._matchByPoses(
        incoming,
        viable,
        labelsIncoming,
        labelsBase
      );
      if (m != null) return m;
    }
    if (this.compareImages) {
      const m = await this._matchByImages(incoming, viable);
      if (m != null) return m;
    }
    return null;
  }
  /**
   * Try to match a video by comparing pose annotations (matching.py:1033-1091).
   *
   * Resolves `includePredictions` separately for incoming and EACH candidate;
   * uses the reference-keyed frame cache; for each candidate computes the common
   * frame-index intersection, requires `min(contentFrames, common.size)` matching
   * sampled frames (sampling up to `contentFrames * 2`), and short-circuits the
   * moment the count reaches `required`. Returns the matched candidate or `null`.
   */
  async _matchByPoses(incoming, candidates, labelsIncoming, labelsBase) {
    const includePreds = _resolveComparePredictions(
      this.comparePredictions,
      labelsIncoming,
      incoming
    );
    const incomingFrames = this._getCachedFrameInstances(
      labelsIncoming,
      incoming,
      includePreds
    );
    if (incomingFrames.size === 0) {
      return null;
    }
    for (const candidate of candidates) {
      const includePredsCand = _resolveComparePredictions(
        this.comparePredictions,
        labelsBase,
        candidate
      );
      const candidateFrames = this._getCachedFrameInstances(
        labelsBase,
        candidate,
        includePredsCand
      );
      if (candidateFrames.size === 0) {
        continue;
      }
      const common = /* @__PURE__ */ new Set();
      for (const idx of incomingFrames.keys()) {
        if (candidateFrames.has(idx)) common.add(idx);
      }
      if (common.size === 0) {
        continue;
      }
      const required = Math.min(this.contentFrames, common.size);
      const samples = _sampleFrameIndices(common, this.contentFrames * 2);
      let matching = 0;
      for (const frameIdx of samples) {
        const a = incomingFrames.get(frameIdx);
        const b = candidateFrames.get(frameIdx);
        if (a != null && b != null && _frameHasMatchingPose(a, b)) {
          matching += 1;
          if (matching >= required) {
            return candidate;
          }
        }
      }
    }
    return null;
  }
  /**
   * Try to match a video by comparing image content (matching.py:1093-1126).
   *
   * Only used when `compareImages` is true (expensive). Same control flow as
   * {@link _matchByPoses} but over common EMBEDDED frame indices, using
   * pixel-similarity (`imageSimilarityThreshold`). Returns the matched candidate
   * or `null`.
   */
  async _matchByImages(incoming, candidates) {
    for (const candidate of candidates) {
      const common = _getCommonEmbeddedIndices(incoming, candidate);
      if (common.size === 0) {
        continue;
      }
      const required = Math.min(this.contentFrames, common.size);
      const samples = _sampleFrameIndices(common, this.contentFrames * 2);
      let matching = 0;
      for (const frameIdx of samples) {
        if (await _framesSimilarByImage(
          incoming,
          candidate,
          frameIdx,
          this.imageSimilarityThreshold
        )) {
          matching += 1;
          if (matching >= required) {
            return candidate;
          }
        }
      }
    }
    return null;
  }
};
var STRUCTURE_SKELETON_MATCHER = new SkeletonMatcher(
  SkeletonMatchMethod.STRUCTURE
);
var SUBSET_SKELETON_MATCHER = new SkeletonMatcher(
  SkeletonMatchMethod.SUBSET
);
var OVERLAP_SKELETON_MATCHER = new SkeletonMatcher(
  SkeletonMatchMethod.OVERLAP,
  { minOverlap: 0.7 }
);
var DUPLICATE_MATCHER = new InstanceMatcher(
  InstanceMatchMethod.SPATIAL,
  { threshold: 5 }
);
var IOU_MATCHER = new InstanceMatcher(InstanceMatchMethod.IOU, {
  threshold: 0.5
});
var IDENTITY_INSTANCE_MATCHER = new InstanceMatcher(
  InstanceMatchMethod.IDENTITY
);
var NAME_TRACK_MATCHER = new TrackMatcher(TrackMatchMethod.NAME);
var IDENTITY_TRACK_MATCHER = new TrackMatcher(
  TrackMatchMethod.IDENTITY
);
var AUTO_VIDEO_MATCHER = new VideoMatcher(VideoMatchMethod.AUTO);
var PATH_VIDEO_MATCHER = new VideoMatcher(VideoMatchMethod.PATH, {
  strict: true
});
var BASENAME_VIDEO_MATCHER = new VideoMatcher(
  VideoMatchMethod.BASENAME
);
var IMAGE_DEDUP_VIDEO_MATCHER = new VideoMatcher(
  VideoMatchMethod.IMAGE_DEDUP
);
var SHAPE_VIDEO_MATCHER = new VideoMatcher(VideoMatchMethod.SHAPE);

// src/model/labeled-frame.ts
var ANNOTATION_ATTRS = [
  "centroids",
  "bboxes",
  "masks",
  "labelImages",
  "rois"
];
function _shallowCopy(item) {
  return Object.create(
    Object.getPrototypeOf(item),
    Object.getOwnPropertyDescriptors(item)
  );
}
function _copyWithMemo(item, memo) {
  const itemCopy = _shallowCopy(item);
  memo.set(item, itemCopy);
  return itemCopy;
}
function _relinkFromPredicted(annotations, memo) {
  for (const ann of annotations) {
    const src = ann?.fromPredicted;
    if (src != null) {
      const replacement = memo.get(src);
      if (replacement !== void 0) {
        ann.fromPredicted = replacement;
      }
    }
  }
}
function _annotationCentroidXy(annotation, attr) {
  if (attr === "centroids") {
    const c = annotation;
    return [c.x, c.y];
  } else if (attr === "bboxes") {
    return annotation.centroidXy;
  } else if (attr === "rois") {
    const roi = annotation;
    if (roi.area === 0) return null;
    return roi.centroidXy;
  } else if (attr === "masks") {
    const mask = annotation;
    const bb = mask.bbox;
    if (bb.width === 0 && bb.height === 0) return null;
    return [bb.x + bb.width / 2, bb.y + bb.height / 2];
  } else if (attr === "labelImages") {
    const li = annotation;
    const [sx, sy] = li.scale;
    const [ox, oy] = li.offset;
    return [li.width / 2 / sx + ox, li.height / 2 / sy + oy];
  }
  return null;
}
function _findAnnotationMatches(selfList, otherList, attr, threshold) {
  const matches = [];
  for (let i = 0; i < selfList.length; i++) {
    const c1 = _annotationCentroidXy(selfList[i], attr);
    if (c1 === null) continue;
    for (let j = 0; j < otherList.length; j++) {
      const c2 = _annotationCentroidXy(otherList[j], attr);
      if (c2 === null) continue;
      const dist = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]);
      if (dist <= threshold) {
        matches.push({ selfIdx: i, otherIdx: j, score: 1 / (1 + dist) });
      }
    }
  }
  return matches;
}
function _findAnnotationLinkMatches(selfList, otherList) {
  const matches = [];
  const selfIdToIdx = /* @__PURE__ */ new Map();
  for (let i = 0; i < selfList.length; i++) selfIdToIdx.set(selfList[i], i);
  const otherIdToIdx = /* @__PURE__ */ new Map();
  for (let j = 0; j < otherList.length; j++) otherIdToIdx.set(otherList[j], j);
  for (let i = 0; i < selfList.length; i++) {
    const src = selfList[i].fromPredicted;
    if (src == null) continue;
    const j = otherIdToIdx.get(src);
    if (j !== void 0) {
      matches.push({ selfIdx: i, otherIdx: j, score: Infinity });
    }
  }
  for (let j = 0; j < otherList.length; j++) {
    const src = otherList[j].fromPredicted;
    if (src == null) continue;
    const i = selfIdToIdx.get(src);
    if (i !== void 0) {
      matches.push({ selfIdx: i, otherIdx: j, score: Infinity });
    }
  }
  return matches;
}
function _resolveAnnotationAuto(selfList, otherList, attr, threshold) {
  const merged = [];
  const usedSelfIndices = /* @__PURE__ */ new Set();
  const memo = /* @__PURE__ */ new Map();
  for (const ann of selfList) {
    if (!ann.isPredicted) {
      merged.push(ann);
    }
  }
  const matches = _findAnnotationLinkMatches(selfList, otherList);
  matches.push(..._findAnnotationMatches(selfList, otherList, attr, threshold));
  matches.sort((a, b) => b.score - a.score);
  const matchedSelf = /* @__PURE__ */ new Set();
  const matchedOther = /* @__PURE__ */ new Set();
  const otherToSelf = /* @__PURE__ */ new Map();
  for (const { selfIdx, otherIdx } of matches) {
    if (!matchedSelf.has(selfIdx) && !matchedOther.has(otherIdx)) {
      otherToSelf.set(otherIdx, selfIdx);
      matchedSelf.add(selfIdx);
      matchedOther.add(otherIdx);
    }
  }
  for (let otherIdx = 0; otherIdx < otherList.length; otherIdx++) {
    const otherAnn = otherList[otherIdx];
    if (otherToSelf.has(otherIdx)) {
      const selfIdx = otherToSelf.get(otherIdx);
      const selfAnn = selfList[selfIdx];
      usedSelfIndices.add(selfIdx);
      if (!selfAnn.isPredicted && !otherAnn.isPredicted) {
      } else if (selfAnn.isPredicted && !otherAnn.isPredicted) {
        merged.push(_copyWithMemo(otherAnn, memo));
      } else if (!selfAnn.isPredicted && otherAnn.isPredicted) {
      } else {
        merged.push(_copyWithMemo(otherAnn, memo));
      }
    } else {
      merged.push(_copyWithMemo(otherAnn, memo));
    }
  }
  for (let selfIdx = 0; selfIdx < selfList.length; selfIdx++) {
    if (selfList[selfIdx].isPredicted && !usedSelfIndices.has(selfIdx)) {
      merged.push(selfList[selfIdx]);
    }
  }
  _relinkFromPredicted(merged, memo);
  return merged;
}
function _resolveAnnotationUpdateTracks(selfList, otherList, attr, threshold) {
  if (attr === "labelImages") return;
  const matches = _findAnnotationMatches(selfList, otherList, attr, threshold);
  const selfToOther = /* @__PURE__ */ new Map();
  for (const { selfIdx, otherIdx, score } of matches) {
    const existing = selfToOther.get(selfIdx);
    if (!existing || score > existing.score) {
      selfToOther.set(selfIdx, { otherIdx, score });
    }
  }
  selfToOther.forEach(({ otherIdx }, selfIdx) => {
    selfList[selfIdx].track = otherList[otherIdx].track;
    selfList[selfIdx].trackingScore = otherList[otherIdx].trackingScore;
  });
}
function _resolveMergedIsNegative(selfNeg, otherNeg, merged) {
  const eitherNeg = selfNeg || otherNeg;
  const hasUserPose = merged.some((inst) => inst.constructor === Instance);
  return [eitherNeg && !hasUserPose, eitherNeg && hasUserPose];
}
var LabeledFrame = class {
  video;
  frameIdx;
  instances;
  isNegative;
  centroids;
  bboxes;
  masks;
  labelImages;
  rois;
  constructor(options) {
    this.video = options.video;
    this.frameIdx = options.frameIdx;
    this.instances = options.instances ?? [];
    this.isNegative = options.isNegative ?? false;
    this.centroids = options.centroids ?? [];
    this.bboxes = options.bboxes ?? [];
    this.masks = options.masks ?? [];
    this.labelImages = options.labelImages ?? [];
    this.rois = options.rois ?? [];
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
    return this.instances.filter(
      (inst) => inst.constructor === Instance
    );
  }
  get predictedInstances() {
    return this.instances.filter(
      (inst) => inst instanceof PredictedInstance
    );
  }
  get hasUserInstances() {
    return this.userInstances.length > 0;
  }
  get hasPredictedInstances() {
    return this.predictedInstances.length > 0;
  }
  /**
   * Whether this frame carries any user-supplied labeling.
   *
   * True if it has at least one user instance, is asserted as a negative
   * (background) frame, or holds any non-predicted frame-level annotation —
   * a user centroid, bounding box, ROI, segmentation mask, or label image.
   * Mirrors Python `LabeledFrame.is_user_labeled` (the ROI clause is the
   * specific contribution of sleap-io PR #509). Predicted annotations alone do
   * not make a frame user-labeled.
   */
  get isUserLabeled() {
    return this.hasUserInstances || this.isNegative || this.centroids.some((c) => !c.isPredicted) || this.bboxes.some((b) => !b.isPredicted) || this.rois.some((r) => !r.isPredicted) || this.masks.some((m) => !m.isPredicted) || this.labelImages.some((li) => !li.isPredicted);
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
      return this.predictedInstances.filter(
        (inst) => !inst.track || !usedTracks.has(inst.track)
      );
    }
    return this.predictedInstances.filter((inst) => !usedPredicted.has(inst));
  }
  /**
   * Predicted masks in this frame that have not been adopted by a user mask.
   *
   * The mask analogue of {@link unusedPredictions}. A prediction is considered
   * adopted (and therefore excluded) when a user mask in the same frame:
   *   1. links to it via `fromPredicted` (checked FIRST, by object identity), or
   *   2. lacking such a link, spatially overlaps it (bbox-centroid within 5 px,
   *      the auto-merge default).
   *
   * Predictions that no user mask claims by either rule are returned, e.g. for
   * surfacing them in a proofreading UI.
   */
  get unusedPredictedMasks() {
    const predicted = this.masks.filter(
      (m) => m instanceof PredictedSegmentationMask
    );
    if (!predicted.length) return [];
    const userMasks = this.masks.filter((m) => !m.isPredicted);
    const adopted = /* @__PURE__ */ new Set();
    for (const u of userMasks) {
      const src = u.fromPredicted;
      if (src != null) adopted.add(src);
    }
    const remaining = predicted.filter((m) => !adopted.has(m));
    if (remaining.length && userMasks.length) {
      const matches = _findAnnotationMatches(
        remaining,
        userMasks,
        "masks",
        5
      );
      for (const { selfIdx } of matches) {
        adopted.add(remaining[selfIdx]);
      }
    }
    return predicted.filter((m) => !adopted.has(m));
  }
  removePredictions() {
    this.instances = this.instances.filter(
      (inst) => !(inst instanceof PredictedInstance)
    );
    this.centroids = this.centroids.filter((c) => !c.isPredicted);
    this.bboxes = this.bboxes.filter((b) => !b.isPredicted);
    this.masks = this.masks.filter((m) => !m.isPredicted);
    this.labelImages = this.labelImages.filter((li) => !li.isPredicted);
    this.rois = this.rois.filter((r) => !r.isPredicted);
  }
  /**
   * Merge annotation lists from another frame into this frame.
   *
   * Shallow-copies annotations from the other frame to avoid mutating the
   * source when references are later remapped. Video and track references
   * are preserved so that remapping can find them in the mapping dicts.
   *
   * @param other - The frame to merge annotations from.
   * @param strategy - The merge strategy. Controls which annotations are kept:
   *   - "keep_original": Keep self only.
   *   - "keep_new": Replace with other's annotations.
   *   - "keep_both": Keep self + add other's (default).
   *   - "replace_predictions": Keep user from self, add predicted from other.
   *   - "auto": Spatial matching + user-vs-predicted resolution cascade.
   *   - "update_tracks": Spatial matching, then update track assignments.
   * @param threshold - Maximum centroid distance (pixels) for spatial matching
   *   in "auto" and "update_tracks" strategies.
   */
  mergeAnnotations(other, strategy = "keep_both", threshold = 5) {
    if (strategy === "keep_original") {
      return;
    }
    if (strategy === "keep_new") {
      for (const attr of ANNOTATION_ATTRS) {
        const memo = /* @__PURE__ */ new Map();
        const newList = other[attr].map(
          (item) => _copyWithMemo(item, memo)
        );
        _relinkFromPredicted(newList, memo);
        this[attr] = newList;
      }
      return;
    }
    if (strategy === "replace_predictions") {
      for (const attr of ANNOTATION_ATTRS) {
        const memo = /* @__PURE__ */ new Map();
        const kept = this[attr].filter((a) => !a.isPredicted);
        for (const item of other[attr]) {
          if (item.isPredicted) {
            kept.push(_copyWithMemo(item, memo));
          }
        }
        _relinkFromPredicted(kept, memo);
        this[attr] = kept;
      }
      return;
    }
    if (strategy === "auto") {
      for (const attr of ANNOTATION_ATTRS) {
        this[attr] = _resolveAnnotationAuto(
          this[attr],
          other[attr],
          attr,
          threshold
        );
      }
      return;
    }
    if (strategy === "update_tracks") {
      for (const attr of ANNOTATION_ATTRS) {
        _resolveAnnotationUpdateTracks(
          this[attr],
          other[attr],
          attr,
          threshold
        );
      }
      return;
    }
    for (const attr of ANNOTATION_ATTRS) {
      const memo = /* @__PURE__ */ new Map();
      const target = this[attr];
      const existing = new Set(target);
      for (const item of other[attr]) {
        if (!existing.has(item)) {
          target.push(_copyWithMemo(item, memo));
        }
      }
      _relinkFromPredicted(target, memo);
    }
  }
  /**
   * Merge instances from another frame into this frame
   * (labeled_frame.py:530-702).
   *
   * The merged instance list is RETURNED (not assigned back) so the caller can
   * decide what to do with it. Frame-level annotations (centroids, bboxes,
   * masks, label images, rois) and the `isNegative` flag ARE updated on this
   * frame in place.
   *
   * Instances added from `other` (in the auto/replace/update strategies) are
   * the ORIGINAL `other` objects, NOT copies, so they alias the other frame's
   * instances. Skeleton/track remap of merged instances is handled by the
   * `Labels.merge` driver, not here.
   *
   * @param other - Another LabeledFrame to merge instances from.
   * @param opts.instance - Matcher to use for finding duplicate instances. If
   *   omitted, uses default spatial matching with 5px tolerance.
   * @param opts.frame - The merge strategy string (default `"auto"`). One of:
   *   `"auto"`, `"keep_original"`, `"keep_new"`, `"keep_both"`,
   *   `"update_tracks"`, `"replace_predictions"`. Any other string falls
   *   through to the auto branch.
   * @returns A tuple `[mergedInstances, conflicts]` where `conflicts` is a list
   *   of `[selfInst, otherInst, resolution]` tuples.
   */
  merge(other, opts = {}) {
    const instanceMatcher = opts.instance ?? new InstanceMatcher(InstanceMatchMethod.SPATIAL, { threshold: 5 });
    const frame = opts.frame ?? "auto";
    const conflicts = [];
    if (frame === "keep_original") {
      this.mergeAnnotations(other, "keep_original");
      [this.isNegative] = _resolveMergedIsNegative(
        this.isNegative,
        other.isNegative,
        this.instances
      );
      return [this.instances.slice(), conflicts];
    } else if (frame === "keep_new") {
      this.mergeAnnotations(other, "keep_new");
      [this.isNegative] = _resolveMergedIsNegative(
        this.isNegative,
        other.isNegative,
        other.instances
      );
      return [other.instances.slice(), conflicts];
    } else if (frame === "keep_both") {
      this.mergeAnnotations(other, "keep_both");
      [this.isNegative] = _resolveMergedIsNegative(
        this.isNegative,
        other.isNegative,
        this.instances.concat(other.instances)
      );
      return [this.instances.concat(other.instances), conflicts];
    } else if (frame === "update_tracks") {
      const matches2 = instanceMatcher.findMatches(
        this.instances,
        other.instances
      );
      for (const [selfIdx, otherIdx] of matches2) {
        this.instances[selfIdx].track = other.instances[otherIdx].track;
        this.instances[selfIdx].trackingScore = other.instances[otherIdx].trackingScore;
      }
      this.mergeAnnotations(other, "update_tracks", instanceMatcher.threshold);
      [this.isNegative] = _resolveMergedIsNegative(
        this.isNegative,
        other.isNegative,
        this.instances
      );
      return [this.instances, conflicts];
    } else if (frame === "replace_predictions") {
      const merged = this.instances.filter(
        (inst) => inst.constructor === Instance
      );
      for (const inst of other.instances) {
        if (inst.constructor === PredictedInstance) {
          merged.push(inst);
        }
      }
      this.mergeAnnotations(other, "replace_predictions");
      [this.isNegative] = _resolveMergedIsNegative(
        this.isNegative,
        other.isNegative,
        merged
      );
      return [merged, []];
    }
    const mergedInstances = [];
    const usedIndices = /* @__PURE__ */ new Set();
    for (const inst of this.instances) {
      if (inst.constructor === Instance) {
        mergedInstances.push(inst);
      }
    }
    const matches = instanceMatcher.findMatches(
      this.instances,
      other.instances
    );
    const otherToSelf = /* @__PURE__ */ new Map();
    for (const [selfIdx, otherIdx, score] of matches) {
      const existing = otherToSelf.get(otherIdx);
      if (existing === void 0 || score > existing[1]) {
        otherToSelf.set(otherIdx, [selfIdx, score]);
      }
    }
    for (let otherIdx = 0; otherIdx < other.instances.length; otherIdx++) {
      const otherInst = other.instances[otherIdx];
      const entry = otherToSelf.get(otherIdx);
      if (entry !== void 0) {
        const selfIdx = entry[0];
        const selfInst = this.instances[selfIdx];
        const su = selfInst.constructor === Instance;
        const ou = otherInst.constructor === Instance;
        if (su && ou) {
          conflicts.push([selfInst, otherInst, "kept_original"]);
          usedIndices.add(selfIdx);
        } else if (!su && ou) {
          if (!usedIndices.has(selfIdx)) {
            mergedInstances.push(otherInst);
            usedIndices.add(selfIdx);
          }
        } else if (su && !ou) {
          conflicts.push([selfInst, otherInst, "kept_user"]);
          usedIndices.add(selfIdx);
        } else {
          if (!usedIndices.has(selfIdx)) {
            mergedInstances.push(otherInst);
            usedIndices.add(selfIdx);
          }
        }
      } else {
        mergedInstances.push(otherInst);
      }
    }
    for (let selfIdx = 0; selfIdx < this.instances.length; selfIdx++) {
      const selfInst = this.instances[selfIdx];
      if (selfInst.constructor === PredictedInstance && !usedIndices.has(selfIdx)) {
        let keep = true;
        for (const [matchedSelfIdx] of otherToSelf.values()) {
          if (matchedSelfIdx === selfIdx) {
            keep = false;
            break;
          }
        }
        if (keep) {
          mergedInstances.push(selfInst);
        }
      }
    }
    this.mergeAnnotations(other, "auto", instanceMatcher.threshold);
    [this.isNegative] = _resolveMergedIsNegative(
      this.isNegative,
      other.isNegative,
      mergedInstances
    );
    return [mergedInstances, conflicts];
  }
  /**
   * Append an annotation to this frame, routing to the correct list by type.
   *
   * @param annotation - Any annotation type: Instance, PredictedInstance,
   *   Centroid, BoundingBox, SegmentationMask, LabelImage, or ROI.
   * @throws TypeError if the annotation type is not recognized.
   */
  append(annotation) {
    if (annotation instanceof PredictedInstance || annotation instanceof Instance) {
      this.instances.push(annotation);
    } else if (annotation instanceof Centroid) {
      this.centroids.push(annotation);
    } else if (annotation instanceof BoundingBox) {
      this.bboxes.push(annotation);
    } else if (annotation instanceof SegmentationMask) {
      this.masks.push(annotation);
    } else if (annotation instanceof LabelImage) {
      this.labelImages.push(annotation);
    } else if (annotation instanceof ROI) {
      this.rois.push(annotation);
    } else {
      throw new TypeError(
        `Unknown annotation type: ${annotation.constructor?.name ?? typeof annotation}`
      );
    }
  }
  removeEmptyInstances() {
    this.instances = this.instances.filter((inst) => !inst.isEmpty);
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

// src/transform/frame.ts
function isImageData(frame) {
  return frame.channels === void 0;
}
function isImageBitmap(value) {
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    return true;
  }
  const v = value;
  return v != null && typeof v.width === "number" && typeof v.height === "number" && typeof v.close === "function" && v.data === void 0;
}
function frameInfo(frame) {
  if (isImageData(frame)) {
    return {
      data: frame.data,
      width: frame.width,
      height: frame.height,
      channels: 4
    };
  }
  return {
    data: frame.data,
    width: frame.width,
    height: frame.height,
    channels: frame.channels ?? 1
  };
}
function resolveFill(fill, channels) {
  if (Array.isArray(fill)) {
    if (fill.length === channels) return [...fill];
    if (fill.length === 1) return new Array(channels).fill(fill[0]);
    const out = new Array(channels);
    for (let c = 0; c < channels; c++) {
      out[c] = c < fill.length ? fill[c] : fill[fill.length - 1] ?? 0;
    }
    return out;
  }
  return new Array(channels).fill(fill);
}
function asImageData(data, width, height) {
  if (typeof globalThis !== "undefined" && typeof globalThis.ImageData !== "undefined") {
    return new ImageData(data, width, height);
  }
  return { data, width, height, colorSpace: "srgb" };
}
function cropFrame(frame, crop, fill = 0) {
  if (isImageBitmap(frame)) {
    throw new Error(
      "cropFrame cannot crop a raw ImageBitmap: its pixels are not synchronously readable. Rasterize it to an ImageData (e.g. via OffscreenCanvas or skia-canvas) before cropping. This is handled by CropVideoBackend.getFrame."
    );
  }
  const { data, width: w, height: h, channels } = frameInfo(frame);
  const [x1, y1, x2, y2] = crop;
  const cropW = x2 - x1;
  const cropH = y2 - y1;
  const srcX1 = Math.max(0, x1);
  const srcY1 = Math.max(0, y1);
  const srcX2 = Math.max(srcX1, Math.min(w, x2));
  const srcY2 = Math.max(srcY1, Math.min(h, y2));
  const fills = resolveFill(fill, channels);
  const needsPad = x1 < 0 || y1 < 0 || x2 > w || y2 > h;
  const outLen = cropW * cropH * channels;
  const out = data instanceof Uint8ClampedArray ? new Uint8ClampedArray(outLen) : new Uint8Array(outLen);
  if (needsPad) {
    for (let i = 0; i < outLen; i += channels) {
      for (let c = 0; c < channels; c++) out[i + c] = fills[c];
    }
  }
  const pasteX1 = srcX1 - x1;
  const pasteY1 = srcY1 - y1;
  const sliceW = srcX2 - srcX1;
  const sliceH = srcY2 - srcY1;
  for (let row = 0; row < sliceH; row++) {
    const srcRowStart = ((srcY1 + row) * w + srcX1) * channels;
    const dstRowStart = ((pasteY1 + row) * cropW + pasteX1) * channels;
    const rowLen = sliceW * channels;
    out.set(data.subarray(srcRowStart, srcRowStart + rowLen), dstRowStart);
  }
  if (isImageData(frame)) {
    return asImageData(out, cropW, cropH);
  }
  return { data: out, width: cropW, height: cropH, channels };
}

// src/transform/points.ts
function offsetFlat(points, dx, dy) {
  if (Array.isArray(points)) {
    const out2 = points.slice();
    for (let i = 0; i + 1 < out2.length; i += 2) {
      out2[i] = points[i] + dx;
      out2[i + 1] = points[i + 1] + dy;
    }
    return out2;
  }
  const typed = points;
  const out = typed.slice();
  for (let i = 0; i + 1 < out.length; i += 2) {
    out[i] = typed[i] + dx;
    out[i + 1] = typed[i + 1] + dy;
  }
  return out;
}
function offsetPairs(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}
function cropPoints(points, crop) {
  const [x1, y1] = crop;
  if (isPairs(points)) {
    return offsetPairs(points, -x1, -y1);
  }
  return offsetFlat(points, -x1, -y1);
}
function uncropPoints(points, crop) {
  const [x1, y1] = crop;
  if (isPairs(points)) {
    return offsetPairs(points, x1, y1);
  }
  return offsetFlat(points, x1, y1);
}
function isPairs(points) {
  return Array.isArray(points) && points.length > 0 && Array.isArray(points[0]);
}

// src/video/image-decode.ts
async function rasterizeBitmap(bitmap) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context to rasterize a frame");
    }
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  try {
    const sc = await import("skia-canvas");
    const Canvas = sc.Canvas;
    const canvas = new Canvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } catch (err) {
    throw new Error(
      `Rasterizing a frame returned as an ImageBitmap requires an image rasterizer (a browser with OffscreenCanvas, or the optional \`skia-canvas\` package on Node). Original error: ${err.message}`
    );
  }
}
async function decodeEncoded(bytes) {
  if (typeof createImageBitmap !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    const safe = new Uint8Array(bytes);
    const bitmap = await createImageBitmap(new Blob([safe.buffer]));
    return rasterizeBitmap(bitmap);
  }
  try {
    const sc = await import("skia-canvas");
    const src = typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
    const img = await sc.loadImage(src);
    const Canvas = sc.Canvas;
    const canvas = new Canvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } catch (err) {
    throw new Error(
      `Decoding undecoded JPEG/PNG image bytes requires an image decoder (a browser, or the optional \`skia-canvas\` package on Node). Original error: ${err.message}`
    );
  }
}

// src/video/crop-backend.ts
function normFill(fill) {
  if (Array.isArray(fill)) {
    return "[" + fill.map((v) => String(Math.trunc(v))).join(",") + "]";
  }
  return String(Math.trunc(fill));
}
function isImageBitmap2(value) {
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    return true;
  }
  const v = value;
  return v != null && typeof v.width === "number" && typeof v.height === "number" && typeof v.close === "function" && v.data === void 0;
}
function isImageDataLike(value) {
  const v = value;
  return v != null && typeof v.width === "number" && typeof v.height === "number" && (v.data instanceof Uint8ClampedArray || v.data instanceof Uint8Array);
}
function isEncodedBytes(bytes) {
  if (bytes.length < 4) return false;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  return jpeg || png;
}
var CropVideoBackend = class _CropVideoBackend {
  /** Derived from `inner.filename`. */
  filename;
  /**
   * The wrapped source backend. Decodes full frames; this wrapper crops them.
   * Invariant: `inner` is never itself a `CropVideoBackend` (enforced by
   * {@link wrap}).
   */
  inner;
  /** Crop region `[x1, y1, x2, y2]`, x2/y2 exclusive (source px, may be OOB). */
  crop;
  /** Fill value for out-of-bounds regions, forwarded to `cropFrame`. */
  fill;
  /**
   * Whether this wrapper owns the inner backend's decode handle. When `true`
   * (the default), {@link close} cascades to `inner.close()`; when `false` (a
   * shared-decode mosaic tile), it does not, so closing one tile does not tear
   * down siblings sharing the inner.
   */
  ownsInner;
  /**
   * Private-by-convention constructor: prefer {@link CropVideoBackend.wrap},
   * which enforces the flatten law and the "inner is never a crop" invariant.
   */
  constructor(inner, crop, fill, ownsInner) {
    this.inner = inner;
    this.crop = [
      Math.trunc(crop[0]),
      Math.trunc(crop[1]),
      Math.trunc(crop[2]),
      Math.trunc(crop[3])
    ];
    this.fill = Array.isArray(fill) ? fill.map((v) => Math.trunc(v)) : fill;
    this.ownsInner = ownsInner;
    this.filename = inner.filename;
  }
  /**
   * Wrap `inner` in a crop view, flattening crop-of-crop when safe.
   *
   * Flattens (composes into a single wrapper) ONLY when `inner` is itself a
   * `CropVideoBackend`, the fills agree, AND the outer crop lies fully within
   * the inner cropped frame `[0, iw] x [0, ih]` (`iw = ix2 - ix1`,
   * `ih = iy2 - iy1`). Otherwise it nests, preserving byte-parity:
   *
   * - Different fills: the inner crop's materialized pad of value `inner.fill`
   *   would be silently replaced after a flatten.
   * - Outer crop exceeds the inner frame: a flatten would read real source
   *   pixels where the nested view pads with `fill`.
   *
   * The flatten composition law expresses the outer rect in source coordinates:
   * `(ix1 + ox1, iy1 + oy1, ix1 + ox2, iy1 + oy2)`. A flattened `inner` is
   * always unwrapped to `inner.inner` so the "inner is never a crop" invariant
   * holds.
   */
  static wrap(options) {
    let { inner } = options;
    let crop = [
      Math.trunc(options.crop[0]),
      Math.trunc(options.crop[1]),
      Math.trunc(options.crop[2]),
      Math.trunc(options.crop[3])
    ];
    const fill = options.fill ?? 0;
    const ownsInner = options.ownsInner ?? true;
    if (inner instanceof _CropVideoBackend && normFill(inner.fill) === normFill(fill)) {
      const [ix1, iy1, ix2, iy2] = inner.crop;
      const [ox1, oy1, ox2, oy2] = crop;
      const iw = ix2 - ix1;
      const ih = iy2 - iy1;
      if (0 <= ox1 && 0 <= oy1 && ox2 <= iw && oy2 <= ih) {
        crop = [ix1 + ox1, iy1 + oy1, ix1 + ox2, iy1 + oy2];
        inner = inner.inner;
      }
    }
    return new _CropVideoBackend(inner, crop, fill, ownsInner);
  }
  /** Inner backend's dataset name (delegated; `null`/`undefined` if absent). */
  get dataset() {
    return this.inner.dataset;
  }
  /** Inner backend's frame rate (delegated). */
  get fps() {
    return this.inner.fps;
  }
  /**
   * Inner backend's embedded frame numbers (delegated). A crop is spatial and
   * frame-preserving, so the embedded set is exactly the inner's. Without this,
   * a cropped `pkg.slp` would report no embedded set (see {@link VideoBackend.frameNumbers}).
   */
  get frameNumbers() {
    return this.inner.frameNumbers;
  }
  /**
   * Cropped frame shape `[F, h, w, c]`.
   *
   * Frame count and channel count come from the inner (a crop is spatial and
   * channel-preserving); height/width are the crop extents. Returns `undefined`
   * only when the inner has no resolved shape.
   */
  get shape() {
    const innerShape = this.inner.shape;
    if (!innerShape) return void 0;
    const [x1, y1, x2, y2] = this.crop;
    return [innerShape[0], y2 - y1, x2 - x1, innerShape[3]];
  }
  /**
   * Read a single cropped frame.
   *
   * First attempts crop pushdown: if the inner backend implements the optional
   * {@link VideoBackend.readCrop} hook (Item 1 of JS issue #153, mirroring
   * Python `_source_frame`, `video_reading.py:2392`) it is given the chance to
   * read only the crop region directly from storage. A non-null result is
   * already cropped/padded and is byte-identical to the fallback, so it is
   * returned as-is. `null` (the default for every shipping backend — encoded
   * blobs / per-frame rows cannot be spatially hyperslabbed) means fall back.
   *
   * Fallback: decode the inner full frame, normalize it to readable pixels
   * (rasterizing an opaque `ImageBitmap`, decoding undecoded encoded bytes, or
   * wrapping raw pixel bytes), then apply {@link cropFrame} with this wrapper's
   * crop/fill. Returns `null` when the inner returns `null` (no such frame).
   */
  async getFrame(frameIndex, opts) {
    if (typeof this.inner.readCrop === "function") {
      const pushed = await this.inner.readCrop(
        frameIndex,
        this.crop,
        this.fill
      );
      if (pushed != null) return pushed;
    }
    const src = await this.inner.getFrame(frameIndex, opts);
    if (src == null) return null;
    const readable = await this.toReadable(src);
    return cropFrame(readable, this.crop, this.fill);
  }
  /**
   * Normalize any {@link VideoFrame} into something {@link cropFrame} can read
   * pixels from synchronously: an `ImageData` or a {@link RawFrame}.
   *
   * - `ImageData`-shaped: returned as-is.
   * - `ImageBitmap`: rasterized to `ImageData` (OffscreenCanvas / skia-canvas).
   * - Encoded bytes (PNG/JPEG): decoded to `ImageData`.
   * - Raw pixel bytes: wrapped as a {@link RawFrame} using the inner shape's
   *   width/height/channels.
   */
  async toReadable(frame) {
    if (isImageBitmap2(frame)) {
      return rasterizeBitmap(frame);
    }
    if (isImageDataLike(frame)) {
      return frame;
    }
    const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame;
    if (isEncodedBytes(bytes)) {
      return decodeEncoded(bytes);
    }
    const innerShape = this.inner.shape;
    if (!innerShape) {
      throw new Error(
        "CropVideoBackend.getFrame received raw pixel bytes but the inner backend has no resolved shape to interpret them. Provide a shape on the inner backend, or use a backend that returns decoded frames."
      );
    }
    const [, height, width, channels] = innerShape;
    const raw = {
      data: bytes,
      width,
      height,
      channels
    };
    return raw;
  }
  /** Inner backend's per-frame presentation times (delegated; a crop is spatial). */
  async getFrameTimes() {
    if (typeof this.inner.getFrameTimes === "function") {
      return this.inner.getFrameTimes();
    }
    return null;
  }
  toCropCoords(points) {
    return cropPoints(points, this.crop);
  }
  toSourceCoords(points) {
    return uncropPoints(points, this.crop);
  }
  /**
   * Release this wrapper's handle and the inner's, if owned.
   *
   * Cascades to `inner.close()` only when {@link ownsInner} (a shared-decode
   * mosaic tile leaves the shared inner open for its siblings).
   */
  close() {
    if (this.ownsInner) {
      this.inner.close();
    }
  }
};

// src/model/video.ts
var EXISTS_TTL_MS = 6e4;
function resolveCropRect(crop, opts = {}) {
  const { bbox, roi, center, size, margin = 0 } = opts;
  if (center == null !== (size == null)) {
    throw new Error(
      `center and size must be provided together for a centered window; got center=${JSON.stringify(center)}, size=${JSON.stringify(size)}.`
    );
  }
  const hasCenterSize = center != null && size != null;
  const nSpecs = (crop != null ? 1 : 0) + (bbox != null ? 1 : 0) + (roi != null ? 1 : 0) + (hasCenterSize ? 1 : 0);
  if (nSpecs !== 1) {
    throw new Error(
      `Exactly one of {crop, bbox, roi, (center, size)} must be provided to specify a crop region, got ${nSpecs}. For a centered window, pass both center and size.`
    );
  }
  let x1;
  let y1;
  let x2;
  let y2;
  if (crop != null) {
    x1 = Math.trunc(crop[0]);
    y1 = Math.trunc(crop[1]);
    x2 = Math.trunc(crop[2]);
    y2 = Math.trunc(crop[3]);
  } else if (bbox != null) {
    const [bx1, by1, bx2, by2] = bbox;
    x1 = Math.floor(bx1);
    y1 = Math.floor(by1);
    x2 = Math.ceil(bx2);
    y2 = Math.ceil(by2);
  } else if (roi != null) {
    const [minx, miny, maxx, maxy] = roi.bounds;
    x1 = Math.floor(minx) - margin;
    y1 = Math.floor(miny) - margin;
    x2 = Math.ceil(maxx) + margin;
    y2 = Math.ceil(maxy) + margin;
  } else {
    const [cx, cy] = center;
    const [w, h] = size;
    x1 = Math.round(cx - w / 2);
    y1 = Math.round(cy - h / 2);
    x2 = x1 + Math.round(w);
    y2 = y1 + Math.round(h);
  }
  if (x2 < x1 || y2 < y1) {
    throw new Error(
      `Inverted crop rect: x2 (${x2}) < x1 (${x1}) or y2 (${y2}) < y1 (${y1}). Crop bounds must satisfy x2 >= x1 and y2 >= y1.`
    );
  }
  return [x1, y1, x2, y2];
}
var Video = class _Video {
  filename;
  backend;
  /** Set when the backend failed to open during load (then `backend` is null). */
  backendError;
  backendMetadata;
  sourceVideo;
  openBackend;
  _embedded;
  _shape = null;
  _fps = null;
  /** Auth headers persisted from a remote `.slp` load (mirror Python `_url_headers`). */
  _urlHeaders;
  /** Per-instance TTL cache for {@link exists}. */
  _existsCache;
  constructor(options) {
    this.filename = options.filename;
    this.backend = options.backend ?? null;
    this.backendError = options.backendError ?? null;
    this.backendMetadata = options.backendMetadata ?? {};
    this.sourceVideo = options.sourceVideo ?? null;
    this.openBackend = options.openBackend ?? true;
    this._embedded = options.embedded ?? false;
  }
  get hasEmbeddedImages() {
    return this._embedded;
  }
  /**
   * Sorted, de-duplicated source frame numbers that have an available image, or
   * `null` when every frame is available (continuous video) or the set is
   * unknown / the backend is closed. For an embedded-image video (`pkg.slp`)
   * the backend exposes the stored `frame_numbers`; callers should treat `null`
   * as "no restriction" (all frames imaged).
   */
  get embeddedFrameIndices() {
    const nums = this.backend?.frameNumbers;
    if (!nums || nums.length === 0) return null;
    return [...new Set(nums)].sort((a, b) => a - b);
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
  async getFrame(frameIndex, opts) {
    if (!this.backend) return null;
    return this.backend.getFrame(frameIndex, opts);
  }
  async getFrameTimes() {
    if (!this.backend?.getFrameTimes) return null;
    return this.backend.getFrameTimes();
  }
  close() {
    this.backend?.close();
  }
  /**
   * Persist the remote auth headers from a remote `.slp` load so later
   * {@link exists} probes (and any URL-backed backend) stay authenticated.
   * Mirrors Python's `HDF5Video._url_headers`. Internal — set by the SLP reader.
   * @internal
   */
  _setUrlPersistence(persistence) {
    if (persistence.headers) this._urlHeaders = persistence.headers;
  }
  /**
   * The auth headers to use for remote requests on this video, preferring the
   * value persisted on this `Video`, then any persisted on the backend. Mirrors
   * Python `Video._backend_url_headers`.
   * @internal
   */
  _backendUrlHeaders() {
    return this._urlHeaders ?? // Python-parity placeholder: no JS backend currently sets `_urlHeaders`,
    // so this fallback is inert today. Kept so a future URL-backed backend
    // that carries its own headers (as Python's HDF5Video does) is honored
    // without changing this accessor.
    this.backend?._urlHeaders;
  }
  /**
   * Non-throwing check that this video's source is reachable.
   *
   * For a URL filename, probes with HEAD (falling back to a `Range: bytes=0-0`
   * GET), forwarding any persisted auth headers, and caches the result
   * per-instance for {@link EXISTS_TTL_MS}. Never throws (a probe failure → a
   * cached `false`). For a non-URL (local/embedded) filename, this returns
   * `true` only when a backend is present (the JS port has no generic
   * filesystem stat); callers needing real local existence should use a Node
   * file check.
   *
   * Port of Python `Video.exists`.
   */
  async exists() {
    const filename = this.filename;
    if (Array.isArray(filename) || !isUrl(filename)) {
      return this.backend != null;
    }
    const dataset = this.backendMetadata?.dataset ?? "";
    const key = `${filename}\0${dataset}`;
    const now = Date.now();
    if (this._existsCache && this._existsCache.key === key && this._existsCache.expiresAt > now) {
      return this._existsCache.value;
    }
    const value = await headOrRangeProbe(filename, {
      headers: this._backendUrlHeaders()
    });
    this._existsCache = { key, value, expiresAt: now + EXISTS_TTL_MS };
    return value;
  }
  /**
   * Return a virtual, on-read cropped view of this video.
   *
   * Port of Python `Video.crop` (video.py:304-389). Exactly one region spec must
   * be given: an explicit `crop` rect (the positional argument), or one of
   * `bbox` / `roi` / (`center` + `size`) via {@link CropOptions}. The returned
   * `Video` shares no pixels with this one; frames are decoded on read and
   * cropped, with out-of-bounds regions pad-filled with `fill` (never clamped),
   * so the output shape is always exactly `[y2 - y1, x2 - x1]`.
   *
   * The crop composes (FLATTENS when fills agree and the region is in-bounds)
   * with any existing crop via {@link CropVideoBackend.wrap}. `sourceVideo` is
   * set to this video for provenance, and `backendMetadata` is seeded with the
   * cropped `shape`, the uncropped `source_shape`, the composed `crop` rect, and
   * `crop_fill` so a closed re-serialize and a close/open round-trip keep the
   * crop. When `shareDecode` (the default), the new crop reuses this video's
   * backend as the shared inner (the new tile does NOT own the decoder).
   *
   * @param crop Explicit crop region `[x1, y1, x2, y2]`, x2/y2 exclusive.
   * @param opts One of `bbox` / `roi` / (`center` + `size`), plus `margin`,
   *   `fill`, and `shareDecode`.
   * @returns A new `Video` exposing the cropped view.
   * @throws Error If there is no backend to crop, or the region spec is invalid.
   */
  crop(crop, opts = {}) {
    const rect = resolveCropRect(crop, opts);
    if (this.backend == null) {
      throw new Error(
        "Cannot crop a video with no open backend. Provide a backend (the JS port has no filesystem auto-open) before cropping."
      );
    }
    const fill = opts.fill ?? 0;
    const shareDecode = opts.shareDecode ?? true;
    const inner = this.backend;
    const croppedBackend = CropVideoBackend.wrap({
      inner,
      crop: rect,
      fill,
      ownsInner: !shareDecode
    });
    const [x1, y1, x2, y2] = croppedBackend.crop;
    const srcShape = this.shape;
    const cropped = new _Video({
      filename: this.filename,
      backend: croppedBackend,
      sourceVideo: this,
      openBackend: this.openBackend
    });
    cropped.backendMetadata = {
      ...this.backendMetadata,
      shape: srcShape != null ? [srcShape[0], y2 - y1, x2 - x1, srcShape[3]] : null,
      // The uncropped source shape, so a closed re-serialize keeps videos_json
      // describing the full frame even without a live sourceVideo.
      source_shape: srcShape != null ? [...srcShape] : null,
      // COMPOSED source rect from wrap: keeps open/closed crop keys identical and
      // root-canonical, and survives close()->open().
      crop: [...croppedBackend.crop],
      crop_fill: croppedBackend.fill
    };
    return cropped;
  }
  /**
   * Crop a `Video` and return a virtual cropped view.
   *
   * Port of Python `Video.from_crop` (video.py:391-440). Accepts the same region
   * specs as {@link crop}. Unlike Python (which can open a path via
   * `from_filename`), the JS port has no generic filesystem-backed open facade,
   * so `video` must already be a `Video` with a backend; passing a path string
   * throws.
   *
   * @param video An existing `Video` to crop.
   * @param crop Explicit crop region `[x1, y1, x2, y2]`, x2/y2 exclusive.
   * @param opts One of `bbox` / `roi` / (`center` + `size`), plus `margin`,
   *   `fill`, and `shareDecode`.
   * @returns A new `Video` exposing the cropped view.
   * @throws Error If `video` is a path string (unsupported in the JS port).
   */
  static fromCrop(video, crop, opts = {}) {
    if (typeof video === "string") {
      throw new Error(
        "Video.fromCrop does not support opening a path string in the JS port (there is no filesystem auto-open). Construct a Video with a backend first, then call Video.fromCrop(video, ...) or video.crop(...)."
      );
    }
    return video.crop(crop, opts);
  }
  /**
   * Return this video's crop rect `[x1, y1, x2, y2]` or `null`.
   *
   * Port of Python `Video._crop_tuple` (video.py:442-454). Reads `backend.crop`
   * when the backend is a {@link CropVideoBackend} (open path), else
   * `backendMetadata.crop` (closed path), else `null` (uncropped).
   */
  _cropTuple() {
    if (this.backend instanceof CropVideoBackend) {
      return [...this.backend.crop];
    }
    const crop = this.backendMetadata.crop;
    return crop != null ? [...crop] : null;
  }
  /**
   * Return this video's crop fill value (open: backend; closed: metadata).
   *
   * Port of Python `Video._crop_fill` (video.py:456-465). Returns `0` for an
   * uncropped video.
   */
  _cropFill() {
    if (this.backend instanceof CropVideoBackend) {
      return this.backend.fill;
    }
    const fill = this.backendMetadata.crop_fill;
    return fill ?? 0;
  }
  /** Whether this video is a virtual crop of another video. */
  get isCropped() {
    return this._cropTuple() !== null;
  }
  /** Crop rect `[x1, y1, x2, y2]` in source coords, or `null` if uncropped. */
  get cropRect() {
    return this._cropTuple();
  }
  /** The out-of-bounds fill value for this video's crop (`0` if uncropped). */
  get cropFill() {
    return this._cropFill();
  }
  toCropCoords(points) {
    const crop = this._cropTuple();
    if (crop === null) {
      return copyPoints(points);
    }
    return cropPoints(points, crop);
  }
  toSourceCoords(points) {
    const crop = this._cropTuple();
    if (crop === null) {
      return copyPoints(points);
    }
    return uncropPoints(points, crop);
  }
  /**
   * Check if this video has the same path as another video.
   *
   * Port of Python `Video.matches_path` (video.py:637-715). The public default
   * is kept at `strict = true` (DECISIONS D1) because every merge/match call
   * site passes `strict` explicitly, so the default is never load-bearing for
   * parity; the LOGIC below mirrors Python exactly.
   *
   * @param other - Another video to compare with.
   * @param strict - If `true`, require an exact (posix-normalized) path match.
   *   If `false`, consider videos with the same basename as matching.
   */
  matchesPath(other, strict = true) {
    const selfIsHdf5 = isHdf5Video(this);
    const otherIsHdf5 = isHdf5Video(other);
    if (selfIsHdf5 && otherIsHdf5) {
      const selfSource = hdf5SourceFilename(this);
      const otherSource = hdf5SourceFilename(other);
      const selfDataset = hdf5Dataset(this);
      const otherDataset = hdf5Dataset(other);
      if (selfDataset !== null && otherDataset !== null) {
        if (selfDataset !== otherDataset) {
          return false;
        }
      }
      if (selfSource !== null && otherSource !== null) {
        if (strict) {
          return toPosix(selfSource) === toPosix(otherSource);
        }
        return basename2(selfSource) === basename2(otherSource);
      }
      if (selfDataset !== null && otherDataset !== null) {
        return selfDataset === otherDataset;
      }
      return false;
    }
    const selfIsList = Array.isArray(this.filename);
    const otherIsList = Array.isArray(other.filename);
    if (selfIsList && otherIsList) {
      const selfList = this.filename;
      const otherList = other.filename;
      if (strict) {
        return arraysEqual(selfList, otherList);
      }
      return arraysEqual(selfList.map(basename2), otherList.map(basename2));
    }
    if (selfIsList || otherIsList) {
      return false;
    }
    const selfName = this.filename;
    const otherName = other.filename;
    if (strict) {
      return toPosix(selfName) === toPosix(otherName);
    }
    return basename2(selfName) === basename2(otherName);
  }
  /**
   * Check if this video has the same content as another video.
   *
   * Port of Python `Video.matches_content` (video.py:717-742). Compares the
   * FULL 4-tuple shape (frames, height, width, channels) and the backend type
   * name, NOT actual frame data.
   *
   * @param other - Another video to compare with.
   * @returns `true` if the videos have the same shape and backend type.
   */
  matchesContent(other) {
    if (!shapeTupleEqual(this.shape, other.shape)) {
      return false;
    }
    if (this.backend === null && other.backend === null) {
      return true;
    }
    if (this.backend === null || other.backend === null) {
      return false;
    }
    return backendTypeName(this) === backendTypeName(other);
  }
  /**
   * Check if this video has the same shape as another video.
   *
   * Port of Python `Video.matches_shape` (video.py:744-772). Compares only
   * height, width, and channels (INCLUDING channels, EXCLUDING frames).
   *
   * @param other - Another video to compare with.
   * @returns `true` if the videos have the same height, width, and channels.
   */
  matchesShape(other) {
    const selfShape = this.backend === null && hasOwn(this.backendMetadata, "shape") ? this.backendMetadata.shape : this.shape;
    const otherShape = other.backend === null && hasOwn(other.backendMetadata, "shape") ? other.backendMetadata.shape : other.shape;
    if (selfShape == null || otherShape == null) {
      return false;
    }
    return selfShape.length === otherShape.length && selfShape[1] === otherShape[1] && selfShape[2] === otherShape[2] && selfShape[3] === otherShape[3];
  }
  /**
   * Check if this video has overlapping images with another video.
   *
   * Port of Python `Video.has_overlapping_images` (video.py:774-799). Only
   * meaningful for image sequences (list filenames); compares basenames.
   *
   * @param other - Another video to compare with.
   * @returns `true` if both are image sequences with at least one shared
   *   image basename, `false` otherwise.
   */
  hasOverlappingImages(other) {
    if (!Array.isArray(this.filename) || !Array.isArray(other.filename)) {
      return false;
    }
    const selfBasenames = new Set(this.filename.map(basename2));
    for (const f of other.filename) {
      if (selfBasenames.has(basename2(f))) {
        return true;
      }
    }
    return false;
  }
  /**
   * Whether this video is grayscale, or `null` if unknown.
   *
   * Port of Python `Video.grayscale` getter (video.py:225-239): if the shape is
   * known, grayscale is `shape[-1] === 1`; otherwise fall back to a stored
   * `backendMetadata["grayscale"]` value (real key-presence, so a stored `null`
   * is returned as-is), else `null`. Used by `deduplicateWith` / `mergeWith` to
   * carry the grayscale hint onto the newly created video.
   */
  get grayscale() {
    const shape = this.shape;
    if (shape != null) {
      return shape[shape.length - 1] === 1;
    }
    if (hasOwn(this.backendMetadata, "grayscale")) {
      return this.backendMetadata.grayscale ?? null;
    }
    return null;
  }
  /**
   * Create a new video with duplicate images removed.
   *
   * Port of Python `Video.deduplicate_with` (video.py:801-840). Specific to
   * image-sequence videos (ImageVideo: `filename` is a list). Images are
   * considered duplicates when they share a basename. The returned video
   * contains only the images from THIS video whose basename is not present in
   * `other`, preserving this video's order.
   *
   * Return contract (matches Python exactly): returns `null` when ALL of this
   * video's images are duplicates (Python returns `None`); otherwise returns a
   * NEW `Video` (never `this`, never `other`) carrying the surviving image paths.
   *
   * @param other - Another image-sequence video to deduplicate against.
   * @returns A new `Video` with the non-duplicate images, or `null` if every
   *   image was a duplicate.
   * @throws Error - If either video's `filename` is not a list (ImageVideo).
   */
  deduplicateWith(other) {
    if (!Array.isArray(this.filename)) {
      throw new Error("deduplicate_with only works with ImageVideo backends");
    }
    if (!Array.isArray(other.filename)) {
      throw new Error("Other video must also be ImageVideo backend");
    }
    const otherBasenames = new Set(other.filename.map(basename2));
    const deduplicatedPaths = this.filename.filter(
      (f) => !otherBasenames.has(basename2(f))
    );
    if (deduplicatedPaths.length === 0) {
      return null;
    }
    return makeImageSequenceVideo(deduplicatedPaths, this.grayscale);
  }
  /**
   * Merge another video's images into this one.
   *
   * Port of Python `Video.merge_with` (video.py:842-883). Specific to
   * image-sequence videos (ImageVideo: `filename` is a list). Returns a NEW
   * `Video` containing all unique images (by basename) from both videos,
   * preserving order: every unique image from THIS video first, then any image
   * from `other` whose basename has not already been seen.
   *
   * @param other - Another image-sequence video to merge with.
   * @returns A new `Video` with the de-duplicated union of both videos' images.
   * @throws Error - If either video's `filename` is not a list (ImageVideo).
   */
  mergeWith(other) {
    if (!Array.isArray(this.filename)) {
      throw new Error("merge_with only works with ImageVideo backends");
    }
    if (!Array.isArray(other.filename)) {
      throw new Error("Other video must also be ImageVideo backend");
    }
    const seenBasenames = /* @__PURE__ */ new Set();
    const mergedPaths = [];
    for (const path of this.filename) {
      const name = basename2(path);
      if (!seenBasenames.has(name)) {
        mergedPaths.push(path);
        seenBasenames.add(name);
      }
    }
    for (const path of other.filename) {
      const name = basename2(path);
      if (!seenBasenames.has(name)) {
        mergedPaths.push(path);
        seenBasenames.add(name);
      }
    }
    return makeImageSequenceVideo(mergedPaths, this.grayscale);
  }
};
function makeImageSequenceVideo(paths, grayscale) {
  const backendMetadata = {};
  if (grayscale != null) {
    backendMetadata.grayscale = grayscale;
  }
  return new Video({
    filename: paths,
    backend: null,
    backendMetadata,
    openBackend: false
  });
}
function copyPoints(points) {
  if (Array.isArray(points)) {
    if (points.length > 0 && Array.isArray(points[0])) {
      return points.map(
        ([x, y]) => [x, y]
      );
    }
    return points.slice();
  }
  return points.slice();
}
function basename2(path) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}
function toPosix(path) {
  let p = path.replace(/\\/g, "/");
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function shapeTupleEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function hasOwn(obj, key) {
  return Object.hasOwn(obj, key);
}
function hdf5Dataset(video) {
  const fromBackend = video.backend?.dataset;
  if (fromBackend != null) return fromBackend;
  const fromMeta = video.backendMetadata.dataset;
  return typeof fromMeta === "string" ? fromMeta : null;
}
function isHdf5Video(video) {
  return hdf5Dataset(video) !== null;
}
function hdf5SourceFilename(video) {
  const fn = video.sourceVideo?.filename;
  return typeof fn === "string" ? fn : null;
}
function backendTypeName(video) {
  return video.backend?.constructor?.name ?? "";
}

// src/model/camera.ts
function rodriguesTransformation(input) {
  if (input.length === 3 && Array.isArray(input[0]) === false) {
    const rvec = input;
    const theta2 = Math.hypot(rvec[0], rvec[1], rvec[2]);
    if (theta2 === 0) {
      return {
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        vector: rvec
      };
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
    const I = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
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
  score;
  identity;
  instance3d;
  metadata;
  _points;
  /**
   * The CONCRETE camera→instance map. Set for in-memory construction and for the
   * JS-inline read path (point-dict instances). `undefined` for a pure-ref group
   * read from a camcorder-format file until first access resolves the refs. Read
   * directly (not via the caching getter) by the write path.
   * @internal
   */
  _instanceByCamera;
  /**
   * Verbatim as-read index refs from `camcorder_to_lf_and_inst_idx_map`:
   * camera → [globalLabeledFrameIdx, instanceIdx]. Captured on read WITHOUT
   * materializing any frames, so an untouched group can be written back
   * losslessly (see hybrid write-back). `undefined` for in-memory groups.
   * @internal
   */
  _instanceRefsByCamera;
  constructor(options) {
    if (options.instanceByCamera !== void 0) {
      if (options.instanceByCamera instanceof Map) {
        this._instanceByCamera = options.instanceByCamera;
      } else {
        const map = /* @__PURE__ */ new Map();
        for (const [key, value] of Object.entries(options.instanceByCamera)) {
          map.set(key, value);
        }
        this._instanceByCamera = map;
      }
    }
    this._instanceRefsByCamera = options.instanceRefsByCamera;
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
    if (this.instance3d?.points && value != null) {
      console.warn(
        "Setting points on an InstanceGroup that has an Instance3D \u2014 the getter will return instance3d.points, not this value. Set instance3d.points directly instead."
      );
    }
    this._points = value;
  }
  /**
   * Camera→Instance map. Concrete when the group was built in memory (or via the
   * JS-inline read path); otherwise resolved lazily from `_instanceRefsByCamera`
   * on first access via the injected `_frameResolver` and cached. In-place
   * `.set()`/`.delete()` mutations therefore act on the resolved concrete map.
   */
  get instanceByCamera() {
    if (this._instanceByCamera) return this._instanceByCamera;
    const refs = this._instanceRefsByCamera;
    const resolver = this._frameResolver;
    if (refs && resolver) {
      const map = /* @__PURE__ */ new Map();
      for (const [camera, [lfIdx, instIdx]] of refs) {
        const lf = resolver(lfIdx);
        const inst = lf?.instances[instIdx];
        if (inst) map.set(camera, inst);
      }
      this._instanceByCamera = map;
      return map;
    }
    return /* @__PURE__ */ new Map();
  }
  set instanceByCamera(value) {
    this._instanceByCamera = value;
  }
  get instances() {
    return Array.from(this.instanceByCamera.values());
  }
};
var FrameGroup = class {
  frameIdx;
  instanceGroups;
  metadata;
  /**
   * The CONCRETE camera→labeledFrame map. Set for in-memory construction;
   * `undefined` for a pure-ref group read from a camcorder-format file until
   * first access resolves the refs. Read directly (not via the caching getter)
   * by the write path.
   * @internal
   */
  _labeledFrameByCamera;
  /**
   * Verbatim as-read index refs from `labeled_frame_by_camera` (or reconstructed
   * from `camcorder_to_lf_and_inst_idx_map`): camera → globalLabeledFrameIdx.
   * Captured on read WITHOUT materializing any frames. `undefined` for in-memory
   * groups.
   * @internal
   */
  _labeledFrameRefsByCamera;
  constructor(options) {
    this.frameIdx = options.frameIdx;
    this.instanceGroups = options.instanceGroups;
    if (options.labeledFrameByCamera !== void 0) {
      if (options.labeledFrameByCamera instanceof Map) {
        this._labeledFrameByCamera = options.labeledFrameByCamera;
      } else {
        const map = /* @__PURE__ */ new Map();
        for (const [key, value] of Object.entries(
          options.labeledFrameByCamera
        )) {
          map.set(key, value);
        }
        this._labeledFrameByCamera = map;
      }
    }
    this._labeledFrameRefsByCamera = options.labeledFrameRefsByCamera;
    this.metadata = options.metadata ?? {};
  }
  /**
   * Camera→LabeledFrame map. Concrete when the group was built in memory;
   * otherwise resolved lazily from `_labeledFrameRefsByCamera` on first access
   * via the injected `_frameResolver` and cached.
   */
  get labeledFrameByCamera() {
    if (this._labeledFrameByCamera) return this._labeledFrameByCamera;
    const refs = this._labeledFrameRefsByCamera;
    const resolver = this._frameResolver;
    if (refs && resolver) {
      const map = /* @__PURE__ */ new Map();
      for (const [camera, lfIdx] of refs) {
        const lf = resolver(lfIdx);
        if (lf) map.set(camera, lf);
      }
      this._labeledFrameByCamera = map;
      return map;
    }
    return /* @__PURE__ */ new Map();
  }
  set labeledFrameByCamera(value) {
    this._labeledFrameByCamera = value;
  }
  /**
   * Cameras participating in this frame group. Reads keys from whichever backing
   * map exists WITHOUT resolving refs, so listing cameras never materializes a
   * frame (crucial for the lazy/zero-materialization write path).
   */
  get cameras() {
    return Array.from(
      (this._labeledFrameByCamera ?? this._labeledFrameRefsByCamera ?? /* @__PURE__ */ new Map()).keys()
    );
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
  /**
   * @deprecated Transitional bridge, OPT-IN only. Pass `{ rawSessions: true }`
   * to a read entrypoint (`readSlp`/`readSlpLazy`/`readSlpStreaming`) to capture
   * it; it is `undefined` by default. The object model is now a faithful, lossless
   * projection of `sessions_json` (typed grouping via `InstanceGroup`/`FrameGroup`
   * refs), so consumers should read typed objects rather than this raw dict. It
   * will be removed once LUCID migrates off it. Capturing it deep-clones the whole
   * session payload, so leaving it off avoids doubling session memory in
   * `Labels.copy()`.
   *
   * The verbatim, as-read `sessions_json` dict for this session (when captured).
   *
   * This is a deep-cloned copy of the `JSON.parse` result of the session's
   * `sessions_json` entry, populated on read (eager, lazy, and streaming) ONLY
   * when `rawSessions` is requested. It lets 3D consumers (e.g. luc3d/LUCID) read
   * app-specific state — `calibration`, `camcorder_to_video_idx_map`,
   * `camcorder_to_lf_and_inst_idx_map`, `frame_group_dicts`, and any nested
   * `metadata.lucid` blob — without re-opening the HDF5, including keys
   * sleap-io.js does not itself model.
   *
   * Caveats:
   * - It is a READ-TIME SNAPSHOT: it is deep-cloned from the parsed dict and
   *   holds NO shared references with the object model, so mutating `rawJson`
   *   never affects the model (or what is written to disk) and mutating the
   *   model never affects `rawJson`.
   * - It is NEVER itself re-written to disk. The object model is the single
   *   source of truth on write; `rawJson` is a pure in-memory read surface.
   * - `undefined` for sessions constructed in-memory (never read from disk).
   */
  rawJson;
  constructor(options) {
    this.cameraGroup = options?.cameraGroup ?? new CameraGroup();
    this.frameGroupByFrameIdx = options?.frameGroupByFrameIdx ?? /* @__PURE__ */ new Map();
    this.videoByCamera = options?.videoByCamera ?? /* @__PURE__ */ new Map();
    this.cameraByVideo = options?.cameraByVideo ?? /* @__PURE__ */ new Map();
    this.metadata = options?.metadata ?? {};
    this.rawJson = options?.rawJson;
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
function injectSessionFrameResolver(labels) {
  const resolver = (i) => labels.frameAt(i);
  const install = (target) => {
    Object.defineProperty(target, "_frameResolver", {
      value: resolver,
      writable: true,
      enumerable: false,
      configurable: true
    });
  };
  for (const session of labels.sessions) {
    for (const frameGroup of session.frameGroupByFrameIdx.values()) {
      install(frameGroup);
      for (const instanceGroup of frameGroup.instanceGroups) {
        install(instanceGroup);
      }
    }
  }
}
function cloneInstanceGroup(ig, remapCam, instanceMap) {
  let instanceByCamera;
  let instanceRefsByCamera;
  if (ig._instanceRefsByCamera) {
    instanceRefsByCamera = /* @__PURE__ */ new Map();
    for (const [c, pair] of ig._instanceRefsByCamera)
      instanceRefsByCamera.set(remapCam(c), [pair[0], pair[1]]);
  } else if (ig._instanceByCamera) {
    instanceByCamera = /* @__PURE__ */ new Map();
    for (const [c, inst] of ig._instanceByCamera)
      instanceByCamera.set(remapCam(c), instanceMap?.get(inst) ?? inst);
  }
  const points = ig.instance3d || !ig.points ? void 0 : ig.points.map((p) => [...p]);
  return new InstanceGroup({
    instanceByCamera,
    instanceRefsByCamera,
    score: ig.score,
    points,
    identity: ig.identity,
    instance3d: ig.instance3d,
    metadata: structuredClone(ig.metadata)
  });
}
function cloneRecordingSession(session, opts = {}) {
  const { videoMap, frameMap, instanceMap } = opts;
  const cameraMap = /* @__PURE__ */ new Map();
  const newCameras = session.cameraGroup.cameras.map((cam) => {
    const nc = new Camera({
      name: cam.name,
      rvec: [...cam.rvec],
      tvec: [...cam.tvec],
      matrix: cam.matrix?.map((r) => [...r]),
      distortions: cam.distortions ? [...cam.distortions] : void 0,
      size: cam.size ? [cam.size[0], cam.size[1]] : void 0
    });
    cameraMap.set(cam, nc);
    return nc;
  });
  const remapCam = (c) => cameraMap.get(c) ?? c;
  const cameraGroup = new CameraGroup({
    cameras: newCameras,
    metadata: structuredClone(session.cameraGroup.metadata)
  });
  const videoByCamera = /* @__PURE__ */ new Map();
  const cameraByVideo = /* @__PURE__ */ new Map();
  for (const [cam, vid] of session.videoByCamera) {
    const nc = remapCam(cam);
    const nv = videoMap?.get(vid) ?? vid;
    videoByCamera.set(nc, nv);
    cameraByVideo.set(nv, nc);
  }
  const frameGroupByFrameIdx = /* @__PURE__ */ new Map();
  for (const [fidx, fg] of session.frameGroupByFrameIdx) {
    const instanceGroups = fg.instanceGroups.map(
      (ig) => cloneInstanceGroup(ig, remapCam, instanceMap)
    );
    let labeledFrameByCamera;
    let labeledFrameRefsByCamera;
    if (fg._labeledFrameRefsByCamera) {
      labeledFrameRefsByCamera = /* @__PURE__ */ new Map();
      for (const [c, i] of fg._labeledFrameRefsByCamera)
        labeledFrameRefsByCamera.set(remapCam(c), i);
    } else if (fg._labeledFrameByCamera) {
      labeledFrameByCamera = /* @__PURE__ */ new Map();
      for (const [c, lf] of fg._labeledFrameByCamera)
        labeledFrameByCamera.set(remapCam(c), frameMap?.get(lf) ?? lf);
    }
    frameGroupByFrameIdx.set(
      fidx,
      new FrameGroup({
        frameIdx: fg.frameIdx,
        instanceGroups,
        labeledFrameByCamera,
        labeledFrameRefsByCamera,
        metadata: structuredClone(fg.metadata)
      })
    );
  }
  return new RecordingSession({
    cameraGroup,
    frameGroupByFrameIdx,
    videoByCamera,
    cameraByVideo,
    metadata: structuredClone(session.metadata),
    rawJson: session.rawJson ? structuredClone(session.rawJson) : void 0
  });
}
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
    const requestInit = options?.headers && Object.keys(options.headers).length > 0 ? { headers: options.headers } : void 0;
    backend.input = new Input({
      source: new UrlSource(url, requestInit ? { requestInit } : void 0),
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
  return labels.numpy({
    returnConfidence: options?.returnConfidence,
    video: options?.video,
    numFrames: options?.numFrames
  });
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
      const hasData = points.some(
        (point) => point.some((value) => !Number.isNaN(value))
      );
      if (!hasData) continue;
      const arrayPoints = points.map((point) => {
        if (options.returnConfidence) {
          return [point[0], point[1], point[2] ?? Number.NaN, 1, 0];
        }
        return [point[0], point[1], 1, 0];
      });
      const instance = new PredictedInstance({
        points: predictedPointsFromArray(
          arrayPoints,
          options.skeleton.nodeNames
        ),
        skeleton: options.skeleton,
        track: tracks[trackIdx]
      });
      instances.push(instance);
    }
    labeledFrames.push(
      new LabeledFrame({
        video: options.video,
        frameIdx: startFrame + frameIdx,
        instances
      })
    );
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
  if (Array.isArray(options.skeletons) && options.skeletons.length)
    return options.skeletons[0];
  if (options.skeletons && !Array.isArray(options.skeletons))
    return options.skeletons;
  throw new Error("fromNumpy requires a skeleton.");
}

// src/model/lazy.ts
var LazyDataStore = class _LazyDataStore {
  framesData;
  instancesData;
  pointsData;
  predPointsData;
  skeletons;
  tracks;
  videos;
  formatId;
  negativeFrames;
  // Per-frame annotation lookups: "videoIdx:frameIdx" -> annotation[]
  _centroidByFrame = /* @__PURE__ */ new Map();
  _bboxByFrame = /* @__PURE__ */ new Map();
  _maskByFrame = /* @__PURE__ */ new Map();
  _labelImageByFrame = /* @__PURE__ */ new Map();
  _roiByFrame = /* @__PURE__ */ new Map();
  // Undistributed annotations (video=null or frameIdx=null, e.g. static ROIs)
  _undistributedCentroids = [];
  _undistributedBboxes = [];
  _undistributedMasks = [];
  _undistributedLabelImages = [];
  _undistributedRois = [];
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
  /**
   * Create an independent copy of this store's raw column data.
   * Videos, skeletons, and tracks arrays are shared (not cloned) —
   * the caller is expected to replace them with new references.
   */
  copy() {
    const copyRecord = (rec) => {
      const out = {};
      for (const key of Object.keys(rec)) {
        out[key] = rec[key].slice();
      }
      return out;
    };
    const copyAnnMap = (map) => {
      const out = /* @__PURE__ */ new Map();
      for (const [key, list] of map) {
        out.set(key, [...list]);
      }
      return out;
    };
    const newStore = new _LazyDataStore({
      framesData: copyRecord(this.framesData),
      instancesData: copyRecord(this.instancesData),
      pointsData: copyRecord(this.pointsData),
      predPointsData: copyRecord(this.predPointsData),
      skeletons: this.skeletons,
      tracks: this.tracks,
      videos: this.videos,
      formatId: this.formatId,
      negativeFrames: new Set(this.negativeFrames)
    });
    newStore._centroidByFrame = copyAnnMap(this._centroidByFrame);
    newStore._bboxByFrame = copyAnnMap(this._bboxByFrame);
    newStore._maskByFrame = copyAnnMap(this._maskByFrame);
    newStore._labelImageByFrame = copyAnnMap(this._labelImageByFrame);
    newStore._roiByFrame = copyAnnMap(this._roiByFrame);
    newStore._undistributedCentroids = [...this._undistributedCentroids];
    newStore._undistributedBboxes = [...this._undistributedBboxes];
    newStore._undistributedMasks = [...this._undistributedMasks];
    newStore._undistributedLabelImages = [...this._undistributedLabelImages];
    newStore._undistributedRois = [...this._undistributedRois];
    return newStore;
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
    const instStart = Number(
      this.framesData.instance_id_start?.[frameIdx] ?? 0
    );
    const instEnd = Number(this.framesData.instance_id_end?.[frameIdx] ?? 0);
    const video = this.videos[videoIndex];
    if (!video) return null;
    const instances = [];
    const instanceById = /* @__PURE__ */ new Map();
    const fromPredictedPairs = [];
    for (let instIdx = instStart; instIdx < instEnd; instIdx++) {
      const instanceType = Number(
        this.instancesData.instance_type?.[instIdx] ?? 0
      );
      const skeletonId = Number(this.instancesData.skeleton?.[instIdx] ?? 0);
      const trackId = Number(this.instancesData.track?.[instIdx] ?? -1);
      const pointStart = Number(
        this.instancesData.point_id_start?.[instIdx] ?? 0
      );
      const pointEnd = Number(this.instancesData.point_id_end?.[instIdx] ?? 0);
      const score = Number(this.instancesData.score?.[instIdx] ?? 0);
      const rawTrackingScore = this.formatId < 1.2 ? 0 : Number(this.instancesData.tracking_score?.[instIdx] ?? 0);
      const trackingScore = Number.isNaN(rawTrackingScore) ? 0 : rawTrackingScore;
      const fromPredicted = Number(
        this.instancesData.from_predicted?.[instIdx] ?? -1
      );
      const skeleton = this.skeletons[skeletonId] ?? this.skeletons[0];
      const track = trackId >= 0 ? this.tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        const points = this.slicePoints(this.pointsData, pointStart, pointEnd);
        instance = new Instance({
          points: pointsFromArray(points, skeleton.nodeNames),
          skeleton,
          track,
          trackingScore
        });
        if (this.formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        const points = this.slicePoints(
          this.predPointsData,
          pointStart,
          pointEnd,
          true
        );
        instance = new PredictedInstance({
          points: predictedPointsFromArray(points, skeleton.nodeNames),
          skeleton,
          track,
          score,
          trackingScore
        });
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
    const annKey = `${videoIndex}:${frameIndex}`;
    const centroids = this._centroidByFrame.get(annKey) ?? [];
    const bboxes = this._bboxByFrame.get(annKey) ?? [];
    const masks = this._maskByFrame.get(annKey) ?? [];
    const labelImages = this._labelImageByFrame.get(annKey) ?? [];
    const rois = this._roiByFrame.get(annKey) ?? [];
    const frame = new LabeledFrame({
      video,
      frameIdx: frameIndex,
      instances,
      centroids,
      bboxes,
      masks,
      labelImages,
      rois
    });
    const negKey = annKey;
    if (this.negativeFrames.has(negKey)) {
      frame.isNegative = true;
    }
    return frame;
  }
  /**
   * Convert lazy-mode labels to a dense `[frames, tracks, nodes, coords]` array
   * directly from raw column data without materializing any LabeledFrame or
   * Instance objects. Coords is `[x, y]` or `[x, y, score]` when
   * `returnConfidence` is true.
   *
   * @param options.numFrames Optional explicit length of the output's frame
   *   dimension. Takes precedence over `video.shape[0]` (the inferred fallback).
   *   Useful when `video.shape` is null — for example, Mp4Box-backed browser
   *   videos — and you still want a video-length-sized array. If smaller than
   *   `maxLabeledFrame + 1`, it is clamped up so no labeled frames are dropped.
   *   Non-finite, non-positive, or fractional values are sanitized via
   *   `Math.floor` and ignored when `<= 0`.
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
    const rawOverride = options?.numFrames;
    const override = Number.isFinite(rawOverride) && rawOverride > 0 ? Math.floor(rawOverride) : 0;
    const effectiveLength = override > 0 ? override : targetVideo.shape?.[0] ?? 0;
    if (effectiveLength > 0) {
      maxFrameIdx = Math.max(maxFrameIdx, effectiveLength - 1);
    }
    const nodeCount = this.skeletons[0]?.nodes.length ?? 0;
    const channelCount = options?.returnConfidence ? 3 : 2;
    const output = Array.from(
      { length: maxFrameIdx + 1 },
      () => Array.from(
        { length: trackCount },
        () => Array.from(
          { length: nodeCount },
          () => Array.from({ length: channelCount }, () => Number.NaN)
        )
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
  _supplementary = [];
  constructor(store) {
    this.store = store;
    this.cache = /* @__PURE__ */ new Map();
  }
  get length() {
    return this.store.frameCount + this._supplementary.length;
  }
  /** Get a frame by index, materializing it if needed. */
  at(index) {
    const n = this.length;
    const nStore = this.store.frameCount;
    if (index < 0) index += n;
    if (index < 0 || index >= n) return void 0;
    if (index >= nStore) {
      return this._supplementary[index - nStore];
    }
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

// src/model/labels.ts
var SLEAP_IO_VERSION = "0.3.1";
function pathBasename(path) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}
function coerceSkeletonMatcher(x) {
  if (x == null) {
    return new SkeletonMatcher(SkeletonMatchMethod.STRUCTURE);
  }
  if (typeof x === "string") {
    return new SkeletonMatcher(toSkeletonMatchMethod(x));
  }
  return x;
}
function coerceVideoMatcher(x) {
  if (x == null) {
    return new VideoMatcher();
  }
  if (typeof x === "string") {
    return new VideoMatcher(toVideoMatchMethod(x));
  }
  return x;
}
function coerceTrackMatcher(x) {
  if (x == null) {
    return new TrackMatcher();
  }
  if (typeof x === "string") {
    return new TrackMatcher(toTrackMatchMethod(x));
  }
  return x;
}
function coerceInstanceMatcher(x) {
  if (x == null) {
    return new InstanceMatcher();
  }
  if (typeof x === "string") {
    return new InstanceMatcher(toInstanceMatchMethod(x));
  }
  return x;
}
function localIsoStringWithoutZ() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}000`;
}
function filenameRepr(filename) {
  const reprStr = (s) => {
    const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `'${escaped}'`;
  };
  if (Array.isArray(filename)) {
    return `[${filename.map(reprStr).join(", ")}]`;
  }
  return reprStr(filename);
}
var Labels = class _Labels {
  labeledFrames;
  videos;
  skeletons;
  tracks;
  suggestions;
  sessions;
  provenance;
  identities;
  // Static ROIs: not tied to any specific frame (e.g., arena boundaries).
  _staticRois;
  /** @internal Lazy frame list for on-demand materialization. */
  _lazyFrameList = null;
  /** @internal Lazy data store holding raw HDF5 data. */
  _lazyDataStore = null;
  // Index caches (excluded from serialization, rebuilt on demand)
  _frameIndex = null;
  _frameIndexLen = -1;
  _trackIndex = null;
  _trackIndexLen = -1;
  constructor(options) {
    this.labeledFrames = options?.labeledFrames ?? [];
    this.videos = options?.videos ?? [];
    this.skeletons = options?.skeletons ?? [];
    this.tracks = options?.tracks ?? [];
    this.suggestions = options?.suggestions ?? [];
    this.sessions = options?.sessions ?? [];
    this.provenance = options?.provenance ?? {};
    this._staticRois = options?.rois ?? [];
    this.identities = options?.identities ?? [];
    if (!this.videos.length && this.labeledFrames.length) {
      const uniqueVideos = /* @__PURE__ */ new Map();
      for (const frame of this.labeledFrames) {
        uniqueVideos.set(frame.video, frame.video);
      }
      this.videos = Array.from(uniqueVideos.values());
    }
    const existingTracks = new Set(this.tracks);
    if (!this._lazyFrameList) {
      for (const frame of this.labeledFrames) {
        for (const instance of frame.instances) {
          this._registerSkeleton(instance);
          if (instance.track && !existingTracks.has(instance.track)) {
            existingTracks.add(instance.track);
            this.tracks.push(instance.track);
          }
        }
      }
      for (const lf of this.labeledFrames) {
        this._collectAnnotationTracks(lf, existingTracks);
      }
    }
    for (const roi of this._staticRois) {
      if (roi.track && !existingTracks.has(roi.track)) {
        existingTracks.add(roi.track);
        this.tracks.push(roi.track);
      }
    }
  }
  /**
   * @deprecated Transitional. Only populated when a read entrypoint is called
   * with `{ rawSessions: true }`; `undefined` per entry otherwise. Prefer the
   * faithful typed session model. See `RecordingSession.rawJson`.
   *
   * The verbatim, as-read `sessions_json` dicts, index-aligned with `sessions`.
   *
   * Derived (no stored field) so it cannot desync in length from `sessions`.
   * `rawSessionsJson[i]` corresponds to `sessions[i]`, and is `undefined` for
   * sessions constructed in-memory (or read without `rawSessions`). Each entry
   * is the untouched `JSON.parse` result of that session's `sessions_json`
   * entry — a read-time snapshot, never itself re-written to disk. See
   * `RecordingSession.rawJson`.
   */
  get rawSessionsJson() {
    return this.sessions.map((s) => s.rawJson);
  }
  /**
   * Get the labeled frame at global index `i`, materializing only that frame
   * under the lazy reader. Backs the session grouping's lazy frame resolver
   * (`injectSessionFrameResolver`): resolving one cross-camera ref materializes
   * a single frame via `LazyFrameList.at(i)` rather than the whole table, so an
   * untouched session round-trips with zero frame materialization.
   */
  frameAt(i) {
    return this._lazyFrameList ? this._lazyFrameList.at(i) : this.labeledFrames[i];
  }
  /**
   * Collect tracks from annotations on a frame into this.tracks.
   *
   * `seen` lets a caller iterating many frames share one membership set instead
   * of rebuilding `new Set(this.tracks)` per frame — the difference between
   * O(frames) and O(frames × tracks) on files with many tracks (e.g. a 21.8k-
   * frame / 7k-track project spent seconds here rebuilding the set). When
   * omitted (single-frame `append`), the set is built from the current tracks.
   * The set must stay in sync with `this.tracks`: every push here also adds to
   * it, so a later frame sees tracks an earlier one contributed.
   */
  _collectAnnotationTracks(lf, seen) {
    const existing = seen ?? new Set(this.tracks);
    const add = (track) => {
      if (track && !existing.has(track)) {
        existing.add(track);
        this.tracks.push(track);
      }
    };
    for (const c of lf.centroids) add(c.track);
    for (const b of lf.bboxes) add(b.track);
    for (const m of lf.masks) add(m.track);
    for (const r of lf.rois) add(r.track);
    for (const li of lf.labelImages) {
      for (const info of li.objects.values()) add(info.track);
    }
  }
  /** Raise if Labels is lazy-loaded. */
  _checkNotLazy(operation) {
    if (this.isLazy) {
      throw new Error(
        `Cannot ${operation} on lazy-loaded Labels.

To use, first materialize:
    labels.materialize();
    labels.${operation}(...);`
      );
    }
  }
  /** Clear all cached indices so they rebuild on next access. */
  _invalidateIndices() {
    this._frameIndex = null;
    this._frameIndexLen = -1;
    this._trackIndex = null;
    this._trackIndexLen = -1;
  }
  /** Build or return the frame index, rebuilding if stale. */
  _ensureFrameIndex() {
    if (this._lazyFrameList) this.materialize();
    const n = this.labeledFrames.length;
    if (this._frameIndex !== null && this._frameIndexLen === n) {
      return this._frameIndex;
    }
    this._frameIndex = /* @__PURE__ */ new Map();
    for (const lf of this.labeledFrames) {
      let videoMap = this._frameIndex.get(lf.video);
      if (!videoMap) {
        videoMap = /* @__PURE__ */ new Map();
        this._frameIndex.set(lf.video, videoMap);
      }
      if (videoMap.has(lf.frameIdx)) {
        console.warn(
          `Duplicate LabeledFrame for video=${lf.video}, frame_idx=${lf.frameIdx}. Using last occurrence.`
        );
      }
      videoMap.set(lf.frameIdx, lf);
    }
    this._frameIndexLen = n;
    return this._frameIndex;
  }
  /** Build or return the track index, rebuilding if stale. */
  _ensureTrackIndex() {
    if (this._lazyFrameList) this.materialize();
    const n = this.labeledFrames.length;
    if (this._trackIndex !== null && this._trackIndexLen === n) {
      return this._trackIndex;
    }
    this._trackIndex = /* @__PURE__ */ new Map();
    for (const lf of this.labeledFrames) {
      let videoMap = this._trackIndex.get(lf.video);
      if (!videoMap) {
        videoMap = /* @__PURE__ */ new Map();
        this._trackIndex.set(lf.video, videoMap);
      }
      for (const ann of [
        ...lf.centroids,
        ...lf.bboxes,
        ...lf.masks,
        ...lf.rois,
        ...lf.instances
      ]) {
        const track = ann.track;
        if (track) {
          let list = videoMap.get(track);
          if (!list) {
            list = [];
            videoMap.set(track, list);
          }
          list.push(ann);
        }
      }
      for (const li of lf.labelImages) {
        for (const info of li.objects.values()) {
          if (info.track) {
            let list = videoMap.get(info.track);
            if (!list) {
              list = [];
              videoMap.set(info.track, list);
            }
            list.push(li);
          }
        }
      }
    }
    const annFrameIdx = /* @__PURE__ */ new Map();
    for (const lf of this.labeledFrames) {
      for (const ann of [
        ...lf.centroids,
        ...lf.bboxes,
        ...lf.masks,
        ...lf.rois,
        ...lf.instances
      ]) {
        annFrameIdx.set(ann, lf.frameIdx);
      }
      for (const li of lf.labelImages) {
        annFrameIdx.set(li, lf.frameIdx);
      }
    }
    for (const videoMap of this._trackIndex.values()) {
      for (const list of videoMap.values()) {
        list.sort(
          (a, b) => (annFrameIdx.get(a) ?? 0) - (annFrameIdx.get(b) ?? 0)
        );
      }
    }
    this._trackIndexLen = n;
    return this._trackIndex;
  }
  /**
   * O(1) lookup of a LabeledFrame by video and frame index.
   *
   * The index is rebuilt lazily. If you mutate frames directly (e.g.,
   * `lf.frameIdx = newIdx`) without calling `reindex()`, the lookup may
   * return stale results.
   */
  getFrame(video, frameIdx) {
    this._checkNotLazy("getFrame");
    return this._ensureFrameIndex().get(video)?.get(frameIdx) ?? null;
  }
  /**
   * O(1) lookup of all annotations for a track in a video, sorted by frameIdx.
   *
   * The index is rebuilt lazily. If you mutate frames directly (e.g.,
   * `lf.frameIdx = newIdx`) without calling `reindex()`, the lookup may
   * return stale results.
   */
  getTrackAnnotations(video, track) {
    this._checkNotLazy("getTrackAnnotations");
    return this._ensureTrackIndex().get(video)?.get(track) ?? [];
  }
  /** Force rebuild of all indices on next access. */
  reindex() {
    this._invalidateIndices();
  }
  /**
   * Remove all predicted instances and predicted annotations from all frames.
   *
   * Mirrors Python `Labels.remove_predictions` (labels.py:1684-1710).
   *
   * @param clean - If `true` (the default), also prune empty frames and unused
   *   skeletons/tracks via {@link clean} with `frames`, `skeletons`, `tracks`
   *   enabled and `emptyInstances`/`videos` disabled. Does NOT remove videos
   *   with no labeled frames, nor instances with no visible points.
   */
  removePredictions(clean = true) {
    if (this._lazyFrameList) this.materialize();
    for (const lf of this.labeledFrames) {
      lf.removePredictions();
    }
    this._invalidateIndices();
    if (clean) {
      this.clean({
        frames: true,
        emptyInstances: false,
        skeletons: true,
        tracks: true,
        videos: false
      });
    }
  }
  /**
   * Collapse structurally-equal skeletons into a single canonical entry.
   *
   * Skeletons are partitioned via {@link Skeleton.matches} called with
   * `requireSameOrder: true` (same node count, same node names IN THE SAME
   * ORDER, same edge set, and same symmetry set). The first member of each
   * equivalence class is kept as canonical; the rest are removed from
   * `this.skeletons` and every instance referencing a non-canonical skeleton is
   * reassigned to the canonical via direct property assignment. Points are
   * positional and are NOT remapped, so order-identical matching is required to
   * keep reassignment safe.
   *
   * Note: skeleton `name` is not part of `matches()` — the canonical's name wins.
   *
   * Note: skeletons that share node names but differ in node ORDER are treated
   * as distinct here (they are not collapsed), since collapsing them would
   * misalign instance points.
   *
   * Legacy `.slp` files often carry content-duplicate skeletons (a pre-1.5 Python
   * sleap quirk). Call this method after `loadSlp` if you want them collapsed —
   * it is not run automatically on load.
   *
   * In lazy mode this forces full materialization, consistent with other Labels
   * mutators.
   *
   * @returns Number of duplicate skeletons collapsed (0 if none).
   */
  dedupSkeletons() {
    if (this._lazyFrameList) this.materialize();
    if (this.skeletons.length <= 1) return { canonicalized: 0 };
    const canonicals = [];
    const canonicalFor = /* @__PURE__ */ new Map();
    for (const skel of this.skeletons) {
      const existing = canonicals.find(
        (c) => skel.matches(c, { requireSameOrder: true })
      );
      if (existing) {
        canonicalFor.set(skel, existing);
      } else {
        canonicals.push(skel);
        canonicalFor.set(skel, skel);
      }
    }
    const canonicalized = this.skeletons.length - canonicals.length;
    if (canonicalized === 0) return { canonicalized: 0 };
    this.skeletons = canonicals;
    for (const frame of this.labeledFrames) {
      for (const inst of frame.instances) {
        const canon = canonicalFor.get(inst.skeleton);
        if (canon && inst.skeleton !== canon) inst.skeleton = canon;
      }
    }
    return { canonicalized };
  }
  /** Flat view of all centroids across all frames. */
  get centroids() {
    if (this._lazyFrameList && this._lazyDataStore) {
      const byFrame = this._lazyDataStore._centroidByFrame;
      const undist = this._lazyDataStore._undistributedCentroids;
      return [...undist, ...[...byFrame.values()].flat()];
    }
    return this.labeledFrames.flatMap((lf) => lf.centroids);
  }
  /** Flat view of all bounding boxes across all frames. */
  get bboxes() {
    if (this._lazyFrameList && this._lazyDataStore) {
      const byFrame = this._lazyDataStore._bboxByFrame;
      const undist = this._lazyDataStore._undistributedBboxes;
      return [...undist, ...[...byFrame.values()].flat()];
    }
    return this.labeledFrames.flatMap((lf) => lf.bboxes);
  }
  /** Flat view of all segmentation masks across all frames. */
  get masks() {
    if (this._lazyFrameList && this._lazyDataStore) {
      const byFrame = this._lazyDataStore._maskByFrame;
      const undist = this._lazyDataStore._undistributedMasks;
      return [...undist, ...[...byFrame.values()].flat()];
    }
    return this.labeledFrames.flatMap((lf) => lf.masks);
  }
  /** Flat view of all label images across all frames. */
  get labelImages() {
    if (this._lazyFrameList && this._lazyDataStore) {
      const byFrame = this._lazyDataStore._labelImageByFrame;
      const undist = this._lazyDataStore._undistributedLabelImages;
      return [...undist, ...[...byFrame.values()].flat()];
    }
    return this.labeledFrames.flatMap((lf) => lf.labelImages);
  }
  /** Flat view of all ROIs across all frames and static ROIs. */
  get rois() {
    if (this._lazyFrameList && this._lazyDataStore) {
      const byFrame = this._lazyDataStore._roiByFrame;
      const undist = this._lazyDataStore._undistributedRois;
      return [...undist, ...[...byFrame.values()].flat()];
    }
    return [
      ...this._staticRois,
      ...this.labeledFrames.flatMap((lf) => lf.rois)
    ];
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
    const store = this._lazyDataStore;
    this.labeledFrames = this._lazyFrameList.toArray();
    this._lazyFrameList = null;
    this._lazyDataStore = null;
    const allInstances = this.labeledFrames.flatMap((f) => f.instances);
    for (const lf of this.labeledFrames) {
      for (const ann of [
        ...lf.centroids,
        ...lf.bboxes,
        ...lf.masks,
        ...lf.rois
      ]) {
        if (ann._instanceIdx !== null && ann._instanceIdx >= 0 && ann._instanceIdx < allInstances.length) {
          ann.instance = allInstances[ann._instanceIdx];
          ann._instanceIdx = null;
        }
      }
      for (const li of lf.labelImages) {
        if (li._objectInstanceIdxs) {
          for (const [labelId, instIdx] of li._objectInstanceIdxs) {
            const obj = li.objects.get(labelId);
            if (obj && instIdx >= 0 && instIdx < allInstances.length) {
              obj.instance = allInstances[instIdx];
            }
          }
          li._objectInstanceIdxs = null;
        }
      }
    }
    if (store) {
      this._staticRois = store._undistributedRois;
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
  /**
   * Search for labeled frames given video and/or frame index.
   *
   * A foreign `Video` instance or filename (`string`/`URL`) is resolved to the
   * matching `Video` in `this.videos` via {@link _resolveVideo} (SYNC; see its
   * documented divergence from `matchVideo`), so an object created independently
   * still works. When the video does not resolve to a project video the foreign
   * reference is used as-is, so identity-based lookups yield no results.
   */
  find(options) {
    if (this._lazyFrameList) this.materialize();
    const resolved = options.video !== void 0 ? this._resolveVideo(options.video) ?? void 0 : void 0;
    if (resolved !== void 0 && options.frameIdx !== void 0) {
      const frame = this.getFrame(resolved, options.frameIdx);
      return frame ? [frame] : [];
    }
    return this.labeledFrames.filter((frame) => {
      if (resolved && frame.video !== resolved) {
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
  /**
   * Append a labeled frame to the labels.
   *
   * Registers the frame's video, the skeletons and tracks of its instances, and
   * the tracks of its nested annotations. Skeletons are registered via
   * {@link _registerSkeleton}, so an instance referencing a structurally-equal
   * but distinct `Skeleton` is rebound to the existing canonical one instead of
   * growing `this.skeletons` (Python #447).
   *
   * Mirrors Python `Labels.append` (PR #447).
   */
  append(frame) {
    if (this._lazyFrameList) this.materialize();
    this.labeledFrames.push(frame);
    this._invalidateIndices();
    this.addVideo(frame.video);
    for (const inst of frame.instances) {
      this._registerSkeleton(inst);
      if (inst.track != null && !this.tracks.includes(inst.track)) {
        this.tracks.push(inst.track);
      }
    }
    this._collectAnnotationTracks(frame);
  }
  /**
   * Append multiple labeled frames to the labels.
   *
   * Like calling {@link append} on each frame in `frames`: registers each
   * frame's video, the skeletons and tracks of its instances (deduplicating
   * structurally-equal skeletons via {@link _registerSkeleton}, Python #447),
   * and the tracks of its nested annotations.
   *
   * Mirrors Python `Labels.extend` (PR #447).
   */
  extend(frames) {
    if (this._lazyFrameList) this.materialize();
    const seenTracks = new Set(this.tracks);
    for (const frame of frames) {
      this.labeledFrames.push(frame);
      this.addVideo(frame.video);
      for (const inst of frame.instances) {
        this._registerSkeleton(inst);
        if (inst.track != null && !seenTracks.has(inst.track)) {
          seenTracks.add(inst.track);
          this.tracks.push(inst.track);
        }
      }
      this._collectAnnotationTracks(frame, seenTracks);
    }
    this._invalidateIndices();
  }
  /**
   * Add a static ROI (not tied to any specific frame, e.g., an arena boundary).
   *
   * Registers the ROI's track (if any) on `this.tracks`. Use
   * `lf.append(roi)` on a `LabeledFrame` to add a frame-bound ROI instead.
   */
  addStaticRoi(roi) {
    this._staticRois.push(roi);
    if (roi.track && !this.tracks.includes(roi.track)) {
      this.tracks.push(roi.track);
    }
  }
  toDict(options) {
    if (this._lazyFrameList) this.materialize();
    return toDict(this, options);
  }
  /** Static ROIs (not attached to any LabeledFrame). */
  get staticRois() {
    return [...this._staticRois];
  }
  /** Frame-bound ROIs (attached to LabeledFrames). */
  get temporalRois() {
    return this.labeledFrames.flatMap((lf) => lf.rois);
  }
  /**
   * Filter ROIs across the Labels object.
   *
   * Filtering rule (matches sibling getters like `getMasks`/`getBboxes`):
   *   - Frame-aware filters (`video` or `frameIdx`) walk only `labeledFrames`.
   *     Static ROIs are excluded from these results.
   *   - Otherwise (no filter, or only `category`/`track`/`instance`/`predicted`)
   *     the search runs over `this.rois` — the union of static + frame-bound.
   *
   * To access static ROIs directly, use `staticRois`. To access only frame-bound
   * ROIs across all frames, use `temporalRois`.
   */
  getRois(filters) {
    if (!filters) return [...this.rois];
    const video = filters.video !== void 0 ? this._resolveVideo(filters.video) ?? void 0 : void 0;
    let results;
    if (video !== void 0 && filters.frameIdx !== void 0) {
      const lf = this.getFrame(video, filters.frameIdx);
      results = lf ? lf.rois : [];
    } else if (video !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.video === video) results.push(...lf.rois);
      }
    } else if (filters.frameIdx !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.frameIdx === filters.frameIdx) results.push(...lf.rois);
      }
    } else {
      results = this.rois;
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
    if (filters.predicted !== void 0) {
      results = results.filter((r) => r.isPredicted === filters.predicted);
    }
    return results;
  }
  getMasks(filters) {
    if (!filters) return [...this.masks];
    const video = filters.video !== void 0 ? this._resolveVideo(filters.video) ?? void 0 : void 0;
    let results;
    if (video !== void 0 && filters.frameIdx !== void 0) {
      const lf = this.getFrame(video, filters.frameIdx);
      results = lf ? lf.masks : [];
    } else if (video !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.video === video) results.push(...lf.masks);
      }
    } else if (filters.frameIdx !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.frameIdx === filters.frameIdx) results.push(...lf.masks);
      }
    } else {
      results = this.masks;
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
    if (filters.predicted !== void 0) {
      results = results.filter((m) => m.isPredicted === filters.predicted);
    }
    return results;
  }
  getBboxes(filters) {
    if (!filters) return [...this.bboxes];
    const video = filters.video !== void 0 ? this._resolveVideo(filters.video) ?? void 0 : void 0;
    let results;
    if (video !== void 0 && filters.frameIdx !== void 0) {
      const lf = this.getFrame(video, filters.frameIdx);
      results = lf ? lf.bboxes : [];
    } else if (video !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.video === video) results.push(...lf.bboxes);
      }
    } else if (filters.frameIdx !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.frameIdx === filters.frameIdx) results.push(...lf.bboxes);
      }
    } else {
      results = this.bboxes;
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
  getCentroids(filters) {
    if (!filters) return [...this.centroids];
    const video = filters.video !== void 0 ? this._resolveVideo(filters.video) ?? void 0 : void 0;
    let results;
    if (video !== void 0 && filters.frameIdx !== void 0) {
      const lf = this.getFrame(video, filters.frameIdx);
      results = lf ? lf.centroids : [];
    } else if (video !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.video === video) results.push(...lf.centroids);
      }
    } else if (filters.frameIdx !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.frameIdx === filters.frameIdx) results.push(...lf.centroids);
      }
    } else {
      results = this.centroids;
    }
    if (filters.category !== void 0) {
      results = results.filter((c) => c.category === filters.category);
    }
    if (filters.track !== void 0) {
      results = results.filter((c) => c.track === filters.track);
    }
    if (filters.instance !== void 0) {
      results = results.filter((c) => c.instance === filters.instance);
    }
    if (filters.predicted !== void 0) {
      results = results.filter((c) => c.isPredicted === filters.predicted);
    }
    return results;
  }
  getLabelImages(filters) {
    if (!filters) return [...this.labelImages];
    const video = filters.video !== void 0 ? this._resolveVideo(filters.video) ?? void 0 : void 0;
    let results;
    if (video !== void 0 && filters.frameIdx !== void 0) {
      const lf = this.getFrame(video, filters.frameIdx);
      results = lf ? lf.labelImages : [];
    } else if (video !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.video === video) results.push(...lf.labelImages);
      }
    } else if (filters.frameIdx !== void 0) {
      results = [];
      for (const lf of this.labeledFrames) {
        if (lf.frameIdx === filters.frameIdx) results.push(...lf.labelImages);
      }
    } else {
      results = this.labelImages;
    }
    if (filters.track !== void 0) {
      results = results.filter(
        (li) => Array.from(li.objects.values()).some(
          (info) => info.track === filters.track
        )
      );
    }
    if (filters.category !== void 0) {
      results = results.filter(
        (li) => Array.from(li.objects.values()).some(
          (info) => info.category === filters.category
        )
      );
    }
    if (filters.predicted !== void 0) {
      results = results.filter((li) => li.isPredicted === filters.predicted);
    }
    return results;
  }
  /**
   * Replace videos and update all references across the Labels object.
   *
   * Provide either `oldVideos`/`newVideos` arrays or a `videoMap`.
   * If only `newVideos` is provided and its length matches `this.videos`,
   * the current videos are used as `oldVideos`.
   */
  replaceVideos(options) {
    if (this._lazyFrameList) this.materialize();
    let { oldVideos, newVideos, videoMap } = options;
    if (!oldVideos && newVideos && newVideos.length === this.videos.length) {
      oldVideos = this.videos;
    }
    if (!videoMap) {
      if (!oldVideos || !newVideos) {
        throw new Error("Must provide oldVideos/newVideos or videoMap.");
      }
      videoMap = /* @__PURE__ */ new Map();
      for (let i = 0; i < oldVideos.length; i++) {
        videoMap.set(oldVideos[i], newVideos[i]);
      }
    }
    for (const frame of this.labeledFrames) {
      const mapped = videoMap.get(frame.video);
      if (mapped) frame.video = mapped;
      for (const r of frame.rois) {
        if (r.video && videoMap.has(r.video)) r.video = videoMap.get(r.video);
      }
    }
    for (const suggestion of this.suggestions) {
      const mapped = videoMap.get(suggestion.video);
      if (mapped) suggestion.video = mapped;
    }
    for (const roi of this._staticRois) {
      if (roi.video && videoMap.has(roi.video))
        roi.video = videoMap.get(roi.video);
    }
    this.videos = this.videos.map((v) => videoMap.get(v) ?? v);
    this._invalidateIndices();
  }
  /**
   * Remove one or more videos and every reference to them — the "drop" analog
   * of {@link replaceVideos}. Labeled frames and suggestions belonging to a
   * removed video are dropped (a frame's ROIs go with it), as are static ROIs
   * that reference it. Videos not present are ignored (a no-op, matching
   * {@link addVideo}'s lenient convention).
   *
   * Tracks and skeletons are intentionally left untouched — cleaning those up
   * is a separate concern (see {@link clean}).
   */
  removeVideos(videos) {
    if (videos.length === 0) return;
    if (this._lazyFrameList) this.materialize();
    const toRemove = new Set(videos);
    this.labeledFrames = this.labeledFrames.filter(
      (lf) => !toRemove.has(lf.video)
    );
    this.suggestions = this.suggestions.filter((s) => !toRemove.has(s.video));
    this._staticRois = this._staticRois.filter(
      (roi) => !roi.video || !toRemove.has(roi.video)
    );
    this.videos = this.videos.filter((v) => !toRemove.has(v));
    this._invalidateIndices();
  }
  /** Remove a single video and all references to it (see {@link removeVideos}). */
  removeVideo(video) {
    this.removeVideos([video]);
  }
  /**
   * Create a deep copy of this Labels object.
   *
   * @param options.openVideos - Controls video backend behavior in the copy:
   *   - `undefined` (default): Preserve each video's current `openBackend` setting.
   *   - `true`: Enable auto-opening for all videos.
   *   - `false`: Disable auto-opening and close any open backends.
   * @returns A new Labels with deep-copied data. Video backends (file handles)
   *   are not copied — they will be re-opened on demand if `openBackend` is true.
   */
  copy(options) {
    const videoMap = /* @__PURE__ */ new Map();
    const newVideos = this.videos.map((v) => {
      const nv = new Video({
        filename: Array.isArray(v.filename) ? [...v.filename] : v.filename,
        backendMetadata: { ...v.backendMetadata },
        openBackend: v.openBackend,
        embedded: v.hasEmbeddedImages
      });
      nv.shape = v.shape;
      nv.fps = v.fps;
      videoMap.set(v, nv);
      return nv;
    });
    const skeletonMap = /* @__PURE__ */ new Map();
    const newSkeletons = this.skeletons.map((s) => {
      const nodeMap = /* @__PURE__ */ new Map();
      const newNodes = s.nodes.map((n) => {
        const nn = new Node(n.name);
        nodeMap.set(n, nn);
        return nn;
      });
      const newEdges = s.edges.map(
        (e) => new Edge(nodeMap.get(e.source), nodeMap.get(e.destination))
      );
      const newSymmetries = s.symmetries.map((sym) => {
        const nodes = [...sym.nodes];
        return new Symmetry([nodeMap.get(nodes[0]), nodeMap.get(nodes[1])]);
      });
      const ns = new Skeleton({
        nodes: newNodes,
        edges: newEdges,
        symmetries: newSymmetries,
        name: s.name
      });
      skeletonMap.set(s, ns);
      return ns;
    });
    const trackMap = /* @__PURE__ */ new Map();
    const newTracks = this.tracks.map((t) => {
      const nt = new Track(t.name);
      trackMap.set(t, nt);
      return nt;
    });
    const cloneInstance = (inst) => {
      const newPoints = inst.points.map((p) => clonePoint(p));
      const newSkeleton = skeletonMap.get(inst.skeleton) ?? inst.skeleton;
      const newTrack = inst.track ? trackMap.get(inst.track) ?? inst.track : null;
      if (inst instanceof PredictedInstance) {
        return new PredictedInstance({
          points: newPoints,
          skeleton: newSkeleton,
          track: newTrack,
          score: inst.score,
          trackingScore: inst.trackingScore
        });
      }
      const ni = new Instance({
        points: newPoints,
        skeleton: newSkeleton,
        track: newTrack,
        trackingScore: inst.trackingScore
      });
      return ni;
    };
    const cloneAncillary = (items) => items.map((item) => {
      const saved = [];
      for (const key of ["video", "track", "instance"]) {
        if (key in item && item[key] != null) {
          saved.push([key, item[key]]);
          item[key] = null;
        }
      }
      let objectRefs = null;
      if ("objects" in item && item.objects instanceof Map) {
        objectRefs = /* @__PURE__ */ new Map();
        for (const [id, info] of item.objects) {
          if (info.track || info.instance) {
            objectRefs.set(id, [info.track, info.instance]);
            info.track = null;
            info.instance = null;
          }
        }
      }
      const clone = structuredClone(item);
      Object.setPrototypeOf(clone, Object.getPrototypeOf(item));
      for (const [key, val] of saved) item[key] = val;
      if (objectRefs) {
        for (const [id, [track, inst]] of objectRefs) {
          const info = item.objects.get(id);
          if (info) {
            info.track = track;
            info.instance = inst;
          }
        }
      }
      for (const [key, val] of saved) {
        if (key === "video") clone.video = videoMap.get(val) ?? val;
        else if (key === "track")
          clone.track = trackMap.get(val) ?? val;
        else if (key === "instance") clone.instance = null;
      }
      if (objectRefs) {
        for (const [id, [track]] of objectRefs) {
          const info = clone.objects.get(id);
          if (info) {
            info.track = track ? trackMap.get(track) ?? track : null;
            info.instance = null;
          }
        }
      }
      return clone;
    });
    let labelsCopy;
    if (this.isLazy) {
      const newStore = this._lazyDataStore.copy();
      newStore.videos = newVideos;
      newStore.skeletons = newSkeletons;
      newStore.tracks = newTracks;
      const newLazyFrames = new LazyFrameList(newStore);
      if (this._lazyFrameList?._supplementary.length) {
        newLazyFrames._supplementary = this._lazyFrameList._supplementary.map(
          (lf) => {
            return new LabeledFrame({
              video: videoMap.get(lf.video) ?? lf.video,
              frameIdx: lf.frameIdx,
              instances: lf.instances.map(cloneInstance),
              isNegative: lf.isNegative,
              centroids: cloneAncillary(lf.centroids),
              bboxes: cloneAncillary(lf.bboxes),
              masks: cloneAncillary(lf.masks),
              labelImages: cloneAncillary(lf.labelImages),
              rois: cloneAncillary(lf.rois)
            });
          }
        );
      }
      labelsCopy = new _Labels({
        videos: newVideos,
        skeletons: newSkeletons,
        tracks: newTracks,
        suggestions: this.suggestions.map((s) => {
          const newVideo = videoMap.get(s.video) ?? s.video;
          return new SuggestionFrame({
            video: newVideo,
            frameIdx: s.frameIdx,
            group: s.group,
            metadata: { ...s.metadata }
          });
        }),
        // Rebuild sessions via constructors (NOT structuredClone, which strips
        // class prototypes/getters and the non-enumerable frame resolver). In
        // lazy mode frames are not materialized here, so ref-backed grouping is
        // carried as refs and re-resolves against the copy's lazy frame list
        // once injectSessionFrameResolver runs below.
        sessions: this.sessions.map(
          (s) => cloneRecordingSession(s, { videoMap })
        ),
        provenance: { ...this.provenance },
        identities: structuredClone(this.identities)
      });
      labelsCopy._lazyDataStore = newStore;
      labelsCopy._lazyFrameList = newLazyFrames;
      injectSessionFrameResolver(labelsCopy);
    } else {
      const frameMap = /* @__PURE__ */ new Map();
      const instanceMap = /* @__PURE__ */ new Map();
      const newFrames = this.labeledFrames.map((f) => {
        const newInstances = f.instances.map((inst) => {
          const ni = cloneInstance(inst);
          instanceMap.set(inst, ni);
          return ni;
        });
        const nf = new LabeledFrame({
          video: videoMap.get(f.video) ?? f.video,
          frameIdx: f.frameIdx,
          instances: newInstances,
          isNegative: f.isNegative,
          centroids: cloneAncillary(f.centroids),
          bboxes: cloneAncillary(f.bboxes),
          masks: cloneAncillary(f.masks),
          labelImages: cloneAncillary(f.labelImages),
          rois: cloneAncillary(f.rois)
        });
        frameMap.set(f, nf);
        return nf;
      });
      labelsCopy = new _Labels({
        labeledFrames: newFrames,
        videos: newVideos,
        skeletons: newSkeletons,
        tracks: newTracks,
        suggestions: this.suggestions.map((s) => {
          const newVideo = videoMap.get(s.video) ?? s.video;
          return new SuggestionFrame({
            video: newVideo,
            frameIdx: s.frameIdx,
            group: s.group,
            metadata: { ...s.metadata }
          });
        }),
        // Rebuild sessions via constructors, remapping Camera keys and
        // Instance/LabeledFrame references onto the copied objects; ref-backed
        // grouping re-resolves via the resolver injected below.
        sessions: this.sessions.map(
          (s) => cloneRecordingSession(s, { videoMap, frameMap, instanceMap })
        ),
        provenance: { ...this.provenance },
        rois: cloneAncillary(this._staticRois),
        identities: structuredClone(this.identities)
      });
      injectSessionFrameResolver(labelsCopy);
    }
    if (options?.openVideos !== void 0) {
      for (const video of labelsCopy.videos) {
        video.openBackend = options.openVideos;
        if (!options.openVideos) video.close();
      }
    }
    return labelsCopy;
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
  /**
   * Convert labels to a dense `[frames, tracks, nodes, coords]` array.
   *
   * @param options.numFrames Optional explicit length of the output's frame
   *   dimension. Takes precedence over `video.shape[0]` (the inferred fallback).
   *   Useful when `video.shape` is null — for example, Mp4Box-backed browser
   *   videos — and you still want a video-length-sized array. If smaller than
   *   `maxLabeledFrame + 1`, it is clamped up so no labeled frames are dropped.
   *   Non-finite, non-positive, or fractional values are sanitized via
   *   `Math.floor` and ignored when `<= 0`.
   */
  /**
   * Build a dense `(frames, tracks, nodes, channels)` array from instance points.
   *
   * A foreign `Video` instance or filename (`string`/`URL`) is resolved to the
   * matching project `Video` via {@link _resolveVideo} (SYNC; see its documented
   * divergence from `matchVideo`). When `options.video` is absent, defaults to
   * `this.video` (the first video).
   */
  numpy(options) {
    const targetVideo = this._resolveVideo(options?.video) ?? this.video;
    if (this._lazyDataStore) {
      return this._lazyDataStore.toNumpy({ ...options, video: targetVideo });
    }
    const frames = this.labeledFrames.filter(
      (frame) => frame.video.matchesPath(targetVideo, true)
    );
    if (!frames.length) return [];
    let maxFrame = Math.max(...frames.map((frame) => frame.frameIdx));
    const rawOverride = options?.numFrames;
    const override = Number.isFinite(rawOverride) && rawOverride > 0 ? Math.floor(rawOverride) : 0;
    const effectiveLength = override > 0 ? override : targetVideo.shape?.[0] ?? 0;
    if (effectiveLength > 0) {
      maxFrame = Math.max(maxFrame, effectiveLength - 1);
    }
    const tracks = this.tracks.length ? this.tracks.length : Math.max(1, ...frames.map((frame) => frame.instances.length));
    const nodes = this.skeletons[0]?.nodes.length ?? 0;
    const channelCount = options?.returnConfidence ? 3 : 2;
    const videoArray = Array.from(
      { length: maxFrame + 1 },
      () => Array.from(
        { length: tracks },
        () => Array.from(
          { length: nodes },
          () => Array.from({ length: channelCount }, () => Number.NaN)
        )
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
  /**
   * Register an instance's skeleton, deduplicating structurally-equal ones.
   *
   * If a skeleton with the same structure *and* the same node order already
   * exists in `this.skeletons`, the instance is rebound to that canonical object
   * instead of leaking a duplicate. If no match exists, the instance's skeleton
   * is appended as a new canonical skeleton.
   *
   * A skeleton that is already registered (by object identity) is left
   * untouched. This deliberately preserves distinct-but-compatible skeletons a
   * caller added explicitly (e.g. via `new Labels({ skeletons: [...] })`), so
   * workflows that reason about them separately keep working; only
   * newly-discovered duplicates are canonicalized.
   *
   * Matching uses `Skeleton.matches(..., { requireSameOrder: true })` — the same
   * strictness as {@link dedupSkeletons} — so a newly-seen skeleton is only
   * treated as a duplicate when its node names, edges, symmetries, *and* node
   * order all match an existing skeleton. Because the node order is identical,
   * the instance's positional points array is already aligned to the canonical
   * skeleton, so rebinding `inst.skeleton` never moves any point data. Two
   * structurally-equal skeletons with *different* node order are intentionally
   * kept distinct, since their positional point semantics genuinely differ.
   *
   * Mirrors Python `Labels._register_skeleton` (PR #447).
   *
   * @param inst - Instance whose skeleton should be registered. Both `Instance`
   *   and `PredictedInstance` are supported.
   */
  _registerSkeleton(inst) {
    if (this.skeletons.includes(inst.skeleton)) {
      return;
    }
    const canonical = this.skeletons.find(
      (s) => s.matches(inst.skeleton, { requireSameOrder: true })
    );
    if (canonical === void 0) {
      this.skeletons.push(inst.skeleton);
    } else {
      inst.skeleton = canonical;
    }
  }
  /**
   * Update data structures based on contents.
   *
   * Repopulates `videos`, `skeletons`, and `tracks` from the labeled frames,
   * their instances and nested annotations, and the suggestions. Existing
   * entries are preserved (in order); only missing ones are appended.
   *
   * Skeletons are registered via {@link _registerSkeleton}, so two
   * structurally-equal but distinct `Skeleton` objects collapse to a single
   * canonical entry (Python #447) instead of leaking a duplicate.
   *
   * Mirrors Python `Labels.update` (labels.py:435-457).
   */
  update() {
    if (this._lazyFrameList) this.materialize();
    const seenVideos = new Set(this.videos);
    const seenTracks = new Set(this.tracks);
    for (const lf of this.labeledFrames) {
      if (!seenVideos.has(lf.video)) {
        seenVideos.add(lf.video);
        this.videos.push(lf.video);
      }
      for (const inst of lf.instances) {
        this._registerSkeleton(inst);
        if (inst.track != null && !seenTracks.has(inst.track)) {
          seenTracks.add(inst.track);
          this.tracks.push(inst.track);
        }
      }
      this._collectAnnotationTracks(lf, seenTracks);
    }
    for (const sf of this.suggestions) {
      if (!seenVideos.has(sf.video)) {
        seenVideos.add(sf.video);
        this.videos.push(sf.video);
      }
    }
  }
  /**
   * Remap video and track references on a frame's annotations in place.
   *
   * Mirrors Python `Labels._remap_frame_annotations` (labels.py:3621-3648).
   * Centroids/bboxes/masks: only `.track` is remapped. ROIs: both `.video` and
   * `.track`. Label-image objects: nested `info.track` only. Membership is by
   * reference via `Map.has`/`Map.get` (never a `?? default`), so a track/video
   * absent from the map is left untouched.
   *
   * @param frame - LabeledFrame whose annotations should be remapped.
   * @param videoMap - Map from old videos to new videos.
   * @param trackMap - Map from old tracks to new tracks.
   */
  static _remapFrameAnnotations(frame, videoMap, trackMap) {
    for (const ann of [
      ...frame.centroids,
      ...frame.bboxes,
      ...frame.masks
    ]) {
      if (ann.track != null && trackMap.has(ann.track)) {
        ann.track = trackMap.get(ann.track);
      }
    }
    for (const r of frame.rois) {
      if (r.video != null && videoMap.has(r.video)) {
        r.video = videoMap.get(r.video);
      }
      if (r.track != null && trackMap.has(r.track)) {
        r.track = trackMap.get(r.track);
      }
    }
    for (const li of frame.labelImages) {
      for (const info of li.objects.values()) {
        if (info.track != null && trackMap.has(info.track)) {
          info.track = trackMap.get(info.track);
        }
      }
    }
  }
  /**
   * Map an instance to use mapped skeleton and track, returning a NEW instance.
   *
   * Mirrors Python `Labels._map_instance` (labels.py:3953-4020). The source
   * instance is never mutated: its points are deep-copied and the returned
   * instance is a fresh object of the SAME exact type (`Instance` vs
   * `PredictedInstance`, dispatched via `constructor ===`). Skeleton/track are
   * resolved through the maps with `?? original` fallback.
   *
   * When the source instance's node order differs from the mapped skeleton's
   * node order (e.g. the default structure matcher matched `[A, B, C]` with
   * `[C, B, A]`), the points are reordered by node NAME so that each node's
   * coordinates and score follow its name rather than its position (Python
   * #489). When the node orders are identical (the common case) the points are
   * copied positionally to avoid any overhead on the hot path. Nodes present in
   * the mapped skeleton but absent from the source are filled with a missing,
   * invisible point (NaN xy).
   *
   * @param instance - Instance to map.
   * @param skeletonMap - Map from old skeletons to new skeletons.
   * @param trackMap - Map from old tracks to new tracks.
   * @param memo - Optional map from the source instance to the new instance,
   *   mutated in place. Used by {@link _relinkFromPredicted} to repair
   *   `fromPredicted` links so a remapped user instance references the remapped
   *   source prediction now in the merged frame (Python #491).
   * @returns New instance with mapped skeleton and track.
   */
  _mapInstance(instance, skeletonMap, trackMap, memo) {
    const mappedSkeleton = skeletonMap.get(instance.skeleton) ?? instance.skeleton;
    const mappedTrack = instance.track ? trackMap.get(instance.track) ?? instance.track : null;
    const isPredicted = instance.constructor === PredictedInstance;
    const sourcePoints = instance.points;
    const mappedNames = mappedSkeleton.nodeNames;
    let mappedPoints;
    const sameOrder = sourcePoints.length === mappedNames.length && sourcePoints.every((p, i) => p.name === mappedNames[i]);
    if (sameOrder) {
      mappedPoints = sourcePoints.map((p) => clonePoint(p));
    } else {
      const sourceByName = /* @__PURE__ */ new Map();
      for (const p of sourcePoints) {
        if (p.name !== void 0) sourceByName.set(p.name, p);
      }
      mappedPoints = mappedNames.map((name) => {
        const src = sourceByName.get(name);
        if (src !== void 0) {
          return clonePoint(src, name);
        }
        return isPredicted ? {
          xy: [Number.NaN, Number.NaN],
          visible: false,
          complete: false,
          score: Number.NaN,
          name
        } : {
          xy: [Number.NaN, Number.NaN],
          visible: false,
          complete: false,
          name
        };
      });
    }
    let newInstance;
    if (isPredicted) {
      const predicted = instance;
      newInstance = new PredictedInstance({
        points: mappedPoints,
        skeleton: mappedSkeleton,
        score: predicted.score,
        track: mappedTrack,
        trackingScore: predicted.trackingScore,
        fromPredicted: predicted.fromPredicted
      });
    } else {
      newInstance = new Instance({
        points: mappedPoints,
        skeleton: mappedSkeleton,
        track: mappedTrack,
        trackingScore: instance.trackingScore,
        fromPredicted: instance.fromPredicted
      });
    }
    if (memo !== void 0) memo.set(instance, newInstance);
    return newInstance;
  }
  /**
   * Merge another `Labels` object into this one in place.
   *
   * Faithful port of Python `Labels.merge` (labels.py:3149-3618). Runs the fixed
   * 5-step pipeline (skeletons -> videos -> tracks -> frames -> suggestions),
   * building reference-keyed maps FROM `other`'s objects TO `self`'s objects (or
   * to a newly-appended `other` object), and returns a {@link MergeResult}.
   *
   * Async (DECISIONS D8): the AUTO video cascade awaits filesystem and pixel
   * reads. Coercion of the matcher/error-mode arguments happens BEFORE the merge
   * body, so a bad method/error-mode string propagates (it is NOT collected into
   * the result).
   *
   * @param other - The `Labels` to merge into `self`.
   * @param opts.skeleton - Skeleton matcher (`null` -> STRUCTURE; string ->
   *   validated; else used as-is).
   * @param opts.video - Video matcher (`null` -> AUTO).
   * @param opts.track - Track matcher (`null` -> IDENTITY). The default matches
   *   tracks only by object identity (the same Track instance) and appends all
   *   other tracks as new — a correctness-first default that never collapses
   *   distinct tracks by their (often arbitrary, tracker-assigned) names. Pass
   *   `"name"` to match tracks by their name attribute instead, for cases where
   *   track names are semantically meaningful (e.g. user-assigned identities or
   *   identity-classification model outputs).
   * @param opts.frame - The frame merge strategy as a RAW string (default
   *   `"auto"`; NOT validated against the enum — an invalid value falls through
   *   `LabeledFrame.merge`'s strategy chain into the AUTO branch).
   * @param opts.instance - Instance matcher (`null` -> SPATIAL/5.0).
   * @param opts.validate - If `true` (default), an unmatched skeleton under
   *   STRICT raises `SkeletonMismatchError`.
   * @param opts.progressCallback - Called `(current, total, message)` per frame
   *   and once at the end.
   * @param opts.errorMode - `"continue"` (default), `"strict"`, or `"warn"`.
   */
  async merge(other, opts = {}) {
    const skeletonMatcher = coerceSkeletonMatcher(opts.skeleton);
    const videoMatcher = coerceVideoMatcher(opts.video);
    const trackMatcher = coerceTrackMatcher(opts.track);
    const instanceMatcher = coerceInstanceMatcher(opts.instance);
    const frame = opts.frame ?? "auto";
    const validate = opts.validate ?? true;
    const progressCallback = opts.progressCallback;
    const errorModeEnum = toErrorMode(opts.errorMode ?? "continue");
    if (this._lazyFrameList) this.materialize();
    const result = new MergeResult(true);
    if (!("merge_history" in this.provenance)) {
      this.provenance.merge_history = [];
    }
    const mergeHistory = this.provenance.merge_history;
    const mergeRecord = {
      timestamp: localIsoStringWithoutZ(),
      source_filename: other.provenance.filename ?? null,
      target_filename: this.provenance.filename ?? null,
      source_labels: {
        n_frames: other.labeledFrames.length,
        n_videos: other.videos.length,
        n_skeletons: other.skeletons.length,
        n_tracks: other.tracks.length
      },
      strategy: frame,
      sleap_io_version: SLEAP_IO_VERSION
    };
    let total = 0;
    try {
      const skeletonMap = /* @__PURE__ */ new Map();
      for (const otherSkel of other.skeletons) {
        let matched = false;
        for (const selfSkel of this.skeletons) {
          if (skeletonMatcher.match(selfSkel, otherSkel)) {
            skeletonMap.set(otherSkel, selfSkel);
            matched = true;
            break;
          }
        }
        if (!matched) {
          if (validate && errorModeEnum === ErrorMode.STRICT) {
            throw new SkeletonMismatchError(
              `No matching skeleton found for ${otherSkel.name}`,
              { skeleton: otherSkel }
            );
          } else if (errorModeEnum === ErrorMode.WARN) {
            console.warn(`Warning: No matching skeleton for ${otherSkel.name}`);
          }
          this.skeletons.push(otherSkel);
          skeletonMap.set(otherSkel, otherSkel);
        }
      }
      const videoMap = /* @__PURE__ */ new Map();
      const frameIdxMap = /* @__PURE__ */ new Map();
      const setFrameIdx = (v, oldIdx, newVideo, newIdx) => {
        let inner = frameIdxMap.get(v);
        if (inner == null) {
          inner = /* @__PURE__ */ new Map();
          frameIdxMap.set(v, inner);
        }
        inner.set(oldIdx, [newVideo, newIdx]);
      };
      for (const otherVideo of other.videos) {
        let matched = false;
        if (videoMatcher.method === VideoMatchMethod.IMAGE_DEDUP || videoMatcher.method === VideoMatchMethod.SHAPE) {
          for (const selfVideo of this.videos) {
            if (await videoMatcher.match(selfVideo, otherVideo)) {
              if (videoMatcher.method === VideoMatchMethod.IMAGE_DEDUP) {
                const dedupedVideo = otherVideo.deduplicateWith(selfVideo);
                if (dedupedVideo === null) {
                  videoMap.set(otherVideo, selfVideo);
                  if (Array.isArray(otherVideo.filename) && Array.isArray(selfVideo.filename)) {
                    const otherBasenames = otherVideo.filename.map(pathBasename);
                    const selfBasenames = selfVideo.filename.map(pathBasename);
                    otherBasenames.forEach((bn, oldIdx) => {
                      const newIdx = selfBasenames.indexOf(bn);
                      if (newIdx !== -1) {
                        setFrameIdx(otherVideo, oldIdx, selfVideo, newIdx);
                      }
                    });
                  }
                } else {
                  this.videos.push(dedupedVideo);
                  videoMap.set(otherVideo, dedupedVideo);
                  if (Array.isArray(otherVideo.filename) && Array.isArray(dedupedVideo.filename)) {
                    const otherBasenames = otherVideo.filename.map(pathBasename);
                    const dedupedBasenames = dedupedVideo.filename.map(pathBasename);
                    const selfBasenames = Array.isArray(selfVideo.filename) ? selfVideo.filename.map(pathBasename) : [];
                    otherBasenames.forEach((bn, oldIdx) => {
                      const dedupIdx = dedupedBasenames.indexOf(bn);
                      if (dedupIdx !== -1) {
                        setFrameIdx(otherVideo, oldIdx, dedupedVideo, dedupIdx);
                      } else {
                        const selfIdx = selfBasenames.indexOf(bn);
                        if (selfIdx === -1) {
                          throw new Error(
                            "Unexpected basename mismatch, possible file corruption."
                          );
                        }
                        setFrameIdx(otherVideo, oldIdx, selfVideo, selfIdx);
                      }
                    });
                  }
                }
              } else {
                const mergedVideo = selfVideo.mergeWith(otherVideo);
                const selfVideoIdx = this.videos.indexOf(selfVideo);
                this.videos[selfVideoIdx] = mergedVideo;
                videoMap.set(otherVideo, mergedVideo);
                videoMap.set(selfVideo, mergedVideo);
                if (Array.isArray(otherVideo.filename) && Array.isArray(mergedVideo.filename)) {
                  const otherBasenames = otherVideo.filename.map(pathBasename);
                  const mergedBasenames = mergedVideo.filename.map(pathBasename);
                  otherBasenames.forEach((bn, oldIdx) => {
                    const newIdx = mergedBasenames.indexOf(bn);
                    if (newIdx !== -1) {
                      setFrameIdx(otherVideo, oldIdx, mergedVideo, newIdx);
                    }
                  });
                }
              }
              matched = true;
              break;
            }
          }
        } else {
          const matchedVideo = await videoMatcher.findMatch(
            otherVideo,
            this.videos,
            { labelsIncoming: other, labelsBase: this }
          );
          if (matchedVideo !== null) {
            videoMap.set(otherVideo, matchedVideo);
            matched = true;
          }
        }
        if (!matched) {
          this.videos.push(otherVideo);
          videoMap.set(otherVideo, otherVideo);
        }
      }
      const trackMap = /* @__PURE__ */ new Map();
      for (const otherTrack of other.tracks) {
        let matched = false;
        for (const selfTrack of this.tracks) {
          if (trackMatcher.match(selfTrack, otherTrack)) {
            trackMap.set(otherTrack, selfTrack);
            matched = true;
            break;
          }
        }
        if (!matched) {
          this.tracks.push(otherTrack);
          trackMap.set(otherTrack, otherTrack);
        }
      }
      this._warnTrackNameDivergence(
        other,
        videoMap,
        trackMap,
        trackMatcher,
        instanceMatcher
      );
      total = other.labeledFrames.length;
      for (let idx = 0; idx < total; idx++) {
        const otherFrame = other.labeledFrames[idx];
        progressCallback?.(idx, total, `Merging frame ${idx + 1}/${total}`);
        let mappedVideo;
        let mappedFrameIdx;
        const inner = frameIdxMap.get(otherFrame.video);
        const mapped = inner?.get(otherFrame.frameIdx);
        if (mapped != null) {
          [mappedVideo, mappedFrameIdx] = mapped;
        } else {
          mappedVideo = videoMap.get(otherFrame.video) ?? otherFrame.video;
          mappedFrameIdx = otherFrame.frameIdx;
        }
        const matching = this.find({
          video: mappedVideo,
          frameIdx: mappedFrameIdx
        });
        if (matching.length === 0) {
          const newFrame = new LabeledFrame({
            video: mappedVideo,
            frameIdx: mappedFrameIdx,
            instances: [],
            isNegative: otherFrame.isNegative
          });
          const instanceMemo = /* @__PURE__ */ new Map();
          for (const inst of otherFrame.instances) {
            newFrame.instances.push(
              this._mapInstance(inst, skeletonMap, trackMap, instanceMemo)
            );
            result.instancesAdded += 1;
          }
          _relinkFromPredicted(newFrame.instances, instanceMemo);
          newFrame.mergeAnnotations(otherFrame);
          _Labels._remapFrameAnnotations(newFrame, videoMap, trackMap);
          this.append(newFrame);
          result.framesMerged += 1;
        } else {
          const selfFrame = matching[0];
          const selfWasNegative = selfFrame.isNegative;
          const [rawMerged, conflicts] = selfFrame.merge(otherFrame, {
            instance: instanceMatcher,
            frame
          });
          const instanceMemo = /* @__PURE__ */ new Map();
          const mergedInstances = rawMerged.map(
            (inst) => skeletonMap.has(inst.skeleton) ? this._mapInstance(inst, skeletonMap, trackMap, instanceMemo) : inst
          );
          _relinkFromPredicted(mergedInstances, instanceMemo);
          const nBefore = selfFrame.instances.length;
          const nAfter = mergedInstances.length;
          result.instancesAdded += Math.max(0, nAfter - nBefore);
          for (const [orig, nw, resolution] of conflicts) {
            result.conflicts.push(
              new ConflictResolution(
                selfFrame,
                "instance_conflict",
                orig,
                nw,
                resolution
              )
            );
          }
          const [, negativeConflict] = _resolveMergedIsNegative(
            selfWasNegative,
            otherFrame.isNegative,
            mergedInstances
          );
          if (negativeConflict) {
            result.conflicts.push(
              new ConflictResolution(
                selfFrame,
                "negative_flag_conflict",
                selfWasNegative,
                otherFrame.isNegative,
                "dropped_for_user_pose"
              )
            );
          }
          selfFrame.instances = mergedInstances;
          _Labels._remapFrameAnnotations(selfFrame, videoMap, trackMap);
          result.framesMerged += 1;
        }
      }
      for (const otherSuggestion of other.suggestions) {
        const mappedVideo = videoMap.get(otherSuggestion.video) ?? otherSuggestion.video;
        let exists = false;
        for (const selfSuggestion of this.suggestions) {
          if (selfSuggestion.video === mappedVideo && selfSuggestion.frameIdx === otherSuggestion.frameIdx) {
            exists = true;
            break;
          }
        }
        if (!exists) {
          this.suggestions.push(
            new SuggestionFrame({
              video: mappedVideo,
              frameIdx: otherSuggestion.frameIdx
            })
          );
        }
      }
      mergeRecord.result = {
        frames_merged: result.framesMerged,
        instances_added: result.instancesAdded,
        conflicts: result.conflicts.length
        // COUNT, not the list
      };
      mergeHistory.push(mergeRecord);
    } catch (e) {
      if (e instanceof MergeError) {
        result.successful = false;
        result.errors.push(e);
        if (errorModeEnum === ErrorMode.STRICT) throw e;
      } else {
        result.successful = false;
        const err = e;
        result.errors.push(
          new MergeError(String(err?.message ?? e), {
            exception: err?.constructor?.name
          })
        );
        if (errorModeEnum === ErrorMode.STRICT) throw e;
      }
    }
    this._invalidateIndices();
    progressCallback?.(total, total, "Merge complete");
    return result;
  }
  /**
   * Warn when name-matched tracks diverge spatially on all shared frames.
   *
   * Faithful port of Python `Labels._warn_track_name_divergence`
   * (labels.py:3672-3776, PR talmolab/sleap-io#448). Name-based track merging
   * silently coalesces tracks that share a name across two `Labels`. If those
   * tracks actually label different animals, this can glue distinct tracks
   * together. This helper emits a diagnostic `console.warn` (purely additive; it
   * never changes the merge result) when a track pair matched by name carries
   * instances on overlapping frames that do not spatially correspond under the
   * merge's instance matcher.
   *
   * The check is a no-op unless track matching is by NAME (divergence is
   * meaningless for identity/object track matching) and the instance matcher is
   * spatial (SPATIAL or IOU). A warning fires at most once per colliding
   * `(otherTrack, selfTrack)` pair, only when the pair has at least one shared
   * frame with instances on both sides and zero spatial instance matches across
   * all such frames.
   *
   * @param other - The other `Labels` being merged into `self`.
   * @param videoMap - Mapping from `other` videos to the matched `self` videos,
   *   as built in {@link merge}.
   * @param trackMap - Mapping from `other` tracks to the matched `self` tracks
   *   (or back to themselves if appended as new), as built in {@link merge}.
   * @param trackMatcher - The `TrackMatcher` used for the merge. The check is
   *   skipped unless its method is NAME.
   * @param instanceMatcher - The `InstanceMatcher` used for the merge. Reused
   *   here as the divergence primitive (no new threshold introduced). Skipped
   *   when its method is IDENTITY (see below).
   */
  _warnTrackNameDivergence(other, videoMap, trackMap, trackMatcher, instanceMatcher) {
    if (trackMatcher.method !== TrackMatchMethod.NAME) {
      return;
    }
    if (instanceMatcher.method === InstanceMatchMethod.IDENTITY) {
      return;
    }
    const collidingPairs = [];
    for (const [otherTrack, selfTrack] of trackMap.entries()) {
      if (selfTrack !== otherTrack && selfTrack.name === otherTrack.name) {
        collidingPairs.push([otherTrack, selfTrack]);
      }
    }
    if (collidingPairs.length === 0) {
      return;
    }
    for (const [otherTrack, selfTrack] of collidingPairs) {
      let nShared = 0;
      let nMatches = 0;
      let divergentVideo = null;
      for (const otherFrame of other.labeledFrames) {
        const mappedVideo = videoMap.get(otherFrame.video) ?? otherFrame.video;
        const matchingFrames = this.find({
          video: mappedVideo,
          frameIdx: otherFrame.frameIdx
        });
        if (matchingFrames.length === 0) {
          continue;
        }
        const selfInsts = [];
        for (const frame of matchingFrames) {
          for (const inst of frame.instances) {
            if (inst.track === selfTrack) {
              selfInsts.push(inst);
            }
          }
        }
        const otherInsts = otherFrame.instances.filter(
          (inst) => inst.track === otherTrack
        );
        if (selfInsts.length === 0 || otherInsts.length === 0) {
          continue;
        }
        nShared += 1;
        nMatches += instanceMatcher.findMatches(selfInsts, otherInsts).length;
        if (divergentVideo === null) {
          divergentVideo = mappedVideo;
        }
      }
      if (nShared >= 1 && nMatches === 0) {
        const videoRepr = divergentVideo != null ? filenameRepr(divergentVideo.filename) : "None";
        console.warn(
          `Track '${selfTrack.name}' was merged by name across labels that share video ${videoRepr} but instances on that track diverge spatially on all ${nShared} overlapping frame(s) (no instance matched under the merge's instance matcher). If these tracking runs label different animals, name-based merging may glue distinct tracks together. Review the merge or resolve tracks at the instance level.`
        );
      }
    }
  }
  /**
   * Build correspondence maps between this `Labels` and another WITHOUT mutating
   * either (read-only twin of {@link merge}).
   *
   * Faithful port of Python `Labels.match` (labels.py:3020-3147). Coerces only
   * the video/skeleton/track matchers (NO instance matcher, NO error mode). No
   * lazy guard, no try/except, no provenance, no mutation. AUTO videos use the
   * full `findMatch` cascade; every other method (including IMAGE_DEDUP/SHAPE)
   * uses a simple first-match-wins loop. Unmatched -> `null`.
   *
   * Async (DECISIONS D8): the AUTO cascade awaits filesystem/pixel reads.
   *
   * @param other - The `Labels` to match against (maps `other` -> `self`).
   * @param opts.video - Video matcher (`null` -> AUTO).
   * @param opts.skeleton - Skeleton matcher (`null` -> STRUCTURE).
   * @param opts.track - Track matcher (`null` -> IDENTITY). The default matches
   *   tracks only by object identity (the same Track instance); all other tracks
   *   map to `null` — a correctness-first default that never collapses distinct
   *   tracks by their (often arbitrary, tracker-assigned) names. Pass `"name"` to
   *   match tracks by their name attribute instead, for cases where track names
   *   are semantically meaningful (e.g. user-assigned identities or
   *   identity-classification model outputs).
   */
  async match(other, opts = {}) {
    const skeletonMatcher = coerceSkeletonMatcher(opts.skeleton);
    const videoMatcher = coerceVideoMatcher(opts.video);
    const trackMatcher = coerceTrackMatcher(opts.track);
    const result = new MatchResult();
    for (const otherSkel of other.skeletons) {
      let matchedSkel = null;
      for (const selfSkel of this.skeletons) {
        if (skeletonMatcher.match(selfSkel, otherSkel)) {
          matchedSkel = selfSkel;
          break;
        }
      }
      result.skeletonMap.set(otherSkel, matchedSkel);
    }
    for (const otherVideo of other.videos) {
      let matchedVideo;
      if (videoMatcher.method === VideoMatchMethod.AUTO) {
        matchedVideo = await videoMatcher.findMatch(otherVideo, this.videos, {
          labelsIncoming: other,
          labelsBase: this
        });
      } else {
        matchedVideo = null;
        for (const selfVideo of this.videos) {
          if (await videoMatcher.match(selfVideo, otherVideo)) {
            matchedVideo = selfVideo;
            break;
          }
        }
      }
      result.videoMap.set(otherVideo, matchedVideo);
    }
    for (const otherTrack of other.tracks) {
      let matchedTrack = null;
      for (const selfTrack of this.tracks) {
        if (trackMatcher.match(selfTrack, otherTrack)) {
          matchedTrack = selfTrack;
          break;
        }
      }
      result.trackMap.set(otherTrack, matchedTrack);
    }
    return result;
  }
  /**
   * Resolve a video argument to the canonical `Video` in this `Labels` (SYNC).
   *
   * Mirrors Python `Labels._resolve_video` (labels.py:1346-1374). Used internally
   * by the video-accepting query methods ({@link find}, {@link numpy},
   * {@link extract}, and the `get*` family) to canonicalize a foreign `Video`,
   * filename, or index so that identity-based lookups succeed.
   *
   * DOCUMENTED DIVERGENCE (DECISIONS-107): unlike the async {@link matchVideo},
   * this resolver is SYNCHRONOUS and therefore does NOT perform inode/pose/image
   * matching. It uses only the synchronous matching subset:
   *   1. identity (`===`),
   *   2. unique `v.matchesPath(query, true)` (strict; posix-normalized),
   *   3. unique `v.matchesPath(query, false)` (basename),
   * raising on ambiguity (>1 match at a tier) with messages mirroring
   * {@link matchVideo}. For all in-memory and non-existent-file lookups (the
   * realistic case) this is observably identical to Python's `match_video`-based
   * resolution, since strict `matchesPath` already does normalized path equality.
   *
   * @param video - A `Video`, filename (`string`/`URL`), integer index into
   *   `this.videos`, or `null`/`undefined`.
   * @returns The canonical `Video`, or `null` if `video` is `null`/`undefined`.
   *   If no video matches, the foreign `Video` is returned unchanged and a
   *   path is coerced into a new (unopened) `Video`, so identity-based lookups
   *   simply yield empty results (preserving the "no match" behavior).
   */
  _resolveVideo(video) {
    if (video == null) return null;
    if (typeof video === "number") return this.videos[video];
    const query = video instanceof Video ? video : new Video({ filename: String(video), openBackend: false });
    for (const v of this.videos) {
      if (v === query) return v;
    }
    const ambiguous = (candidates, by) => {
      const names = candidates.map((v) => filenameRepr(v.filename)).join(", ");
      return new Error(
        `Ambiguous video match for ${filenameRepr(query.filename)}: matched ${candidates.length} videos ${by}: ${names}.`
      );
    };
    const strict = this.videos.filter((v) => v.matchesPath(query, true));
    if (strict.length > 1) {
      throw ambiguous(strict, "by file identity");
    }
    if (strict.length) return strict[0];
    const byBasename = this.videos.filter((v) => v.matchesPath(query, false));
    if (byBasename.length > 1) {
      throw ambiguous(byBasename, "by basename");
    }
    if (byBasename.length) return byBasename[0];
    return query;
  }
  /**
   * Resolve a foreign `Video` or path to the canonical `Video` in `this.videos`.
   *
   * Faithful port of Python `Labels.match_video` (labels.py:1216-1344). Uses its
   * OWN simpler cascade (NOT `findMatch`). Method validation runs BEFORE the
   * identity short-circuit. RAISES on ambiguity (>1 candidate), unlike
   * {@link match} which silently takes the first.
   *
   * Async (DECISIONS D8): the file-identity tier awaits `isSameFile` / FS checks.
   *
   * @param videoOrPath - A `Video`, or a filename string (wrapped in an unopened
   *   `Video`).
   * @param method - `"auto"` (default), another method string, or a
   *   `VideoMatcher`. AUTO (string or matcher) uses the tiered cascade.
   * @returns The canonical `Video` from `this.videos`, or `null` if none match.
   */
  async matchVideo(videoOrPath, method = "auto") {
    let query;
    if (videoOrPath instanceof Video) {
      query = videoOrPath;
    } else if (typeof videoOrPath === "string") {
      query = new Video({ filename: videoOrPath, openBackend: false });
    } else {
      throw new TypeError(
        `match_video() expects a Video, str, or Path, got ${videoOrPath?.constructor?.name ?? typeof videoOrPath}.`
      );
    }
    let matcher;
    if (typeof method === "string") {
      const methodEnum = toVideoMatchMethod(method);
      matcher = methodEnum === VideoMatchMethod.AUTO ? null : new VideoMatcher(methodEnum);
    } else if (method instanceof VideoMatcher) {
      matcher = method.method === VideoMatchMethod.AUTO ? null : method;
    } else {
      throw new TypeError(
        `match_video() expects method to be a str or VideoMatcher, got ${method?.constructor?.name ?? typeof method}.`
      );
    }
    for (const video of this.videos) {
      if (video === query) return video;
    }
    const ambiguous = (candidates, by) => {
      const names = candidates.map((v) => filenameRepr(v.filename)).join(", ");
      return new Error(
        `Ambiguous video match for ${filenameRepr(query.filename)}: matched ${candidates.length} videos ${by}: ${names}.`
      );
    };
    if (matcher === null) {
      const definitive = [];
      for (const v of this.videos) {
        if (await isSameFile(v, query) || v.matchesPath(query, true)) {
          definitive.push(v);
        }
      }
      if (definitive.length > 1) {
        throw ambiguous(definitive, "by file identity");
      }
      if (definitive.length) {
        return definitive[0];
      }
      const byBasename = this.videos.filter((v) => v.matchesPath(query, false));
      if (byBasename.length > 1) {
        throw ambiguous(byBasename, "by basename");
      }
      return byBasename.length ? byBasename[0] : null;
    }
    const matches = [];
    for (const v of this.videos) {
      if (await matcher.match(v, query)) matches.push(v);
    }
    if (matches.length > 1) {
      throw ambiguous(matches, `with method '${matcher.method}'`);
    }
    return matches.length ? matches[0] : null;
  }
  /**
   * Remove empty frames, unused skeletons, tracks and videos.
   *
   * Mirrors Python `Labels.clean` (labels.py:1577-1682). In-place, returns
   * void. This is an explicit opt-in operation (never auto-run on load).
   *
   * @param opts.frames - If `true` (default), remove empty frames. Negative
   *   frames (`isNegative === true`) and annotation-only frames are preserved.
   * @param opts.emptyInstances - If `true` (NOT default), remove instances with
   *   no visible points (before the emptiness check).
   * @param opts.skeletons - If `true` (default), remove unused skeletons.
   * @param opts.tracks - If `true` (default), remove unused tracks and the
   *   annotations/objects that reference removed tracks (track=null is always
   *   preserved).
   * @param opts.videos - If `true` (NOT default), remove videos with no labeled
   *   frames.
   */
  clean(opts) {
    if (this._lazyFrameList) this.materialize();
    const frames = opts?.frames ?? true;
    const emptyInstances = opts?.emptyInstances ?? false;
    const skeletons = opts?.skeletons ?? true;
    const tracks = opts?.tracks ?? true;
    const videos = opts?.videos ?? false;
    const usedSkeletons = [];
    const usedTracks = [];
    const usedVideos = [];
    const keptFrames = [];
    for (const lf of this.labeledFrames) {
      if (emptyInstances) {
        lf.removeEmptyInstances();
      }
      const hasAnnotations = lf.centroids.length > 0 || lf.bboxes.length > 0 || lf.masks.length > 0 || lf.labelImages.length > 0 || lf.rois.length > 0;
      if (frames && lf.instances.length === 0 && !lf.isNegative && !hasAnnotations) {
        continue;
      }
      if (videos && !usedVideos.includes(lf.video)) {
        usedVideos.push(lf.video);
      }
      if (skeletons || tracks) {
        for (const inst of lf.instances) {
          if (skeletons && !usedSkeletons.includes(inst.skeleton)) {
            usedSkeletons.push(inst.skeleton);
          }
          if (tracks && inst.track != null && !usedTracks.includes(inst.track)) {
            usedTracks.push(inst.track);
          }
        }
      }
      if (tracks) {
        for (const ann of [
          ...lf.centroids,
          ...lf.bboxes,
          ...lf.masks,
          ...lf.rois
        ]) {
          if (ann.track != null && !usedTracks.includes(ann.track)) {
            usedTracks.push(ann.track);
          }
        }
        for (const li of lf.labelImages) {
          for (const info of li.objects.values()) {
            if (info.track != null && !usedTracks.includes(info.track)) {
              usedTracks.push(info.track);
            }
          }
        }
      }
      if (frames) {
        keptFrames.push(lf);
      }
    }
    if (videos) {
      this.videos = this.videos.filter((v) => usedVideos.includes(v));
    }
    if (skeletons) {
      this.skeletons = this.skeletons.filter((s) => usedSkeletons.includes(s));
    }
    if (tracks) {
      this.tracks = this.tracks.filter((t) => usedTracks.includes(t));
      const validTracks = new Set(this.tracks);
      const targetFrames = frames ? keptFrames : this.labeledFrames;
      for (const lf of targetFrames) {
        if (lf.centroids.length) {
          lf.centroids = lf.centroids.filter(
            (a) => a.track == null || validTracks.has(a.track)
          );
        }
        if (lf.bboxes.length) {
          lf.bboxes = lf.bboxes.filter(
            (a) => a.track == null || validTracks.has(a.track)
          );
        }
        if (lf.masks.length) {
          lf.masks = lf.masks.filter(
            (a) => a.track == null || validTracks.has(a.track)
          );
        }
        if (lf.rois.length) {
          lf.rois = lf.rois.filter(
            (a) => a.track == null || validTracks.has(a.track)
          );
        }
        if (lf.labelImages.length) {
          for (const li of lf.labelImages) {
            if (li.objects.size) {
              const kept = new Map(li.objects);
              for (const [k, v] of li.objects) {
                if (!(v.track == null || validTracks.has(v.track))) {
                  kept.delete(k);
                }
              }
              li.objects = kept;
            }
          }
        }
      }
    }
    if (frames) {
      this.labeledFrames = keptFrames;
    }
    this._invalidateIndices();
  }
  /**
   * Extract a set of frames into a new Labels object.
   *
   * Mirrors Python `Labels.extract` (labels.py:2482-2551). Copies the selected
   * frames and their reachable graph (instances/skeletons/tracks/videos/
   * annotations) with structural sharing (each shared object copied once), keeps
   * the relative ordering of tracks/skeletons by NAME, copies/dedups suggestions
   * for the extracted videos, and records the source labels in provenance.
   *
   * @param inds - Frame selection: an array of integer indices, an array of
   *   `[Video, frameIdx]` tuples, or a single `Video` (all of its frames). A
   *   foreign `Video`/filename (`string`/`URL`) selector or tuple element is
   *   resolved to the matching project `Video` via {@link _resolveVideo} (SYNC;
   *   see its documented divergence from `matchVideo`).
   * @param copy - If `true` (default), deep-copy the frames and containing
   *   objects; otherwise share references with this Labels.
   * @returns A new `Labels` containing the selected frames.
   */
  extract(inds, copy = true) {
    if (this._lazyFrameList) this.materialize();
    const resolvedInds = this._resolveExtractInds(inds);
    let lfs = this._selectFrames(resolvedInds);
    if (copy) {
      lfs = this._deepCopyFrames(lfs);
    }
    const labels = new _Labels({ labeledFrames: lfs });
    const trackToInd = /* @__PURE__ */ new Map();
    this.tracks.forEach((t, i) => {
      trackToInd.set(t.name, i);
    });
    labels.tracks = labels.tracks.map((t, i) => [t, i]).sort((a, b) => {
      const ka = trackToInd.get(a[0].name) ?? 0;
      const kb = trackToInd.get(b[0].name) ?? 0;
      return ka === kb ? a[1] - b[1] : ka - kb;
    }).map(([t]) => t);
    const skelToInd = /* @__PURE__ */ new Map();
    this.skeletons.forEach((s, i) => {
      skelToInd.set(s.name ?? "", i);
    });
    labels.skeletons = labels.skeletons.map((s, i) => [s, i]).sort((a, b) => {
      const ka = skelToInd.get(a[0].name ?? "") ?? 0;
      const kb = skelToInd.get(b[0].name ?? "") ?? 0;
      return ka === kb ? a[1] - b[1] : ka - kb;
    }).map(([s]) => s);
    const extractedVideos = new Set(
      this._selectFrames(resolvedInds).map((lf) => lf.video)
    );
    let suggestions = this.suggestions.filter(
      (sf) => extractedVideos.has(sf.video)
    );
    if (copy) {
      suggestions = suggestions.map(
        (sf) => new SuggestionFrame({
          video: sf.video,
          frameIdx: sf.frameIdx,
          group: sf.group,
          metadata: { ...sf.metadata }
        })
      );
    }
    for (const sf of suggestions) {
      for (const vid of labels.videos) {
        if (vid.matchesContent(sf.video) && vid.matchesPath(sf.video)) {
          sf.video = vid;
          break;
        }
      }
    }
    labels.suggestions.push(...suggestions);
    labels.update();
    labels.provenance = { ...labels.provenance };
    labels.provenance.source_labels = this.provenance.filename ?? null;
    return labels;
  }
  /**
   * Canonicalize an {@link extract} selector, resolving foreign `Video` /
   * filename references to the matching project `Video` via {@link _resolveVideo}
   * (SYNC). The `number[]` index-array path is returned unchanged. Returns a
   * narrowed selector that {@link _selectFrames} can consume directly.
   */
  _resolveExtractInds(inds) {
    if (inds instanceof Video) {
      return this._resolveVideo(inds);
    }
    if (typeof inds === "string" || inds instanceof URL) {
      return this._resolveVideo(inds);
    }
    if (Array.isArray(inds)) {
      if (inds.length === 0) return inds;
      if (Array.isArray(inds[0])) {
        return inds.map(
          ([video, frameIdx]) => [this._resolveVideo(video), frameIdx]
        );
      }
      return inds;
    }
    return inds;
  }
  /**
   * Resolve an extraction selection to a list of LabeledFrame references.
   *
   * Supports the subset of Python `__getitem__` selectors needed by
   * `extract`/`split`: integer index arrays, `[Video, frameIdx]` tuple arrays,
   * and a single `Video`. Foreign `Video`/filename references are canonicalized
   * by {@link _resolveExtractInds} before reaching this method, so it receives
   * canonical project `Video` instances.
   */
  _selectFrames(inds) {
    if (inds instanceof Video) {
      return this.find({ video: inds });
    }
    if (Array.isArray(inds)) {
      if (inds.length === 0) return [];
      if (Array.isArray(inds[0])) {
        const tuples = inds;
        const result = [];
        for (const [video, frameIdx] of tuples) {
          const res = this.find({ video, frameIdx });
          if (res.length === 1) {
            result.push(res[0]);
          } else if (res.length === 0) {
            throw new Error(
              `No labeled frames found for video ${video} and frame index ${frameIdx}.`
            );
          }
        }
        return result;
      }
      return inds.map((i) => this.labeledFrames[i]);
    }
    return [];
  }
  /**
   * Deep-copy a list of frames with structural sharing.
   *
   * Reproduces Python `deepcopy(lfs)`: shared Track/Skeleton/Video objects within
   * the selected subgraph are copied exactly once (via memo maps), so references
   * shared across frames/instances remain shared in the copy.
   */
  _deepCopyFrames(frames) {
    const videoMap = /* @__PURE__ */ new Map();
    const skeletonMap = /* @__PURE__ */ new Map();
    const trackMap = /* @__PURE__ */ new Map();
    const mapVideo = (v) => {
      let nv = videoMap.get(v);
      if (!nv) {
        nv = new Video({
          filename: Array.isArray(v.filename) ? [...v.filename] : v.filename,
          backendMetadata: { ...v.backendMetadata },
          openBackend: v.openBackend,
          embedded: v.hasEmbeddedImages
        });
        nv.shape = v.shape;
        nv.fps = v.fps;
        videoMap.set(v, nv);
      }
      return nv;
    };
    const mapSkeleton = (s) => {
      let ns = skeletonMap.get(s);
      if (!ns) {
        const nodeMap = /* @__PURE__ */ new Map();
        const newNodes = s.nodes.map((n) => {
          const nn = new Node(n.name);
          nodeMap.set(n, nn);
          return nn;
        });
        const newEdges = s.edges.map(
          (e) => new Edge(nodeMap.get(e.source), nodeMap.get(e.destination))
        );
        const newSymmetries = s.symmetries.map((sym) => {
          const nodes = [...sym.nodes];
          return new Symmetry([nodeMap.get(nodes[0]), nodeMap.get(nodes[1])]);
        });
        ns = new Skeleton({
          nodes: newNodes,
          edges: newEdges,
          symmetries: newSymmetries,
          name: s.name
        });
        skeletonMap.set(s, ns);
      }
      return ns;
    };
    const mapTrack = (t) => {
      if (t == null) return null;
      let nt = trackMap.get(t);
      if (!nt) {
        nt = new Track(t.name);
        trackMap.set(t, nt);
      }
      return nt;
    };
    const cloneInstance = (inst) => {
      const newPoints = inst.points.map((p) => clonePoint(p));
      const newSkeleton = mapSkeleton(inst.skeleton);
      const newTrack = mapTrack(inst.track);
      if (inst.constructor === PredictedInstance) {
        const predicted = inst;
        return new PredictedInstance({
          points: newPoints,
          skeleton: newSkeleton,
          track: newTrack,
          score: predicted.score,
          trackingScore: predicted.trackingScore
        });
      }
      return new Instance({
        points: newPoints,
        skeleton: newSkeleton,
        track: newTrack,
        trackingScore: inst.trackingScore
      });
    };
    const cloneAncillary = (items) => items.map((item) => {
      const clone = Object.create(
        Object.getPrototypeOf(item),
        Object.getOwnPropertyDescriptors(item)
      );
      const anyClone = clone;
      if ("video" in anyClone && anyClone.video != null) {
        anyClone.video = mapVideo(anyClone.video);
      }
      if ("track" in anyClone && anyClone.track != null) {
        anyClone.track = mapTrack(anyClone.track);
      }
      if ("instance" in anyClone) {
        anyClone.instance = null;
      }
      if ("objects" in anyClone && anyClone.objects instanceof Map) {
        const oldObjects = anyClone.objects;
        const newObjects = /* @__PURE__ */ new Map();
        for (const [id, info] of oldObjects) {
          const newInfo = { ...info };
          if (newInfo.track != null) {
            newInfo.track = mapTrack(newInfo.track);
          }
          newInfo.instance = null;
          newObjects.set(id, newInfo);
        }
        anyClone.objects = newObjects;
      }
      return clone;
    });
    return frames.map(
      (f) => new LabeledFrame({
        video: mapVideo(f.video),
        frameIdx: f.frameIdx,
        instances: f.instances.map(cloneInstance),
        isNegative: f.isNegative,
        centroids: cloneAncillary(f.centroids),
        bboxes: cloneAncillary(f.bboxes),
        masks: cloneAncillary(f.masks),
        labelImages: cloneAncillary(f.labelImages),
        rois: cloneAncillary(f.rois)
      })
    );
  }
  /**
   * Separate the labels into two random splits.
   *
   * Mirrors Python `Labels.split` (labels.py:2553-2607) for the count/branch
   * logic. Per DECISIONS D5, the index selection uses a deterministic seeded
   * RNG (NOT NumPy PCG64) — counts and edge cases match Python exactly, but the
   * specific frames chosen are not bit-identical to NumPy.
   *
   * @param n - Size of the first split. `>= 1` is an absolute frame count;
   *   `< 1.0` is a fraction of the total (`max(trunc(n0*n), 1)`).
   * @param seed - Optional integer seed for reproducibility within JS. When
   *   omitted/null, a fixed default seed is used.
   * @returns A `LabelsSet` with keys `"split1"` and `"split2"`.
   */
  split(n, seed) {
    if (this._lazyFrameList) this.materialize();
    const n0 = this.labeledFrames.length;
    if (n0 === 0) {
      return new LabelsSet({ split1: this, split2: this });
    }
    let n1;
    if (n < 1) {
      n1 = Math.max(Math.trunc(n0 * n), 1);
    } else {
      n1 = Math.trunc(n);
    }
    const rng = _Labels._mulberry32(seed == null ? 2654435769 : seed >>> 0);
    const pool = Array.from({ length: n0 }, (_, i) => i);
    const take = Math.min(n1, n0);
    for (let i = 0; i < take; i += 1) {
      const j = i + Math.floor(rng() * (n0 - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const inds1 = pool.slice(0, take);
    let inds2;
    if (n0 === 1) {
      inds2 = [0];
    } else {
      const inds1Set = new Set(inds1);
      inds2 = [];
      for (let i = 0; i < n0; i += 1) {
        if (!inds1Set.has(i)) inds2.push(i);
      }
    }
    const split1 = this.extract(inds1, true);
    const split2 = this.extract(inds2, true);
    return new LabelsSet({ split1, split2 });
  }
  /** Deterministic 32-bit RNG (mulberry32). Returns floats in [0, 1). */
  static _mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
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
      this.video?.addEventListener(
        "error",
        () => reject(new Error("Failed to load video"))
      );
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
    const symmetries = skeleton.symmetries.map(
      (sym) => {
        const [left, right] = sym.nodes;
        return [skeleton.index(left.name), skeleton.index(right.name)];
      }
    );
    return {
      name: skeleton.name ?? void 0,
      nodes: skeleton.nodeNames,
      edges,
      symmetries
    };
  });
  const labeledFrames = [];
  for (const frame of labels.labeledFrames) {
    if (videoFilter && !frame.video.matchesPath(videoFilter.video, true))
      continue;
    if (options?.skipEmptyFrames && frame.instances.length === 0 && !frame.isNegative)
      continue;
    const videoIdx = videos.indexOf(frame.video);
    if (videoIdx < 0) continue;
    labeledFrames.push({
      frame_idx: frame.frameIdx,
      video_idx: videoIdx,
      instances: frame.instances.map(
        (instance) => instanceToDict(instance, labels, trackIndex)
      ),
      ...frame.isNegative ? { is_negative: true } : {}
    });
  }
  const suggestions = labels.suggestions.filter(
    (suggestion) => !videoFilter || suggestion.video.matchesPath(videoFilter.video, true)
  ).map((suggestion) => ({
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
    const edges = skeleton.edges.map(
      ([sourceIdx, destIdx]) => new Edge(nodes[sourceIdx], nodes[destIdx])
    );
    const symmetries = (skeleton.symmetries ?? []).map(
      ([leftIdx, rightIdx]) => new Symmetry([nodes[leftIdx], nodes[rightIdx]])
    );
    return new Skeleton({ name: skeleton.name, nodes, edges, symmetries });
  });
  const videos = data.videos.map(
    (video) => new Video({ filename: video.filename })
  );
  const tracks = data.tracks.map(
    (track) => new Track(String(track.name ?? ""))
  );
  const labeledFrames = data.labeled_frames.map((frame) => {
    const video = videos[frame.video_idx];
    const instances = frame.instances.map(
      (inst) => dictToInstance(inst, skeletons, tracks)
    );
    return new LabeledFrame({
      video,
      frameIdx: frame.frame_idx,
      instances,
      isNegative: frame.is_negative ?? false
    });
  });
  const suggestions = data.suggestions.map((suggestion) => {
    const entry = suggestion;
    const video = videos[entry.video_idx ?? 0];
    return new SuggestionFrame({
      video,
      frameIdx: entry.frame_idx ?? 0,
      metadata: entry
    });
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
  const required = [
    "version",
    "skeletons",
    "videos",
    "tracks",
    "labeled_frames",
    "suggestions",
    "provenance"
  ];
  for (const key of required) {
    if (!(key in data)) {
      throw new Error(`Missing required key: ${key}`);
    }
  }
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
  /** Extra HTTP headers (e.g. Authorization) applied to every byte fetch. */
  headers;
  constructor(source, options) {
    if (!hasWebCodecs) {
      throw new Error("Mp4BoxVideoBackend requires WebCodecs support.");
    }
    if (!isBrowser2) {
      throw new Error("Mp4BoxVideoBackend requires a browser environment.");
    }
    this.filename = source instanceof Blob ? source.name ?? "" : source;
    this.dataset = null;
    this.headers = options?.headers ?? {};
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
  async getFrame(frameIndex, opts) {
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
    this.decodeQueue = this.decodeQueue.then(async () => {
      if (this.latestRequestedFrame !== frameIndex) return;
      if (opts?.signal?.aborted) return;
      const keyframe = this.findKeyframeBefore(frameIndex);
      const end = Math.min(
        frameIndex + this.lookahead,
        this.samples.length - 1
      );
      await this.decodeRange(keyframe, end, frameIndex);
    });
    await this.decodeQueue;
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
    this.cache.forEach((bitmap) => {
      bitmap.close();
    });
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
    const response = await fetchRetrying(this.filename, {
      headers: { ...identityHeaders(this.headers), Range: "bytes=0-0" }
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
      throw new RemoteIOError({
        message: statusToMessage(response.status),
        url: this.filename,
        status: response.status
      });
    }
    const full = await fetchRetrying(this.filename, {
      headers: { ...this.headers }
    });
    if (!full.ok) {
      throw new RemoteIOError({
        message: statusToMessage(full.status),
        url: this.filename,
        status: full.status
      });
    }
    const blob = await full.blob();
    this.fileBlob = blob;
    this.fileSize = blob.size;
    this.supportsRangeRequests = false;
  }
  async readChunk(offset, size) {
    const end = Math.min(offset + size, this.fileSize);
    if (this.supportsRangeRequests) {
      const response = await fetchRetrying(this.filename, {
        headers: {
          ...identityHeaders(this.headers),
          Range: `bytes=${offset}-${end - 1}`
        }
      });
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
        results.set(
          sample.decodeIndex,
          bufferView.slice(bufferOffset, bufferOffset + sample.size)
        );
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

// src/video/embedded-frame.ts
var PNG_MAGIC = new Uint8Array([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10
]);
var JPEG_MAGIC = new Uint8Array([255, 216, 255]);
function isEncodedFormat(format) {
  const n = format.toLowerCase();
  return n === "png" || n === "jpg" || n === "jpeg";
}
function magicFor(format) {
  return format.toLowerCase() === "png" ? PNG_MAGIC : JPEG_MAGIC;
}
function matchesMagicAt(buffer, pos, magic) {
  if (pos + magic.length > buffer.length) return false;
  for (let k = 0; k < magic.length; k++) {
    if (buffer[pos + k] !== magic[k]) return false;
  }
  return true;
}
function startsWithImageMagic(buffer) {
  return matchesMagicAt(buffer, 0, PNG_MAGIC) || matchesMagicAt(buffer, 0, JPEG_MAGIC);
}
function findEncodedFrameOffsets(buffer, format, expectedFrameCount) {
  const magic = magicFor(format);
  const m0 = magic[0];
  const L = magic.length;
  const limit = buffer.length - L;
  const offsets = [];
  for (let i = 0; i <= limit; i++) {
    if (buffer[i] !== m0) continue;
    let ok = true;
    for (let k = 1; k < L; k++) {
      if (buffer[i + k] !== magic[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    offsets.push(i);
    i += L - 1;
    if (expectedFrameCount > 0 && offsets.length >= expectedFrameCount) break;
  }
  return offsets;
}
function computeOffsetsFromSizes(sizes) {
  const offsets = new Array(sizes.length);
  let off = 0;
  for (let i = 0; i < sizes.length; i++) {
    offsets[i] = off;
    off += sizes[i];
  }
  return offsets;
}
function trimPaddedRow(row, size) {
  if (size != null && size >= 0 && size <= row.length) {
    return size === row.length ? row : row.subarray(0, size);
  }
  let end = row.length;
  while (end > 0 && row[end - 1] === 0) end--;
  return end === row.length ? row : row.subarray(0, end);
}
function classifyLayout(shape, frameCount) {
  if (shape.length >= 2) return "padded";
  if (shape.length === 1) {
    if (frameCount > 0) return shape[0] === frameCount ? "vlen" : "concat";
    return "ambiguous1d";
  }
  return "ambiguous1d";
}
function rowSlice(shape, index) {
  return shape.map(
    (dim, d) => d === 0 ? [index, index + 1] : [0, dim]
  );
}
function asUint8Array(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const v = value;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  if (typeof value === "object" && "buffer" in value) {
    return new Uint8Array(value.buffer);
  }
  return null;
}
function readVlenElementManual(Module, dataset, index) {
  if (!Module || !Module._malloc || !Module.HEAPU8 || !Module.get_dataset_data) {
    return null;
  }
  const md = dataset.metadata;
  const vlenClass = Module.H5T_class_t?.H5T_VLEN.value;
  const isVlen = md?.vlen === true || vlenClass != null && md?.type === vlenClass;
  if (!isVlen || md?.size !== 8) return null;
  const dataPtr = Module._malloc(md.size);
  if (!dataPtr) return null;
  try {
    Module.get_dataset_data(
      dataset.file_id,
      dataset.path,
      [1n],
      [BigInt(index)],
      [1n],
      BigInt(dataPtr)
    );
    const u32 = new Uint32Array(Module.HEAPU8.buffer, Number(dataPtr), 2);
    const len = u32[0];
    const blobPtr = u32[1];
    if (!blobPtr) return new Uint8Array(0);
    const out = Module.HEAPU8.slice(blobPtr, blobPtr + len);
    Module._free(blobPtr);
    return out;
  } finally {
    Module._free(dataPtr);
  }
}
async function readEmbeddedFrameBytes(reader, index) {
  if (index < 0) return null;
  const meta = await reader.getMeta();
  const shape = meta.shape ?? [];
  const layout = classifyLayout(shape, reader.frameCount);
  const encoded = isEncodedFormat(reader.format);
  if (layout === "padded") {
    const { value } = await reader.readSlice(rowSlice(shape, index));
    const row = asUint8Array(value);
    if (!row) return null;
    return encoded ? trimPaddedRow(row, reader.frameSizes?.[index]) : row;
  }
  if (layout === "vlen") {
    if (reader.readVlenElement) {
      const out = await reader.readVlenElement(index);
      if (out) return out;
    }
    if (!reader.legacy.whole) {
      const { value } = await reader.readSlice();
      reader.legacy.whole = Array.isArray(value) ? value : [];
    }
    const whole2 = reader.legacy.whole;
    return Array.isArray(whole2) ? asUint8Array(whole2[index]) : null;
  }
  if (layout === "concat" && reader.frameSizes && reader.frameSizes.length > index) {
    reader.legacy.offsets ??= computeOffsetsFromSizes(reader.frameSizes);
    const offsets2 = reader.legacy.offsets;
    const start = offsets2[index];
    const end = start + reader.frameSizes[index];
    const { value } = await reader.readSlice([[start, end]]);
    return asUint8Array(value);
  }
  if (!reader.legacy.whole) {
    const { value } = await reader.readSlice();
    if (Array.isArray(value)) {
      reader.legacy.whole = value;
    } else {
      const buf2 = asUint8Array(value);
      if (!buf2) return null;
      reader.legacy.whole = buf2;
      if (encoded && startsWithImageMagic(buf2)) {
        reader.legacy.offsets = findEncodedFrameOffsets(
          buf2,
          reader.format,
          reader.frameCount
        );
      }
    }
  }
  const whole = reader.legacy.whole;
  if (Array.isArray(whole)) {
    return asUint8Array(whole[index]);
  }
  const buf = whole;
  const offsets = reader.legacy.offsets;
  if (offsets && offsets.length > index) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length;
    return buf.slice(start, end);
  }
  return null;
}

// src/video/streaming-hdf5-video.ts
var isBrowser3 = typeof window !== "undefined" && typeof document !== "undefined";
var StreamingHdf5VideoBackend = class {
  filename;
  dataset;
  shape;
  fps;
  /** Source frame numbers with a stored image (storage order). */
  frameNumbers;
  h5file;
  datasetPath;
  frameNumberToIndex;
  format;
  channelOrder;
  frameSizes;
  legacy;
  metaCache;
  constructor(options) {
    this.filename = options.filename;
    this.h5file = options.h5file;
    this.datasetPath = options.datasetPath;
    this.dataset = options.datasetPath;
    const frameNumbers = options.frameNumbers ?? [];
    this.frameNumbers = frameNumbers;
    this.frameNumberToIndex = new Map(
      frameNumbers.map((num, idx) => [num, idx])
    );
    this.format = options.format ?? "png";
    this.channelOrder = options.channelOrder ?? "RGB";
    this.frameSizes = options.frameSizes;
    this.shape = options.shape;
    this.fps = options.fps;
    this.legacy = { whole: null, offsets: null };
    this.metaCache = null;
  }
  async getFrame(frameIndex) {
    const index = this.frameNumberToIndex.size > 0 ? this.frameNumberToIndex.get(frameIndex) : frameIndex;
    if (index === void 0) return null;
    let rawBytes;
    try {
      rawBytes = await readEmbeddedFrameBytes(this.buildReader(), index);
    } catch {
      return null;
    }
    if (!rawBytes || rawBytes.length === 0) return null;
    if (isEncodedFormat(this.format)) {
      const decoded = await decodeImageBytes(
        rawBytes,
        this.format,
        this.channelOrder
      );
      return decoded ?? rawBytes;
    }
    const image = decodeRawFrame(rawBytes, this.shape, this.channelOrder);
    return image ?? rawBytes;
  }
  async probeShape(sourceFrameCount) {
    if (this.shape && this.shape[0] > 0) return;
    try {
      const rawBytes = await readEmbeddedFrameBytes(this.buildReader(), 0);
      if (!rawBytes || rawBytes.length === 0) return;
      if (isEncodedFormat(this.format)) {
        const decoded = await decodeImageBytes(
          rawBytes,
          this.format,
          this.channelOrder
        );
        if (decoded && "width" in decoded && "height" in decoded) {
          let fc = sourceFrameCount ?? 0;
          if (!fc && this.frameNumberToIndex.size > 0) {
            let maxIdx = 0;
            for (const key of this.frameNumberToIndex.keys()) {
              if (key > maxIdx) maxIdx = key;
            }
            fc = maxIdx + 1;
          }
          const channels = this.shape?.[3] ?? 4;
          this.shape = [fc, decoded.height, decoded.width, channels];
        }
      }
    } catch {
    }
  }
  /**
   * Crop pushdown hook (Item 1 of JS issue #153). Always returns `null`: this
   * streaming embedded backend stores opaque encoded blobs (PNG/JPEG) or
   * per-frame-indexed raw rows, neither of which can be spatially hyperslabbed
   * without first decoding the whole frame. Pushdown is structurally impossible
   * here, so the crop wrapper falls back to full-decode + `cropFrame`. (A raw
   * rank-4 chunked HDF5 pixel-array backend, which COULD push down over the
   * worker's `dataset.slice`, does not exist in the JS port yet; see backend.ts
   * `readCrop` doc.) Short-circuits before any network read.
   */
  async readCrop() {
    return null;
  }
  /** Build a single-frame reader bound to the streaming worker file. */
  buildReader() {
    return {
      frameCount: this.frameNumberToIndex.size,
      format: this.format,
      frameSizes: this.frameSizes,
      legacy: this.legacy,
      getMeta: async () => {
        if (!this.metaCache) {
          this.metaCache = await this.h5file.getDatasetMeta(this.datasetPath);
        }
        return this.metaCache;
      },
      readSlice: async (slice) => {
        const data = await this.h5file.getDatasetValue(this.datasetPath, slice);
        return { value: data.value, shape: data.shape };
      },
      readVlenElement: async (index) => {
        const data = await this.h5file.getDatasetValue(this.datasetPath, [
          [index, index + 1]
        ]);
        const value = data.value;
        if (value instanceof Uint8Array) return value;
        if (Array.isArray(value)) return asUint8Array(value[index]);
        return asUint8Array(value);
      }
    };
  }
  close() {
    this.legacy.whole = null;
    this.legacy.offsets = null;
    this.metaCache = null;
  }
};
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

// src/video/image-source.ts
var _reader = null;
var _default = null;
function setImageBytesReader(reader) {
  _reader = reader;
}
function setDefaultImageBytesReader(reader) {
  _default = reader;
}
function getImageBytesReader() {
  return _reader ?? _default;
}

// src/video/lru-cache.ts
var LruCache = class {
  /**
   * @param maxBytes Soft byte budget. Eviction runs after each `set` until the
   *   total is within budget — except the entry just set is never evicted, so a
   *   single oversized entry is kept (you still need it to render).
   * @param sizeOf Byte size of a value. Must be deterministic for a given value.
   */
  constructor(maxBytes, sizeOf) {
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }
  map = /* @__PURE__ */ new Map();
  bytes = 0;
  get size() {
    return this.map.size;
  }
  get totalBytes() {
    return this.bytes;
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return void 0;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.size;
      this.map.delete(key);
    }
    const size = this.sizeOf(value);
    this.map.set(key, { value, size });
    this.bytes += size;
    this.evict();
  }
  delete(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.bytes -= entry.size;
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
  keys() {
    return this.map.keys();
  }
  evict() {
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      const entry = this.map.get(oldest);
      if (!entry) break;
      this.bytes -= entry.size;
      this.map.delete(oldest);
    }
  }
};

// src/video/image-video.ts
function computePrefetchWindow(current, last, length, ahead, behind) {
  const dir = last === null || current >= last ? 1 : -1;
  const out = [];
  for (let k = 1; k <= ahead; k++) out.push(current + dir * k);
  for (let k = 1; k <= behind; k++) out.push(current - dir * k);
  return out.filter((i) => i >= 0 && i < length && i !== current);
}
var DEFAULT_BYTES_CACHE = 128 * 1024 * 1024;
var DEFAULT_DECODED_CACHE = 64 * 1024 * 1024;
var DEFAULT_PREFETCH_CONCURRENCY = 6;
var DEFAULT_PREFETCH_AHEAD = 8;
var DEFAULT_PREFETCH_BEHIND = 2;
var ImageVideoBackend = class _ImageVideoBackend {
  filename;
  shape;
  reader;
  // Two-tier cache: a large tier of raw encoded bytes (kills the network read on
  // revisit/prefetch) and a small tier of decoded frames (kills the re-decode).
  bytesCache;
  decodedCache;
  // In-flight byte reads, so a getFrame and a prefetch of the same frame share
  // one read instead of racing.
  inflight = /* @__PURE__ */ new Map();
  prefetchConcurrency;
  prefetchAhead;
  prefetchBehind;
  lastIndex = null;
  // Bumped each time a new prefetch window is issued; in-flight prefetch workers
  // stop pulling new frames once superseded (e.g. the user jumps away).
  prefetchGen = 0;
  /**
   * The in-flight auto-prefetch promise from the most recent `getFrame`. Resolves
   * when that window finishes (or is superseded). Exposed for coordination/tests;
   * callers normally ignore it.
   */
  lastPrefetch = Promise.resolve();
  constructor(filename, reader, shape, cfg) {
    this.filename = filename;
    this.reader = reader;
    this.shape = shape;
    this.bytesCache = new LruCache(cfg.bytesCacheBytes, (b) => b.byteLength);
    this.decodedCache = new LruCache(
      cfg.decodedCacheBytes,
      (f) => f.data.byteLength
    );
    this.prefetchConcurrency = cfg.prefetchConcurrency;
    this.prefetchAhead = cfg.prefetchAhead;
    this.prefetchBehind = cfg.prefetchBehind;
  }
  /**
   * Build a backend, inferring `shape` by decoding `filename[0]` once (cached)
   * when no `shape` is supplied — parity with Python `VideoBackend.img_shape`
   * (`read_test_frame` -> `_read_frame(0)`; index 0, not "first available").
   */
  static async create(opts) {
    const reader = opts.reader ?? getImageBytesReader();
    if (!reader) {
      throw new Error(
        "ImageVideoBackend requires an image-bytes reader, but none is injected. On desktop/Node a default is registered; in the browser supply one via setImageBytesReader()."
      );
    }
    const frames = opts.filename.length;
    let height = 0;
    let width = 0;
    let channels = 0;
    let seedBytes;
    let seedFrame;
    if (opts.shape) {
      [, height, width, channels] = opts.shape;
    } else if (frames > 0) {
      seedBytes = await reader(opts.filename[0]);
      seedFrame = await decodeEncoded(seedBytes);
      height = seedFrame.height;
      width = seedFrame.width;
      channels = isGrayscale(seedFrame) ? 1 : 3;
    }
    const be = new _ImageVideoBackend(
      opts.filename,
      reader,
      [frames, height, width, channels],
      {
        bytesCacheBytes: opts.bytesCacheBytes ?? DEFAULT_BYTES_CACHE,
        decodedCacheBytes: opts.decodedCacheBytes ?? DEFAULT_DECODED_CACHE,
        prefetchConcurrency: opts.prefetchConcurrency ?? DEFAULT_PREFETCH_CONCURRENCY,
        prefetchAhead: opts.prefetchAhead ?? DEFAULT_PREFETCH_AHEAD,
        prefetchBehind: opts.prefetchBehind ?? DEFAULT_PREFETCH_BEHIND
      }
    );
    if (seedBytes) be.bytesCache.set(0, seedBytes);
    if (seedFrame) be.decodedCache.set(0, seedFrame);
    return be;
  }
  async getFrame(frameIndex, opts) {
    if (frameIndex < 0 || frameIndex >= this.filename.length) return null;
    if (opts?.prefetch !== false) this.triggerPrefetch(frameIndex);
    const decoded = this.decodedCache.get(frameIndex);
    if (decoded) return decoded;
    const bytes = await this.startRead(frameIndex);
    const frame = await decodeEncoded(bytes);
    this.decodedCache.set(frameIndex, frame);
    return frame;
  }
  /**
   * Read a frame's encoded bytes, serving from the bytes tier when present (no
   * network) and coalescing concurrent reads of the same frame via `inflight` so
   * a getFrame and a prefetch never read the same file twice.
   */
  startRead(frameIndex) {
    const cached = this.bytesCache.get(frameIndex);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(frameIndex);
    if (existing) return existing;
    const p = (async () => {
      try {
        const bytes = await this.reader(this.filename[frameIndex]);
        this.bytesCache.set(frameIndex, bytes);
        return bytes;
      } finally {
        this.inflight.delete(frameIndex);
      }
    })();
    this.inflight.set(frameIndex, p);
    return p;
  }
  /**
   * Read a window of frames' bytes into the bytes tier, concurrency-capped, and
   * cancellable: a later prefetch (or a jump) bumps the generation so in-flight
   * workers stop pulling new frames. Resolves when this window finishes or is
   * superseded. Frames already cached or in flight are skipped.
   */
  prefetch(indices) {
    const gen = ++this.prefetchGen;
    const queue = [...new Set(indices)].filter(
      (i) => i >= 0 && i < this.filename.length && !this.bytesCache.has(i)
    );
    let next = 0;
    const worker = async () => {
      while (next < queue.length && gen === this.prefetchGen) {
        const i = queue[next++];
        if (this.bytesCache.has(i)) continue;
        try {
          await this.startRead(i);
        } catch {
        }
      }
    };
    const n = Math.min(this.prefetchConcurrency, queue.length);
    return Promise.all(Array.from({ length: n }, () => worker())).then(
      () => void 0
    );
  }
  /** Compute and launch the read-ahead window for `frameIndex` (fire-and-forget). */
  triggerPrefetch(frameIndex) {
    const window2 = computePrefetchWindow(
      frameIndex,
      this.lastIndex,
      this.filename.length,
      this.prefetchAhead,
      this.prefetchBehind
    );
    this.lastIndex = frameIndex;
    this.lastPrefetch = this.prefetch(window2);
  }
  close() {
    this.bytesCache.clear();
    this.decodedCache.clear();
    this.inflight.clear();
  }
};
function isGrayscale(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] !== d[i + 2]) return false;
  }
  return true;
}

// src/video/seq-video.ts
var IMAGE_FORMAT_CODES = {
  100: "monoraw",
  // Grayscale uncompressed
  200: "raw",
  // Color BGR uncompressed
  101: "brgb8",
  // Bayer pattern raw
  102: "monojpg",
  // Grayscale JPEG compressed
  201: "jpg",
  // Color JPEG compressed
  103: "jbrgb",
  // Bayer JPEG compressed
  1: "monopng",
  // Grayscale PNG compressed
  2: "png"
  // Color PNG compressed
};
var COMPRESSED_CODECS = /* @__PURE__ */ new Set([
  "monojpg",
  "jpg",
  "jbrgb",
  "monopng",
  "png"
]);
var BAYER_CODECS = /* @__PURE__ */ new Set(["brgb8", "jbrgb"]);
var HEADER_SIZE = 1024;
var MAGIC = 65261;
var BlobByteSource = class {
  blob;
  constructor(blob) {
    this.blob = blob;
  }
  async size() {
    return this.blob.size;
  }
  async read(offset, length) {
    const end = Math.min(offset + length, this.blob.size);
    if (end <= offset) return new Uint8Array(0);
    const buf = await this.blob.slice(offset, end).arrayBuffer();
    return new Uint8Array(buf);
  }
  close() {
  }
};
var fileByteSourceFactory = null;
function setSeqFileByteSourceFactory(factory) {
  fileByteSourceFactory = factory;
}
function createFileByteSource(path) {
  if (!fileByteSourceFactory) {
    throw new Error(
      "Reading .seq files from a path requires the Node entry point (`@talmolab/sleap-io.js`). In the browser, pass a File/Blob instead."
    );
  }
  return fileByteSourceFactory(path);
}
var SeqHeader = class _SeqHeader {
  magic = MAGIC;
  name = "Norpix seq";
  version = 0;
  headerSize = HEADER_SIZE;
  description = "";
  width = 0;
  height = 0;
  bitDepth = 8;
  bitDepthReal = 8;
  imageSizeBytes = 0;
  imageFormat = 100;
  numFrames = 0;
  trueImageSize = 0;
  fps = 30;
  codec = "";
  /** Human-readable codec name (e.g. `"monoraw"`). */
  get codecName() {
    return IMAGE_FORMAT_CODES[this.imageFormat] ?? `unknown(${this.imageFormat})`;
  }
  /** Whether frames use variable-length compression (JPEG/PNG). */
  get isCompressed() {
    return COMPRESSED_CODECS.has(this.codecName);
  }
  /** Number of color channels (`bitDepth / bitDepthReal`). */
  get numChannels() {
    return Math.floor(this.bitDepth / (this.bitDepthReal || 8));
  }
  /**
   * Parse the 1024-byte header from a byte buffer.
   *
   * @throws If the buffer is too small or has an invalid magic number.
   */
  static fromBytes(raw) {
    if (raw.length < HEADER_SIZE) {
      throw new Error("File too small to contain a valid .seq header");
    }
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== MAGIC) {
      throw new Error(
        `Invalid .seq magic: 0x${magic.toString(16).toUpperCase()} (expected 0x${MAGIC.toString(16).toUpperCase()})`
      );
    }
    const readU16String = (start, count) => {
      let s = "";
      for (let i = 0; i < count; i++) {
        const c = dv.getUint16(start + i * 2, true);
        if (c > 0 && c < 128) s += String.fromCharCode(c);
      }
      return s.trim();
    };
    const header = new _SeqHeader();
    header.magic = magic;
    header.name = readU16String(4, 10);
    header.version = dv.getInt32(28, true);
    header.headerSize = dv.getUint32(32, true);
    header.description = readU16String(36, 256);
    header.width = dv.getUint32(548, true);
    header.height = dv.getUint32(552, true);
    header.bitDepth = dv.getUint32(556, true);
    header.bitDepthReal = dv.getUint32(560, true);
    header.imageSizeBytes = dv.getUint32(564, true);
    header.imageFormat = dv.getUint32(568, true);
    header.numFrames = dv.getUint32(572, true);
    header.trueImageSize = dv.getUint32(580, true);
    header.fps = dv.getFloat64(584, true);
    header.codec = `imageFormat${String(header.imageFormat).padStart(3, "0")}`;
    return header;
  }
};
var JPEG_SOI = [255, 216];
var PNG_SIG = [137, 80];
var SeqIndex = class _SeqIndex {
  offsets;
  numFrames;
  /** Per-frame timestamp size in bytes (6 for version < 5, else 8). */
  timestampSize;
  constructor(offsets, numFrames, timestampSize) {
    this.offsets = offsets;
    this.numFrames = numFrames;
    this.timestampSize = timestampSize;
  }
  /** Byte offset for a frame. @throws If out of range. */
  frameOffset(frame) {
    if (frame < 0 || frame >= this.numFrames) {
      throw new Error(`Frame ${frame} out of range [0, ${this.numFrames})`);
    }
    return this.offsets[frame];
  }
  /** Build the index for uncompressed formats (constant frame stride). */
  static buildUncompressed(header) {
    const offsets = [];
    for (let i = 0; i < header.numFrames; i++) {
      offsets.push(HEADER_SIZE + i * header.trueImageSize);
    }
    return new _SeqIndex(offsets, header.numFrames, header.version >= 5 ? 8 : 6);
  }
  /**
   * Build the index for compressed formats by scanning the file.
   *
   * Compressed frames are variable-length, so the file is scanned sequentially:
   * each frame begins with a uint32 size; the next frame is located by probing
   * for the next `size + magic` past the timestamp, allowing small even padding.
   */
  static async buildCompressed(source, header) {
    const fileSize = await source.size();
    const nMax = header.numFrames > 0 ? header.numFrames : 1e7;
    const tsSize = header.version >= 5 ? 8 : 6;
    let extra = null;
    const readU32 = async (pos) => {
      const b = await source.read(pos, 4);
      if (b.length < 4) return null;
      return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    };
    const offsets = [HEADER_SIZE];
    for (let i = 1; i < nMax; i++) {
      const prev = offsets[i - 1];
      const frameSize = await readU32(prev);
      if (frameSize === null) break;
      if (frameSize === 0 || frameSize > fileSize) break;
      let nextOffset;
      if (extra !== null) {
        nextOffset = prev + frameSize + extra;
      } else {
        const searchStart = prev + frameSize + tsSize;
        let found = false;
        nextOffset = 0;
        for (let pad = 0; pad < 32; pad += 2) {
          const candidate = searchStart + pad;
          if (candidate + 6 > fileSize) break;
          const probe = await source.read(candidate, 6);
          if (probe.length < 6) break;
          const candSize = new DataView(
            probe.buffer,
            probe.byteOffset,
            6
          ).getUint32(0, true);
          const m0 = probe[4];
          const m1 = probe[5];
          const isMagic = m0 === JPEG_SOI[0] && m1 === JPEG_SOI[1] || m0 === PNG_SIG[0] && m1 === PNG_SIG[1];
          if (candSize > 0 && candSize < fileSize && isMagic) {
            extra = tsSize + pad;
            nextOffset = candidate;
            found = true;
            break;
          }
        }
        if (!found) break;
      }
      if (nextOffset >= fileSize) break;
      const check = await source.read(nextOffset, 6);
      if (check.length < 6) break;
      const checkSize = new DataView(
        check.buffer,
        check.byteOffset,
        6
      ).getUint32(0, true);
      if (checkSize === 0 || checkSize > fileSize) break;
      offsets.push(nextOffset);
    }
    return new _SeqIndex(offsets, offsets.length, tsSize);
  }
};
var hasGlobalImageData = typeof globalThis !== "undefined" && typeof globalThis.ImageData !== "undefined";
async function makeImageData(rgba, width, height) {
  if (hasGlobalImageData) {
    return new ImageData(rgba, width, height);
  }
  try {
    const sc = await import("skia-canvas");
    return new sc.ImageData(rgba, width, height);
  } catch {
    return {
      data: rgba,
      width,
      height,
      colorSpace: "srgb"
    };
  }
}
async function decodeEncoded2(bytes) {
  if (typeof createImageBitmap !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    const safe = new Uint8Array(bytes);
    const bitmap = await createImageBitmap(new Blob([safe.buffer]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context for .seq frame decode");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  }
  try {
    const sc = await import("skia-canvas");
    const src = typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
    const img = await sc.loadImage(src);
    const Canvas = sc.Canvas;
    const canvas = new Canvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } catch (err) {
    throw new Error(
      `Decoding JPEG/PNG frames in .seq files requires an image decoder (a browser, or the optional \`skia-canvas\` package on Node). Original error: ${err.message}`
    );
  }
}
var SeqVideoBackend = class _SeqVideoBackend {
  filename;
  dataset = null;
  shape;
  fps;
  source;
  headerData;
  index;
  constructor(filename, source, header, index, fps) {
    this.filename = filename;
    this.source = source;
    this.headerData = header;
    this.index = index;
    this.fps = fps;
    const channels = header.numChannels === 1 ? 1 : 3;
    this.shape = [index.numFrames, header.height, header.width, channels];
  }
  /** Open a `.seq` file from a path (Node) or a `File`/`Blob` (browser). */
  static async create(source) {
    const isBlob = typeof Blob !== "undefined" && source instanceof Blob;
    const filename = isBlob ? source.name ?? "" : source;
    const byteSource = isBlob ? new BlobByteSource(source) : createFileByteSource(source);
    try {
      const header = SeqHeader.fromBytes(await byteSource.read(0, HEADER_SIZE));
      if (BAYER_CODECS.has(header.codecName)) {
        throw new Error(
          `Bayer codec '${header.codecName}' is not supported in .seq files. Convert the file to a standard format first.`
        );
      }
      const index = header.isCompressed ? await SeqIndex.buildCompressed(byteSource, header) : SeqIndex.buildUncompressed(header);
      const fps = await computeFps(
        byteSource,
        header,
        index,
        (i, h) => readTimestamp(byteSource, h, index, i)
      );
      return new _SeqVideoBackend(filename, byteSource, header, index, fps);
    } catch (err) {
      byteSource.close();
      throw err;
    }
  }
  /** The parsed `.seq` header. */
  get header() {
    return this.headerData;
  }
  /** Number of frames in the video. */
  get numFrames() {
    return this.index.numFrames;
  }
  async getFrame(frameIndex) {
    let idx = frameIndex;
    if (idx < 0) idx = this.index.numFrames + idx;
    if (idx < 0 || idx >= this.index.numFrames) return null;
    const data = await readFrameData(
      this.source,
      this.headerData,
      this.index,
      idx
    );
    return decodeFrame(this.headerData, data);
  }
  /**
   * Absolute per-frame timestamps as seconds since the Unix epoch (Python
   * `get_timestamps` parity).
   */
  async getTimestamps() {
    const out = [];
    for (let i = 0; i < this.index.numFrames; i++) {
      out.push(
        await readTimestamp(this.source, this.headerData, this.index, i)
      );
    }
    return out;
  }
  /** Absolute timestamp (seconds since epoch) for a single frame. */
  async getTimestamp(frameIndex) {
    let idx = frameIndex;
    if (idx < 0) idx = this.index.numFrames + idx;
    if (idx < 0 || idx >= this.index.numFrames) {
      throw new Error(
        `Frame ${frameIndex} out of range [0, ${this.index.numFrames})`
      );
    }
    return readTimestamp(this.source, this.headerData, this.index, idx);
  }
  /**
   * Presentation times in seconds relative to the first frame (consistent with
   * the other backends' {@link VideoBackend.getFrameTimes}). For absolute
   * timestamps use {@link getTimestamps}.
   */
  async getFrameTimes() {
    const ts = await this.getTimestamps();
    if (ts.length === 0) return null;
    const t0 = ts[0];
    return ts.map((t) => t - t0);
  }
  close() {
    this.source.close();
  }
};
async function readCompressedFrameSize(source, offset) {
  const sizeBytes = await source.read(offset, 4);
  return new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 4).getUint32(
    0,
    true
  );
}
async function readFrameData(source, header, index, frameIdx) {
  const offset = index.frameOffset(frameIdx);
  if (header.isCompressed) {
    const nbytes = await readCompressedFrameSize(source, offset);
    return source.read(offset + 4, nbytes - 4);
  }
  return source.read(offset, header.imageSizeBytes);
}
async function readTimestamp(source, header, index, frameIdx) {
  const offset = index.frameOffset(frameIdx);
  const tsPos = header.isCompressed ? offset + await readCompressedFrameSize(source, offset) : offset + header.imageSizeBytes;
  const buf = await source.read(tsPos, index.timestampSize);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sec = dv.getUint32(0, true);
  const ms = dv.getUint16(4, true);
  let result = sec + ms / 1e3;
  if (index.timestampSize === 8) {
    const us = dv.getUint16(6, true);
    result += us / 1e6;
  }
  return result;
}
async function decodeFrame(header, data) {
  const codec = header.codecName;
  const h = header.height;
  const w = header.width;
  const nch = header.numChannels;
  if (codec === "monoraw" || codec === "raw") {
    const rgba = new Uint8ClampedArray(w * h * 4);
    if (nch === 1) {
      for (let i = 0; i < w * h; i++) {
        const gray = data[i] ?? 0;
        const o = i * 4;
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = 255;
      }
    } else {
      for (let i = 0; i < w * h; i++) {
        const base = i * nch;
        const o = i * 4;
        rgba[o] = data[base + 2] ?? 0;
        rgba[o + 1] = data[base + 1] ?? 0;
        rgba[o + 2] = data[base] ?? 0;
        rgba[o + 3] = 255;
      }
    }
    return makeImageData(rgba, w, h);
  }
  if (codec === "monojpg" || codec === "jpg" || codec === "monopng" || codec === "png") {
    return decodeEncoded2(data);
  }
  throw new Error(`Unsupported .seq codec: ${codec}`);
}
async function computeFps(source, header, index, read) {
  const fallback = header.fps >= 1 ? header.fps : void 0;
  try {
    const n = Math.min(100, index.numFrames);
    if (n < 2) return fallback;
    const ts = [];
    for (let i = 0; i < n; i++) ts.push(await read(i, header));
    const ds = [];
    for (let i = 1; i < ts.length; i++) ds.push(ts[i] - ts[i - 1]);
    const median = medianOf(ds);
    const filtered = ds.filter((d) => Math.abs(d - median) < 5e-3);
    if (filtered.length > 0) {
      const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
      const computed = 1 / mean;
      if (Number.isFinite(computed) && computed >= 1) {
        return computed;
      }
    }
  } catch {
  }
  return fallback;
}
function medianOf(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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

// Inlined subset of ../../io/remote.ts (the worker runs in an isolated context
// via importScripts and cannot import the module). Keep in lockstep with
// RETRYABLE_STATUSES / withRetries / identityHeaders there.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Force Accept-Encoding: identity (drop any user-supplied value, any case) so a
// gzip transfer-encoding cannot corrupt ranged reads. Applied to remote fetches
// here for parity with the main-thread ranged paths.
function identityHeadersWorker(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === 'accept-encoding') continue;
    out[k] = headers[k];
  }
  out['Accept-Encoding'] = 'identity';
  return out;
}

function parseRetryAfterMsWorker(value) {
  if (!value) return undefined;
  const secs = parseInt(value, 10);
  if (!isFinite(secs) || String(secs) !== String(value).trim()) return undefined;
  return Math.min(secs * 1000, 30000);
}

// fetch wrapped in retry/backoff: retries transient network errors and
// retryable statuses (429/5xx), honoring Retry-After. Returns the Response for
// any non-retryable status so the caller handles it. Mirrors fetchRetrying in
// ../../io/remote.ts. Errors are NOT redacted here because the worker only ever
// sees URLs the main thread already resolved; the main thread re-wraps worker
// failures, and no token-bearing URL reaches this transport in the streaming
// path (Drive/headers route through the buffer download, not createLazyFile).
async function fetchRetryingWorker(url, init, retries) {
  const max = retries == null ? 3 : retries;
  let attempt = 0;
  while (true) {
    let response;
    let networkError = false;
    try {
      response = await fetch(url, init);
    } catch (e) {
      networkError = true;
    }
    if (!networkError && !RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }
    if (attempt >= max) {
      if (networkError) throw new Error('Failed to fetch remote HDF5 file');
      return response;
    }
    let delayMs = Math.min(200 * Math.pow(2, attempt), 30000);
    if (!networkError) {
      const ra = parseRetryAfterMsWorker(
        response.headers && response.headers.get
          ? response.headers.get('Retry-After')
          : null,
      );
      if (ra != null) delayMs = Math.min(ra, 30000);
    }
    attempt += 1;
    await new Promise(function(r) { setTimeout(r, delayMs); });
  }
}
// Track how the current file was mounted so closeFile can clean up correctly:
// 'remote' = MEMFS dir + createLazyFile, 'local' = WORKERFS mount,
// 'buffer' = MEMFS dir + FS.writeFile. Required because FS.rmdir fails on
// non-empty dirs (errno 55) and on file paths (errno 54).
let mountType = null;
let currentFilename = null;

// B-seam range bridge: SharedArrayBuffer views the custom device uses to request
// bytes from the main thread synchronously (Atomics.wait). Set by openRangeFile.
// Control layout: Int32[0] = STATE (1=REQUEST pending, 2=READY), Int32[1] = RETLEN.
let rangeControl = null;
let rangeData = null;
let rangeMaxChunk = 0;

self.onmessage = async function(e) {
  const { type, payload, id } = e.data;

  try {
    switch (type) {
      case 'init':
        await initH5Wasm(payload?.h5wasmUrl);
        respond(id, { success: true });
        break;

      case 'openUrl':
        const urlResult = await openRemoteFile(payload.url, payload.filename, payload.headers);
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

      case 'openRange':
        const rangeResult = openRangeFile(payload.sab, payload.size, payload.filename, payload.controlBytes);
        respond(id, rangeResult);
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
  const url = h5wasmUrl || 'https://cdn.jsdelivr.net/npm/h5wasm@0.10.2/dist/iife/h5wasm.js';

  // Import h5wasm IIFE
  importScripts(url);

  // Wait for module to be ready
  await h5wasm.ready;
  h5wasmModule = h5wasm;
  // FS is exposed directly on h5wasm module after ready
  FS = h5wasm.FS;
}

async function openRemoteFile(url, filename = 'data.h5', headers) {
  if (!h5wasmModule) {
    throw new Error('h5wasm not initialized');
  }

  // Close any existing file
  closeFile();

  // createLazyFile (synchronous XHR) has NO header API. When custom headers are
  // present we cannot authenticate a range stream, so buffer-download the file
  // with the headers applied and mount it as a MEMFS buffer instead. Header-free
  // requests keep the efficient createLazyFile range streaming path.
  const hasHeaders = headers && typeof headers === 'object' && Object.keys(headers).length > 0;
  if (hasHeaders) {
    // Retried with backoff on transient failures / 429/5xx; identity encoding
    // forced so a gzip transfer-encoding can't corrupt the bytes.
    const response = await fetchRetryingWorker(url, { headers: identityHeadersWorker(headers) });
    if (!response.ok) {
      throw new Error('Failed to fetch remote HDF5 file: ' + response.status);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const basename = (filename.split('/').pop() || '').split('\\\\').pop() || 'data.h5';
    mountPath = '/remote-buffer-' + Date.now() + '/' + basename;
    mountType = 'buffer';
    currentFilename = basename;
    const dir = mountPath.substring(0, mountPath.lastIndexOf('/'));
    FS.mkdir(dir);
    FS.writeFile(mountPath, data);
    currentFile = new h5wasm.File(mountPath, 'r');
    return {
      success: true,
      path: currentFile.path,
      filename: currentFile.filename,
      keys: currentFile.keys()
    };
  }

  // Create mount point
  mountPath = '/remote-' + Date.now();
  mountType = 'remote';
  currentFilename = filename;
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
  mountType = 'local';
  currentFilename = fname;
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
  // Strip any directory components so MEMFS doesn't need recursive mkdir.
  const basename = (filename.split('/').pop() || '').split('\\\\').pop() || 'data.h5';
  mountPath = '/buffer-' + Date.now() + '/' + basename;
  mountType = 'buffer';
  currentFilename = basename;

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

// B-seam: request [offset, offset+want) from the main thread and BLOCK the worker
// until it writes the bytes back into the shared data area and wakes us. Returns a
// view over the shared data area (valid only until the next bridgeRead) \u2014 callers
// copy immediately. \`want\` is capped to the data area size; the device loops.
function bridgeRead(offset, length) {
  var want = length < rangeMaxChunk ? length : rangeMaxChunk;
  Atomics.store(rangeControl, 0, 1);                                  // STATE = REQUEST
  self.postMessage({ type: 'rangeRequest', offset: offset, length: want });
  Atomics.wait(rangeControl, 0, 1);                                  // block until STATE != REQUEST
  var got = Atomics.load(rangeControl, 1);                           // RETLEN (acquire)
  return rangeData.subarray(0, got);
}

// Create a read-only Emscripten file node whose synchronous reads pull bytes via
// the bridge instead of XHR (mirrors FS.createLazyFile's node setup: forceLoadFile
// no-ops once \`contents\` is set, and usedBytes/fstat reads contents.length).
function createRangeFile(parent, name, size) {
  var contents = { length: size };
  var node = FS.createFile(parent, name, { isDevice: false, contents: contents }, true, false);
  node.contents = contents;
  Object.defineProperties(node, { usedBytes: { get: function() { return size; } } });
  var stream_ops = {};
  var origOps = node.stream_ops;
  for (var key in origOps) {
    (function(k, fn) {
      stream_ops[k] = function() { FS.forceLoadFile(node); return fn.apply(null, arguments); };
    })(key, origOps[key]);
  }
  stream_ops.read = function(stream, buffer, offset, length, position) {
    if (position >= size) return 0;
    var end = position + length;
    if (end > size) end = size;
    var got = 0;
    var pos = position;
    while (pos < end) {
      var chunk = bridgeRead(pos, end - pos);
      if (chunk.length === 0) break;                                  // short read / EOF
      buffer.set(chunk, offset + got);
      got += chunk.length;
      pos += chunk.length;
    }
    return got;
  };
  node.stream_ops = stream_ops;
  return node;
}

function openRangeFile(sab, size, filename, controlBytes) {
  if (!h5wasmModule) {
    throw new Error('h5wasm not initialized');
  }
  closeFile();
  rangeControl = new Int32Array(sab, 0, 8);
  rangeData = new Uint8Array(sab, controlBytes || 32);
  rangeMaxChunk = rangeData.length;
  // Strip directory components: filenameHint is often a full path (e.g. a native
  // .slp path with slashes), and MEMFS would treat it as nested dirs that don't
  // exist -> ENOENT. Mirror openBufferFile's basename handling.
  var fname = (((filename || 'data.h5').split('/').pop() || '').split('\\\\').pop()) || 'data.h5';
  mountPath = '/range-' + Date.now();
  mountType = 'range';
  currentFilename = fname;
  FS.mkdir(mountPath);
  createRangeFile(mountPath, fname, size);
  const filePath = mountPath + '/' + fname;
  currentFile = new h5wasm.File(filePath, 'r');
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

// Read a fixed-size 1-D compound dataset column-wise straight from the record
// blob, skipping h5wasm's Dataset.value (which allocates ~8 Uint8Array.slice per
// record \u2014 the dominant cost of opening a large project). Mirrors
// readCompoundColumnsManual in ./h5-compound.ts (keep them in lockstep). Returns
// { columns: { memberName: Float64Array }, buffers: ArrayBuffer[] } \u2014 the buffers
// are the postMessage transfer list so the columns move to the main thread
// instead of being structured-cloned. Returns null (caller falls back to .value)
// for anything not a plain-numeric compound. Values match .value except int64
// comes back as number (every consumer routes these through Number()).
function readCompoundColumnsWorker(dataset, M) {
  const md = dataset.metadata;
  const members = md && md.compound_type && md.compound_type.members;
  if (!members || !members.length || (md && md.vlen)) return null;
  const shape = dataset.shape;
  if (!shape || shape.length !== 1) return null;
  const recSize = md.size;
  if (!recSize || recSize <= 0) return null;
  for (let k = 0; k < members.length; k++) {
    const mt = members[k];
    if (mt.type !== 0 && mt.type !== 1 && mt.type !== 8) return null;
    if (mt.type === 1 && mt.size !== 8 && mt.size !== 4) return null;
    if (mt.size !== 1 && mt.size !== 2 && mt.size !== 4 && mt.size !== 8) return null;
  }
  if (!(M && M._malloc && M.get_dataset_data && M.HEAPU8 && M._free)) return null;
  const n = shape[0];
  // Columns are Float64Array (every SLEAP field \u2014 coords, scores, and integer
  // id/index columns up to 2^53 \u2014 is exact in f64) so their backing buffers can
  // be TRANSFERRED to the main thread instead of structured-cloned. \`buffers\`
  // is the postMessage transfer list.
  const columns = {};
  const buffers = [];
  if (n === 0) {
    for (let z = 0; z < members.length; z++) {
      const c = new Float64Array(0);
      columns[members[z].name] = c;
      buffers.push(c.buffer);
    }
    return { columns: columns, buffers: buffers };
  }
  const nbytes = recSize * n;
  const dptr = M._malloc(nbytes);
  if (!dptr) return null;
  let buf;
  try {
    M.get_dataset_data(dataset.file_id, dataset.path, [BigInt(n)], [0n], [1n], BigInt(dptr));
    buf = M.HEAPU8.slice(dptr, dptr + nbytes);
  } finally {
    M._free(dptr);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let j = 0; j < members.length; j++) {
    const m = members[j];
    const col = new Float64Array(n);
    const off = m.offset, sz = m.size, isFloat = (m.type === 1);
    const signed = (m.signed !== false), le = (m.littleEndian !== false);
    for (let i = 0; i < n; i++) {
      const p = i * recSize + off;
      let v;
      if (isFloat) v = sz === 8 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
      else if (sz === 1) v = signed ? dv.getInt8(p) : dv.getUint8(p);
      else if (sz === 2) v = signed ? dv.getInt16(p, le) : dv.getUint16(p, le);
      else if (sz === 4) v = signed ? dv.getInt32(p, le) : dv.getUint32(p, le);
      else v = Number(signed ? dv.getBigInt64(p, le) : dv.getBigUint64(p, le));
      col[i] = v;
    }
    columns[m.name] = col;
    buffers.push(col.buffer);
  }
  return { columns: columns, buffers: buffers };
}

function getDatasetValue(path, slice) {
  if (!currentFile) throw new Error('No file open');
  const dataset = currentFile.get(path);
  if (!dataset) throw new Error('Dataset not found: ' + path);

  // Variable-length (vlen) datasets: h5wasm's high-level dataset.slice() corrupts
  // the heap here \u2014 its post-read reclaim walks the FULL dataset dataspace over a
  // single-element buffer (intermittent "memory access out of bounds" / abort).
  // So NEVER call dataset.slice() on a vlen dataset. For a single-element slice we
  // read the one hvl_t manually and free only that element (mirrors
  // readVlenElementManual in ../../video/embedded-frame.ts \u2014 keep them in lockstep).
  const M = h5wasmModule && h5wasmModule.Module;
  const md = dataset.metadata;
  const vlenClass = (M && M.H5T_class_t && M.H5T_class_t.H5T_VLEN) ? M.H5T_class_t.H5T_VLEN.value : 9;
  const isVlen = !!(md && (md.vlen === true || md.type === vlenClass));
  if (isVlen) {
    const single = slice && Array.isArray(slice) && slice.length === 1 &&
      Array.isArray(slice[0]) && slice[0].length === 2;
    if (single && md.size === 8 && M && M._malloc && M.get_dataset_data && M.HEAPU8) {
      const index = slice[0][0];
      const dataPtr = M._malloc(md.size);
      let out;
      try {
        M.get_dataset_data(dataset.file_id, dataset.path, [1n], [BigInt(index)], [1n], BigInt(dataPtr));
        // HEAPU32 isn't exported; build the view over HEAPU8.buffer each call
        // (heap growth can detach the previous ArrayBuffer).
        const u32 = new Uint32Array(M.HEAPU8.buffer, Number(dataPtr), 2);
        const len = u32[0];
        const blobPtr = u32[1];
        out = blobPtr ? M.HEAPU8.slice(blobPtr, blobPtr + len) : new Uint8Array(0);
        if (blobPtr) M._free(blobPtr); // free ONLY the inner blob
      } finally {
        M._free(dataPtr);
      }
      return {
        value: { type: 'typedarray', dtype: 'Uint8Array', buffer: out.buffer, byteOffset: out.byteOffset, length: out.length },
        shape: dataset.shape,
        dtype: dataset.dtype,
        transferables: [out.buffer]
      };
    }
    // Can't do the manual single-element read (whole read, or unexpected hvl_t
    // size). Read the whole vlen dataset (safe) and return the array of blobs;
    // the caller indexes into it. structuredClone copies it (no transfer).
    return {
      value: dataset.value,
      shape: dataset.shape,
      dtype: dataset.dtype,
      transferables: []
    };
  }

  // Fixed-size compound full read (frames/instances/points/pred_points): return
  // per-member columns read directly from the record blob, skipping h5wasm's slow
  // Dataset.value. normalizeStructData accepts a { field: array } record as-is, so
  // no caller change is needed; falls through to .value when not applicable.
  if (!slice) {
    const res = readCompoundColumnsWorker(dataset, M);
    if (res) {
      return {
        value: { type: 'columns', columns: res.columns },
        shape: dataset.shape,
        dtype: dataset.dtype,
        transferables: res.buffers
      };
    }
  }

  // Non-vlen: hyperslab slice or whole read as requested.
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
    // Cleanup sequence depends on how the file was mounted. FS.rmdir requires
    // an empty dir; FS.rmdir on a file path fails with errno 54. Without the
    // right sequence per mount type, repeated open/close cycles leak MEMFS
    // entries (and for 'buffer' mounts, the entire file bytes) for the lifetime
    // of the worker.
    const warn = function(op, path, e) {
      try {
        var msg = '[h5-worker] cleanup ' + op + '(' + path + ') failed: ' + (e && (e.message || e.errno || e));
        if (typeof console !== 'undefined' && console.warn) console.warn(msg);
      } catch (_) {}
    };
    if (mountType === 'buffer') {
      // mountPath is the file; parent dir was created by FS.mkdir.
      var parent = mountPath.substring(0, mountPath.lastIndexOf('/'));
      try { FS.unlink(mountPath); } catch (e) { warn('unlink', mountPath, e); }
      try { FS.rmdir(parent); } catch (e) { warn('rmdir', parent, e); }
    } else if (mountType === 'remote' || mountType === 'range') {
      // mountPath is the dir containing the lazy / range-backed file.
      var lazyPath = mountPath + '/' + currentFilename;
      try { FS.unlink(lazyPath); } catch (e) { warn('unlink', lazyPath, e); }
      try { FS.rmdir(mountPath); } catch (e) { warn('rmdir', mountPath, e); }
    } else if (mountType === 'local') {
      // WORKERFS mount must be unmounted before rmdir.
      try { FS.unmount(mountPath); } catch (e) { warn('unmount', mountPath, e); }
      try { FS.rmdir(mountPath); } catch (e) { warn('rmdir', mountPath, e); }
    } else {
      // Unknown mount type \u2014 best effort rmdir (preserves pre-existing behavior).
      try { FS.rmdir(mountPath); } catch (e) { warn('rmdir', mountPath, e); }
    }
    mountPath = null;
    mountType = null;
    currentFilename = null;
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
function isRangeSource(source) {
  return typeof source === "object" && source !== null && typeof source.size === "number" && typeof source.readRange === "function";
}
async function serviceRangeBridge(control, dataArea, reader, offset, length) {
  try {
    const bytes = await reader(offset, length);
    const n = Math.min(bytes.length, dataArea.length, length);
    dataArea.set(bytes.subarray(0, n), 0);
    Atomics.store(control, 1, n);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
  } catch (err) {
    Atomics.store(control, 1, 0);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
    console.error("[StreamingH5File] readRange failed:", err);
  }
}
function reconstructValue(data) {
  if (data && typeof data === "object" && "type" in data) {
    const typed = data;
    if (typed.type === "columns" && typed.columns) {
      return typed.columns;
    }
    if (typed.type === "typedarray" && typed.buffer) {
      const TypedArrayConstructor = getTypedArrayConstructor(
        typed.dtype || "Uint8Array"
      );
      return new TypedArrayConstructor(
        typed.buffer,
        typed.byteOffset || 0,
        typed.length
      );
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
  // B-seam range bridge (set by openRange): the app-provided reader plus the
  // SharedArrayBuffer views the Worker blocks on. See serviceRangeRequest.
  rangeReader;
  rangeControl;
  rangeData;
  constructor() {
    this.worker = createH5Worker();
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);
  }
  handleMessage(e) {
    const msg = e.data;
    if (msg && msg.type === "rangeRequest") {
      this.serviceRangeRequest(msg.offset ?? 0, msg.length ?? 0);
      return;
    }
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
   * The scheme is resolved on the MAIN thread (the worker cannot import the
   * scheme gate): `gs://`/`gcs://` are mapped to `storage.googleapis.com`, and
   * `s3://`/`az://`/`abfs://` fail fast with a redacted {@link RemoteIOError}.
   * Google Drive is NOT supported on the streaming worker path (Drive requires a
   * buffered, interstitial-following download, not range streaming); a Drive URL
   * throws a redacted {@link RemoteIOError} directing the caller to the
   * non-streaming reader. The worker only ever fetches an already-resolved
   * http(s) URL.
   *
   * @param url - URL to the HDF5 file (must support HTTP range requests)
   * @param options - Optional settings
   */
  async open(url, options) {
    await this.init(options);
    let resolvedUrl = url;
    if (isUrl(url)) {
      const { url: resolved, gdrive } = resolveUrl(url);
      if (gdrive) {
        throw new RemoteIOError({
          message: 'Google Drive URLs are not supported on the streaming worker path (Drive needs a buffered download); use the non-streaming reader (stream:"download" / loadSlp)',
          url,
          status: null
        });
      }
      resolvedUrl = resolved;
    }
    const filename = options?.filenameHint || resolvedUrl.split("/").pop()?.split("?")[0] || "data.h5";
    const result = await this.send("openUrl", {
      url: resolvedUrl,
      filename,
      headers: options?.headers
    });
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
   * Open an HDF5 file from a lazy {@link RangeSource} via the B-seam bridge.
   *
   * The Worker registers a custom Emscripten device whose synchronous `read`
   * blocks on `Atomics.wait` over a SharedArrayBuffer; this main thread services
   * each request by calling `readRange` and waking the Worker. Requires
   * cross-origin isolation (SharedArrayBuffer / COOP+COEP).
   */
  async openRange(source, options) {
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "RangeSource streaming requires SharedArrayBuffer (enable cross-origin isolation: COOP 'same-origin' + COEP 'require-corp')"
      );
    }
    await this.init(options);
    this.rangeReader = source.readRange;
    const CONTROL_BYTES = 32;
    const MAX_CHUNK = 4 * 1024 * 1024;
    const sab = new SharedArrayBuffer(CONTROL_BYTES + MAX_CHUNK);
    this.rangeControl = new Int32Array(sab, 0, 8);
    this.rangeData = new Uint8Array(sab, CONTROL_BYTES);
    const filename = options?.filenameHint || "data.h5";
    const result = await this.send("openRange", {
      sab,
      size: source.size,
      filename,
      controlBytes: CONTROL_BYTES
    });
    this._keys = result.keys || [];
    this._isOpen = true;
  }
  /**
   * Service a Worker byte-request: read via the app's `readRange`, copy the
   * bytes into the shared data area, then wake the (blocked) Worker. STATE is
   * stored last (release) so the Worker's `Atomics.wait` return (acquire) sees
   * the data + returned length.
   */
  serviceRangeRequest(offset, length) {
    const control = this.rangeControl;
    const dataArea = this.rangeData;
    const reader = this.rangeReader;
    if (!control || !dataArea || !reader) return;
    void serviceRangeBridge(control, dataArea, reader, offset, length);
  }
  /**
   * Open an HDF5 file from any supported source.
   *
   * @param source - URL string, File, ArrayBuffer, Uint8Array, or RangeSource
   * @param options - Optional settings
   */
  async openAny(source, options) {
    if (isRangeSource(source)) {
      return this.openRange(source, options);
    }
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

// src/codecs/slp/h5.ts
var _nodeGetModule = null;
var _nodeOpenFile = null;
function _registerNodeH5(getModule, openFile) {
  _nodeGetModule = getModule;
  _nodeOpenFile = openFile;
}
var _nodeWriteFile = null;
var _nodeFileExists = null;
var _nodeReadPackageVersion = null;
function _registerNodeFileOps(ops) {
  _nodeWriteFile = ops.writeFile;
  _nodeFileExists = ops.fileExists;
  _nodeReadPackageVersion = ops.readPackageVersion;
}
async function nodeWriteFile(path, bytes) {
  if (!_nodeWriteFile) {
    throw new Error(
      "Writing files requires a Node.js environment. This codec's writer is Node-only."
    );
  }
  await _nodeWriteFile(path, bytes);
}
async function nodeFileExists(path) {
  return _nodeFileExists ? _nodeFileExists(path) : null;
}
async function nodeReadPackageVersion() {
  return _nodeReadPackageVersion ? _nodeReadPackageVersion() : null;
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
async function getH5EmscriptenModule() {
  const ns = await getH5Module();
  return ns.Module ?? null;
}
async function openH5File(source, options) {
  const module = await getH5Module();
  if (_nodeOpenFile) {
    return _nodeOpenFile(module, source, options);
  }
  return openH5FileBrowser(module, source, options);
}
function isFileHandle(value) {
  return typeof value === "object" && value !== null && "getFile" in value;
}
async function openH5FileBrowser(module, source, options) {
  const fs = getH5FileSystem(module);
  if (typeof source === "string" && isUrl(source)) {
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
  const hasHeaders = !!(options?.headers && Object.keys(options.headers).length > 0);
  const { url: resolved, gdrive } = resolveUrl(url);
  if (gdrive) {
    const bytes = await openGdrive(url, { headers: options?.headers });
    const localPath2 = "/tmp-slp.slp";
    fs.writeFile(localPath2, bytes);
    const file2 = new module.File(localPath2, "r");
    return { file: file2, close: () => file2.close() };
  }
  if (!hasHeaders && fs.createLazyFile && (streamMode === "auto" || streamMode === "range")) {
    const mountPath = `/slp-remote-${Date.now()}`;
    fs.mkdir?.(mountPath);
    try {
      fs.createLazyFile(mountPath, filename, resolved, true, false);
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
  const init = { headers: options?.headers ?? {} };
  const response = await fetchRetrying(resolved, init);
  if (!response.ok) {
    throw new RemoteIOError({
      message: statusToMessage(response.status),
      url: resolved,
      status: response.status
    });
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
async function fetchRemoteSlpBytes(url, options) {
  const { url: resolved, gdrive } = resolveUrl(url);
  if (gdrive) {
    return openGdrive(url, { headers: options?.headers });
  }
  const init = { headers: options?.headers ?? {} };
  const response = await fetchRetrying(resolved, init);
  if (!response.ok) {
    throw new RemoteIOError({
      message: statusToMessage(response.status),
      url: resolved,
      status: response.status
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}
function getH5FileSystem(module) {
  const fs = module.FS;
  if (!fs) {
    throw new Error("h5wasm FS is not available.");
  }
  return fs;
}
function ensureH5StagingDir(module) {
  try {
    getH5FileSystem(module).mkdir?.("/tmp");
  } catch {
  }
}

// src/video/hdf5-video.ts
var isBrowser4 = typeof window !== "undefined" && typeof document !== "undefined";
var Hdf5VideoBackend = class {
  filename;
  dataset;
  shape;
  fps;
  /** Source frame numbers with a stored image (storage order). */
  frameNumbers;
  file;
  datasetPath;
  frameNumberToIndex;
  format;
  channelOrder;
  frameSizes;
  legacy;
  constructor(options) {
    this.filename = options.filename;
    this.file = options.file;
    this.datasetPath = options.datasetPath;
    this.dataset = options.datasetPath;
    const frameNumbers = options.frameNumbers ?? [];
    this.frameNumbers = frameNumbers;
    this.frameNumberToIndex = new Map(
      frameNumbers.map((num, idx) => [num, idx])
    );
    this.format = options.format ?? "png";
    this.channelOrder = options.channelOrder ?? "RGB";
    this.shape = options.shape;
    this.fps = options.fps;
    this.frameSizes = options.frameSizes;
    this.legacy = { whole: null, offsets: null };
  }
  async getFrame(frameIndex) {
    const dataset = this.file.get(this.datasetPath);
    if (!dataset) return null;
    const index = this.frameNumberToIndex.size > 0 ? this.frameNumberToIndex.get(frameIndex) : frameIndex;
    if (index === void 0) return null;
    const rawBytes = await readEmbeddedFrameBytes(
      this.buildReader(dataset),
      index
    );
    if (!rawBytes || rawBytes.length === 0) return null;
    if (isEncodedFormat(this.format)) {
      const decoded = await decodeImageBytes2(
        rawBytes,
        this.format,
        this.channelOrder
      );
      return decoded ?? rawBytes;
    }
    const image = decodeRawFrame2(rawBytes, this.shape, this.channelOrder);
    return image ?? rawBytes;
  }
  /**
   * Crop pushdown hook (Item 1 of JS issue #153). Always returns `null`: this
   * embedded backend stores opaque encoded blobs (PNG/JPEG) or per-frame-indexed
   * raw rows, neither of which can be spatially hyperslabbed without first
   * decoding the whole frame. Pushdown is structurally impossible here, so the
   * crop wrapper falls back to full-decode + `cropFrame`. (A raw rank-4 chunked
   * HDF5 pixel-array backend, which COULD push down, does not exist in the JS
   * port yet; see backend.ts `readCrop` doc.) Short-circuits before touching the
   * dataset.
   */
  async readCrop() {
    return null;
  }
  /** Build a single-frame reader bound to an open h5wasm dataset object. */
  buildReader(dataset) {
    return {
      frameCount: this.frameNumberToIndex.size,
      format: this.format,
      frameSizes: this.frameSizes,
      legacy: this.legacy,
      getMeta: async () => ({
        shape: dataset.shape ?? [],
        dtype: dataset.dtype
      }),
      readSlice: async (slice) => {
        const value = slice ? dataset.slice(slice) : dataset.value;
        return { value, shape: dataset.shape ?? [] };
      },
      readVlenElement: async (index) => {
        const Module = await getH5EmscriptenModule();
        return readVlenElementManual(Module, dataset, index);
      }
    };
  }
  close() {
    this.legacy.whole = null;
    this.legacy.offsets = null;
  }
};
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

// src/video/factory.ts
var MEDIABUNNY_EXTENSIONS = ["webm", "mkv", "ogg", "mov", "ts"];
var UNSUPPORTED_EXTENSIONS = ["avi", "mpeg", "mpg"];
var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "tif", "tiff", "bmp"];
function isImageSource(source) {
  if (Array.isArray(source)) return true;
  const ext = source.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}
var UnsupportedVideoFormatError = class extends Error {
  /** The offending file extension (without the leading dot), e.g. `"avi"`. */
  extension;
  constructor(extension) {
    super(
      `Unsupported video format ".${extension}". AVI and MPEG program streams cannot be decoded in the browser or desktop app. Transcode to MP4 (H.264) first, e.g. \`ffmpeg -i input.${extension} -c:v libx264 output.mp4\`.`
    );
    this.name = "UnsupportedVideoFormatError";
    this.extension = extension;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
async function createVideoBackend(source, options) {
  if (Array.isArray(source)) {
    return ImageVideoBackend.create({
      filename: source,
      shape: options?.shape
    });
  }
  const isBlob = typeof Blob !== "undefined" && source instanceof Blob;
  const filename = isBlob ? source.name ?? "" : source;
  const normalized = filename.split("?")[0]?.toLowerCase() ?? "";
  const ext = normalized.split(".").pop() ?? "";
  const headers = options?.headers;
  if (options?.embedded || ext === "slp" || ext === "h5" || ext === "hdf5") {
    const { file } = await openH5File(isBlob ? source : filename, {
      headers
    });
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
  if (ext === "seq") {
    return SeqVideoBackend.create(source);
  }
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return ImageVideoBackend.create({
      filename: [filename],
      shape: options?.shape
    });
  }
  const videoUrl = !isBlob && typeof filename === "string" && isUrl(filename) ? resolveVideoUrl(filename) : filename;
  if (options?.backend === "mediabunny") {
    if (isBlob)
      return MediaBunnyVideoBackend.fromBlob(source, filename);
    return MediaBunnyVideoBackend.fromUrl(videoUrl, { headers });
  }
  if (options?.backend === "mp4box") {
    if (isBlob) return new Mp4BoxVideoBackend(source);
    return new Mp4BoxVideoBackend(videoUrl, { headers });
  }
  if (options?.backend === "media") {
    if (isBlob)
      return new MediaVideoBackend(URL.createObjectURL(source));
    return new MediaVideoBackend(videoUrl);
  }
  if (UNSUPPORTED_EXTENSIONS.includes(ext)) {
    throw new UnsupportedVideoFormatError(ext);
  }
  const supportsWebCodecs = typeof window !== "undefined" && typeof window.VideoDecoder !== "undefined" && typeof window.EncodedVideoChunk !== "undefined";
  if (supportsWebCodecs && ext === "mp4") {
    if (isBlob) return new Mp4BoxVideoBackend(source);
    return new Mp4BoxVideoBackend(videoUrl, { headers });
  }
  if (supportsWebCodecs && MEDIABUNNY_EXTENSIONS.includes(ext)) {
    if (isBlob)
      return MediaBunnyVideoBackend.fromBlob(source, filename);
    return MediaBunnyVideoBackend.fromUrl(videoUrl, { headers });
  }
  if (isBlob) return new MediaVideoBackend(URL.createObjectURL(source));
  return new MediaVideoBackend(videoUrl);
}
function resolveVideoUrl(url) {
  const { url: resolved, gdrive } = resolveUrl(url);
  if (gdrive) {
    throw new RemoteIOError({
      message: `Google Drive videos are not supported: ${redactUrl(url)}`,
      url,
      status: null
    });
  }
  return resolved;
}

// src/codecs/slp/frame-count.ts
function resolveSourceFrameCount(opts) {
  const { framesAttr, jsonFrameCount, frameNumbers } = opts;
  let declared = 0;
  if (framesAttr !== void 0 && framesAttr > 0) declared = framesAttr;
  else if (jsonFrameCount !== void 0 && jsonFrameCount > 0)
    declared = jsonFrameCount;
  let fromFrameNumbers = 0;
  if (frameNumbers && frameNumbers.length > 0) {
    let max = 0;
    for (const n of frameNumbers) {
      if (n > max) max = n;
    }
    fromFrameNumbers = max + 1;
  }
  const count = Math.max(declared, fromFrameNumbers);
  return count > 0 ? count : void 0;
}

// src/codecs/slp/read-streaming.ts
async function readSlpStreaming(source, options) {
  if (!isStreamingSupported()) {
    throw new Error(
      "Streaming HDF5 requires Web Worker support (browser environment)"
    );
  }
  const file = await openH5Worker(source, {
    h5wasmUrl: options?.h5wasmUrl,
    filenameHint: options?.filenameHint,
    headers: options?.headers
  });
  const openVideos = options?.openVideos ?? false;
  const sourcePath = typeof source === "string" ? source : typeof File !== "undefined" && source instanceof File ? source.name : options?.filenameHint ?? "slp-data.slp";
  try {
    return await readFromStreamingFile(
      file,
      sourcePath,
      options?.filenameHint,
      openVideos,
      options?.onProgress,
      options?.rawSessions ?? false
    );
  } finally {
    if (!openVideos) {
      await file.close();
    }
  }
}
async function readFromStreamingFile(file, url, filenameHint, openVideos = false, onProgress, rawSessions = false) {
  const STAGES = [
    "Reading metadata",
    // 0
    "Reading tracks",
    // 1
    "Reading video metadata",
    // 2 (also holds the bar for "Opening videos (i/n)")
    "Reading suggestions",
    // 3
    "Reading frames",
    // 4
    "Reading instances",
    // 5
    "Reading points",
    // 6
    "Building labeled frames",
    // 7
    "Reading identities",
    // 8
    "Reading sessions"
    // 9
  ];
  const total = STAGES.length;
  const report = (n, message) => onProgress?.(n, total, message ?? STAGES[n]);
  report(0);
  const labelsPath = filenameHint ?? url.split("/").pop()?.split("?")[0] ?? "slp-data.slp";
  let metadataAttrs;
  try {
    metadataAttrs = await file.getAttrs("metadata");
  } catch {
    throw missingMetadataJsonError(labelsPath);
  }
  const formatId = Number(
    metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1
  );
  const metadataJson = parseMetadataJson(
    metadataAttrs["json"],
    labelsPath
  );
  const skeletons = parseSkeletons(metadataJson);
  report(1);
  const tracks = await readTracksStreaming(file);
  report(2);
  const videoCrops = await readVideoCropsStreaming(file);
  const videos = await readVideosStreaming(
    file,
    labelsPath,
    openVideos,
    formatId,
    videoCrops,
    openVideos ? (i, n) => report(2, `Opening videos (${i}/${n})`) : void 0
  );
  report(3);
  const suggestions = await readSuggestionsStreaming(file, videos);
  report(4);
  const framesData = await readStructDatasetStreaming(file, "frames");
  report(5);
  const instancesData = await readStructDatasetStreaming(file, "instances");
  report(6);
  const pointsData = await readStructDatasetStreaming(file, "points");
  const predPointsData = await readStructDatasetStreaming(file, "pred_points");
  report(7);
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
  report(8);
  const identities = await readIdentitiesStreaming(file);
  report(9);
  const sessions = await readSessionsStreaming(
    file,
    videos,
    skeletons,
    identities,
    rawSessions
  );
  onProgress?.(total, total, "Finalizing");
  const labels = new Labels({
    labeledFrames,
    videos,
    skeletons,
    tracks,
    suggestions,
    sessions,
    identities,
    provenance: metadataJson?.provenance ?? {}
  });
  injectSessionFrameResolver(labels);
  return labels;
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
async function readVideoCropsStreaming(file) {
  const out = /* @__PURE__ */ new Map();
  try {
    const keys = file.keys();
    if (!keys.includes("video_crops")) return out;
    const data = await file.getDatasetValue("video_crops");
    let raw = data.value;
    if (Array.isArray(raw)) raw = raw[0];
    let json;
    if (typeof raw === "string") {
      json = raw;
    } else if (raw instanceof Uint8Array) {
      json = new TextDecoder().decode(raw);
    } else if (raw != null) {
      json = String(raw);
    } else {
      return out;
    }
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const videoIdx = Number(entry.video);
      const cropArr = entry.crop;
      if (!Array.isArray(cropArr) || cropArr.length !== 4) continue;
      const crop = [
        Number(cropArr[0]),
        Number(cropArr[1]),
        Number(cropArr[2]),
        Number(cropArr[3])
      ];
      const fillRaw = entry.fill;
      const fill = Array.isArray(fillRaw) ? fillRaw.map((v) => Number(v)) : Number(fillRaw ?? 0);
      out.set(videoIdx, { crop, fill });
    }
    return out;
  } catch {
    return out;
  }
}
async function readVideosStreaming(file, labelsPath, openVideos = false, formatId = 1, videoCrops, onVideoProgress) {
  try {
    const keys = file.keys();
    if (!keys.includes("videos_json")) return [];
    const data = await file.getDatasetValue("videos_json");
    const values = normalizeDatasetArray(data.value);
    const metadataList = parseVideosMetadata(values, labelsPath);
    const videos = [];
    for (let videoIndex = 0; videoIndex < metadataList.length; videoIndex++) {
      onVideoProgress?.(videoIndex + 1, metadataList.length);
      const meta = metadataList[videoIndex];
      let datasetPath = meta.dataset;
      if (meta.embedded && !datasetPath) {
        datasetPath = await findVideoDatasetStreaming(file, videoIndex) ?? void 0;
      }
      let format = meta.format;
      let channelOrderFromAttrs;
      let frameCountFromAttrs;
      if (datasetPath) {
        try {
          const attrs = await file.getAttrs(datasetPath);
          if (!format) {
            format = attrToString(attrs.format);
          }
          channelOrderFromAttrs = attrToString(attrs.channel_order);
          const framesNum = attrToNumber(attrs.frames);
          if (framesNum !== void 0 && framesNum > 0) {
            frameCountFromAttrs = framesNum;
          }
          const readNumAttr = (attr) => {
            if (attr === void 0 || attr === null) return void 0;
            const v = typeof attr === "object" && attr !== null && "value" in attr ? attr.value : attr;
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : void 0;
          };
          if (!meta.height) meta.height = readNumAttr(attrs.height);
          if (!meta.width) meta.width = readNumAttr(attrs.width);
          if (!meta.channels) meta.channels = readNumAttr(attrs.channels);
        } catch {
        }
      }
      let frameNumbers = [];
      let frameSizes;
      if (openVideos && meta.embedded && datasetPath) {
        frameNumbers = await readFrameNumbersStreaming(file, datasetPath);
        frameSizes = await readFrameSizesStreaming(file, datasetPath);
      }
      const frameCount = resolveSourceFrameCount({
        framesAttr: frameCountFromAttrs,
        jsonFrameCount: meta.frameCount,
        frameNumbers
      });
      const shape = meta.height && meta.width && meta.channels ? [frameCount ?? 0, meta.height, meta.width, meta.channels] : void 0;
      const channelOrder = meta.channelOrder ?? channelOrderFromAttrs ?? (formatId < 1.4 ? "BGR" : "RGB");
      let backend = null;
      if (openVideos && meta.embedded && datasetPath) {
        backend = new StreamingHdf5VideoBackend({
          // Embedded videos always carry a single string filename (the labels
          // path); the array form is only for image sequences, which never
          // reach this embedded branch. Narrow for the type checker.
          filename: Array.isArray(meta.filename) ? meta.filename[0] ?? "" : meta.filename,
          h5file: file,
          datasetPath,
          frameNumbers,
          frameSizes,
          format: format ?? "png",
          channelOrder,
          shape,
          fps: meta.fps
        });
        if (!shape || shape[0] === 0) {
          await backend.probeShape(frameCount ?? void 0);
        }
      }
      let videoBackend = backend;
      const backendMetadata = {
        dataset: datasetPath,
        format,
        shape,
        fps: meta.fps,
        channel_order: channelOrder
      };
      const cropEntry = videoCrops?.get(videoIndex);
      if (cropEntry) {
        const [cx1, cy1, cx2, cy2] = cropEntry.crop;
        if (openVideos && videoBackend) {
          videoBackend = CropVideoBackend.wrap({
            inner: videoBackend,
            crop: cropEntry.crop,
            fill: cropEntry.fill
            // ownsInner: true (default) — see comment above.
          });
        }
        if (shape && shape.length === 4) {
          backendMetadata.source_shape = [...shape];
          backendMetadata.shape = [shape[0], cy2 - cy1, cx2 - cx1, shape[3]];
        }
        backendMetadata.crop = [...cropEntry.crop];
        backendMetadata.crop_fill = cropEntry.fill;
      }
      videos.push(
        new Video({
          filename: meta.filename,
          backend: videoBackend,
          backendMetadata,
          sourceVideo: meta.sourceVideo ? new Video({ filename: meta.sourceVideo.filename }) : null,
          openBackend: openVideos && meta.embedded,
          embedded: meta.embedded
        })
      );
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
async function readFrameSizesStreaming(file, datasetPath) {
  try {
    const groupPath = datasetPath.endsWith("/video") ? datasetPath.slice(0, -6) : datasetPath;
    const groupKeys = await file.getKeys(groupPath);
    if (!groupKeys.includes("frame_sizes")) {
      return void 0;
    }
    const data = await file.getDatasetValue(`${groupPath}/frame_sizes`);
    const values = data.value;
    if (Array.isArray(values)) {
      return values.map((v) => Number(v));
    }
    if (ArrayBuffer.isView(values)) {
      return Array.from(values).map(Number);
    }
    return void 0;
  } catch {
    return void 0;
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
async function readIdentitiesStreaming(file) {
  try {
    const keys = file.keys();
    if (!keys.includes("identities_json")) return [];
    const data = await file.getDatasetValue("identities_json");
    const values = normalizeDatasetArray(data.value);
    const identities = [];
    for (const entry of values) {
      const parsed = parseJsonEntry(entry);
      const { name, color, ...rest } = parsed;
      identities.push(
        new Identity({
          name: name ?? "",
          color,
          metadata: rest
        })
      );
    }
    return identities;
  } catch {
    return [];
  }
}
async function readSessionsStreaming(file, videos, skeletons, identities, captureRaw = false) {
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
          distortions: cameraData.distortions,
          size: cameraData.size
        });
        cameraGroup.cameras.push(camera);
        cameraMap.set(String(key), camera);
      }
      cameraGroup.metadata = calibration.metadata ?? {};
      const session = new RecordingSession({
        cameraGroup,
        metadata: parsed.metadata ?? {}
      });
      if (captureRaw) session.rawJson = structuredClone(parsed);
      const map = parsed.camcorder_to_video_idx_map ?? {};
      for (const [cameraKey, videoIdx] of Object.entries(map)) {
        const camera = resolveCameraKey(
          cameraKey,
          cameraMap,
          cameraGroup.cameras
        );
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
          let instanceByCamera;
          const instancesRecord = instanceGroupRecord.instances ?? {};
          for (const [cameraKey, points] of Object.entries(instancesRecord)) {
            const camera = resolveCameraKey(
              cameraKey,
              cameraMap,
              cameraGroup.cameras
            );
            if (!camera) {
              console.warn(
                `Camera key "${cameraKey}" not found in session calibration \u2014 skipping 2D instance data for this camera.`
              );
              continue;
            }
            const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
            if (!instanceByCamera)
              instanceByCamera = /* @__PURE__ */ new Map();
            instanceByCamera.set(
              camera,
              new Instance({
                points,
                skeleton
              })
            );
          }
          let instanceRefsByCamera;
          const lfInstMap = instanceGroupRecord.camcorder_to_lf_and_inst_idx_map ?? {};
          for (const [camIdx, value] of Object.entries(lfInstMap)) {
            const camera = resolveCameraKey(
              camIdx,
              cameraMap,
              cameraGroup.cameras
            );
            if (!camera) continue;
            const pair = value;
            if (!instanceRefsByCamera)
              instanceRefsByCamera = /* @__PURE__ */ new Map();
            instanceRefsByCamera.set(camera, [
              Number(pair[0]),
              Number(pair[1])
            ]);
          }
          const instance3d = reconstructInstance3D(
            instanceGroupRecord,
            skeletons
          );
          const identity = resolveIdentity(instanceGroupRecord, identities);
          instanceGroups.push(
            new InstanceGroup({
              instanceByCamera,
              instanceRefsByCamera,
              score: instanceGroupRecord.score,
              instance3d,
              identity,
              metadata: instanceGroupRecord.metadata ?? {}
            })
          );
        }
        let labeledFrameRefsByCamera;
        const labeledFrameMap = groupRecord.labeled_frame_by_camera ?? {};
        for (const [cameraKey, labeledFrameIdx] of Object.entries(
          labeledFrameMap
        )) {
          const camera = resolveCameraKey(
            cameraKey,
            cameraMap,
            cameraGroup.cameras
          );
          if (!camera) {
            console.warn(
              `Camera key "${cameraKey}" not found in session calibration \u2014 skipping labeled frame mapping.`
            );
            continue;
          }
          if (!labeledFrameRefsByCamera)
            labeledFrameRefsByCamera = /* @__PURE__ */ new Map();
          labeledFrameRefsByCamera.set(camera, Number(labeledFrameIdx));
        }
        if (!labeledFrameRefsByCamera) {
          for (const instanceGroup of instanceGroupList) {
            const igRecord = instanceGroup;
            const lfInstMap = igRecord.camcorder_to_lf_and_inst_idx_map ?? {};
            for (const [camIdx, value] of Object.entries(lfInstMap)) {
              const camera = resolveCameraKey(
                camIdx,
                cameraMap,
                cameraGroup.cameras
              );
              if (!camera) continue;
              const pair = value;
              if (!labeledFrameRefsByCamera)
                labeledFrameRefsByCamera = /* @__PURE__ */ new Map();
              labeledFrameRefsByCamera.set(camera, Number(pair[0]));
            }
          }
        }
        session.frameGroups.set(
          Number(frameIdx),
          new FrameGroup({
            frameIdx: Number(frameIdx),
            instanceGroups,
            labeledFrameRefsByCamera,
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
    let fieldNames = getFieldNamesFromMeta(meta);
    if (fieldNames.length === 0) {
      try {
        const attrs = await file.getAttrs(path);
        const fnAttr = attrs.field_names ?? attrs.fieldNames;
        if (fnAttr) {
          let raw = Array.isArray(fnAttr) ? fnAttr : fnAttr?.value;
          if (typeof raw === "string") {
            try {
              raw = JSON.parse(raw);
            } catch {
            }
          }
          if (raw instanceof Uint8Array) {
            try {
              raw = JSON.parse(new TextDecoder().decode(raw));
            } catch {
            }
          }
          if (Array.isArray(raw)) {
            fieldNames = raw.map(String);
          }
        }
      } catch {
      }
    }
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
  if (Array.isArray(dtype)) {
    return dtype.map((pair) => pair[0]);
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
    const firstCol = firstKey ? obj[firstKey] : void 0;
    if (firstKey && (Array.isArray(firstCol) || ArrayBuffer.isView(firstCol))) {
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
  const {
    framesData,
    instancesData,
    pointsData,
    predPointsData,
    skeletons,
    tracks,
    videos,
    formatId
  } = options;
  const frameIds = framesData.frame_id ?? [];
  const videoIdToIndex = buildVideoIdMap(framesData, videos);
  const instanceById = /* @__PURE__ */ new Map();
  const fromPredictedPairs = [];
  for (let frameIdx = 0; frameIdx < frameIds.length; frameIdx += 1) {
    const rawVideoId = Number(framesData.video?.[frameIdx] ?? 0);
    const videoIndex = videoIdToIndex.get(rawVideoId) ?? rawVideoId;
    const frameIndex = Number(
      framesData.frame_idx?.[frameIdx] ?? 0
    );
    const instStart = Number(
      framesData.instance_id_start?.[frameIdx] ?? 0
    );
    const instEnd = Number(
      framesData.instance_id_end?.[frameIdx] ?? 0
    );
    const video = videos[videoIndex];
    if (!video) continue;
    const instances = [];
    for (let instIdx = instStart; instIdx < instEnd; instIdx += 1) {
      const instanceType = Number(
        instancesData.instance_type?.[instIdx] ?? 0
      );
      const skeletonId = Number(
        instancesData.skeleton?.[instIdx] ?? 0
      );
      const trackId = Number(
        instancesData.track?.[instIdx] ?? -1
      );
      const pointStart = Number(
        instancesData.point_id_start?.[instIdx] ?? 0
      );
      const pointEnd = Number(
        instancesData.point_id_end?.[instIdx] ?? 0
      );
      const score = Number(instancesData.score?.[instIdx] ?? 0);
      const rawTrackingScore = formatId < 1.2 ? 0 : Number(instancesData.tracking_score?.[instIdx] ?? 0);
      const trackingScore = Number.isNaN(rawTrackingScore) ? 0 : rawTrackingScore;
      const fromPredicted = Number(
        instancesData.from_predicted?.[instIdx] ?? -1
      );
      const skeleton = skeletons[skeletonId] ?? skeletons[0] ?? new Skeleton({ nodes: [] });
      const track = trackId >= 0 ? tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        instance = Instance._fromColumns({
          columns: pointsData,
          start: pointStart,
          end: pointEnd,
          skeleton,
          track,
          trackingScore
        });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        instance = PredictedInstance._fromColumns({
          columns: predPointsData,
          start: pointStart,
          end: pointEnd,
          skeleton,
          track,
          score,
          trackingScore
        });
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

// src/codecs/slp/write.ts
import { deflate } from "pako";
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
function writeStringDataset(file, name, values) {
  const json = JSON.stringify(values);
  const bytes = textEncoder.encode(json);
  file.create_dataset({
    name,
    data: bytes,
    shape: [bytes.length],
    dtype: "<B"
  });
  const ds = file.get(name);
  setStringAttr(ds, "json", json);
}
var SPAWNED_ON = 0;
function writeSlpToFile(file, labels, embeddedVideoData) {
  writeMetadata(file, labels);
  if (embeddedVideoData && embeddedVideoData.size > 0) {
    writeEmbeddedVideos(file, labels, embeddedVideoData);
  } else {
    writeVideos(file, labels.videos);
  }
  writeVideoCrops(file, labels.videos);
  writeTracks(file, labels.tracks);
  writeSuggestions(file, labels.suggestions, labels.videos);
  writeIdentities(file, labels.identities);
  writeSessions(
    file,
    labels.sessions,
    labels.videos,
    labels.labeledFrames,
    labels.identities
  );
  writeLabeledFrames(file, labels);
  writeNegativeFrames(file, labels);
  const allInstances = labels.labeledFrames.flatMap((f) => f.instances);
  const allRois = [];
  const roiCtx = [];
  const allMasks = [];
  const maskCtx = [];
  const allBboxes = [];
  const bboxCtx = [];
  const allCentroids = [];
  const centroidCtx = [];
  const allLabelImages = [];
  const liCtx = [];
  for (const lf of labels.labeledFrames) {
    const vidIdx = labels.videos.indexOf(lf.video);
    for (const r of lf.rois) {
      allRois.push(r);
      roiCtx.push([vidIdx, lf.frameIdx]);
    }
    for (const m of lf.masks) {
      allMasks.push(m);
      maskCtx.push([vidIdx, lf.frameIdx]);
    }
    for (const b of lf.bboxes) {
      allBboxes.push(b);
      bboxCtx.push([vidIdx, lf.frameIdx]);
    }
    for (const c of lf.centroids) {
      allCentroids.push(c);
      centroidCtx.push([vidIdx, lf.frameIdx]);
    }
    for (const li of lf.labelImages) {
      allLabelImages.push(li);
      liCtx.push([vidIdx, lf.frameIdx]);
    }
  }
  for (const r of labels._staticRois) {
    allRois.push(r);
    roiCtx.push([r.video ? labels.videos.indexOf(r.video) : -1, -1]);
  }
  writeRois(file, allRois, labels.videos, labels.tracks, allInstances, roiCtx);
  writeMasks(
    file,
    allMasks,
    labels.videos,
    labels.tracks,
    allInstances,
    maskCtx
  );
  writeBboxes(
    file,
    allBboxes,
    labels.videos,
    labels.tracks,
    allInstances,
    bboxCtx
  );
  writeCentroids(
    file,
    allCentroids,
    labels.videos,
    labels.tracks,
    allInstances,
    centroidCtx
  );
  writeLabelImages(
    file,
    allLabelImages,
    labels.videos,
    labels.tracks,
    allInstances,
    liCtx
  );
}
var LazySourceFallback = class extends Error {
  constructor() {
    super("lazy source mode requires materialization");
    this.name = "LazySourceFallback";
  }
};
function makeLazySourceLabels(labels) {
  const restoredVideos = labels.videos.map((v) => v.sourceVideo ?? v);
  const videoMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < labels.videos.length; i++) {
    if (labels.videos[i] !== restoredVideos[i]) {
      videoMap.set(labels.videos[i], restoredVideos[i]);
    }
  }
  if (videoMap.size === 0) return labels;
  for (const session of labels.sessions) {
    for (const v of session.videoByCamera.values()) {
      if (videoMap.has(v)) {
        throw new LazySourceFallback();
      }
    }
  }
  const remappedSuggestions = labels.suggestions.map((s) => {
    const newVideo = videoMap.get(s.video);
    if (!newVideo) return s;
    return new SuggestionFrame({
      video: newVideo,
      frameIdx: s.frameIdx,
      group: s.group,
      metadata: s.metadata
    });
  });
  const out = new Labels({
    videos: restoredVideos,
    skeletons: labels.skeletons,
    tracks: labels.tracks,
    suggestions: remappedSuggestions,
    sessions: labels.sessions,
    // safe: verified no swapped refs
    identities: labels.identities,
    provenance: labels.provenance,
    rois: labels._staticRois
  });
  out._lazyFrameList = labels._lazyFrameList;
  out._lazyDataStore = labels._lazyDataStore;
  return out;
}
function writeLazyMatrixDataset(file, name, columns, fieldNames, dtype) {
  const rowCount = (columns[fieldNames[0]] ?? []).length;
  const colCount = fieldNames.length;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = new Array(colCount);
    for (let j = 0; j < colCount; j++) {
      const col = columns[fieldNames[j]] ?? [];
      const v = col[i];
      row[j] = v === void 0 || v === null ? 0 : Number(v);
    }
    rows.push(row);
  }
  createMatrixDataset(file, name, rows, fieldNames, dtype);
}
function writeLazyFramesAndInstances(file, store) {
  writeLazyMatrixDataset(
    file,
    "frames",
    store.framesData,
    ["frame_id", "video", "frame_idx", "instance_id_start", "instance_id_end"],
    "<i8"
  );
  writeLazyMatrixDataset(
    file,
    "instances",
    store.instancesData,
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
  writeLazyMatrixDataset(
    file,
    "points",
    store.pointsData,
    ["x", "y", "visible", "complete"],
    "<f8"
  );
  writeLazyMatrixDataset(
    file,
    "pred_points",
    store.predPointsData,
    ["x", "y", "visible", "complete", "score"],
    "<f8"
  );
}
function writeLazyNegativeFrames(file, store) {
  if (store.negativeFrames.size === 0) return;
  const rows = [];
  for (const key of store.negativeFrames) {
    const [vidStr, fidxStr] = key.split(":");
    rows.push([Number(vidStr), Number(fidxStr)]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  createMatrixDataset(
    file,
    "negative_frames",
    rows,
    ["video_id", "frame_idx"],
    "<i8"
  );
}
function writeSlpToFileLazy(file, labels) {
  const store = labels._lazyDataStore;
  if (!labels.isLazy || !store) {
    throw new Error(
      "writeSlpToFileLazy requires lazy Labels with a data store"
    );
  }
  writeMetadata(file, labels);
  writeVideos(file, labels.videos);
  writeVideoCrops(file, labels.videos);
  writeTracks(file, labels.tracks);
  writeSuggestions(file, labels.suggestions, labels.videos);
  writeIdentities(file, labels.identities);
  writeSessions(file, labels.sessions, labels.videos, [], labels.identities);
  writeLazyFramesAndInstances(file, store);
  writeLazyNegativeFrames(file, store);
  const allRois = [];
  const roiCtx = [];
  const allMasks = [];
  const maskCtx = [];
  const allBboxes = [];
  const bboxCtx = [];
  const allCentroids = [];
  const centroidCtx = [];
  const allLabelImages = [];
  const liCtx = [];
  const collectFrameBound = (byFrame, out, ctxOut) => {
    for (const [key, list] of byFrame) {
      const [vidStr, fidxStr] = key.split(":");
      const vidIdx = Number(vidStr);
      const fidx = Number(fidxStr);
      for (const ann of list) {
        out.push(ann);
        ctxOut.push([vidIdx, fidx]);
      }
    }
  };
  collectFrameBound(store._roiByFrame, allRois, roiCtx);
  collectFrameBound(store._maskByFrame, allMasks, maskCtx);
  collectFrameBound(store._bboxByFrame, allBboxes, bboxCtx);
  collectFrameBound(store._centroidByFrame, allCentroids, centroidCtx);
  collectFrameBound(store._labelImageByFrame, allLabelImages, liCtx);
  for (const roi of store._undistributedRois) {
    allRois.push(roi);
    const vidIdx = roi.video ? labels.videos.indexOf(roi.video) : -1;
    roiCtx.push([vidIdx, -1]);
  }
  for (const m of store._undistributedMasks) {
    allMasks.push(m);
    maskCtx.push([-1, -1]);
  }
  for (const b of store._undistributedBboxes) {
    allBboxes.push(b);
    bboxCtx.push([-1, -1]);
  }
  for (const c of store._undistributedCentroids) {
    allCentroids.push(c);
    centroidCtx.push([-1, -1]);
  }
  for (const li of store._undistributedLabelImages) {
    allLabelImages.push(li);
    liCtx.push([-1, -1]);
  }
  writeRois(file, allRois, labels.videos, labels.tracks, void 0, roiCtx);
  writeMasks(file, allMasks, labels.videos, labels.tracks, [], maskCtx);
  writeBboxes(file, allBboxes, labels.videos, labels.tracks, [], bboxCtx);
  writeCentroids(
    file,
    allCentroids,
    labels.videos,
    labels.tracks,
    [],
    centroidCtx
  );
  writeLabelImages(
    file,
    allLabelImages,
    labels.videos,
    labels.tracks,
    [],
    liCtx
  );
}
async function saveSlpToBytes(labels, options) {
  const embedMode = options?.embed ?? false;
  if (labels.isLazy) {
    const needsMaterialization = embedMode === true || embedMode === "all" || embedMode === "user" || embedMode === "suggestions" || embedMode === "user+suggestions";
    if (!needsMaterialization) {
      let lazyWriteLabels = labels;
      let proceedWithFastPath = true;
      if (embedMode === "source") {
        try {
          lazyWriteLabels = makeLazySourceLabels(labels);
        } catch (e) {
          if (e instanceof LazySourceFallback) {
            labels.materialize();
            proceedWithFastPath = false;
          } else {
            throw e;
          }
        }
      }
      if (proceedWithFastPath) {
        const module2 = await getH5Module();
        ensureH5StagingDir(module2);
        const memPath2 = `/tmp/sleap_output_${Date.now()}_${Math.random().toString(16).slice(2)}.slp`;
        const file2 = new module2.File(memPath2, "w");
        try {
          writeSlpToFileLazy(file2, lazyWriteLabels);
        } finally {
          file2.close();
        }
        const fs2 = getH5FileSystem(module2);
        const bytes2 = fs2.readFile(memPath2);
        fs2.unlink(memPath2);
        return bytes2;
      }
    } else {
      labels.materialize();
    }
  }
  let writeLabels2 = labels;
  if (embedMode === "source") {
    const restoredVideos = labels.videos.map((video) => {
      if (video.sourceVideo) return video.sourceVideo;
      return video;
    });
    writeLabels2 = new Labels({
      labeledFrames: labels.labeledFrames.map((frame) => {
        const videoIdx = labels.videos.indexOf(frame.video);
        const restoredVideo = videoIdx >= 0 ? restoredVideos[videoIdx] : frame.video;
        return new LabeledFrame({
          video: restoredVideo,
          frameIdx: frame.frameIdx,
          instances: frame.instances,
          centroids: frame.centroids,
          bboxes: frame.bboxes,
          masks: frame.masks,
          labelImages: frame.labelImages,
          rois: frame.rois
        });
      }),
      videos: restoredVideos,
      skeletons: labels.skeletons,
      tracks: labels.tracks,
      suggestions: labels.suggestions,
      sessions: labels.sessions,
      provenance: labels.provenance,
      rois: labels._staticRois,
      identities: labels.identities
    });
  }
  const module = await getH5Module();
  ensureH5StagingDir(module);
  const memPath = `/tmp/sleap_output_${Date.now()}_${Math.random().toString(16).slice(2)}.slp`;
  let embeddedVideoData = null;
  if (embedMode && embedMode !== "source") {
    embeddedVideoData = await collectFramesForEmbedding(labels, embedMode);
  }
  const file = new module.File(memPath, "w");
  try {
    writeSlpToFile(file, writeLabels2, embeddedVideoData);
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
  const hasPredicted = labels.rois.some((r) => r.isPredicted) || labels.masks.some((m) => m.isPredicted) || (labels.labelImages ?? []).some((li) => li.isPredicted);
  const hasMaskInstances = labels.masks.some(
    (m) => m.instance !== null || m._instanceIdx != null && m._instanceIdx >= 0
  );
  let formatId = (labels.bboxes?.length ?? 0) > 0 ? 2 : hasPredicted || hasMaskInstances ? 1.9 : (labels.labelImages?.length ?? 0) > 0 ? 1.8 : hasRoiInstance ? 1.6 : labels.rois.length > 0 || labels.masks.length > 0 ? 1.5 : FORMAT_ID;
  if (hasIdentities) {
    formatId = Math.max(formatId, 1.9);
  }
  const hasSpatialTransform = labels.masks.some((m) => m.hasSpatialTransform) || (labels.labelImages ?? []).some((li) => li.hasSpatialTransform);
  if (hasSpatialTransform) {
    formatId = Math.max(formatId, 2.1);
  }
  if (labels.videos.some((v) => v._cropTuple() !== null)) {
    formatId = Math.max(formatId, 2.3);
  }
  const savedMasks = labels.masks;
  const savedMaskSet = new Set(savedMasks);
  if (savedMasks.some(
    (m) => m.fromPredicted != null && savedMaskSet.has(
      m.fromPredicted
    )
  )) {
    formatId = Math.max(formatId, 2.4);
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
    const skeletonNodeIds = skeleton.nodeNames.map(
      (name) => nodeIndex.get(name) ?? 0
    );
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
  const liveBackend = video.backend;
  if (liveBackend instanceof CropVideoBackend) {
    const inner = liveBackend.inner;
    if (inner instanceof CropVideoBackend) {
      throw new Error(
        "Cannot serialize a nested crop-of-crop video: the /video_crops format stores a single crop per video. Flatten the crop (use matching fills and an in-bounds region) before saving."
      );
    }
    const innerShape = inner.shape ?? backend.source_shape ?? video.sourceVideo?.shape;
    if (innerShape != null) backend.shape = [...innerShape];
    else delete backend.shape;
    if (inner.dataset != null) backend.dataset = inner.dataset;
    if (inner.fps != null) backend.fps = inner.fps;
  } else if (liveBackend == null && "crop" in backend) {
    let srcShape = null;
    if (video.sourceVideo?.shape != null) {
      srcShape = [...video.sourceVideo.shape];
    } else if (backend.source_shape != null) {
      srcShape = [...backend.source_shape];
    }
    if (srcShape == null) {
      throw new Error(
        "Cannot serialize closed cropped video: the uncropped source shape is unavailable (no source_video and no recorded source_shape), so videos_json cannot describe the full frame."
      );
    }
    backend.shape = srcShape;
  } else {
    if (backend.dataset == null && liveBackend?.dataset)
      backend.dataset = liveBackend.dataset;
    if (backend.shape == null && liveBackend?.shape)
      backend.shape = liveBackend.shape;
    if (backend.fps == null && liveBackend?.fps != null)
      backend.fps = liveBackend.fps;
  }
  delete backend.crop;
  delete backend.crop_fill;
  delete backend.source_shape;
  const entry = {
    filename: video.filename,
    backend
  };
  if (video.sourceVideo) {
    entry.source_video = { filename: video.sourceVideo.filename };
  }
  return entry;
}
function writeVideoCrops(file, videos) {
  const crops = [];
  for (let i = 0; i < videos.length; i++) {
    const rect = videos[i]._cropTuple();
    if (rect == null) continue;
    crops.push({ video: i, crop: [...rect], fill: videos[i]._cropFill() });
  }
  if (crops.length === 0) return;
  const payload = JSON.stringify(crops);
  file.create_dataset({ name: "video_crops", data: [payload] });
}
function writeTracks(file, tracks) {
  const payload = tracks.map(
    (track) => JSON.stringify([SPAWNED_ON, track.name])
  );
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
    for (const [key, value] of Object.entries(identity.metadata)) {
      if (key !== "name" && key !== "color") {
        d[key] = value;
      }
    }
    return JSON.stringify(d);
  });
  file.create_dataset({ name: "identities_json", data: payload });
}
function writeSessions(file, sessions, videos, labeledFrames, identities) {
  const labeledFrameIndex = /* @__PURE__ */ new Map();
  labeledFrames.forEach((lf, idx) => {
    labeledFrameIndex.set(lf, idx);
  });
  const payload = sessions.map(
    (session) => JSON.stringify(
      serializeSession(session, videos, labeledFrameIndex, identities)
    )
  );
  file.create_dataset({ name: "sessions_json", data: payload });
}
function serializeSession(session, videos, labeledFrameIndex, identities) {
  const calibration = {
    metadata: session.cameraGroup.metadata ?? {}
  };
  session.cameraGroup.cameras.forEach((camera, idx) => {
    const key = `cam_${idx}`;
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
    const cameraKey = cameraKeyForSession(camera, session);
    const videoIndex = videos.indexOf(video);
    if (cameraKey !== "-1" && videoIndex >= 0) {
      camcorder_to_video_idx_map[cameraKey] = videoIndex;
    }
  }
  const frame_group_dicts = [];
  for (const frameGroup of session.frameGroups.values()) {
    if (!frameGroup.instanceGroups.length) continue;
    frame_group_dicts.push(
      serializeFrameGroup(frameGroup, session, labeledFrameIndex, identities)
    );
  }
  return {
    calibration,
    camcorder_to_video_idx_map,
    frame_group_dicts,
    metadata: session.metadata ?? {}
  };
}
function serializeFrameGroup(frameGroup, session, labeledFrameIndex, identities) {
  const instance_groups = frameGroup.instanceGroups.map(
    (group) => serializeInstanceGroup(
      group,
      session,
      identities,
      frameGroup,
      labeledFrameIndex
    )
  );
  const concreteLfByCamera = frameGroup._labeledFrameByCamera;
  const lfRefsByCamera = frameGroup._labeledFrameRefsByCamera;
  const labeled_frame_by_camera = {};
  const frameCameras = /* @__PURE__ */ new Set([
    ...concreteLfByCamera?.keys() ?? [],
    ...lfRefsByCamera?.keys() ?? []
  ]);
  for (const camera of frameCameras) {
    const cameraKey = cameraKeyForSession(camera, session);
    const labeledFrame = concreteLfByCamera?.get(camera);
    let index = labeledFrame !== void 0 ? labeledFrameIndex.get(labeledFrame) : void 0;
    if (index === void 0) index = lfRefsByCamera?.get(camera);
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
function serializeInstanceGroup(group, session, identities, frameGroup, labeledFrameIndex) {
  const concreteInst = group._instanceByCamera;
  const instRefs = group._instanceRefsByCamera;
  const lfByCamera = concreteInst && frameGroup ? frameGroup.labeledFrameByCamera : void 0;
  const instances = {};
  const camcorder_to_lf_and_inst_idx_map = {};
  const instCameras = /* @__PURE__ */ new Set([
    ...concreteInst?.keys() ?? [],
    ...instRefs?.keys() ?? []
  ]);
  for (const camera of instCameras) {
    const cameraKey = cameraKeyForSession(camera, session);
    const instance = concreteInst?.get(camera);
    let pair;
    if (instance) {
      if (labeledFrameIndex) {
        const labeledFrame = lfByCamera?.get(camera);
        const lfIdx = labeledFrame !== void 0 ? labeledFrameIndex.get(labeledFrame) : void 0;
        const instIdx = labeledFrame ? labeledFrame.instances.indexOf(instance) : -1;
        if (lfIdx !== void 0 && instIdx >= 0) pair = [lfIdx, instIdx];
      }
      instances[cameraKey] = pointsToDict(instance);
    }
    if (!pair && instRefs?.has(camera)) pair = instRefs.get(camera);
    if (pair) camcorder_to_lf_and_inst_idx_map[cameraKey] = pair;
  }
  const payload = {};
  if (Object.keys(instances).length > 0) {
    payload.instances = instances;
  }
  if (Object.keys(camcorder_to_lf_and_inst_idx_map).length > 0) {
    payload.camcorder_to_lf_and_inst_idx_map = camcorder_to_lf_and_inst_idx_map;
  }
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
    } else {
      console.warn(
        `InstanceGroup references an Identity ("${group.identity.name}") not found in Labels.identities \u2014 identity will be dropped on save.`
      );
    }
  }
  if (group.metadata && Object.keys(group.metadata).length)
    payload.metadata = group.metadata;
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
  return String(session.cameraGroup.cameras.indexOf(camera));
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
      const skeletonId = Math.max(
        0,
        labels.skeletons.indexOf(instance.skeleton)
      );
      const trackId = instance.track ? labels.tracks.indexOf(instance.track) : -1;
      const trackingScore = instance.trackingScore ?? 0;
      const fromPredicted = -1;
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
    frames.push([
      frameId,
      videoIndex,
      labeledFrame.frameIdx,
      instanceStart,
      instanceEnd
    ]);
  }
  for (const [instanceId, fromPredictedInstance] of predictedLinks) {
    const fromIndex = instanceIndex.get(fromPredictedInstance);
    if (fromIndex != null) {
      instances[instanceId][5] = fromIndex;
    } else {
      instances[instanceId][5] = -1;
    }
  }
  createMatrixDataset(
    file,
    "frames",
    frames,
    ["frame_id", "video", "frame_idx", "instance_id_start", "instance_id_end"],
    "<i8"
  );
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
  createMatrixDataset(
    file,
    "points",
    points,
    ["x", "y", "visible", "complete"],
    "<f8"
  );
  createMatrixDataset(
    file,
    "pred_points",
    predPoints,
    ["x", "y", "visible", "complete", "score"],
    "<f8"
  );
}
function writeNegativeFrames(file, labels) {
  const negativeFrames = labels.labeledFrames.filter((f) => f.isNegative);
  if (!negativeFrames.length) return;
  const rows = [];
  for (const frame of negativeFrames) {
    const videoIndex = Math.max(0, labels.videos.indexOf(frame.video));
    rows.push([videoIndex, frame.frameIdx]);
  }
  createMatrixDataset(
    file,
    "negative_frames",
    rows,
    ["video_id", "frame_idx"],
    "<i8"
  );
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
      if (!framesByVideo.has(videoIndex))
        framesByVideo.set(videoIndex, /* @__PURE__ */ new Set());
      framesByVideo.get(videoIndex).add(frame.frameIdx);
    }
  }
  if (mode === "suggestions" || mode === "user+suggestions") {
    for (const suggestion of labels.suggestions) {
      const videoIndex = labels.videos.indexOf(suggestion.video);
      if (videoIndex < 0) continue;
      if (!framesByVideo.has(videoIndex))
        framesByVideo.set(videoIndex, /* @__PURE__ */ new Set());
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
      const inner = video.backend instanceof CropVideoBackend ? video.backend.inner : video.backend;
      const innerShape = inner?.shape ?? video.backendMetadata?.source_shape;
      if (innerShape) backend.shape = innerShape;
      if (inner?.fps != null) backend.fps = inner.fps;
      const entry = {
        filename: ".",
        backend
      };
      if (video.sourceVideo) {
        entry.source_video = { filename: video.sourceVideo.filename };
      } else if (!video.hasEmbeddedImages) {
        entry.source_video = {
          filename: Array.isArray(video.filename) ? video.filename[0] : video.filename
        };
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
function writeRois(file, rois, videos, tracks, instances, contexts) {
  if (!rois.length) return;
  const rows = [];
  const wkbChunks = [];
  let wkbOffset = 0;
  const categories = [];
  const names = [];
  const sources = [];
  const hasInstances = instances && instances.length > 0;
  for (let i = 0; i < rois.length; i++) {
    const roi = rois[i];
    const wkb = encodeWkb(roi.geometry);
    const wkbStart = wkbOffset;
    const wkbEnd = wkbOffset + wkb.length;
    wkbChunks.push(wkb);
    wkbOffset = wkbEnd;
    const videoIdx = contexts ? contexts[i][0] : roi.video ? videos.indexOf(roi.video) : -1;
    const frameIdx = contexts ? contexts[i][1] : -1;
    const trackIdx = roi.track ? tracks.indexOf(roi.track) : -1;
    const instanceIdx = hasInstances && roi.instance ? instances.indexOf(roi.instance) : roi._instanceIdx ?? -1;
    const score = roi.isPredicted ? roi.score : Number.NaN;
    const isPredicted = roi.isPredicted ? 1 : 0;
    const trackingScore = roi.trackingScore ?? Number.NaN;
    rows.push([
      0,
      videoIdx,
      frameIdx,
      trackIdx,
      score,
      trackingScore,
      wkbStart,
      wkbEnd,
      instanceIdx,
      isPredicted
    ]);
    categories.push(roi.category);
    names.push(roi.name);
    sources.push(roi.source);
  }
  createMatrixDataset(
    file,
    "rois",
    rows,
    [
      "annotation_type",
      "video",
      "frame_idx",
      "track",
      "score",
      "tracking_score",
      "wkb_start",
      "wkb_end",
      "instance",
      "is_predicted"
    ],
    "<f8"
  );
  writeStringDataset(file, "roi_categories", categories);
  writeStringDataset(file, "roi_names", names);
  writeStringDataset(file, "roi_sources", sources);
  const totalWkb = wkbChunks.reduce((sum, c) => sum + c.length, 0);
  const wkbFlat = new Uint8Array(totalWkb);
  let offset = 0;
  for (const chunk of wkbChunks) {
    wkbFlat.set(chunk, offset);
    offset += chunk.length;
  }
  if (wkbFlat.length > 0) {
    file.create_dataset({
      name: "roi_wkb",
      data: wkbFlat,
      shape: [wkbFlat.length],
      dtype: "<B",
      chunks: [wkbFlat.length],
      compression: "gzip",
      compression_opts: 1
    });
  } else {
    file.create_dataset({
      name: "roi_wkb",
      data: wkbFlat,
      shape: [wkbFlat.length],
      dtype: "<B"
    });
  }
}
function writeMasks(file, masks, videos, tracks, instances, contexts) {
  if (!masks.length) return;
  const rows = [];
  const rleChunks = [];
  let rleOffset = 0;
  const categories = [];
  const names = [];
  const sources = [];
  const scoreMapIndexRows = [];
  const scoreMapChunks = [];
  let smOffset = 0;
  const maskIdToIdx = /* @__PURE__ */ new Map();
  masks.forEach((m, i) => {
    maskIdToIdx.set(m, i);
  });
  for (let i = 0; i < masks.length; i++) {
    const mask = masks[i];
    const rleBytes = new Uint8Array(mask.rleCounts.length * 4);
    const view = new DataView(rleBytes.buffer);
    for (let j = 0; j < mask.rleCounts.length; j++) {
      view.setUint32(j * 4, mask.rleCounts[j], true);
    }
    const rleStart = rleOffset;
    const rleEnd = rleOffset + rleBytes.length;
    rleChunks.push(rleBytes);
    rleOffset = rleEnd;
    const videoIdx = contexts ? contexts[i][0] : -1;
    const frameIdx = contexts ? contexts[i][1] : -1;
    const trackIdx = mask.track ? tracks.indexOf(mask.track) : -1;
    const score = mask.isPredicted ? mask.score : Number.NaN;
    const isPredicted = mask.isPredicted ? 1 : 0;
    const instanceIdx = mask.instance ? instances.indexOf(mask.instance) : mask._instanceIdx ?? -1;
    const maskTrackingScore = mask.trackingScore ?? Number.NaN;
    const fromPredictedSrc = mask.fromPredicted ?? null;
    const fromPredictedIdx = fromPredictedSrc != null ? maskIdToIdx.get(fromPredictedSrc) ?? -1 : -1;
    rows.push([
      mask.height,
      mask.width,
      2,
      videoIdx,
      frameIdx,
      trackIdx,
      score,
      rleStart,
      rleEnd,
      isPredicted,
      instanceIdx,
      maskTrackingScore,
      mask.scale[0],
      mask.scale[1],
      mask.offset[0],
      mask.offset[1],
      fromPredictedIdx
    ]);
    categories.push(mask.category);
    names.push(mask.name);
    sources.push(mask.source);
    if (mask.isPredicted) {
      const pm = mask;
      if (pm.scoreMap) {
        const smBytes = new Uint8Array(
          pm.scoreMap.buffer,
          pm.scoreMap.byteOffset,
          pm.scoreMap.byteLength
        );
        const compressed = deflate(smBytes);
        const smH = pm.scoreMap.length / mask.width;
        if (!Number.isInteger(smH)) {
          throw new Error(
            `Score map size ${pm.scoreMap.length} not divisible by width ${mask.width}`
          );
        }
        scoreMapIndexRows.push([
          i,
          smOffset,
          smOffset + compressed.length,
          smH,
          mask.width
        ]);
        scoreMapChunks.push(compressed);
        smOffset += compressed.length;
      }
    }
  }
  createMatrixDataset(
    file,
    "masks",
    rows,
    [
      "height",
      "width",
      "annotation_type",
      "video",
      "frame_idx",
      "track",
      "score",
      "rle_start",
      "rle_end",
      "is_predicted",
      "instance",
      "tracking_score",
      "scale_x",
      "scale_y",
      "offset_x",
      "offset_y",
      "from_predicted"
    ],
    "<f8"
  );
  writeStringDataset(file, "mask_categories", categories);
  writeStringDataset(file, "mask_names", names);
  writeStringDataset(file, "mask_sources", sources);
  const totalRle = rleChunks.reduce((sum, c) => sum + c.length, 0);
  const rleFlat = new Uint8Array(totalRle);
  let offset = 0;
  for (const chunk of rleChunks) {
    rleFlat.set(chunk, offset);
    offset += chunk.length;
  }
  if (rleFlat.length > 0) {
    file.create_dataset({
      name: "mask_rle",
      data: rleFlat,
      shape: [rleFlat.length],
      dtype: "<B",
      chunks: [rleFlat.length],
      compression: "gzip",
      compression_opts: 1
    });
  } else {
    file.create_dataset({
      name: "mask_rle",
      data: rleFlat,
      shape: [rleFlat.length],
      dtype: "<B"
    });
  }
  if (scoreMapIndexRows.length > 0) {
    createMatrixDataset(
      file,
      "mask_score_map_index",
      scoreMapIndexRows,
      ["mask_idx", "data_start", "data_end", "height", "width"],
      "<f8"
    );
    const totalSm = scoreMapChunks.reduce((sum, c) => sum + c.length, 0);
    const smFlat = new Uint8Array(totalSm);
    let smOff = 0;
    for (const chunk of scoreMapChunks) {
      smFlat.set(chunk, smOff);
      smOff += chunk.length;
    }
    file.create_dataset({
      name: "mask_score_maps",
      data: smFlat,
      shape: [smFlat.length],
      dtype: "<B"
    });
  }
}
function writeBboxes(file, bboxes, _videos, tracks, instances, contexts) {
  if (!bboxes.length) return;
  const rows = [];
  const categories = [];
  const names = [];
  const sources = [];
  for (let i = 0; i < bboxes.length; i++) {
    const bbox = bboxes[i];
    const videoIdx = contexts ? contexts[i][0] : -1;
    const frameIdx = contexts ? contexts[i][1] : -1;
    const trackIdx = bbox.track ? tracks.indexOf(bbox.track) : -1;
    const score = bbox.isPredicted ? bbox.score : Number.NaN;
    const instanceIdx = bbox.instance ? instances.indexOf(bbox.instance) : bbox._instanceIdx ?? -1;
    const trackingScore = bbox.trackingScore ?? Number.NaN;
    rows.push([
      bbox.x1,
      bbox.y1,
      bbox.x2,
      bbox.y2,
      bbox.angle,
      videoIdx,
      frameIdx,
      trackIdx,
      score,
      instanceIdx,
      trackingScore
    ]);
    categories.push(bbox.category);
    names.push(bbox.name);
    sources.push(bbox.source);
  }
  createMatrixDataset(
    file,
    "bboxes",
    rows,
    [
      "x1",
      "y1",
      "x2",
      "y2",
      "angle",
      "video",
      "frame_idx",
      "track",
      "score",
      "instance",
      "tracking_score"
    ],
    "<f8"
  );
  writeStringDataset(file, "bbox_categories", categories);
  writeStringDataset(file, "bbox_names", names);
  writeStringDataset(file, "bbox_sources", sources);
}
function writeLabelImages(file, labelImages, _videos, tracks, instances, contexts) {
  if (!labelImages.length) return;
  const endianCheck = new Uint8Array(new Uint16Array([258]).buffer);
  if (endianCheck[0] !== 2) {
    throw new Error("LabelImage I/O requires a little-endian platform.");
  }
  const rows = [];
  const compressedChunks = [];
  let dataOffset = 0;
  const objectRows = [];
  const objectCategories = [];
  const objectNames = [];
  const sources = [];
  let objectsOffset = 0;
  const smIndexRows = [];
  const smChunks = [];
  let smOffset = 0;
  for (let liIdx = 0; liIdx < labelImages.length; liIdx++) {
    const li = labelImages[liIdx];
    const videoIdx = contexts ? contexts[liIdx][0] : -1;
    const frameIdx = contexts ? contexts[liIdx][1] : -1;
    const pixelBytes = new Uint8Array(
      li.data.buffer,
      li.data.byteOffset,
      li.data.byteLength
    );
    const compressed = deflate(pixelBytes);
    const dataStart = dataOffset;
    const dataEnd = dataOffset + compressed.length;
    compressedChunks.push(compressed);
    dataOffset = dataEnd;
    const isPredicted = li.isPredicted ? 1 : 0;
    const liScore = li.isPredicted ? li.score : Number.NaN;
    const objectsStart = objectsOffset;
    for (const [labelId, info] of li.objects) {
      const trackIdx = info.track ? tracks.indexOf(info.track) : -1;
      let instanceIdx = li._objectInstanceIdxs?.get(labelId) ?? -1;
      if (info.instance) {
        const found = instances.indexOf(info.instance);
        if (found >= 0) instanceIdx = found;
      } else if (info._instanceIdx != null && info._instanceIdx >= 0) {
        instanceIdx = info._instanceIdx;
      }
      const objScore = info.score != null ? info.score : Number.NaN;
      const objTrackingScore = info.trackingScore != null ? info.trackingScore : Number.NaN;
      objectRows.push([
        labelId,
        trackIdx,
        instanceIdx,
        objScore,
        objTrackingScore
      ]);
      objectCategories.push(info.category);
      objectNames.push(info.name);
      objectsOffset++;
    }
    rows.push([
      videoIdx,
      frameIdx,
      li.height,
      li.width,
      li.nObjects,
      objectsStart,
      dataStart,
      dataEnd,
      isPredicted,
      liScore,
      li.scale[0],
      li.scale[1],
      li.offset[0],
      li.offset[1]
    ]);
    sources.push(li.source);
    if (li.isPredicted) {
      const pli = li;
      if (pli.scoreMap) {
        const smBytes = new Uint8Array(
          pli.scoreMap.buffer,
          pli.scoreMap.byteOffset,
          pli.scoreMap.byteLength
        );
        const smCompressed = deflate(smBytes);
        const smH = pli.scoreMap.length / li.width;
        if (!Number.isInteger(smH)) {
          throw new Error(
            `Score map size ${pli.scoreMap.length} not divisible by width ${li.width}`
          );
        }
        smIndexRows.push([
          liIdx,
          smOffset,
          smOffset + smCompressed.length,
          smH,
          li.width
        ]);
        smChunks.push(smCompressed);
        smOffset += smCompressed.length;
      }
    }
  }
  createMatrixDataset(
    file,
    "label_images",
    rows,
    [
      "video",
      "frame_idx",
      "height",
      "width",
      "n_objects",
      "objects_start",
      "data_start",
      "data_end",
      "is_predicted",
      "score",
      "scale_x",
      "scale_y",
      "offset_x",
      "offset_y"
    ],
    "<f8"
  );
  writeStringDataset(file, "label_image_sources", sources);
  if (objectRows.length > 0) {
    createMatrixDataset(
      file,
      "label_image_objects",
      objectRows,
      ["label_id", "track", "instance", "score", "tracking_score"],
      "<f8"
    );
    writeStringDataset(file, "label_image_obj_categories", objectCategories);
    writeStringDataset(file, "label_image_obj_names", objectNames);
  }
  const totalData = compressedChunks.reduce((sum, c) => sum + c.length, 0);
  const dataFlat = new Uint8Array(totalData);
  let offset = 0;
  for (const chunk of compressedChunks) {
    dataFlat.set(chunk, offset);
    offset += chunk.length;
  }
  file.create_dataset({
    name: "label_image_data",
    data: dataFlat,
    shape: [dataFlat.length],
    dtype: "<B"
  });
  if (smIndexRows.length > 0) {
    createMatrixDataset(
      file,
      "label_image_score_map_index",
      smIndexRows,
      ["li_idx", "data_start", "data_end", "height", "width"],
      "<f8"
    );
    const totalSm = smChunks.reduce((sum, c) => sum + c.length, 0);
    const smFlat = new Uint8Array(totalSm);
    let smOff = 0;
    for (const chunk of smChunks) {
      smFlat.set(chunk, smOff);
      smOff += chunk.length;
    }
    file.create_dataset({
      name: "label_image_score_maps",
      data: smFlat,
      shape: [smFlat.length],
      dtype: "<B"
    });
  }
}
function writeCentroids(file, centroids, _videos, tracks, instances, contexts) {
  if (!centroids.length) return;
  const rows = [];
  const categories = [];
  const names = [];
  const sources = [];
  for (let i = 0; i < centroids.length; i++) {
    const c = centroids[i];
    const videoIdx = contexts ? contexts[i][0] : -1;
    const frameIdx = contexts ? contexts[i][1] : -1;
    const trackIdx = c.track ? tracks.indexOf(c.track) : -1;
    const score = c.isPredicted ? c.score : Number.NaN;
    const instanceIdx = c.instance ? instances.indexOf(c.instance) : c._instanceIdx ?? -1;
    const isPredicted = c.isPredicted ? 1 : 0;
    const trackingScore = c.trackingScore ?? Number.NaN;
    rows.push([
      c.x,
      c.y,
      c.z ?? Number.NaN,
      videoIdx,
      frameIdx,
      trackIdx,
      instanceIdx,
      isPredicted,
      score,
      trackingScore
    ]);
    categories.push(c.category);
    names.push(c.name);
    sources.push(c.source);
  }
  createMatrixDataset(
    file,
    "centroids",
    rows,
    [
      "x",
      "y",
      "z",
      "video",
      "frame_idx",
      "track",
      "instance",
      "is_predicted",
      "score",
      "tracking_score"
    ],
    "<f8"
  );
  writeStringDataset(file, "centroid_categories", categories);
  writeStringDataset(file, "centroid_names", names);
  writeStringDataset(file, "centroid_sources", sources);
}

// src/io/analysis-h5.ts
var PRESETS = {
  // Standard: (frame, track, node, xy) - intuitive Python indexing.
  standard: { frame: 0, track: 1, node: 2, xy: 3 },
  // MATLAB: (track, xy, node, frame) - SLEAP-compatible column-major.
  matlab: { frame: 3, track: 0, node: 2, xy: 1 }
};
function dimsForNdim(ndim) {
  if (ndim === 4) return ["frame", "track", "node", "xy"];
  if (ndim === 3) return ["frame", "track", "node"];
  return ["frame", "track"];
}
function getAxisOrder(preset, frameDim, trackDim, nodeDim, xyDim) {
  const explicitDims = [frameDim, trackDim, nodeDim, xyDim];
  const hasExplicit = explicitDims.some((d) => d !== void 0);
  if (preset !== void 0 && hasExplicit) {
    throw new Error(
      "Cannot specify both 'preset' and explicit dimension positions (frame_dim, track_dim, node_dim, xy_dim). Use one or the other."
    );
  }
  if (hasExplicit) {
    if (!explicitDims.every((d) => d !== void 0)) {
      throw new Error(
        "When using explicit dimensions, all four must be specified: frame_dim, track_dim, node_dim, xy_dim"
      );
    }
    const sorted = [...explicitDims].sort((a, b) => a - b);
    const isPermutation = sorted.length === 4 && sorted[0] === 0 && sorted[1] === 1 && sorted[2] === 2 && sorted[3] === 3;
    if (!isPermutation) {
      throw new Error(
        `Dimension positions must be a permutation of [0, 1, 2, 3]. Got: frame_dim=${frameDim}, track_dim=${trackDim}, node_dim=${nodeDim}, xy_dim=${xyDim}`
      );
    }
    return {
      axisOrder: {
        frame: frameDim,
        track: trackDim,
        node: nodeDim,
        xy: xyDim
      },
      presetName: "custom"
    };
  }
  const presetName = preset ?? "matlab";
  if (!(presetName in PRESETS)) {
    throw new Error(
      `Unknown preset '${presetName}'. Available: ${JSON.stringify(Object.keys(PRESETS))}`
    );
  }
  return { axisOrder: PRESETS[presetName], presetName };
}
function getTransposeAxes(fromOrder, toOrder, ndim) {
  const dims = dimsForNdim(ndim);
  const axes = [];
  for (let targetPos = 0; targetPos < ndim; targetPos++) {
    for (const dim of dims) {
      if (toOrder[dim] === targetPos) {
        axes.push(fromOrder[dim]);
        break;
      }
    }
  }
  return axes;
}
function getDimsTuple(axisOrder, ndim) {
  const dims = dimsForNdim(ndim);
  const result = new Array(ndim).fill("");
  for (const dim of dims) {
    if (dim in axisOrder) {
      result[axisOrder[dim]] = dim;
    }
  }
  return result;
}
function rowMajorStrides(shape) {
  const strides = new Array(shape.length).fill(1);
  for (let i = shape.length - 2; i >= 0; i--) {
    strides[i] = strides[i + 1] * shape[i + 1];
  }
  return strides;
}
function transposeFlat(data, shape, axes) {
  const numShape = Array.from(shape, (s) => Number(s));
  const ndim = numShape.length;
  const inStrides = rowMajorStrides(numShape);
  const outShape = axes.map((a) => numShape[a]);
  const total = outShape.reduce((a, b) => a * b, 1);
  const out = new Float64Array(total);
  const outStridesInInput = axes.map((a) => inStrides[a]);
  const idx = new Array(ndim).fill(0);
  for (let flat = 0; flat < total; flat++) {
    let src = 0;
    for (let d = 0; d < ndim; d++) {
      src += idx[d] * outStridesInInput[d];
    }
    out[flat] = data[src];
    for (let d = ndim - 1; d >= 0; d--) {
      idx[d]++;
      if (idx[d] < outShape[d]) break;
      idx[d] = 0;
    }
  }
  return { data: out, shape: outShape };
}
function renumberOrder(order, keep) {
  const filtered = [];
  for (const k of keep) {
    if (k in order) filtered.push([k, order[k]]);
  }
  const positions = filtered.map(([, v]) => v).sort((a, b) => a - b);
  const result = {};
  for (const [k, v] of filtered) {
    result[k] = positions.indexOf(v);
  }
  return result;
}
var textDecoder = new TextDecoder();
function getDs(file, name) {
  const item = file.get(name);
  if (item == null) return null;
  if (!("value" in item)) return null;
  return item;
}
function decodeStringElement(v) {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return textDecoder.decode(v);
  if (Array.isArray(v))
    return textDecoder.decode(Uint8Array.from(v));
  return String(v);
}
function decodeStringArray(value) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (value instanceof Uint8Array) return [textDecoder.decode(value)];
  if (Array.isArray(value))
    return value.map(decodeStringElement);
  if (typeof value.length === "number") {
    return Array.from(value).map(decodeStringElement);
  }
  return [decodeStringElement(value)];
}
function decodeScalarString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return textDecoder.decode(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return decodeStringElement(value[0]);
  }
  return decodeStringElement(value);
}
function unwrapAttr(attr) {
  if (attr != null && typeof attr === "object" && "value" in attr) {
    return attr.value;
  }
  return attr;
}
function readStringAttr(attrs, name) {
  if (!attrs || !(name in attrs)) return void 0;
  const raw = unwrapAttr(attrs[name]);
  if (raw == null) return void 0;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return textDecoder.decode(raw);
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "";
    return decodeStringElement(raw[0]);
  }
  return String(raw);
}
function readDimsAttr(attrs) {
  if (!attrs || !("dims" in attrs)) return void 0;
  const raw = unwrapAttr(attrs["dims"]);
  if (raw == null) return void 0;
  if (Array.isArray(raw)) {
    return raw.map(decodeStringElement);
  }
  let s;
  if (typeof raw === "string") s = raw;
  else if (raw instanceof Uint8Array) s = textDecoder.decode(raw);
  else s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  } catch {
  }
  return void 0;
}
async function isAnalysisH5File(source) {
  try {
    if (typeof source === "string") {
      const exists = await nodeFileExists(source);
      if (exists === false) return false;
    }
    const { file, close } = await openH5File(source);
    try {
      const f = file;
      if (typeof f.keys === "function") {
        const keys = f.keys();
        return Array.isArray(keys) && keys.includes("track_occupancy");
      }
      const item = f.get("track_occupancy");
      return typeof item === "object" && item !== null;
    } finally {
      close();
    }
  } catch {
    return false;
  }
}
async function readLabels(filename, options) {
  const { file: rawFile, close } = await openH5File(filename);
  const file = rawFile;
  try {
    const fileAttrs = file.attrs ?? {};
    const tracksDs = getDs(file, "tracks");
    if (tracksDs == null) {
      throw new Error("Analysis HDF5 file is missing the 'tracks' dataset.");
    }
    const tracksAttrs = tracksDs.attrs ?? {};
    let storedOrder;
    const tracksDims = readDimsAttr(tracksAttrs);
    if (tracksDims) {
      storedOrder = {};
      tracksDims.forEach((dim, i) => {
        storedOrder[dim] = i;
      });
    } else {
      const transposeRaw = unwrapAttr(fileAttrs["transpose"]);
      const wasTransposed = transposeRaw === void 0 ? true : Boolean(transposeRaw);
      if (wasTransposed) {
        storedOrder = PRESETS["matlab"];
      } else {
        storedOrder = { frame: 0, node: 1, xy: 2, track: 3 };
      }
    }
    const canonicalOrder4d = { frame: 0, track: 1, node: 2, xy: 3 };
    const canonicalOrder3d = { frame: 0, track: 1, node: 2 };
    const canonicalOrder2d = { frame: 0, track: 1 };
    const tracksShape = tracksDs.shape ?? [];
    const axes4d = getTransposeAxes(storedOrder, canonicalOrder4d, 4);
    const tracksT = transposeFlat(
      tracksDs.value,
      tracksShape,
      axes4d
    );
    const [nFrames, nTracks, nNodes] = tracksT.shape;
    const tracksData = tracksT.data;
    const storedOrder3d = renumberOrder(storedOrder, [
      "frame",
      "track",
      "node"
    ]);
    const storedOrder2d = renumberOrder(storedOrder, ["frame", "track"]);
    const axes3d = getTransposeAxes(storedOrder3d, canonicalOrder3d, 3);
    const axes2d = getTransposeAxes(storedOrder2d, canonicalOrder2d, 2);
    const pointScoresDs = getDs(file, "point_scores");
    const pointScoresData = pointScoresDs ? transposeFlat(
      pointScoresDs.value,
      pointScoresDs.shape ?? [],
      axes3d
    ).data : new Float64Array(nFrames * nTracks * nNodes).fill(NaN);
    const instanceScoresDs = getDs(file, "instance_scores");
    const instanceScoresData = instanceScoresDs ? transposeFlat(
      instanceScoresDs.value,
      instanceScoresDs.shape ?? [],
      axes2d
    ).data : new Float64Array(nFrames * nTracks).fill(NaN);
    const trackingScoresDs = getDs(file, "tracking_scores");
    const trackingScoresData = trackingScoresDs ? transposeFlat(
      trackingScoresDs.value,
      trackingScoresDs.shape ?? [],
      axes2d
    ).data : new Float64Array(nFrames * nTracks).fill(NaN);
    const trackNamesDs = getDs(file, "track_names");
    const trackNames = trackNamesDs ? decodeStringArray(trackNamesDs.value) : [];
    const nodeNamesDs = getDs(file, "node_names");
    const nodeNames = nodeNamesDs ? decodeStringArray(nodeNamesDs.value) : [];
    const edgeNames = [];
    const edgeNamesDs = getDs(file, "edge_names");
    if (edgeNamesDs && edgeNamesDs.value != null) {
      const raw = edgeNamesDs.value;
      if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
        for (const pair of raw) {
          if (pair.length >= 2) {
            edgeNames.push([
              decodeStringElement(pair[0]),
              decodeStringElement(pair[1])
            ]);
          }
        }
      } else {
        const flat = decodeStringArray(raw);
        for (let i = 0; i + 1 < flat.length; i += 2) {
          edgeNames.push([flat[i], flat[i + 1]]);
        }
      }
    }
    let videoPath = "";
    const videoPathDs = getDs(file, "video_path");
    if (videoPathDs) videoPath = decodeScalarString(videoPathDs.value);
    let provenance = {};
    const provenanceDs = getDs(file, "provenance");
    if (provenanceDs) {
      const raw = decodeScalarString(provenanceDs.value);
      if (raw) {
        try {
          provenance = JSON.parse(raw);
        } catch {
          provenance = {};
        }
      }
    }
    const skeletonName = readStringAttr(fileAttrs, "skeleton_name") ?? "";
    let skeletonSymmetries = [];
    const symRaw = readStringAttr(fileAttrs, "skeleton_symmetries");
    if (symRaw) {
      try {
        skeletonSymmetries = JSON.parse(symRaw);
      } catch {
        skeletonSymmetries = [];
      }
    }
    let videoBackendMetadata = {};
    const vbmRaw = readStringAttr(fileAttrs, "video_backend_metadata");
    if (vbmRaw) {
      try {
        videoBackendMetadata = JSON.parse(vbmRaw);
      } catch {
        videoBackendMetadata = {};
      }
    }
    let video;
    if (options?.video !== void 0) {
      if (typeof options.video === "string") {
        video = new Video({ filename: options.video });
      } else {
        video = options.video;
      }
    } else {
      video = new Video({ filename: videoPath });
      video.backendMetadata = videoBackendMetadata;
    }
    const nodeNameSet = new Set(nodeNames);
    const validEdges = edgeNames.filter(
      ([s, d]) => nodeNameSet.has(s) && nodeNameSet.has(d)
    );
    const skeleton = new Skeleton({
      nodes: nodeNames,
      edges: validEdges,
      name: skeletonName ? skeletonName : void 0
    });
    for (const pair of skeletonSymmetries) {
      try {
        skeleton.addSymmetry(pair[0], pair[1]);
      } catch {
      }
    }
    const tracks = trackNames.length ? trackNames.map((name) => new Track(name)) : [null];
    const labeledFrames = [];
    for (let frameIdx = 0; frameIdx < nFrames; frameIdx++) {
      const instances = [];
      for (let trackIdx = 0; trackIdx < nTracks; trackIdx++) {
        const base4d = (frameIdx * nTracks + trackIdx) * nNodes * 2;
        let allNaN = true;
        for (let n = 0; n < nNodes * 2; n++) {
          if (!Number.isNaN(tracksData[base4d + n])) {
            allNaN = false;
            break;
          }
        }
        if (allNaN) continue;
        const base3d = (frameIdx * nTracks + trackIdx) * nNodes;
        const base2d = frameIdx * nTracks + trackIdx;
        const instanceScore = instanceScoresData[base2d];
        const trackingScore = trackingScoresData[base2d];
        const pointsData = [];
        for (let n = 0; n < nNodes; n++) {
          const x = tracksData[base4d + n * 2];
          const y = tracksData[base4d + n * 2 + 1];
          const score = pointScoresData[base3d + n];
          pointsData.push([x, y, score]);
        }
        const inst = PredictedInstance.fromNumpy({
          pointsData,
          skeleton,
          score: Number.isNaN(instanceScore) ? 0 : instanceScore,
          track: tracks[trackIdx] ?? void 0,
          trackingScore: Number.isNaN(trackingScore) ? void 0 : trackingScore
        });
        instances.push(inst);
      }
      if (instances.length > 0) {
        labeledFrames.push(new LabeledFrame({ video, frameIdx, instances }));
      }
    }
    const realTracks = tracks.filter((t) => t != null);
    const labels = new Labels({
      labeledFrames,
      videos: [video],
      skeletons: [skeleton],
      tracks: realTracks,
      provenance
    });
    labels.provenance["filename"] = String(filename);
    return labels;
  } finally {
    close();
  }
}
function maxInstancesPerFrame(lfs) {
  let nInstances = 0;
  for (const lf of lfs) {
    const nUser = (lf.userInstances ?? []).length;
    const nPredicted = (lf.predictedInstances ?? []).length;
    const nFrameInstances = Math.max(nUser, nPredicted);
    nInstances = Math.max(nInstances, nFrameInstances);
  }
  return nInstances;
}
function untrackedFrameInstances(lf, isSingleInstance) {
  const include = [];
  const userInsts = lf.userInstances ?? [];
  const predInsts = lf.predictedInstances ?? [];
  const hasUser = userInsts.length > 0;
  if (hasUser) {
    for (const inst of userInsts) include.push(inst);
    if (isSingleInstance && include.length > 0) {
      return include;
    }
    for (const inst of predInsts) {
      let skip = false;
      for (const userInst of userInsts) {
        if (userInst.fromPredicted !== void 0 && userInst.fromPredicted === inst) {
          skip = true;
          break;
        }
        if (userInst.track != null && inst.track != null && userInst.track === inst.track) {
          skip = true;
          break;
        }
      }
      if (!skip) include.push(inst);
    }
  } else {
    for (const inst of predInsts) include.push(inst);
  }
  return include;
}
function trackedFrameInstances(lf) {
  const trackToInstance = /* @__PURE__ */ new Map();
  for (const inst of lf.predictedInstances ?? []) {
    if (inst.track != null) trackToInstance.set(inst.track, inst);
  }
  for (const inst of lf.userInstances ?? []) {
    if (inst.track != null) trackToInstance.set(inst.track, inst);
  }
  return trackToInstance;
}
function videoFrameCount(video) {
  const shape = video.shape;
  if (shape && shape.length > 0 && typeof shape[0] === "number") {
    return shape[0];
  }
  return 0;
}
function toAnalysisArrays(labels, video, allFrames, minOccupancy) {
  const lfs = labels.find({ video });
  if (!lfs.length) {
    throw new Error(`No labeled frames in video: ${video.filename}`);
  }
  const frameIdxs = lfs.map((lf) => lf.frameIdx).sort((a, b) => a - b);
  const firstFrame = allFrames ? 0 : frameIdxs[0];
  let lastFrame = frameIdxs[frameIdxs.length - 1];
  const videoLength = videoFrameCount(video);
  if (videoLength > 0) {
    lastFrame = Math.max(lastFrame, videoLength - 1);
  }
  const nFrames = lastFrame - firstFrame + 1;
  const skeleton = labels.skeletons[0];
  const nodeCount = skeleton.nodeNames.length;
  const untracked = labels.tracks.length === 0;
  let nTracks;
  let isSingleInstance = false;
  let trackToSlot = null;
  if (untracked) {
    const nInstances = maxInstancesPerFrame(lfs);
    isSingleInstance = nInstances === 1;
    nTracks = nInstances;
  } else {
    nTracks = labels.tracks.length;
    trackToSlot = /* @__PURE__ */ new Map();
    labels.tracks.forEach((track, i) => {
      trackToSlot.set(track, i);
    });
  }
  const occupancy = new Float64Array(nFrames * nTracks);
  const locations = new Float64Array(nFrames * nTracks * nodeCount * 2).fill(
    NaN
  );
  const pointScores = new Float64Array(nFrames * nTracks * nodeCount).fill(NaN);
  const instanceScores = new Float64Array(nFrames * nTracks).fill(NaN);
  const trackingScores = new Float64Array(nFrames * nTracks).fill(NaN);
  const lfMap = /* @__PURE__ */ new Map();
  for (const lf of lfs) lfMap.set(lf.frameIdx, lf);
  for (let frameIdx = firstFrame; frameIdx <= lastFrame; frameIdx++) {
    const frameI = frameIdx - firstFrame;
    const lf = lfMap.get(frameIdx);
    if (!lf) continue;
    const slotted = [];
    if (untracked) {
      const insts = untrackedFrameInstances(lf, isSingleInstance);
      insts.forEach((inst, i) => {
        slotted.push([i, inst]);
      });
    } else {
      for (const [track, inst] of trackedFrameInstances(lf)) {
        const slot = trackToSlot.get(track);
        if (slot !== void 0) slotted.push([slot, inst]);
      }
    }
    for (const [trackI, inst] of slotted) {
      if (trackI >= nTracks) continue;
      occupancy[frameI * nTracks + trackI] = 1;
      const xy = inst.numpy();
      const locBase = (frameI * nTracks + trackI) * nodeCount * 2;
      for (let n = 0; n < nodeCount; n++) {
        const row = xy[n] ?? [NaN, NaN];
        locations[locBase + n * 2] = row[0];
        locations[locBase + n * 2 + 1] = row[1];
      }
      const ts = inst.trackingScore;
      if (ts !== void 0 && ts !== null) {
        trackingScores[frameI * nTracks + trackI] = ts;
      }
      if (inst instanceof PredictedInstance) {
        const withScores = inst.numpy({ scores: true });
        const psBase = (frameI * nTracks + trackI) * nodeCount;
        for (let n = 0; n < nodeCount; n++) {
          const row = withScores[n];
          pointScores[psBase + n] = row ? row[2] : NaN;
        }
        if (inst.score !== void 0 && inst.score !== null) {
          instanceScores[frameI * nTracks + trackI] = inst.score;
        }
      }
    }
  }
  const occupiedFrames = new Array(nTracks).fill(0);
  for (let f = 0; f < nFrames; f++) {
    for (let t = 0; t < nTracks; t++) {
      occupiedFrames[t] += occupancy[f * nTracks + t];
    }
  }
  const keepMask = occupiedFrames.map(
    (count) => count > 0 && count / nFrames >= minOccupancy
  );
  const keepIdxs = [];
  keepMask.forEach((keep, i) => {
    if (keep) keepIdxs.push(i);
  });
  let finalNTracks = nTracks;
  let finalOccupancy = occupancy;
  let finalLocations = locations;
  let finalPointScores = pointScores;
  let finalInstanceScores = instanceScores;
  let finalTrackingScores = trackingScores;
  if (keepIdxs.length !== nTracks) {
    finalNTracks = keepIdxs.length;
    finalOccupancy = new Float64Array(nFrames * finalNTracks);
    finalLocations = new Float64Array(nFrames * finalNTracks * nodeCount * 2);
    finalPointScores = new Float64Array(nFrames * finalNTracks * nodeCount);
    finalInstanceScores = new Float64Array(nFrames * finalNTracks);
    finalTrackingScores = new Float64Array(nFrames * finalNTracks);
    for (let f = 0; f < nFrames; f++) {
      for (let newT = 0; newT < finalNTracks; newT++) {
        const oldT = keepIdxs[newT];
        finalOccupancy[f * finalNTracks + newT] = occupancy[f * nTracks + oldT];
        finalInstanceScores[f * finalNTracks + newT] = instanceScores[f * nTracks + oldT];
        finalTrackingScores[f * finalNTracks + newT] = trackingScores[f * nTracks + oldT];
        for (let n = 0; n < nodeCount; n++) {
          finalPointScores[(f * finalNTracks + newT) * nodeCount + n] = pointScores[(f * nTracks + oldT) * nodeCount + n];
          const newBase = ((f * finalNTracks + newT) * nodeCount + n) * 2;
          const oldBase = ((f * nTracks + oldT) * nodeCount + n) * 2;
          finalLocations[newBase] = locations[oldBase];
          finalLocations[newBase + 1] = locations[oldBase + 1];
        }
      }
    }
  }
  let trackNames;
  if (untracked) {
    trackNames = Array.from({ length: finalNTracks }, (_, i) => `track_${i}`);
  } else {
    trackNames = labels.tracks.filter((_, i) => keepMask[i]).map((t) => t.name);
  }
  return {
    occupancy: finalOccupancy,
    locations: finalLocations,
    pointScores: finalPointScores,
    instanceScores: finalInstanceScores,
    trackingScores: finalTrackingScores,
    trackNames,
    firstFrame,
    nFrames,
    nTracks: finalNTracks,
    nNodes: nodeCount
  };
}
async function readPackageVersion() {
  try {
    const version = await nodeReadPackageVersion();
    if (version) return version;
  } catch {
  }
  return "0.0.0";
}
function setRootAttr(f, name, value) {
  try {
    f.create_attribute(name, value);
    return;
  } catch {
  }
  const root = f.get("/");
  if (root) {
    root.create_attribute(name, value);
  }
}
function videoFilenameString(video) {
  const fn = video.filename;
  if (Array.isArray(fn)) return fn.length ? fn[0] : "";
  return fn ?? "";
}
async function writeLabels(labels, filename, options) {
  const allFrames = options?.allFrames ?? true;
  const minOccupancy = options?.minOccupancy ?? 0;
  const saveMetadata = options?.saveMetadata ?? true;
  const { axisOrder, presetName } = getAxisOrder(
    options?.preset,
    options?.frameDim,
    options?.trackDim,
    options?.nodeDim,
    options?.xyDim
  );
  let video;
  if (options?.video === void 0) {
    video = labels.videos[0];
  } else if (typeof options.video === "number") {
    video = labels.videos[options.video];
  } else {
    video = options.video;
  }
  const arrays = toAnalysisArrays(labels, video, allFrames, minOccupancy);
  const { nFrames, nTracks, nNodes } = arrays;
  const canonicalOrder4d = { frame: 0, track: 1, node: 2, xy: 3 };
  const canonicalOrder3d = { frame: 0, track: 1, node: 2 };
  const canonicalOrder2d = { frame: 0, track: 1 };
  const targetOrder3d = renumberOrder(axisOrder, ["frame", "track", "node"]);
  const targetOrder2d = renumberOrder(axisOrder, ["frame", "track"]);
  const targetOrderOccupancy = presetName === "matlab" ? { frame: 0, track: 1 } : targetOrder2d;
  const axes4d = getTransposeAxes(canonicalOrder4d, axisOrder, 4);
  const axes3d = getTransposeAxes(canonicalOrder3d, targetOrder3d, 3);
  const axes2d = getTransposeAxes(canonicalOrder2d, targetOrder2d, 2);
  const axesOccupancy = getTransposeAxes(
    canonicalOrder2d,
    targetOrderOccupancy,
    2
  );
  const locationsT = transposeFlat(
    arrays.locations,
    [nFrames, nTracks, nNodes, 2],
    axes4d
  );
  const pointScoresT = transposeFlat(
    arrays.pointScores,
    [nFrames, nTracks, nNodes],
    axes3d
  );
  const instanceScoresT = transposeFlat(
    arrays.instanceScores,
    [nFrames, nTracks],
    axes2d
  );
  const trackingScoresT = transposeFlat(
    arrays.trackingScores,
    [nFrames, nTracks],
    axes2d
  );
  const occupancyT = transposeFlat(
    arrays.occupancy,
    [nFrames, nTracks],
    axesOccupancy
  );
  const dims4d = getDimsTuple(axisOrder, 4);
  const dims3d = getDimsTuple(targetOrder3d, 3);
  const dims2d = getDimsTuple(targetOrder2d, 2);
  const dimsOccupancy = getDimsTuple(targetOrderOccupancy, 2);
  const skeleton = labels.skeletons[0];
  const nodeNames = skeleton.nodeNames;
  const edgeNames = skeleton.edges.map(
    (e) => [e.source.name, e.destination.name]
  );
  const edgeInds = skeleton.edgeIndices;
  const version = await readPackageVersion();
  const module = await getH5Module();
  ensureH5StagingDir(module);
  const memPath = `/tmp/analysis_${Date.now()}_${Math.random().toString(16).slice(2)}.h5`;
  const f = new module.File(memPath, "w");
  try {
    const writeNumeric = (name, data, shape, dimNames) => {
      const canCompress = shape.length > 0 && shape.every((d) => d > 0);
      if (canCompress) {
        f.create_dataset({
          name,
          data,
          shape,
          dtype: "<f8",
          chunks: shape,
          compression: "gzip",
          compression_opts: 9
        });
      } else {
        f.create_dataset({ name, data, shape, dtype: "<f8" });
      }
      const ds = f.get(name);
      if (ds) ds.create_attribute("dims", JSON.stringify(dimNames));
    };
    writeNumeric("tracks", locationsT.data, locationsT.shape, dims4d);
    writeNumeric(
      "track_occupancy",
      occupancyT.data,
      occupancyT.shape,
      dimsOccupancy
    );
    writeNumeric("point_scores", pointScoresT.data, pointScoresT.shape, dims3d);
    writeNumeric(
      "instance_scores",
      instanceScoresT.data,
      instanceScoresT.shape,
      dims2d
    );
    writeNumeric(
      "tracking_scores",
      trackingScoresT.data,
      trackingScoresT.shape,
      dims2d
    );
    f.create_dataset({ name: "track_names", data: arrays.trackNames });
    f.create_dataset({ name: "node_names", data: nodeNames });
    const edgeFlat = [];
    for (const [s, d] of edgeNames) {
      edgeFlat.push(s, d);
    }
    f.create_dataset({
      name: "edge_names",
      data: edgeFlat,
      shape: [edgeNames.length, 2]
    });
    f.create_dataset({
      name: "edge_inds",
      data: Int32Array.from(edgeInds.flat()),
      shape: [edgeInds.length, 2],
      dtype: "<i4"
    });
    f.create_dataset({
      name: "labels_path",
      data: options?.labelsPath ? String(options.labelsPath) : ""
    });
    f.create_dataset({
      name: "video_path",
      data: videoFilenameString(video) || ""
    });
    f.create_dataset({
      name: "video_ind",
      data: Int32Array.from([labels.videos.indexOf(video)]),
      shape: [],
      dtype: "<i4"
    });
    f.create_dataset({
      name: "provenance",
      data: JSON.stringify(labels.provenance ?? {})
    });
    setRootAttr(f, "preset", presetName);
    setRootAttr(f, "format", "analysis");
    setRootAttr(f, "sleap_io_version", version);
    if (saveMetadata) {
      const symmetries = skeleton.symmetryNames;
      setRootAttr(f, "skeleton_name", skeleton.name ?? "");
      setRootAttr(f, "skeleton_symmetries", JSON.stringify(symmetries));
      setRootAttr(
        f,
        "video_backend_metadata",
        JSON.stringify(video.backendMetadata ?? {})
      );
    }
  } finally {
    f.close();
  }
  const fsModule = getH5FileSystem(module);
  const bytes = fsModule.readFile(memPath);
  fsModule.unlink(memPath);
  await nodeWriteFile(filename, bytes);
}

// src/io/label-images.ts
var fileReader = null;
function setLabelImageFileReader(fn) {
  fileReader = fn;
}
var warnedMessages = /* @__PURE__ */ new Set();
async function decodeTiff(bytes, opts) {
  let mod;
  try {
    mod = await import("tiff");
  } catch {
    throw new Error(
      "Reading TIFF label images requires the optional `tiff` package. Install it with: npm install tiff"
    );
  }
  try {
    return mod.decode(bytes, opts);
  } catch (err) {
    const m = String(err?.message ?? "");
    if (/bit\s*depth/i.test(m) && /(32|64)/.test(m)) {
      throw new Error(
        `32-bit integer TIFFs are not yet supported (${m}). Re-export the label image as uint16, or split into <=65535 objects.`
      );
    }
    throw err;
  }
}
async function loadLabelImages(source, options = {}) {
  const pagesAs = options.pagesAs ?? "auto";
  if (pagesAs !== "auto" && pagesAs !== "time" && pagesAs !== "classes") {
    throw new Error(
      `pagesAs must be 'auto', 'time', or 'classes'; got ${JSON.stringify(pagesAs)}.`
    );
  }
  const isBlob = typeof Blob !== "undefined" && source instanceof Blob;
  if (isBlob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    const src2 = options.source ?? source.name ?? "";
    return decodeSingleFile(bytes, pagesAs, options, src2);
  }
  if (!fileReader) {
    throw new Error(
      "Reading TIFF label images from a path requires the Node entry point (`@talmolab/sleap-io.js`). In the browser, pass a File/Blob instead."
    );
  }
  const read = await fileReader(source);
  const src = options.source ?? source;
  if (read instanceof Uint8Array) {
    return decodeSingleFile(read, pagesAs, options, src);
  }
  return decodeDirectory(read.files, pagesAs, options, src);
}
async function decodeSingleFile(bytes, pagesAs, options, source) {
  const meta = await decodeTiff(bytes, { ignoreImageData: true });
  const nPages = meta.length;
  if (nPages === 0) return [];
  for (const ifd of meta) validatePageDtype(ifd);
  let layout;
  if (pagesAs === "time") layout = "TYX";
  else if (pagesAs === "classes") layout = "CYX";
  else layout = inferAxes(meta[0].imageDescription, nPages);
  if (layout === "TCYX") {
    throw new Error(
      "4D TCYX (time + channel) TIFF stacks are not yet supported. Pass pagesAs: 'time' or 'classes' explicitly, or split the stack by channel."
    );
  }
  const pageIndices = normalizeFrames(options.frames, nPages);
  if (pageIndices.length === 0) return [];
  const ifds = await decodeTiff(bytes, { pages: pageIndices });
  const pages = ifds.map(pageTo2D);
  if (layout === "CYX") {
    return [buildClassStack(pages, options, source)];
  }
  if (pagesAs === "auto" && layout === "unknown" && nPages > 1 && pagesCouldBeClassStack(pages)) {
    warnAmbiguous(source, nPages, dtypeName(meta[0]));
  }
  return buildTimeStack(pages, options, source);
}
async function decodeDirectory(files, pagesAs, options, source) {
  if (files.length === 0) return [];
  const fileIndices = normalizeFrames(options.frames, files.length);
  const pages = [];
  for (const i of fileIndices) {
    const ifds = await decodeTiff(files[i], { pages: [0] });
    if (ifds.length === 0) continue;
    validatePageDtype(ifds[0]);
    pages.push(pageTo2D(ifds[0]));
  }
  if (pages.length === 0) return [];
  if (pagesAs === "classes") return [buildClassStack(pages, options, source)];
  return buildTimeStack(pages, options, source);
}
function validatePageDtype(ifd) {
  if (ifd.samplesPerPixel !== 1) {
    throw new Error(
      `Expected a single-channel (2D) label-image page, got ${ifd.samplesPerPixel} samples per pixel. Multi-channel/RGB TIFFs are not supported.`
    );
  }
  const fmt = ifd.sampleFormat ?? 1;
  if (fmt === 3) {
    throw new Error(
      `Floating-point TIFFs are not supported as label images (bitsPerSample=${ifd.bitsPerSample}). Re-export as uint8 or uint16.`
    );
  }
  if (fmt === 2) {
    throw new Error(
      "Signed-integer TIFFs are not supported as label images. Re-export as uint8 or uint16."
    );
  }
  if (ifd.bitsPerSample !== 8 && ifd.bitsPerSample !== 16) {
    throw new Error(
      `Only 8- and 16-bit unsigned label images are supported (got ${ifd.bitsPerSample}-bit). Re-export as uint16, or split into <=65535 objects.`
    );
  }
}
function dtypeName(ifd) {
  const fmt = ifd.sampleFormat ?? 1;
  const kind = fmt === 3 ? "float" : fmt === 2 ? "int" : "uint";
  return `${kind}${ifd.bitsPerSample}`;
}
function inferAxes(description, nPages) {
  if (nPages === 1) return "YX";
  if (!description) return "unknown";
  const dims = parseImageJDims(description) ?? parseOmeDims(description);
  if (!dims) return "unknown";
  return dimsToLayout(dims.c, dims.z, dims.t);
}
function dimsToLayout(c, z, t) {
  const time = Math.max(z, 1) * Math.max(t, 1);
  if (c > 1 && time <= 1) return "CYX";
  if (c <= 1 && time > 1) return "TYX";
  if (c > 1 && time > 1) return "TCYX";
  return "unknown";
}
function parseImageJDims(desc) {
  if (!/(^|\n)ImageJ=/.test(desc)) return null;
  const get = (key) => {
    const m = desc.match(new RegExp(`(?:^|\\n)${key}=(\\d+)`));
    return m ? parseInt(m[1], 10) : 1;
  };
  return { c: get("channels"), z: get("slices"), t: get("frames") };
}
function parseOmeDims(desc) {
  if (!/<\s*OME[\s>]|openmicroscopy\.org/i.test(desc)) return null;
  const pixels = desc.match(/<\s*Pixels\b[^>]*>/i);
  const attrs = pixels ? pixels[0] : desc;
  const get = (attr) => {
    const m = attrs.match(new RegExp(`${attr}\\s*=\\s*["'](\\d+)["']`, "i"));
    return m ? parseInt(m[1], 10) : 1;
  };
  return { c: get("SizeC"), z: get("SizeZ"), t: get("SizeT") };
}
function inferLabelIdsFromPages(pages) {
  const ids = [];
  for (const page of pages) {
    const positive = /* @__PURE__ */ new Set();
    for (const row of page) {
      for (const v of row) {
        if (v > 0) {
          positive.add(v);
          if (positive.size > 1) return null;
        }
      }
    }
    if (positive.size !== 1) return null;
    ids.push(positive.values().next().value);
  }
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}
function pagesCouldBeClassStack(pages) {
  for (const page of pages) {
    const positive = /* @__PURE__ */ new Set();
    for (const row of page) {
      for (const v of row) {
        if (v > 0) {
          positive.add(v);
          if (positive.size >= 2) return false;
        }
      }
    }
  }
  return true;
}
function buildTimeStack(pages, options, source) {
  return LabelImage.fromStack({
    data: pages,
    tracks: options.tracks ?? null,
    categories: options.categories ?? null,
    createTracks: options.createTracks ?? false,
    source
  });
}
function buildClassStack(pages, options, source) {
  const labelIds = inferLabelIdsFromPages(pages);
  const masks = pages.map(
    (page) => page.map((row) => row.map((v) => v > 0 ? 1 : 0))
  );
  const categories = coerceCategoriesToList(options.categories, pages.length);
  return LabelImage.fromBinaryMasks(masks, {
    labelIds: labelIds ?? void 0,
    categories: categories ?? void 0,
    source
  });
}
function coerceCategoriesToList(categories, n) {
  if (categories == null) return null;
  let list;
  if (Array.isArray(categories)) {
    list = Array.from({ length: n }, (_, i) => categories[i] ?? "");
  } else {
    list = Array.from({ length: n }, (_, i) => categories.get(i + 1) ?? "");
  }
  return list.some((c) => c !== "") ? list : null;
}
function normalizeFrames(frames, n) {
  if (frames == null) return Array.from({ length: n }, (_, i) => i);
  return frames.filter((i) => i >= 0 && i < n);
}
function pageTo2D(ifd) {
  const { width, height, data } = ifd;
  const out = new Array(height);
  for (let r = 0; r < height; r++) {
    const row = new Array(width);
    for (let c = 0; c < width; c++) row[c] = data[r * width + c];
    out[r] = row;
  }
  return out;
}
function warnAmbiguous(path, nPages, dtype) {
  const msg = `Loaded ${nPages} frames from multi-page TIFF ${path} with no axis metadata (dtype=${dtype}). Assuming pages are time. If pages represent classes for a single frame, pass pagesAs: 'classes' to route through fromBinaryMasks with categories.`;
  if (warnedMessages.has(msg)) return;
  warnedMessages.add(msg);
  console.warn(msg);
}

// src/io/csv.ts
function videoFrameCount2(video) {
  const shape = video.shape;
  if (shape && shape.length > 0 && typeof shape[0] === "number") {
    return shape[0];
  }
  return 0;
}
function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number")
    return Number.isNaN(value) ? "" : String(value);
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
function labelsToCsv(labels, options = {}) {
  const includeScore = options.includeScore ?? true;
  const includeEmpty = options.includeEmpty ?? false;
  const startFrame = options.startFrame ?? null;
  const endFrame = options.endFrame ?? null;
  let selectedVideos;
  if (options.video == null) {
    selectedVideos = labels.videos;
  } else if (typeof options.video === "number") {
    const v = labels.videos[options.video];
    if (!v) throw new Error(`Video index ${options.video} out of range.`);
    selectedVideos = [v];
  } else {
    selectedVideos = [options.video];
  }
  const videoSet = new Set(selectedVideos);
  const videoIndex = new Map(labels.videos.map((v, i) => [v, i]));
  const frames = labels.labeledFrames.filter((lf) => videoSet.has(lf.video));
  const rows = [];
  const nodeColSet = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const seenByVideo = /* @__PURE__ */ new Map();
  const seenKey = (v, f) => `${videoIndex.get(v)}:${f}`;
  for (const lf of frames) {
    if (startFrame != null && lf.frameIdx < startFrame) continue;
    if (endFrame != null && lf.frameIdx >= endFrame) continue;
    seen.add(seenKey(lf.video, lf.frameIdx));
    const byVid = seenByVideo.get(lf.video);
    if (byVid) byVid.push(lf.frameIdx);
    else seenByVideo.set(lf.video, [lf.frameIdx]);
    const instances = [...lf.userInstances, ...lf.predictedInstances];
    for (const inst of instances) {
      const predicted = inst instanceof PredictedInstance;
      const cols = /* @__PURE__ */ new Map();
      cols.set("frame_idx", lf.frameIdx);
      cols.set("track", inst.track ? inst.track.name : null);
      cols.set(
        "instance.score",
        predicted ? inst.score ?? null : null
      );
      const nodes = inst.skeleton.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const name = nodes[i].name;
        const pt = inst.points[i];
        const xKey = `${name}.x`;
        const yKey = `${name}.y`;
        cols.set(xKey, pt ? pt.xy[0] : Number.NaN);
        cols.set(yKey, pt ? pt.xy[1] : Number.NaN);
        nodeColSet.add(xKey);
        nodeColSet.add(yKey);
        if (includeScore && predicted) {
          const sKey = `${name}.score`;
          cols.set(sKey, pt?.score ?? Number.NaN);
          nodeColSet.add(sKey);
        }
      }
      rows.push({ video: lf.video, cols });
    }
  }
  if (includeEmpty && frames.length) {
    const skeleton = labels.skeletons[0];
    for (const vid of selectedVideos) {
      const emitted = seenByVideo.get(vid);
      if (!emitted || !emitted.length) continue;
      const first = startFrame != null ? startFrame : 0;
      let last;
      if (endFrame != null) {
        last = endFrame;
      } else {
        let maxIdx = emitted[0];
        for (const f of emitted) if (f > maxIdx) maxIdx = f;
        last = maxIdx + 1;
        const len = videoFrameCount2(vid);
        if (len > 0) last = Math.max(last, len);
      }
      for (let f = first; f < last; f++) {
        if (seen.has(seenKey(vid, f))) continue;
        const cols = /* @__PURE__ */ new Map();
        cols.set("frame_idx", f);
        cols.set("track", null);
        cols.set("instance.score", null);
        if (skeleton) {
          for (const node of skeleton.nodes) {
            cols.set(`${node.name}.x`, Number.NaN);
            cols.set(`${node.name}.y`, Number.NaN);
            nodeColSet.add(`${node.name}.x`);
            nodeColSet.add(`${node.name}.y`);
            if (includeScore) {
              cols.set(`${node.name}.score`, Number.NaN);
              nodeColSet.add(`${node.name}.score`);
            }
          }
        }
        rows.push({ video: vid, cols });
      }
    }
    rows.sort((a, b) => {
      const va = videoIndex.get(a.video) ?? 0;
      const vb = videoIndex.get(b.video) ?? 0;
      if (va !== vb) return va - vb;
      return a.cols.get("frame_idx") - b.cols.get("frame_idx");
    });
  }
  const nodeCols = [...nodeColSet].sort();
  const header = ["track", "frame_idx", "instance.score", ...nodeCols];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      header.map((col) => csvCell(row.cols.get(col) ?? null)).join(",")
    );
  }
  return `${lines.join("\n")}
`;
}
async function saveLabelsCsv(labels, filename, options = {}) {
  const text = labelsToCsv(labels, options);
  const bytes = new TextEncoder().encode(text);
  await nodeWriteFile(filename, bytes);
}

// src/codecs/slp/h5-compound.ts
var H5T_INTEGER = 0;
var H5T_FLOAT = 1;
var H5T_ENUM = 8;
function moduleUsable(m) {
  const mm = m;
  return !!mm && typeof mm._malloc === "function" && typeof mm._free === "function" && typeof mm.get_dataset_data === "function" && mm.HEAPU8 instanceof Uint8Array;
}
function readCompoundColumnsManual(module, dataset) {
  if (!moduleUsable(module)) return null;
  const md = dataset.metadata;
  const members = md?.compound_type?.members;
  if (!members || members.length === 0) return null;
  if (md?.vlen) return null;
  const shape = md?.shape;
  if (!Array.isArray(shape) || shape.length !== 1) return null;
  const recSize = md?.size ?? 0;
  if (recSize <= 0) return null;
  for (const m of members) {
    if (m.type !== H5T_INTEGER && m.type !== H5T_FLOAT && m.type !== H5T_ENUM) {
      return null;
    }
    if (m.type === H5T_FLOAT && m.size !== 8 && m.size !== 4) return null;
    if (m.size !== 1 && m.size !== 2 && m.size !== 4 && m.size !== 8)
      return null;
  }
  const nrows = shape[0];
  if (nrows === 0) {
    const empty = {};
    for (const m of members) empty[m.name] = [];
    return empty;
  }
  const nbytes = recSize * nrows;
  const dataPtr = module._malloc(nbytes);
  if (!dataPtr) return null;
  let buf;
  try {
    module.get_dataset_data(
      dataset.file_id,
      dataset.path,
      [BigInt(nrows)],
      [0n],
      [1n],
      BigInt(dataPtr)
    );
    buf = module.HEAPU8.slice(dataPtr, dataPtr + nbytes);
  } finally {
    module._free(dataPtr);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cols = {};
  for (const m of members) {
    const col = new Array(nrows);
    const off = m.offset;
    const sz = m.size;
    const isFloat = m.type === H5T_FLOAT;
    const signed = m.signed !== false;
    const le = m.littleEndian !== false;
    for (let i = 0; i < nrows; i += 1) {
      const p = i * recSize + off;
      let v;
      if (isFloat) {
        v = sz === 8 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
      } else if (sz === 1) {
        v = signed ? dv.getInt8(p) : dv.getUint8(p);
      } else if (sz === 2) {
        v = signed ? dv.getInt16(p, le) : dv.getUint16(p, le);
      } else if (sz === 4) {
        v = signed ? dv.getInt32(p, le) : dv.getUint32(p, le);
      } else {
        v = Number(signed ? dv.getBigInt64(p, le) : dv.getBigUint64(p, le));
      }
      col[i] = v;
    }
    cols[m.name] = col;
  }
  return cols;
}

// src/codecs/slp/read.ts
import { inflate } from "pako";
var textDecoder2 = new TextDecoder();
var EAGER_STAGES = [
  "Reading metadata",
  "Reading tracks",
  "Reading videos",
  "Reading suggestions",
  "Building labeled frames",
  "Reading identities",
  "Reading sessions",
  "Reading annotations"
];
async function readSlp(source, options) {
  const total = EAGER_STAGES.length;
  const onProgress = options?.onProgress;
  const report = (i) => onProgress?.(i, total, EAGER_STAGES[i]);
  const { file, close } = await openH5File(source, options?.h5);
  const remote = {
    urlHeaders: options?.h5?.headers
  };
  try {
    report(0);
    const labelsPath = typeof source === "string" ? source : options?.h5?.filenameHint ?? "slp-data.slp";
    const metadataGroup = file.get("metadata");
    if (!metadataGroup) {
      throw missingMetadataJsonError(labelsPath);
    }
    const metadataAttrs = metadataGroup.attrs ?? {};
    const formatId = Number(
      metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1
    );
    const metadataJson = parseMetadataJson(
      metadataAttrs["json"],
      labelsPath
    );
    const skeletons = parseSkeletons(metadataJson);
    report(1);
    const tracks = readTracks(file.get("tracks_json"));
    const videoCrops = readVideoCrops(file);
    report(2);
    const openVideos = options?.openVideos ?? true;
    const videos = await readVideos(
      file.get("videos_json"),
      labelsPath,
      openVideos,
      file,
      formatId,
      videoCrops,
      openVideos ? (i, n) => onProgress?.(2, total, `Opening videos (${i}/${n})`) : void 0,
      remote
    );
    report(3);
    const suggestions = readSuggestions(file.get("suggestions_json"), videos);
    report(4);
    const emscripten = await getH5EmscriptenModule();
    const framesData = normalizeStructDataset(file.get("frames"), emscripten);
    const instancesData = normalizeStructDataset(
      file.get("instances"),
      emscripten
    );
    const pointsData = normalizeStructDataset(file.get("points"), emscripten);
    const predPointsData = normalizeStructDataset(
      file.get("pred_points"),
      emscripten
    );
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
    report(5);
    const identities = readIdentities(file.get("identities_json"));
    report(6);
    const sessions = readSessions(
      file.get("sessions_json"),
      videos,
      skeletons,
      identities,
      options?.rawSessions ?? false
    );
    report(7);
    const allInstances = labeledFrames.flatMap((f) => f.instances);
    const { rois: roiTuples, bboxes: bboxTuples } = readRoisAndBboxes(
      file,
      videos,
      tracks,
      allInstances
    );
    const maskTuples = readMasks(file, videos, tracks);
    const centroidTuples = readCentroids(file, videos, tracks);
    const labelImageTuples = readLabelImages(
      file,
      videos,
      tracks,
      allInstances
    );
    const frameMap = /* @__PURE__ */ new Map();
    for (const lf of labeledFrames) {
      const vidIdx = videos.indexOf(lf.video);
      frameMap.set(`${vidIdx}:${lf.frameIdx}`, lf);
    }
    const getOrCreateFrame = (vidIdx, frameIdx) => {
      const key = `${vidIdx}:${frameIdx}`;
      let lf = frameMap.get(key);
      if (!lf) {
        lf = new LabeledFrame({ video: videos[vidIdx], frameIdx });
        frameMap.set(key, lf);
        labeledFrames.push(lf);
      }
      return lf;
    };
    const staticRois = [];
    const distributeTuples = (tuples, push) => {
      for (const [ann, vidIdx, frameIdx] of tuples) {
        if (vidIdx >= 0 && vidIdx < videos.length && frameIdx >= 0) {
          push(getOrCreateFrame(vidIdx, frameIdx), ann);
        }
      }
    };
    for (const [roi, vidIdx, frameIdx] of roiTuples) {
      if (vidIdx >= 0 && vidIdx < videos.length && frameIdx >= 0) {
        getOrCreateFrame(vidIdx, frameIdx).rois.push(roi);
      } else {
        staticRois.push(roi);
      }
    }
    distributeTuples(bboxTuples, (lf, b) => lf.bboxes.push(b));
    distributeTuples(maskTuples, (lf, m) => lf.masks.push(m));
    distributeTuples(centroidTuples, (lf, c) => lf.centroids.push(c));
    distributeTuples(labelImageTuples, (lf, li) => lf.labelImages.push(li));
    const allInstancesFlat = labeledFrames.flatMap((lf) => lf.instances);
    const resolveInstanceRef = (ann) => {
      if (ann._instanceIdx !== null && ann._instanceIdx >= 0 && ann._instanceIdx < allInstancesFlat.length) {
        ann.instance = allInstancesFlat[ann._instanceIdx];
        ann._instanceIdx = null;
      }
    };
    for (const lf of labeledFrames) {
      for (const b of lf.bboxes) resolveInstanceRef(b);
      for (const c of lf.centroids) resolveInstanceRef(c);
      for (const m of lf.masks) resolveInstanceRef(m);
      for (const r of lf.rois) resolveInstanceRef(r);
      for (const li of lf.labelImages) {
        if (li._objectInstanceIdxs) {
          for (const [labelId, instIdx] of li._objectInstanceIdxs) {
            const obj = li.objects.get(labelId);
            if (obj && instIdx >= 0 && instIdx < allInstancesFlat.length) {
              obj.instance = allInstancesFlat[instIdx];
            }
          }
          li._objectInstanceIdxs = null;
        }
      }
    }
    onProgress?.(total, total, "Finalizing");
    const labels = new Labels({
      labeledFrames,
      videos,
      skeletons,
      tracks,
      suggestions,
      sessions,
      identities,
      provenance: metadataJson?.provenance ?? {},
      rois: staticRois
    });
    injectSessionFrameResolver(labels);
    return labels;
  } finally {
    close();
  }
}
var LAZY_STAGES = [
  "Reading metadata",
  "Reading tracks",
  "Reading videos",
  "Reading suggestions",
  "Reading frame data",
  "Reading identities",
  "Reading sessions",
  "Reading annotations"
];
async function readSlpLazy(source, options) {
  const total = LAZY_STAGES.length;
  const onProgress = options?.onProgress;
  const report = (i) => onProgress?.(i, total, LAZY_STAGES[i]);
  const { file, close } = await openH5File(source, options?.h5);
  const remote = {
    urlHeaders: options?.h5?.headers
  };
  try {
    report(0);
    const labelsPath = typeof source === "string" ? source : options?.h5?.filenameHint ?? "slp-data.slp";
    const metadataGroup = file.get("metadata");
    if (!metadataGroup) {
      throw missingMetadataJsonError(labelsPath);
    }
    const metadataAttrs = metadataGroup.attrs ?? {};
    const formatId = Number(
      metadataAttrs["format_id"]?.value ?? metadataAttrs["format_id"] ?? 1
    );
    const metadataJson = parseMetadataJson(
      metadataAttrs["json"],
      labelsPath
    );
    const skeletons = parseSkeletons(metadataJson);
    report(1);
    const tracks = readTracks(file.get("tracks_json"));
    const videoCrops = readVideoCrops(file);
    report(2);
    const openVideos = options?.openVideos ?? true;
    const videos = await readVideos(
      file.get("videos_json"),
      labelsPath,
      openVideos,
      file,
      formatId,
      videoCrops,
      openVideos ? (i, n) => onProgress?.(2, total, `Opening videos (${i}/${n})`) : void 0,
      remote
    );
    report(3);
    const suggestions = readSuggestions(file.get("suggestions_json"), videos);
    report(4);
    const emscripten = await getH5EmscriptenModule();
    const framesData = normalizeStructDataset(file.get("frames"), emscripten);
    const instancesData = normalizeStructDataset(
      file.get("instances"),
      emscripten
    );
    const pointsData = normalizeStructDataset(file.get("points"), emscripten);
    const predPointsData = normalizeStructDataset(
      file.get("pred_points"),
      emscripten
    );
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
    report(5);
    const identities = readIdentities(file.get("identities_json"));
    report(6);
    const sessions = readSessions(
      file.get("sessions_json"),
      videos,
      skeletons,
      identities,
      options?.rawSessions ?? false
    );
    report(7);
    const { rois: roiTuples, bboxes: bboxTuples } = readRoisAndBboxes(
      file,
      videos,
      tracks
    );
    const maskTuples = readMasks(file, videos, tracks);
    const centroidTuples = readCentroids(file, videos, tracks);
    const labelImageTuples = readLabelImages(file, videos, tracks);
    const buildAnnByFrame = (tuples) => {
      const byFrame = /* @__PURE__ */ new Map();
      const undistributed = [];
      for (const [ann, vidIdx, frameIdx] of tuples) {
        if (vidIdx >= 0 && frameIdx >= 0) {
          const key = `${vidIdx}:${frameIdx}`;
          const list = byFrame.get(key);
          if (list) list.push(ann);
          else byFrame.set(key, [ann]);
        } else {
          undistributed.push(ann);
        }
      }
      return { byFrame, undistributed };
    };
    const cResult = buildAnnByFrame(centroidTuples);
    const bResult = buildAnnByFrame(bboxTuples);
    const mResult = buildAnnByFrame(maskTuples);
    const rResult = buildAnnByFrame(roiTuples);
    const liResult = buildAnnByFrame(labelImageTuples);
    store._centroidByFrame = cResult.byFrame;
    store._bboxByFrame = bResult.byFrame;
    store._maskByFrame = mResult.byFrame;
    store._roiByFrame = rResult.byFrame;
    store._labelImageByFrame = liResult.byFrame;
    store._undistributedCentroids = cResult.undistributed;
    store._undistributedBboxes = bResult.undistributed;
    store._undistributedMasks = mResult.undistributed;
    store._undistributedRois = rResult.undistributed;
    store._undistributedLabelImages = liResult.undistributed;
    const frameKeys = /* @__PURE__ */ new Set();
    const frameVideoIds = framesData.video ?? [];
    const frameFrameIdxs = framesData.frame_idx ?? [];
    for (let i = 0; i < (framesData.frame_id ?? []).length; i++) {
      frameKeys.add(`${Number(frameVideoIds[i])}:${Number(frameFrameIdxs[i])}`);
    }
    const allAnnKeys = /* @__PURE__ */ new Set();
    for (const dict of [
      store._centroidByFrame,
      store._bboxByFrame,
      store._maskByFrame,
      store._labelImageByFrame,
      store._roiByFrame
    ]) {
      for (const key of dict.keys()) allAnnKeys.add(key);
    }
    for (const key of [...allAnnKeys].sort()) {
      if (frameKeys.has(key)) continue;
      const [vidIdxStr, fidxStr] = key.split(":");
      const vidIdx = Number(vidIdxStr);
      const fidx = Number(fidxStr);
      if (vidIdx >= 0 && vidIdx < videos.length) {
        lazyFrames._supplementary.push(
          new LabeledFrame({
            video: videos[vidIdx],
            frameIdx: fidx,
            centroids: store._centroidByFrame.get(key) ?? [],
            bboxes: store._bboxByFrame.get(key) ?? [],
            masks: store._maskByFrame.get(key) ?? [],
            labelImages: store._labelImageByFrame.get(key) ?? [],
            rois: store._roiByFrame.get(key) ?? []
          })
        );
      }
    }
    const labels = new Labels({
      videos,
      skeletons,
      tracks,
      suggestions,
      sessions,
      identities,
      provenance: metadataJson?.provenance ?? {}
    });
    labels._lazyFrameList = lazyFrames;
    labels._lazyDataStore = store;
    injectSessionFrameResolver(labels);
    onProgress?.(total, total, "Finalizing");
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
function readVideoCrops(file) {
  const out = /* @__PURE__ */ new Map();
  const keys = file.keys?.() ?? [];
  if (!keys.includes("video_crops")) return out;
  const ds = file.get("video_crops");
  if (!ds) return out;
  let raw = ds.value;
  if (Array.isArray(raw)) raw = raw[0];
  let json;
  if (typeof raw === "string") {
    json = raw;
  } else if (raw instanceof Uint8Array) {
    json = textDecoder2.decode(raw);
  } else if (raw != null) {
    json = String(raw);
  } else {
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const videoIdx = Number(entry.video);
    const cropArr = entry.crop;
    if (!Array.isArray(cropArr) || cropArr.length !== 4) continue;
    const crop = [
      Number(cropArr[0]),
      Number(cropArr[1]),
      Number(cropArr[2]),
      Number(cropArr[3])
    ];
    const fillRaw = entry.fill;
    const fill = Array.isArray(fillRaw) ? fillRaw.map((v) => Number(v)) : Number(fillRaw ?? 0);
    out.set(videoIdx, { crop, fill });
  }
  return out;
}
async function readVideos(dataset, labelsPath, openVideos, file, formatId, videoCrops, onVideoProgress, remote) {
  if (!dataset) return [];
  const urlHeaders = remote?.urlHeaders;
  const values = dataset.value ?? [];
  const videos = [];
  for (let videoIndex = 0; videoIndex < values.length; videoIndex++) {
    onVideoProgress?.(videoIndex + 1, values.length);
    const entry = values[videoIndex];
    if (!entry) continue;
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder2.decode(entry));
    const backendMeta = parsed.backend ?? {};
    let filename = resolveVideoFilename(backendMeta, parsed);
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
    let frameCountFromAttrs;
    let heightFromAttrs;
    let widthFromAttrs;
    let channelsFromAttrs;
    if (datasetPath) {
      const videoDs = file.get(datasetPath);
      if (videoDs) {
        const attrs = videoDs.attrs ?? {};
        if (!format) {
          format = attrToString(attrs.format);
        }
        channelOrderFromAttrs = attrToString(attrs.channel_order);
        const framesNum = attrToNumber(attrs.frames);
        if (framesNum !== void 0 && framesNum > 0) {
          frameCountFromAttrs = framesNum;
        }
        const h = attrToNumber(attrs.height);
        if (h !== void 0 && h > 0) heightFromAttrs = h;
        const w = attrToNumber(attrs.width);
        if (w !== void 0 && w > 0) widthFromAttrs = w;
        const c = attrToNumber(attrs.channels);
        if (c !== void 0 && c > 0) channelsFromAttrs = c;
      }
    }
    const frameNumbers = datasetPath ? readFrameNumbers(file, datasetPath) : [];
    const jsonShape = backendMeta.shape;
    const height = jsonShape?.[1] ?? heightFromAttrs;
    const width = jsonShape?.[2] ?? widthFromAttrs;
    const channels = jsonShape?.[3] ?? channelsFromAttrs;
    const frameCount = resolveSourceFrameCount({
      framesAttr: frameCountFromAttrs,
      jsonFrameCount: jsonShape?.[0],
      frameNumbers
    });
    const shape = height && width && channels ? [frameCount ?? 0, height, width, channels] : void 0;
    const channelOrder = backendMeta.channel_order ?? channelOrderFromAttrs ?? (formatId < 1.4 ? "BGR" : "RGB");
    let backend = null;
    let backendError = null;
    if (openVideos) {
      try {
        backend = await createVideoBackend(filename, {
          dataset: datasetPath ?? void 0,
          embedded,
          frameNumbers,
          frameSizes: readFrameSizes(file, datasetPath),
          format,
          channelOrder,
          shape,
          fps: backendMeta.fps,
          // Persist the remote `.slp` auth headers onto remote/embedded video
          // backends so reopens / existence probes stay authenticated. The
          // factory only uses them for URL-backed backends; embedded/local
          // backends ignore them.
          headers: urlHeaders
        });
      } catch (err) {
        backend = null;
        backendError = {
          kind: err instanceof UnsupportedVideoFormatError ? "unsupported-format" : isImageSource(filename) ? "image-sequence" : "decode",
          message: err instanceof Error ? err.message : String(err)
        };
      }
    }
    const sourceVideo = parsed.source_video ? new Video({ filename: parsed.source_video.filename ?? "" }) : null;
    const cropEntry = videoCrops?.get(videoIndex);
    let backendMetadata = shape !== backendMeta.shape ? { ...backendMeta, shape } : backendMeta;
    if (cropEntry) {
      const [cx1, cy1, cx2, cy2] = cropEntry.crop;
      if (openVideos && backend) {
        backend = CropVideoBackend.wrap({
          inner: backend,
          crop: cropEntry.crop,
          fill: cropEntry.fill
          // ownsInner: true (default) — see comment above.
        });
      }
      backendMetadata = { ...backendMetadata };
      const innerShape = backendMetadata.shape;
      if (innerShape && innerShape.length === 4) {
        backendMetadata.source_shape = [...innerShape];
        backendMetadata.shape = [
          innerShape[0],
          cy2 - cy1,
          cx2 - cx1,
          innerShape[3]
        ];
      }
      backendMetadata.crop = [...cropEntry.crop];
      backendMetadata.crop_fill = cropEntry.fill;
    }
    const video = new Video({
      filename,
      backend,
      backendError,
      backendMetadata,
      sourceVideo,
      openBackend: openVideos,
      embedded
    });
    if (urlHeaders) {
      video._setUrlPersistence({ headers: urlHeaders });
    }
    videos.push(video);
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
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder2.decode(entry));
    const videoIndex = Number(parsed.video ?? 0);
    const video = videos[videoIndex];
    if (!video) continue;
    suggestions.push(
      new SuggestionFrame({
        video,
        frameIdx: parsed.frame_idx ?? parsed.frameIdx ?? 0,
        group: parsed.group != null ? String(parsed.group) : void 0,
        metadata: parsed
      })
    );
  }
  return suggestions;
}
function readIdentities(dataset) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const identities = [];
  for (const entry of values) {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder2.decode(entry));
    const { name, color, ...rest } = parsed;
    identities.push(
      new Identity({
        name: name ?? "",
        color: color ?? void 0,
        metadata: rest
      })
    );
  }
  return identities;
}
function readSessions(dataset, videos, skeletons, identities, captureRaw = false) {
  if (!dataset) return [];
  const values = dataset.value ?? [];
  const sessions = [];
  for (const entry of values) {
    const parsed = typeof entry === "string" ? JSON.parse(entry) : JSON.parse(textDecoder2.decode(entry));
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
    cameraGroup.metadata = calibration.metadata ?? {};
    const session = new RecordingSession({
      cameraGroup,
      metadata: parsed.metadata ?? {}
    });
    if (captureRaw) session.rawJson = structuredClone(parsed);
    const map = asRecord(parsed.camcorder_to_video_idx_map);
    for (const [cameraKey, videoIdx] of Object.entries(map)) {
      const camera = resolveCameraKey(
        cameraKey,
        cameraMap,
        cameraGroup.cameras
      );
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
        let instanceByCamera;
        const instancesRecord = asRecord(instanceGroupRecord.instances);
        for (const [cameraKey, points] of Object.entries(instancesRecord)) {
          const camera = resolveCameraKey(
            cameraKey,
            cameraMap,
            cameraGroup.cameras
          );
          if (!camera) {
            console.warn(
              `Camera key "${cameraKey}" not found in session calibration \u2014 skipping 2D instance data for this camera.`
            );
            continue;
          }
          const skeleton = skeletons[0] ?? new Skeleton({ nodes: [] });
          if (!instanceByCamera) instanceByCamera = /* @__PURE__ */ new Map();
          instanceByCamera.set(
            camera,
            new Instance({
              points,
              skeleton
            })
          );
        }
        let instanceRefsByCamera;
        const lfInstMap = asRecord(
          instanceGroupRecord.camcorder_to_lf_and_inst_idx_map
        );
        for (const [camIdx, value] of Object.entries(lfInstMap)) {
          const camera = resolveCameraKey(
            camIdx,
            cameraMap,
            cameraGroup.cameras
          );
          if (!camera) continue;
          const pair = value;
          if (!instanceRefsByCamera)
            instanceRefsByCamera = /* @__PURE__ */ new Map();
          instanceRefsByCamera.set(camera, [Number(pair[0]), Number(pair[1])]);
        }
        const instance3d = reconstructInstance3D(
          instanceGroupRecord,
          skeletons
        );
        const identity = resolveIdentity(instanceGroupRecord, identities);
        instanceGroups.push(
          new InstanceGroup({
            instanceByCamera,
            instanceRefsByCamera,
            score: instanceGroupRecord.score,
            instance3d,
            identity,
            metadata: instanceGroupRecord.metadata ?? {}
          })
        );
      }
      let labeledFrameRefsByCamera;
      const labeledFrameMap = asRecord(groupRecord.labeled_frame_by_camera);
      for (const [cameraKey, labeledFrameIdx] of Object.entries(
        labeledFrameMap
      )) {
        const camera = resolveCameraKey(
          cameraKey,
          cameraMap,
          cameraGroup.cameras
        );
        if (!camera) {
          console.warn(
            `Camera key "${cameraKey}" not found in session calibration \u2014 skipping labeled frame mapping.`
          );
          continue;
        }
        if (!labeledFrameRefsByCamera)
          labeledFrameRefsByCamera = /* @__PURE__ */ new Map();
        labeledFrameRefsByCamera.set(camera, Number(labeledFrameIdx));
      }
      if (!labeledFrameRefsByCamera) {
        for (const instanceGroup of instanceGroupList) {
          const igRecord = asRecord(instanceGroup);
          const lfInstMap = asRecord(igRecord.camcorder_to_lf_and_inst_idx_map);
          for (const [camIdx, value] of Object.entries(lfInstMap)) {
            const camera = resolveCameraKey(
              camIdx,
              cameraMap,
              cameraGroup.cameras
            );
            if (!camera) continue;
            const pair = value;
            if (!labeledFrameRefsByCamera)
              labeledFrameRefsByCamera = /* @__PURE__ */ new Map();
            labeledFrameRefsByCamera.set(camera, Number(pair[0]));
          }
        }
      }
      session.frameGroups.set(
        Number(frameIdx),
        new FrameGroup({
          frameIdx: Number(frameIdx),
          instanceGroups,
          labeledFrameRefsByCamera,
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
      return JSON.parse(textDecoder2.decode(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.map(String);
  return [];
}
function readRoisAndBboxes(file, videos, tracks, instances) {
  const { rois, migratedBboxes } = readRoisWithMigration(
    file,
    videos,
    tracks,
    instances
  );
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
  const categories = readStringMetadata(
    file,
    "roi_categories",
    roisDs,
    "categories"
  );
  const names = readStringMetadata(file, "roi_names", roisDs, "names");
  const sources = readStringMetadata(file, "roi_sources", roisDs, "sources");
  const videoIndices = roisData.video ?? [];
  const frameIndices = roisData.frame_idx ?? [];
  const trackIndices = roisData.track ?? [];
  const scores = roisData.score ?? [];
  const wkbStarts = roisData.wkb_start ?? [];
  const wkbEnds = roisData.wkb_end ?? [];
  const instanceIndices = roisData.instance ?? [];
  const isPredictedCol = roisData.is_predicted ?? [];
  const trackingScoresCol = roisData.tracking_score ?? [];
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
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const annotType = Number(annotationTypes[i]);
    const isPred = isPredictedCol.length > i ? Number(isPredictedCol[i]) === 1 : false;
    const roiTsVal = trackingScoresCol.length > i ? Number(trackingScoresCol[i]) : Number.NaN;
    const roiTrackingScore = Number.isNaN(roiTsVal) ? null : roiTsVal;
    if (annotType === 1 /* BOUNDING_BOX */ && !isPred) {
      const tmpRoi = new UserROI({
        geometry,
        name: names[i] ?? "",
        category: categories[i] ?? "",
        source: sources[i] ?? "",
        video,
        track
      });
      const b = tmpRoi.bounds;
      const scoreVal = Number(scores[i]);
      const bboxScore = Number.isNaN(scoreVal) ? null : scoreVal;
      const bboxOptions = {
        x1: b.minX,
        y1: b.minY,
        x2: b.maxX,
        y2: b.maxY,
        track,
        trackingScore: roiTrackingScore,
        category: categories[i] ?? "",
        name: names[i] ?? "",
        source: sources[i] ?? ""
      };
      let bbox;
      if (bboxScore !== null) {
        bbox = new PredictedBoundingBox({ ...bboxOptions, score: bboxScore });
      } else {
        bbox = new UserBoundingBox(bboxOptions);
      }
      if (instanceIndices.length > 0) {
        const instIdx = Number(instanceIndices[i]);
        if (instances && instIdx >= 0 && instIdx < instances.length) {
          bbox.instance = instances[instIdx];
        } else if (instIdx >= 0) {
          bbox._instanceIdx = instIdx;
        }
      }
      migratedBboxes.push([bbox, videoIdx, frameIdxVal]);
    } else {
      const roiOptions = {
        geometry,
        name: names[i] ?? "",
        category: categories[i] ?? "",
        source: sources[i] ?? "",
        video,
        track,
        trackingScore: roiTrackingScore
      };
      let roi;
      if (isPred) {
        const scoreVal = Number(scores[i]);
        roi = new PredictedROI({
          ...roiOptions,
          score: Number.isNaN(scoreVal) ? 0 : scoreVal
        });
      } else {
        roi = new UserROI(roiOptions);
      }
      if (instanceIndices.length > 0) {
        const instIdx = Number(instanceIndices[i]);
        if (instances && instIdx >= 0 && instIdx < instances.length) {
          roi.instance = instances[instIdx];
        } else if (instIdx >= 0) {
          roi._instanceIdx = instIdx;
        }
      }
      rois.push([roi, videoIdx, frameIdxVal]);
    }
  }
  return { rois, migratedBboxes };
}
function readBboxes(file, _videos, tracks) {
  const bboxesDs = file.get("bboxes");
  if (!bboxesDs) return [];
  const bboxesData = normalizeStructDataset(bboxesDs);
  const xCenters = bboxesData.x_center ?? [];
  const isLegacy = xCenters.length > 0;
  const x1s = bboxesData.x1 ?? [];
  const count = isLegacy ? xCenters.length : x1s.length;
  if (!count) return [];
  const categories = readStringMetadata(
    file,
    "bbox_categories",
    bboxesDs,
    "categories"
  );
  const names = readStringMetadata(file, "bbox_names", bboxesDs, "names");
  const sources = readStringMetadata(file, "bbox_sources", bboxesDs, "sources");
  const yCenters = bboxesData.y_center ?? [];
  const widths = bboxesData.width ?? [];
  const heights = bboxesData.height ?? [];
  const y1s = bboxesData.y1 ?? [];
  const x2s = bboxesData.x2 ?? [];
  const y2s = bboxesData.y2 ?? [];
  const angles = bboxesData.angle ?? [];
  const videoIndices = bboxesData.video ?? [];
  const frameIndices = bboxesData.frame_idx ?? [];
  const trackIndices = bboxesData.track ?? [];
  const bboxScores = bboxesData.score ?? [];
  const instanceIndices = bboxesData.instance ?? [];
  const trackingScores = bboxesData.tracking_score ?? [];
  const bboxes = [];
  for (let i = 0; i < count; i++) {
    const videoIdx = Number(videoIndices[i]);
    const frameIdxVal = Number(frameIndices[i]);
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const scoreVal = Number(bboxScores[i]);
    const instanceIdx = Number(instanceIndices[i]);
    let bx1, by1, bx2, by2;
    if (isLegacy) {
      const cx = Number(xCenters[i]);
      const cy = Number(yCenters[i]);
      const w = Number(widths[i]);
      const h = Number(heights[i]);
      bx1 = cx - w / 2;
      by1 = cy - h / 2;
      bx2 = cx + w / 2;
      by2 = cy + h / 2;
    } else {
      bx1 = Number(x1s[i]);
      by1 = Number(y1s[i]);
      bx2 = Number(x2s[i]);
      by2 = Number(y2s[i]);
    }
    const tsVal = trackingScores.length > i ? Number(trackingScores[i]) : Number.NaN;
    const trackingScore = Number.isNaN(tsVal) ? null : tsVal;
    const options = {
      x1: bx1,
      y1: by1,
      x2: bx2,
      y2: by2,
      angle: Number(angles[i]),
      track,
      trackingScore,
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
    bboxes.push([bbox, videoIdx, frameIdxVal]);
  }
  return bboxes;
}
function readStringMetadata(file, datasetPath, dataset, attrName) {
  const ds = file.get(datasetPath);
  if (ds) {
    const jsonAttr = readAttrString(ds, "json");
    if (jsonAttr.length > 0) return jsonAttr;
    const val = ds.value;
    if (Array.isArray(val)) {
      return val.map((v) => typeof v === "string" ? v : String(v ?? ""));
    }
  }
  return readAttrString(dataset, attrName);
}
function readScoreMaps(file, indexPath, dataPath) {
  const result = /* @__PURE__ */ new Map();
  const indexDs = file.get(indexPath);
  const dataDs = file.get(dataPath);
  if (!indexDs || !dataDs) return result;
  const indexData = normalizeStructDataset(indexDs);
  const idxCol = indexData.mask_idx ?? indexData.li_idx ?? [];
  const starts = indexData.data_start ?? [];
  const ends = indexData.data_end ?? [];
  const smHeights = indexData.height ?? [];
  const smWidths = indexData.width ?? [];
  const dataFlat = dataDs.value instanceof Uint8Array ? dataDs.value : new Uint8Array(dataDs.value ?? []);
  for (let i = 0; i < idxCol.length; i++) {
    const annotIdx = Number(idxCol[i]);
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    const h = Number(smHeights[i]);
    const w = Number(smWidths[i]);
    const compressed = dataFlat.slice(start, end);
    const decompressed = inflate(compressed);
    const expectedBytes = h * w * 4;
    if (decompressed.byteLength !== expectedBytes) {
      throw new Error(
        `Score map decompression size mismatch: expected ${expectedBytes} bytes, got ${decompressed.byteLength}`
      );
    }
    const scoreMap = new Float32Array(
      decompressed.buffer.slice(
        decompressed.byteOffset,
        decompressed.byteOffset + decompressed.byteLength
      )
    );
    result.set(annotIdx, { scoreMap, height: h, width: w });
  }
  return result;
}
function readMasks(file, _videos, tracks) {
  const masksDs = file.get("masks");
  if (!masksDs) return [];
  const masksData = normalizeStructDataset(masksDs);
  const heights = masksData.height ?? [];
  if (!heights.length) return [];
  const rleDs = file.get("mask_rle");
  if (!rleDs) return [];
  const rleFlat = rleDs.value instanceof Uint8Array ? rleDs.value : new Uint8Array(rleDs.value ?? []);
  const categories = readStringMetadata(
    file,
    "mask_categories",
    masksDs,
    "categories"
  );
  const names = readStringMetadata(file, "mask_names", masksDs, "names");
  const sources = readStringMetadata(file, "mask_sources", masksDs, "sources");
  const widths = masksData.width ?? [];
  const videoIndices = masksData.video ?? [];
  const frameIndices = masksData.frame_idx ?? [];
  const trackIndices = masksData.track ?? [];
  const rleStarts = masksData.rle_start ?? [];
  const rleEnds = masksData.rle_end ?? [];
  const isPredictedCol = masksData.is_predicted ?? [];
  const scoreCol = masksData.score ?? [];
  const instanceCol = masksData.instance ?? [];
  const maskTrackingScoreCol = masksData.tracking_score ?? [];
  const fromPredictedCol = masksData.from_predicted ?? [];
  const scaleXCol = masksData.scale_x ?? [];
  const scaleYCol = masksData.scale_y ?? [];
  const offsetXCol = masksData.offset_x ?? [];
  const offsetYCol = masksData.offset_y ?? [];
  const scoreMaps = readScoreMaps(
    file,
    "mask_score_map_index",
    "mask_score_maps"
  );
  const masks = [];
  const fromPredictedPairs = [];
  for (let i = 0; i < heights.length; i++) {
    const rleStart = Number(rleStarts[i]);
    const rleEnd = Number(rleEnds[i]);
    const rleRaw = rleFlat.slice(rleStart, rleEnd);
    const numCounts = rleRaw.byteLength / 4;
    const rleCounts = new Uint32Array(numCounts);
    const rleView = new DataView(
      rleRaw.buffer,
      rleRaw.byteOffset,
      rleRaw.byteLength
    );
    for (let j = 0; j < numCounts; j++) {
      rleCounts[j] = rleView.getUint32(j * 4, true);
    }
    const videoIdx = Number(videoIndices[i]);
    const frameIdxVal = Number(frameIndices[i]);
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const scaleX = scaleXCol.length > i ? Number(scaleXCol[i]) : 1;
    const scaleY = scaleYCol.length > i ? Number(scaleYCol[i]) : 1;
    const offsetX = offsetXCol.length > i ? Number(offsetXCol[i]) : 0;
    const offsetY = offsetYCol.length > i ? Number(offsetYCol[i]) : 0;
    const maskTsVal = maskTrackingScoreCol.length > i ? Number(maskTrackingScoreCol[i]) : Number.NaN;
    const maskTrackingScore = Number.isNaN(maskTsVal) ? null : maskTsVal;
    const baseOptions = {
      rleCounts,
      height: Number(heights[i]),
      width: Number(widths[i]),
      name: names[i] ?? "",
      category: categories[i] ?? "",
      source: sources[i] ?? "",
      track,
      trackingScore: maskTrackingScore,
      scale: [scaleX, scaleY],
      offset: [offsetX, offsetY]
    };
    const isPred = isPredictedCol.length > i ? Number(isPredictedCol[i]) === 1 : false;
    let mask;
    if (isPred) {
      const scoreVal = scoreCol.length > i ? Number(scoreCol[i]) : 0;
      const sm = scoreMaps.get(i);
      mask = new PredictedSegmentationMask({
        ...baseOptions,
        score: scoreVal,
        scoreMap: sm?.scoreMap ?? null
      });
    } else {
      mask = new UserSegmentationMask(baseOptions);
      const fpIdx = fromPredictedCol.length > i ? Number(fromPredictedCol[i]) : -1;
      if (fpIdx >= 0) fromPredictedPairs.push([i, fpIdx]);
    }
    const instIdx = instanceCol.length > i ? Number(instanceCol[i]) : -1;
    if (instIdx >= 0) {
      mask._instanceIdx = instIdx;
    }
    masks.push([mask, videoIdx, frameIdxVal]);
  }
  for (const [i, fpIdx] of fromPredictedPairs) {
    if (fpIdx >= 0 && fpIdx < masks.length) {
      masks[i][0].fromPredicted = masks[fpIdx][0];
    }
  }
  return masks;
}
function readLabelImages(file, _videos, tracks, instances) {
  const liDs = file.get("label_images");
  if (!liDs) return [];
  const liData = normalizeStructDataset(liDs);
  const videoIndices = liData.video ?? [];
  if (!videoIndices.length) return [];
  const frameIndices = liData.frame_idx ?? [];
  const heights = liData.height ?? [];
  const widths = liData.width ?? [];
  const nObjectsList = liData.n_objects ?? [];
  const objectsStarts = liData.objects_start ?? [];
  const dataStarts = liData.data_start ?? [];
  const dataEnds = liData.data_end ?? [];
  const sources = readStringMetadata(
    file,
    "label_image_sources",
    liDs,
    "sources"
  );
  const isPredictedCol = liData.is_predicted ?? [];
  const liScoreCol = liData.score ?? [];
  const liScaleXCol = liData.scale_x ?? [];
  const liScaleYCol = liData.scale_y ?? [];
  const liOffsetXCol = liData.offset_x ?? [];
  const liOffsetYCol = liData.offset_y ?? [];
  const dataDs = file.get("label_image_data");
  if (!dataDs) return [];
  const dataShape = dataDs.shape ?? [];
  const isChunked = dataShape.length === 3;
  let dataFlat = new Uint8Array(0);
  let dataChunked = null;
  if (isChunked) {
    dataChunked = dataDs.value;
  } else {
    dataFlat = dataDs.value instanceof Uint8Array ? dataDs.value : new Uint8Array(dataDs.value ?? []);
  }
  let objLabelIds = [];
  let objTrackIndices = [];
  let objInstanceIndices = [];
  let objCategories = [];
  let objNames = [];
  let objScoreCol = [];
  let objTrackingScoreCol = [];
  const objDs = file.get("label_image_objects");
  if (objDs) {
    const objData = normalizeStructDataset(objDs);
    objLabelIds = objData.label_id ?? [];
    objTrackIndices = objData.track ?? [];
    objInstanceIndices = objData.instance ?? [];
    objCategories = readStringMetadata(
      file,
      "label_image_obj_categories",
      objDs,
      "categories"
    );
    objNames = readStringMetadata(
      file,
      "label_image_obj_names",
      objDs,
      "names"
    );
    objScoreCol = objData.score ?? [];
    objTrackingScoreCol = objData.tracking_score ?? [];
  }
  const liScoreMaps = readScoreMaps(
    file,
    "label_image_score_map_index",
    "label_image_score_maps"
  );
  const labelImages = [];
  for (let i = 0; i < videoIndices.length; i++) {
    const videoIdx = Number(videoIndices[i]);
    const frameIdxVal = Number(frameIndices[i]);
    const height = Number(heights[i]);
    const width = Number(widths[i]);
    let pixelData;
    if (isChunked && dataChunked) {
      const frameSize = height * width;
      if (dataChunked instanceof Int32Array) {
        pixelData = new Int32Array(
          dataChunked.buffer,
          dataChunked.byteOffset + i * frameSize * 4,
          frameSize
        );
      } else if (ArrayBuffer.isView(dataChunked)) {
        const offset = i * frameSize;
        pixelData = new Int32Array(frameSize);
        for (let p = 0; p < frameSize; p++) {
          pixelData[p] = dataChunked[offset + p];
        }
      } else {
        pixelData = new Int32Array(frameSize);
      }
    } else {
      const dataStart = Number(dataStarts[i]);
      const dataEnd = Number(dataEnds[i]);
      const compressed = dataFlat.slice(dataStart, dataEnd);
      const decompressed = inflate(compressed);
      pixelData = new Int32Array(
        decompressed.buffer.slice(
          decompressed.byteOffset,
          decompressed.byteOffset + decompressed.byteLength
        )
      );
    }
    const nObj = Number(nObjectsList[i]);
    const objStart = Number(objectsStarts[i]);
    const objects = /* @__PURE__ */ new Map();
    const deferredInstances = /* @__PURE__ */ new Map();
    for (let j = objStart; j < objStart + nObj; j++) {
      const labelId = Number(objLabelIds[j]);
      const trackIdx = Number(objTrackIndices[j]);
      const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
      const instIdx = Number(objInstanceIndices[j]);
      let instance = null;
      if (instances && instIdx >= 0 && instIdx < instances.length) {
        instance = instances[instIdx];
      } else if (instIdx >= 0) {
        deferredInstances.set(labelId, instIdx);
      }
      const objScore = objScoreCol.length > j ? Number(objScoreCol[j]) : null;
      const objTsVal = objTrackingScoreCol.length > j ? Number(objTrackingScoreCol[j]) : null;
      objects.set(labelId, {
        track,
        category: objCategories[j] ?? "",
        name: objNames[j] ?? "",
        instance,
        score: objScore !== null && !Number.isNaN(objScore) ? objScore : null,
        trackingScore: objTsVal !== null && !Number.isNaN(objTsVal) ? objTsVal : null,
        _instanceIdx: instIdx >= 0 ? instIdx : -1
      });
    }
    const isPred = isPredictedCol.length > i ? Number(isPredictedCol[i]) === 1 : false;
    const liScaleX = liScaleXCol.length > i ? Number(liScaleXCol[i]) : 1;
    const liScaleY = liScaleYCol.length > i ? Number(liScaleYCol[i]) : 1;
    const liOffsetX = liOffsetXCol.length > i ? Number(liOffsetXCol[i]) : 0;
    const liOffsetY = liOffsetYCol.length > i ? Number(liOffsetYCol[i]) : 0;
    const liScale = [liScaleX, liScaleY];
    const liOffset = [liOffsetX, liOffsetY];
    let li;
    if (isPred) {
      const liScore = liScoreCol.length > i ? Number(liScoreCol[i]) : 0;
      const sm = liScoreMaps.get(i);
      li = new PredictedLabelImage({
        data: pixelData,
        height,
        width,
        objects,
        source: sources[i] ?? "",
        score: liScore,
        scoreMap: sm?.scoreMap ?? null,
        scale: liScale,
        offset: liOffset
      });
    } else {
      li = new UserLabelImage({
        data: pixelData,
        height,
        width,
        objects,
        source: sources[i] ?? "",
        scale: liScale,
        offset: liOffset
      });
    }
    if (deferredInstances.size > 0) {
      li._objectInstanceIdxs = deferredInstances;
    }
    labelImages.push([li, videoIdx, frameIdxVal]);
  }
  return labelImages;
}
function normalizeStructDataset(dataset, module) {
  if (!dataset) return {};
  if (module) {
    const fast = readCompoundColumnsManual(module, dataset);
    if (fast) return fast;
  }
  const raw = dataset.value;
  if (!raw) return {};
  const fieldNames = getFieldNames(dataset);
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    return mapStructuredRows(raw, fieldNames);
  }
  if (raw && ArrayBuffer.isView(raw) && Array.isArray(dataset.shape) && dataset.shape.length === 2) {
    const [rowCount, colCount] = dataset.shape;
    const flat = raw;
    if (fieldNames.length) {
      const cols = fieldNames.map(() => new Array(rowCount));
      const fillCols = Math.min(fieldNames.length, colCount);
      for (let i = 0; i < rowCount; i += 1) {
        const base = i * colCount;
        for (let j = 0; j < fillCols; j += 1) {
          cols[j][i] = flat[base + j];
        }
      }
      const data = {};
      for (let j = 0; j < fieldNames.length; j += 1) {
        data[fieldNames[j]] = cols[j];
      }
      return data;
    }
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) {
      const start = i * colCount;
      rows.push(Array.from(raw.slice(start, start + colCount)));
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
      const parsed = JSON.parse(textDecoder2.decode(value));
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      return [];
    }
  }
  return [];
}
function buildLabeledFrames2(options) {
  const frames = [];
  const {
    framesData,
    instancesData,
    pointsData,
    predPointsData,
    skeletons,
    tracks,
    videos,
    formatId
  } = options;
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
      const fromPredicted = Number(
        instancesData.from_predicted?.[instIdx] ?? -1
      );
      const skeleton = skeletons[skeletonId] ?? skeletons[0];
      const track = trackId >= 0 ? tracks[trackId] : null;
      let instance;
      if (instanceType === 0) {
        instance = Instance._fromColumns({
          columns: pointsData,
          start: pointStart,
          end: pointEnd,
          skeleton,
          track,
          trackingScore
        });
        if (formatId < 1.1) {
          instance.points.forEach((point) => {
            point.xy = [point.xy[0] - 0.5, point.xy[1] - 0.5];
          });
        }
        if (fromPredicted >= 0) {
          fromPredictedPairs.push([instIdx, fromPredicted]);
        }
      } else {
        instance = PredictedInstance._fromColumns({
          columns: predPointsData,
          start: pointStart,
          end: pointEnd,
          skeleton,
          track,
          score,
          trackingScore
        });
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
function readCentroids(file, _videos, tracks) {
  const centroidsDs = file.get("centroids");
  if (!centroidsDs) return [];
  const data = normalizeStructDataset(centroidsDs);
  const xs = data.x ?? [];
  const count = xs.length;
  if (!count) return [];
  const categories = readStringMetadata(
    file,
    "centroid_categories",
    centroidsDs,
    "categories"
  );
  const names = readStringMetadata(
    file,
    "centroid_names",
    centroidsDs,
    "names"
  );
  const sources = readStringMetadata(
    file,
    "centroid_sources",
    centroidsDs,
    "sources"
  );
  const ys = data.y ?? [];
  const zs = data.z ?? [];
  const videoIndices = data.video ?? [];
  const frameIndices = data.frame_idx ?? [];
  const trackIndices = data.track ?? [];
  const instanceIndices = data.instance ?? [];
  const isPredictedCol = data.is_predicted ?? [];
  const scores = data.score ?? [];
  const trackingScores = data.tracking_score ?? [];
  const centroids = [];
  for (let i = 0; i < count; i++) {
    const videoIdx = Number(videoIndices[i]);
    const frameIdxVal = Number(frameIndices[i]);
    const trackIdx = Number(trackIndices[i]);
    const track = trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : null;
    const zVal = zs.length > i ? Number(zs[i]) : Number.NaN;
    const z = Number.isNaN(zVal) ? null : zVal;
    const tsVal = trackingScores.length > i ? Number(trackingScores[i]) : Number.NaN;
    const trackingScore = Number.isNaN(tsVal) ? null : tsVal;
    const instanceIdx = Number(instanceIndices[i]);
    const options = {
      x: Number(xs[i]),
      y: Number(ys[i]),
      z,
      track,
      trackingScore,
      category: categories[i] ?? "",
      name: names[i] ?? "",
      source: sources[i] ?? ""
    };
    const isPred = isPredictedCol.length > i ? Number(isPredictedCol[i]) === 1 : false;
    let centroid;
    if (isPred) {
      const scoreVal = Number(scores[i]);
      centroid = new PredictedCentroid({
        ...options,
        score: Number.isNaN(scoreVal) ? 0 : scoreVal
      });
    } else {
      centroid = new UserCentroid(options);
    }
    if (instanceIdx >= 0) {
      centroid._instanceIdx = instanceIdx;
    }
    centroids.push([centroid, videoIdx, frameIdxVal]);
  }
  return centroids;
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
          headers: options?.h5?.headers,
          h5wasmUrl: options?.h5?.h5wasmUrl,
          openVideos,
          onProgress: options?.onProgress
        });
      } catch (e) {
        if (streamMode === "auto") {
          console.warn(
            "[sleap-io] Worker-based loading failed, falling back to main thread:",
            redactedCauseSummary(e)
          );
        } else {
          throw e;
        }
      }
    }
  }
  if (lazy) {
    return readSlpLazy(source, {
      openVideos,
      h5: options?.h5,
      onProgress: options?.onProgress
    });
  }
  return readSlp(source, {
    openVideos,
    h5: options?.h5,
    onProgress: options?.onProgress
  });
}
async function saveSlp(labels, filename, options) {
  await writeSlp(filename, labels, {
    embed: options?.embed ?? false,
    restoreOriginalVideos: options?.restoreOriginalVideos ?? true
  });
}
async function loadAnalysisH5(filename, options) {
  return readLabels(filename, { video: options?.video });
}
async function saveAnalysisH5(labels, filename, options) {
  await writeLabels(labels, filename, {
    video: options?.video,
    labelsPath: options?.labelsPath,
    allFrames: options?.allFrames,
    minOccupancy: options?.minOccupancy,
    preset: options?.preset,
    frameDim: options?.frameDim,
    trackDim: options?.trackDim,
    nodeDim: options?.nodeDim,
    xyDim: options?.xyDim,
    saveMetadata: options?.saveMetadata
  });
}
async function loadSlpSet(sources, options) {
  const set = new LabelsSet();
  if (Array.isArray(sources)) {
    const results = await Promise.all(
      sources.map((src) => loadSlp(src, options))
    );
    for (let i = 0; i < sources.length; i++) {
      set.set(sources[i], results[i]);
    }
  } else {
    const entries = Object.entries(sources);
    const results = await Promise.all(
      entries.map(([, src]) => loadSlp(src, options))
    );
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
  return new Video({
    filename,
    backend,
    openBackend: options?.openBackend ?? true
  });
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
    return new UserROI({
      geometry: feature.geometry,
      name: String(props.name ?? ""),
      category: String(props.category ?? ""),
      source: String(props.source ?? "")
    });
  });
}
function writeGeoJSON(rois) {
  return JSON.stringify(roisToGeoJSON(rois), null, 2);
}
function readGeoJSON(json) {
  return roisFromGeoJSON(JSON.parse(json));
}

// src/io/coco.ts
function isCocoData(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data) && ["images", "annotations", "categories"].every(
    (k) => Array.isArray(data[k])
  );
}
function parseCocoJson(jsonOrObject) {
  const coco = typeof jsonOrObject === "string" ? JSON.parse(jsonOrObject) : jsonOrObject;
  for (const field of ["images", "annotations", "categories"]) {
    if (!Array.isArray(coco?.[field])) {
      throw new Error(`Missing required COCO field: ${field}`);
    }
  }
  return coco;
}
function createSkeletonFromCategory(category) {
  if (!("keypoints" in category) || category.keypoints === void 0) {
    throw new Error(
      `Category '${category.name ?? ""}' has no keypoint definitions`
    );
  }
  const nodes = category.keypoints.map((name2) => new Node(name2));
  const edges = [];
  if (Array.isArray(category.skeleton)) {
    for (const conn of category.skeleton) {
      if (Array.isArray(conn) && conn.length === 2) {
        const srcIdx = conn[0] - 1;
        const dstIdx = conn[1] - 1;
        if (srcIdx >= 0 && srcIdx < nodes.length && dstIdx >= 0 && dstIdx < nodes.length) {
          edges.push(new Edge(nodes[srcIdx], nodes[dstIdx]));
        }
      }
    }
  }
  const name = category.name ?? "unknown";
  return new Skeleton({ nodes, edges, name });
}
function decodeKeypoints(keypoints, numKeypoints, skeleton) {
  if (keypoints.length !== numKeypoints * 3) {
    throw new Error(
      `Keypoints length ${keypoints.length} doesn't match expected ${numKeypoints * 3}`
    );
  }
  if (skeleton.nodeNames.length !== numKeypoints) {
    throw new Error(
      `Skeleton has ${skeleton.nodeNames.length} nodes but annotation has ${numKeypoints} keypoints`
    );
  }
  const points = [];
  for (let i = 0; i < numKeypoints; i++) {
    const x = keypoints[i * 3];
    const y = keypoints[i * 3 + 1];
    const v = keypoints[i * 3 + 2];
    if (v === 0) {
      points.push([Number.NaN, Number.NaN, 0]);
    } else {
      points.push([x, y, 1]);
    }
  }
  return points;
}
function decodeCompressedRleCounts(counts) {
  const bytes = new TextEncoder().encode(counts);
  const runLengths = [];
  let p = 0;
  let m = 0;
  while (p < bytes.length) {
    let x = 0;
    let k = 0;
    let more = 1;
    while (more) {
      const c = bytes[p] - 48;
      x |= (c & 31) << 5 * k;
      more = c & 32;
      p += 1;
      k += 1;
      if (!more && c & 16) {
        x |= -1 << 5 * k;
      }
    }
    if (m > 2) {
      x += runLengths[m - 2];
    }
    runLengths.push(x);
    m += 1;
  }
  return runLengths;
}
function decodeCocoRle(counts, size) {
  const runs = typeof counts === "string" ? decodeCompressedRleCounts(counts) : counts;
  const [height, width] = size;
  const total = height * width;
  const flat = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const count = runs[i];
    if (i % 2 === 1) {
      const end = Math.min(pos + count, total);
      for (let k = pos; k < end; k++) flat[k] = 1;
    }
    pos += count;
  }
  const out = Array.from(
    { length: height },
    () => new Array(width).fill(false)
  );
  for (let idx = 0; idx < total; idx++) {
    const col = Math.floor(idx / height);
    const row = idx % height;
    out[row][col] = flat[idx] === 1;
  }
  return out;
}
function makeSegMaskFromBinary(mask2d, height, width, opts) {
  const flat = new Uint8Array(height * width);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      flat[r * width + c] = mask2d[r][c] ? 1 : 0;
    }
  }
  const rleCounts = encodeRle(flat, height, width);
  const { score, ...rest } = opts;
  if (score !== void 0 && score !== null) {
    return new PredictedSegmentationMask({
      rleCounts,
      height,
      width,
      ...rest,
      score
    });
  }
  return new UserSegmentationMask({ rleCounts, height, width, ...rest });
}
function closeRing(ring) {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, [first[0], first[1]]];
  }
  return ring;
}
function decodeSegmentation(segmentation, height, width, segmentationFormat, kwargs, score) {
  const masks = [];
  const rois = [];
  if (segmentation == null) {
    return { masks, rois };
  }
  const predicted = score !== void 0 && score !== null;
  if (!Array.isArray(segmentation) && typeof segmentation === "object") {
    const rle = segmentation;
    const [nativeH, nativeW] = rle.size;
    const mask2d = decodeCocoRle(rle.counts, rle.size);
    masks.push(
      makeSegMaskFromBinary(mask2d, nativeH, nativeW, { ...kwargs, score })
    );
    return { masks, rois };
  }
  if (Array.isArray(segmentation) && segmentation.length > 0) {
    const polygons = [];
    for (const ring of segmentation) {
      const coords = [];
      for (let i = 0; i < ring.length - 1; i += 2) {
        coords.push([Number(ring[i]), Number(ring[i + 1])]);
      }
      if (coords.length >= 3) {
        polygons.push(coords);
      }
    }
    if (polygons.length === 0) {
      return { masks, rois };
    }
    const roiOpts = {
      category: kwargs.category,
      instance: kwargs.instance,
      track: kwargs.track
    };
    if (segmentationFormat === "mask" && height > 0 && width > 0) {
      let roi;
      if (polygons.length === 1) {
        const geometry = {
          type: "Polygon",
          coordinates: [closeRing(polygons[0])]
        };
        roi = predicted ? new PredictedROI({ geometry, score, ...roiOpts }) : new UserROI({ geometry, ...roiOpts });
      } else {
        const geometry = {
          type: "MultiPolygon",
          coordinates: polygons.map((ring) => [closeRing(ring)])
        };
        roi = predicted ? new PredictedROI({ geometry, score, ...roiOpts }) : new UserROI({ geometry, ...roiOpts });
      }
      masks.push(roi.toMask(height, width));
    } else {
      for (const coords of polygons) {
        if (predicted) {
          rois.push(
            new PredictedROI({
              geometry: { type: "Polygon", coordinates: [closeRing(coords)] },
              score,
              ...roiOpts
            })
          );
        } else {
          rois.push(UserROI.fromPolygon(coords, roiOpts));
        }
      }
    }
  }
  return { masks, rois };
}
function readCoco(jsonOrObject, options = {}) {
  const fmt = options.segmentationFormat ?? "mask";
  if (fmt !== "mask" && fmt !== "roi") {
    throw new Error(
      `segmentationFormat must be 'mask' or 'roi', got ${JSON.stringify(fmt)}.`
    );
  }
  const grayscale = options.grayscale ?? false;
  const categoryAsTrack = options.categoryAsTrack ?? false;
  const datasetRoot = options.datasetRoot;
  const resolveImage = options.resolveImage ?? ((fileName, root) => root ? `${root}/${fileName}` : fileName);
  const coco = parseCocoJson(jsonOrObject);
  const categoryTrackDict = /* @__PURE__ */ new Map();
  function categoryTrack(catName) {
    if (!categoryAsTrack || !catName) return null;
    let t = categoryTrackDict.get(catName);
    if (!t) {
      t = new Track(catName);
      categoryTrackDict.set(catName, t);
    }
    return t;
  }
  const skeletons = /* @__PURE__ */ new Map();
  const categoryNames = /* @__PURE__ */ new Map();
  for (const cat of coco.categories) {
    categoryNames.set(cat.id, cat.name ?? "");
    if (Array.isArray(cat.keypoints) && cat.keypoints.length > 0) {
      skeletons.set(cat.id, createSkeletonFromCategory(cat));
    }
  }
  const trackDict = /* @__PURE__ */ new Map();
  const imageAnnotations = /* @__PURE__ */ new Map();
  for (const ann of coco.annotations) {
    let list = imageAnnotations.get(ann.image_id);
    if (!list) {
      list = [];
      imageAnnotations.set(ann.image_id, list);
    }
    list.push(ann);
  }
  const shapeToImages = /* @__PURE__ */ new Map();
  const imageIdToPath = /* @__PURE__ */ new Map();
  const imageIdToShape = /* @__PURE__ */ new Map();
  const imageIdToFrameIdx = /* @__PURE__ */ new Map();
  for (const img of coco.images) {
    const imageId = img.id;
    const fileName = img.file_name;
    const height = img.height ?? 0;
    const width = img.width ?? 0;
    const resolved = resolveImage(fileName, datasetRoot);
    if (resolved == null) continue;
    imageIdToPath.set(imageId, resolved);
    const shapeKey = `${height},${width}`;
    imageIdToShape.set(imageId, [height, width]);
    let group = shapeToImages.get(shapeKey);
    if (!group) {
      group = [];
      shapeToImages.set(shapeKey, group);
    }
    imageIdToFrameIdx.set(imageId, group.length);
    group.push(resolved);
  }
  const channels = grayscale ? 1 : 3;
  const shapeToVideo = /* @__PURE__ */ new Map();
  for (const [shapeKey, paths] of shapeToImages) {
    const [height, width] = shapeKey.split(",").map(Number);
    const video = new Video({
      filename: paths,
      openBackend: false,
      backendMetadata: {
        shape: [paths.length, height, width, channels],
        grayscale
      }
    });
    shapeToVideo.set(shapeKey, video);
  }
  const labeledFrames = [];
  for (const img of coco.images) {
    const imageId = img.id;
    if (!imageIdToPath.has(imageId)) continue;
    const [imgHeight, imgWidth] = imageIdToShape.get(imageId);
    const shapeKey = `${imgHeight},${imgWidth}`;
    const video = shapeToVideo.get(shapeKey);
    const frameIdx = imageIdToFrameIdx.get(imageId);
    const instances = [];
    const masks = [];
    const rois = [];
    const bboxes = [];
    const annotations = imageAnnotations.get(imageId) ?? [];
    for (const ann of annotations) {
      const categoryId = ann.category_id;
      const catName = categoryNames.get(categoryId) ?? "";
      const hasKpts = Array.isArray(ann.keypoints) && ann.keypoints.length > 0;
      if (hasKpts && skeletons.has(categoryId)) {
        const skeleton = skeletons.get(categoryId);
        const trackId = ann.attributes?.object_id || ann.track_id || ann.instance_id;
        let track;
        if (trackId != null) {
          let t = trackDict.get(trackId);
          if (!t) {
            t = new Track(`track_${trackId}`);
            trackDict.set(trackId, t);
          }
          track = t;
        } else {
          track = categoryTrack(catName);
        }
        const expected = skeleton.nodeNames.length;
        const pointsData = decodeKeypoints(
          ann.keypoints,
          expected,
          skeleton
        );
        const instance = Instance.fromNumpy({ pointsData, skeleton, track });
        instances.push(instance);
        const segResult = decodeSegmentation(
          ann.segmentation,
          imgHeight,
          imgWidth,
          fmt,
          { category: catName, instance, track }
        );
        masks.push(...segResult.masks);
        rois.push(...segResult.rois);
        if (ann.bbox != null) {
          const [x, y, w, h] = ann.bbox;
          bboxes.push(
            BoundingBox.fromXywh(x, y, w, h, {
              category: catName,
              instance,
              track
            })
          );
        }
      } else {
        const kwargs = {
          category: catName,
          track: categoryTrack(catName)
        };
        const score = ann.score;
        const segResult = decodeSegmentation(
          ann.segmentation,
          imgHeight,
          imgWidth,
          fmt,
          kwargs,
          score
        );
        masks.push(...segResult.masks);
        rois.push(...segResult.rois);
        if (ann.bbox != null && segResult.masks.length === 0 && segResult.rois.length === 0) {
          const [x, y, w, h] = ann.bbox;
          if (score !== void 0 && score !== null) {
            const bboxOpts = {
              x1: x,
              y1: y,
              x2: x + w,
              y2: y + h,
              category: catName,
              track: kwargs.track,
              score
            };
            bboxes.push(new PredictedBoundingBox(bboxOpts));
          } else {
            bboxes.push(
              BoundingBox.fromXywh(x, y, w, h, {
                category: catName,
                track: kwargs.track
              })
            );
          }
        }
      }
    }
    const frame = new LabeledFrame({ video, frameIdx, instances });
    frame.masks.push(...masks);
    frame.rois.push(...rois);
    frame.bboxes.push(...bboxes);
    labeledFrames.push(frame);
  }
  return new Labels({
    labeledFrames,
    provenance: { source: datasetRoot ?? "" }
  });
}
function readCocoSet(splits, options = {}) {
  const result = {};
  for (const [splitName, json] of Object.entries(splits)) {
    const labels = readCoco(json, options);
    labels.provenance = { ...labels.provenance, split: splitName };
    result[splitName] = labels;
  }
  return result;
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
    if (!leftNode || !rightNode)
      throw new Error("Symmetry references unknown node.");
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
function encodeNode(name) {
  return {
    "py/object": "sleap.skeleton.Node",
    "py/state": { "py/tuple": [name, 1] }
  };
}
function encodeSkeleton(skeleton) {
  const links = [];
  const edgeTypePyId = /* @__PURE__ */ new Map();
  let nextEdgeTypePyId = 1;
  function encodeEdgeType(typeVal) {
    const existing = edgeTypePyId.get(typeVal);
    if (existing !== void 0) return { "py/id": existing };
    edgeTypePyId.set(typeVal, nextEdgeTypePyId++);
    return {
      "py/reduce": [
        { "py/type": "sleap.skeleton.EdgeType" },
        { "py/tuple": [typeVal] }
      ]
    };
  }
  const nodePyId = /* @__PURE__ */ new Map();
  let nextNodePyId = 1;
  const ensureNodePyId = (name) => {
    if (!nodePyId.has(name)) nodePyId.set(name, nextNodePyId++);
  };
  const linkedNodes = /* @__PURE__ */ new Set();
  let edgeInsertIdx = 0;
  for (const edge of skeleton.edges) {
    const src = edge.source.name;
    const dst = edge.destination.name;
    links.push({
      edge_insert_idx: edgeInsertIdx++,
      key: 0,
      source: encodeNode(src),
      target: encodeNode(dst),
      type: encodeEdgeType(1)
    });
    ensureNodePyId(src);
    ensureNodePyId(dst);
    linkedNodes.add(src).add(dst);
  }
  for (const [left, right] of skeleton.symmetryNames) {
    links.push({
      key: 0,
      source: encodeNode(left),
      target: encodeNode(right),
      type: encodeEdgeType(2)
    });
    ensureNodePyId(left);
    ensureNodePyId(right);
    linkedNodes.add(left).add(right);
  }
  for (const node of skeleton.nodes) ensureNodePyId(node.name);
  const nodes = skeleton.nodes.map(
    (node) => linkedNodes.has(node.name) ? { id: { "py/id": nodePyId.get(node.name) } } : { id: encodeNode(node.name) }
  );
  return {
    directed: true,
    graph: {
      name: skeleton.name ?? "",
      num_edges_inserted: skeleton.edges.length
    },
    links,
    multigraph: true,
    nodes
  };
}
function writeSkeletonJson(skeletons) {
  const data = Array.isArray(skeletons) ? skeletons.map(encodeSkeleton) : encodeSkeleton(skeletons);
  return JSON.stringify(data);
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
function drawTrails(ctx, trails, options = {}) {
  if (trails.length === 0) return;
  const {
    color = [0, 255, 0],
    colors,
    lineWidth = 2,
    alphaFade = true,
    alpha = 1,
    scale = 1,
    offset = [0, 0]
  } = options;
  if (colors !== void 0 && colors.length !== trails.length) {
    throw new Error(
      `colors has length ${colors.length} but there are ${trails.length} trails; they must be the same length.`
    );
  }
  const [ox, oy] = offset;
  const scaledWidth = lineWidth * scale;
  const prevLineCap = ctx.lineCap;
  ctx.lineCap = "round";
  ctx.lineWidth = scaledWidth;
  for (let i = 0; i < trails.length; i++) {
    const trail = trails[i];
    const c = colors !== void 0 ? colors[i] : color;
    const nPoints = trail.length;
    if (nPoints < 2) continue;
    const nSegments = nPoints - 1;
    for (let k = 0; k < nSegments; k++) {
      const [x0, y0] = trail[k];
      const [x1, y1] = trail[k + 1];
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
        continue;
      }
      const segFrac = alphaFade ? Math.max((k + 1) / nSegments, 0.05) : 1;
      const segAlpha = Math.max(0, Math.min(1, segFrac * alpha));
      ctx.strokeStyle = rgbToCSS(c, segAlpha);
      ctx.beginPath();
      ctx.moveTo((x0 - ox) * scale, (y0 - oy) * scale);
      ctx.lineTo((x1 - ox) * scale, (y1 - oy) * scale);
      ctx.stroke();
    }
  }
  ctx.lineCap = prevLineCap;
}

// src/rendering/trails.ts
function resolveTrailNode(trailNode, skeleton) {
  const names = typeof trailNode === "string" ? [trailNode] : [...trailNode];
  return names.map((name) => {
    if (typeof name === "string" && name.toLowerCase() === "centroid") {
      return null;
    }
    try {
      return skeleton.index(name);
    } catch {
      throw new Error(
        `Unknown trailNode ${JSON.stringify(name)}; skeleton nodes: ${JSON.stringify(
          skeleton.nodeNames
        )}`
      );
    }
  });
}
function nTrailPaletteColors(hasTracks, nTracks, frames) {
  if (hasTracks) {
    return Math.max(nTracks, 1);
  }
  let peak = 1;
  for (const lf of frames) {
    peak = Math.max(peak, lf.instances.length);
  }
  return Math.max(peak, 1);
}
function collectTracks2(frames) {
  const seen = /* @__PURE__ */ new Set();
  const tracks = [];
  for (const lf of frames) {
    for (const inst of lf.instances) {
      if (inst.track != null && !seen.has(inst.track)) {
        seen.add(inst.track);
        tracks.push(inst.track);
      }
    }
  }
  return tracks;
}
function computeTrails(opts) {
  const {
    frameIdx,
    frameIdxToLf,
    trailLength,
    trailTargets,
    trackIndexMap,
    paletteColors,
    hasTracks,
    ptsCache
  } = opts;
  const frameStart = frameIdx - trailLength;
  const nPoints = trailLength + 1;
  const trailData = /* @__PURE__ */ new Map();
  for (let j = 0; j < nPoints; j++) {
    const f = frameStart + j;
    const lf = frameIdxToLf.get(f);
    if (!lf) continue;
    const insts = lf.instances;
    for (let instIdx = 0; instIdx < insts.length; instIdx++) {
      const inst = insts[instIdx];
      let keyIdx;
      if (hasTracks) {
        if (inst.track == null) continue;
        const k = trackIndexMap.get(inst.track);
        if (k === void 0) continue;
        keyIdx = k;
      } else {
        keyIdx = instIdx;
      }
      let pts;
      if (ptsCache) {
        const cached = ptsCache.get(inst);
        if (cached) {
          pts = cached;
        } else {
          pts = inst.numpy();
          ptsCache.set(inst, pts);
        }
      } else {
        pts = inst.numpy();
      }
      for (let tIdx = 0; tIdx < trailTargets.length; tIdx++) {
        const target = trailTargets[tIdx];
        let coord;
        if (target === null) {
          let sumX = 0;
          let sumY = 0;
          let count = 0;
          for (const p of pts) {
            if (!Number.isNaN(p[0])) {
              sumX += p[0];
              sumY += p[1];
              count++;
            }
          }
          coord = count > 0 ? [sumX / count, sumY / count] : [NaN, NaN];
        } else if (target < pts.length) {
          coord = [pts[target][0], pts[target][1]];
        } else {
          coord = [NaN, NaN];
        }
        const dkey = `${keyIdx}:${tIdx}`;
        let entry = trailData.get(dkey);
        if (!entry) {
          const arr = Array.from(
            { length: nPoints },
            () => [NaN, NaN]
          );
          entry = { arr, keyIdx };
          trailData.set(dkey, entry);
        }
        entry.arr[j] = coord;
      }
    }
  }
  const trails = [];
  const colors = [];
  for (const { arr, keyIdx } of trailData.values()) {
    if (!arr.some((p) => Number.isFinite(p[0]) || Number.isFinite(p[1]))) {
      continue;
    }
    trails.push(arr);
    colors.push(paletteColors[keyIdx % paletteColors.length]);
  }
  return { trails, colors };
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

// src/rendering/overlays-raster.ts
function blendChannel(dst, src, alpha) {
  return Math.trunc(dst * (1 - alpha) + src * alpha);
}
function clampAlpha(alpha) {
  if (!Number.isFinite(alpha)) return 0;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}
function pickColor(colors, i, fallback) {
  if (colors === null || colors.length === 0) return fallback;
  return colors[i % colors.length];
}
function drawMasks(image, masks, opts) {
  const color = opts?.color ?? [255, 0, 0];
  const colors = opts?.colors ?? null;
  const alpha = clampAlpha(opts?.alpha ?? 0.3);
  const imgW = image.width;
  const imgH = image.height;
  const pixels = image.data;
  for (let i = 0; i < masks.length; i++) {
    const mask = masks[i];
    const maskColor = pickColor(colors, i, color);
    const maskData = mask.data;
    let region;
    let x0;
    let y0;
    let drawW;
    let drawH;
    if (mask.hasSpatialTransform) {
      const ext = mask.imageExtent;
      const targetH = ext.height;
      const targetW = ext.width;
      const resized = resizeNearest(
        maskData,
        mask.height,
        mask.width,
        targetH,
        targetW
      );
      const ox = Math.trunc(mask.offset[0]);
      const oy = Math.trunc(mask.offset[1]);
      y0 = Math.max(0, oy);
      x0 = Math.max(0, ox);
      const y1 = Math.min(imgH, oy + targetH);
      const x1 = Math.min(imgW, ox + targetW);
      if (y1 <= y0 || x1 <= x0) continue;
      drawH = y1 - y0;
      drawW = x1 - x0;
      const my0 = y0 - oy;
      const mx0 = x0 - ox;
      region = new Uint8Array(drawH * drawW);
      for (let r = 0; r < drawH; r++) {
        const srcRow = (my0 + r) * targetW + mx0;
        region.set(resized.subarray(srcRow, srcRow + drawW), r * drawW);
      }
    } else {
      drawH = Math.min(mask.height, imgH);
      drawW = Math.min(mask.width, imgW);
      x0 = 0;
      y0 = 0;
      region = new Uint8Array(drawH * drawW);
      for (let r = 0; r < drawH; r++) {
        const srcRow = r * mask.width;
        region.set(maskData.subarray(srcRow, srcRow + drawW), r * drawW);
      }
    }
    const [cr, cg, cb] = maskColor;
    for (let r = 0; r < drawH; r++) {
      for (let c = 0; c < drawW; c++) {
        if (region[r * drawW + c] === 0) continue;
        const px = ((y0 + r) * imgW + (x0 + c)) * 4;
        pixels[px] = blendChannel(pixels[px], cr, alpha);
        pixels[px + 1] = blendChannel(pixels[px + 1], cg, alpha);
        pixels[px + 2] = blendChannel(pixels[px + 2], cb, alpha);
      }
    }
  }
  return image;
}
function drawLabelImage(image, labels, opts) {
  const alpha = clampAlpha(opts?.alpha ?? 0.3);
  const palette = opts?.palette ?? "distinct";
  const outline = opts?.outline ?? false;
  const outlineWidth = opts?.outlineWidth ?? 1;
  const outlineColor = opts?.outlineColor ?? null;
  const labData = labels.data;
  const labH = labels.height;
  const labW = labels.width;
  const scale = opts?.scale ?? labels.scale ?? [1, 1];
  const offset = opts?.offset ?? labels.offset ?? [0, 0];
  let maxId = 0;
  let hasFg = false;
  for (let i = 0; i < labData.length; i++) {
    const v = labData[i];
    if (v > 0) {
      hasFg = true;
      if (v > maxId) maxId = v;
    }
  }
  if (!hasFg) return image;
  const paletteColors = getPalette(palette, maxId + 1);
  const lut = new Float32Array((maxId + 1) * 3);
  for (let id = 1; id <= maxId; id++) {
    const col = paletteColors[id % paletteColors.length];
    lut[id * 3] = col[0];
    lut[id * 3 + 1] = col[1];
    lut[id * 3 + 2] = col[2];
  }
  const imgW = image.width;
  const imgH = image.height;
  const pixels = image.data;
  const hasTransform = scale[0] !== 1 || scale[1] !== 1 || offset[0] !== 0 || offset[1] !== 0;
  let region;
  let x0;
  let y0;
  let drawW;
  let drawH;
  if (hasTransform) {
    const sx = scale[0];
    const sy = scale[1];
    const targetH = Math.trunc(labH / sy);
    const targetW = Math.trunc(labW / sx);
    const resized = resizeNearest(labData, labH, labW, targetH, targetW);
    const ox = Math.trunc(offset[0]);
    const oy = Math.trunc(offset[1]);
    y0 = Math.max(0, oy);
    x0 = Math.max(0, ox);
    const y1 = Math.min(imgH, oy + targetH);
    const x1 = Math.min(imgW, ox + targetW);
    if (y1 <= y0 || x1 <= x0) return image;
    drawH = y1 - y0;
    drawW = x1 - x0;
    const my0 = y0 - oy;
    const mx0 = x0 - ox;
    region = new Int32Array(drawH * drawW);
    for (let r = 0; r < drawH; r++) {
      const srcRow = (my0 + r) * targetW + mx0;
      region.set(resized.subarray(srcRow, srcRow + drawW), r * drawW);
    }
  } else {
    drawH = Math.min(labH, imgH);
    drawW = Math.min(labW, imgW);
    x0 = 0;
    y0 = 0;
    region = new Int32Array(drawH * drawW);
    for (let r = 0; r < drawH; r++) {
      const srcRow = r * labW;
      region.set(labData.subarray(srcRow, srcRow + drawW), r * drawW);
    }
  }
  for (let r = 0; r < drawH; r++) {
    for (let c = 0; c < drawW; c++) {
      const lab = region[r * drawW + c];
      if (lab <= 0) continue;
      const safe = lab > maxId ? maxId : lab;
      const li = safe * 3;
      const px = ((y0 + r) * imgW + (x0 + c)) * 4;
      pixels[px] = Math.trunc(pixels[px] * (1 - alpha) + lut[li] * alpha);
      pixels[px + 1] = Math.trunc(
        pixels[px + 1] * (1 - alpha) + lut[li + 1] * alpha
      );
      pixels[px + 2] = Math.trunc(
        pixels[px + 2] * (1 - alpha) + lut[li + 2] * alpha
      );
    }
  }
  if (outline) {
    drawLabelOutlines(
      image,
      region,
      x0,
      y0,
      drawH,
      drawW,
      outlineWidth,
      outlineColor,
      lut,
      maxId
    );
  }
  return image;
}
function drawLabelOutlines(image, region, x0, y0, drawH, drawW, outlineWidth, outlineColor, lut, maxId) {
  const imgW = image.width;
  const pixels = image.data;
  const edges = new Uint8Array(drawH * drawW);
  const at = (r, c) => region[r * drawW + c];
  for (let r = 0; r < drawH; r++) {
    for (let c = 0; c < drawW; c++) {
      const v = at(r, c);
      let edge = false;
      if (c + 1 < drawW && v !== at(r, c + 1)) edge = true;
      if (!edge && c - 1 >= 0 && v !== at(r, c - 1)) edge = true;
      if (!edge && r + 1 < drawH && v !== at(r + 1, c)) edge = true;
      if (!edge && r - 1 >= 0 && v !== at(r - 1, c)) edge = true;
      if (edge && v > 0) edges[r * drawW + c] = 1;
    }
  }
  let finalEdges = edges;
  if (outlineWidth > 1) {
    const pad = Math.trunc(outlineWidth / 2);
    const dilated = new Uint8Array(drawH * drawW);
    for (let dy = -pad; dy <= pad; dy++) {
      for (let dx = -pad; dx <= pad; dx++) {
        const sy = Math.max(0, dy);
        const ey = drawH + Math.min(0, dy);
        const sx = Math.max(0, dx);
        const ex = drawW + Math.min(0, dx);
        const oy = Math.max(0, -dy);
        const ox = Math.max(0, -dx);
        for (let r = sy; r < ey; r++) {
          for (let c = sx; c < ex; c++) {
            if (edges[(oy + (r - sy)) * drawW + (ox + (c - sx))]) {
              dilated[r * drawW + c] = 1;
            }
          }
        }
      }
    }
    for (let i = 0; i < dilated.length; i++) {
      if (dilated[i] && region[i] > 0) dilated[i] = 1;
      else dilated[i] = 0;
    }
    finalEdges = dilated;
  }
  for (let r = 0; r < drawH; r++) {
    for (let c = 0; c < drawW; c++) {
      if (!finalEdges[r * drawW + c]) continue;
      const px = ((y0 + r) * imgW + (x0 + c)) * 4;
      if (outlineColor !== null) {
        pixels[px] = outlineColor[0];
        pixels[px + 1] = outlineColor[1];
        pixels[px + 2] = outlineColor[2];
      } else {
        const lab = region[r * drawW + c];
        const safe = lab > maxId ? maxId : lab;
        const li = safe * 3;
        pixels[px] = Math.trunc(lut[li] * 0.6);
        pixels[px + 1] = Math.trunc(lut[li + 1] * 0.6);
        pixels[px + 2] = Math.trunc(lut[li + 2] * 0.6);
      }
    }
  }
}

export {
  getCentroidSkeleton,
  CENTROID_SKELETON,
  Centroid,
  UserCentroid,
  PredictedCentroid,
  _registerMaskFactory,
  AnnotationType,
  ROI,
  rasterizeGeometry,
  encodeWkb,
  decodeWkb,
  UserROI,
  PredictedROI,
  BoundingBox,
  UserBoundingBox,
  PredictedBoundingBox,
  encodeRle,
  decodeRle,
  resizeNearest,
  traceMaskContours,
  groupRingsIntoPolygons,
  SegmentationMask,
  UserSegmentationMask,
  PredictedSegmentationMask,
  LabelImage,
  UserLabelImage,
  PredictedLabelImage,
  normalizeLabelIds,
  SkeletonMatchMethod,
  InstanceMatchMethod,
  TrackMatchMethod,
  VideoMatchMethod,
  FrameStrategy,
  ErrorMode,
  ConflictResolution,
  MergeError,
  SkeletonMismatchError,
  MergeResult,
  MatchResult,
  MergeProgressBar,
  setFsResolver,
  setDefaultFsResolver,
  SkeletonMatcher,
  InstanceMatcher,
  TrackMatcher,
  VideoMatcher,
  STRUCTURE_SKELETON_MATCHER,
  SUBSET_SKELETON_MATCHER,
  OVERLAP_SKELETON_MATCHER,
  DUPLICATE_MATCHER,
  IOU_MATCHER,
  IDENTITY_INSTANCE_MATCHER,
  NAME_TRACK_MATCHER,
  IDENTITY_TRACK_MATCHER,
  AUTO_VIDEO_MATCHER,
  PATH_VIDEO_MATCHER,
  BASENAME_VIDEO_MATCHER,
  IMAGE_DEDUP_VIDEO_MATCHER,
  SHAPE_VIDEO_MATCHER,
  _relinkFromPredicted,
  _annotationCentroidXy,
  _findAnnotationMatches,
  _findAnnotationLinkMatches,
  _resolveMergedIsNegative,
  LabeledFrame,
  SuggestionFrame,
  cropFrame,
  cropPoints,
  uncropPoints,
  CropVideoBackend,
  EXISTS_TTL_MS,
  resolveCropRect,
  Video,
  rodriguesTransformation,
  Camera,
  CameraGroup,
  InstanceGroup,
  FrameGroup,
  RecordingSession,
  injectSessionFrameResolver,
  cloneRecordingSession,
  makeCameraFromDict,
  MediaBunnyVideoBackend,
  toDict,
  fromDict,
  toNumpy,
  fromNumpy,
  labelsFromNumpy,
  LazyDataStore,
  LazyFrameList,
  LabelsSet,
  Labels,
  Identity,
  Mp4BoxVideoBackend,
  StreamingHdf5VideoBackend,
  setImageBytesReader,
  setDefaultImageBytesReader,
  getImageBytesReader,
  computePrefetchWindow,
  ImageVideoBackend,
  BlobByteSource,
  setSeqFileByteSourceFactory,
  SeqHeader,
  SeqIndex,
  SeqVideoBackend,
  StreamingH5File,
  isStreamingSupported,
  openStreamingH5,
  openH5Worker,
  _registerNodeH5,
  _registerNodeFileOps,
  nodeFileExists,
  openH5File,
  fetchRemoteSlpBytes,
  UnsupportedVideoFormatError,
  createVideoBackend,
  readSlpStreaming,
  _registerFileWriter,
  saveSlpToBytes,
  isAnalysisH5File,
  setLabelImageFileReader,
  loadLabelImages,
  labelsToCsv,
  saveLabelsCsv,
  loadSlp,
  saveSlp,
  loadAnalysisH5,
  saveAnalysisH5,
  loadSlpSet,
  saveSlpSet,
  loadVideo,
  roisToGeoJSON,
  roisFromGeoJSON,
  writeGeoJSON,
  readGeoJSON,
  isCocoData,
  parseCocoJson,
  createSkeletonFromCategory,
  decodeKeypoints,
  decodeCompressedRleCounts,
  decodeCocoRle,
  decodeSegmentation,
  readCoco,
  readCocoSet,
  decodeYamlSkeleton,
  encodeYamlSkeleton,
  readSkeletonJson,
  writeSkeletonJson,
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
  drawTrails,
  resolveTrailNode,
  nTrailPaletteColors,
  collectTracks2 as collectTracks,
  computeTrails,
  RenderContext,
  InstanceContext,
  clampAlpha,
  pickColor,
  drawMasks,
  drawLabelImage
};
