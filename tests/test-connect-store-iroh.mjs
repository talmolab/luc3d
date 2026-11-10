/**
 * Port of sleap-app tests/unit/connectStoreIroh.test.ts @ 683a159 against pose/connect/store.js.
 * Desktop (Tauri) mode there = an iroh socket factory is registered here (`registerIrohSocketFactory`,
 * transport.js); the web-mode assertions are in test-connect-store.mjs. A few LUCID cases are appended
 * (iroh unavailable again after the factory is removed; a remembered iroh worker falls back to ws then).
 */
console.warn = () => {};
import { describe, it, expect, beforeEach, run, MemoryStorage } from './connect/store-test-env.mjs';
import { useConnectStore, configureConnect, __resetManagedConnections, __setManagedDeps } from '../pose/connect/store.js';
import { registerIrohSocketFactory } from '../pose/connect/transport.js';
class FakeWorkerClient {
    opts;
    static instances = [];
    static failWsConnect = null;
    peerNodeId = "worker-node-id";
    authenticated = false;
    fetchBlobCalls = 0;
    closed = false;
    _closeListeners = new Set();
    constructor(opts){
        this.opts = opts;
        FakeWorkerClient.instances.push(this);
    }
    async connect() {
        if (FakeWorkerClient.failWsConnect && this.opts.url.startsWith("ws://")) {
            throw FakeWorkerClient.failWsConnect;
        }
    }
    async pairClaim() {
        this.authenticated = true;
    }
    async authProve() {
        this.authenticated = true;
    }
    async fsMounts() {
        return [];
    }
    async jobsStatus() {
        throw new Error("job.not_found");
    }
    async fetchBlob() {
        this.fetchBlobCalls++;
        return new Uint8Array([
            1
        ]);
    }
    onClose(cb) {
        this._closeListeners.add(cb);
        return ()=>this._closeListeners.delete(cb);
    }
    simulateDrop() {
        for (const cb of [
            ...this._closeListeners
        ])cb({
            intentional: false
        });
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        for (const cb of [
            ...this._closeListeners
        ])cb({
            intentional: true
        });
    }
}
// Desktop mode: an iroh socket factory is registered (sleap-app: `isTauri: true`).
const IROH_SOCKET = () => ({});
function setup() {
    configureConnect(null);
    configureConnect({
        WorkerClient: FakeWorkerClient,
        getClientIdentity: async ()=>({ nodeId: "client-node-id", sign: async ()=>"sig" }),
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage()
    });
    registerIrohSocketFactory(IROH_SOCKET);
}
setup();
const TICKET_WITH_IROH = JSON.stringify({
    node_id: "worker-node-id",
    addrs: [
        "ws://192.168.1.42:9631"
    ],
    secret: "s",
    iroh: {
        node_id: "iroh-id",
        relay_url: "https://relay.example",
        direct_addrs: [
            "1.2.3.4:5"
        ]
    }
});
const TICKET_NO_IROH = JSON.stringify({
    node_id: "worker-node-id",
    addrs: [
        "ws://192.168.1.42:9631"
    ],
    secret: "s"
});
function last() {
    return FakeWorkerClient.instances[FakeWorkerClient.instances.length - 1];
}
async function store() {
    return useConnectStore;
}
describe("connectStore iroh transport (desktop)", ()=>{
    beforeEach(async ()=>{
        FakeWorkerClient.instances.length = 0;
        FakeWorkerClient.failWsConnect = null;
        const s = await store();
                __resetManagedConnections();
        __setManagedDeps({});
        s.setState({
            pairedWorkers: [],
            selectedWorkerId: null,
            trackedJobs: [],
            connectionStatus: "disconnected",
            connectionError: null,
            workerMounts: [],
            reattachableJob: null,
            activeTransport: null,
            connections: {},
            _client: null
        });
    });
    it("dials the iroh endpoint via the tauri iroh socket when explicitly requested", async ()=>{
        const s = await store();
        await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, {
            transport: "iroh"
        });
        const client = last();
        expect(typeof client.opts.createSocket).toBe("function");
        expect(JSON.parse(client.opts.url)).toEqual({
            nodeId: "iroh-id",
            relayUrl: "https://relay.example",
            directAddrs: [
                "1.2.3.4:5"
            ]
        });
        const state = s.getState();
        expect(state.activeTransport).toBe("iroh");
        expect(state.connectionStatus).toBe("connected");
        expect(state.pairedWorkers[0].transport).toBe("iroh");
    });
    it("falls back to the protocol node_id when the iroh section omits one", async ()=>{
        const s = await store();
        const ticket = JSON.stringify({
            node_id: "worker-node-id",
            secret: "s",
            iroh: {
                relay_url: "https://relay.example"
            }
        });
        await s.getState().pairWithTicket(ticket, undefined, {
            transport: "iroh"
        });
        expect(JSON.parse(last().opts.url).nodeId).toBe("worker-node-id");
    });
    it("stays on ws by default even in the desktop app", async ()=>{
        const s = await store();
        await s.getState().pairWithTicket(TICKET_WITH_IROH);
        expect(last().opts.url).toBe("ws://192.168.1.42:9631");
        expect(last().opts.createSocket).toBeUndefined();
        expect(s.getState().activeTransport).toBe("ws");
    });
    it("rejects an iroh connect for a ticket without an iroh section", async ()=>{
        const s = await store();
        await expect(s.getState().pairWithTicket(TICKET_NO_IROH, undefined, {
            transport: "iroh"
        })).rejects.toThrow(/no internet connection info/);
        expect(FakeWorkerClient.instances).toHaveLength(0);
        expect(s.getState().connectionStatus).toBe("disconnected");
    });
    it("reconnect reuses the remembered iroh transport, and an explicit ws override wins", async ()=>{
        const s = await store();
        await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, {
            transport: "iroh"
        });
        await s.getState().connectToWorker("worker-node-id");
        expect(s.getState().activeTransport).toBe("iroh");
        expect(typeof last().opts.createSocket).toBe("function");
        await s.getState().connectToWorker("worker-node-id", {
            transport: "ws"
        });
        expect(s.getState().activeTransport).toBe("ws");
        expect(last().opts.url).toBe("ws://192.168.1.42:9631");
        expect(s.getState().pairedWorkers[0].transport).toBeUndefined();
    });
    it("an iroh-only pairing (no addresses) can reconnect over iroh", async ()=>{
        const s = await store();
        const ticket = JSON.stringify({
            node_id: "worker-node-id",
            secret: "s",
            iroh: {
                node_id: "iroh-id"
            }
        });
        await s.getState().pairWithTicket(ticket, undefined, {
            transport: "iroh"
        });
        expect(s.getState().pairedWorkers[0].addrs).toEqual([]);
        await s.getState().connectToWorker("worker-node-id");
        expect(s.getState().activeTransport).toBe("iroh");
    });
    it("reconnects over iroh once a ws drop has lasted the fallback threshold", async ()=>{
        const s = await store();
                let t = 0;
        __setManagedDeps({
            now: ()=>t,
            sleep: (ms)=>{
                t += ms;
                return Promise.resolve();
            }
        });
        await s.getState().pairWithTicket(TICKET_WITH_IROH);
        await s.getState().connectToWorker("worker-node-id");
        expect(s.getState().activeTransport).toBe("ws");
        const wsClient = last();
        let resolveFallback;
        const fallbackReached = new Promise((resolve)=>{
            resolveFallback = resolve;
        });
        const unsubscribe = s.subscribe((state, prev)=>{
            if (state.activeTransport === "iroh" && prev.activeTransport !== "iroh") resolveFallback();
        });
        FakeWorkerClient.failWsConnect = new Error("ws unreachable");
        wsClient.simulateDrop();
        await fallbackReached;
        unsubscribe();
        expect(s.getState().activeTransport).toBe("iroh");
        expect(s.getState().connectionStatus).toBe("connected");
        expect(typeof last().opts.createSocket).toBe("function");
        expect(s.getState().pairedWorkers[0].transport).toBeUndefined();
        __resetManagedConnections();
    });
    it("fetchResultBlob gives a clear error over iroh instead of hitting the ws-only blob path", async ()=>{
        const s = await store();
        await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, {
            transport: "iroh"
        });
        await expect(s.getState().fetchResultBlob({
            sha256: "abc",
            size: 1
        })).rejects.toThrow(/internet \(direct or relay\).*network address/);
        expect(last().fetchBlobCalls).toBe(0);
    });
});

await run();
