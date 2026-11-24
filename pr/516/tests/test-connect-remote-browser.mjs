/**
 * Port of sleap-app tests/unit/remoteBrowser.test.ts @ 683a159 (types stripped), plus
 * tests of `pose/connect/remote-browser-store.js` (the storage-injected store; sleap-app has
 * no unit test of remoteBrowserStore itself, its behavior is exercised through
 * remoteFileBrowser.test.tsx).
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  DEFAULT_SORT, baseName, fileKind, filterLabel, formatModified, formatSize, joinPath,
  matchesFilter, matchesSearch, mountRootFor, normalizeFilter, parentPath, pathTrail, sortEntries,
} from '../pose/connect/remote-browser.js';
import { createRemoteBrowserStore, MAX_RECENTS, REMOTE_BROWSER_STORAGE_KEY } from '../pose/connect/remote-browser-store.js';

const f = (name, extra = {}) => ({ name, isDir: false, ...extra });
const d = (name, extra = {}) => ({ name, isDir: true, ...extra });
const names = (es) => es.map((e) => e.name);

describe("paths", () => {
  it("joins, splits and names paths", () => {
    expect(joinPath("/a/", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(parentPath("/a/b/")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(baseName("/a/b.slp")).toBe("b.slp");
  });

  it("mountRootFor picks the longest containing mount", () => {
    expect(mountRootFor("/vast/exp1/x", ["/vast", "/vast/exp1"])).toBe("/vast/exp1");
    expect(mountRootFor("/vaster", ["/vast"])).toBeNull();
  });

  it("pathTrail lists every folder from the mount root down", () => {
    expect(pathTrail("/vast/exp1/videos", ["/vast"])).toEqual(["/vast", "/vast/exp1", "/vast/exp1/videos"]);
    expect(pathTrail("/vast", ["/vast"])).toEqual(["/vast"]);
    expect(pathTrail("/x/y", [])).toEqual(["/", "/x", "/x/y"]);
  });
});

describe("kinds + filters", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(fileKind(f("Flies.SLP"))).toBe("labels");
    expect(fileKind(f("a.mp4"))).toBe("video");
    expect(fileKind(d("models.slp"))).toBe("folder");
    expect(fileKind(f("README"))).toBe("other");
  });

  it("matchesFilter lets folders through and checks files' extensions", () => {
    const exts = normalizeFilter([".SLP"]);
    expect(matchesFilter(f("a.slp"), exts)).toBe(true);
    expect(matchesFilter(f("a.mp4"), exts)).toBe(false);
    expect(matchesFilter(d("videos"), exts)).toBe(true);
    expect(matchesFilter(f("a.mp4"), null)).toBe(true);
  });

  it("filterLabel names known kinds", () => {
    expect(filterLabel([".slp"])).toBe("SLEAP labels (.slp)");
    expect(filterLabel([".xyz"])).toBe(".xyz");
  });

  it("matchesSearch is a case-insensitive substring match; blank matches all", () => {
    expect(matchesSearch(f("Flies_v003.slp"), "v003")).toBe(true);
    expect(matchesSearch(f("Flies.slp"), "FLIES")).toBe(true);
    expect(matchesSearch(f("a.slp"), "  ")).toBe(true);
    expect(matchesSearch(f("a.slp"), "b")).toBe(false);
  });
});

describe("sortEntries", () => {
  const entries = [f("b10.slp", { size: 5, modified: 300 }), d("zeta", { modified: 100 }), f("b2.mp4", { size: 50, modified: 200 }), d("alpha", { modified: 400 })];

  it("defaults to folders first, then natural name order", () => {
    expect(names(sortEntries(entries, DEFAULT_SORT))).toEqual(["alpha", "zeta", "b2.mp4", "b10.slp"]);
  });

  it("sorts by size and date modified in either direction", () => {
    expect(names(sortEntries(entries, { key: "size", dir: "desc", foldersFirst: false }))).toEqual(["b2.mp4", "b10.slp", "alpha", "zeta"]);
    expect(names(sortEntries(entries, { key: "modified", dir: "desc", foldersFirst: false }))).toEqual(["alpha", "b10.slp", "b2.mp4", "zeta"]);
  });

  it("date last opened puts never-opened entries last in both directions", () => {
    const lastOpened = { "/w/b2.mp4": 10, "/w/zeta": 20 };
    const asc = sortEntries(entries, { key: "lastOpened", dir: "asc", foldersFirst: false }, { dir: "/w", lastOpened });
    const desc = sortEntries(entries, { key: "lastOpened", dir: "desc", foldersFirst: false }, { dir: "/w", lastOpened });
    expect(names(asc)).toEqual(["b2.mp4", "zeta", "alpha", "b10.slp"]);
    expect(names(desc)).toEqual(["zeta", "b2.mp4", "alpha", "b10.slp"]);
  });
});

describe("formatting", () => {
  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2.5 * 1024 ** 2)).toBe("2.5 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.00 GB");
  });

  it("formats dates relative to today", () => {
    const now = new Date(2026, 9, 20, 15, 0);
    const at = (dayOffset) => new Date(2026, 9, 20 + dayOffset, 9, 5).getTime() / 1000;
    expect(formatModified(at(0), now).startsWith("Today at")).toBe(true);
    expect(formatModified(at(-1), now).startsWith("Yesterday at")).toBe(true);
    expect(formatModified(at(-3), now)).toContain("2026");
    expect(formatModified(undefined, now)).toBe("—");
  });
});

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), m };
}

describe("remote-browser-store", () => {
  it("starts with sleap-app's defaults", () => {
    const s = createRemoteBrowserStore().getState();
    expect(s.view).toBe("list");
    expect(s.sort).toEqual({ key: "name", dir: "asc", foldersFirst: true });
    expect(s.size).toBeNull();
    expect(s.columnWidth).toBeNull();
    expect(s.favorites).toEqual({});
    expect(s.recents).toEqual({});
  });

  it("toggles and removes favorites per worker", () => {
    const st = createRemoteBrowserStore();
    st.getState().toggleFavorite("w1", "/a");
    st.getState().toggleFavorite("w1", "/b");
    st.getState().toggleFavorite("w2", "/a");
    expect(st.getState().favorites).toEqual({ w1: ["/a", "/b"], w2: ["/a"] });
    st.getState().toggleFavorite("w1", "/a");
    expect(st.getState().favorites.w1).toEqual(["/b"]);
    st.getState().removeFavorite("w1", "/b");
    st.getState().removeFavorite("w3", "/x");
    expect(st.getState().favorites.w1).toEqual([]);
    expect(st.getState().favorites.w3).toEqual([]);
  });

  it("addRecent is newest-first, de-duplicates by path and caps at MAX_RECENTS", () => {
    let t = 0;
    const st = createRemoteBrowserStore({ now: () => ++t });
    st.getState().addRecent("w", "/a", true);
    st.getState().addRecent("w", "/b", false);
    st.getState().addRecent("w", "/a", true);
    expect(st.getState().recents.w).toEqual([
      { path: "/a", isDir: true, openedAt: 3 },
      { path: "/b", isDir: false, openedAt: 2 },
    ]);
    for (let i = 0; i < 20; i++) st.getState().addRecent("w", `/f${i}`, false);
    expect(st.getState().recents.w).toHaveLength(MAX_RECENTS);
    expect(st.getState().recents.w[0].path).toBe("/f19");
  });

  it("persists only data fields under the renamed key, and reloads them", () => {
    const storage = memoryStorage();
    const a = createRemoteBrowserStore({ storage });
    a.getState().setView("columns");
    a.getState().setSort({ key: "size", dir: "desc", foldersFirst: false });
    a.getState().setSize({ width: 800, height: 600 });
    a.getState().setColumnWidth(240);
    a.getState().toggleFavorite("w", "/fav");
    expect(REMOTE_BROWSER_STORAGE_KEY).toBe("lucid-connect-remote-browser");
    const blob = JSON.parse(storage.m.get("lucid-connect-remote-browser"));
    expect(blob.version).toBe(1);
    expect(Object.keys(blob.state).sort()).toEqual(["columnWidth", "favorites", "recents", "size", "sort", "view"]);
    const b = createRemoteBrowserStore({ storage });
    expect(b.getState().view).toBe("columns");
    expect(b.getState().size).toEqual({ width: 800, height: 600 });
    expect(b.getState().columnWidth).toBe(240);
    expect(b.getState().favorites).toEqual({ w: ["/fav"] });
  });

  it("ignores a corrupt or wrong-version blob and survives a throwing storage", () => {
    for (const raw of ["not json", JSON.stringify({ state: { view: "icons" }, version: 99 }), "null"]) {
      const st = createRemoteBrowserStore({ storage: memoryStorage({ [REMOTE_BROWSER_STORAGE_KEY]: raw }) });
      expect(st.getState().view).toBe("list");
    }
    const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    const st = createRemoteBrowserStore({ storage: bad });
    st.getState().setView("icons");
    expect(st.getState().view).toBe("icons");
  });

  it("notifies subscribers until they unsubscribe", () => {
    const st = createRemoteBrowserStore();
    let n = 0;
    const off = st.subscribe(() => n++);
    st.getState().setView("icons");
    off();
    st.getState().setView("list");
    expect(n).toBe(1);
  });
});

await run();
