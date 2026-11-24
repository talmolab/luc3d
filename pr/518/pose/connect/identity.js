/**
 * Port of sleap-app src/lib/protocolV1/identity.ts @ 683a159.
 *
 * Persistent Ed25519 client identity for protocol v1 pairing/auth.
 *
 * Per spec §3.1, the app generates a keypair on first run and keeps it
 * forever — this is a per-device identity, not per-account. Encoding
 * matches `sleap_rtc.auth.keypair` / the worker-side `WorkerIdentity`
 * (`sleap_rtc/protocol_v1/identity.py`): `node_id` is the raw 32-byte
 * Ed25519 public key, URL-safe base64, no padding; signatures are encoded
 * the same way.
 *
 * The key is stored as plain bytes (PKCS#8 private key + raw public key),
 * NOT as `CryptoKey` objects. WebKit (Safari, Tauri's macOS WebView)
 * encrypts any `CryptoKey` written to IndexedDB with a "WebCrypto Master
 * Key" kept in the macOS keychain, so every read asked for the keychain
 * password, and again after each rebuild or update of an unsigned app.
 * Plain bytes keep the key protected the way the worker's own key file
 * is: by the app's data directory, not the keychain.
 *
 * LUCID changes:
 *  - Storage is an injected adapter `{get(key), put(key, value), delete(key)}`
 *    (optionally `has(key)`, see below). `setIdentityStorage(adapter)` swaps
 *    it; the default is `createIndexedDbAdapter()`, built LAZILY on the first
 *    identity call (never at import time, so Node can import this module).
 *    Node tests use `createMemoryAdapter()`.
 *  - IndexedDB database name is `lucid-connect` (sleap-app: `sleap-app-protocol-v1`);
 *    object store `identity` and key `client-identity` are unchanged.
 *  - The Web Locks name is `lucid-connect-identity` (sleap-app:
 *    `sleap-app-protocol-v1-identity`), matching the database.
 *  - "Record exists but unreadable" (sleap-app: `hasStoredRecord`, an IDB
 *    `count`) is the adapter's optional `has(key)`; without it the check
 *    falls back to `get(key) !== null`, i.e. an adapter that cannot tell
 *    "absent" from "unreadable" never refuses.
 *  - The unreadable-record error no longer names "sleap-app WebCrypto Master
 *    Key" (that is the keychain item of the sleap-app bundle); it says
 *    "the WebCrypto Master Key" of this app.
 *  - Identity is a per-ORIGIN IndexedDB record, so LUCID's web build and the
 *    desktop app have different node ids and pair separately, as sleap-app's do.
 */

const DB_NAME = "lucid-connect";
const DB_VERSION = 1;
const STORE_NAME = "identity";
const KEY_ID = "client-identity";

/**
 * @typedef {object} ClientIdentity
 * @property {string} nodeId This device's public identity — URL-safe base64 Ed25519 public key.
 * @property {(nonce: string) => Promise<string>} sign Sign a nonce (e.g. the worker's `hello.nonce`) with this identity.
 */

/**
 * Key-value storage for the identity record. `get` resolves `null` (or
 * `undefined`) when absent. `has` is optional: true when ANY record exists
 * under the key even if `get` cannot make sense of it.
 * @typedef {object} IdentityStorage
 * @property {(key: string) => Promise<unknown>} get
 * @property {(key: string, value: unknown) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(key: string) => Promise<boolean>} [has]
 */

// ── base64 helpers (URL-safe, no padding) — matches sleap_rtc.auth.keypair ──

/** @param {Uint8Array} bytes */
function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Tag check, not `instanceof`: a structured-cloned buffer can come from
// another realm.
const isArrayBuffer = (v) => Object.prototype.toString.call(v) === "[object ArrayBuffer]";

/**
 * What's stored under `KEY_ID`: `{v: 2, pkcs8: ArrayBuffer, publicRaw: ArrayBuffer}`
 * (PKCS#8 Ed25519 private key + raw 32-byte public key).
 * @param {unknown} value
 */
function isStoredIdentity(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.v === 2 &&
    isArrayBuffer(value.pkcs8) &&
    isArrayBuffer(value.publicRaw)
  );
}

// ── storage adapters ─────────────────────────────────────────────────

/**
 * IndexedDB-backed storage (one object store, out-of-line keys). Opens the
 * database per operation, like sleap-app, and closes it after.
 *
 * @param {{dbName?: string, storeName?: string, indexedDB?: IDBFactory}} [opts]
 *   `indexedDB` defaults to `globalThis.indexedDB`, read when an operation
 *   runs (never at import or construction).
 * @returns {IdentityStorage}
 */
export function createIndexedDbAdapter(opts = {}) {
  const dbName = opts.dbName ?? DB_NAME;
  const storeName = opts.storeName ?? STORE_NAME;

  /** @returns {Promise<IDBDatabase>} */
  const openDB = () =>
    new Promise((resolve, reject) => {
      const factory = opts.indexedDB ?? globalThis.indexedDB;
      if (!factory) {
        reject(new Error("IndexedDB is not available in this environment"));
        return;
      }
      const request = factory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  /**
   * One read request, resolving its result.
   * @param {(store: IDBObjectStore) => IDBRequest} fn
   */
  async function read(fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = fn(db.transaction(storeName, "readonly").objectStore(storeName));
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  }

  /** @param {(store: IDBObjectStore) => unknown} fn */
  async function write(fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      fn(tx.objectStore(storeName));
      tx.oncomplete = () => {
        db.close();
        resolve(undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  return {
    async get(key) {
      return (await read((s) => s.get(key))) ?? null;
    },
    async put(key, value) {
      await write((s) => s.put(value, key));
    },
    async delete(key) {
      await write((s) => s.delete(key));
    },
    // WebKit can fail to unwrap a legacy keychain-wrapped `CryptoKeyPair` and
    // hand back nothing, which must not be mistaken for "first run": count the
    // record without deserializing it.
    async has(key) {
      return (await read((s) => s.count(key))) > 0;
    },
  };
}

/**
 * In-memory storage, for Node tests. Values are held by reference.
 * @returns {IdentityStorage & {map: Map<string, unknown>}}
 */
export function createMemoryAdapter() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async has(key) {
      return map.has(key);
    },
  };
}

/** @type {IdentityStorage | null} */
let _storage = null;

/**
 * Replace the identity storage (the default is IndexedDB, created on first
 * use). Drops the in-memory identity so the next call loads from `adapter`.
 * @param {IdentityStorage | null} adapter `null` restores the lazy default.
 */
export function setIdentityStorage(adapter) {
  _storage = adapter;
  _resetClientIdentityCache();
}

/** @returns {IdentityStorage} */
function storage() {
  if (!_storage) _storage = createIndexedDbAdapter();
  return _storage;
}

/** Deletes the stored identity — for tests only; a real device keeps one forever. */
export async function clearClientIdentity() {
  await storage().delete(KEY_ID);
}

/** Web Locks name serializing identity load/creation across this origin's tabs and windows. */
export const IDENTITY_LOCK_NAME = "lucid-connect-identity";

/**
 * Runs `fn` holding an exclusive cross-tab lock (Web Locks API), so two
 * tabs opening for the first time can't both generate a key — the second
 * waits, then reads the key the first one stored. Without this the last
 * write wins and the other tab could pair with a key that no longer exists.
 * Falls back to running unlocked where Web Locks is missing (tests, very
 * old WebViews).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIdentityLock(fn) {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(IDENTITY_LOCK_NAME, { mode: "exclusive" }, fn);
}

/** @type {ClientIdentity | null} */
let _cached = null;
// Concurrent first callers (several workers connecting at once) share one
// load, so the stored key is read once per launch.
/** @type {Promise<ClientIdentity> | null} */
let _pending = null;

/**
 * Exports an extractable key pair as the bytes stored under `KEY_ID`.
 * @param {CryptoKeyPair} pair
 */
async function toStoredIdentity(pair) {
  return {
    v: 2,
    pkcs8: await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    publicRaw: await crypto.subtle.exportKey("raw", pair.publicKey),
  };
}

/** @returns {Promise<ClientIdentity>} */
async function loadOrCreateIdentity() {
  const store = storage();
  const value = await store.get(KEY_ID);
  let stored;
  if (isStoredIdentity(value)) {
    stored = value;
  } else if (value && typeof value === "object" && "privateKey" in value) {
    // Legacy: a `CryptoKeyPair` stored before v2. Reading it needed the
    // keychain one last time; rewrite it as bytes so it never does again.
    // Same key, so existing pairings keep working.
    stored = await toStoredIdentity(/** @type {CryptoKeyPair} */ (value));
    await store.put(KEY_ID, stored);
  } else {
    // A record we couldn't read is this device's real identity (every
    // worker it paired with knows it); replacing it would silently unpair
    // them all. Refuse instead.
    const exists = store.has ? await store.has(KEY_ID) : value !== null && value !== undefined;
    if (exists) {
      throw new Error(
        "Couldn't read this device's saved pairing key. On macOS, allow the keychain prompt " +
          'for "WebCrypto Master Key" and try again.',
      );
    }
    const pair = /** @type {CryptoKeyPair} */ (
      await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    );
    stored = await toStoredIdentity(pair);
    await store.put(KEY_ID, stored);
  }

  // Non-extractable in memory: nothing in the app can read the key back out.
  const privateKey = await crypto.subtle.importKey("pkcs8", stored.pkcs8, "Ed25519", false, ["sign"]);
  const nodeId = bytesToB64(new Uint8Array(stored.publicRaw));

  return {
    nodeId,
    async sign(nonce) {
      const data = new TextEncoder().encode(nonce);
      const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
      return bytesToB64(new Uint8Array(signature));
    },
  };
}

/**
 * Load this device's persistent protocol-v1 identity, generating one on
 * first call. Memoized in-process — the private `CryptoKey` never leaves
 * this module; callers only ever see `nodeId` and `sign()`.
 *
 * @returns {Promise<ClientIdentity>}
 */
export async function getClientIdentity() {
  if (_cached) return _cached;
  if (!_pending) {
    _pending = withIdentityLock(loadOrCreateIdentity)
      .then((identity) => {
        _cached = identity;
        return identity;
      })
      .finally(() => {
        _pending = null;
      });
  }
  return _pending;
}

/** Drops the in-memory cache — for tests only; does not touch storage. */
export function _resetClientIdentityCache() {
  _cached = null;
  _pending = null;
}
