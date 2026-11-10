/**
 * A tiny local stand-in for the two zustand pieces sleap-app's connectStore uses
 * (`create` from `zustand`, `persist` from `zustand/middleware`), written against
 * zustand 5.x's documented semantics. Not a port of one file: it exists so
 * `pose/connect/store.js` can keep connectStore's shape (initializer `(set, get, api)`,
 * `getState / setState / subscribe`, `persist` options) without a dependency.
 *
 * `createStore(initializer)` -> `{ getState, setState(partial | fn, replace?), subscribe(listener) -> unsubscribe }`:
 *  - `setState(partial)` shallow-merges (`Object.assign({}, state, partial)`); `setState(next, true)` replaces.
 *  - A `partial` that is a function receives the current state. A result that is `Object.is`-equal to the
 *    current state changes nothing and notifies nobody.
 *  - `subscribe(listener)` calls `listener(state, prevState)` after every change; the returned function unsubscribes.
 *  - The `api` the initializer receives is the store itself (`getState`, `setState`, `subscribe`, plus `getInitialState`).
 *
 * `persist(config, options)` is the middleware: `createStore(persist((set, get, api) => ({...}), options))`.
 * It reproduces what zustand's persist does for connectStore's config and nothing else:
 *  - `options.name`, `options.version` (default 0), `options.storage` (a `PersistStorage`:
 *    `{getItem(name) -> {state, version} | null, setItem(name, {state, version}), removeItem(name)}`, all SYNCHRONOUS
 *    here — zustand also allows promises; connectStore's storage is localStorage, so this port does not),
 *    `options.partialize(state)` (default: the whole state), `options.merge(persisted, current)` (default: shallow
 *    `{...current, ...persisted}`), `options.migrate(persistedState, version)` (called when the stored version differs
 *    from `options.version`; without one a version mismatch is logged and the stored state is ignored), `options.skipHydration`.
 *  - Every `set` made by the initializer AND every `api.setState` call saves `{state: partialize(get()), version}` through
 *    `storage.setItem` (after updating the store).
 *  - Hydration (at creation unless `skipHydration`, and on `api.persist.rehydrate()`): read, migrate if the version
 *    differs, `merge`, install with replace semantics WITHOUT saving; a migrated state is saved back once.
 *  - `api.persist` = `{ rehydrate, hasHydrated, getOptions, setOptions, clearStorage, onHydrate, onFinishHydration }`.
 *
 * LUCID changes (P2 review): `subscribeSelector(selector, listener(selected, prevSelected), equalityFn = Object.is)`
 * on the store API (zustand's `subscribeWithSelector`; fires only when the selection changes, for DOM
 * panels) and an exported `shallowEqual` helper.
 *
 * Differences from zustand: synchronous storage only (a storage whose `getItem` returns a promise is an error here),
 * no `onRehydrateStorage` callback, no `createJSONStorage`/`devtools`/`immer` middlewares, no React bindings.
 */

/**
 * @template S
 * @typedef {object} StoreApi
 * @property {() => S} getState
 * @property {(partial: Partial<S> | ((state: S) => Partial<S> | S), replace?: boolean) => void} setState
 * @property {(listener: (state: S, prev: S) => void) => () => void} subscribe
 * @property {() => S} getInitialState
 * @property {<T>(selector: (state: S) => T, listener: (selected: T, prevSelected: T) => void, equalityFn?: (a: T, b: T) => boolean) => () => void} subscribeSelector
 */

/**
 * Shallow equality for `subscribeSelector` (zustand's `shallow`): same keys with `Object.is`-equal
 * values (plain objects / arrays), or `Object.is`-equal.
 * @param {any} a
 * @param {any} b
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * @template S
 * @param {(set: StoreApi<S>["setState"], get: () => S, api: StoreApi<S>) => S} initializer
 * @returns {StoreApi<S>}
 */
export function createStore(initializer) {
  /** @type {S} */
  let state;
  /** @type {Set<(state: S, prev: S) => void>} */
  const listeners = new Set();

  const setState = (partial, replace) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    if (Object.is(next, state)) return;
    const prev = state;
    state =
      (replace ?? (typeof next !== "object" || next === null))
        ? /** @type {S} */ (next)
        : Object.assign({}, state, next);
    for (const l of [...listeners]) l(state, prev);
  };
  const getState = () => state;
  const getInitialState = () => initialState;
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const subscribeSelector = (selector, listener, equalityFn = Object.is) => {
    let selected = selector(state);
    return subscribe((next) => {
      const nextSelected = selector(next);
      if (equalityFn(selected, nextSelected)) return;
      const prevSelected = selected;
      selected = nextSelected;
      listener(selected, prevSelected);
    });
  };
  const api = { getState, getInitialState, setState, subscribe, subscribeSelector };
  const initialState = (state = initializer(setState, getState, api));
  return api;
}

/**
 * @template S
 * @typedef {object} PersistStorage
 * @property {(name: string) => ({ state: S, version?: number } | null)} getItem
 * @property {(name: string, value: { state: S, version?: number }) => void} setItem
 * @property {(name: string) => void} removeItem
 */

/**
 * @template S, P
 * @typedef {object} PersistOptions
 * @property {string} name
 * @property {number} [version]
 * @property {PersistStorage<P>} storage
 * @property {(state: S) => P} [partialize]
 * @property {(persisted: unknown, current: S) => S} [merge]
 * @property {(persisted: unknown, version: number) => P} [migrate]
 * @property {boolean} [skipHydration]
 */

/**
 * @template S, P
 * @param {(set: StoreApi<S>["setState"], get: () => S, api: StoreApi<S> & { persist?: any }) => S} config
 * @param {PersistOptions<S, P>} baseOptions
 */
export function persist(config, baseOptions) {
  return (set, get, api) => {
    const options = {
      version: 0,
      partialize: (state) => state,
      merge: (persisted, current) => ({ ...current, ...persisted }),
      ...baseOptions,
    };
    const storage = options.storage;
    let hasHydrated = false;
    const hydrationListeners = new Set();
    const finishHydrationListeners = new Set();

    const setItem = () => {
      const state = options.partialize({ ...get() });
      storage.setItem(options.name, { state, version: options.version });
    };

    const savedSetState = api.setState;
    api.setState = (state, replace) => {
      savedSetState(state, replace);
      setItem();
    };

    const configResult = config(
      (...args) => {
        set(...args);
        setItem();
      },
      get,
      api,
    );

    /** @type {S | undefined} */
    let stateFromStorage;

    const hydrate = () => {
      hasHydrated = false;
      for (const cb of hydrationListeners) cb(get() ?? configResult);
      /** @type {unknown} */
      let error;
      let migrated = false;
      try {
        const stored = storage.getItem(options.name);
        if (stored && typeof stored.then === "function") {
          throw new Error("mini-store persist: the storage must be synchronous");
        }
        let migratedState;
        if (stored) {
          if (typeof stored.version === "number" && stored.version !== options.version) {
            if (options.migrate) {
              migratedState = options.migrate(stored.state, stored.version);
              migrated = true;
            } else {
              console.error("State loaded from storage couldn't be migrated since no migrate function was provided");
            }
          } else {
            migratedState = stored.state;
          }
        }
        stateFromStorage = options.merge(migratedState, get() ?? configResult);
      } catch (e) {
        // As zustand: a storage / migrate / merge that throws leaves the current state in place.
        error = e;
        migrated = false;
        console.error("mini-store persist: hydration failed, keeping the initial state:", e);
      }
      if (error === undefined) {
        set(stateFromStorage, true);
        if (migrated) setItem();
      }
      stateFromStorage = get();
      hasHydrated = true;
      for (const cb of finishHydrationListeners) cb(stateFromStorage);
    };

    api.persist = {
      setOptions: (newOptions) => {
        Object.assign(options, newOptions);
      },
      clearStorage: () => {
        storage.removeItem(options.name);
      },
      getOptions: () => options,
      rehydrate: () => hydrate(),
      hasHydrated: () => hasHydrated,
      onHydrate: (cb) => {
        hydrationListeners.add(cb);
        return () => hydrationListeners.delete(cb);
      },
      onFinishHydration: (cb) => {
        finishHydrationListeners.add(cb);
        return () => finishHydrationListeners.delete(cb);
      },
    };

    if (!options.skipHydration) hydrate();
    return stateFromStorage || configResult;
  };
}
