/**
 * Port of sleap-app tests/unit/tauriIrohSocket.test.ts @ 683a159 against
 * pose/connect/iroh-socket.js, with a fake `window.lucidDesktop.iroh` shim
 * (connect(target, onEvent) / send / disconnect) instead of fake Tauri IPC.
 */
import { describe, it, expect, run } from './connect-test-utils.mjs';
import { createIrohSocketFactory, encodeIrohDialUrl } from '../pose/connect/iroh-socket.js';

async function flush(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function makeFakeIroh(overrides = {}) {
  const calls = [];
  let onEvent = null;
  let nextConnId = 0;
  const iroh = {
    connect: async (target, cb) => {
      calls.push({ cmd: "connect", args: { target } });
      onEvent = cb;
      if (overrides.onConnect) return overrides.onConnect(target);
      return ++nextConnId; // like the Rust registry: every connect gets its own id
    },
    send: async (connId, msg) => { calls.push({ cmd: "send", args: { connId, msg } }); },
    disconnect: async (connId) => { calls.push({ cmd: "disconnect", args: { connId } }); },
  };
  return { iroh, calls, emit: (payload) => onEvent?.(payload) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("encodeIrohDialUrl", () => {
  it("round-trips through a real connect call", async () => {
    const { iroh, calls } = makeFakeIroh();
    const createSocket = createIrohSocketFactory(async () => iroh);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "abc123", relayUrl: "https://relay.example", directAddrs: ["1.2.3.4:5"] }));
    await flush();
    expect(socket.readyState).toBe(1);
    expect(calls.find((c) => c.cmd === "connect")?.args.target).toEqual({
      nodeId: "abc123", relayUrl: "https://relay.example", directAddrs: ["1.2.3.4:5"],
    });
  });
});

describe("IrohSocket connect", () => {
  it("fires onopen and reaches OPEN once connect resolves", async () => {
    const { iroh } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    let opened = false;
    socket.onopen = () => { opened = true; };
    await flush();
    expect(opened).toBe(true);
    expect(socket.readyState).toBe(1);
  });

  it("does nothing synchronously during construction (handlers attach after it returns)", async () => {
    const { iroh } = makeFakeIroh();
    let errored = false;
    const socket = createIrohSocketFactory(async () => iroh)("not-json");
    socket.onerror = () => { errored = true; };
    expect(errored).toBe(false);
    await flush();
    expect(errored).toBe(true);
  });

  it("fails to connect (onerror + onclose, CLOSED) on invalid dial JSON", async () => {
    const { iroh } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)("not-json");
    let erroredWith; let closed = false;
    socket.onerror = (e) => { erroredWith = e; };
    socket.onclose = () => { closed = true; };
    await flush();
    expect(erroredWith).toBeInstanceOf(Error);
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("fails to connect when the worker's node_id is missing", async () => {
    const { iroh } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(JSON.stringify({}));
    let closed = false;
    socket.onclose = () => { closed = true; };
    await flush();
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("fails to connect when the shim is unavailable", async () => {
    const socket = createIrohSocketFactory(async () => { throw new Error("no shim"); })(encodeIrohDialUrl({ nodeId: "n" }));
    let erroredWith; let closed = false;
    socket.onerror = (e) => { erroredWith = e; };
    socket.onclose = () => { closed = true; };
    await flush();
    expect(erroredWith.message).toContain("no shim");
    expect(closed).toBe(true);
  });

  it("fails to connect (onerror + onclose, CLOSED) when connect rejects", async () => {
    const { iroh } = makeFakeIroh({ onConnect: async () => { throw new Error("iroh connect failed: timed out"); } });
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    let erroredWith; let closed = false;
    socket.onerror = (e) => { erroredWith = e; };
    socket.onclose = () => { closed = true; };
    await flush();
    expect(erroredWith.message).toContain("timed out");
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});

describe("IrohSocket messages", () => {
  it("forwards a message event as { data }", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let received;
    socket.onmessage = (ev) => { received = ev; };
    emit({ kind: "message", data: '{"type":"hello"}' });
    expect(received.data).toBe('{"type":"hello"}');
  });

  it("treats a closed event as a close, once", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let closeCount = 0;
    socket.onclose = () => { closeCount++; };
    emit({ kind: "closed" });
    emit({ kind: "closed" });
    expect(closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("surfaces an error event as an Error via onerror, without closing", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let erroredWith;
    socket.onerror = (e) => { erroredWith = e; };
    emit({ kind: "error", message: "boom" });
    expect(erroredWith.message).toBe("boom");
    expect(socket.readyState).toBe(1);
  });

  it("ignores an event that is not an object or has an unknown kind", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let n = 0;
    socket.onmessage = () => { n++; };
    socket.onerror = () => { n++; };
    emit(null); emit("x"); emit({ kind: "mystery" });
    expect(n).toBe(0);
    expect(socket.readyState).toBe(1);
  });
});

describe("IrohSocket send", () => {
  it("sends the raw message with its connection id once OPEN", async () => {
    const { iroh, calls } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    socket.send('{"type":"req"}');
    await flush();
    const sendCall = calls.find((c) => c.cmd === "send");
    expect(sendCall.args.msg).toBe('{"type":"req"}');
    expect(sendCall.args.connId).toBe(1);
  });

  it("routes each socket's sends and close to its own connection id", async () => {
    const { iroh, calls } = makeFakeIroh();
    const createSocket = createIrohSocketFactory(async () => iroh);
    const a = createSocket(encodeIrohDialUrl({ nodeId: "node-a" }));
    const b = createSocket(encodeIrohDialUrl({ nodeId: "node-b" }));
    await flush();
    expect(a.irohConnectionId).toBe(1);
    expect(b.irohConnectionId).toBe(2);
    b.send("to-b");
    a.send("to-a");
    a.close();
    await flush();
    expect(calls.filter((c) => c.cmd === "send").map((c) => [c.args.connId, c.args.msg])).toEqual([[2, "to-b"], [1, "to-a"]]);
    expect(calls.filter((c) => c.cmd === "disconnect").map((c) => c.args.connId)).toEqual([1]);
    expect(b.readyState).toBe(1);
  });

  it("silently drops a send before OPEN", async () => {
    const { iroh, calls } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    socket.send("too-early"); // deliberately not flushed: still CONNECTING
    expect(calls.some((c) => c.cmd === "send")).toBe(false);
  });

  it("reports a failed send through onerror", async () => {
    const { iroh } = makeFakeIroh();
    iroh.send = async () => { throw new Error("Not connected to a worker over iroh"); };
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let erroredWith;
    socket.onerror = (e) => { erroredWith = e; };
    socket.send("x");
    await flush();
    expect(erroredWith.message).toContain("Not connected");
  });
});

describe("IrohSocket close", () => {
  it("disconnects and reaches CLOSED once", async () => {
    const { iroh, calls } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let closeCount = 0;
    socket.onclose = () => { closeCount++; };
    socket.close();
    await flush();
    socket.close(); // idempotent
    const disconnects = calls.filter((c) => c.cmd === "disconnect");
    expect(disconnects.length).toBe(1);
    expect(disconnects[0].args.connId).toBe(1);
    expect(closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("still reaches CLOSED when disconnect rejects", async () => {
    const { iroh } = makeFakeIroh();
    iroh.disconnect = async () => { throw new Error("gone"); };
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let closed = false;
    socket.onclose = () => { closed = true; };
    socket.close();
    await flush();
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("disconnects the real connection instead of leaking it when closed mid-connect", async () => {
    const gate = deferred();
    const { iroh, calls } = makeFakeIroh({ onConnect: () => gate.promise });
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    let opened = false;
    socket.onopen = () => { opened = true; };
    await flush();
    socket.close(); // before connect ever resolves
    gate.resolve(42); // the Rust-side connection "succeeds" anyway
    await flush();
    expect(opened).toBe(false);
    expect(calls.find((c) => c.cmd === "disconnect")?.args.connId).toBe(42);
    expect(socket.readyState).toBe(3);
  });
});

describe("P8 stress review: behaving like a WebSocket", () => {
  it("holds events that beat iroh_connect's reply and replays them after onopen, in order", async () => {
    const gate = deferred();
    const { iroh, emit } = makeFakeIroh({ onConnect: () => gate.promise });
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    const seen = [];
    socket.onopen = () => seen.push("open");
    socket.onmessage = (ev) => seen.push("msg:" + ev.data);
    socket.onclose = () => seen.push("close");
    await flush();
    emit({ kind: "message", data: "a" });
    emit({ kind: "message", data: "b" });
    emit({ kind: "closed" });
    expect(seen).toEqual([]);
    gate.resolve(5);
    await flush();
    expect(seen).toEqual(["open", "msg:a", "msg:b", "close"]);
    expect(socket.readyState).toBe(3);
  });

  it("delivers nothing after CLOSED (late message, error, closed)", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let events = 0;
    socket.onmessage = () => events++;
    socket.onerror = () => events++;
    socket.onclose = () => events++;
    emit({ kind: "closed" });
    expect(events).toBe(1);
    emit({ kind: "message", data: "late" });
    emit({ kind: "error", message: "late" });
    emit({ kind: "closed" });
    expect(events).toBe(1);
  });

  it("ignores a message whose data is not a string", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    let got = 0;
    socket.onmessage = () => got++;
    emit({ kind: "message", data: 5 });
    emit({ kind: "message", data: null });
    emit({ kind: "message" });
    emit({ kind: "message", data: "" }); // an empty frame is still a string
    expect(got).toBe(1);
  });

  it("close() while CONNECTING ends at once with error then close 1006, and disconnects the late connection silently", async () => {
    const gate = deferred();
    const { iroh, calls } = makeFakeIroh({ onConnect: () => gate.promise });
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    const seen = [];
    socket.onopen = () => seen.push("open");
    socket.onerror = () => seen.push("error");
    socket.onclose = (ev) => seen.push("close:" + ev.code);
    await flush();
    socket.close();
    expect(socket.readyState).toBe(3);
    await flush();
    expect(seen).toEqual(["error", "close:1006"]);
    gate.resolve(9);
    await flush();
    expect(seen).toEqual(["error", "close:1006"]); // no second close, no open
    expect(calls.filter((c) => c.cmd === "disconnect").map((c) => c.args.connId)).toEqual([9]);
  });

  it("close() while CONNECTING, then connect rejecting, reports nothing twice", async () => {
    const gate = deferred();
    const { iroh } = makeFakeIroh({ onConnect: () => gate.promise });
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    let closes = 0;
    socket.onclose = () => closes++;
    await flush();
    socket.close();
    gate.reject(new Error("dial failed"));
    await flush();
    expect(closes).toBe(1);
  });

  it("a closed event after our own close() is not a second close; codes say who closed", async () => {
    const { iroh, emit } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    const closes = [];
    socket.onclose = (ev) => closes.push(ev);
    socket.close();
    emit({ kind: "closed" }); // Rust's own reader reports the end too
    await flush();
    expect(closes.length).toBe(1);
    expect(socket.readyState).toBe(3);

    const other = makeFakeIroh();
    const s2 = createIrohSocketFactory(async () => other.iroh)(encodeIrohDialUrl({ nodeId: "node-2" }));
    await flush();
    let ev2;
    s2.onclose = (ev) => { ev2 = ev; };
    other.emit({ kind: "closed" });
    expect(ev2.code).toBe(1006);
    expect(ev2.wasClean).toBe(false);
  });

  it("send after close and double close are harmless", async () => {
    const { iroh, calls } = makeFakeIroh();
    const socket = createIrohSocketFactory(async () => iroh)(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();
    socket.close();
    await flush();
    socket.close();
    socket.send("late");
    await flush();
    expect(calls.filter((c) => c.cmd === "send").length).toBe(0);
    expect(calls.filter((c) => c.cmd === "disconnect").length).toBe(1);
  });
});

run();
