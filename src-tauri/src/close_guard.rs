//! Unsaved-changes close guard.
//!
//! A webview's own `beforeunload` prompt does not fire when the native window
//! is closed, so the JS shim opts in with `set_close_guard({enabled: true})`.
//! While enabled, a close request is cancelled and `lucid://close-requested`
//! is emitted to that window; the page decides and calls `confirm_close` to
//! really close.
//!
//! Escape hatch for a hung page: the shim acknowledges each request at once
//! (any `set_close_guard` call counts). If a request is still unacknowledged
//! and the user asks to close again more than `HUNG_AFTER` later, the window
//! closes anyway. A user who answered "Cancel" is not affected: their request
//! was acknowledged, so the next close asks again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, Runtime, WebviewWindow, Window, WindowEvent};

pub const CLOSE_REQUESTED_EVENT: &str = "lucid://close-requested";
pub const HUNG_AFTER: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// No guard: let the window close.
    Allow,
    /// Guarded: cancel the close and ask the page.
    PreventAndAsk,
    /// Guarded, but the page never acknowledged an earlier request: close.
    AllowHung,
}

#[derive(Default, Debug)]
struct WindowGuard {
    enabled: bool,
    /// Time of the oldest close request the page has not acknowledged.
    pending_since: Option<Instant>,
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
        match g.pending_since {
            Some(t) if now.saturating_duration_since(t) > HUNG_AFTER => CloseDecision::AllowHung,
            Some(_) => CloseDecision::PreventAndAsk,
            None => {
                g.pending_since = Some(now);
                CloseDecision::PreventAndAsk
            }
        }
    }

    pub fn forget(&mut self, label: &str) {
        self.0.remove(label);
    }
}

#[derive(Default)]
pub struct CloseGuardState(pub Mutex<CloseGuards>);

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
                CloseDecision::AllowHung => {
                    eprintln!("[lucid] close guard: page did not answer, closing anyway");
                }
                CloseDecision::PreventAndAsk => {
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), CLOSE_REQUESTED_EVENT, ());
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

#[tauri::command]
pub fn set_close_guard<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, CloseGuardState>,
    enabled: bool,
) -> Result<(), String> {
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
            CloseDecision::AllowHung
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
