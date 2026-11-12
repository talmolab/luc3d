/**
 * Port of sleap-app src/lib/remoteOutputDir.ts @ 683a159.
 *
 * LUCID changes: types become JSDoc; imports point at ./path-mappings.js. No behavior change.
 */
/**
 * Where a "this window" remote run saves its models and predictions on the
 * worker (folder access stage 4). Pure apart from the injected `stat`.
 *
 * Default, in order:
 * 1. the project's own folder on the worker — the local project path, already
 *    a worker path or translated by a path rule, if that folder exists there
 *    inside a shared folder;
 * 2. `<serve folder>/sleap-connect/<project name>/`, if the worker's serve
 *    folder is shared;
 * 3. none — outputs stay in the worker's job folder.
 * The user can pick another folder (Change…), remembered per project+worker.
 */
import { isWorkerPath, translatePath } from "./path-mappings.js?v=82449baaa3c2";

/**
 * @typedef {"project" | "serve-folder" | "chosen"} OutputDirSource
 * @typedef {{ dir: string, source: OutputDirSource }} OutputDirChoice
 */

/** @param {string} path */
function posixDirname(path) {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/**
 * "labels.v002.slp" → "labels.v002" (the folder name under sleap-connect/).
 * @param {string} projectName
 */
export function projectFolderName(projectName) {
  const base = projectName.replace(/\.(pkg\.)?slp$/i, "");
  return base.replace(/[\\/]/g, "_") || "untitled";
}

/**
 * @param {{
 *   projectPath: string | null,
 *   projectName: string,
 *   rules: import("./path-mappings.js?v=82449baaa3c2").PathMapping[],
 *   mounts: string[],
 *   serveFolder: string | null,
 *   isSharedFolder: (path: string) => Promise<boolean>,
 * }} opts `isSharedFolder`: whether `path` is a folder on the worker inside a shared folder.
 * @returns {Promise<OutputDirChoice | null>}
 */
export async function defaultOutputDir(opts) {
  const { projectPath, rules, mounts, serveFolder } = opts;
  if (projectPath) {
    const onWorker = isWorkerPath(projectPath, mounts) ? projectPath : translatePath(projectPath, rules);
    if (onWorker) {
      const dir = posixDirname(onWorker);
      try {
        if (isWorkerPath(dir, mounts) && (await opts.isSharedFolder(dir))) {
          return { dir, source: "project" };
        }
      } catch {
        // Can't tell — fall through to the serve folder.
      }
    }
  }
  if (serveFolder) {
    return {
      dir: `${serveFolder.replace(/\/+$/, "")}/sleap-connect/${projectFolderName(opts.projectName)}`,
      source: "serve-folder",
    };
  }
  return null;
}
