/**
 * Port of sleap-app src/lib/protocolV1/transport.ts @ 683a159.
 *
 * Which transport a `WorkerClient` connection runs over (stage 2.6):
 * the plain WebSocket dial (`ws://host:port`, works in browser + desktop) or
 * a direct iroh QUIC connection (desktop only, via an injected socket factory).
 *
 * The choice is always explicit — there's no automatic failover between the
 * two in this module (that's `managed-connection.js`). A worker only offers
 * iroh if its pairing ticket carried an `iroh` section; tickets without one
 * behave exactly as before.
 *
 * LUCID changes:
 *  - `decodeIrohDialUrl` rejects a JSON `null` payload with its usual error
 *    message (sleap-app threw a raw TypeError reading a property of null).
 *  - `irohTransportAvailable()` is not `isTauri`. sleap-app's iroh socket is
 *    its own `tauriIrohSocket.ts`; LUCID keeps that seam but makes it a
 *    REGISTERED capability: the desktop app calls
 *    `registerIrohSocketFactory(createTauriIrohSocket())` at startup (a later
 *    phase), after which iroh is available. A plain browser never registers
 *    one, so iroh is unavailable there (the web version reaches workers over
 *    ws:// only). The factory has `WorkerClientOptions.createSocket`'s shape,
 *    `(url) => WebSocketLike`, and receives `encodeIrohDialUrl(target)`.
 *  - `encodeIrohDialUrl` / `decodeIrohDialUrl` (sleap-app: in
 *    `tauriIrohSocket.ts`) live here, since they are pure JSON and both the
 *    dialer and the future Tauri socket need them.
 *  - `toIrohDialTarget` returns a plain object (no `IrohDialTarget` import).
 */

/** @typedef {"ws" | "iroh"} TransportKind */

/**
 * The optional `iroh` section of a pairing ticket / paired worker.
 * @typedef {object} IrohEndpointInfo
 * @property {string} [nodeId] The worker's iroh endpoint id; falls back to the protocol node_id when absent.
 * @property {string} [relayUrl]
 * @property {string[]} [directAddrs]
 */

/**
 * @typedef {object} IrohDialTarget
 * @property {string} nodeId
 * @property {string} [relayUrl]
 * @property {string[]} [directAddrs]
 */

/**
 * Tolerantly reads a ticket's `iroh` section (snake_case wire keys). Returns
 * `undefined` for anything that isn't a usable object, so a malformed
 * section never breaks pairing over WebSocket.
 *
 * @param {unknown} raw
 * @returns {IrohEndpointInfo | undefined}
 */
export function parseTicketIroh(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const directAddrs = Array.isArray(r.direct_addrs)
    ? r.direct_addrs.filter((a) => typeof a === "string" && a.length > 0)
    : undefined;
  return {
    nodeId: str(r.node_id),
    relayUrl: str(r.relay_url),
    directAddrs: directAddrs && directAddrs.length > 0 ? directAddrs : undefined,
  };
}

/** @type {((url: string) => unknown) | null} */
let irohSocketFactory = null;

/**
 * Registers (or, with `null`, removes) the iroh socket factory: a
 * `createSocket`-shaped `(url) => WebSocketLike` that dials the worker over
 * iroh. The desktop app registers one at startup; the web never does.
 *
 * @param {((url: string) => unknown) | null} factory
 */
export function registerIrohSocketFactory(factory) {
  irohSocketFactory = factory ?? null;
}

/** The registered iroh socket factory, or null when iroh is unavailable. */
export function getIrohSocketFactory() {
  return irohSocketFactory;
}

/** Whether direct iroh connections can be dialed from this runtime. */
export function irohTransportAvailable() {
  return irohSocketFactory !== null;
}

/**
 * How a connection runs, in words for people (shown after "via"): iroh is
 * direct when it can be and relayed when it can't; a WebSocket needs the
 * worker on the network/VPN. Never the transports' own names.
 *
 * @param {TransportKind} kind
 */
export function transportLabel(kind) {
  return kind === "iroh" ? "internet (direct or relay)" : "local network";
}

/**
 * @param {IrohEndpointInfo} info
 * @param {string} fallbackNodeId
 * @returns {IrohDialTarget}
 */
export function toIrohDialTarget(info, fallbackNodeId) {
  return {
    nodeId: info.nodeId ?? fallbackNodeId,
    relayUrl: info.relayUrl,
    directAddrs: info.directAddrs,
  };
}

/**
 * Packs a dial target into the opaque string `WorkerClientOptions.url` carries.
 * @param {IrohDialTarget} target
 */
export function encodeIrohDialUrl(target) {
  return JSON.stringify(target);
}

/**
 * Unpacks `encodeIrohDialUrl`'s string (sleap-app `tauriIrohSocket.ts`, same
 * messages).
 * @param {string} url
 * @returns {IrohDialTarget}
 */
export function decodeIrohDialUrl(url) {
  let parsed;
  try {
    parsed = JSON.parse(url);
  } catch (err) {
    throw new Error(
      `Not a valid iroh dial target (expected JSON from encodeIrohDialUrl): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed.nodeId !== "string" || parsed.nodeId.length === 0) {
    throw new Error("iroh dial target is missing nodeId");
  }
  return {
    nodeId: parsed.nodeId,
    relayUrl: parsed.relayUrl,
    directAddrs: parsed.directAddrs,
  };
}
