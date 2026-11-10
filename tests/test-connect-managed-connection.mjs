/**
 * Port of sleap-app tests/unit/managedConnection.test.ts @ 683a159.
 * Reconnect / fallback state machine on a fake clock (pose/connect/managed-connection.js).
 */
/**
 * Tests for ManagedConnection (PR2b §2b.2) — the pure, injectable reconnect/
 * fallback state machine connectStore wraps one of per worker. No zustand, no
 * real timers: `now`/`sleep` are injected so every test runs on a fake clock
 * that advances only when the code under test calls `sleep`.
 */
import { describe, it, expect, run } from './connect-test-utils.mjs';
import {
  ManagedConnection,
  RECONNECT_BACKOFF_MS,
  FALLBACK_AFTER_MS,
} from '../pose/connect/managed-connection.js';
import { WorkerProtocolError, AUTH_UNTRUSTED } from '../pose/connect/errors.js';

/** Minimal WorkerClient stand-in: just the surface ManagedConnection touches. */
class FakeClient {
  closed = false;
  _closeListeners = new Set();

  onClose(cb) {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

  close() {
    this.closed = true;
    for (const cb of [...this._closeListeners]) cb({ intentional: true });
  }

  /**
   * Test helper: simulate the socket dropping — an UNINTENTIONAL close, as a
   * real WorkerClient reports for a dropped connection (not a caller's
   * `close()`). Deliberately doesn't gate on `closed` the way a real
   * WorkerClient's single-notify guard would, so a test can fire a second,
   * stale close from an already-replaced client (rule 8).
   */
  simulateDrop() {
    for (const cb of [...this._closeListeners]) cb({ intentional: false });
  }
}

/** A scripted sequence of dial results; the last entry repeats once exhausted. */
function makeDialQueue(outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    dial: async (route) => {
      calls.push(route);
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      if (outcome.ok) return outcome.client;
      throw outcome.error ?? new Error("dial failed");
    },
  };
}

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms)=> {
      t += ms;
      return Promise.resolve();
    },
  };
}

function statusLog() {
  const log = [];
  return { log, onStatus: (s, r) => log.push([s, r]) };
}

/** Polls a predicate across microtask ticks — every async step in this file
 * (dial/sleep) resolves via an already-settled promise, so no real time ever
 * needs to pass; this just lets pending microtasks drain between each check. */
async function waitUntil(predicate, maxTicks = 500) {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("waitUntil: condition not met within the tick budget");
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("ManagedConnection", () => {
  it("start() dials the preferred route, wires onClose, and reports connected", async () => {
    const clock = makeClock();
    const client = new FakeClient();
    const { dial, calls } = makeDialQueue([{ ok: true, client }]);
    const { log, onStatus } = statusLog();
    const connectedCalls = [];

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: (c, r) => connectedCalls.push([c, r]),
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await mc.start();

    expect(result).toBe(client);
    expect(calls).toEqual(["ws"]);
    expect(log).toEqual([["connected", "ws"]]);
    expect(connectedCalls).toEqual([[client, "ws"]]);
    expect(mc.client).toBe(client);
    expect(mc.route).toBe("ws");
  });

  it("start() failure throws, with no retry loop and no 'reconnecting' status", async () => {
    const clock = makeClock();
    const { dial } = makeDialQueue([{ ok: false, error: new Error("refused") }]);
    const { log, onStatus } = statusLog();

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(mc.start()).rejects.toThrow("refused");
    // Give any (incorrectly) auto-started retry loop a chance to run.
    await flushMicrotasks();
    expect(log.some(([s]) => s === "reconnecting")).toBe(false);
    expect(mc.client).toBeNull();
  });

  it("reconnects on the same route after an unintentional close, backing off between attempts", async () => {
    const clock = makeClock();
    const first = new FakeClient();
    const second = new FakeClient();
    const { dial, calls } = makeDialQueue([
      { ok: true, client: first },
      { ok: false, error: new Error("still down") },
      { ok: false, error: new Error("still down") },
      { ok: true, client: second },
    ]);
    const { log, onStatus } = statusLog();
    const connected = [];

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: (c) => connected.push(c),
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    first.simulateDrop();
    await waitUntil(() => mc.client === (second));

    expect(calls).toEqual(["ws", "ws", "ws", "ws"]);
    expect(mc.route).toBe("ws");
    expect(connected).toEqual([first, second]);
    expect(log).toEqual([
      ["connected", "ws"],
      ["reconnecting", "ws"],
      ["connected", "ws"],
    ]);
  });

  it("falls back to iroh once FALLBACK_AFTER_MS of ws retries have elapsed", async () => {
    const clock = makeClock();
    const wsClient = new FakeClient();
    const irohClient = new FakeClient();
    const { dial, calls } = makeDialQueue([
      { ok: true, client: wsClient },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: true, client: irohClient },
    ]);
    const { log, onStatus } = statusLog();
    const connected = [];
    // A route switching onto iroh also starts a probe loop back toward "ws"
    // — and since `sleep` here resolves instantly, that probe's first dial
    // would otherwise race this test's own assertions. A latch resolved
    // synchronously inside `onConnected` lets the test call `stop()` in the
    // very next microtask, strictly before the just-started probe loop's
    // queued continuation gets a turn (both were scheduled in the same
    // synchronous window, but this one was queued first).
    let resolveFallback;
    const fallbackReached = new Promise ((resolve) => {
      resolveFallback = resolve;
    });

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: true,
      onStatus,
      onConnected: (c, r) => {
        connected.push([c, r]);
        if (r === "iroh") resolveFallback();
      },
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    wsClient.simulateDrop();
    await fallbackReached;
    mc.stop(); // before the probe loop it just started can dial anything

    expect(calls).toEqual(["ws", "ws", "ws", "ws", "ws", "iroh"]);
    expect(mc.route).toBe("iroh");
    expect(connected[connected.length - 1]).toEqual([irohClient, "iroh"]);
    // `stop()` above appends its own "stopped" entry, logged after the fallback.
    expect(log).toEqual([
      ["connected", "ws"],
      ["reconnecting", "ws"],
      ["connected", "iroh"],
      ["stopped", "iroh"],
    ]);
  });

  it("reports 'offline' after FALLBACK_AFTER_MS with no iroh fallback, and keeps retrying with backoff capped at 30s", async () => {
    const clock = makeClock();
    const first = new FakeClient();
    const { dial, calls } = makeDialQueue([
      { ok: true, client: first },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
    ]);
    const { log, onStatus } = statusLog();

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    first.simulateDrop();
    await waitUntil(() => log.some(([s]) => s === "offline"));

    expect(log).toEqual([
      ["connected", "ws"],
      ["reconnecting", "ws"],
      ["offline", "ws"],
    ]);
    expect(calls.every((route) => route === "ws")).toBe(true);
    // RECONNECT_BACKOFF_MS's last entry is the cap applied to every attempt
    // once the sequence is exhausted — sanity-check the fixture matches it.
    expect(RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]).toBe(30_000);
    expect(FALLBACK_AFTER_MS).toBe(10_000);

    mc.stop();
  });

  it("probes the preferred route periodically while on a fallback, switching back on success", async () => {
    const clock = makeClock();
    const wsClient1 = new FakeClient();
    const irohClient = new FakeClient();
    const wsClient2 = new FakeClient();
    const { dial, calls } = makeDialQueue([
      { ok: true, client: wsClient1 },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: false, error: new Error("down") },
      { ok: true, client: irohClient },
      { ok: false, error: new Error("still down") },
      { ok: true, client: wsClient2 },
    ]);
    const { onStatus } = statusLog();
    const connected = [];

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: true,
      onStatus,
      onConnected: (c, r) => connected.push([c, r]),
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    wsClient1.simulateDrop();
    await waitUntil(() => mc.route === "iroh");
    expect(irohClient.closed).toBe(false);

    // First probe attempt fails — stays on iroh.
    await waitUntil(() => calls.length >= 7);
    expect(mc.route).toBe("iroh");
    expect(irohClient.closed).toBe(false);

    // Second probe attempt succeeds — switches back to ws, closing iroh.
    await waitUntil(() => mc.client === (wsClient2));
    expect(mc.route).toBe("ws");
    expect(irohClient.closed).toBe(true);
    expect(connected[connected.length - 1]).toEqual([wsClient2, "ws"]);
    // Both probe attempts dial the PREFERRED route ("ws"), not "iroh".
    expect(calls).toEqual(["ws", "ws", "ws", "ws", "ws", "iroh", "ws", "ws"]);

    mc.stop();
  });

  it("stop() during a retry sleep ends the loop immediately, with no further dials", async () => {
    const clock = makeClock();
    const first = new FakeClient();
    const { dial, calls } = makeDialQueue([
      { ok: true, client: first },
      { ok: false, error: new Error("down") },
    ]);
    const { log, onStatus } = statusLog();

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    first.simulateDrop();
    // Let exactly one failed retry happen, landing the loop in its sleep.
    await waitUntil(() => calls.length === 2);
    mc.stop();
    await flushMicrotasks();

    expect(calls.length).toBe(2); // no dial after stop()
    expect(log[log.length - 1]).toEqual(["stopped", "ws"]);
    expect(mc.client).toBeNull();
  });

  it("ignores a stale close event from a client that is no longer current", async () => {
    const clock = makeClock();
    const first = new FakeClient();
    const second = new FakeClient();
    const { dial } = makeDialQueue([
      { ok: true, client: first },
      { ok: true, client: second },
    ]);
    const { log, onStatus } = statusLog();

    const mc = new ManagedConnection({
      dial,
      preferredRoute: "ws",
      canFallBackToIroh: false,
      onStatus,
      onConnected: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });

    await mc.start();
    first.simulateDrop();
    await waitUntil(() => mc.client === (second));
    const logLengthBefore = log.length;

    // A second, stale close from the already-replaced client must be a no-op.
    first.simulateDrop();
    await flushMicrotasks();

    expect(log.length).toBe(logLengthBefore);
    expect(mc.client).toBe(second);

    mc.stop();
  });
});

describe("route choice after the fallback window", () => {
  /** A dial whose per-route availability the test flips; each success returns a fresh client. */
  function routeDial(up) {
    const calls = [];
    const made = [];
    return {
      calls,
      made,
      dial: async (route)=> {
        calls.push(route);
        if (!up[route]) throw new Error(`${route} down`);
        const client = new FakeClient();
        made.push({ route, client });
        return client;
      },
    };
  }

  it("keeps trying the LAN while iroh is also down, and reconnects when the LAN returns", async () => {
    const up = { ws: true, iroh: false };
    const { calls, made, dial } = routeDial(up);
    const conn = new ManagedConnection({
      dial, preferredRoute: "ws", canFallBackToIroh: true,
      onStatus: () => {}, onConnected: () => {}, ...makeClock(),
    });
    await conn.start();

    up.ws = false;
    made[0].client.simulateDrop();
    await waitUntil(() => calls.includes("iroh"));
    up.ws = true;
    await waitUntil(() => made.length === 2);

    expect(conn.route).toBe("ws");
    expect(conn.client).toBe(made[1].client);
    conn.stop();
  });

  it("dropped while on iroh also retries the preferred route", async () => {
    const up = { ws: true, iroh: true };
    const { made, dial } = routeDial(up);
    const conn = new ManagedConnection({
      dial, preferredRoute: "ws", canFallBackToIroh: true,
      onStatus: () => {}, onConnected: () => {}, ...makeClock(),
    });
    await conn.start();

    up.ws = false; // LAN drops -> falls back to iroh after the window
    made[0].client.simulateDrop();
    await waitUntil(() => conn.route === "iroh");

    up.iroh = false; // iroh drops too, while the LAN has come back
    up.ws = true;
    made[made.length - 1].client.simulateDrop();
    await waitUntil(() => conn.route === "ws" && conn.client !== null);

    expect(conn.route).toBe("ws");
    conn.stop();
  });

  describe("unpaired by the worker (auth.untrusted)", () => {
    const untrusted = () => new WorkerProtocolError(AUTH_UNTRUSTED, "not paired");

    it("a reconnect refused as untrusted stops retrying and reports 'unpaired'", async () => {
      const clock = makeClock();
      const first = new FakeClient();
      const { dial, calls } = makeDialQueue([
        { ok: true, client: first },
        { ok: false, error: untrusted() },
      ]);
      const { log, onStatus } = statusLog();
      const mc = new ManagedConnection({
        dial,
        preferredRoute: "ws",
        canFallBackToIroh: false,
        onStatus,
        onConnected: () => {},
        now: clock.now,
        sleep: clock.sleep,
      });

      await mc.start();
      first.simulateDrop();
      await waitUntil(() => log.some(([s]) => s === "unpaired"));
      await flushMicrotasks();

      expect(calls).toEqual(["ws", "ws"]);
      expect(mc.client).toBeNull();
      expect(log).toEqual([
        ["connected", "ws"],
        ["reconnecting", "ws"],
        ["unpaired", "ws"],
      ]);
    });

    it("start() refused as untrusted reports 'unpaired' and still throws", async () => {
      const { dial } = makeDialQueue([{ ok: false, error: untrusted() }]);
      const { log, onStatus } = statusLog();
      const mc = new ManagedConnection({
        dial,
        preferredRoute: "ws",
        canFallBackToIroh: false,
        onStatus,
        onConnected: () => {},
      });

      await expect(mc.start()).rejects.toThrow("not paired");
      expect(log).toEqual([["unpaired", "ws"]]);
    });

    it("other dial failures keep retrying as before", async () => {
      const clock = makeClock();
      const first = new FakeClient();
      const second = new FakeClient();
      const { dial } = makeDialQueue([
        { ok: true, client: first },
        { ok: false, error: new Error("down") },
        { ok: true, client: second },
      ]);
      const { log, onStatus } = statusLog();
      const mc = new ManagedConnection({
        dial,
        preferredRoute: "ws",
        canFallBackToIroh: false,
        onStatus,
        onConnected: () => {},
        now: clock.now,
        sleep: clock.sleep,
      });
      await mc.start();
      first.simulateDrop();
      await waitUntil(() => mc.client === (second));
      expect(log.some(([s]) => s === "unpaired")).toBe(false);
    });
  });
});

await run();
