/**
 * pose/connect/open-predictions-plan.js — the DOM-free planning behind Connect's "Open as new project"
 * (Jobs tab ▸ Fetch & Load ▸ Load predictions): a remote inference RUN opened as a new, unsaved project
 * instead of merged into the open one (luc3d #450; sleap-app `MergePredictionsDialog.tsx` "Open predictions").
 *
 * sleap-app opens ONE job's predictions `.slp` as its project (one Labels, many videos). A LUCID run is one
 * `track` job per camera sharing a `run.id`, so here the whole run becomes ONE session, one camera per video
 * of every completed track job of the run:
 *  - camera name: the view this device submitted the job for (`TrackedJob.camera`), else the view in LUCID's
 *    own output name (`<session>__<view>.<yymmdd_hhmmss>.predictions.slp`, written by `remoteOutputPath`),
 *    else the video's file stem, else its folder when stems collide (campy names every video `0.mp4`), else a
 *    `_2`, `_3` suffix; a job whose result has no video at all is `cam_<n>`;
 *  - session name: the tracked `sessionId` when every job has the same one, else the output names' session,
 *    else the folder holding the videos (the camera folders' parent when cameras were named by folder),
 *    else "Session 1";
 *  - tracks: per camera, `<camera>: <track>` (as `mergeViewPredictions` names them), so two cameras'
 *    `track_0` never become one LUCID track; predictions stay ungrouped (Track ▸ All frames groups them);
 *  - no calibration (a predictions file has none): the cameras are uncalibrated, exactly as when a plain
 *    SLEAP `.slp` is opened; Load Calibration matches them by name;
 *  - videos are the WORKER's paths: `handleLoadSlpFile`'s folder prompt binds picked files by parent folder,
 *    stem, or the referenced file name, so only names matter (no path translation).
 * The result is the `slpData` shape `parseSlpForImport` returns, with ONE synthetic recording session
 * (calibration keys = camera names, no matrices; `camcorder_to_video_idx_map`; `metadata.lucid.sessionName`;
 * no `frame_group_dicts`), handed to `handleLoadSlpFile(file, {slpData})`.
 */

export const DEFAULT_SESSION_NAME = "Session 1";

/** `<session>__<view>.<yymmdd_hhmmss>.predictions.slp` (see `remoteOutputPath`). */
const LUCID_OUTPUT_RE = /^(.+?)__(.+)\.\d{6}_\d{6}\.predictions\.slp$/;

function parts(p) {
  return String(p == null ? "" : p).split(/[\\/]+/).filter(Boolean);
}
function baseName(p) {
  const a = parts(p);
  return a.length ? a[a.length - 1] : "";
}
function stemOf(p) {
  return baseName(p).replace(/\.[^.]+$/, "");
}
/** The name of the folder `up` levels above the file (1 = its folder), or "". */
function folderAbove(p, up) {
  const a = parts(p);
  return a.length > up ? a[a.length - 1 - up] : "";
}
function usablePath(p) {
  return typeof p === "string" && p !== "" && p !== "." ? p : null;
}

/** `{session, view}` from LUCID's own output file name, else null. */
export function parseLucidOutputName(path) {
  const m = LUCID_OUTPUT_RE.exec(baseName(path));
  return m ? { session: m[1], view: m[2] } : null;
}

/** Run order: `run.index`, then submit time. */
function runOrder(a, b) {
  const ai = a.run && typeof a.run.index === "number" ? a.run.index : 0;
  const bi = b.run && typeof b.run.index === "number" ? b.run.index : 0;
  if (ai !== bi) return ai - bi;
  return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
}

const LEFT_OUT = { queued: "still queued", running: "still running", failed: "failed", canceled: "canceled" };

/**
 * Which jobs of the clicked job's run open, and which are left out (and why). Only `track` jobs count
 * (a training run's chained inference shares the run with its training jobs).
 *
 * @param {Array<{jobId: string, kind: string, state: string, run?: {id: string, index?: number}, createdAt?: string}>} jobs
 *   the worker's job list (or just the run)
 * @param {string} jobId the clicked job (completed)
 * @returns {{ open: any[], leftOut: Array<{job: any, reason: string}> }}
 */
export function runJobsToOpen(jobs, jobId) {
  const clicked = (jobs || []).find((j) => j.jobId === jobId);
  const runId = clicked && clicked.run ? clicked.run.id : null;
  const members = runId
    ? jobs.filter((j) => j.kind === "track" && j.run && j.run.id === runId)
    : clicked ? [clicked] : [];
  members.sort(runOrder);
  const open = [];
  const leftOut = [];
  for (const j of members) {
    if (j.state === "completed") open.push(j);
    else leftOut.push({ job: j, reason: LEFT_OUT[j.state] || j.state });
  }
  return { open, leftOut };
}

/**
 * Camera names for every video of every part, and the session name (see the header for the rules).
 *
 * @param {Array<{jobId: string, camera?: string, sessionId?: string, outputPath?: string, dataPath?: string, videos: Array<string|null>}>} partsIn
 *   one per job, in run order; `videos` = the result's video paths (worker paths), `[]` when it has none
 * @returns {{ sessionName: string, cameras: Array<{name: string, part: number, video: number, path: string | null}> }}
 */
export function nameCameras(partsIn) {
  const entries = [];
  partsIn.forEach((p, pi) => {
    const out = parseLucidOutputName(p.outputPath);
    const vids = p.videos && p.videos.length ? p.videos : [null];
    vids.forEach((v, vi) => {
      const path = usablePath(v) || (vids.length === 1 ? usablePath(p.dataPath) : null);
      let fixed = null;
      if (vids.length === 1 && p.camera) fixed = String(p.camera);
      else if (vids.length === 1 && out) fixed = out.view;
      entries.push({ part: pi, video: vi, path, fixed, byFolder: false, name: null });
    });
  });

  // Stems first; a stem shared by two videos (campy's 0.mp4) or by a fixed name takes the video's folder.
  const fixedNames = new Set(entries.filter((e) => e.fixed).map((e) => e.fixed));
  const free = entries.filter((e) => !e.fixed && e.path);
  const stemCount = new Map();
  free.forEach((e) => { const s = stemOf(e.path); stemCount.set(s, (stemCount.get(s) || 0) + 1); });
  entries.forEach((e, i) => {
    if (e.fixed) { e.name = e.fixed; return; }
    if (!e.path) { e.name = "cam_" + i; return; }
    const stem = stemOf(e.path);
    const folder = folderAbove(e.path, 1);
    if ((stemCount.get(stem) > 1 || fixedNames.has(stem) || !stem) && folder) { e.name = folder; e.byFolder = true; }
    else e.name = stem || "cam_" + i;
  });
  // Whatever still collides gets a suffix, in run order (the first keeps its name).
  const used = new Set();
  entries.forEach((e) => {
    let n = e.name;
    for (let k = 2; used.has(n); k++) n = e.name + "_" + k;
    e.name = n;
    used.add(n);
  });

  return {
    sessionName: sessionNameFor(partsIn, entries),
    cameras: entries.map((e) => ({ name: e.name, part: e.part, video: e.video, path: e.path })),
  };
}

function agreed(values) {
  if (!values.length || values.some((v) => !v)) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

function sessionNameFor(partsIn, entries) {
  const tracked = agreed(partsIn.map((p) => (p.sessionId ? String(p.sessionId) : "")));
  if (tracked) return tracked;
  const fromOut = agreed(partsIn.map((p) => { const o = parseLucidOutputName(p.outputPath); return o ? o.session : ""; }));
  if (fromOut) return fromOut;
  const fromPath = agreed(entries.map((e) => (e.path ? folderAbove(e.path, e.byFolder ? 2 : 1) : "")));
  return fromPath || DEFAULT_SESSION_NAME;
}

/** The skeleton's node names as strings. */
function nodeNames(sk) {
  return ((sk && sk.nodes) || []).map((n) => (typeof n === "string" ? n : n && n.name != null ? String(n.name) : String(n)));
}

function trackName(t) {
  return typeof t === "string" ? t : (t && t.name) || "track";
}

/**
 * Combine the run's parsed predictions into one `slpData` for `handleLoadSlpFile(file, {slpData})`.
 * Throws (nothing is opened) when nothing has a result, when the cameras' skeletons have different nodes,
 * or when several results carry embedded frames (the loader reads those from ONE file).
 *
 * @param {Array<{jobId: string, camera?: string, sessionId?: string, outputPath?: string, dataPath?: string, slpData: any}>} partsIn
 * @returns {{ slpData: any, sessionName: string, cameras: Array<{name: string, jobId: string, path: string | null, frames: number, instances: number}> }}
 */
export function combinePredictions(partsIn) {
  const partsOk = (partsIn || []).filter((p) => p && p.slpData);
  if (!partsOk.length) throw new Error("No predictions to open.");
  if (partsOk.length > 1 && partsOk.some((p) => (p.slpData.videos || []).some((v) => v && v.embedded))) {
    throw new Error("These results embed their frames; open them one at a time (Download .slp, then File ▸ Open).");
  }

  // The skeleton: the first one with nodes; every other must have the same node names (any order).
  const ref = partsOk.find((p) => nodeNames(p.slpData.skeleton).length) || partsOk[0];
  const refSk = ref.slpData.skeleton || { name: "skeleton", nodes: [], edges: [] };
  const refNodes = nodeNames(refSk);
  const refIndex = new Map(refNodes.map((n, i) => [n, i]));

  const naming = nameCameras(partsOk.map((p) => ({
    jobId: p.jobId, camera: p.camera, sessionId: p.sessionId, outputPath: p.outputPath, dataPath: p.dataPath,
    videos: (p.slpData.videos || []).map((v) => (v ? v.filename || v.sourceFilename || null : null)),
  })));
  const camOf = new Map(naming.cameras.map((c, i) => [c.part + ":" + c.video, i]));

  const videos = [];
  naming.cameras.forEach((c) => {
    const src = (partsOk[c.part].slpData.videos || [])[c.video];
    videos.push(src ? Object.assign({}, src, { index: videos.length }) : {
      index: videos.length, filename: c.path, sourceFilename: null, backendType: "MediaVideo", shape: null, embedded: false, dataset: null,
    });
  });
  const stats = naming.cameras.map(() => ({ frames: 0, instances: 0 }));

  const tracks = [];
  const trackIdx = new Map();
  const frames = [];
  partsOk.forEach((p, pi) => {
    const d = p.slpData;
    const names = nodeNames(d.skeleton);
    const nodesOk = !names.length || (names.length === refNodes.length && names.every((n) => refIndex.has(n)) && new Set(names).size === names.length);
    if (!nodesOk) {
      const cam = naming.cameras.find((c) => c.part === pi);
      throw new Error("The cameras' skeletons differ: " + (cam ? cam.name : p.jobId) + " has " + names.join(", ") +
        ", " + naming.cameras.find((c) => c.part === partsOk.indexOf(ref)).name + " has " + refNodes.join(", ") + ".");
    }
    // srcOf[k] = this part's node index for the reference's node k (null: the part has no such node).
    const reorder = names.length && names.some((n, i) => refNodes[i] !== n)
      ? refNodes.map((n) => names.indexOf(n)) : null;
    const nVid = Math.max(1, (d.videos || []).length);
    const srcTracks = d.tracks || [];
    (d.frames || []).forEach((fd) => {
      let vi = fd.videoIdx;
      if (!(vi >= 0 && vi < nVid)) { if (nVid === 1) vi = 0; else return; }
      const ci = camOf.get(pi + ":" + vi);
      const cam = naming.cameras[ci].name;
      const instances = (fd.instances || []).map((inst) => {
        let ti = -1;
        if (typeof inst.trackIdx === "number" && inst.trackIdx >= 0 && inst.trackIdx < srcTracks.length) {
          const key = cam + ": " + trackName(srcTracks[inst.trackIdx]);
          if (!trackIdx.has(key)) { trackIdx.set(key, tracks.length); tracks.push(key); }
          ti = trackIdx.get(key);
        }
        const out = Object.assign({}, inst, { trackIdx: ti });
        if (reorder) {
          out.points = reorder.map((k) => (inst.points && k >= 0 ? inst.points[k] : null));
          if (inst.occluded) out.occluded = reorder.map((k) => (k >= 0 ? !!inst.occluded[k] : false));
          if (inst.pointScores) out.pointScores = Float64Array.from(reorder.map((k) => (k >= 0 ? inst.pointScores[k] : NaN)));
        }
        return out;
      });
      stats[ci].frames++;
      stats[ci].instances += instances.length;
      frames.push({ frameIdx: fd.frameIdx, videoIdx: ci, instances });
    });
  });

  const calibration = {};
  const camMap = {};
  naming.cameras.forEach((c, i) => { calibration[c.name] = { name: c.name }; camMap[c.name] = i; });
  const slpData = {
    skeleton: { name: refSk.name || "skeleton", nodes: refNodes, edges: refSk.edges || [] },
    tracks,
    frames,
    videos,
    sessions: [{
      name: naming.sessionName,
      calibration,
      camcorder_to_video_idx_map: camMap,
      metadata: { lucid: { sessionName: naming.sessionName } },
    }],
    identities: [],
    provenance: null,
  };
  return {
    slpData,
    sessionName: naming.sessionName,
    cameras: naming.cameras.map((c, i) => ({
      name: c.name, jobId: partsOk[c.part].jobId, path: c.path, frames: stats[i].frames, instances: stats[i].instances,
    })),
  };
}
