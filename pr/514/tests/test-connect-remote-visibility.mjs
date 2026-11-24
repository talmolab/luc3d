import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  checkVideoVisibility,
  classifyVisibility,
  inferRuleFromLocate,
  projectVideoPaths,

} from '../pose/connect/remote-visibility.js';

const MOUNTS = ["/mnt/data", "/workspace"];
const RULES = [{ local: "/Users/amickl/videos", worker: "/mnt/data/videos" }];

/** Always-resolve stat: every candidate worker path exists. */
function statAlways(exists) {
  return async (_path) => exists;
}

describe("checkVideoVisibility", () => {
  it("all visible: a worker-mount path passes through untranslated, a local path translates via a rule", async () => {
    const videoPaths = ["/mnt/data/a.mp4", "/Users/amickl/videos/b.mp4"];
    const result = await checkVideoVisibility(videoPaths, {
      rules: RULES,
      mounts: MOUNTS,
      stat: statAlways(true),
    });

    expect(result).toEqual([
      { index: 0, local: "/mnt/data/a.mp4", worker: "/mnt/data/a.mp4", visible: true },
      {
        index: 1,
        local: "/Users/amickl/videos/b.mp4",
        worker: "/mnt/data/videos/b.mp4",
        visible: true,
      },
    ]);
    expect(classifyVisibility(result)).toBe("all");
  });

  it("some visible: one found, one not-found", async () => {
    const videoPaths = ["/mnt/data/a.mp4", "/mnt/data/missing.mp4"];
    const result = await checkVideoVisibility(videoPaths, {
      rules: [],
      mounts: MOUNTS,
      stat: async (path) => path === "/mnt/data/a.mp4",
    });

    expect(result[0]).toEqual({ index: 0, local: videoPaths[0], worker: videoPaths[0], visible: true });
    expect(result[1]).toEqual({
      index: 1,
      local: videoPaths[1],
      worker: videoPaths[1],
      visible: false,
      reason: "not-found",
    });
    expect(classifyVisibility(result)).toBe("some");
  });

  it("none visible: every candidate not-found", async () => {
    const videoPaths = ["/mnt/data/a.mp4", "/mnt/data/b.mp4"];
    const result = await checkVideoVisibility(videoPaths, {
      rules: [],
      mounts: MOUNTS,
      stat: statAlways(false),
    });

    expect(result.every((v) => !v.visible && v.reason === "not-found")).toBe(true);
    expect(classifyVisibility(result)).toBe("none");
  });

  it("a path with no mount or rule match is tried as-is; missing there = 'no-location'", async () => {
    const calls = [];
    const result = await checkVideoVisibility(["/opt/unknown/video.mp4"], {
      rules: RULES,
      mounts: MOUNTS,
      stat: async (p) => {
        calls.push(p);
        return { exists: false };
      },
    });

    expect(result).toEqual([
      { index: 0, local: "/opt/unknown/video.mp4", worker: null, visible: false, reason: "no-location" },
    ]);
    expect(calls).toEqual(["/opt/unknown/video.mp4"]);
  });

  it("the same path existing on the worker (outside shared folders) counts as visible, not shared", async () => {
    const result = await checkVideoVisibility(["/data/raw/video.mp4"], {
      rules: [],
      mounts: MOUNTS,
      stat: async () => ({ exists: true, shared: false }),
    });
    expect(result).toEqual([
      { index: 0, local: "/data/raw/video.mp4", worker: "/data/raw/video.mp4", visible: true, shared: false },
    ]);
  });

  it("a rule-translated path outside the shared folders: visible if the worker confirms it exists", async () => {
    const rules = [{ local: "/Users/amickl/other", worker: "/unlisted/dir" }];
    const result = await checkVideoVisibility(["/Users/amickl/other/video.mp4"], {
      rules,
      mounts: MOUNTS,
      stat: async () => ({ exists: true, shared: false }),
    });
    expect(result[0]).toMatchObject({ worker: "/unlisted/dir/video.mp4", visible: true, shared: false });
  });

  it("an older worker that refuses to stat outside its shared folders gives 'outside-shares'", async () => {
    const rules = [{ local: "/Users/amickl/other", worker: "/unlisted/dir" }];
    const result = await checkVideoVisibility(["/Users/amickl/other/video.mp4"], {
      rules,
      mounts: MOUNTS,
      stat: async () => ({ exists: false, forbidden: true }),
    });
    expect(result).toEqual([
      {
        index: 0,
        local: "/Users/amickl/other/video.mp4",
        worker: "/unlisted/dir/video.mp4",
        visible: false,
        reason: "outside-shares",
      },
    ]);
  });

  it("a stat() rejection never throws — the video is marked 'error'", async () => {
    const result = await checkVideoVisibility(["/mnt/data/a.mp4"], {
      rules: [],
      mounts: MOUNTS,
      stat: async () => {
        throw new Error("worker unreachable");
      },
    });

    expect(result).toEqual([
      { index: 0, local: "/mnt/data/a.mp4", worker: "/mnt/data/a.mp4", visible: false, reason: "error" },
    ]);
  });

  it("respects the concurrency cap", async () => {
    const videoPaths = Array.from({ length: 10 }, (_, i) => `/mnt/data/v${i}.mp4`);
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await checkVideoVisibility(videoPaths, {
      rules: [],
      mounts: MOUNTS,
      concurrency: 3,
      stat: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve().then(() => Promise.resolve()); // yield a couple microtask ticks
        inFlight--;
        return true;
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result).toHaveLength(10);
  });

  it("defaults concurrency to 8", async () => {
    const videoPaths = Array.from({ length: 20 }, (_, i) => `/mnt/data/v${i}.mp4`);
    let inFlight = 0;
    let maxInFlight = 0;
    await checkVideoVisibility(videoPaths, {
      rules: [],
      mounts: MOUNTS,
      stat: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve().then(() => Promise.resolve());
        inFlight--;
        return true;
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(3); // proves it's not accidentally serialized
  });

  it("returns [] for an empty input", async () => {
    const result = await checkVideoVisibility([], { rules: [], mounts: MOUNTS, stat: statAlways(true) });
    expect(result).toEqual([]);
  });
});

describe("classifyVisibility", () => {
  it("[] -> 'all'", () => {
    expect(classifyVisibility([])).toBe("all");
  });

  const makeVisibility = (visible) => ({
    index: 0,
    local: "/a",
    worker: "/a",
    visible,
    ...(visible ? {} : { reason: "not-found" }),
  });

  it("every video visible -> 'all'", () => {
    expect(classifyVisibility([makeVisibility(true), makeVisibility(true)])).toBe("all");
  });

  it("a mix -> 'some'", () => {
    expect(classifyVisibility([makeVisibility(true), makeVisibility(false)])).toBe("some");
  });

  it("none visible -> 'none'", () => {
    expect(classifyVisibility([makeVisibility(false), makeVisibility(false)])).toBe("none");
  });
});

describe("inferRuleFromLocate", () => {
  it("infers a directory-prefix rule when local and worker share a meaningful suffix", () => {
    expect(
      inferRuleFromLocate(
        "/Users/amickl/repos/sleap/video.mp4",
        "/root/vast/amick/repos/sleap/video.mp4",
      ),
    ).toEqual({ local: "/Users/amickl", worker: "/root/vast/amick" });
  });

  it("falls back to an exact-file rule when no common prefix is detectable", () => {
    expect(inferRuleFromLocate("/Users/amickl/video.mp4", "/totally/different/other.mp4")).toEqual({
      local: "/Users/amickl/video.mp4",
      worker: "/totally/different/other.mp4",
    });
  });
});

describe("projectVideoPaths", () => {
  it("uses a string filename as-is", () => {
    const labels = { videos: [{ filename: "/a/video.mp4" }] };
    expect(projectVideoPaths(labels)).toEqual(["/a/video.mp4"]);
  });

  it("uses the first element of an array filename (image-sequence video)", () => {
    const labels = {
      videos: [{ filename: ["/a/frame0.png", "/a/frame1.png"] }],
    };
    expect(projectVideoPaths(labels)).toEqual(["/a/frame0.png"]);
  });

  it("preserves video order/index across a mix", () => {
    const labels = {
      videos: [{ filename: "/a.mp4" }, { filename: ["/b0.png", "/b1.png"] }, { filename: "/c.mp4" }],
    };
    expect(projectVideoPaths(labels)).toEqual(["/a.mp4", "/b0.png", "/c.mp4"]);
  });
});

// LUCID: projectVideoPaths takes plain arrays (per-(session, camera) video paths).
describe("projectVideoPaths (LUCID array inputs)", () => {
  it("a plain array of path strings is returned as-is (copied)", () => {
    const input = ["/s1/cam1.mp4", "/s1/cam2.mp4", "/s2/cam1.mp4"];
    const out = projectVideoPaths(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("an array of { filename } objects (string or image-sequence) works too", () => {
    expect(projectVideoPaths([{ filename: "/a.mp4" }, { filename: ["/b0.png", "/b1.png"] }])).toEqual([
      "/a.mp4",
      "/b0.png",
    ]);
  });

  it("an empty array -> []", () => {
    expect(projectVideoPaths([])).toEqual([]);
  });
});

await run();
