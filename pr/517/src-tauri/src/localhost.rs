//! The http://localhost origin release builds serve the frontend from
//! (tauri-plugin-localhost): port choice, the runtime capability for it, and a
//! startup self-check that the server answering is really ours.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, Instant};

/// Response header LUCID's own server adds (value: a per-run token), so the
/// self-check can tell it from another program on the same port.
pub const MARKER_HEADER: &str = "X-Lucid-App";

/// Free on BOTH loopbacks. The webview resolves `localhost` itself and may
/// try ::1 first; a port taken there by another program would hand it that
/// program's page. Only "in use" / "access denied" (Windows excluded port
/// ranges) count as busy on ::1; any other error means the host has no IPv6
/// loopback (e.g. EAFNOSUPPORT), where nothing can be listening either.
pub fn port_is_free(port: u16) -> bool {
    if port == 0 || TcpListener::bind(("127.0.0.1", port)).is_err() {
        return false;
    }
    match TcpListener::bind(("::1", port)) {
        Ok(_) => true,
        Err(e) => !matches!(
            e.kind(),
            std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
        ),
    }
}

/// A port free on both loopbacks (the OS picks on 127.0.0.1; retried until
/// ::1 agrees).
pub fn pick_free_port() -> u16 {
    let mut last = 1430;
    for _ in 0..32 {
        if let Ok(port) = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
        {
            last = port;
            if port_is_free(port) {
                return port;
            }
        }
    }
    last
}

#[derive(Debug, PartialEq, Eq)]
pub enum PortChoice {
    /// The saved port, free: the usual case.
    Saved(u16),
    /// Nothing (usable) was saved: a new port, now saved.
    NewlySaved(u16),
    /// The saved port is busy (e.g. a second LUCID is running): a port for
    /// this run only; the saved one is kept for later launches.
    Temporary { port: u16, saved: u16 },
}

impl PortChoice {
    pub fn port(&self) -> u16 {
        match *self {
            PortChoice::Saved(p) | PortChoice::NewlySaved(p) => p,
            PortChoice::Temporary { port, .. } => port,
        }
    }
}

/// WKWebView, WebKitGTK and WebView2 key localStorage/IndexedDB by origin
/// INCLUDING the port, so the port must not change between launches or every
/// browser-local LUCID preference silently resets. It is saved once in
/// `<app config dir>/localhost-port` and never overwritten while it parses;
/// a busy saved port gets a throwaway port for that run only (overwriting
/// would move the FIRST instance's settings away on its next launch).
pub fn resolve_port(port_file: Option<&Path>) -> PortChoice {
    let saved = port_file
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|&p| p != 0);
    match saved {
        Some(p) if port_is_free(p) => PortChoice::Saved(p),
        Some(p) => PortChoice::Temporary {
            port: pick_free_port(),
            saved: p,
        },
        None => {
            let port = pick_free_port();
            if let Some(path) = port_file {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, port.to_string());
            }
            PortChoice::NewlySaved(port)
        }
    }
}

/// The static capability (capabilities/default.json) re-issued for the
/// http://localhost:<port> origin. A page on that origin is REMOTE to Tauri,
/// so the build-time local capability does not cover it, and the port is only
/// known at launch. Derived from the same file so the two can never drift.
pub fn capability(port: u16) -> String {
    let mut cap: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("capabilities/default.json is valid JSON");
    let obj = cap.as_object_mut().expect("capability is a JSON object");
    obj.remove("$schema");
    obj.insert("identifier".into(), "localhost-dynamic".into());
    obj.insert(
        "description".into(),
        "Runtime grant for the http://localhost origin (tauri-plugin-localhost).".into(),
    );
    obj.insert("local".into(), false.into());
    obj.insert(
        "remote".into(),
        serde_json::json!({ "urls": [format!("http://localhost:{port}")] }),
    );
    cap.to_string()
}

/// One GET of `/`: Ok(None) if the response carries our marker, Ok(Some(status
/// line)) if something answered without it (another program, or our server
/// without an index.html), Err if nothing could be reached.
fn probe_once(addr: SocketAddr, port: u16, marker: &str) -> std::io::Result<Option<String>> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET / HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 64 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(e),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    if buf.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "connection closed without a response",
        ));
    }
    if has_marker(&head, marker) {
        Ok(None)
    } else {
        Ok(Some(head.lines().next().unwrap_or("").trim().to_string()))
    }
}

/// Does an HTTP response head carry `X-Lucid-App: <marker>`?
pub fn has_marker(head: &str, marker: &str) -> bool {
    let want = MARKER_HEADER.to_ascii_lowercase();
    head.split("\r\n").skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().to_ascii_lowercase() == want && value.trim() == marker
        })
    })
}

/// Wait (up to `timeout`; the server thread may still be starting) until
/// `http://localhost:<port>/` answers with our marker. Fails at once if
/// anything answers without it.
pub fn self_check(port: u16, marker: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last_err = String::from("no response");
    loop {
        let addrs: Vec<SocketAddr> = ("localhost", port)
            .to_socket_addrs()
            .map_err(|e| format!("cannot resolve localhost: {e}"))?
            .collect();
        for addr in &addrs {
            match probe_once(*addr, port, marker) {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => {
                    return Err(format!(
                        "http://localhost:{port} ({addr}) did not serve LUCID (\"{status}\"): \
                         another program may be using the port, or the app's files are missing"
                    ))
                }
                Err(e) => last_err = format!("{addr}: {e}"),
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "LUCID's local server did not answer on http://localhost:{port} ({last_err})"
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lucid-port-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("sub").join("localhost-port")
    }

    #[test]
    fn port_is_saved_once_and_reused() {
        let file = scratch_file("save");
        let first = resolve_port(Some(&file));
        assert!(matches!(first, PortChoice::NewlySaved(_)));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            first.port().to_string()
        );
        assert_eq!(resolve_port(Some(&file)), PortChoice::Saved(first.port()));
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn busy_saved_port_gets_a_temporary_port_and_is_not_overwritten() {
        let file = scratch_file("busy");
        let saved = resolve_port(Some(&file)).port();
        let _hold = TcpListener::bind(("127.0.0.1", saved)).unwrap();
        match resolve_port(Some(&file)) {
            PortChoice::Temporary { port, saved: s } => {
                assert_eq!(s, saved);
                assert_ne!(port, saved);
            }
            other => panic!("expected Temporary, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), saved.to_string());
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn garbage_port_file_is_replaced() {
        let file = scratch_file("garbage");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not a port").unwrap();
        let c = resolve_port(Some(&file));
        assert!(matches!(c, PortChoice::NewlySaved(_)));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            c.port().to_string()
        );
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_port_busy_on_ipv6_only_is_not_free() {
        let Ok(l) = TcpListener::bind("[::1]:0") else {
            return; // no IPv6 loopback on this host
        };
        let port = l.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(l);
    }

    #[test]
    fn marker_header_is_matched_case_insensitively_by_name_only() {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nx-lucid-app: abc123\r\n\r\n";
        assert!(has_marker(head, "abc123"));
        assert!(!has_marker(head, "other"));
        assert!(!has_marker(
            "HTTP/1.1 200 OK\r\nServer: x\r\n\r\n",
            "abc123"
        ));
    }

    /// A one-shot HTTP server on 127.0.0.1 answering with `extra_header`.
    fn serve_once(extra_header: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten().take(4) {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\n{extra_header}Content-Length: 0\r\n\r\n"
                );
            }
        });
        port
    }

    #[test]
    fn self_check_accepts_our_server_and_refuses_a_stranger() {
        let ours = serve_once("X-Lucid-App: tok\r\n");
        // `localhost` may resolve to ::1 first; the probe tries every address.
        assert_eq!(self_check(ours, "tok", Duration::from_secs(3)), Ok(()));
        let theirs = serve_once("Server: someone-else\r\n");
        let err = self_check(theirs, "tok", Duration::from_secs(3)).unwrap_err();
        assert!(err.contains("did not serve LUCID"), "{err}");
    }

    #[test]
    fn self_check_times_out_when_nothing_listens() {
        let port = pick_free_port();
        let t = Instant::now();
        let err = self_check(port, "tok", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn capability_mirrors_default_json() {
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let remote: serde_json::Value = serde_json::from_str(&capability(4321)).unwrap();
        assert_eq!(remote["permissions"], local["permissions"]);
        assert_eq!(remote["windows"], local["windows"]);
        assert_eq!(remote["local"], false);
        assert_eq!(remote["remote"]["urls"][0], "http://localhost:4321");
        assert_ne!(remote["identifier"], local["identifier"]);
        assert!(remote.get("$schema").is_none());
    }

    #[test]
    fn capability_grants_only_what_the_shim_uses() {
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = local["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().expect("plain permission ids only"))
            .collect();
        assert_eq!(perms, vec!["core:event:default", "lucid:default"]);
    }
}
