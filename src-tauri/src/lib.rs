//! LUCID desktop shell (Tauri 2).
//!
//! The frontend is the unmodified LUCID web app (staged into `dist-desktop/`).
//! This crate adds: a stable http://localhost origin for release builds, one
//! inlined plugin `lucid` holding every native command (see build.rs), the
//! window (with the JS shim `js/lucid-desktop.js` as initialization script),
//! the macOS menu, and cleanup on exit.

mod close_guard;
mod dialogs;
mod files;
mod sleap_nn;
mod system;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// Serve the app cross-origin isolated (COOP + COEP) so SharedArrayBuffer is
/// available. OFF: LUCID does not need it yet, and COEP `require-corp` would
/// block the huggingface.co model fetches of the image ID-switch check. It is
/// the switch for the future sleap-nn / sleap-io openRange path; it can also be
/// turned on per launch with `LUCID_CROSS_ORIGIN_ISOLATED=1`. It only affects
/// the localhost origin (the tauri:// fallback takes headers from
/// tauri.conf.json, which sets none).
const CROSS_ORIGIN_ISOLATED: bool = false;

fn cross_origin_isolated() -> bool {
    CROSS_ORIGIN_ISOLATED || std::env::var("LUCID_CROSS_ORIGIN_ISOLATED").is_ok_and(|v| v == "1")
}

/// Print every request the localhost server answers (smoke tests, debugging).
fn log_requests() -> bool {
    std::env::var("LUCID_LOG_REQUESTS").is_ok_and(|v| v == "1")
}

// ---------------------------------------------------------------------------
// Localhost origin
// ---------------------------------------------------------------------------

fn port_is_free(port: u16) -> bool {
    port != 0 && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(1430)
}

/// Resolve the localhost port, preferring the one saved by the last launch.
///
/// WKWebView, WebKitGTK and WebView2 key localStorage/IndexedDB by origin
/// INCLUDING the port, so a new port each launch would silently reset every
/// browser-local LUCID preference. The port is saved in
/// `<app config dir>/localhost-port` and reused while free; only when it is
/// taken (second instance, another program) is a new one picked and saved.
/// The file I/O is best-effort.
fn resolve_localhost_port(port_file: Option<PathBuf>) -> u16 {
    if let Some(saved) = port_file
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|&p| port_is_free(p))
    {
        return saved;
    }
    let port = pick_free_port();
    if let Some(path) = port_file {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, port.to_string());
    }
    port
}

/// The static capability (capabilities/default.json) re-issued for the
/// http://localhost:<port> origin. A page on that origin is REMOTE to Tauri,
/// so the build-time local capability does not cover it, and the port is only
/// known at launch. Derived from the same file so the two can never drift.
fn localhost_capability(port: u16) -> String {
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

// ---------------------------------------------------------------------------
// Window + shim
// ---------------------------------------------------------------------------

/// The JS shim injected before page scripts. Release builds embed it; debug
/// builds re-read it from disk at window creation so it can be edited without
/// recompiling (falling back to the embedded copy).
fn desktop_shim() -> Cow<'static, str> {
    const EMBEDDED: &str = include_str!("../js/lucid-desktop.js");
    if cfg!(debug_assertions) {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/js/lucid-desktop.js");
        if let Ok(s) = std::fs::read_to_string(path) {
            return Cow::Owned(s);
        }
    }
    Cow::Borrowed(EMBEDDED)
}

/// The inlined plugin `lucid`: invoked from JS as `plugin:lucid|<name>`.
/// Plugin commands (unlike bare app commands) can be granted to the remote
/// http://localhost origin. Keep this list identical to build.rs COMMANDS.
fn lucid_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("lucid")
        .invoke_handler(tauri::generate_handler![
            dialogs::pick_save_path,
            dialogs::pick_directory,
            files::path_stat,
            files::read_range,
            files::list_dir,
            files::make_dir,
            files::write_open,
            files::write_chunk,
            files::write_truncate,
            files::write_commit,
            files::write_abort,
            files::reveal_path,
            files::open_external_url,
            dialogs::ask_dialog,
            close_guard::set_close_guard,
            close_guard::confirm_close,
            system::system_info,
            sleap_nn::sleap_nn_status,
            sleap_nn::run_python_command,
            sleap_nn::cancel_command,
            sleap_nn::detect_uv,
            sleap_nn::detect_gpu,
        ])
        .build()
}

#[cfg(target_os = "macos")]
fn set_macos_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let app_menu = SubmenuBuilder::new(app, "LUCID")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    // NO Undo/Redo: their native Cmd+Z / Cmd+Shift+Z accelerators would eat
    // the keystroke before LUCID's own undo handler sees it.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    // Release builds serve the frontend from http://localhost (secure
    // context, Cache API, stable origin). `tauri::is_dev()` is true only under
    // `tauri dev`, which loads devUrl instead. LUCID_ORIGIN=custom falls back
    // to the tauri:// app protocol.
    let use_localhost = !tauri::is_dev()
        && std::env::var("LUCID_ORIGIN")
            .map(|v| v != "custom")
            .unwrap_or(true);
    let isolated = use_localhost && cross_origin_isolated();

    // WebKitGTK exposes no SharedArrayBuffer constructor even on an isolated
    // page unless this JavaScriptCore option is set, and the WebKitWebProcess
    // inherits it from us, so it must be set before the first webview spawns.
    #[cfg(target_os = "linux")]
    if isolated {
        std::env::set_var("JSC_useSharedArrayBuffer", "1");
    }

    // Resolved once and used for the server, the window URL and the runtime
    // capability, so all three agree. Same directory as app_config_dir().
    let localhost_port = if use_localhost {
        let port_file =
            dirs::config_dir().map(|d| d.join(&context.config().identifier).join("localhost-port"));
        resolve_localhost_port(port_file)
    } else {
        0
    };

    let mut builder = tauri::Builder::default()
        .manage(files::GrantState::default())
        .manage(Arc::new(files::WriteSessions::default()))
        .manage(close_guard::CloseGuardState::default())
        .manage(sleap_nn::RunningProcess::default())
        .on_window_event(close_guard::handle_window_event)
        .plugin(tauri_plugin_dialog::init())
        .plugin(lucid_plugin());

    if use_localhost {
        let log = log_requests();
        builder = builder.plugin(
            tauri_plugin_localhost::Builder::new(localhost_port)
                .host("localhost")
                .on_request(move |req, resp| {
                    if log {
                        println!("[lucid] localhost served {}", req.url());
                    }
                    if isolated {
                        resp.add_header("Cross-Origin-Opener-Policy", "same-origin");
                        resp.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                    }
                })
                .build(),
        );
    }

    let builder = builder.setup(move |app| {
        #[cfg(target_os = "macos")]
        set_macos_menu(app)?;

        let url = if use_localhost {
            // Must be granted before the webview loads.
            app.add_capability(localhost_capability(localhost_port))?;
            println!(
                "[lucid] serving frontend at http://localhost:{localhost_port} (cross-origin isolated: {isolated})"
            );
            tauri::WebviewUrl::External(
                format!("http://localhost:{localhost_port}")
                    .parse()
                    .expect("valid localhost url"),
            )
        } else {
            tauri::WebviewUrl::App("index.html".into())
        };

        tauri::WebviewWindowBuilder::new(app, "main", url)
            .title("LUCID")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 700.0)
            .resizable(true)
            // Lets LUCID's own HTML5 drag-and-drop receive file drops (on
            // Windows the native handler would swallow them).
            .disable_drag_drop_handler()
            .initialization_script(desktop_shim())
            .build()?;
        Ok(())
    });

    let app = builder
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Every quit path (incl. macOS Cmd+Q) passes here: delete the temp
        // files of saves that never committed.
        if let tauri::RunEvent::Exit = event {
            app_handle.state::<Arc<files::WriteSessions>>().abort_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localhost_capability_mirrors_default_json() {
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let remote: serde_json::Value = serde_json::from_str(&localhost_capability(4321)).unwrap();
        assert_eq!(remote["permissions"], local["permissions"]);
        assert_eq!(remote["windows"], local["windows"]);
        assert_eq!(remote["local"], false);
        assert_eq!(remote["remote"]["urls"][0], "http://localhost:4321");
        assert_ne!(remote["identifier"], local["identifier"]);
        assert!(remote.get("$schema").is_none());
        let perms: Vec<&str> = remote["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        assert!(perms.contains(&"lucid:default"));
    }

    #[test]
    fn persisted_port_is_reused_while_free() {
        let dir = std::env::temp_dir().join(format!("lucid-port-{}", std::process::id()));
        let file = dir.join("sub").join("localhost-port");
        let _ = std::fs::remove_dir_all(&dir);
        let first = resolve_localhost_port(Some(file.clone()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), first.to_string());
        assert_eq!(resolve_localhost_port(Some(file.clone())), first);

        // Saved port busy -> a different port, and the file is rewritten.
        let _hold = std::net::TcpListener::bind(("127.0.0.1", first)).unwrap();
        let second = resolve_localhost_port(Some(file.clone()));
        assert_ne!(second, first);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), second.to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// build.rs (ACL permissions) and generate_handler! (dispatch) must list
    /// the same commands, or a command is either unreachable or unpermitted.
    #[test]
    fn build_rs_and_handler_list_the_same_commands() {
        let build = include_str!("../build.rs");
        let consts = &build[build.find("const COMMANDS").unwrap()..];
        let consts = &consts[..consts.find("];").unwrap()];
        let mut from_build: Vec<&str> = consts.split('"').skip(1).step_by(2).collect();

        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").unwrap() + "generate_handler![".len();
        let body = &lib[start..start + lib[start..].find(']').unwrap()];
        let mut from_lib: Vec<&str> = body
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap())
            .collect();

        assert_eq!(from_build.len(), 22);
        from_build.sort_unstable();
        from_lib.sort_unstable();
        assert_eq!(from_build, from_lib);
    }

    #[test]
    fn shim_is_loaded() {
        assert!(!desktop_shim().is_empty());
    }
}
