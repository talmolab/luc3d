/**
 * Port of sleap-app src/lib/projectTag.ts @ 683a159.
 *
 * LUCID changes: added `lucidProjectTag({ fileName, sessionFolders })` (below); `projectTag` itself is unchanged.
 */
/**
 * A short, stable, human-meaningful tag for the project attached to a remote
 * job (PR3, docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3a.5) — lets
 * a worker's job list/history (sleap-connect #98's `job.project`, the same
 * `JobProject` shape) show which project submitted a job without the app
 * ever sending a full local path. Pure and synchronous: both fields are
 * derived directly from `projectPath`, nothing else.
 */

/**
 * `JobProject`, the shape sleap-connect's `job.project` carries.
 * @typedef {{ name: string, id: string }} JobProject
 */

/** Last path segment of a filesystem path (handles both `/` and `\`). */
/** @param {string} p */
function basename(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 32-bit FNV-1a hash, formatted as 8 lowercase hex digits — fast,
 * dependency-free, and deterministic across platforms/runs. Collisions are a
 * non-issue here: this is a display tag for a job list, not an identity or
 * security key.
 */
/** @param {string} input */
function fnv1aHex8(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `name` is the project file's basename, or `"untitled.slp"` for an unsaved
 * project (`projectPath === null`). `id` is an 8-hex FNV-1a hash of the full
 * path — or of `""` for an unsaved project, so every untitled project tags
 * the same way (there's no path to disambiguate them by anyway).
 */
/**
 * @param {string | null} projectPath
 * @returns {JobProject}
 */
export function projectTag(projectPath) {
  return {
    name: projectPath ? basename(projectPath) : "untitled.slp",
    id: fnv1aHex8(projectPath ?? ""),
  };
}

/**
 * LUCID's project tag. A LUCID project is one `.slp` plus one or more session
 * folders, and the app has no single filesystem path for it (the `.slp` is
 * often a handle picked in the browser, and a project can be reopened from a
 * different folder or machine), so the tag is built from NAMES only:
 *
 *  - `name` is the project file's basename (`"untitled.slp"` when there is no
 *    file yet) — what the worker's job list shows.
 *  - `id` is the same 8-hex FNV-1a hash as `projectTag`, over the file name
 *    plus every session's folder name, sorted. Sorting makes it independent of
 *    session order; using names, not full paths, keeps it stable across
 *    reopen (and across moving the project to another drive), while two
 *    projects with the same file name but different sessions still differ.
 *
 * `fileName` and each `sessionFolders` entry may be a bare name or a path
 * (the last segment is used). With neither a file name nor any session
 * folder, this equals `projectTag(null)`.
 *
 * @param {{ fileName?: string | null, sessionFolders?: Array<string | null | undefined> | null }} project
 * @returns {JobProject}
 */
export function lucidProjectTag({ fileName, sessionFolders } = {}) {
  const file = fileName ? basename(fileName) : "";
  const folders = (sessionFolders ?? [])
    .filter((f) => typeof f === "string" && f.length > 0)
    .map((f) => basename(f.replace(/[\\/]+$/, "")))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const key = file || folders.length > 0 ? `${file}\n${folders.join("\n")}` : "";
  return { name: file || "untitled.slp", id: fnv1aHex8(key) };
}
