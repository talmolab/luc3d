//! Port of sleap-app `src-tauri/src/iroh_client.rs` @ 683a159.
//!
//! LUCID changes (everything else is sleap-app's file):
//!  - commands live in the inlined plugin `lucid` (`plugin:lucid|iroh_*`);
//!  - the reader pushes to an [`EventSink`], so the core runs without a Tauri
//!    app (tests, `examples/iroh_real_worker.rs`);
//!  - frames are capped at [`MAX_FRAME_BYTES`] both ways and read in steps that
//!    must each progress within [`STALL_TIMEOUT`] (never sized up front);
//!  - blob reads are capped at [`MAX_BLOB_RANGE`], a reply may not exceed the
//!    request, blob headers have their own small caps, and the body returns as
//!    raw bytes (`tauri::ipc::Response`);
//!  - every write and blob wait is time-bounded; a failed blob read drops its
//!    stream and a failed control write closes the connection (either would
//!    desync the framing);
//!  - connections belong to the webview that dialed them
//!    ([`IrohClients::with_conn`]), ids are never reused, at most
//!    [`MAX_CONNS_PER_OWNER`] per webview, a dial outliving its webview is
//!    closed ([`DialTicket`]), and the endpoint accepts no worker streams.
//!
//! A dial-only byte pipe: one bidirectional QUIC stream to a worker carrying
//! protocol-v1 envelope JSON, framed exactly as the worker's
//! `IrohStreamTransport` (4-byte big-endian length, then UTF-8 JSON) under the
//! same ALPN. All hello/auth/job logic stays in JS. Each dial uses a fresh
//! ephemeral iroh identity (protocol v1 authenticates on its own) and iroh's
//! `N0` preset (n0's relays and discovery), as the worker does.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::{
    endpoint::{presets, Connection, QuicTransportConfig, RecvStream, SendStream},
    Endpoint, EndpointAddr, PublicKey, RelayUrl,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// Must match the worker's `sleap_rtc/protocol_v1/iroh_transport.py::ALPN`
/// byte-for-byte.
const ALPN: &[u8] = b"sleap-connect/protocol-v1";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Largest frame either side accepts or sends (a LUCID hardening; the
/// WebSocket path has no cap of its own), so a worker cannot make this process
/// allocate whatever length its 4-byte prefix claims.
pub const MAX_FRAME_BYTES: usize = 256 * 1024 * 1024;

/// A frame's payload is read in steps of this size, each of which must make
/// progress within [`STALL_TIMEOUT`]; the buffer grows only as bytes arrive.
const READ_STEP: usize = 256 * 1024;

/// A frame (or blob body) whose next bytes do not arrive within this long is
/// abandoned: a worker may be silent between frames, never in the middle of one.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest a control-stream write may take (a worker that stops reading).
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest a blob open or one blob read (header + body) may take in all.
pub const BLOB_IO_TIMEOUT: Duration = Duration::from_secs(120);

/// A blob-open reply carries one sha256 per chunk (64 hex characters each), so
/// it is far larger than a read reply but nowhere near a whole frame.
pub const MAX_BLOB_OPEN_HEADER: usize = 16 * 1024 * 1024;

/// A blob-read reply header is `{"ok":true,"size":N}`.
pub const MAX_BLOB_READ_HEADER: usize = 64 * 1024;

/// Connections (and dials in flight) one webview may hold at once.
pub const MAX_CONNS_PER_OWNER: usize = 16;

/// Direct addresses accepted in one dial target.
pub const MAX_DIRECT_ADDRS: usize = 32;

/// Largest single blob range read (`iroh_blob_read_range`). The JS caller
/// splits a chunk-aligned window into reads of at most this size.
pub const MAX_BLOB_RANGE: u64 = 4 * 1024 * 1024;

/// Everything needed to dial a worker over iroh. `node_id` is the worker's
/// base64url (no padding) Ed25519 key, which is also its iroh `EndpointId`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrohDialTarget {
    pub node_id: String,
    pub relay_url: Option<String>,
    pub direct_addrs: Option<Vec<String>>,
}

/// Pushed to the frontend over the `on_message` IPC channel: what a
/// `WebSocket`'s `onmessage`/`onclose`/`onerror` distinguish.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IrohClientEvent {
    Message { data: String },
    Closed,
    Error { message: String },
}

/// Identifies one open connection. `iroh_connect` returns it, and every
/// later command for that connection names it — so connections from
/// different windows (each its own JS heap with its own `WorkerClient`s), or
/// to different workers from one window, never share a stream.
pub type ConnId = u32;

/// Where the reader task pushes events. Returns `false` once nobody listens
/// any more (the page is gone), which ends the reader. The command wraps its
/// `tauri::ipc::Channel` in one; tests and the example use a plain closure.
pub type EventSink = Arc<dyn Fn(IrohClientEvent) -> bool + Send + Sync>;

/// One worker connection: the endpoint it was dialed from, the control
/// stream's send half, and its blob stream slot. The send half and blob slot
/// each sit behind their own lock, so a slow write or blob read on one
/// connection never stalls another, and a blob read never stalls `iroh_send`
/// on its own connection.
struct IrohConn {
    /// Label of the webview that opened it — closed when that webview
    /// reloads or its window is destroyed ([`IrohClients::close_owned_by`]).
    owner: String,
    endpoint: Endpoint,
    connection: Connection,
    send: Arc<Mutex<SendStream>>,
    blob: Arc<Mutex<IrohBlobState>>,
}

impl IrohConn {
    async fn close(self) {
        self.connection.close(0u32.into(), b"client disconnect");
        self.endpoint.close().await;
    }
}

#[derive(Default)]
struct Registry {
    next_id: ConnId,
    conns: HashMap<ConnId, IrohConn>,
    /// Bumped when an owner's webview goes away, so a dial that started before
    /// (and finishes after) cannot register a connection nobody will close.
    epochs: HashMap<String, u64>,
    /// Dials in flight per owner (they count against [`MAX_CONNS_PER_OWNER`]).
    pending: HashMap<String, usize>,
}

/// Held by one dial from [`IrohClients::begin`] to [`IrohClients::add`] /
/// [`IrohClients::cancel`].
#[derive(Debug)]
pub struct DialTicket {
    owner: String,
    epoch: u64,
}

/// Every open iroh connection in the app, keyed by [`ConnId`]. Tauri-managed
/// and shared by all windows; cheap to clone (the reader task holds a clone
/// so it can drop its own connection when the stream ends).
#[derive(Clone, Default)]
pub struct IrohClients(Arc<Mutex<Registry>>);

impl IrohClients {
    /// Reserves a connection slot for `owner` before it dials: refused at
    /// [`MAX_CONNS_PER_OWNER`] (open plus in flight), so a page cannot bind
    /// endpoints without limit.
    pub async fn begin(&self, owner: &str) -> Result<DialTicket, String> {
        let mut r = self.0.lock().await;
        let open = r.conns.values().filter(|c| c.owner == owner).count();
        let pending = r.pending.get(owner).copied().unwrap_or(0);
        if open + pending >= MAX_CONNS_PER_OWNER {
            return Err(format!(
                "Too many iroh connections open ({MAX_CONNS_PER_OWNER} per window)"
            ));
        }
        *r.pending.entry(owner.to_string()).or_insert(0) += 1;
        let epoch = r.epochs.get(owner).copied().unwrap_or(0);
        Ok(DialTicket {
            owner: owner.to_string(),
            epoch,
        })
    }

    fn release_pending(r: &mut Registry, owner: &str) {
        if let Some(n) = r.pending.get_mut(owner) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                r.pending.remove(owner);
            }
        }
    }

    /// A dial that failed: gives its slot back.
    pub async fn cancel(&self, ticket: DialTicket) {
        let mut r = self.0.lock().await;
        Self::release_pending(&mut r, &ticket.owner);
    }

    /// Registers a dialed connection. Fails (closing it) when the owner's
    /// webview went away while the dial ran. Ids are never `0` and never in use.
    pub async fn add(
        &self,
        ticket: DialTicket,
        endpoint: Endpoint,
        connection: Connection,
        send: SendStream,
    ) -> Result<ConnId, String> {
        let conn = IrohConn {
            owner: ticket.owner.clone(),
            endpoint,
            connection,
            send: Arc::new(Mutex::new(send)),
            blob: Arc::new(Mutex::new(IrohBlobState::default())),
        };
        let mut r = self.0.lock().await;
        Self::release_pending(&mut r, &ticket.owner);
        if r.epochs.get(&ticket.owner).copied().unwrap_or(0) != ticket.epoch {
            drop(r);
            conn.close().await;
            return Err("The window that asked for this connection is gone".to_string());
        }
        let id = loop {
            r.next_id = r.next_id.wrapping_add(1);
            if r.next_id != 0 && !r.conns.contains_key(&r.next_id) {
                break r.next_id;
            }
        };
        r.conns.insert(id, conn);
        Ok(id)
    }

    /// Clones what `f` picks out of connection `id` while holding the
    /// registry lock only that long. A connection belongs to the webview
    /// `owner` that dialed it: another webview naming its id gets the same
    /// answer as for an id that does not exist.
    async fn with_conn<T>(
        &self,
        owner: &str,
        id: ConnId,
        f: impl FnOnce(&IrohConn) -> T,
    ) -> Result<T, String> {
        let r = self.0.lock().await;
        r.conns
            .get(&id)
            .filter(|c| c.owner == owner)
            .map(f)
            .ok_or_else(|| "Not connected to a worker over iroh".to_string())
    }

    pub async fn send(&self, owner: &str, id: ConnId, msg: &str) -> Result<(), String> {
        // Refused before anything is written, so the stream stays in sync.
        encode_frame_header(msg.len())?;
        let send = self.with_conn(owner, id, |c| c.send.clone()).await?;
        let result = {
            let mut send = send.lock().await;
            write_frame_with(&mut send, msg, WRITE_TIMEOUT).await
        };
        if result.is_err() {
            // A frame that was only partly written cannot be followed by another.
            self.close(id).await;
        }
        result
    }

    /// Removes and closes connection `id`. A no-op if it's already gone.
    /// (The reader task's own connection; commands go through [`close_as`].)
    pub async fn close(&self, id: ConnId) {
        self.close_if(id, |_| true).await;
    }

    /// [`close`] for a command: only when `owner` opened it.
    pub async fn close_as(&self, owner: &str, id: ConnId) {
        self.close_if(id, |c| c.owner == owner).await;
    }

    async fn close_if(&self, id: ConnId, pred: impl FnOnce(&IrohConn) -> bool) {
        let conn = {
            let mut r = self.0.lock().await;
            match r.conns.get(&id).is_some_and(pred) {
                true => r.conns.remove(&id),
                false => None,
            }
        };
        if let Some(conn) = conn {
            conn.close().await;
        }
    }

    /// Closes every connection opened by webview `owner` — its JS side is
    /// gone (reload or window closed), so nothing will ever disconnect them —
    /// and refuses any of its dials still in flight.
    pub async fn close_owned_by(&self, owner: &str) {
        let owned: Vec<IrohConn> = {
            let mut r = self.0.lock().await;
            *r.epochs.entry(owner.to_string()).or_insert(0) += 1;
            let ids: Vec<ConnId> = r
                .conns
                .iter()
                .filter(|(_, c)| c.owner == owner)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| r.conns.remove(id)).collect()
        };
        for conn in owned {
            conn.close().await;
        }
    }
}

/// One connection's blob stream, behind its own lock so a slow blob read never
/// blocks `iroh_send`/`iroh_disconnect`. One slot per connection: a second
/// `iroh_blob_open` replaces (drops) the stream open before.
#[derive(Debug, Default)]
pub struct IrohBlobState {
    #[allow(dead_code)] // kept for debugging/future multi-slot support, not read today
    sha256: Option<String>,
    send: Option<SendStream>,
    recv: Option<RecvStream>,
}

pub fn decode_node_id(node_id: &str) -> Result<PublicKey, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(node_id)
        .map_err(|e| format!("Invalid node_id (not base64url): {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| format!("node_id must decode to 32 bytes, got {}", v.len()))?;
    PublicKey::from_bytes(&arr).map_err(|e| format!("Invalid node_id (not an Ed25519 key): {e}"))
}

pub fn build_endpoint_addr(target: &IrohDialTarget) -> Result<EndpointAddr, String> {
    let id = decode_node_id(&target.node_id)?;
    let mut addr = EndpointAddr::new(id);
    if target.direct_addrs.as_ref().is_some_and(|a| a.len() > MAX_DIRECT_ADDRS) {
        return Err(format!("More than {MAX_DIRECT_ADDRS} direct addresses"));
    }
    if let Some(relay) = &target.relay_url {
        let relay_url: RelayUrl = relay
            .parse()
            .map_err(|e| format!("Invalid relay_url '{relay}': {e}"))?;
        addr = addr.with_relay_url(relay_url);
    }
    for a in target.direct_addrs.iter().flatten() {
        let sock: SocketAddr = a
            .parse()
            .map_err(|e| format!("Invalid direct address '{a}': {e}"))?;
        addr = addr.with_ip_addr(sock);
    }
    Ok(addr)
}

// ── Connect Command ──────────────────────────────────────────────

/// Binds a fresh endpoint under `preset` and dials `endpoint_addr`, opening
/// one bidirectional stream. Tests dial with `presets::Minimal` (no relay or
/// DNS); the command uses `presets::N0`.
pub async fn dial(
    endpoint_addr: EndpointAddr,
    preset: impl iroh::endpoint::presets::Preset,
) -> Result<(Endpoint, Connection, SendStream, RecvStream), String> {
    // This side only ever opens streams: accept none from the worker (each
    // would otherwise hold receive-window memory nobody ever reads).
    let transport = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(0u32.into())
        .max_concurrent_uni_streams(0u32.into())
        .build();
    let endpoint = Endpoint::builder(preset)
        .transport_config(transport)
        .bind()
        .await
        .map_err(|e| format!("Failed to bind iroh endpoint: {e}"))?;

    let opened = async {
        let connect = async {
            (endpoint.connect(endpoint_addr, ALPN).await)
                .map_err(|e| format!("iroh connect failed: {e}"))
        };
        let connection = bounded(CONNECT_TIMEOUT, connect, "iroh connect timed out (20s)").await?;
        let open = async {
            (connection.open_bi().await).map_err(|e| format!("Failed to open iroh stream: {e}"))
        };
        let (send, recv) =
            bounded(CONNECT_TIMEOUT, open, "Opening the iroh stream timed out (20s)").await?;
        Ok((connection, send, recv))
    }
    .await;
    match opened {
        Ok((connection, send, recv)) => Ok((endpoint, connection, send, recv)),
        Err(e) => {
            endpoint.close().await;
            Err(e)
        }
    }
}

/// `fut`'s result, or `Err(msg)` when it takes longer than `limit`.
async fn bounded<T>(
    limit: Duration,
    fut: impl std::future::Future<Output = Result<T, String>>,
    msg: &str,
) -> Result<T, String> {
    timeout(limit, fut).await.unwrap_or_else(|_| Err(msg.to_string()))
}

/// Dials a worker and returns the new connection's [`ConnId`], which the
/// caller passes to every later command for it. Each call is its own
/// connection — it never replaces another window's (or another worker's).
#[tauri::command]
pub async fn iroh_connect<R: tauri::Runtime>(
    target: IrohDialTarget,
    on_message: tauri::ipc::Channel<IrohClientEvent>,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<ConnId, String> {
    let endpoint_addr = build_endpoint_addr(&target)?;
    let ticket = clients.begin(webview.label()).await?;
    let (endpoint, connection, send, recv) = match dial(endpoint_addr, presets::N0).await {
        Ok(parts) => parts,
        Err(e) => {
            clients.cancel(ticket).await;
            return Err(e);
        }
    };

    // Registered before the reader starts, so a stream that ends at once
    // still finds (and drops) its own entry.
    let id = clients.add(ticket, endpoint, connection, send).await?;
    let sink: EventSink = Arc::new(move |event| on_message.send(event).is_ok());
    spawn_reader(recv, sink, clients.inner().clone(), id);
    Ok(id)
}

/// The 4-byte big-endian length prefix for a `len`-byte frame, or an error when
/// the frame is over [`MAX_FRAME_BYTES`].
pub fn encode_frame_header(len: usize) -> Result<[u8; 4], String> {
    if len > MAX_FRAME_BYTES {
        return Err(format!(
            "frame of {len} bytes is over the {MAX_FRAME_BYTES}-byte limit"
        ));
    }
    Ok((len as u32).to_be_bytes())
}

/// The payload length a frame header announces, refused when it is over
/// [`MAX_FRAME_BYTES`] (checked BEFORE anything is allocated for it).
pub fn decode_frame_len(header: [u8; 4]) -> Result<usize, String> {
    decode_frame_len_max(header, MAX_FRAME_BYTES)
}

/// [`decode_frame_len`] with a caller's own cap (blob headers are small).
pub fn decode_frame_len_max(header: [u8; 4], max: usize) -> Result<usize, String> {
    let len = u32::from_be_bytes(header) as usize;
    if len > max {
        return Err(format!(
            "worker announced a frame of {len} bytes, over the {max}-byte limit"
        ));
    }
    Ok(len)
}

/// Writes one length-prefixed frame: a 4-byte big-endian length, then that
/// many UTF-8 bytes (the worker's `IrohStreamTransport` framing).
pub async fn write_frame(send: &mut SendStream, text: &str) -> Result<(), String> {
    write_frame_with(send, text, WRITE_TIMEOUT).await
}

/// [`write_frame`] that gives up after `limit` (a worker that stopped reading).
pub async fn write_frame_with(
    send: &mut SendStream,
    text: &str,
    limit: Duration,
) -> Result<(), String> {
    let payload = text.as_bytes();
    let header = encode_frame_header(payload.len())?;
    let write = async {
        send.write_all(&header)
            .await
            .map_err(|e| format!("iroh send (length prefix) failed: {e}"))?;
        send.write_all(payload)
            .await
            .map_err(|e| format!("iroh send failed: {e}"))
    };
    bounded(limit, write, "iroh send timed out: the worker is not reading").await
}

/// Reads one length-prefixed frame (the read-side counterpart of
/// [`write_frame`]). `Ok(None)` means the stream ended, cleanly or not (iroh
/// does not reliably tell them apart). A header over the size cap is an `Err`
/// (and the stream is not read further).
pub async fn read_frame(recv: &mut RecvStream) -> Result<Option<String>, String> {
    read_frame_with(recv, MAX_FRAME_BYTES, STALL_TIMEOUT).await
}

/// [`read_frame`] with its own size cap and stall limit. Waiting for a frame
/// to START is unbounded (an idle worker is fine); once the header is in, the
/// payload is read in [`READ_STEP`] pieces that must each arrive within
/// `stall`, and the buffer grows only with the bytes received — an announced
/// length is never allocated up front.
pub async fn read_frame_with(
    recv: &mut RecvStream,
    max: usize,
    stall: Duration,
) -> Result<Option<String>, String> {
    let mut header = [0u8; 4];
    if recv.read_exact(&mut header).await.is_err() {
        return Ok(None);
    }
    let len = decode_frame_len_max(header, max)?;
    let mut payload: Vec<u8> = Vec::with_capacity(len.min(READ_STEP));
    while payload.len() < len {
        let start = payload.len();
        let want = (len - start).min(READ_STEP);
        payload.resize(start + want, 0);
        match timeout(stall, recv.read(&mut payload[start..])).await {
            Ok(Ok(Some(n))) => payload.truncate(start + n),
            Ok(Ok(None)) | Ok(Err(_)) => return Ok(None),
            Err(_) => {
                return Err(format!(
                    "worker stalled mid-frame ({start} of {len} bytes received)"
                ))
            }
        }
    }
    String::from_utf8(payload)
        .map(Some)
        .map_err(|e| format!("Received non-UTF-8 frame: {e}"))
}

/// Forwards frames to the frontend until the stream ends (or the frontend
/// stops listening), then drops connection `id` so a worker-side close
/// doesn't leave its endpoint open.
pub fn spawn_reader(mut recv: RecvStream, sink: EventSink, clients: IrohClients, id: ConnId) {
    tokio::spawn(async move {
        loop {
            match read_frame(&mut recv).await {
                Ok(Some(text)) => {
                    if !sink(IrohClientEvent::Message { data: text }) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(message) => {
                    let _ = sink(IrohClientEvent::Error { message });
                    break;
                }
            }
        }
        clients.close(id).await;
        let _ = sink(IrohClientEvent::Closed);
    });
}

// ── Send Command ─────────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_send<R: tauri::Runtime>(
    conn_id: ConnId,
    msg: String,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    clients.send(webview.label(), conn_id, &msg).await
}

// ── Disconnect Command ────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_disconnect<R: tauri::Runtime>(
    conn_id: ConnId,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    clients.close_as(webview.label(), conn_id).await;
    Ok(())
}

// ── Blob Commands ───────────────────────────────────────────────────
//
// A blob (a job-result file) is fetched by range on its own stream. Still a
// byte pipe: chunk alignment and hash checks belong to the JS caller.

/// Every `{ok, ...}` / `{ok:false, error}` JSON header the worker sends on the
/// blob stream (open reply and each read reply); absent fields are `None`.
#[derive(Deserialize)]
struct BlobHeader {
    ok: bool,
    size: Option<u64>,
    error: Option<String>,
    #[serde(rename = "chunkSize")]
    chunk_size: Option<u64>,
    #[serde(rename = "chunkHashes")]
    chunk_hashes: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct IrohBlobOpenResult {
    pub size: u64,
    #[serde(rename = "chunkSize")]
    pub chunk_size: u64,
    #[serde(rename = "chunkHashes")]
    pub chunk_hashes: Vec<String>,
}

/// A blob id is a lowercase-hex sha256, 64 characters. Refused here so a page
/// cannot send the worker anything else down the blob stream.
pub fn valid_blob_sha256(sha256: &str) -> bool {
    sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Core of `iroh_blob_open`, without `tauri::State` (testable).
pub async fn open_blob_stream(
    connection: Connection,
    sha256: String,
) -> Result<(IrohBlobOpenResult, IrohBlobState), String> {
    open_blob_stream_with(connection, sha256, BLOB_IO_TIMEOUT).await
}

/// [`open_blob_stream`] with its own overall time limit.
pub async fn open_blob_stream_with(
    connection: Connection,
    sha256: String,
    limit: Duration,
) -> Result<(IrohBlobOpenResult, IrohBlobState), String> {
    let open = open_blob_stream_inner(connection, sha256, limit);
    bounded(limit, open, "Opening the blob stream timed out").await
}

async fn open_blob_stream_inner(
    connection: Connection,
    sha256: String,
    limit: Duration,
) -> Result<(IrohBlobOpenResult, IrohBlobState), String> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| format!("Failed to open blob stream: {e}"))?;

    write_frame_with(
        &mut send,
        &serde_json::json!({ "sha256": sha256 }).to_string(),
        limit,
    )
    .await?;
    let header_text = read_frame_with(&mut recv, MAX_BLOB_OPEN_HEADER, STALL_TIMEOUT)
        .await?
        .ok_or("Worker closed the blob stream before replying")?;
    let header: BlobHeader = serde_json::from_str(&header_text)
        .map_err(|e| format!("Malformed blob response header: {e}"))?;
    if !header.ok {
        return Err(header.error.unwrap_or_else(|| "blob open failed".into()));
    }
    let size = header.size.ok_or("Response missing size")?;
    let chunk_size = header.chunk_size.ok_or("Response missing chunkSize")?;
    let chunk_hashes = header.chunk_hashes.ok_or("Response missing chunkHashes")?;
    if chunk_size == 0 {
        return Err("Response has a chunkSize of 0".to_string());
    }

    let result = IrohBlobOpenResult {
        size,
        chunk_size,
        chunk_hashes,
    };
    let state = IrohBlobState {
        sha256: Some(sha256),
        send: Some(send),
        recv: Some(recv),
    };
    Ok((result, state))
}

/// Opens a fresh stream on connection `conn_id` for reading one blob,
/// replacing whatever blob stream that connection had open.
#[tauri::command]
pub async fn iroh_blob_open<R: tauri::Runtime>(
    conn_id: ConnId,
    sha256: String,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<IrohBlobOpenResult, String> {
    if !valid_blob_sha256(&sha256) {
        return Err("A blob id is a 64-character lowercase hex sha256".to_string());
    }
    // Only clone the handles under the registry lock: the round trip below
    // must not stall every other connection's iroh_send.
    let (connection, blob) = clients
        .with_conn(webview.label(), conn_id, |c| {
            (c.connection.clone(), c.blob.clone())
        })
        .await?;
    let (result, state) = open_blob_stream(connection, sha256).await?;
    *blob.lock().await = state;
    Ok(result)
}

/// Core of `iroh_blob_read_range`, without `tauri::State` (testable).
pub async fn read_blob_range(
    state: &mut IrohBlobState,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    read_blob_range_with(state, offset, length, BLOB_IO_TIMEOUT, STALL_TIMEOUT).await
}

/// [`read_blob_range`] with its own time limits: `limit` for the whole read,
/// `stall` for each piece of the reply. ANY failure (including a timeout)
/// drops the stream: its reply may be half-read, and the next read would take
/// body bytes for a header.
pub async fn read_blob_range_with(
    state: &mut IrohBlobState,
    offset: u64,
    length: u64,
    limit: Duration,
    stall: Duration,
) -> Result<Vec<u8>, String> {
    if length > MAX_BLOB_RANGE {
        return Err(format!(
            "blob read of {length} bytes is over the {MAX_BLOB_RANGE}-byte limit"
        ));
    }
    if offset.checked_add(length).is_none() {
        return Err("blob read range overflows".to_string());
    }
    let read = read_blob_range_inner(state, offset, length, stall);
    let result = bounded(limit, read, "blob read timed out").await;
    if result.is_err() && state.recv.is_some() {
        *state = IrohBlobState::default();
    }
    result
}

async fn read_blob_range_inner(
    state: &mut IrohBlobState,
    offset: u64,
    length: u64,
    stall: Duration,
) -> Result<Vec<u8>, String> {
    // Destructured at once: two `.as_mut()` calls would borrow `state` twice.
    let IrohBlobState { send, recv, .. } = state;
    let send = send
        .as_mut()
        .ok_or("No blob stream open — call iroh_blob_open first")?;
    let recv = recv.as_mut().ok_or("No blob stream open — call iroh_blob_open first")?;

    write_frame_with(
        send,
        &serde_json::json!({ "offset": offset, "length": length }).to_string(),
        stall,
    )
    .await?;
    let header_text = read_frame_with(recv, MAX_BLOB_READ_HEADER, stall)
        .await?
        .ok_or("Worker closed the blob stream mid-read")?;
    let header: BlobHeader = serde_json::from_str(&header_text)
        .map_err(|e| format!("Malformed blob response header: {e}"))?;
    if !header.ok {
        return Err(header.error.unwrap_or_else(|| "blob read failed".into()));
    }
    let size = header.size.ok_or("Response missing size")?;
    // A worker may return fewer bytes than asked (end of file), never more.
    if size > length {
        return Err(format!(
            "Worker answered a {length}-byte read with {size} bytes"
        ));
    }
    // `size <= length <= MAX_BLOB_RANGE` (4 MiB), so this fits any usize.
    let size = usize::try_from(size).map_err(|_| "blob reply too large".to_string())?;
    let mut buf = vec![0u8; size];
    let mut got = 0;
    while got < size {
        match timeout(stall, recv.read(&mut buf[got..])).await {
            Ok(Ok(Some(n))) => got += n,
            Ok(Ok(None)) => return Err("Worker closed the blob stream mid-body".to_string()),
            Ok(Err(e)) => return Err(format!("Failed to read blob body: {e}")),
            Err(_) => return Err(format!("worker stalled mid-body ({got} of {size} bytes)")),
        }
    }
    Ok(buf)
}

/// Reads `[offset, offset + length)` off the open blob stream (opened by
/// [`iroh_blob_open`]), forwarding the range verbatim.
#[tauri::command]
pub async fn iroh_blob_read_range<R: tauri::Runtime>(
    conn_id: ConnId,
    offset: u64,
    length: u64,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<tauri::ipc::Response, String> {
    let blob = clients
        .with_conn(webview.label(), conn_id, |c| c.blob.clone())
        .await?;
    let mut b = blob.lock().await;
    read_blob_range(&mut b, offset, length)
        .await
        .map(tauri::ipc::Response::new)
}

/// Ends connection `conn_id`'s open blob stream, if any. A no-op (not an
/// error) if nothing was open or the connection is already gone.
#[tauri::command]
pub async fn iroh_blob_close<R: tauri::Runtime>(
    conn_id: ConnId,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    let Ok(blob) = clients
        .with_conn(webview.label(), conn_id, |c| c.blob.clone())
        .await
    else {
        return Ok(());
    };
    let old = std::mem::take(&mut *blob.lock().await);
    if let Some(mut send) = old.send {
        let _ = send.finish();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Real iroh endpoints and QUIC streams with `presets::Minimal` (no relay,
    //! direct addresses only) on both sides: no external network.
    use super::*;
    use iroh::endpoint::presets::Minimal;
    use tokio::time::sleep;

    async fn add_conn(
        clients: &IrohClients,
        owner: &str,
        ep: Endpoint,
        conn: Connection,
        send: SendStream,
    ) -> ConnId {
        let ticket = clients.begin(owner).await.expect("begin");
        clients.add(ticket, ep, conn, send).await.expect("add")
    }

    /// Polls until `endpoint.addr()` reports a direct address. Stands in
    /// for `online()`, which hangs forever with the relay disabled (it
    /// specifically waits for a usable relay, which `Minimal` has none of).
    async fn wait_for_direct_address(endpoint: &Endpoint) -> EndpointAddr {
        loop {
            let addr = endpoint.addr();
            if addr.ip_addrs().next().is_some() {
                return addr;
            }
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// A worker endpoint (protocol-v1 ALPN) that hands its one accepted
    /// connection to `script`, then stays up for `linger` and closes.
    async fn spawn_worker<F, Fut>(linger: Duration, script: F) -> EndpointAddr
    where
        F: FnOnce(Connection) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let endpoint = Endpoint::builder(Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("worker endpoint bind");
        let addr = timeout(Duration::from_secs(5), wait_for_direct_address(&endpoint))
            .await
            .expect("worker never reported a direct address");
        tokio::spawn(async move {
            let incoming = endpoint.accept().await.expect("incoming");
            let conn = incoming.accept().expect("accept").await.expect("handshake");
            script(conn.clone()).await;
            sleep(linger).await; // `conn` stays open until here
            drop(conn);
            endpoint.close().await;
        });
        addr
    }

    /// A fake worker that reads one frame and echoes it back prefixed with
    /// `"echo:"`, then closes after 500 ms.
    async fn spawn_fake_worker() -> EndpointAddr {
        spawn_worker(Duration::from_millis(500), |conn| async move {
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let text = read_frame(&mut recv)
                .await
                .expect("read_frame")
                .expect("stream closed before a frame arrived");
            write_frame(&mut send, &format!("echo:{text}")).await.expect("write_frame");
        })
        .await
    }

    #[tokio::test]
    async fn dials_a_real_worker_and_exchanges_one_framed_message() {
        let worker_addr = spawn_fake_worker().await;

        let (client_endpoint, _connection, mut send, mut recv) =
            dial(worker_addr, Minimal).await.expect("dial");

        write_frame(&mut send, "hello").await.expect("write_frame");
        let reply = read_frame(&mut recv)
            .await
            .expect("read_frame")
            .expect("worker closed without replying");

        assert_eq!(reply, "echo:hello");
        client_endpoint.close().await;
    }

    /// Two windows (owners) each hold a connection to their own worker: each
    /// connection's sends reach only its own worker, and closing one owner's
    /// connections leaves the other's open — the bug this registry fixes was
    /// a second `iroh_connect` closing the first window's connection.
    #[tokio::test]
    async fn connections_from_two_owners_stay_independent() {
        let clients = IrohClients::default();
        let (ep_a, conn_a, send_a, mut recv_a) =
            dial(spawn_fake_worker().await, Minimal).await.expect("dial a");
        let (ep_b, conn_b, send_b, mut recv_b) =
            dial(spawn_fake_worker().await, Minimal).await.expect("dial b");
        let id_a = add_conn(&clients, "main", ep_a, conn_a, send_a).await;
        let id_b = add_conn(&clients, "window-2", ep_b, conn_b, send_b).await;
        assert_ne!(id_a, id_b);

        clients.send("window-2", id_b, "from-b").await.expect("send b");
        clients.send("main", id_a, "from-a").await.expect("send a");
        assert_eq!(read_frame(&mut recv_a).await.unwrap().unwrap(), "echo:from-a");
        assert_eq!(read_frame(&mut recv_b).await.unwrap().unwrap(), "echo:from-b");

        clients.close_owned_by("main").await;
        assert!(clients.send("main", id_a, "x").await.is_err(), "main's connection should be gone");
        assert!(clients.with_conn("window-2", id_b, |_| ()).await.is_ok(), "window-2's connection should remain");

        clients.close(id_b).await;
        assert!(clients.with_conn("window-2", id_b, |_| ()).await.is_err());
    }

    #[tokio::test]
    async fn decode_node_id_round_trips_a_real_endpoint_id() {
        let endpoint = Endpoint::builder(Minimal)
            .bind()
            .await
            .expect("endpoint bind");
        let id = endpoint.id();
        let encoded = URL_SAFE_NO_PAD.encode(id.as_bytes());

        let decoded = decode_node_id(&encoded).expect("decode_node_id");

        assert_eq!(decoded, id);
        endpoint.close().await;
    }

    #[test]
    fn decode_node_id_rejects_the_wrong_byte_length() {
        let short = URL_SAFE_NO_PAD.encode([0u8; 16]);
        let err = decode_node_id(&short).unwrap_err();
        assert!(err.contains("32 bytes"), "unexpected error: {err}");
    }

    #[test]
    fn build_endpoint_addr_parses_relay_and_direct_addrs() {
        // An arbitrary 32-byte pattern isn't necessarily a valid point on
        // the curve `PublicKey` wraps — generate a real key instead.
        let node_id = URL_SAFE_NO_PAD.encode(iroh::SecretKey::generate().public().as_bytes());
        let target = IrohDialTarget {
            node_id,
            relay_url: Some("https://relay.example.com".to_string()),
            direct_addrs: Some(vec!["127.0.0.1:4000".to_string()]),
        };

        let addr = build_endpoint_addr(&target).expect("build_endpoint_addr");

        assert_eq!(addr.ip_addrs().count(), 1);
        assert_eq!(addr.relay_urls().count(), 1);
    }

    // ── Blob commands ────────────────────────────────────────────────
    //
    // A fake worker serving each incoming stream as one blob session (open
    // frame, then read frames until the client finishes) over known bytes.

    const TEST_CHUNK_SIZE: u64 = 4; // tiny on purpose, to exercise multiple chunks

    // A chunk-unique stand-in for sha256s: this module only passes
    // `chunkHashes` through (the JS side verifies them).
    fn test_chunk_hashes(bytes: &[u8]) -> Vec<String> {
        bytes
            .chunks(TEST_CHUNK_SIZE as usize)
            .map(|c| c.iter().map(|b| format!("{b:02x}")).collect())
            .collect()
    }

    async fn spawn_fake_blob_worker(bytes: &'static [u8]) -> EndpointAddr {
        spawn_worker(Duration::from_millis(500), move |conn| async move {
            loop {
                let (mut send, mut recv) = match conn.accept_bi().await {
                    Ok(streams) => streams,
                    Err(_) => break, // connection closed
                };
                let bytes = bytes;
                tokio::spawn(async move {
                    let open_req = match read_frame(&mut recv).await {
                        Ok(Some(t)) => t,
                        _ => return,
                    };
                    let sha256 = serde_json::from_str::<serde_json::Value>(&open_req)
                        .ok()
                        .and_then(|v| v.get("sha256").and_then(|s| s.as_str().map(String::from)))
                        .unwrap_or_default();
                    if sha256 != "knownblob" {
                        let _ = write_frame(
                            &mut send,
                            &serde_json::json!({"ok": false, "error": "not_found"}).to_string(),
                        )
                        .await;
                        let _ = send.finish();
                        return;
                    }
                    let _ = write_frame(
                        &mut send,
                        &serde_json::json!({
                            "ok": true,
                            "size": bytes.len(),
                            "chunkSize": TEST_CHUNK_SIZE,
                            "chunkHashes": test_chunk_hashes(bytes),
                        })
                        .to_string(),
                    )
                    .await;

                    loop {
                        let req = match read_frame(&mut recv).await {
                            Ok(Some(t)) => t,
                            _ => break, // client finished its send side
                        };
                        let r: serde_json::Value = serde_json::from_str(&req).expect("valid request json");
                        let offset = r["offset"].as_u64().unwrap() as usize;
                        let length = r["length"].as_u64().unwrap() as usize;
                        let end = (offset + length).min(bytes.len());
                        let slice = &bytes[offset..end];
                        let _ = write_frame(
                            &mut send,
                            &serde_json::json!({"ok": true, "size": slice.len()}).to_string(),
                        )
                        .await;
                        let _ = send.write_all(slice).await;
                    }
                    let _ = send.finish();
                });
            }
        })
        .await
    }

    const TEST_BLOB_BYTES: &[u8] = b"0123456789abcdefghij"; // 20 bytes = 5 chunks of 4

    #[tokio::test]
    async fn iroh_blob_open_and_multiple_range_reads_on_the_same_stream() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let (opened, mut state) = open_blob_stream(connection, "knownblob".to_string())
            .await
            .expect("open_blob_stream");
        assert_eq!(opened.size, TEST_BLOB_BYTES.len() as u64);
        assert_eq!(opened.chunk_size, TEST_CHUNK_SIZE);
        assert_eq!(opened.chunk_hashes, test_chunk_hashes(TEST_BLOB_BYTES));

        // First read: entirely inside chunk 0.
        let a = read_blob_range(&mut state, 0, 4).await.expect("read a");
        assert_eq!(a, TEST_BLOB_BYTES[0..4]);

        // Second read on the SAME stream/state, starting mid-file, spanning
        // a chunk boundary — proves session reuse, not just one request.
        let b = read_blob_range(&mut state, 6, 8).await.expect("read b");
        assert_eq!(b, TEST_BLOB_BYTES[6..14]);

        // Third read reaching past EOF — clamped, not an error.
        let c = read_blob_range(&mut state, 18, 10).await.expect("read c");
        assert_eq!(c, TEST_BLOB_BYTES[18..20]);

        client_endpoint.close().await;
    }

    #[tokio::test]
    async fn iroh_blob_open_reports_not_found_for_an_unknown_sha256() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let err = open_blob_stream(connection, "nope".to_string())
            .await
            .expect_err("should fail for unknown sha256");
        assert!(err.contains("not_found"), "unexpected error: {err}");

        client_endpoint.close().await;
    }

    #[tokio::test]
    async fn iroh_blob_open_replaces_a_previously_open_stream() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let (_opened1, state1) = open_blob_stream(connection.clone(), "knownblob".to_string())
            .await
            .expect("first open_blob_stream");
        // Re-open on the SAME connection before closing the first — this is
        // exactly what the `iroh_blob_open` command does (assigns a fresh
        // `IrohBlobState` into the same slot, dropping the old one).
        let (_opened2, mut state) = open_blob_stream(connection, "knownblob".to_string())
            .await
            .expect("second open_blob_stream");
        drop(state1); // the slot this represented has been replaced

        let bytes = read_blob_range(&mut state, 0, 5).await.expect("read after replace");
        assert_eq!(bytes, TEST_BLOB_BYTES[0..5]);

        client_endpoint.close().await;
    }

    // ── LUCID additions: framing, caps, the sink ─────────────────────

    #[test]
    fn frame_header_is_a_four_byte_big_endian_length() {
        assert_eq!(encode_frame_header(0).unwrap(), [0, 0, 0, 0]);
        assert_eq!(encode_frame_header(1).unwrap(), [0, 0, 0, 1]);
        assert_eq!(encode_frame_header(258).unwrap(), [0, 0, 1, 2]);
        assert_eq!(decode_frame_len([0, 0, 1, 2]).unwrap(), 258);
        for len in [0usize, 1, 255, 256, 65_535, 1 << 20, MAX_FRAME_BYTES] {
            assert_eq!(decode_frame_len(encode_frame_header(len).unwrap()).unwrap(), len);
        }
    }

    #[test]
    fn frames_over_the_cap_are_refused_both_ways() {
        assert_eq!(MAX_FRAME_BYTES, 256 * 1024 * 1024);
        let err = encode_frame_header(MAX_FRAME_BYTES + 1).unwrap_err();
        assert!(err.contains("over the"), "unexpected error: {err}");
        // What a hostile worker could announce: nothing is allocated for it.
        for header in [(MAX_FRAME_BYTES as u32 + 1).to_be_bytes(), [0xff; 4]] {
            let err = decode_frame_len(header).unwrap_err();
            assert!(err.contains("over the"), "unexpected error: {err}");
        }
    }

    #[test]
    fn the_blob_range_cap_is_four_mib() {
        assert_eq!(MAX_BLOB_RANGE, 4 * 1024 * 1024);
    }

    #[tokio::test]
    async fn a_read_over_the_blob_range_cap_is_refused_before_anything_is_sent() {
        let mut state = IrohBlobState::default();
        // No stream is open: a read inside the cap says so, one over it
        // fails on the cap first.
        let within = read_blob_range(&mut state, 0, MAX_BLOB_RANGE).await.unwrap_err();
        assert!(within.contains("No blob stream open"), "unexpected error: {within}");
        let over = read_blob_range(&mut state, 0, MAX_BLOB_RANGE + 1).await.unwrap_err();
        assert!(over.contains("over the"), "unexpected error: {over}");
    }

    /// A worker that announces a frame over the cap: the client errors on the
    /// header instead of allocating.
    #[tokio::test]
    async fn read_frame_refuses_an_announced_frame_over_the_cap() {
        let addr = spawn_worker(Duration::from_millis(500), |conn| async move {
            let (mut send, _recv) = conn.accept_bi().await.expect("accept_bi");
            send.write_all(&[0xff, 0xff, 0xff, 0xff]).await.expect("write");
        })
        .await;
        let (client, _conn, mut send, mut recv) = dial(addr, Minimal).await.expect("dial");
        // The control stream only becomes visible to the worker once written to.
        write_frame(&mut send, "x").await.expect("write_frame");
        let err = read_frame(&mut recv).await.unwrap_err();
        assert!(err.contains("over the"), "unexpected error: {err}");
        client.close().await;
    }

    /// The reader pushes through the sink: a message, then (worker closing)
    /// Closed, and the connection is dropped from the registry.
    #[tokio::test]
    async fn the_reader_pushes_messages_then_closed_through_the_sink() {
        let clients = IrohClients::default();
        let (ep, conn, send, recv) =
            dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        let id = add_conn(&clients, "main", ep, conn, send).await;
        let events = Arc::new(std::sync::Mutex::new(Vec::<IrohClientEvent>::new()));
        let sink_events = events.clone();
        let sink: EventSink = Arc::new(move |e| {
            sink_events.lock().unwrap().push(e);
            true
        });
        spawn_reader(recv, sink, clients.clone(), id);

        clients.send("main", id, "ping").await.expect("send");
        // The fake worker answers once, then closes its endpoint.
        timeout(Duration::from_secs(5), async {
            loop {
                if events.lock().unwrap().contains(&IrohClientEvent::Closed) {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Closed never arrived");
        let got = events.lock().unwrap().clone();
        assert_eq!(got[0], IrohClientEvent::Message { data: "echo:ping".into() });
        assert_eq!(got.last().unwrap(), &IrohClientEvent::Closed);
        assert!(clients.with_conn("main", id, |_| ()).await.is_err(), "reader should drop its connection");
    }

    #[test]
    fn events_serialize_with_a_snake_case_kind() {
        let msg = serde_json::to_value(IrohClientEvent::Message { data: "d".into() }).unwrap();
        assert_eq!(msg, serde_json::json!({"kind": "message", "data": "d"}));
        let closed = serde_json::to_value(IrohClientEvent::Closed).unwrap();
        assert_eq!(closed, serde_json::json!({"kind": "closed"}));
        let err = serde_json::to_value(IrohClientEvent::Error { message: "m".into() }).unwrap();
        assert_eq!(err, serde_json::json!({"kind": "error", "message": "m"}));
    }

    // ── P8 stress review: hostile workers, hostile pages ─────────────

    /// [`spawn_worker`] that stays up 5 s after its script.
    async fn spawn_script_worker<F, Fut>(script: F) -> EndpointAddr
    where
        F: FnOnce(Connection) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        spawn_worker(Duration::from_secs(5), script).await
    }

    /// Dials a script worker, writes one frame (so the worker sees the
    /// control stream) and returns the client's pieces.
    async fn dial_script_worker<F, Fut>(
        script: F,
    ) -> (Endpoint, Connection, SendStream, RecvStream)
    where
        F: FnOnce(Connection) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let addr = spawn_script_worker(script).await;
        let (ep, conn, mut send, recv) = dial(addr, Minimal).await.expect("dial");
        write_frame(&mut send, "x").await.expect("write");
        (ep, conn, send, recv)
    }

    const SHORT: Duration = Duration::from_millis(300);

    #[test]
    fn blob_ids_must_be_lowercase_hex_sha256() {
        assert!(valid_blob_sha256(&"a".repeat(64)));
        assert!(valid_blob_sha256(&"0123456789abcdef".repeat(4)));
        assert!(!valid_blob_sha256(""));
        assert!(!valid_blob_sha256(&"a".repeat(63)));
        assert!(!valid_blob_sha256(&"A".repeat(64)));
        assert!(!valid_blob_sha256(&format!("{}\"}}", "a".repeat(62))));
    }

    #[test]
    fn a_dial_target_with_too_many_direct_addresses_is_refused() {
        let node_id = URL_SAFE_NO_PAD.encode(iroh::SecretKey::generate().public().as_bytes());
        let target = IrohDialTarget {
            node_id,
            relay_url: None,
            direct_addrs: Some((0..=MAX_DIRECT_ADDRS).map(|i| format!("127.0.0.1:{}", 4000 + i)).collect()),
        };
        let err = build_endpoint_addr(&target).unwrap_err();
        assert!(err.contains("direct addresses"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn another_webview_cannot_touch_a_connection_it_did_not_open() {
        let clients = IrohClients::default();
        let (ep, conn, send, _recv) = dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        let id = add_conn(&clients, "main", ep, conn, send).await;
        assert!(clients.send("other", id, "x").await.is_err());
        assert!(clients.with_conn("other", id, |_| ()).await.is_err());
        clients.close_as("other", id).await; // a no-op for a stranger
        assert!(clients.with_conn("main", id, |_| ()).await.is_ok(), "the owner's connection must survive");
        clients.close_as("main", id).await;
        assert!(clients.with_conn("main", id, |_| ()).await.is_err());
    }

    #[tokio::test]
    async fn connection_ids_are_never_zero_and_never_reused_while_open() {
        let clients = IrohClients::default();
        // Next id wraps past u32::MAX: 0 is skipped.
        clients.0.lock().await.next_id = ConnId::MAX;
        let (ep, conn, send, _r) = dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        let first = add_conn(&clients, "main", ep, conn, send).await;
        assert_eq!(first, 1);
        // The next id to hand out is still in use: it is skipped.
        clients.0.lock().await.next_id = 0;
        let (ep, conn, send, _r) = dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        let second = add_conn(&clients, "main", ep, conn, send).await;
        assert_ne!(second, first);
        assert_ne!(second, 0);
        clients.close_owned_by("main").await;
    }

    #[tokio::test]
    async fn a_window_holds_at_most_max_conns_per_owner_dials_and_connections() {
        let clients = IrohClients::default();
        let mut tickets = Vec::new();
        for _ in 0..MAX_CONNS_PER_OWNER {
            tickets.push(clients.begin("main").await.expect("begin"));
        }
        let err = clients.begin("main").await.unwrap_err();
        assert!(err.contains("Too many"), "unexpected error: {err}");
        // Another window is not affected; a failed dial gives its slot back.
        clients.begin("window-2").await.expect("other owner");
        clients.cancel(tickets.pop().unwrap()).await;
        clients.begin("main").await.expect("slot freed by cancel");
    }

    #[tokio::test]
    async fn a_dial_finishing_after_its_window_reloaded_is_closed_not_registered() {
        let clients = IrohClients::default();
        let ticket = clients.begin("main").await.expect("begin");
        let (ep, conn, send, _recv) = dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        // The webview reloads while the dial was in flight.
        clients.close_owned_by("main").await;
        let err = clients.add(ticket, ep, conn, send).await.unwrap_err();
        assert!(err.contains("gone"), "unexpected error: {err}");
        assert!(clients.0.lock().await.conns.is_empty(), "nothing may be registered");
        assert!(clients.0.lock().await.pending.is_empty(), "its slot must be given back");
        // The next dial of the same window works.
        let ticket = clients.begin("main").await.expect("begin again");
        let (ep, conn, send, _recv) = dial(spawn_fake_worker().await, Minimal).await.expect("dial");
        clients.add(ticket, ep, conn, send).await.expect("add after reload");
        clients.close_owned_by("main").await;
    }

    #[tokio::test]
    async fn a_zero_length_frame_is_an_empty_message() {
        let (client, _conn, _send, mut recv) = dial_script_worker(|conn| async move {
            let (mut send, _recv) = conn.accept_bi().await.expect("accept_bi");
            send.write_all(&[0, 0, 0, 0]).await.expect("write");
            write_frame(&mut send, "after").await.expect("write");
            sleep(Duration::from_secs(2)).await;
        })
        .await;
        assert_eq!(read_frame(&mut recv).await.unwrap(), Some(String::new()));
        assert_eq!(read_frame(&mut recv).await.unwrap(), Some("after".to_string()));
        client.close().await;
    }

    #[tokio::test]
    async fn a_frame_split_across_many_small_writes_is_reassembled() {
        let (client, _conn, _send, mut recv) = dial_script_worker(|conn| async move {
            let (mut send, _recv) = conn.accept_bi().await.expect("accept_bi");
            let payload = "hello, split world";
            let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(payload.as_bytes());
            for b in bytes {
                send.write_all(&[b]).await.expect("write");
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert_eq!(
            read_frame_with(&mut recv, MAX_FRAME_BYTES, Duration::from_secs(5)).await.unwrap(),
            Some("hello, split world".to_string())
        );
        client.close().await;
    }

    /// Slowloris: the header promises a big frame, a few bytes arrive, then
    /// nothing. The read gives up and nothing near the announced size was held.
    #[tokio::test]
    async fn a_worker_that_stalls_mid_frame_is_cut_off() {
        let (client, _conn, _send, mut recv) = dial_script_worker(|conn| async move {
            let (mut send, _recv) = conn.accept_bi().await.expect("accept_bi");
            send.write_all(&(200u32 * 1024 * 1024).to_be_bytes()).await.expect("write");
            send.write_all(b"abc").await.expect("write");
            sleep(Duration::from_secs(10)).await;
        })
        .await;
        let started = std::time::Instant::now();
        let err = read_frame_with(&mut recv, MAX_FRAME_BYTES, SHORT).await.unwrap_err();
        assert!(err.contains("stalled"), "unexpected error: {err}");
        assert!(started.elapsed() < Duration::from_secs(3));
        client.close().await;
    }

    #[tokio::test]
    async fn a_frame_over_a_callers_smaller_cap_is_refused() {
        let (client, _conn, _send, mut recv) = dial_script_worker(|conn| async move {
            let (mut send, _recv) = conn.accept_bi().await.expect("accept_bi");
            write_frame(&mut send, &"a".repeat(100)).await.expect("write");
            sleep(Duration::from_secs(2)).await;
        })
        .await;
        let err = read_frame_with(&mut recv, 10, SHORT).await.unwrap_err();
        assert!(err.contains("over the 10-byte limit"), "unexpected error: {err}");
        client.close().await;
    }

    /// A worker that opens a blob stream and answers the open with `header`
    /// (a raw string, sent as one frame), then `then`.
    async fn blob_worker_replying(
        open_reply: String,
        script: impl FnOnce(SendStream, RecvStream) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            + Send
            + 'static,
    ) -> (Endpoint, Connection) {
        let addr = spawn_script_worker(move |conn| async move {
            let _control = conn.accept_bi().await.expect("control stream");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let _open = read_frame(&mut recv).await.expect("frame");
            write_frame(&mut send, &open_reply).await.expect("write");
            script(send, recv).await;
        })
        .await;
        let (ep, conn, _s, _r) = dial(addr, Minimal).await.expect("dial");
        (ep, conn)
    }

    fn open_ok(size: u64) -> String {
        serde_json::json!({"ok": true, "size": size, "chunkSize": 4, "chunkHashes": []}).to_string()
    }

    #[tokio::test]
    async fn a_blob_reply_bigger_than_the_request_drops_the_stream() {
        let (ep, conn) = blob_worker_replying(open_ok(100), |mut send, mut recv| {
            Box::pin(async move {
                let _ = read_frame(&mut recv).await;
                let _ = write_frame(&mut send, &serde_json::json!({"ok": true, "size": 50}).to_string()).await;
            sleep(Duration::from_secs(2)).await;
            })
        })
        .await;
        let (_opened, mut state) = open_blob_stream(conn, "a".repeat(64)).await.expect("open");
        let err = read_blob_range(&mut state, 0, 10).await.unwrap_err();
        assert!(err.contains("with 50 bytes"), "unexpected error: {err}");
        let again = read_blob_range(&mut state, 0, 10).await.unwrap_err();
        assert!(again.contains("No blob stream open"), "stream must be dropped: {again}");
        ep.close().await;
    }

    /// The reply promises 10 bytes, sends 3 and finishes: an error, and the
    /// 3 body bytes are never taken for the next header.
    #[tokio::test]
    async fn a_truncated_blob_body_is_an_error_and_drops_the_stream() {
        let (ep, conn) = blob_worker_replying(open_ok(100), |mut send, mut recv| {
            Box::pin(async move {
                let _ = read_frame(&mut recv).await;
                let _ = write_frame(&mut send, &serde_json::json!({"ok": true, "size": 10}).to_string()).await;
                let _ = send.write_all(b"abc").await;
                let _ = send.finish();
                sleep(Duration::from_secs(2)).await;
            })
        })
        .await;
        let (_o, mut state) = open_blob_stream(conn, "a".repeat(64)).await.expect("open");
        let err = read_blob_range(&mut state, 0, 10).await.unwrap_err();
        assert!(err.contains("mid-body") || err.contains("body"), "unexpected error: {err}");
        assert!(read_blob_range(&mut state, 0, 10).await.unwrap_err().contains("No blob stream open"));
        ep.close().await;
    }

    #[tokio::test]
    async fn a_silent_worker_times_a_blob_read_out_and_drops_the_stream() {
        let (ep, conn) = blob_worker_replying(open_ok(100), |_send, mut recv| {
            Box::pin(async move {
                let _keep = &_send;
                let _ = read_frame(&mut recv).await;
                sleep(Duration::from_secs(10)).await;
            })
        })
        .await;
        let (_o, mut state) = open_blob_stream(conn, "a".repeat(64)).await.expect("open");
        let started = std::time::Instant::now();
        let err = read_blob_range_with(&mut state, 0, 10, SHORT, Duration::from_secs(60))
            .await
            .unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(read_blob_range(&mut state, 0, 10).await.unwrap_err().contains("No blob stream open"));
        ep.close().await;
    }

    #[tokio::test]
    async fn a_blob_open_that_never_answers_times_out() {
        let addr = spawn_script_worker(|conn| async move {
            let _control = conn.accept_bi().await.expect("control stream");
            let (_send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let _ = read_frame(&mut recv).await;
            sleep(Duration::from_secs(10)).await;
        })
        .await;
        let (ep, conn, _s, _r) = dial(addr, Minimal).await.expect("dial");
        let err = open_blob_stream_with(conn, "a".repeat(64), SHORT).await.unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
        ep.close().await;
    }

    #[tokio::test]
    async fn an_oversized_blob_read_header_is_refused() {
        let (ep, conn) = blob_worker_replying(open_ok(100), |mut send, mut recv| {
            Box::pin(async move {
                let _ = read_frame(&mut recv).await;
                let _ = write_frame(&mut send, &" ".repeat(MAX_BLOB_READ_HEADER + 1)).await;
            sleep(Duration::from_secs(2)).await;
            })
        })
        .await;
        let (_o, mut state) = open_blob_stream(conn, "a".repeat(64)).await.expect("open");
        let err = read_blob_range(&mut state, 0, 10).await.unwrap_err();
        assert!(err.contains("over the"), "unexpected error: {err}");
        ep.close().await;
    }

    #[tokio::test]
    async fn a_blob_open_reply_with_a_zero_chunk_size_is_refused() {
        let addr = spawn_script_worker(|conn| async move {
            let _control = conn.accept_bi().await.expect("control stream");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let _ = read_frame(&mut recv).await;
            let reply = serde_json::json!({"ok": true, "size": 8, "chunkSize": 0, "chunkHashes": []});
            let _ = write_frame(&mut send, &reply.to_string()).await;
            sleep(Duration::from_secs(2)).await;
        })
        .await;
        let (ep, conn, _s, _r) = dial(addr, Minimal).await.expect("dial");
        let err = open_blob_stream(conn, "a".repeat(64)).await.unwrap_err();
        assert!(err.contains("chunkSize"), "unexpected error: {err}");
        ep.close().await;
    }

    #[tokio::test]
    async fn an_overflowing_blob_range_is_refused_before_anything_is_sent() {
        let mut state = IrohBlobState::default();
        let err = read_blob_range(&mut state, u64::MAX, 1).await.unwrap_err();
        assert!(err.contains("overflows"), "unexpected error: {err}");
    }
}
