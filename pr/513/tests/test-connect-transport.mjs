/**
 * Port of sleap-app tests/unit/protocolV1Transport.test.ts @ 683a159.
 * Ticket iroh parsing and labels (pose/connect/transport.js).
 */
import { describe, it, expect, itEach, run } from './bun-test-shim.mjs';
import {
  parseTicketIroh,
  toIrohDialTarget,
  transportLabel,
  irohTransportAvailable,
  registerIrohSocketFactory,
  getIrohSocketFactory,
  encodeIrohDialUrl,
  decodeIrohDialUrl,
} from '../pose/connect/transport.js';

describe("parseTicketIroh", () => {
  it("reads the snake_case wire keys", () => {
    expect(
      parseTicketIroh({ node_id: "n", relay_url: "https://r", direct_addrs: ["1.2.3.4:5"] }),
    ).toEqual({ nodeId: "n", relayUrl: "https://r", directAddrs: ["1.2.3.4:5"] });
  });

  itEach([undefined, null, "str", 3, true])("returns undefined for a non-object (%p)", (raw) => {
    expect(parseTicketIroh(raw)).toBeUndefined();
  });

  it("tolerates wrong-typed and empty fields", () => {
    expect(
      parseTicketIroh({ node_id: 5, relay_url: "", direct_addrs: ["a", 3, "", null] }),
    ).toEqual({ nodeId: undefined, relayUrl: undefined, directAddrs: ["a"] });
    expect(parseTicketIroh({ direct_addrs: "nope" })?.directAddrs).toBeUndefined();
    expect(parseTicketIroh({ direct_addrs: [] })?.directAddrs).toBeUndefined();
  });
});

describe("toIrohDialTarget / transportLabel", () => {
  it("prefers the iroh section's node_id, falling back to the protocol one", () => {
    expect(toIrohDialTarget({ nodeId: "a" }, "b").nodeId).toBe("a");
    expect(toIrohDialTarget({}, "b").nodeId).toBe("b");
  });

  it("labels both transports", () => {
    expect(transportLabel("ws")).toBe("local network");
    expect(transportLabel("iroh")).toBe("internet (direct or relay)");
  });
});

// LUCID: iroh availability is a registered capability, not `isTauri`.
describe("iroh socket factory registration (LUCID)", () => {
  it("is unavailable until a factory is registered (the web), then available, then unavailable again", () => {
    expect(irohTransportAvailable()).toBe(false);
    expect(getIrohSocketFactory()).toBeNull();
    const factory = () => ({});
    registerIrohSocketFactory(factory);
    expect(irohTransportAvailable()).toBe(true);
    expect(getIrohSocketFactory()).toBe(factory);
    registerIrohSocketFactory(null);
    expect(irohTransportAvailable()).toBe(false);
    expect(getIrohSocketFactory()).toBeNull();
  });
});

describe("encodeIrohDialUrl / decodeIrohDialUrl", () => {
  it("round-trips a dial target", () => {
    const target = { nodeId: "abc", relayUrl: "https://r/", directAddrs: ["1.2.3.4:5"] };
    expect(decodeIrohDialUrl(encodeIrohDialUrl(target))).toEqual(target);
  });

  it("rejects non-JSON and a target without a nodeId", () => {
    expect(() => decodeIrohDialUrl("ws://host:1")).toThrow(/Not a valid iroh dial target/);
    expect(() => decodeIrohDialUrl("{}")).toThrow("iroh dial target is missing nodeId");
    expect(() => decodeIrohDialUrl('{"nodeId":""}')).toThrow("iroh dial target is missing nodeId");
    expect(() => decodeIrohDialUrl("null")).toThrow("iroh dial target is missing nodeId");
  });
});

await run();
