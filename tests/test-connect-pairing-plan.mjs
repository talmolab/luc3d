/**
 * Port of sleap-app tests/unit/pairingPlan.test.ts @ 683a159.
 * Pairing-code transport plan (pose/connect/pairing-plan.js).
 */
import { describe, it, expect, run } from './connect-test-utils.mjs';
import { planPairing, preferredTransport } from '../pose/connect/pairing-plan.js';

const NOW = 1_000_000;
const code = (o = {}) => ({
  addrs: [],
  hasRelay: false,
  expiresAt: NOW + 300,
  ...o,
});

describe("planPairing", () => {
  it("desktop + relay → iroh", () => {
    expect(planPairing(code({ hasRelay: true }), { irohAvailable: true, now: NOW })).toMatchObject({
      kind: "ready",
      transport: "iroh",
    });
  });

  it("an address in the code → ws, in either app", () => {
    for (const irohAvailable of [true, false]) {
      expect(
        planPairing(code({ addrs: ["ws://10.0.0.1:9631"] }), { irohAvailable, now: NOW }),
      ).toMatchObject({ kind: "ready", transport: "ws" });
    }
  });

  it("a typed address wins over everything", () => {
    expect(
      planPairing(code({ hasRelay: true }), {
        irohAvailable: true,
        addrOverride: " ws://1.2.3.4:9631 ",
        now: NOW,
      }),
    ).toEqual({ kind: "ready", transport: "ws", detail: "Connects to ws://1.2.3.4:9631." });
  });

  it("browser + relay only → needs an address, and says the web version is why", () => {
    const plan = planPairing(code({ hasRelay: true }), { irohAvailable: false, now: NOW });
    expect(plan.kind).toBe("needs-address");
    expect(plan.kind === "needs-address" && plan.reason).toMatch(/web version/);
  });

  it("nothing to dial → needs an address, and says the worker may not be running", () => {
    const plan = planPairing(code(), { irohAvailable: true, now: NOW });
    expect(plan.kind === "needs-address" && plan.reason).toMatch(/sleap-connect serve/);
  });

  it("an expired code is an error, whatever it carries", () => {
    const plan = planPairing(code({ hasRelay: true, expiresAt: NOW - 120 }), {
      irohAvailable: true,
      now: NOW,
    });
    expect(plan).toMatchObject({ kind: "error" });
    expect(plan.kind === "error" && plan.message).toMatch(/expired 2 min ago/);
  });
});

describe("preferredTransport", () => {
  it("iroh when available and the worker has iroh info, else its address, else nothing", () => {
    expect(preferredTransport({ iroh: {}, addrs: ["ws://x"] }, true)).toBe("iroh");
    expect(preferredTransport({ iroh: {}, addrs: ["ws://x"] }, false)).toBe("ws");
    expect(preferredTransport({ addrs: ["ws://x"] }, true)).toBe("ws");
    expect(preferredTransport({ iroh: {}, addrs: [] }, false)).toBeNull();
  });
});

await run();
