/**
 * store-test-env.mjs — shared setup for the Connect store tests (`tests/test-connect-store*.mjs`).
 *
 * Not a suite (the name does not start with `test-`). Provides what the sleap-app store tests got
 * from bun:test + happy-dom + `vi.mock`:
 *  - `MemoryStorage`: a `Storage` stand-in (inject with `configureConnect({localStorage, sessionStorage})`).
 *  - `makeToast()`: the injected `notify` (`success/error/info`) as spies (`.mock.calls`, `.mockClear()`).
 *  - `fakePathMappingsStorage(getMappings)`: a `PathMappingsStorage` whose config.toml holds `getMappings()`.
 *  - `expect` = connect-test-utils' expect plus `toHaveBeenCalled / ...Times / ...With` for those spies and
 *    `expect.stringContaining` / `expect.anything`.
 *  - `buildPairCode` / `base64UrlEncode` / `fakeBytes` / `mistypeCode`: sleap-app's `buildPairCode.ts` helpers
 *    over the `pair-code.mjs` encoder.
 *  - `FAKE_IDENTITY`: the `getClientIdentity` the store tests inject.
 */
import { expect as baseExpect, describe, it, beforeEach, afterEach, run, itEach } from '../connect-test-utils.mjs';
import { encodePairCode, mistypeCode, b64urlEncode, RELAY_TABLE } from './pair-code.mjs';

export { describe, it, beforeEach, afterEach, run, itEach, mistypeCode };
export const base64UrlEncode = b64urlEncode;

export class MemoryStorage {
  constructor() { this._m = new Map(); }
  get length() { return this._m.size; }
  key(i) { return [...this._m.keys()][i] ?? null; }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}

/** A minimal call-recording function (bun's `mock`). */
export function spy(impl = () => undefined) {
  const fn = (...args) => { fn.mock.calls.push(args); return impl(...args); };
  fn.mock = { calls: [] };
  fn.mockClear = () => { fn.mock.calls.length = 0; };
  return fn;
}

export function makeToast() {
  return { success: spy(), error: spy(), info: spy() };
}

export const FAKE_IDENTITY = async () => ({ nodeId: 'client-node-id', sign: async (nonce) => `sig(${nonce})` });

/** PathMappingsStorage over one fake `~/.sleap-connect/config.toml` whose content is derived from `getMappings()`. */
export function fakePathMappingsStorage(getMappings) {
  const toml = () => getMappings().map((m) => `\n[[path_mappings]]\nlocal = "${m.local}"\nworker = "${m.worker}"\n`).join('');
  return {
    homeDir: async () => '/home/u',
    join: async (...p) => p.join('/'),
    exists: async (p) => (p.endsWith('config.toml') ? getMappings().length > 0 : p === '/home/u/.sleap-connect'),
    readTextFile: async () => toml(),
    writeTextFile: async () => {},
    mkdir: async () => {},
  };
}

// ── matchers ──
const ASYM = Object.getOwnPropertySymbols(baseExpect.any(String))[0];
const asym = (match) => ({ [ASYM]: true, match });
const stringContaining = (s) => asym((a) => typeof a === 'string' && a.includes(s));
const anything = () => asym((a) => a !== null && a !== undefined);

function same(a, b) {
  if (b && typeof b === 'object' && b[ASYM]) return b.match(a);
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}
const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function spyMatchers(fn, negate) {
  const check = (pass, msg) => { if (negate ? pass : !pass) throw new Error((negate ? 'NOT ' : '') + msg); };
  const calls = fn?.mock?.calls ?? [];
  return {
    toHaveBeenCalled: () => check(calls.length > 0, `expected spy toHaveBeenCalled (calls: ${calls.length})`),
    toHaveBeenCalledTimes: (n) => check(calls.length === n, `expected spy called ${n} times, got ${calls.length}`),
    toHaveBeenCalledWith: (...exp) =>
      check(calls.some((c) => c.length === exp.length && exp.every((e, i) => same(c[i], e))), `expected spy toHaveBeenCalledWith ${fmt(exp)}; calls ${fmt(calls)}`),
  };
}

/** A stand-in YAML parser for the fixtures here: `trainer_config:` + optional indented `run_name: x` (the page injects the real `yaml`). */
export function miniYamlLoad(text) {
  const m = /^trainer_config:[ \t]*\n[ \t]+run_name:[ \t]*(.+)$/m.exec(text);
  if (m) return { trainer_config: { run_name: m[1].trim() } };
  return /^trainer_config:/m.test(text) ? { trainer_config: {} } : {};
}

export function expect(actual) {
  const m = baseExpect(actual);
  m.toContainEqual = (e) => {
    if (!Array.isArray(actual) || !actual.some((x) => same(x, e))) throw new Error(`expected ${fmt(actual)} toContainEqual ${fmt(e)}`);
  };
  m.resolves = {
    toEqual: async (e) => baseExpect(await actual).toEqual(e),
    toBe: async (e) => baseExpect(await actual).toBe(e),
    toBeUndefined: async () => baseExpect(await actual).toBeUndefined(),
    toMatchObject: async (e) => baseExpect(await actual).toMatchObject(e),
  };
  if (actual && actual.mock && Array.isArray(actual.mock.calls)) {
    Object.assign(m, spyMatchers(actual, false));
    Object.assign(m.not, spyMatchers(actual, true));
  }
  return m;
}
Object.assign(expect, baseExpect, { stringContaining, anything });

/**
 * sleap-app's `buildPairCode`: `{nodeId (32 bytes), secret (16), expiresAt (unix s), addrs?: [{ip, port}], relay?: {index} | {url}}`.
 * @returns {Promise<string>}
 */
export async function buildPairCode(opts) {
  const relay_url = opts.relay ? ('url' in opts.relay ? opts.relay.url : RELAY_TABLE[opts.relay.index - 1]) : null;
  return encodePairCode(
    {
      node_id: b64urlEncode(opts.nodeId),
      secret: b64urlEncode(opts.secret),
      expires_at: opts.expiresAt,
      addrs: (opts.addrs ?? []).map((a) => `ws://${a.ip.join('.')}:${a.port}`),
      relay_url,
    },
    opts.version !== undefined ? { version: opts.version } : {},
  );
}

/** A deterministic byte array: `seed, seed+1, ...` mod 256. */
export function fakeBytes(length, seed = 1) {
  return new Uint8Array(Array.from({ length }, (_, i) => (seed + i) % 256));
}
