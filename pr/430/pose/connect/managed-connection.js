/**
 * Port of sleap-app src/lib/protocolV1/managedConnection.ts @ 683a159.
 *
 * Owns one worker's `WorkerClient` connection on its caller's behalf:
 * reconnects with backoff after an unintentional close, falls back from ws to
 * iroh once a drop has lasted `FALLBACK_AFTER_MS` (desktop only, when the
 * pairing offers iroh), and — while on that fallback — probes the preferred
 * route every `PROBE_PREFERRED_EVERY_MS` and switches back on success.
 *
 * Pure and injectable: no timers of its own beyond the injectable `sleep`.
 * The store owns one of these per worker that's either selected or has an
 * active tracked job, and supplies `dial`/`onStatus`/`onConnected` to wire it
 * into store state; tests supply a fake clock (`now`/`sleep`) instead.
 *
 * LUCID changes: `start()` now also checks for a `stop()` that landed during
 * the first dial (it closes the late client and throws `client.closed` instead
 * of adopting it and reporting "connected" after "stopped"). Otherwise none in behaviour (backoff 1/2/4/8/15/30 s, 10 s fallback
 * window and 60 s probe period are unchanged); TypeScript types became JSDoc.
 * `canFallBackToIroh` is meant to be `!!worker.iroh && irohTransportAvailable()`
 * from `transport.js`, i.e. false on the web (no iroh socket factory is
 * registered).
 */

import { AUTH_UNTRUSTED, CLIENT_CLOSED, WorkerProtocolError } from "./errors.js?v=82449baaa3c2";

/**
 * `unpaired`: the worker refused this device (`auth.untrusted`) — it was
 * removed there (`sleap-rtc clients remove`). Terminal: retrying can't help
 * until the device pairs again, so the connection stops like `stopped`.
 * @typedef {"connecting" | "connected" | "reconnecting" | "offline" | "stopped" | "unpaired"} LinkStatus
 */

/** @typedef {import("./transport.js?v=82449baaa3c2").TransportKind} TransportKind */
/** @typedef {import("./client.js?v=82449baaa3c2").WorkerClient} WorkerClient */
/** @typedef {import("./client.js?v=82449baaa3c2").CloseInfo} CloseInfo */

/**
 * @typedef {object} ManagedConnectionDeps
 * @property {(route: TransportKind) => Promise<WorkerClient>} dial Make + connect + verify peer + authProve over `route`; resolves an authenticated client or throws.
 * @property {TransportKind} preferredRoute The route the user asked for / remembered — what every reconnect and probe tries to get back to.
 * @property {boolean} canFallBackToIroh Whether falling back to iroh is possible at all (pairing has iroh info AND irohTransportAvailable()).
 * @property {(status: LinkStatus, route: TransportKind) => void} onStatus
 * @property {(client: WorkerClient, route: TransportKind) => void} onConnected Fires after the initial connect, a reconnect, or a route switch — never for a client that didn't become current.
 * @property {() => number} [now] Overridable for tests; defaults to `Date.now`.
 * @property {(ms: number) => Promise<void>} [sleep] Overridable for tests; defaults to a real `setTimeout`-backed delay.
 */

/**
 * Whether `err` is the worker refusing this device because it's no longer paired.
 * @param {unknown} err
 */
export function isUnpairedError(err) {
  return err instanceof WorkerProtocolError && err.code === AUTH_UNTRUSTED;
}

export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
export const FALLBACK_AFTER_MS = 10_000;
export const PROBE_PREFERRED_EVERY_MS = 60_000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ManagedConnection {
  /** @param {ManagedConnectionDeps} deps */
  constructor(deps) {
    this._dial = deps.dial;
    this._preferredRoute = deps.preferredRoute;
    this._canFallBackToIroh = deps.canFallBackToIroh;
    this._onStatus = deps.onStatus;
    this._onConnected = deps.onConnected;
    this._now = deps.now ?? Date.now;
    this._sleep = deps.sleep ?? defaultSleep;
    this._route = deps.preferredRoute;
    /** @type {WorkerClient | null} */
    this._client = null;
    this._stopped = false;
    // Bumped on every adopted client and on stop() — a reconnect/probe loop
    // started against an earlier generation checks this and exits rather than
    // acting once it's stale (rule 8: ignore a close from a client that's no
    // longer current, and never let two loops race to "win" the same slot).
    this._generation = 0;
    this._probeGeneration = 0;
  }

  get client() {
    return this._client;
  }

  get route() {
    return this._route;
  }

  /**
   * Initial connect on the preferred route. Throws on failure — this is a
   * user-initiated action (pair / connect / resume-on-launch), so a failed
   * first dial is the caller's to handle; no silent retry loop starts.
   */
  async start() {
    const generation = this._generation;
    let client;
    try {
      client = await this._dial(this._preferredRoute);
    } catch (err) {
      if (isUnpairedError(err) && !this._stopped && generation === this._generation) this._markUnpaired();
      throw err;
    }
    // stop() landed while the first dial was in flight: this client never became current.
    if (this._stopped || generation !== this._generation) {
      client.close();
      throw new WorkerProtocolError(CLIENT_CLOSED, "Connection stopped before it finished connecting");
    }
    this._route = this._preferredRoute;
    this._adopt(client);
    this._onStatus("connected", this._route);
    this._onConnected(client, this._route);
    return client;
  }

  /** Intentional stop: closes the client, cancels any retry/probe loop. Idempotent. */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._generation++;
    this._probeGeneration++;
    const client = this._client;
    this._client = null;
    this._onStatus("stopped", this._route);
    client?.close();
  }

  /** The worker no longer trusts this device: stop for good and say so. */
  _markUnpaired() {
    this._stopped = true;
    this._generation++;
    this._probeGeneration++;
    this._client = null;
    this._onStatus("unpaired", this._route);
  }

  /** Makes `client` the current one and wires its close notification to this generation. */
  _adopt(client) {
    this._client = client;
    const generation = ++this._generation;
    client.onClose((info) => this._handleClose(client, generation, info));
  }

  _handleClose(client, generation, info) {
    // A close from a client we've already moved on from (replaced by a
    // reconnect, a route switch, or stop()) is never acted on (rule 8).
    if (this._stopped || client !== this._client || generation !== this._generation) return;
    if (info.intentional) return; // our own close() — not a drop to react to
    this._client = null;
    void this._reconnectLoop(generation);
  }

  async _reconnectLoop(generation) {
    this._onStatus("reconnecting", this._route);
    const droppedAt = this._now();
    let attempt = 0;
    let announcedOffline = false;
    let altIndex = 0;
    /** @type {TransportKind[]} */
    const routes =
      this._canFallBackToIroh && this._preferredRoute !== "iroh"
        ? [this._preferredRoute, "iroh"]
        : [this._preferredRoute];

    while (!this._stopped && generation === this._generation) {
      const elapsed = this._now() - droppedAt;
      const windowPassed = elapsed >= FALLBACK_AFTER_MS;

      // Within the window, retry the route we were on. After it, alternate
      // between every usable route, starting with the one we weren't on, so
      // neither a blocked relay nor a still-down LAN can pin us to a route
      // that never comes back (and a drop while on iroh also retries the
      // preferred route).
      /** @type {TransportKind} */
      let dialRoute = this._route;
      if (windowPassed && routes.length > 1) {
        dialRoute = routes[(routes.indexOf(this._route) + 1 + altIndex) % routes.length];
        altIndex++;
      }

      try {
        const client = await this._dial(dialRoute);
        if (this._stopped || generation !== this._generation) {
          client.close();
          return;
        }
        this._route = dialRoute;
        this._adopt(client);
        this._onStatus("connected", this._route);
        this._onConnected(client, this._route);
        if (this._route !== this._preferredRoute) this._startProbeLoop();
        return;
      } catch (err) {
        // Removed on the worker: no amount of retrying gets back in.
        if (isUnpairedError(err) && !this._stopped && generation === this._generation) {
          this._markUnpaired();
          return;
        }
        // Otherwise fall through to backoff + retry below.
      }

      if (this._stopped || generation !== this._generation) return;
      // Unreachable on every route we tried past the window: say so (once),
      // and keep retrying.
      if (windowPassed && !announcedOffline) {
        announcedOffline = true;
        this._onStatus("offline", this._route);
      }
      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt++;
      await this._sleep(backoff);
    }
  }

  _startProbeLoop() {
    const probeGeneration = ++this._probeGeneration;
    const connectionGeneration = this._generation;
    void this._probeLoop(probeGeneration, connectionGeneration);
  }

  /**
   * Runs only while still on the SAME connection (`connectionGeneration`)
   * that started it and still off the preferred route — a reconnect or a
   * successful switch invalidates it (via `_generation`/`_probeGeneration`),
   * letting a fresh probe loop (or none, if back on preferred) take over.
   */
  async _probeLoop(probeGeneration, connectionGeneration) {
    const stillRelevant = () =>
      !this._stopped &&
      probeGeneration === this._probeGeneration &&
      connectionGeneration === this._generation &&
      this._route !== this._preferredRoute;

    while (stillRelevant()) {
      await this._sleep(PROBE_PREFERRED_EVERY_MS);
      if (!stillRelevant()) return;

      try {
        const client = await this._dial(this._preferredRoute);
        if (!stillRelevant()) {
          client.close();
          return;
        }
        const old = this._client;
        this._route = this._preferredRoute;
        this._adopt(client); // bumps _generation; `old`'s close becomes stale and is ignored.
        old?.close();
        this._onStatus("connected", this._route);
        this._onConnected(client, this._route);
        return;
      } catch {
        // Stay on the fallback route; try again next tick.
      }
    }
  }
}
