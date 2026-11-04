//! Unsaved-changes close guard.
//!
//! A webview's own `beforeunload` prompt does not fire when the native window
//! is closed, so the JS shim opts in with `set_close_guard({enabled: true})`.
//! While enabled, a close request is cancelled and `lucid://close-requested`
//! is emitted to that window; the page decides and calls `confirm_close` to
//! really close.
//!
//! Hung page: the shim acknowledges each request at once (any
//! `set_close_guard` call counts). If a request is still unacknowledged and
//! the user asks to close again more than `HUNG_AFTER` later, a native
//! "not responding" dialog offers Close / Wait. A user who answered the
//! page's own "Cancel" is not affected: their request was acknowledged, so the
//! next close asks the page again.
//!
//! Quitting goes through the same guard: the macOS Quit item (Cmd+Q) is our
//! own item that asks every window to close (`request_close_all`), and an
//! explicit exit request is turned into the same thing (`on_exit_requested`).
//! NOT caught: Dock > Quit, logout/shutdown and `osascript quit` on macOS.
//! They call NSApp `terminate:`, which tao 0.35 lets through (it implements no
//! `applicationShouldTerminate:`); the app then gets only `RunEvent::Exit`,
//! where open write sessions are aborted so no temp files are left behind.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub const CLOSE_REQUESTED_EVENT: &str = "lucid://close-requested";
pub const HUNG_AFTER: Duration = Duration::from_secs(5);
pub const HUNG_MESSAGE: &str =
    "LUCID is not responding. Close anyway? Unsaved changes will be lost.";

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// No guard: let the window close.
    Allow,
    /// Guarded: cancel the close and ask the page.
    PreventAndAsk,
    /// Guarded, and the page never acknowledged an earlier request: cancel
    /// the close and ask the user natively whether to close anyway.
    PreventAndAskHung,
    /// The "not responding" dialog is already up: just cancel this close.
    Prevent,
}

#[derive(Default, Debug)]
struct WindowGuard {
    enabled: bool,
    /// Time of the oldest close request the page has not acknowledged.
    pending_since: Option<Instant>,
    hung_dialog_open: bool,
}

/// Per-window guard state, keyed by window label. Pure logic: time is passed
/// in so the hung-page rule is testable.
#[derive(Default, Debug)]
pub struct CloseGuards(HashMap<String, WindowGuard>);

impl CloseGuards {
    /// `set_close_guard`: also acknowledges any pending request.
    pub fn set(&mut self, label: &str, enabled: bool) {
        let g = self.0.entry(label.to_string()).or_default();
        g.enabled = enabled;
        g.pending_since = None;
    }

    pub fn on_close_requested(&mut self, label: &str, now: Instant) -> CloseDecision {
        let Some(g) = self.0.get_mut(label).filter(|g| g.enabled) else {
            return CloseDecision::Allow;
        };
        if g.hung_dialog_open {
            return CloseDecision::Prevent;
        }
        match g.pending_since {
            Some(t) if now.saturating_duration_since(t) > HUNG_AFTER => {
                g.hung_dialog_open = true;
                CloseDecision::PreventAndAskHung
            }
            Some(_) => CloseDecision::PreventAndAsk,
            None => {
                g.pending_since = Some(now);
                CloseDecision::PreventAndAsk
            }
        }
    }

    /// The "not responding" dialog was answered. On Wait the request stays
    /// unacknowledged, so a later close may offer the dialog again.
    pub fn hung_dialog_answered(&mut self, label: &str, close: bool) {
        if close {
            self.0.remove(label);
        } else if let Some(g) = self.0.get_mut(label) {
            g.hung_dialog_open = false;
        }
    }

    pub fn is_enabled(&self, label: &str) -> bool {
        self.0.get(label).is_some_and(|g| g.enabled)
    }

    pub fn forget(&mut self, label: &str) {
        self.0.remove(label);
    }
}

#[derive(Default)]
pub struct CloseGuardState(pub Mutex<CloseGuards>);

fn show_hung_dialog<R: Runtime>(window: &Window<R>) {
    let target = window.clone();
    window
        .dialog()
        .message(HUNG_MESSAGE)
        .title("LUCID")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close".into(),
            "Wait".into(),
        ))
        // Non-blocking: this runs on the event-loop thread.
        .show(move |close| {
            if let Ok(mut g) = target.state::<CloseGuardState>().0.lock() {
                g.hung_dialog_answered(target.label(), close);
            }
            if close {
                eprintln!("[lucid] close guard: page not responding, closed by the user");
                let _ = target.destroy();
            }
        });
}

/// Hooked into `Builder::on_window_event`.
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let state = window.state::<CloseGuardState>();
            let decision = match state.0.lock() {
                Ok(mut g) => g.on_close_requested(window.label(), Instant::now()),
                // A poisoned lock must never trap the user in the window.
                Err(_) => CloseDecision::Allow,
            };
            match decision {
                CloseDecision::Allow => {}
                CloseDecision::Prevent => api.prevent_close(),
                CloseDecision::PreventAndAsk => {
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), CLOSE_REQUESTED_EVENT, ());
                }
                CloseDecision::PreventAndAskHung => {
                    api.prevent_close();
                    show_hung_dialog(window);
                }
            }
        }
        WindowEvent::Destroyed => {
            if let Ok(mut g) = window.state::<CloseGuardState>().0.lock() {
                g.forget(window.label());
            }
        }
        _ => {}
    }
}

/// Ask every window to close, as if the user clicked each close button, so
/// each goes through its guard. The app exits when the last one is gone.
pub fn request_close_all<R: Runtime>(app: &AppHandle<R>) {
    for window in app.webview_windows().values() {
        let _ = window.close();
    }
}

/// `RunEvent::ExitRequested`. `code: None` means the last window already
/// closed (each passed its own guard): let it go. An explicit exit request
/// (`code: Some`) while a guarded window is open is turned into a close of
/// every window instead.
pub fn on_exit_requested<R: Runtime>(
    app: &AppHandle<R>,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    if code.is_none() {
        return;
    }
    let guarded = match app.state::<CloseGuardState>().0.lock() {
        Ok(g) => app.webview_windows().keys().any(|l| g.is_enabled(l)),
        Err(_) => false,
    };
    if guarded {
        api.prevent_exit();
        request_close_all(app);
    }
}

#[tauri::command]
pub fn set_close_guard<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, CloseGuardState>,
    enabled: bool,
) -> Result<(), String> {
    if crate::verbose_log() {
        println!("[lucid] set_close_guard({enabled}) from {}", window.label());
    }
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .set(window.label(), enabled);
    Ok(())
}

/// Close the calling window without asking again. `destroy` skips
/// CloseRequested entirely; Tauri exits the app when the last window goes.
#[tauri::command]
pub fn confirm_close<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, CloseGuardState>,
) -> Result<(), String> {
    if let Ok(mut g) = state.0.lock() {
        g.forget(window.label());
    }
    window.destroy().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unguarded_windows_close() {
        let mut g = CloseGuards::default();
        assert_eq!(
            g.on_close_requested("main", Instant::now()),
            CloseDecision::Allow
        );
        g.set("main", false);
        assert_eq!(
            g.on_close_requested("main", Instant::now()),
            CloseDecision::Allow
        );
    }

    #[test]
    fn guarded_window_asks_and_acknowledged_requests_never_force_close() {
        let mut g = CloseGuards::default();
        let t0 = Instant::now();
        g.set("main", true);
        assert_eq!(
            g.on_close_requested("main", t0),
            CloseDecision::PreventAndAsk
        );
        // Page acknowledges (user then picks Cancel).
        g.set("main", true);
        // Much later, the user closes again: still asks.
        let later = t0 + Duration::from_secs(60);
        assert_eq!(
            g.on_close_requested("main", later),
            CloseDecision::PreventAndAsk
        );
        // Other windows are independent.
        assert_eq!(g.on_close_requested("other", later), CloseDecision::Allow);
    }

    #[test]
    fn unacknowledged_request_forces_close_after_timeout() {
        let mut g = CloseGuards::default();
        let t0 = Instant::now();
        g.set("main", true);
        assert_eq!(
            g.on_close_requested("main", t0),
            CloseDecision::PreventAndAsk
        );
        // A quick second click re-asks (and does not restart the clock).
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(3)),
            CloseDecision::PreventAndAsk
        );
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(6)),
            CloseDecision::PreventAndAskHung
        );
        // While the native dialog is up, further closes are just swallowed.
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(7)),
            CloseDecision::Prevent
        );
        // "Wait": still unacknowledged, so the next close offers it again.
        g.hung_dialog_answered("main", false);
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(8)),
            CloseDecision::PreventAndAskHung
        );
        // "Close": the guard is dropped and the window may go.
        g.hung_dialog_answered("main", true);
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(9)),
            CloseDecision::Allow
        );
    }

    #[test]
    fn page_recovering_while_dialog_is_up_resets_the_clock() {
        let mut g = CloseGuards::default();
        let t0 = Instant::now();
        g.set("main", true);
        g.on_close_requested("main", t0);
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(6)),
            CloseDecision::PreventAndAskHung
        );
        g.hung_dialog_answered("main", false);
        g.set("main", true); // the page acknowledges after all
        assert!(g.is_enabled("main"));
        assert_eq!(
            g.on_close_requested("main", t0 + Duration::from_secs(60)),
            CloseDecision::PreventAndAsk
        );
    }

    #[test]
    fn forget_drops_state() {
        let mut g = CloseGuards::default();
        g.set("main", true);
        g.forget("main");
        assert_eq!(
            g.on_close_requested("main", Instant::now()),
            CloseDecision::Allow
        );
    }
}
