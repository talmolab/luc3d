/**
 * Port of sleap-app src/lib/connectSync.ts @ 683a159.
 *
 * LUCID changes: types become JSDoc; `PairedWorker` / `TrackedJob` live in the store port. No behavior change.
 */
/**
 * Merging the Connect state that every window shares (#453). Each window
 * keeps its own in-memory copy and saves it to one localStorage key, so a
 * plain overwrite lets a stale window undo another's pairings, forgets, path
 * rules and tracked jobs. Instead, a save is a three-way merge: `base` is the
 * shared copy this window last read or wrote, `mine` is its current state,
 * `theirs` is what's stored now. Only the records this window changed since
 * `base` are taken from `mine`; everything else comes from `theirs`.
 *
 * Pure — no store, no storage — so the rules are testable on their own.
 */

/**
 * The slice of the Connect store every window shares.
 * @typedef {{
 *   pairedWorkers: Array<{ nodeId: string } & Record<string, any>>,
 *   trackedJobs: Array<{ jobId: string, state: string, error?: string, lastSeq: number, seen: boolean } & Record<string, any>>,
 *   deviceName: string | null,
 *   lastSelectedWorkerId: string | null,
 * }} SharedConnectState `lastSelectedWorkerId` is the worker some window most recently selected — a new window's starting selection.
 */

/** JSON with object keys sorted, so equal records compare equal whatever order their keys were set in. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const same = (a, b) => stableStringify(a) === stableStringify(b);

/**
 * Merges one keyed list. Per key: unchanged here → theirs (including their
 * delete); unchanged there → mine (including my delete); changed on both →
 * a delete wins, else `resolve(mine, theirs)`. With no base nothing counts as
 * deleted: both sides are unioned. Order: theirs, then keys new in mine.
 */
function mergeRecords(
  base,
  mine,
  theirs,
  key,
  resolve,
) {
  const baseBy = new Map((base ?? []).map((r) => [key(r), r]));
  const mineBy = new Map(mine.map((r) => [key(r), r]));
  const theirsBy = new Map(theirs.map((r) => [key(r), r]));

  const pick = (k) => {
    const b = baseBy.get(k);
    const m = mineBy.get(k);
    const t = theirsBy.get(k);
    if (base === null) {
      if (m && t) return resolve(m, t);
      return t ?? m;
    }
    if (same(m, b)) return t;
    if (same(t, b)) return m;
    if (!m || !t) return undefined;
    return resolve(m, t);
  };

  const out = [];
  const done = new Set();
  for (const r of [...theirs, ...mine]) {
    const k = key(r);
    if (done.has(k)) continue;
    done.add(k);
    const picked = pick(k);
    if (picked) out.push(picked);
  }
  return out;
}

/** A job both sides changed: progress never goes backwards, and a finished state beats `active`. */
function mergeJob(mine, theirs) {
  const finished = mine.state !== "active" ? mine : theirs.state !== "active" ? theirs : mine;
  // LUCID: `fetchedAt` (set by `markJobFetched`) carries across windows; the latest non-null wins.
  const fetchedAt = Math.max(mine.fetchedAt ?? 0, theirs.fetchedAt ?? 0) || null;
  return {
    ...mine,
    state: finished.state,
    error: finished.error,
    lastSeq: Math.max(mine.lastSeq, theirs.lastSeq),
    seen: mine.seen || theirs.seen,
    ...(fetchedAt !== null ? { fetchedAt } : {}),
  };
}

/**
 * A job's progress, finished state and `seen` only ever move forward, so
 * whichever side's record was picked, keep the furthest of both — even a
 * copy saved by a window that didn't merge can't move a job backwards.
 */
function keepJobsMonotonic(merged, mine, theirs) {
  const mineBy = new Map(mine.map((j) => [j.jobId, j]));
  const theirsBy = new Map(theirs.map((j) => [j.jobId, j]));
  return merged.map((j) => {
    const other = j === mineBy.get(j.jobId) ? theirsBy.get(j.jobId) : mineBy.get(j.jobId);
    return other ? mergeJob(j, other) : j;
  });
}

function mergeScalar(base, mine, theirs) {
  return base !== undefined && same(mine, base) ? theirs : mine;
}

/**
 * Three-way merge of the shared Connect state; `base` null = never read (first save of an older copy).
 * @param {SharedConnectState | null} base
 * @param {SharedConnectState} mine
 * @param {SharedConnectState} theirs
 * @returns {SharedConnectState}
 */
export function mergeShared(
  base,
  mine,
  theirs,
) {
  return {
    pairedWorkers: mergeRecords(
      base?.pairedWorkers ?? null,
      mine.pairedWorkers,
      theirs.pairedWorkers,
      (w) => w.nodeId,
      (m) => m,
    ),
    trackedJobs: keepJobsMonotonic(
      mergeRecords(base?.trackedJobs ?? null, mine.trackedJobs, theirs.trackedJobs, (j) => j.jobId, mergeJob),
      mine.trackedJobs,
      theirs.trackedJobs,
    ),
    deviceName: mergeScalar(base?.deviceName, mine.deviceName, theirs.deviceName),
    lastSelectedWorkerId: mergeScalar(
      base?.lastSelectedWorkerId,
      mine.lastSelectedWorkerId,
      theirs.lastSelectedWorkerId,
    ),
  };
}

/**
 * Whether two shared states hold the same data (key order ignored).
 * @param {SharedConnectState} a
 * @param {SharedConnectState} b
 */
export function sameShared(a, b) {
  return same(a, b);
}
