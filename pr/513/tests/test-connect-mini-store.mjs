/**
 * Tests for pose/connect/mini-store.js: the zustand subset (`createStore`, `persist`) the Connect store
 * is built on. Written against zustand 5's documented semantics (no sleap-app test exists for zustand).
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import { createStore, persist } from '../pose/connect/mini-store.js';

class Mem {
  constructor() { this.m = new Map(); this.sets = 0; }
  getItem(k) { const v = this.m.get(k); return v === undefined ? null : JSON.parse(v); }
  setItem(k, v) { this.sets++; this.m.set(k, JSON.stringify(v)); }
  removeItem(k) { this.m.delete(k); }
}

describe('createStore', () => {
  it('merges a partial, replaces on request, and takes an updater function', () => {
    const s = createStore((set) => ({ a: 1, b: 2, inc: () => set((x) => ({ a: x.a + 1 })) }));
    s.setState({ b: 3 });
    expect(s.getState()).toMatchObject({ a: 1, b: 3 });
    s.getState().inc();
    expect(s.getState().a).toBe(2);
    s.setState({ only: true }, true);
    expect(Object.keys(s.getState())).toEqual(['only']);
  });

  it('notifies subscribers with (state, prev), skips an Object.is-equal set, and unsubscribes', () => {
    const s = createStore(() => ({ a: 1 }));
    const seen = [];
    const off = s.subscribe((st, prev) => seen.push([st.a, prev.a]));
    s.setState({ a: 2 });
    s.setState((st) => st); // same object: no notification
    expect(seen).toEqual([[2, 1]]);
    off();
    s.setState({ a: 3 });
    expect(seen).toHaveLength(1);
  });

  it('a subscriber may set state (re-entrancy) and sees each change in order', () => {
    const s = createStore(() => ({ a: 0, b: 0 }));
    const log = [];
    s.subscribe((st) => { log.push(`${st.a}/${st.b}`); if (st.a === 1 && st.b === 0) s.setState({ b: 1 }); });
    s.setState({ a: 1 });
    expect(log).toEqual(['1/0', '1/1']);
  });

  it('the initializer receives (set, get, api) and getInitialState returns the first state', () => {
    let seenApi;
    const s = createStore((set, get, api) => { seenApi = api; return { x: 1 }; });
    expect(seenApi).toBe(s);
    s.setState({ x: 2 });
    expect(s.getInitialState().x).toBe(1);
  });
});

describe('persist', () => {
  const mk = (storage, extra = {}) => createStore(persist((set) => ({
    n: 0, runtime: 'r', bump: () => set((s) => ({ n: s.n + 1 })),
  }), { name: 'k', version: 2, storage, partialize: (s) => ({ n: s.n }), ...extra }));

  it('saves partialize(state) with the version after every set and every api.setState', () => {
    const st = new Mem();
    const s = mk(st);
    expect(st.sets).toBe(0); // hydration of an empty storage writes nothing
    s.getState().bump();
    expect(st.getItem('k')).toEqual({ state: { n: 1 }, version: 2 });
    s.setState({ n: 5, runtime: 'x' });
    expect(st.getItem('k')).toEqual({ state: { n: 5 }, version: 2 });
  });

  it('hydrates at creation through merge, keeping functions and non-persisted fields from the initializer', () => {
    const st = new Mem();
    st.setItem('k', { state: { n: 7 }, version: 2 });
    st.sets = 0;
    const s = mk(st);
    expect(s.getState().n).toBe(7);
    expect(s.getState().runtime).toBe('r');
    expect(typeof s.getState().bump).toBe('function');
    expect(st.sets).toBe(0); // a same-version hydrate does not write back
    expect(s.persist.hasHydrated()).toBe(true);
  });

  it('migrates a different version, then saves the migrated state back once', () => {
    const st = new Mem();
    st.setItem('k', { state: { old: 3 }, version: 1 });
    st.sets = 0;
    const calls = [];
    const s = mk(st, { migrate: (p, v) => { calls.push(v); return { n: p.old }; } });
    expect(calls).toEqual([1]);
    expect(s.getState().n).toBe(3);
    expect(st.sets).toBe(1);
    expect(st.getItem('k').version).toBe(2);
  });

  it('a version mismatch without migrate ignores the stored state', () => {
    const st = new Mem();
    st.setItem('k', { state: { n: 9 }, version: 1 });
    const err = console.error; console.error = () => {};
    try {
      const s = mk(st);
      expect(s.getState().n).toBe(0);
    } finally { console.error = err; }
  });

  it('skipHydration + rehydrate(), the default shallow merge, onHydrate/onFinishHydration, clearStorage', () => {
    const st = new Mem();
    st.setItem('k', { state: { n: 4 }, version: 2 });
    const s = createStore(persist(() => ({ n: 0, extra: 1 }), { name: 'k', version: 2, storage: st, skipHydration: true }));
    expect(s.getState().n).toBe(0);
    expect(s.persist.hasHydrated()).toBe(false);
    const events = [];
    s.persist.onHydrate(() => events.push('start'));
    s.persist.onFinishHydration((x) => events.push(`done:${x.n}`));
    s.persist.rehydrate();
    expect(s.getState()).toEqual({ n: 4, extra: 1 });
    expect(events).toEqual(['start', 'done:4']);
    s.persist.clearStorage();
    expect(st.getItem('k')).toBeNull();
  });

  it('a stored copy that is not a state object leaves the initializer state (merge decides)', () => {
    const st = new Mem();
    const s = mk(st, { merge: (persisted, current) => (persisted ? { ...current, ...persisted } : current) });
    expect(s.getState().n).toBe(0);
  });
});

await run();
