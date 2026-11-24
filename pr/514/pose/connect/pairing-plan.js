/**
 * Port of sleap-app src/lib/protocolV1/pairingPlan.ts @ 683a159.
 *
 * How the app will reach a worker from a pasted pairing code — the one
 * decision behind the pairing form, so the form never asks the user to pick
 * a transport (they don't know what iroh or a WebSocket is, and shouldn't
 * have to).
 *
 * - Desktop app + the code has a relay → iroh: direct when it can be,
 *   through the relay when it can't. This covers nearly everyone.
 * - Else a network address in the code (or typed under "Advanced") → a
 *   plain WebSocket, which needs the worker reachable on the network/VPN.
 * - Else nothing can work as-is: say why and open the address box.
 *
 * LUCID changes: none (types became JSDoc). `NOT_A_CODE` and every user-facing
 * string are verbatim, including "The web version" (LUCID's browser build is
 * the web version; the desktop app has iroh).
 */

/** @typedef {"ws" | "iroh"} TransportKind */

/**
 * The parts of a decoded pairing code (or legacy JSON ticket) this needs.
 * @typedef {object} PairingCodeInfo
 * @property {number} [expiresAt] Unix seconds, if the code carries an expiry.
 * @property {string[]} addrs
 * @property {boolean} hasRelay Whether the code has a relay to dial over iroh.
 */

/**
 * @typedef {{kind: "ready", transport: TransportKind, detail: string}
 *   | {kind: "needs-address", reason: string}
 *   | {kind: "error", message: string}} PairingPlan
 */

export const NOT_A_CODE =
  "That doesn't look like a pairing code. Copy the whole line starting with sleap1.";

/**
 * @param {PairingCodeInfo} code
 * @param {{irohAvailable: boolean, addrOverride?: string, now?: number}} opts
 * @returns {PairingPlan}
 */
export function planPairing(code, opts) {
  const now = opts.now ?? Date.now() / 1000;
  if (code.expiresAt !== undefined && code.expiresAt <= now) {
    const mins = Math.max(1, Math.round((now - code.expiresAt) / 60));
    return {
      kind: "error",
      message: `This code expired ${mins} min ago. Run sleap-connect pair on the worker for a new one.`,
    };
  }
  const typed = opts.addrOverride?.trim();
  if (typed) {
    return { kind: "ready", transport: "ws", detail: `Connects to ${typed}.` };
  }
  if (opts.irohAvailable && code.hasRelay) {
    return {
      kind: "ready",
      transport: "iroh",
      detail: "Connects directly when it can, through a relay when it can't.",
    };
  }
  if (code.addrs.length) {
    return {
      kind: "ready",
      transport: "ws",
      detail: `Connects over your network (${code.addrs[0]}).`,
    };
  }
  if (code.hasRelay) {
    return {
      kind: "needs-address",
      reason:
        "The web version can only reach workers on your network or VPN. Use the desktop app, or enter the worker's address.",
    };
  }
  return {
    kind: "needs-address",
    reason:
      "This code doesn't say how to reach the worker. Make sure it's running (sleap-connect serve), then run sleap-connect pair again.",
  };
}

/**
 * The transport to reconnect a paired worker over: iroh whenever this app
 * can use it and the worker has iroh info, else its network address.
 *
 * @param {{iroh?: unknown, addrs: string[]}} worker
 * @param {boolean} irohAvailable
 * @returns {TransportKind | null}
 */
export function preferredTransport(worker, irohAvailable) {
  if (irohAvailable && worker.iroh) return "iroh";
  if (worker.addrs.length) return "ws";
  return null;
}
