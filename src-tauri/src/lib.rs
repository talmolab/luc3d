//! LUCID desktop shell (Tauri 2).
//!
//! The frontend is the unmodified LUCID web app (staged into `dist-desktop/`).
//! This crate adds: a stable http://localhost origin for release builds, one
//! inlined plugin `lucid` holding every native command (see build.rs), the
//! window (with the JS shim `js/lucid-desktop.js` as initialization script),
//! the macOS menu bar (which carries the page's own menus: native_menu.rs),
//! and cleanup on exit.

mod close_guard;
mod dialogs;
mod files;
mod localhost;
mod native_menu;
mod sleap_nn;
mod system;
mod updates;

use std::borrow::Cow;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

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

/// `LUCID_LOG=1`: print each request the localhost server answers and each
/// close-guard change (smoke tests, debugging).
pub(crate) fn verbose_log() -> bool {
    std::env::var("LUCID_LOG").is_ok_and(|v| v == "1")
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
            dialogs::message_dialog,
            close_guard::set_close_guard,
            close_guard::confirm_close,
            system::system_info,
            native_menu::set_app_menu,
            updates::get_update_info,
            updates::set_update_channel,
            updates::check_update,
            updates::install_update,
            updates::restart_app,
            sleap_nn::sleap_nn_status,
            sleap_nn::run_python_command,
            sleap_nn::cancel_command,
            sleap_nn::detect_uv,
            sleap_nn::detect_gpu,
        ])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest (updates.rs, tauri-plugin-updater) uses rustls without a
    // built-in provider choice: install ring's once, before any thread can
    // race to a first TLS handshake (which panics without one).
    let _ = rustls::crypto::ring::default_provider().install_default();

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
        let choice = localhost::resolve_port(port_file.as_deref());
        if let localhost::PortChoice::Temporary { port, saved } = choice {
            println!(
                "[lucid] saved port {saved} is busy (is LUCID already running?); using {port} for this run only, so browser-local settings start empty"
            );
        }
        choice.port()
    } else {
        0
    };
    // Per-run token the server adds to every response; the self-check in
    // setup() looks for it.
    let marker = files::random_suffix();

    let mut builder = tauri::Builder::default()
        .manage(Arc::new(files::GrantState::default()))
        .manage(Arc::new(files::WriteSessions::default()))
        .manage(close_guard::CloseGuardState::default())
        .manage(sleap_nn::RunningProcess::default())
        .manage(native_menu::NativeMenuState::<tauri::Wry>::default())
        .on_window_event(close_guard::handle_window_event)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == native_menu::QUIT_MENU_ID {
                close_guard::request_close_all(app);
            } else if native_menu::page_key(id).is_some() {
                native_menu::on_page_item(app, id);
            } else if id.starts_with(native_menu::UPDATE_ITEM_PREFIX) {
                native_menu::on_update_item(app, id);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(lucid_plugin());

    if use_localhost {
        let log = verbose_log();
        let marker = marker.clone();
        builder = builder.plugin(
            tauri_plugin_localhost::Builder::new(localhost_port)
                .host("localhost")
                .on_request(move |req, resp| {
                    if log {
                        println!("[lucid] localhost served {}", req.url());
                    }
                    resp.add_header(localhost::MARKER_HEADER, marker.as_str());
                    if isolated {
                        resp.add_header("Cross-Origin-Opener-Policy", "same-origin");
                        resp.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                    }
                })
                .build(),
        );
    }

    let builder = builder.setup(move |app| {
        app.manage(updates::UpdateState::load(app.handle()));
        // luc3d | Edit | Window until the page sends its own menus
        // (set_app_menu); also what stays if it never does.
        #[cfg(target_os = "macos")]
        native_menu::install_initial(app.handle())?;

        let url = if use_localhost {
            // Never open the window on someone else's server: the plugin's
            // server thread panics quietly if it cannot bind, and a program
            // holding the port would then get our IPC-capable window.
            if let Err(e) =
                localhost::self_check(localhost_port, &marker, std::time::Duration::from_secs(5))
            {
                eprintln!("[lucid] startup self-check failed: {e}");
                let handle = app.handle().clone();
                app.dialog()
                    .message(format!("luc3d could not start its local server.\n\n{e}"))
                    .title("luc3d")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
                return Ok(());
            }
            // Must be granted before the webview loads.
            app.add_capability(localhost::capability(localhost_port))?;
            println!(
                "[lucid] self-check ok: serving frontend at http://localhost:{localhost_port} (cross-origin isolated: {isolated})"
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
            .title("luc3d")
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

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            close_guard::on_exit_requested(app_handle, code, &api);
        }
        // Every quit path passes here, including the macOS ones the guard
        // cannot stop (see close_guard.rs): delete the temp files of saves
        // that never committed.
        tauri::RunEvent::Exit => {
            app_handle.state::<Arc<files::WriteSessions>>().abort_all();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert_eq!(from_build.len(), 29);
        from_build.sort_unstable();
        from_lib.sort_unstable();
        assert_eq!(from_build, from_lib);
    }

    #[test]
    fn shim_is_loaded() {
        assert!(!desktop_shim().is_empty());
    }
}
