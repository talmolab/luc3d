import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  translatePath,
  buildPathMappings,
  detectPrefixDiff,
  isWorkerPath,
  parsePathMappingsFromToml,
  resolveProjectPaths,
  loadSavedMappings,
  saveMapping,
} from '../pose/connect/path-mappings.js';

const SAVED_MAPPINGS = [
  { local: "/Users/amickl/repos", worker: "/root/vast/amick/repos" },
  { local: "/Users/amickl/data", worker: "/root/vast/amick/data" },
  { local: "/Users/amickl", worker: "/root/vast/amick" },
];

const WORKER_MOUNTS = ["/root/vast/amick", "/workspace"];

describe("translatePath", () => {
  it("translates using longest matching prefix", () => {
    const result = translatePath(
      "/Users/amickl/repos/sleap/tests/video.mp4",
      SAVED_MAPPINGS,
    );
    expect(result).toBe("/root/vast/amick/repos/sleap/tests/video.mp4");
  });

  it("uses shorter prefix when longer doesn't match", () => {
    const result = translatePath(
      "/Users/amickl/other/file.slp",
      SAVED_MAPPINGS,
    );
    expect(result).toBe("/root/vast/amick/other/file.slp");
  });

  it("returns null when no prefix matches", () => {
    const result = translatePath("/opt/videos/test.mp4", SAVED_MAPPINGS);
    expect(result).toBeNull();
  });

  it("returns null for empty mappings", () => {
    const result = translatePath("/Users/amickl/file.mp4", []);
    expect(result).toBeNull();
  });

  it("handles trailing slashes in prefixes", () => {
    const mappings = [{ local: "/Users/amickl/", worker: "/root/vast/amick/" }];
    const result = translatePath("/Users/amickl/data/file.mp4", mappings);
    expect(result).toBe("/root/vast/amick/data/file.mp4");
  });
});

describe("isWorkerPath", () => {
  it("returns true for paths starting with a worker mount", () => {
    expect(isWorkerPath("/root/vast/amick/data/file.mp4", WORKER_MOUNTS)).toBe(
      true,
    );
  });

  it("returns true for path starting with mount + /", () => {
    expect(isWorkerPath("/workspace/project/file.mp4", WORKER_MOUNTS)).toBe(
      true,
    );
  });

  it("returns false for local paths", () => {
    expect(isWorkerPath("/Users/amickl/file.mp4", WORKER_MOUNTS)).toBe(false);
  });

  it("returns false for empty mounts", () => {
    expect(isWorkerPath("/root/vast/amick/file.mp4", [])).toBe(false);
  });
});

describe("detectPrefixDiff", () => {
  it("detects directory prefix difference", () => {
    const result = detectPrefixDiff(
      "/Users/amickl/repos/sleap/video.mp4",
      "/root/vast/amick/repos/sleap/video.mp4",
    );
    expect(result).toEqual({
      local: "/Users/amickl",
      worker: "/root/vast/amick",
    });
  });

  it("returns null when paths share no common suffix", () => {
    const result = detectPrefixDiff(
      "/Users/amickl/video.mp4",
      "/totally/different/other.mp4",
    );
    expect(result).toBeNull();
  });

  it("handles paths with different depths", () => {
    const result = detectPrefixDiff(
      "/Users/amickl/data/videos/test.mp4",
      "/workspace/data/videos/test.mp4",
    );
    expect(result).toEqual({
      local: "/Users/amickl",
      worker: "/workspace",
    });
  });
});

describe("buildPathMappings", () => {
  it("builds dict from resolved paths", () => {
    const paths = [
      { local: "/Users/amickl/a.mp4", worker: "/root/vast/amick/a.mp4" },
      { local: "/Users/amickl/b.mp4", worker: "/root/vast/amick/b.mp4" },
    ];
    const result = buildPathMappings(paths);
    expect(result).toEqual({
      "/Users/amickl/a.mp4": "/root/vast/amick/a.mp4",
      "/Users/amickl/b.mp4": "/root/vast/amick/b.mp4",
    });
  });

  it("excludes paths where local equals worker", () => {
    const paths = [
      { local: "/root/vast/amick/a.mp4", worker: "/root/vast/amick/a.mp4" },
      { local: "/Users/amickl/b.mp4", worker: "/root/vast/amick/b.mp4" },
    ];
    const result = buildPathMappings(paths);
    expect(result).toEqual({
      "/Users/amickl/b.mp4": "/root/vast/amick/b.mp4",
    });
  });

  it("returns empty dict when all paths are identical", () => {
    const paths = [{ local: "/data/a.mp4", worker: "/data/a.mp4" }];
    expect(buildPathMappings(paths)).toEqual({});
  });
});

describe("parsePathMappingsFromToml", () => {
  it("parses [[path_mappings]] entries", () => {
    const toml = `
[[path_mappings]]
local = "/Users/amickl/repos"
worker = "/root/vast/amick/repos"

[[path_mappings]]
local = "/Users/amickl/data"
worker = "/root/vast/amick/data"
`;
    const result = parsePathMappingsFromToml(toml);
    expect(result).toEqual([
      { local: "/Users/amickl/repos", worker: "/root/vast/amick/repos" },
      { local: "/Users/amickl/data", worker: "/root/vast/amick/data" },
    ]);
  });

  it("returns empty array for empty content", () => {
    expect(parsePathMappingsFromToml("")).toEqual([]);
  });

  it("ignores other TOML sections", () => {
    const toml = `
[server]
url = "https://example.com"

[[path_mappings]]
local = "/Users/amickl"
worker = "/root/vast/amick"

[other]
key = "value"
`;
    const result = parsePathMappingsFromToml(toml);
    expect(result).toEqual([
      { local: "/Users/amickl", worker: "/root/vast/amick" },
    ]);
  });
});

describe("resolveProjectPaths", () => {
  it("marks worker paths as worker-path status", () => {
    const result = resolveProjectPaths(
      ["/root/vast/amick/file.slp"],
      [],
      WORKER_MOUNTS,
    );
    expect(result[0].status).toBe("worker-path");
    expect(result[0].worker).toBe("/root/vast/amick/file.slp");
  });

  it("marks translated paths as resolved", () => {
    const result = resolveProjectPaths(
      ["/Users/amickl/repos/file.slp"],
      SAVED_MAPPINGS,
      WORKER_MOUNTS,
    );
    expect(result[0].status).toBe("resolved");
    expect(result[0].worker).toBe("/root/vast/amick/repos/file.slp");
  });

  it("marks untranslatable paths as unresolved", () => {
    const result = resolveProjectPaths(
      ["/opt/unknown/file.slp"],
      SAVED_MAPPINGS,
      WORKER_MOUNTS,
    );
    expect(result[0].status).toBe("unresolved");
    expect(result[0].worker).toBeNull();
  });
});

// LUCID: loadSavedMappings / saveMapping use an injected storage adapter (sleap-app: Tauri plugin-fs).
describe("loadSavedMappings / saveMapping (injected storage)", () => {
  /** In-memory adapter over a { path: text } map plus a set of directories. */
  function memStorage(files = {}, dirs = ["/home/u"]) {
    const dirSet = new Set(dirs);
    return {
      files,
      dirs: dirSet,
      homeDir: async () => "/home/u",
      join: async (...p) => p.join("/"),
      exists: async (p) => p in files || dirSet.has(p),
      readTextFile: async (p) => files[p],
      writeTextFile: async (p, c) => {
        files[p] = c;
      },
      mkdir: async (p) => {
        dirSet.add(p);
      },
    };
  }

  it("are no-ops without an adapter", async () => {
    expect(await loadSavedMappings()).toEqual([]);
    expect(await loadSavedMappings(null)).toEqual([]);
    await saveMapping({ local: "/a", worker: "/b" });
  });

  it("saveMapping creates ~/.sleap-connect/config.toml and loadSavedMappings reads it back", async () => {
    const st = memStorage();
    await saveMapping({ local: "/Users/me/data", worker: "/root/vast/me/data" }, st);
    expect(st.dirs.has("/home/u/.sleap-connect")).toBe(true);
    expect(st.files["/home/u/.sleap-connect/config.toml"]).toBe(
      '\n[[path_mappings]]\nlocal = "/Users/me/data"\nworker = "/root/vast/me/data"\n',
    );
    expect(await loadSavedMappings(st)).toEqual([{ local: "/Users/me/data", worker: "/root/vast/me/data" }]);
  });

  it("appends, and does not duplicate an existing mapping", async () => {
    const st = memStorage();
    await saveMapping({ local: "/a", worker: "/b" }, st);
    await saveMapping({ local: "/a", worker: "/b" }, st);
    await saveMapping({ local: "/c", worker: "/d" }, st);
    expect(await loadSavedMappings(st)).toEqual([
      { local: "/a", worker: "/b" },
      { local: "/c", worker: "/d" },
    ]);
  });

  it("still reads the pre-rename ~/.sleap-rtc folder when ~/.sleap-connect is absent", async () => {
    const st = memStorage(
      { "/home/u/.sleap-rtc/config.toml": '[[path_mappings]]\nlocal = "/x"\nworker = "/y"\n' },
      ["/home/u", "/home/u/.sleap-rtc"],
    );
    expect(await loadSavedMappings(st)).toEqual([{ local: "/x", worker: "/y" }]);
  });

  it("a failing adapter is swallowed (load -> [], save -> no throw)", async () => {
    const bad = {
      ...memStorage(),
      homeDir: async () => {
        throw new Error("denied");
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await loadSavedMappings(bad)).toEqual([]);
      await saveMapping({ local: "/a", worker: "/b" }, bad);
    } finally {
      console.warn = warn;
    }
  });
});

await run();
