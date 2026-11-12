/**
 * bun-test-shim.mjs — a tiny `describe / it / expect` for the Connect ports.
 *
 * sleap-app's unit tests are written against bun:test. The LUCID ports keep the
 * test bodies as close to the originals as they can, so this implements just the
 * matchers those bodies use (toBe, toEqual, toMatchObject, toBeNull, toContain,
 * toHaveLength, `.not`, `toThrow` with a class / RegExp / substring, toBeInstanceOf,
 * `.rejects.toThrow` / `.rejects.toMatchObject`, and `itEach` = bun's `it.each`)
 * on top of node:assert. Not a general test framework:
 * a test file imports `{ describe, it, expect, run }`, registers its tests, and
 * ends with `await run()`, which runs them in order, prints a summary and sets
 * `process.exitCode` (so `tests/run-mjs-tests.mjs` sees a failure).
 *
 * Not itself a suite: the name does not start with `test-`, so the runner skips it.
 */
import assert from 'node:assert';

const ASYM = Symbol('asymmetric');
const suites = [];
let current = null;

export function describe(name, fn) {
  const suite = { name, tests: [], parent: current, before: [], after: [] };
  suites.push(suite);
  const prev = current;
  current = suite;
  fn();
  current = prev;
}

export function it(name, fn) {
  const owner = current ?? (suites.find((s) => s.name === '') ?? (suites.push({ name: '', tests: [], parent: null, before: [], after: [] }), suites[suites.length - 1]));
  owner.tests.push({ name, fn });
}
export const test = it;

export function beforeEach(fn) { (current ?? suites[0]).before.push(fn); }
export function afterEach(fn) { (current ?? suites[0]).after.push(fn); }

/** Bun-style `toEqual`: deep, ignores properties that are `undefined`, understands objectContaining / any. */
function equals(a, b) {
  if (b && b[ASYM]) return b.match(a);
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  if (a instanceof Set || a instanceof Map) return equals([...a], [...b]);
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => equals(a[k], b[k]));
}

function matchesObject(actual, expected) {
  if (expected && expected[ASYM]) return expected.match(actual);
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  return Object.keys(expected).every((k) => matchesObject(actual[k], expected[k]));
}

const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function matchers(actual, negate) {
  const check = (pass, msg) => {
    if (negate ? pass : !pass) throw new assert.AssertionError({ message: (negate ? 'NOT ' : '') + msg });
  };
  return {
    toBe: (e) => check(Object.is(actual, e), `expected ${fmt(actual)} toBe ${fmt(e)}`),
    toEqual: (e) => check(equals(actual, e), `expected ${fmt(actual)} toEqual ${fmt(e)}`),
    toStrictEqual: (e) => check(equals(actual, e), `expected ${fmt(actual)} toStrictEqual ${fmt(e)}`),
    toMatchObject: (e) => check(matchesObject(actual, e), `expected ${fmt(actual)} toMatchObject ${fmt(e)}`),
    toBeNull: () => check(actual === null, `expected ${fmt(actual)} toBeNull`),
    toBeUndefined: () => check(actual === undefined, `expected ${fmt(actual)} toBeUndefined`),
    toBeDefined: () => check(actual !== undefined, `expected value toBeDefined`),
    toBeTruthy: () => check(!!actual, `expected ${fmt(actual)} toBeTruthy`),
    toBeFalsy: () => check(!actual, `expected ${fmt(actual)} toBeFalsy`),
    toMatch: (re) => check(typeof actual === 'string' && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `expected ${fmt(actual)} toMatch ${re}`),
    toContain: (e) => check(actual != null && (typeof actual === 'string' || Array.isArray(actual)) && actual.includes(e), `expected ${fmt(actual)} toContain ${fmt(e)}`),
    toHaveLength: (n) => check(actual != null && actual.length === n, `expected length ${actual?.length} toHaveLength ${n}`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} toBeGreaterThan ${n}`),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} toBeLessThan ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `expected ${actual} toBeLessThanOrEqual ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} toBeGreaterThanOrEqual ${n}`),
    toThrow: (m) => {
      let threw = false, err;
      try { actual(); } catch (e) { threw = true; err = e; }
      check(threw && matchesThrow(err, m), `expected function toThrow ${m === undefined ? '' : describeThrowArg(m)}`);
    },
    toBeInstanceOf: (cls) => check(actual instanceof cls, `expected value toBeInstanceOf ${cls.name}`),
  };
}

/** Does `err` satisfy a `toThrow` argument (undefined = anything, an Error class, RegExp, or message substring)? */
function matchesThrow(err, arg) {
  if (arg === undefined) return true;
  if (typeof arg === 'function') return err instanceof arg;
  const msg = String(err?.message ?? err);
  return arg instanceof RegExp ? arg.test(msg) : msg.includes(arg);
}
const describeThrowArg = (arg) => (typeof arg === 'function' ? arg.name : String(arg));

/** Awaits `promise` and returns the rejection, or throws if it resolved. */
async function rejectionOf(promise) {
  try { await promise; } catch (e) { return e; }
  throw new assert.AssertionError({ message: 'expected promise to reject, but it resolved' });
}

export function expect(actual) {
  const m = matchers(actual, false);
  m.not = matchers(actual, true);
  m.rejects = {
    async toThrow(arg) {
      const err = await rejectionOf(actual);
      if (!matchesThrow(err, arg)) throw new assert.AssertionError({ message: `expected rejection toThrow ${describeThrowArg(arg)}, got ${err?.name}: ${err?.message}` });
    },
    async toMatchObject(expected) { expect(await rejectionOf(actual)).toMatchObject(expected); },
  };
  return m;
}
expect.objectContaining = (expected) => ({ [ASYM]: true, match: (a) => matchesObject(a, expected) });
expect.any = (ctor) => ({ [ASYM]: true, match: (a) => (ctor === String ? typeof a === 'string' : ctor === Number ? typeof a === 'number' : a instanceof ctor) });

/** bun's `it.each(cases)(name, fn)`: one test per case, `%p` in the name replaced by the case. */
export function itEach(cases) {
  return (name, fn) => {
    for (const c of cases) it(name.replace('%p', JSON.stringify(c) ?? String(c)), () => fn(c));
  };
}

/** Runs every registered test in order, prints a summary, sets process.exitCode. */
export async function run() {
  let passed = 0, failed = 0;
  const chain = (s) => (s.parent ? chain(s.parent) + ' > ' : '') + s.name;
  for (const suite of suites) {
    const befores = []; const afters = [];
    for (let s = suite; s; s = s.parent) { befores.unshift(...s.before); afters.push(...s.after); }
    for (const t of suite.tests) {
      const label = (chain(suite) ? chain(suite) + ' > ' : '') + t.name;
      try {
        for (const b of befores) await b();
        await t.fn();
        for (const a of afters) await a();
        passed++;
        console.log('  ok   ' + label);
      } catch (e) {
        failed++;
        console.log('  FAIL ' + label + '\n       ' + (e && e.message ? e.message : e));
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? 'PASS' : 'FAIL');
  if (failed) process.exitCode = 1;
  return { passed, failed };
}
