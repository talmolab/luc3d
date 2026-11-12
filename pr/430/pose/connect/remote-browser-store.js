/**
 * Port of sleap-app src/stores/remoteBrowserStore.ts @ 683a159.
 *
 * The worker file browser's remembered settings: one view + sort for every folder and worker,
 * the window's size, and per-worker Favorites and Recents. Recents double as "Date Last
 * Opened" (the worker has no idea what this app opened).
 *
 * LUCID changes:
 *  - No zustand: `createRemoteBrowserStore({ storage, now })` builds the store with
 *    `./mini-store.js`'s `createStore` + `persist` (state fields and action names as in
 *    sleap-app's; `getState / setState / subscribe` as in zustand).
 *  - Persistence is injected: `storage` is any string `{ getItem, setItem }` (default none =
 *    memory only). The persisted blob keeps zustand's `{ state, version: 1 }` shape under the
 *    key `lucid-connect-remote-browser` (sleap-app: `sleap-app-remote-browser`); only the data
 *    fields are written, never the actions. A missing, corrupt or wrong-version blob loads as
 *    the defaults; storage failures never throw. `now` (default `Date.now`) stamps Recents.
 *
 * @typedef {import("./remote-browser.js?v=82449baaa3c2").BrowserView} BrowserView
 * @typedef {import("./remote-browser.js?v=82449baaa3c2").SortSpec} SortSpec
 * @typedef {{ path: string, isDir: boolean, openedAt: number }} RecentItem `openedAt` is `Date.now()` when it was last picked.
 */
import { createStore, persist } from "./mini-store.js?v=82449baaa3c2";
import { DEFAULT_SORT } from "./remote-browser.js?v=82449baaa3c2";

export const MAX_RECENTS = 10;
export const REMOTE_BROWSER_STORAGE_KEY = "lucid-connect-remote-browser";
const PERSIST_VERSION = 1;
const DATA_KEYS = ["view", "sort", "size", "columnWidth", "favorites", "recents"];

function defaults() {
  return {
    /** @type {BrowserView} */
    view: "list",
    sort: DEFAULT_SORT,
    /** Last dragged-to window size, px; null = the default size. @type {{ width: number, height: number } | null} */
    size: null,
    /** Columns view: the last width a column was dragged to; null = default. @type {number | null} */
    columnWidth: null,
    /** Pinned folders, per worker key. @type {Record<string, string[]>} */
    favorites: {},
    /** Newest first, per worker key, at most `MAX_RECENTS`. @type {Record<string, RecentItem[]>} */
    recents: {},
  };
}

/**
 * Adapts a string storage to mini-store's synchronous `PersistStorage`; never throws.
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void } | undefined} storage
 */
function jsonStorage(storage) {
  return {
    getItem(/** @type {string} */ name) {
      try {
        const raw = storage?.getItem(name);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    setItem(/** @type {string} */ name, /** @type {any} */ value) {
      try {
        storage?.setItem(name, JSON.stringify(value));
      } catch {
        /* best-effort storage */
      }
    },
    removeItem() {},
  };
}

/**
 * @param {{ storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void }, now?: () => number }} [opts]
 */
export function createRemoteBrowserStore(opts = {}) {
  const { storage, now = Date.now } = opts;
  return createStore(
    persist(
      (/** @type {any} */ set) => ({
        ...defaults(),
        setView: (/** @type {BrowserView} */ view) => set({ view }),
        setSort: (/** @type {SortSpec} */ sort) => set({ sort }),
        setSize: (/** @type {{ width: number, height: number }} */ size) => set({ size }),
        setColumnWidth: (/** @type {number} */ columnWidth) => set({ columnWidth }),
        toggleFavorite: (/** @type {string} */ workerKey, /** @type {string} */ path) =>
          set((/** @type {any} */ s) => {
            const current = s.favorites[workerKey] ?? [];
            const next = current.includes(path) ? current.filter((/** @type {string} */ p) => p !== path) : [...current, path];
            return { favorites: { ...s.favorites, [workerKey]: next } };
          }),
        removeFavorite: (/** @type {string} */ workerKey, /** @type {string} */ path) =>
          set((/** @type {any} */ s) => ({
            favorites: { ...s.favorites, [workerKey]: (s.favorites[workerKey] ?? []).filter((/** @type {string} */ p) => p !== path) },
          })),
        addRecent: (/** @type {string} */ workerKey, /** @type {string} */ path, /** @type {boolean} */ isDir) =>
          set((/** @type {any} */ s) => {
            const rest = (s.recents[workerKey] ?? []).filter((/** @type {RecentItem} */ r) => r.path !== path);
            const next = [{ path, isDir, openedAt: now() }, ...rest].slice(0, MAX_RECENTS);
            return { recents: { ...s.recents, [workerKey]: next } };
          }),
      }),
      {
        name: REMOTE_BROWSER_STORAGE_KEY,
        version: PERSIST_VERSION,
        storage: jsonStorage(storage),
        partialize: (/** @type {any} */ s) => Object.fromEntries(DATA_KEYS.map((k) => [k, s[k]])),
      },
    ),
  );
}
