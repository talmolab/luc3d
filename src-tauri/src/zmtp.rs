//! The two ZeroMQ sockets sleap-nn talks to a GUI over, in plain std Rust (no libzmq).
//!
//! sleap-nn's training callbacks (`sleap_nn/training/callbacks.py`) CONNECT to two local TCP
//! ports when its config names them (`trainer_config.zmq.publish_port` / `controller_port`):
//!   - `ProgressReporterZMQ`, a PUB, sends one JSON string per event (`train_begin`,
//!     `epoch_end`, `batch_end`, …) to the port we BIND a SUB on ([`SubListener`]);
//!   - `TrainingControllerZMQ`, a SUB, polls the port we BIND a PUB on ([`PubServer`]) at each
//!     batch end and `jsonpickle.decode`s what it receives. Arbitrary bytes there could run code
//!     in sleap-nn, so the only thing ever sent is [`STOP_MESSAGE`].
//!
//! sleap-app runs both sockets in Python relay processes on fixed ports 9000/9001 (killing whatever
//! holds 9000 first). Here both are bound by Rust on `127.0.0.1:0` (ports the OS picks) for the
//! life of the run, so no other program is touched and nothing else can take the port.
//!
//! Only what those two pairs need of ZMTP 3.0 (RFC 23) is implemented: the greeting with the NULL
//! mechanism, the READY command with `Socket-Type`, short and long single-frame messages, and the
//! subscription a SUB sends (as a ZMTP 3.0 `0x01` message or a 3.1 SUBSCRIBE command, both read
//! and ignored by the PUB: it sends to every peer). Multi-part messages are read and joined.
#![cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// The one message the controller socket ever carries (sleap-nn: `{"command": "stop"}`).
pub const STOP_MESSAGE: &[u8] = br#"{"command":"stop"}"#;
/// Largest progress message accepted (a sleap-nn event is a few hundred bytes).
pub const MAX_MESSAGE: u64 = 1 << 20;

const FLAG_MORE: u8 = 0x01;
const FLAG_LONG: u8 = 0x02;
const FLAG_COMMAND: u8 = 0x04;

/// Our greeting: signature, version 3.0, NULL mechanism, as-server = 0.
fn greeting() -> [u8; 64] {
    let mut g = [0u8; 64];
    g[0] = 0xFF;
    g[9] = 0x7F;
    g[10] = 3; // major
    g[11] = 0; // minor
    g[12..16].copy_from_slice(b"NULL");
    g
}

fn read_greeting(s: &mut TcpStream) -> std::io::Result<()> {
    let mut g = [0u8; 64];
    s.read_exact(&mut g)?;
    if g[0] != 0xFF || g[9] & 0x01 != 0x01 || g[10] < 3 || &g[12..16] != b"NULL" {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a ZMTP 3 NULL peer"));
    }
    Ok(())
}

fn write_frame(s: &mut TcpStream, flags: u8, body: &[u8]) -> std::io::Result<()> {
    if body.len() <= 255 {
        s.write_all(&[flags, body.len() as u8])?;
    } else {
        s.write_all(&[flags | FLAG_LONG])?;
        s.write_all(&(body.len() as u64).to_be_bytes())?;
    }
    s.write_all(body)
}

/// One frame: (flags, body). Refuses bodies over [`MAX_MESSAGE`].
fn read_frame(s: &mut TcpStream) -> std::io::Result<(u8, Vec<u8>)> {
    let mut f = [0u8; 1];
    s.read_exact(&mut f)?;
    let len = if f[0] & FLAG_LONG != 0 {
        let mut l = [0u8; 8];
        s.read_exact(&mut l)?;
        u64::from_be_bytes(l)
    } else {
        let mut l = [0u8; 1];
        s.read_exact(&mut l)?;
        l[0] as u64
    };
    if len > MAX_MESSAGE {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len as usize];
    s.read_exact(&mut body)?;
    Ok((f[0], body))
}

/// The READY command naming our socket type.
fn ready(socket_type: &str) -> Vec<u8> {
    let mut b = Vec::new();
    b.push(5);
    b.extend_from_slice(b"READY");
    b.push(11);
    b.extend_from_slice(b"Socket-Type");
    b.extend_from_slice(&(socket_type.len() as u32).to_be_bytes());
    b.extend_from_slice(socket_type.as_bytes());
    b
}

/// Greeting both ways, then READY both ways. The peer's READY is read and checked loosely
/// (it must be a command named READY).
fn handshake(s: &mut TcpStream, socket_type: &str) -> std::io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    s.write_all(&greeting())?;
    read_greeting(s)?;
    write_frame(s, FLAG_COMMAND, &ready(socket_type))?;
    let (flags, body) = read_frame(s)?;
    if flags & FLAG_COMMAND == 0 || body.len() < 6 || &body[1..6] != b"READY" {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "peer did not send READY"));
    }
    Ok(())
}

/// A PUB bound on `127.0.0.1:0`: every SUB that connects gets every message sent after its
/// handshake (sleap-nn's controller subscribes to everything).
pub struct PubServer {
    port: u16,
    peers: Arc<Mutex<Vec<TcpStream>>>,
    closed: Arc<AtomicBool>,
}

impl PubServer {
    pub fn bind_local() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let peers: Arc<Mutex<Vec<TcpStream>>> = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let (p, c) = (Arc::clone(&peers), Arc::clone(&closed));
        thread::spawn(move || {
            for conn in listener.incoming() {
                if c.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let p2 = Arc::clone(&p);
                // Handshake off the accept loop; then drain (and ignore) whatever the SUB sends
                // (its subscriptions) so its writes never block.
                thread::spawn(move || {
                    if handshake(&mut s, "PUB").is_err() {
                        return;
                    }
                    let Ok(reader) = s.try_clone() else { return };
                    if let Ok(mut peers) = p2.lock() {
                        peers.push(s);
                    }
                    let mut r = reader;
                    let _ = r.set_read_timeout(None);
                    while read_frame(&mut r).is_ok() {}
                });
            }
        });
        Ok(Self { port, peers, closed })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// How many SUBs finished their handshake.
    #[cfg(test)]
    pub fn peer_count(&self) -> usize {
        self.peers.lock().map(|p| p.len()).unwrap_or(0)
    }

    /// Send one single-frame message to every connected SUB (a peer that fails is dropped).
    pub fn send(&self, msg: &[u8]) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.retain_mut(|s| write_frame(s, 0, msg).is_ok());
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut peers) = self.peers.lock() {
            for s in peers.drain(..) {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        // Wake the accept loop so it sees `closed`.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

impl Drop for PubServer {
    fn drop(&mut self) {
        self.close();
    }
}

/// A SUB bound on `127.0.0.1:0` subscribed to everything: each message a connecting PUB sends is
/// handed to `on_message` (multi-part messages joined), on the connection's own thread.
pub struct SubListener {
    port: u16,
    closed: Arc<AtomicBool>,
    conns: Arc<Mutex<Vec<TcpStream>>>,
}

impl SubListener {
    pub fn bind_local<F>(on_message: F) -> std::io::Result<Self>
    where
        F: Fn(Vec<u8>) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let closed = Arc::new(AtomicBool::new(false));
        let conns: Arc<Mutex<Vec<TcpStream>>> = Arc::default();
        let on_message = Arc::new(on_message);
        let (c, cs) = (Arc::clone(&closed), Arc::clone(&conns));
        thread::spawn(move || {
            for conn in listener.incoming() {
                if c.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let cb = Arc::clone(&on_message);
                let cs2 = Arc::clone(&cs);
                thread::spawn(move || {
                    if handshake(&mut s, "SUB").is_err() {
                        return;
                    }
                    // Subscribe to every topic: ZMTP 3.0 form, a message `0x01` + topic.
                    if write_frame(&mut s, 0, &[0x01]).is_err() {
                        return;
                    }
                    if let Ok(clone) = s.try_clone() {
                        if let Ok(mut v) = cs2.lock() {
                            v.push(clone);
                        }
                    }
                    let _ = s.set_read_timeout(None);
                    let mut parts: Vec<u8> = Vec::new();
                    while let Ok((flags, body)) = read_frame(&mut s) {
                        if flags & FLAG_COMMAND != 0 {
                            continue;
                        }
                        if parts.len() as u64 + body.len() as u64 > MAX_MESSAGE {
                            break;
                        }
                        parts.extend_from_slice(&body);
                        if flags & FLAG_MORE == 0 {
                            cb(std::mem::take(&mut parts));
                        }
                    }
                });
            }
        });
        Ok(Self { port, closed, conns })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut v) = self.conns.lock() {
            for s in v.drain(..) {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

impl Drop for SubListener {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    /// A minimal ZMTP peer: greeting + READY as `socket_type`.
    fn peer(port: u16, socket_type: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        handshake(&mut s, socket_type).unwrap();
        s
    }

    #[test]
    fn greeting_is_zmtp_3_null() {
        let g = greeting();
        assert_eq!(g.len(), 64);
        assert_eq!((g[0], g[9], g[10]), (0xFF, 0x7F, 3));
        assert_eq!(&g[12..16], b"NULL");
        assert_eq!(g[32], 0, "as-server");
    }

    #[test]
    fn sub_listener_receives_short_long_and_multipart_messages() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sub = SubListener::bind_local(move |m| {
            let _ = tx.lock().unwrap().send(m);
        })
        .unwrap();
        let mut p = peer(sub.port(), "PUB");
        // The listener subscribes to everything first.
        let (flags, body) = read_frame(&mut p).unwrap();
        assert_eq!((flags, body), (0, vec![0x01]));
        write_frame(&mut p, 0, br#"{"event":"epoch_end"}"#).unwrap();
        let long = vec![b'x'; 300];
        write_frame(&mut p, 0, &long).unwrap();
        write_frame(&mut p, FLAG_MORE, b"ab").unwrap();
        write_frame(&mut p, 0, b"cd").unwrap();
        let got: Vec<Vec<u8>> = (0..3).map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        assert_eq!(got[0], br#"{"event":"epoch_end"}"#.to_vec());
        assert_eq!(got[1], long);
        assert_eq!(got[2], b"abcd".to_vec());
    }

    #[test]
    fn sub_listener_drops_an_oversized_frame_and_the_connection() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let tx = Mutex::new(tx);
        let sub = SubListener::bind_local(move |m| {
            let _ = tx.lock().unwrap().send(m);
        })
        .unwrap();
        let mut p = peer(sub.port(), "PUB");
        let _ = read_frame(&mut p).unwrap();
        p.write_all(&[FLAG_LONG]).unwrap();
        p.write_all(&(MAX_MESSAGE + 1).to_be_bytes()).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    }

    #[test]
    fn pub_server_sends_only_after_the_handshake_and_ignores_subscriptions() {
        let pubs = PubServer::bind_local().unwrap();
        let mut s = peer(pubs.port(), "SUB");
        write_frame(&mut s, 0, &[0x01]).unwrap(); // subscribe ""
        let t0 = Instant::now();
        while pubs.peer_count() == 0 && t0.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(pubs.peer_count(), 1);
        pubs.send(STOP_MESSAGE);
        let (flags, body) = read_frame(&mut s).unwrap();
        assert_eq!(flags, 0);
        assert_eq!(body, STOP_MESSAGE.to_vec());
    }

    #[test]
    fn a_peer_that_is_not_zmtp_is_refused() {
        let pubs = PubServer::bind_local().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", pubs.port())).unwrap();
        s.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        s.write_all(&[0u8; 64]).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert_eq!(pubs.peer_count(), 0);
    }

    /// Interop with the REAL thing: sleap-nn's own `ProgressReporterZMQ` (pyzmq PUB, connect) and
    /// `TrainingControllerZMQ` (pyzmq SUB, connect, `jsonpickle.decode`). Needs sleap-nn's Python:
    /// `LUCID_SLEAP_NN_PYTHON=~/.local/share/uv/tools/sleap-nn/bin/python3 cargo test --features
    /// sleap-nn zmtp -- --ignored`.
    #[test]
    #[ignore]
    fn interop_with_sleap_nn_callbacks() {
        let Ok(py) = std::env::var("LUCID_SLEAP_NN_PYTHON") else {
            eprintln!("LUCID_SLEAP_NN_PYTHON not set: skipped");
            return;
        };
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sub = SubListener::bind_local(move |m| {
            let _ = tx.lock().unwrap().send(m);
        })
        .unwrap();
        let pubs = PubServer::bind_local().unwrap();
        let script = format!(
            r#"
import time, json, jsonpickle
from sleap_nn.training.callbacks import ProgressReporterZMQ, TrainingControllerZMQ
rep = ProgressReporterZMQ(address="tcp://127.0.0.1:{sub}")
ctl = TrainingControllerZMQ(address="tcp://127.0.0.1:{publ}")
time.sleep(1.0)  # PUB/SUB late joiner: let both connections settle
rep.send("train_begin", wandb_url=None)
rep.send("epoch_end", epoch=0, logs={{"train/loss": 0.5, "val/loss": float("nan")}})
rep.send("batch_end", epoch=0, batch=3, logs={{"loss": 0.25}})
got = None
for _ in range(100):
    if ctl.socket.poll(100):
        got = jsonpickle.decode(ctl.socket.recv_string())
        break
print("STOP=" + json.dumps(got), flush=True)
"#,
            sub = sub.port(),
            publ = pubs.port()
        );
        let mut child = std::process::Command::new(py)
            .args(["-I", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // The controller connects; once it is there, send stop (resent like the real run does).
        let t0 = Instant::now();
        let mut msgs = Vec::new();
        while msgs.len() < 3 && t0.elapsed() < Duration::from_secs(20) {
            if let Ok(m) = rx.recv_timeout(Duration::from_millis(200)) {
                msgs.push(String::from_utf8(m).unwrap());
            }
        }
        for _ in 0..40 {
            pubs.send(STOP_MESSAGE);
            thread::sleep(Duration::from_millis(250));
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
        }
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(msgs.len(), 3, "three progress messages: {msgs:?}");
        assert!(msgs[0].contains("\"train_begin\""), "{}", msgs[0]);
        assert!(msgs[1].contains("\"epoch_end\"") && msgs[1].contains("NaN"), "jsonpickle writes NaN bare: {}", msgs[1]);
        assert!(msgs[2].contains("\"batch_end\""), "{}", msgs[2]);
        assert!(stdout.contains("STOP={\"command\": \"stop\"}"), "the controller decoded stop: {stdout}");
    }

    #[test]
    fn ports_are_os_chosen_and_distinct() {
        let a = PubServer::bind_local().unwrap();
        let b = SubListener::bind_local(|_| {}).unwrap();
        assert!(a.port() > 0 && b.port() > 0 && a.port() != b.port());
        assert_ne!(a.port(), 9000);
    }
}
