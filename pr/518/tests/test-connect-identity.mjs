/**
 * Port of sleap-app tests/unit/protocolV1Identity.test.ts @ 683a159.
 * Persistent Ed25519 client identity (pose/connect/identity.js).
 *
 * sleap-app ran these against `fake-indexeddb`; LUCID's identity storage is an
 * injected adapter, so they run against `createMemoryAdapter()` (the same
 * stored-record assertions, read through the adapter), and a minimal fake
 * `IDBFactory` below covers the real IndexedDB adapter (database `lucid-connect`,
 * store `identity`, key `client-identity`, lazily created).
 */
import { describe, it, expect, beforeEach, run } from './bun-test-shim.mjs';
import {
  getClientIdentity,
  clearClientIdentity,
  setIdentityStorage,
  createMemoryAdapter,
  createIndexedDbAdapter,
  _resetClientIdentityCache,
} from '../pose/connect/identity.js';

let adapter = createMemoryAdapter();

async function freshStorage() {
  adapter = createMemoryAdapter();
  setIdentityStorage(adapter); // also drops the in-memory identity
}

const rawNodeId = (nodeId) => {
  let b64 = nodeId.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

describe("protocolV1 identity", () => {
  beforeEach(freshStorage);

  it("generates a node_id that looks like URL-safe base64", async () => {
    const identity = await getClientIdentity();
    expect(identity.nodeId.length).toBeGreaterThan(0);
    expect(identity.nodeId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes to exactly 32 raw bytes (a raw Ed25519 public key)", async () => {
    const identity = await getClientIdentity();
    expect(rawNodeId(identity.nodeId).length).toBe(32);
  });

  it("memoizes across calls within the same process (same node_id)", async () => {
    const a = await getClientIdentity();
    const b = await getClientIdentity();
    expect(b.nodeId).toBe(a.nodeId);
  });

  it("persists across a fresh in-memory cache (same stored key)", async () => {
    const a = await getClientIdentity();
    _resetClientIdentityCache();
    const b = await getClientIdentity();
    expect(b.nodeId).toBe(a.nodeId);
  });

  it("generates a new identity after clearClientIdentity()", async () => {
    const a = await getClientIdentity();
    _resetClientIdentityCache();
    await clearClientIdentity();
    const b = await getClientIdentity();
    expect(b.nodeId).not.toBe(a.nodeId);
  });

  describe("sign", () => {
    it("returns a non-empty URL-safe base64 signature", async () => {
      const identity = await getClientIdentity();
      const sig = await identity.sign("some-nonce");
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces different signatures for different nonces", async () => {
      const identity = await getClientIdentity();
      const sig1 = await identity.sign("nonce-1");
      const sig2 = await identity.sign("nonce-2");
      expect(sig1).not.toBe(sig2);
    });

    it("produces a signature verifiable against the raw public key", async () => {
      const identity = await getClientIdentity();
      const sig = await identity.sign("verify-me");

      const publicKey = await crypto.subtle.importKey("raw", rawNodeId(identity.nodeId), "Ed25519", false, ["verify"]);
      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        rawNodeId(sig),
        new TextEncoder().encode("verify-me"),
      );
      expect(valid).toBe(true);
    });
  });
});

describe("protocolV1 identity storage (no CryptoKey objects at rest)", () => {
  beforeEach(freshStorage);

  it("stores the key as plain bytes, not CryptoKey objects", async () => {
    await getClientIdentity();
    const stored = await adapter.get("client-identity");
    expect(stored.v).toBe(2);
    expect(Object.prototype.toString.call(stored.pkcs8)).toBe("[object ArrayBuffer]");
    expect(Object.prototype.toString.call(stored.publicRaw)).toBe("[object ArrayBuffer]");
    expect(Object.values(stored).some((v) => v instanceof CryptoKey)).toBe(false);
  });

  it("migrates a legacy stored CryptoKeyPair to bytes, keeping the same node_id", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    await adapter.put("client-identity", pair);
    const legacyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    const identity = await getClientIdentity();
    expect(rawNodeId(identity.nodeId)).toEqual(legacyRaw);

    const stored = await adapter.get("client-identity");
    expect(stored.v).toBe(2);
  });

  it("refuses to replace a stored record it can't read (never silently re-keys)", async () => {
    await adapter.put("client-identity", { unreadable: true });
    await expect(getClientIdentity()).rejects.toThrow(/Couldn't read this device's saved pairing key/);
    expect(await adapter.get("client-identity")).toEqual({ unreadable: true }); // untouched
  });

  it("an adapter without has() still refuses when get() returns a record it can't read", async () => {
    const bare = createMemoryAdapter();
    delete bare.has;
    setIdentityStorage(bare);
    await bare.put("client-identity", { unreadable: true });
    await expect(getClientIdentity()).rejects.toThrow(/Couldn't read this device's saved pairing key/);
  });

  it("concurrent first calls share one load (same identity object)", async () => {
    const [a, b, c] = await Promise.all([getClientIdentity(), getClientIdentity(), getClientIdentity()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe("protocolV1 identity: first run in two tabs at once", () => {
  // Two tabs share storage but not memory — modeled by dropping the
  // in-memory cache between two concurrent first calls.
  async function twoTabsFirstRun() {
    await freshStorage();
    const a = getClientIdentity();
    _resetClientIdentityCache();
    const b = getClientIdentity();
    const [ia, ib] = await Promise.all([a, b]);
    _resetClientIdentityCache();
    return [ia.nodeId, ib.nodeId];
  }

  it("both tabs end up with the same stored key when Web Locks serializes creation", async () => {
    // Minimal exclusive Web Locks: one holder at a time, FIFO.
    let tail = Promise.resolve();
    const locks = {
      request: (_name, _opts, fn) => {
        const run = tail.then(fn);
        tail = run.catch(() => {});
        return run;
      },
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    try {
      const [a, b] = await twoTabsFirstRun();
      expect(a).toBe(b);
      expect((await getClientIdentity()).nodeId).toBe(a);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete globalThis.navigator;
    }
  });
});

// ── the real IndexedDB adapter, against a minimal fake IDBFactory ──────────

/** Just enough IndexedDB: open/onupgradeneeded, one store, get/put/delete/count in a transaction. */
function fakeIndexedDB() {
  const dbs = new Map(); // name -> Map(storeName -> Map(key -> value))
  const opened = [];
  const req = (fn) => {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
    });
    return r;
  };
  return {
    opened,
    dbs,
    open(name, version) {
      opened.push({ name, version });
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        r.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => stores.set(n, new Map()),
          close() {},
          transaction: (storeName) => {
            const store = stores.get(storeName);
            const tx = { oncomplete: null, onerror: null };
            const done = () => queueMicrotask(() => tx.oncomplete?.());
            tx.objectStore = () => ({
              get: (k) => req(() => store.get(k)),
              count: (k) => req(() => (store.has(k) ? 1 : 0)),
              put: (v, k) => { store.set(k, v); done(); return req(() => k); },
              delete: (k) => { store.delete(k); done(); return req(() => undefined); },
            });
            return tx;
          },
        };
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}

describe("IndexedDB adapter (lucid-connect)", () => {
  it("is created lazily: importing / constructing never touches indexedDB", async () => {
    const idb = fakeIndexedDB();
    const store = createIndexedDbAdapter({ indexedDB: idb });
    expect(idb.opened).toHaveLength(0);
    expect(await store.get("client-identity")).toBeNull();
    expect(idb.opened).toHaveLength(1);
  });

  it("defaults to database 'lucid-connect', store 'identity', version 1", async () => {
    const idb = fakeIndexedDB();
    setIdentityStorage(createIndexedDbAdapter({ indexedDB: idb }));
    const identity = await getClientIdentity();
    expect(idb.opened[0]).toEqual({ name: "lucid-connect", version: 1 });
    const stored = idb.dbs.get("lucid-connect").get("identity").get("client-identity");
    expect(stored.v).toBe(2);
    expect(rawNodeId(identity.nodeId).length).toBe(32);
    // a fresh process (cache dropped) reads the same key back
    _resetClientIdentityCache();
    expect((await getClientIdentity()).nodeId).toBe(identity.nodeId);
  });

  it("has() reports a record that exists, get() or not", async () => {
    const store = createIndexedDbAdapter({ indexedDB: fakeIndexedDB() });
    expect(await store.has("k")).toBe(false);
    await store.put("k", { a: 1 });
    expect(await store.has("k")).toBe(true);
    await store.delete("k");
    expect(await store.has("k")).toBe(false);
  });

  it("rejects, rather than throwing at import, when there is no indexedDB", async () => {
    const saved = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
      await expect(createIndexedDbAdapter().get("k")).rejects.toThrow("IndexedDB is not available");
    } finally {
      if (saved !== undefined) globalThis.indexedDB = saved;
    }
  });
});

await run();
