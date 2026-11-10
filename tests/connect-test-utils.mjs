/**
 * connect-test-utils.mjs — the few bun:test matchers the Connect protocol
 * ports use that `bun-test-shim.mjs` does not provide: `.rejects.toThrow` /
 * `.rejects.toMatchObject`, `.toBeInstanceOf`, a `toThrow` that accepts an
 * Error class, and `itEach` (bun's `it.each`).
 *
 * Wraps the shim's `expect` (leaving the shim untouched) and re-exports
 * `describe`, `it`, `beforeEach`, `afterEach`, `run`. Not a suite: the name does
 * not start with `test-`, so `tests/run-mjs-tests.mjs` skips it.
 */
import { expect as baseExpect, describe, it, beforeEach, afterEach, run } from './bun-test-shim.mjs';

/** Does `err` satisfy a `toThrow` argument (undefined = anything, class, RegExp, or message substring)? */
function matchesThrow(err, arg) {
  if (arg === undefined) return true;
  if (typeof arg === 'function') return err instanceof arg;
  const msg = String(err?.message ?? err);
  return arg instanceof RegExp ? arg.test(msg) : msg.includes(arg);
}

function describeArg(arg) {
  return typeof arg === 'function' ? arg.name : String(arg);
}

function toThrowOn(fn, negate) {
  return (arg) => {
    let threw = false;
    let err;
    try { fn(); } catch (e) { threw = true; err = e; }
    const ok = threw && matchesThrow(err, arg);
    if (negate ? ok : !ok) throw new Error(`expected function ${negate ? 'not ' : ''}toThrow ${arg === undefined ? '' : describeArg(arg)}`);
  };
}

export function expect(actual) {
  const m = baseExpect(actual);
  m.toThrow = toThrowOn(actual, false);
  m.not.toThrow = toThrowOn(actual, true);
  m.toBeInstanceOf = (cls) => {
    if (!(actual instanceof cls)) throw new Error(`expected value toBeInstanceOf ${cls.name}`);
  };
  m.rejects = {
    async toThrow(arg) {
      let threw = false;
      let err;
      try { await actual; } catch (e) { threw = true; err = e; }
      if (!threw) throw new Error('expected promise to reject, but it resolved');
      if (!matchesThrow(err, arg)) throw new Error(`expected rejection toThrow ${describeArg(arg)}, got ${err?.name}: ${err?.message}`);
    },
    async toMatchObject(expected) {
      let threw = false;
      let err;
      try { await actual; } catch (e) { threw = true; err = e; }
      if (!threw) throw new Error('expected promise to reject, but it resolved');
      baseExpect(err).toMatchObject(expected);
    },
  };
  return m;
}
Object.assign(expect, baseExpect);

/** bun's `it.each(cases)(name, fn)`: one test per case, `%p` in the name replaced by the case. */
export function itEach(cases) {
  return (name, fn) => {
    for (const c of cases) it(name.replace('%p', JSON.stringify(c) ?? String(c)), () => fn(c));
  };
}

export { describe, it, beforeEach, afterEach, run };
