/**
 * pose/connect/remote-inference-plan.js — the DOM-free planning behind a remote
 * inference run (the remote branch of sleap-app `src/stores/inferenceStore.ts`
 * `startInference` @ 683a159, plus the path / output-folder rules it leans on).
 *
 * What it decides, given facts the UI gathers (nothing here reads a store, a
 * socket or the DOM):
 *  - each view's video as a "local" path and where it is ON THE WORKER
 *    (`resolveViewVideos`: `pathRulesFor` rules + the worker's shared folders +
 *    `checkVideoVisibility`'s `fs.stat` probes). On the web LUCID has no
 *    absolute local paths, so a view's local key is its session folder name +
 *    the video's relative path (`rec/cam1/0.mp4`); one "Locate on worker…" per
 *    session root records a rule for the whole root (`inferLocateRule`);
 *  - which views can run, and the refusal when two views resolve to the SAME
 *    worker file (campy names every camera's video `0.mp4`, so a rule that
 *    drops the camera folder would feed one video to every view);
 *  - the explicit `output_path` of every job
 *    (`<output dir>/predictions/<session>__<view>.<timestamp>.predictions.slp`;
 *    the worker never creates folders for an explicit `output_path`, so when
 *    `<output dir>/predictions` does not exist the file goes straight into the
 *    output dir);
 *  - the protocol-v1 `track` spec of each view (`buildViewSpec`, built by
 *    sleap-app's own `buildRemoteTrackSpecs` so every option field is
 *    identical) and the whole run (`planRemoteRun`);
 *  - which tracked jobs are still waiting to be fetched (`pendingFetches`).
 *
 * `frames`: sleap-nn's `--frames` (`predict.py` `frame_list`, called from `cli.py`) takes ONE range
 * `a-b` or a plain comma list, never `0-4,10-11` (it splits on `-` and `int()`s the middle). So a
 * contiguous run is `a-b` and anything else (e.g. "Exclude user-labeled") lists every frame; the
 * worker passes the string as ONE argv entry, which Linux caps at 128 KiB, so `planRemoteRun`
 * refuses a list over `MAX_FRAMES_SPEC_CHARS` (100,000) with a message instead of failing opaquely.
 *
 * LUCID changes from sleap-app: one job PER VIEW (sleap-app runs one job over
 * the project's labels file or video), each with an explicit `frames` list
 * computed by the panel (a video input has no labels to filter on), no
 * `exclude_user_labeled` (applied to that list already), no `path_mappings` (the
 * data path is the worker's own), and the `project` tag of `lucidProjectTag`.
 *
 * Imports only inside `pose/connect/` (Node tests: tests/test-connect-remote-inference-plan.mjs).
 */
import { isWorkerPath, translatePath } from "./path-mappings.js";
import { checkVideoVisibility, inferRuleFromLocate } from "./remote-visibility.js";
import { buildRemoteTrackSpecs } from "./remote-track-spec.js";

export const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv", ".m4v"];

/** The longest `frames` string a job may carry (one argv entry on the worker; Linux caps one at 128 KiB). */
export const MAX_FRAMES_SPEC_CHARS = 100000;

/** The refusal for a `frames` string over `MAX_FRAMES_SPEC_CHARS` (what is wrong, then what to do). */
export function framesTooLongMessage(view, length) {
  return (
    `The frames to run on ${view} are too many to send in one job (${Number(length).toLocaleString("en-US")} characters; ` +
    `the limit is ${MAX_FRAMES_SPEC_CHARS.toLocaleString("en-US")}), because sleap-nn takes only one range or a plain list. ` +
    "Choose a Custom range or the Entire video instead of a frame choice that skips frames (for example Exclude user-labeled)."
  );
}

/**
 * The checked, runnable views whose video is not located on the worker (sleap-app's
 * `PathResolutionDialog` blocks Submit until every path resolves; LUCID blocks Run).
 * @param {Array<{view: string, checked: boolean, blocker: string | null}>} descs
 * @param {Record<string, {visible?: boolean} | undefined>} byView
 * @returns {string[]}
 */
export function unresolvedViews(descs, byView) {
  return descs.filter((d) => d.checked && !d.blocker && !(byView[d.view] && byView[d.view].visible)).map((d) => d.view);
}

/** Filesystem-safe piece of a name for an output file name (as `ui/inference-jobs.js` `safeFilePart`). */
export function safePart(name) {
  const s = String(name == null ? "" : name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return s || "x";
}

/** `/` joins, without doubling the slash. */
function joinWorker(dir, name) {
  const clean = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  return clean === "/" || clean === "" ? `/${name}` : `${clean}/${name}`;
}

/** Forward slashes, no `.` parts, no empty parts (a leading `/` is kept). */
function normLocal(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const lead = s.startsWith("/") ? "/" : "";
  return lead + s.split("/").filter((x) => x && x !== ".").join("/");
}

function isAbsolutePath(p) {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p || ""));
}

/**
 * The session's root as the rules know it: the name of the folder the user picked (the first
 * component of any view's `webkitRelativePath`), else the session's name.
 * @param {Array<{relPath?: string}>} descs
 * @param {string} sessionName
 */
export function sessionRootOf(descs, sessionName) {
  for (const d of descs) {
    const parts = normLocal(d.relPath).split("/").filter(Boolean);
    if (parts.length > 1) return parts[0];
  }
  return String(sessionName || "").replace(/[\\/]+/g, "_") || "session";
}

/**
 * Every "local" spelling of a view's video, best first. `absPath` is a real disk path (the
 * desktop app knows the files the user opened); `videoPath` is what the `.slp` / session recorded
 * (may be absolute from another machine, or relative); `relPath` is the browser's
 * `webkitRelativePath` (`<picked folder>/cam1/0.mp4`).
 *
 * @param {{view: string, fileName?: string, relPath?: string, videoPath?: string, absPath?: string}} d
 * @param {string} root the session root (`sessionRootOf`)
 * @returns {string[]}
 */
export function localCandidates(d, root) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  if (d.absPath) add(normLocal(d.absPath));
  if (d.videoPath && isAbsolutePath(d.videoPath)) add(normLocal(d.videoPath));
  const rel = normLocal(d.relPath);
  if (rel) add(rel);
  const vp = normLocal(d.videoPath);
  if (vp && !isAbsolutePath(d.videoPath)) add(vp.startsWith(root + "/") ? vp : `${root}/${vp}`);
  if (d.fileName) add(`${root}/${d.fileName}`);
  return out;
}

/**
 * The spelling the rules / mounts can place on the worker, else the best one.
 * @param {string[]} candidates
 * @param {{rules: Array<{local: string, worker: string}>, mounts: string[]}} ctx
 * @returns {string | null}
 */
export function chooseLocalPath(candidates, ctx) {
  for (const c of candidates) {
    if (isWorkerPath(c, ctx.mounts) || translatePath(c, ctx.rules) !== null) return c;
  }
  return candidates[0] ?? null;
}

/**
 * Where each view's video is on the worker.
 *
 * @param {Array<{view: string, fileName?: string, relPath?: string, videoPath?: string, absPath?: string}>} descs
 * @param {{
 *   rules: Array<{local: string, worker: string}>,
 *   mounts: string[],
 *   stat: (workerPath: string) => Promise<any>,
 *   sessionName: string,
 *   concurrency?: number,
 * }} deps
 * @returns {Promise<Array<{view: string, local: string | null, worker: string | null, visible: boolean, reason?: string}>>}
 */
export async function resolveViewVideos(descs, deps) {
  const root = sessionRootOf(descs, deps.sessionName);
  const locals = descs.map((d) => chooseLocalPath(localCandidates(d, root), deps));
  const checked = await checkVideoVisibility(
    locals.map((l) => l ?? ""),
    { rules: deps.rules, mounts: deps.mounts, stat: deps.stat, concurrency: deps.concurrency },
  );
  return descs.map((d, i) => {
    const c = checked[i];
    if (locals[i] === null) return { view: d.view, local: null, worker: null, visible: false, reason: "no-location" };
    // A relative local key the worker "found" against its own working folder is a coincidence, not a location.
    if (c.visible && !String(c.worker).startsWith("/")) {
      return { view: d.view, local: locals[i], worker: null, visible: false, reason: "no-location" };
    }
    return c.visible
      ? { view: d.view, local: locals[i], worker: c.worker, visible: true }
      : { view: d.view, local: locals[i], worker: null, visible: false, reason: c.reason ?? "not-found" };
  });
}

/** A short line for a view's row: where its video is on the worker, or why it is not. */
export function describeViewStatus(r) {
  if (r.visible) return r.worker;
  switch (r.reason) {
    case "no-location": return "not located on the worker yet";
    case "outside-shares": return "outside the worker's shared folders";
    case "error": return "could not be checked on the worker";
    default: return "not found on the worker";
  }
}

/**
 * Views that resolved to the same worker file.
 * @param {Array<{view: string, worker: string | null, visible: boolean}>} resolved only the views that would run
 * @returns {Array<{worker: string, views: string[]}>}
 */
export function duplicateTargets(resolved) {
  const by = new Map();
  for (const r of resolved) {
    if (!r.visible || !r.worker) continue;
    const list = by.get(r.worker) ?? [];
    list.push(r.view);
    by.set(r.worker, list);
  }
  return [...by].filter(([, views]) => views.length > 1).map(([worker, views]) => ({ worker, views }));
}

/** The refusal for `duplicateTargets` (what is wrong, then what to do). */
export function duplicateTargetsMessage(dups) {
  const d = dups[0];
  const more = dups.length > 1 ? ` (and ${dups.length - 1} more shared file${dups.length > 2 ? "s" : ""})` : "";
  return (
    `${d.views.join(" and ")} point at the same file on the worker (${d.worker})${more}. ` +
    "Each view needs its own video: use Locate on worker… to pick the right one for each."
  );
}

/**
 * The path rule to remember after the user locates `view`'s video on the worker. When the local
 * key is `<root>/<rest>` and the worker file ends with `<rest>`, the whole session root maps to
 * the worker folder holding `<rest>` (one Locate then covers every view). Otherwise the generic
 * rule of sleap-app's Locate-on-worker (`inferRuleFromLocate`).
 *
 * @param {string} local the view's local key
 * @param {string} worker the worker path the user picked
 * @param {string} root the session root
 * @returns {{local: string, worker: string}}
 */
export function inferLocateRule(local, worker, root) {
  if (local.startsWith(root + "/")) {
    const rest = local.slice(root.length); // "/cam1/0.mp4"
    if (worker.endsWith(rest) && worker.length > rest.length) {
      return { local: root, worker: worker.slice(0, worker.length - rest.length) };
    }
  }
  return inferRuleFromLocate(local, worker);
}

/**
 * `<output dir>/predictions/<session>__<view>.<stamp>.predictions.slp`, or straight in the output
 * dir when it has no `predictions` folder (the worker does not create folders for an explicit
 * `output_path`, and the protocol has no mkdir).
 *
 * @param {{dir: string, hasPredictionsDir: boolean, session: string, view: string, stamp: string}} o
 */
export function remoteOutputPath(o) {
  const base = o.hasPredictionsDir ? joinWorker(o.dir, "predictions") : o.dir;
  return joinWorker(base, `${safePart(o.session)}__${safePart(o.view)}.${o.stamp}.predictions.slp`);
}

/**
 * The `track` spec of one view: sleap-app's `buildRemoteTrackSpecs` for the config with this view's
 * video as the data, then the LUCID differences (see the header).
 *
 * @param {Record<string, any>} config the panel's inference config (`modelPaths` = worker paths)
 * @param {{view: string, workerPath: string, framesSpec: string | null, frameCount: number}} v
 * @param {{outputPath: string, project: {name: string, id: string}}} ctx
 */
export function buildViewSpec(config, v, ctx) {
  const [spec] = buildRemoteTrackSpecs(
    { ...config, frameRange: "video", videoIndex: "all", ensureChannels: config.ensureChannels ?? "auto" },
    {
      dataPath: v.workerPath,
      pathMappings: {},
      videoFrameCounts: [v.frameCount],
      currentFrameIdx: 0,
      activeVideoFrameCount: v.frameCount,
    },
  );
  const out = { ...spec };
  delete out.exclude_user_labeled; // the frames list already left them out
  delete out.video_index;
  delete out.frame_filter;
  if (v.framesSpec) out.frames = v.framesSpec;
  out.output_path = ctx.outputPath;
  out.project = ctx.project;
  // Drop the keys buildRemoteTrackSpecs leaves `undefined` (they would not survive JSON anyway).
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * The whole run: one job per view that can run, in view order.
 *
 * @param {{
 *   config: Record<string, any>,
 *   session: string,
 *   views: Array<{view: string, workerPath: string | null, framesSpec: string | null, frameCount: number, skip?: string | null}>,
 *   outputDir: string | null,
 *   hasPredictionsDir: boolean,
 *   stamp: string,
 *   project: {name: string, id: string},
 *   models: string[],
 * }} o
 * @returns {{jobs: Array<{view: string, spec: Record<string, any>, outputPath: string}>, skipped: Array<{view: string, reason: string}>, error: string | null}}
 */
export function planRemoteRun(o) {
  const skipped = [];
  const jobs = [];
  const fail = (error) => ({ jobs: [], skipped, error });
  if (!o.models || o.models.length === 0) return fail("Add a model on the worker.");
  if (!o.outputDir) return fail("Choose an output folder on the worker.");
  const ready = [];
  for (const v of o.views) {
    if (v.skip) skipped.push({ view: v.view, reason: v.skip });
    else if (!v.workerPath) skipped.push({ view: v.view, reason: "its video is not on the worker" });
    else if (v.framesSpec === "") skipped.push({ view: v.view, reason: "no frames to run" });
    else ready.push(v);
  }
  if (ready.length === 0) return fail("No view has a video on the worker and frames to run.");
  for (const v of ready) {
    if (v.framesSpec && v.framesSpec.length > MAX_FRAMES_SPEC_CHARS) return fail(framesTooLongMessage(v.view, v.framesSpec.length));
  }
  const dups = duplicateTargets(ready.map((v) => ({ view: v.view, worker: v.workerPath, visible: true })));
  if (dups.length) return fail(duplicateTargetsMessage(dups));
  for (const v of ready) {
    const outputPath = remoteOutputPath({
      dir: o.outputDir, hasPredictionsDir: o.hasPredictionsDir, session: o.session, view: v.view, stamp: o.stamp,
    });
    const spec = buildViewSpec({ ...o.config, modelPaths: o.models }, v, { outputPath, project: o.project });
    jobs.push({ view: v.view, spec, outputPath });
  }
  return { jobs, skipped, error: null };
}

/**
 * Tracked jobs of this project whose predictions are waiting to be loaded (completed on the
 * worker, not yet fetched).
 *
 * @param {Array<Record<string, any>>} trackedJobs `store.trackedJobs`
 * @param {{projectTagId: string, workerId?: string | null}} o
 */
export function pendingFetches(trackedJobs, o) {
  return trackedJobs.filter(
    (j) =>
      j.kind === "track" &&
      j.state === "completed" &&
      j.camera !== undefined &&
      j.sessionId !== undefined &&
      j.projectTag === o.projectTagId &&
      (j.fetchedAt === null || j.fetchedAt === undefined) &&
      (!o.workerId || j.workerId === o.workerId),
  );
}

/**
 * Frame progress from a log line of the job: sleap-nn's `--gui` JSON, else the rich progress bar
 * line (`42%|████ | 420/1000 [00:10<00:14, 41.9it/s]` or `Predicting... 42% 420/1000`), else null.
 * `rate` / `eta` are 0 when the line has none (the rich line's `<eta` is `mm:ss` or `h:mm:ss`).
 */
export function progressFromLine(line) {
  const s = String(line || "").trim();
  if (s.charAt(0) === "{") {
    try {
      const d = JSON.parse(s);
      if (d && typeof d === "object" && "n_processed" in d && "n_total" in d) {
        return { done: Number(d.n_processed) || 0, total: Number(d.n_total) || 0, rate: Number(d.rate) || 0, eta: Number(d.eta) || 0 };
      }
    } catch {
      /* not JSON */
    }
    return null;
  }
  const m = /(\d+(?:\.\d+)?)%[^\d]*?(\d+)\s*\/\s*(\d+)/.exec(s);
  if (!m) return null;
  const done = Number(m[2]);
  const total = Number(m[3]);
  if (!(total > 0) || done > total) return null;
  const rate = /([\d.]+)\s*(it|frames?)\/s/.exec(s);
  const eta = /<\s*(?:(\d+):)?(\d+):(\d+)/.exec(s);
  return {
    done, total,
    rate: rate ? Number(rate[1]) || 0 : 0,
    eta: eta ? (Number(eta[1] || 0) * 3600 + Number(eta[2]) * 60 + Number(eta[3])) : 0,
  };
}

/** The newest frame progress in a log. */
export function lastProgress(lines) {
  for (let i = (lines?.length ?? 0) - 1; i >= 0; i--) {
    const p = progressFromLine(lines[i]);
    if (p) return p;
  }
  return null;
}

/**
 * The newest line of a job log that names an exception (`PermissionError: [Errno 13] ...`,
 * `torch.OutOfMemoryError: ...`), or null. The worker's own failure detail is often only
 * "exit code 1"; the reason is the last traceback line.
 * @param {string[] | null | undefined} lines
 * @returns {string | null}
 */
export function lastErrorLine(lines) {
  for (let i = (lines?.length ?? 0) - 1; i >= 0; i--) {
    const s = String(lines[i] ?? "").trim();
    if (/^[A-Za-z_][\w.]*(Error|Exception)\b/.test(s)) return s.length > 240 ? s.slice(0, 237) + "..." : s;
  }
  return null;
}
