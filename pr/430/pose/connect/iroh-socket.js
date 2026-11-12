/**
 * Port of sleap-app src/lib/protocolV1/tauriIrohSocket.ts @ 683a159.
 *
 * A `WebSocketLike` (see `client.js`) backed by a Rust-owned iroh QUIC
 * connection (`src-tauri/src/iroh_client.rs`), for the desktop app instead of
 * a browser `WebSocket`. Rust is only a byte pipe: this file translates
 * between `WebSocketLike`'s callbacks and the `iroh_connect` / `iroh_send` /
 * `iroh_disconnect` commands. All hello/auth/job logic stays in `WorkerClient`,
 * shared with the WebSocket transport (`createSocket` is its injection point).
 * `WorkerClientOptions.url` carries the dial target as JSON
 * (`encodeIrohDialUrl`, `transport.js`).
 *
 * LUCID changes:
 *  - The IPC is `window.lucidDesktop.iroh` (the shim, `src-tauri/js/
 *    lucid-desktop.js`), INJECTED as `getIroh` so Node tests can fake it, not
 *    `@tauri-apps/api` + `sleapCmd`. Its `connect(target, onEvent)` creates the
 *    Tauri Channel itself and resolves to the connection id; events keep
 *    sleap-app's shape (`{kind:"message", data}` | `{kind:"closed"}` |
 *    `{kind:"error", message}`). `send` / `disconnect` take the connection id.
 *  - `encodeIrohDialUrl` / `decodeIrohDialUrl` live in `transport.js` (same
 *    messages); re-exported here for sleap-app's import path.
 *  - Plain JS; the types are JSDoc.
 *  - P8 stress review, to behave like a real `WebSocket` for `WorkerClient`:
 *    events that arrive while `iroh_connect` is still resolving (the Channel can
 *    beat the invoke's reply) are held and replayed right after `onopen`;
 *    nothing is delivered once CLOSED (a late message/error after a close);
 *    `close()` while CONNECTING ends the socket at once (error + close, code
 *    1006, as a browser does) and the connection that completes afterwards is
 *    disconnected silently; the close events carry `code`/`wasClean`.
 *  - Non-object events from the shim are ignored (sleap-app dereferences
 *    `event.kind` directly), and a rejected `disconnect` is swallowed (sleap-app
 *    lets it surface as an unhandled rejection).
 *
 * Registered at startup by `ui/connect/index.js`:
 * `registerIrohSocketFactory(createIrohSocketFactory(() => window.lucidDesktop.iroh))`.
 */
import { decodeIrohDialUrl, encodeIrohDialUrl } from "./transport.js?v=82449baaa3c2";

export { encodeIrohDialUrl };

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * The slice of `window.lucidDesktop.iroh` the socket needs.
 * @typedef {object} IrohShim
 * @property {(target: {nodeId: string, relayUrl?: string, directAddrs?: string[]}, onEvent: (event: object) => void) => Promise<number>} connect
 * @property {(connId: number, msg: string) => Promise<unknown>} send
 * @property {(connId: number) => Promise<unknown>} disconnect
 */

/**
 * Returns a `createSocket` function for `WorkerClientOptions`: the same shape
 * as `(url) => new WebSocket(url)`, dialing a worker over iroh via the desktop
 * shell. `getIroh` returns the shim (a promise is fine); overridable for tests.
 *
 * @param {() => IrohShim | Promise<IrohShim>} getIroh
 * @returns {(url: string) => IrohSocket}
 */
export function createIrohSocketFactory(getIroh) {
  return (url) => new IrohSocket(url, getIroh);
}

/** The socket `createIrohSocketFactory` hands out (a `WebSocketLike`). */
export class IrohSocket {
  /**
   * @param {string} url
   * @param {() => IrohShim | Promise<IrohShim>} getIroh
   */
  constructor(url, getIroh) {
    this.readyState = WS_CONNECTING;
    /** @type {((ev: unknown) => void) | null} */ this.onopen = null;
    /** @type {((ev: {data: string}) => void) | null} */ this.onmessage = null;
    /** @type {((ev: unknown) => void) | null} */ this.onclose = null;
    /** @type {((ev: unknown) => void) | null} */ this.onerror = null;
    /** This socket's connection in the Rust registry, set once `iroh_connect` returns. @type {number | null} */
    this.irohConnectionId = null;
    /** @type {IrohShim | null} */ this._iroh = null;
    this._closedByUs = false;
    /** Events that arrived before `onopen` could fire. @type {any[]} */
    this._early = [];
    void this._connect(url, getIroh);
  }

  /** @param {string} url @param {() => IrohShim | Promise<IrohShim>} getIroh */
  async _connect(url, getIroh) {
    // Nothing runs synchronously during construction: a real WebSocket never
    // calls onerror/onclose before its constructor returns, and
    // `WorkerClient.connect()` attaches its handlers right after.
    await Promise.resolve();

    let target;
    try {
      target = decodeIrohDialUrl(url);
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    let iroh;
    try {
      iroh = await getIroh();
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    try {
      this.irohConnectionId = await iroh.connect(
        { nodeId: target.nodeId, relayUrl: target.relayUrl, directAddrs: target.directAddrs },
        (event) => this._handleEvent(event),
      );
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    this._iroh = iroh;
    if (this._closedByUs) {
      // close() arrived while iroh_connect was in flight (the socket already
      // reported its close); the Rust connection did complete, so tear it down
      // rather than leak it.
      this._early = [];
      void this._disconnect();
      return;
    }
    this.readyState = WS_OPEN;
    if (this.onopen) this.onopen({});
    const early = this._early;
    this._early = [];
    for (const event of early) this._handleEvent(event);
  }

  /** @param {unknown} err */
  _failToConnect(err) {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._early = [];
    if (this.onerror) this.onerror(err);
    if (this.onclose) this.onclose({ code: 1006, wasClean: false, reason: String(err && err.message || err || "") });
  }

  /** @param {any} event */
  _handleEvent(event) {
    if (!event || typeof event !== "object") return;
    // Nothing is delivered once CLOSED, as with a WebSocket.
    if (this.readyState === WS_CLOSED) return;
    if (this.readyState === WS_CONNECTING) {
      // iroh_connect has not resolved yet: hold the event until onopen has fired.
      this._early.push(event);
      return;
    }
    switch (event.kind) {
      case "message":
        if (typeof event.data === "string" && this.onmessage) this.onmessage({ data: event.data });
        break;
      case "closed":
        this.readyState = WS_CLOSED;
        if (this.onclose) {
          this.onclose({ code: this._closedByUs ? 1000 : 1006, wasClean: this._closedByUs, reason: "" });
        }
        break;
      case "error":
        if (this.onerror) this.onerror(new Error(event.message));
        break;
    }
  }

  /** @param {string} data */
  send(data) {
    if (this.readyState !== WS_OPEN || !this._iroh) return;
    this._iroh
      .send(/** @type {number} */ (this.irohConnectionId), data)
      .catch((err) => {
        if (this.onerror) this.onerror(err);
      });
  }

  close() {
    if (this.readyState === WS_CLOSED || this._closedByUs) return;
    this._closedByUs = true;
    if (this.readyState !== WS_OPEN) {
      // Still connecting: end the socket now, as a browser does (error, then
      // close 1006). _connect's completion notices _closedByUs and disconnects
      // the connection once (if) it actually establishes.
      this.readyState = WS_CLOSED;
      this._early = [];
      queueMicrotask(() => {
        if (this.onerror) this.onerror(new Error("Closed before the connection opened"));
        if (this.onclose) this.onclose({ code: 1006, wasClean: false, reason: "" });
      });
      return;
    }
    this.readyState = WS_CLOSING;
    void this._disconnect();
  }

  async _disconnect() {
    try {
      if (this._iroh) await this._iroh.disconnect(/** @type {number} */ (this.irohConnectionId));
    } catch (_) {
      // The connection may already be gone (worker closed first); closing is the goal.
    } finally {
      if (this.readyState !== WS_CLOSED) {
        this.readyState = WS_CLOSED;
        if (this.onclose) this.onclose({ code: 1000, wasClean: true, reason: "" });
      }
    }
  }
}
