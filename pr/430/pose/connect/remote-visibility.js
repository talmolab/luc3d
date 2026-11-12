/**
 * Port of sleap-app src/lib/remoteVisibility.ts @ 683a159.
 *
 * LUCID changes:
 *  - `projectVideoPaths` also accepts a plain array: of path strings (LUCID passes one
 *    path per (session, camera) video — videos are per camera view and a project has several
 *    sessions) or of `{ filename: string | string[] }` video-like objects. A sleap-io
 *    `Labels` (anything with a `.videos` array) still works exactly as in sleap-app.
 *  - Types are JSDoc; `Labels` is not imported. `checkVideoVisibility`, `classifyVisibility`
 *    and `inferRuleFromLocate` are verbatim.
 */
/**
 * Per-video "can the worker see this?" check for remote training/inference
 * (PR3, docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3a.3). Pure:
 * everything it needs (path rules, worker mounts, a `stat` probe) is passed
 * in — no store/connectStore dependency here, so it's trivially testable and
 * reusable from both the data-summary UI (PR3b) and `trainingStore`.
 */
import { isWorkerPath, translatePath, detectPrefixDiff } from "./path-mappings.js?v=82449baaa3c2";

/**
 * @typedef {import("./path-mappings.js?v=82449baaa3c2").PathMapping} PathMapping
 *
 * @typedef {"no-location" | "not-found" | "outside-shares" | "error"} HiddenReason
 *
 * @typedef {{
 *   index: number,
 *   local: string,
 *   worker: string | null,
 *   visible: boolean,
 *   reason?: HiddenReason,
 *   shared?: boolean,
 * }} VideoVisibility
 *   `worker`: the worker-side path this video would resolve to, or `null` if none could be
 *   computed at all ("no-location"). `shared`: false when visible but outside the worker's
 *   shared folders (can't be browsed there).
 *
 * @typedef {boolean | { exists: boolean, shared?: boolean, forbidden?: boolean }} StatProbe
 *   What a `stat` probe reports: just "exists", or the worker's fuller answer.
 *
 * @typedef {"all" | "some" | "none"} VisibilityCase
 */

/**
 * Why a video isn't visible on the worker (`HiddenReason`):
 * - "no-location": no shared-folder prefix and no path rule covers it, and
 *   the local path itself doesn't exist on the worker either.
 * - "not-found": we have a candidate path, but the worker's `fs.stat` says
 *   it doesn't exist there.
 * - "outside-shares": the candidate isn't under a shared folder and the
 *   worker won't say whether it exists (an older worker refuses `fs.stat`
 *   outside its shared folders).
 * - "error": the `stat` call itself failed (e.g. a dropped connection).
 *
 * A newer worker does confirm paths outside its shared folders exist (jobs
 * can read media there): those count as visible, with `shared: false`.
 */

/** What a `stat` probe reports: just "exists", or the worker's fuller answer (`StatProbe`). */

const DEFAULT_CONCURRENCY = 8;

/**
 * A video's own path(s) the same way `trainingStore` has always read them: a string, or an
 * image-sequence video's first frame. LUCID: also accepts a plain array of path strings or of
 * `{ filename }` objects (see the header).
 *
 * @param {{ videos: Array<{ filename: string | string[] }> } | Array<string | { filename: string | string[] }>} labels
 * @returns {string[]}
 */
export function projectVideoPaths(labels) {
  const videos = Array.isArray(labels) ? labels : labels.videos;
  return videos.map((video) => {
    if (typeof video === "string") return video;
    return typeof video.filename === "string" ? video.filename : video.filename[0];
  });
}

/**
 * Checks every video path against the worker, bounded to `deps.concurrency`
 * (default 8) concurrent `stat` calls. The candidate is the path itself when
 * it's already under a shared folder, else the path-rule translation, else
 * the path as-is (the same path may exist on both machines).
 *
 * @param {string[]} videoPaths
 * @param {{
 *   rules: PathMapping[],
 *   mounts: string[],
 *   stat: (workerPath: string) => Promise<StatProbe>,
 *   concurrency?: number,
 * }} deps
 * @returns {Promise<VideoVisibility[]>}
 */
export async function checkVideoVisibility(videoPaths, deps) {
  // Whether each candidate came from a shared folder or a path rule (vs. the
  // bare local path, which says "no-location" rather than "not-found").
  const located = [];
  const results = videoPaths.map((local, index) => {
    const mapped = isWorkerPath(local, deps.mounts) ? local : translatePath(local, deps.rules);
    located[index] = mapped !== null;
    // Pending: needs a `stat` call below. `reason` stays unset as the marker.
    return { index, local, worker: mapped ?? local, visible: false };
  });

  const pending = results
    .map((r, i) => (r.reason === undefined ? i : -1))
    .filter((i) => i >= 0);

  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  const runOne = async () => {
    while (cursor < pending.length) {
      const i = pending[cursor++];
      const r = results[i];
      try {
        const probe = await deps.stat(r.worker);
        const { exists, shared, forbidden } =
          typeof probe === "boolean" ? { exists: probe, shared: undefined, forbidden: false } : probe;
        if (exists) {
          results[i] = shared === false ? { ...r, visible: true, shared: false } : { ...r, visible: true };
        } else if (!located[i]) {
          results[i] = { ...r, worker: null, visible: false, reason: "no-location" };
        } else {
          results[i] = { ...r, visible: false, reason: forbidden ? "outside-shares" : "not-found" };
        }
      } catch {
        results[i] = { ...r, visible: false, reason: "error" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runOne));

  return results;
}

/**
 * `[]` counts as "all" — there's nothing hidden to warn about.
 * @param {VideoVisibility[]} v
 * @returns {VisibilityCase}
 */
export function classifyVisibility(v) {
  if (v.length === 0) return "all";
  const visibleCount = v.filter((x) => x.visible).length;
  if (visibleCount === v.length) return "all";
  if (visibleCount === 0) return "none";
  return "some";
}

/**
 * The path rule to remember after the user manually locates a hidden video
 * on the worker (RemoteFileBrowser's "Locate on worker…", PR3b) — a
 * directory-prefix rule when one's detectable (so sibling videos under the
 * same moved directory resolve automatically too), else an exact single-file
 * rule.
 *
 * @param {string} local
 * @param {string} worker
 * @returns {PathMapping}
 */
export function inferRuleFromLocate(local, worker) {
  return detectPrefixDiff(local, worker) ?? { local, worker };
}
