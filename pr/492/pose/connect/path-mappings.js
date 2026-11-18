/**
 * Port of sleap-app src/lib/pathMappings.ts @ 683a159.
 *
 * LUCID changes: `loadSavedMappings(storage)` / `saveMapping(mapping, storage)` take an injected
 * file-storage adapter (`PathMappingsStorage`) instead of Tauri plugin-fs + `isTauri`; with none
 * they are no-ops (sleap-app's browser behavior). Everything else is verbatim.
 */
/**
 * Path mapping utilities for translating between local and remote worker
 * filesystem paths during remote training/inference.
 *
 * Mappings are stored in ~/.sleap-connect/config.toml as [[path_mappings]]
 * entries (~/.sleap-rtc/config.toml before the rename, still read).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ local: string, worker: string }} PathMapping
 * @typedef {{ local: string, worker: string | null, status: "resolved" | "worker-path" | "unresolved" }} ResolvedPath
 */

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Translate a local path to a worker path using longest-prefix match.
 *
 * Strips trailing slashes from prefixes before matching. Ensures the match
 * occurs on a directory boundary (next char after prefix is "/" or end of string).
 */
export function translatePath(
  localPath,
  mappings,
) {
  if (mappings.length === 0) return null;

  let bestMatch = null;
  let bestLen = 0;

  for (const mapping of mappings) {
    const prefix = mapping.local.replace(/\/+$/, "");
    if (localPath.startsWith(prefix)) {
      // Check boundary: next char must be "/" or end of string
      const nextChar = localPath[prefix.length];
      if (nextChar === undefined || nextChar === "/") {
        if (prefix.length > bestLen) {
          bestLen = prefix.length;
          bestMatch = mapping;
        }
      }
    }
  }

  if (!bestMatch) return null;

  const normalizedLocal = bestMatch.local.replace(/\/+$/, "");
  const normalizedWorker = bestMatch.worker.replace(/\/+$/, "");
  const suffix = localPath.slice(normalizedLocal.length);
  return normalizedWorker + suffix;
}

/**
 * Check if a path starts with any known worker mount prefix.
 */
export function isWorkerPath(path, workerMounts) {
  for (const mount of workerMounts) {
    const normalized = mount.replace(/\/+$/, "");
    if (path.startsWith(normalized)) {
      const nextChar = path[normalized.length];
      if (nextChar === undefined || nextChar === "/") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect the prefix difference between a local path and a worker path by
 * finding the common suffix (from the end) and extracting the differing
 * head portions.
 *
 * Returns null if there is no meaningful common suffix (need at least one
 * shared path segment beyond the filename).
 */
export function detectPrefixDiff(
  localPath,
  workerPath,
) {
  const localParts = localPath.split("/");
  const workerParts = workerPath.split("/");

  // Find how many segments match from the end
  let commonCount = 0;
  let li = localParts.length - 1;
  let wi = workerParts.length - 1;

  while (li >= 0 && wi >= 0) {
    if (localParts[li] === workerParts[wi]) {
      commonCount++;
      li--;
      wi--;
    } else {
      break;
    }
  }

  // Need at least 2 common segments (e.g., "dir/file.mp4") to be meaningful
  if (commonCount < 2) return null;

  // The prefix is everything before the common suffix
  const localPrefix = localParts.slice(0, localParts.length - commonCount).join("/");
  const workerPrefix = workerParts.slice(0, workerParts.length - commonCount).join("/");

  if (!localPrefix || !workerPrefix) return null;

  return { local: localPrefix, worker: workerPrefix };
}

/**
 * Build a path_mappings dict from resolved path pairs.
 * Excludes pairs where local === worker (no mapping needed).
 */
export function buildPathMappings(
  paths,
) {
  const result = {};
  for (const { local, worker } of paths) {
    if (local !== worker) {
      result[local] = worker;
    }
  }
  return result;
}

/**
 * Parse [[path_mappings]] entries from TOML content.
 *
 * Uses a simple line-by-line parser that looks for [[path_mappings]] section
 * headers and extracts local/worker key-value pairs.
 */
export function parsePathMappingsFromToml(content) {
  if (!content.trim()) return [];

  const mappings = [];
  const lines = content.split("\n");

  let inSection = false;
  let current = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for [[path_mappings]] header
    if (trimmed === "[[path_mappings]]") {
      // Save previous entry if complete
      if (inSection && current.local && current.worker) {
        mappings.push({ local: current.local, worker: current.worker });
      }
      inSection = true;
      current = {};
      continue;
    }

    // Check for other section headers (exits current section)
    if (trimmed.startsWith("[") && trimmed !== "[[path_mappings]]") {
      if (inSection && current.local && current.worker) {
        mappings.push({ local: current.local, worker: current.worker });
      }
      inSection = false;
      current = {};
      continue;
    }

    // Parse key = "value" lines within section
    if (inSection) {
      const match = trimmed.match(/^(local|worker)\s*=\s*"([^"]*)"$/);
      if (match) {
        const [, key, value] = match;
        current[key] = value;
      }
    }
  }

  // Don't forget the last entry
  if (inSection && current.local && current.worker) {
    mappings.push({ local: current.local, worker: current.worker });
  }

  return mappings;
}

/**
 * Categorize each local path as resolved, worker-path, or unresolved.
 *
 * Priority:
 * 1. If the path already starts with a worker mount -> "worker-path"
 * 2. If translatable via saved mappings -> "resolved"
 * 3. Otherwise -> "unresolved"
 */
export function resolveProjectPaths(
  localPaths,
  savedMappings,
  workerMounts,
) {
  return localPaths.map((localPath) => {
    // Check if it's already a worker path
    if (isWorkerPath(localPath, workerMounts)) {
      return { local: localPath, worker: localPath, status: "worker-path" };
    }

    // Try to translate using saved mappings
    const translated = translatePath(localPath, savedMappings);
    if (translated !== null) {
      return { local: localPath, worker: translated, status: "resolved" };
    }

    // Unresolved
    return { local: localPath, worker: null, status: "unresolved" };
  });
}

// ---------------------------------------------------------------------------
// Persistence (injected storage adapter)
// ---------------------------------------------------------------------------

/**
 * File access the persistence functions need. sleap-app used Tauri's
 * `plugin-fs` + `api/path` (desktop only); here the caller injects the same
 * five operations (LUCID desktop: its shell's file commands). With no adapter
 * (a plain browser, or a shell without file access) both functions are no-ops.
 *
 * @typedef {{
 *   homeDir: () => Promise<string>,
 *   join: (...paths: string[]) => Promise<string>,
 *   exists: (path: string) => Promise<boolean>,
 *   readTextFile: (path: string) => Promise<string>,
 *   writeTextFile: (path: string, content: string) => Promise<void>,
 *   mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>,
 * }} PathMappingsStorage
 */

// The current folder first, then its name before the sleap-rtc → sleap-connect
// rename (the worker moves it on first run, leaving a symlink on macOS/Linux).
const CONFIG_DIRS = [".sleap-connect", ".sleap-rtc"];
const CONFIG_FILE = "config.toml";

/**
 * The config folder in use: the first that exists, else the current name.
 * @param {string} home
 * @param {PathMappingsStorage["join"]} join
 * @param {PathMappingsStorage["exists"]} exists
 */
async function configDir(home, join, exists) {
  for (const name of CONFIG_DIRS) {
    const dir = await join(home, name);
    if (await exists(dir)) return dir;
  }
  return join(home, CONFIG_DIRS[0]);
}

/**
 * Load saved path mappings from ~/.sleap-connect/config.toml.
 * Returns empty array with no storage adapter or if the file doesn't exist.
 * @param {PathMappingsStorage | null} [storage]
 * @returns {Promise<PathMapping[]>}
 */
export async function loadSavedMappings(storage = null) {
  if (!storage) return [];

  try {
    const { readTextFile, exists, homeDir, join } = storage;

    const home = await homeDir();
    const configPath = await join(await configDir(home, join, exists), CONFIG_FILE);

    if (!(await exists(configPath))) return [];

    const content = await readTextFile(configPath);
    return parsePathMappingsFromToml(content);
  } catch (err) {
    console.warn("[pathMappings] Failed to load saved mappings:", err);
    return [];
  }
}

/**
 * Save a new path mapping to ~/.sleap-connect/config.toml.
 * Appends to the file (does not overwrite existing mappings).
 * No-op with no storage adapter.
 * @param {PathMapping} mapping
 * @param {PathMappingsStorage | null} [storage]
 * @returns {Promise<void>}
 */
export async function saveMapping(mapping, storage = null) {
  if (!storage) return;

  try {
    const { readTextFile, writeTextFile, exists, mkdir, homeDir, join } = storage;

    const home = await homeDir();
    const dirPath = await configDir(home, join, exists);
    const configPath = await join(dirPath, CONFIG_FILE);

    // Ensure directory exists
    if (!(await exists(dirPath))) {
      await mkdir(dirPath, { recursive: true });
    }

    // Read existing content
    let content = "";
    if (await exists(configPath)) {
      content = await readTextFile(configPath);
    }

    // Check if this mapping already exists
    const existing = parsePathMappingsFromToml(content);
    const alreadyExists = existing.some(
      (m) => m.local === mapping.local && m.worker === mapping.worker,
    );
    if (alreadyExists) return;

    // Append the new mapping
    const entry = `\n[[path_mappings]]\nlocal = "${mapping.local}"\nworker = "${mapping.worker}"\n`;
    await writeTextFile(configPath, content + entry);
  } catch (err) {
    console.warn("[pathMappings] Failed to save mapping:", err);
  }
}
