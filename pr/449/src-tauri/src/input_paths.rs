//! Learn the DISK PATHS of files the user picks through the page's own
//! `<input type=file>` dialogs.
//!
//! Why: LUCID opens sessions and projects through file inputs, which hand the
//! page `File` objects (disk-backed, what h5wasm and the video decoder need)
//! but never their paths. Native tools such as sleap-nn need paths. The webview
//! itself shows the native dialog, and Tauri has no hook to learn its answer.
//!
//! macOS: wry shows that dialog in ONE Objective-C method of its WKWebView UI
//! delegate, `webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:`.
//! `install` takes that delegate's class from the live webview (its runtime
//! name embeds wry's version) and swaps that method's body for `run_open_panel` below, which does
//! exactly what wry's does (an `NSOpenPanel` with the same options, the chosen
//! URLs handed to WebKit) and ALSO records the chosen paths and grants them
//! (the user picked them in a native dialog, the same rule as every grant in
//! `files.rs`). If wry ever drops or renames the method, `install` finds
//! nothing, logs it and changes nothing: the page keeps working and the
//! Inference panel falls back to its Choose folder button.
//!
//! Windows (WebView2 runs Chromium's own picker) and Linux (WebKitGTK) are not
//! covered yet: `input_picks` answers `supported: false` there.

use serde::Serialize;
use std::sync::Mutex;

/// How many recent picks are kept (each is one dialog's answer).
const MAX_PICKS: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputPick {
    /// Absolute paths the user chose in one dialog.
    pub paths: Vec<String>,
    /// The dialog allowed folders (a `webkitdirectory` input).
    pub directories: bool,
    /// Order of the pick in this run (1, 2, …).
    pub seq: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPicks {
    pub supported: bool,
    pub picks: Vec<InputPick>,
}

#[derive(Default)]
pub struct PickLog {
    picks: Mutex<Vec<InputPick>>,
    seq: Mutex<u64>,
}

impl PickLog {
    pub fn record(&self, paths: Vec<String>, directories: bool) {
        if paths.is_empty() {
            return;
        }
        let seq = {
            let mut s = self.seq.lock().unwrap_or_else(|e| e.into_inner());
            *s += 1;
            *s
        };
        let mut p = self.picks.lock().unwrap_or_else(|e| e.into_inner());
        p.push(InputPick { paths, directories, seq });
        let excess = p.len().saturating_sub(MAX_PICKS);
        p.drain(..excess);
    }

    pub fn snapshot(&self) -> Vec<InputPick> {
        self.picks.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Process-wide log: the Objective-C callback has no Tauri state to reach.
pub fn log() -> &'static PickLog {
    static LOG: std::sync::OnceLock<PickLog> = std::sync::OnceLock::new();
    LOG.get_or_init(PickLog::default)
}

/// The paths picked through the page's file inputs this run (newest last),
/// and whether this platform records them at all.
#[tauri::command]
pub fn input_picks() -> InputPicks {
    InputPicks {
        supported: cfg!(target_os = "macos") && installed(),
        picks: log().snapshot(),
    }
}

fn installed() -> bool {
    INSTALLED.load(std::sync::atomic::Ordering::Relaxed)
}
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
mod mac {
    use super::{log, INSTALLED};
    use crate::files::GrantState;
    use block2::Block;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use std::ffi::CStr;
    use std::sync::{Arc, OnceLock};

    static GRANTS: OnceLock<Arc<GrantState>> = OnceLock::new();

    /// NSModalResponseOK.
    const MODAL_OK: isize = 1;

    unsafe fn url_paths(urls: *mut AnyObject) -> Vec<String> {
        let mut out = Vec::new();
        if urls.is_null() {
            return out;
        }
        let n: usize = msg_send![urls, count];
        for i in 0..n {
            let url: *mut AnyObject = msg_send![urls, objectAtIndex: i];
            if url.is_null() {
                continue;
            }
            let path: *mut AnyObject = msg_send![url, path];
            if path.is_null() {
                continue;
            }
            let c: *const std::ffi::c_char = msg_send![path, UTF8String];
            if !c.is_null() {
                out.push(CStr::from_ptr(c).to_string_lossy().into_owned());
            }
        }
        out
    }

    /// Replacement body: wry's own steps, plus record + grant.
    unsafe extern "C-unwind" fn run_open_panel(
        _this: *mut AnyObject,
        _cmd: Sel,
        _webview: *mut AnyObject,
        params: *mut AnyObject,
        _frame: *mut AnyObject,
        handler: *mut Block<dyn Fn(*const AnyObject)>,
    ) {
        let Some(cls) = AnyClass::get(c"NSOpenPanel") else {
            if !handler.is_null() {
                (*handler).call((std::ptr::null(),));
            }
            return;
        };
        let panel: *mut AnyObject = msg_send![cls, openPanel];
        let multi: Bool = msg_send![params, allowsMultipleSelection];
        let dirs: Bool = msg_send![params, allowsDirectories];
        let _: () = msg_send![panel, setCanChooseFiles: Bool::YES];
        let _: () = msg_send![panel, setAllowsMultipleSelection: multi];
        let _: () = msg_send![panel, setCanChooseDirectories: dirs];
        let resp: isize = msg_send![panel, runModal];
        if resp == MODAL_OK {
            let urls: *mut AnyObject = msg_send![panel, URLs];
            let paths = url_paths(urls);
            if let Some(g) = GRANTS.get() {
                if let Ok(mut grants) = g.0.lock() {
                    for p in &paths {
                        let path = std::path::Path::new(p);
                        if path.is_dir() {
                            grants.grant_dir(path);
                        } else {
                            grants.grant_file(path);
                        }
                    }
                }
            }
            log().record(paths, dirs.as_bool());
            if !handler.is_null() {
                (*handler).call((urls as *const AnyObject,));
            }
        } else if !handler.is_null() {
            (*handler).call((std::ptr::null(),));
        }
    }

    /// Patch the class of `wk_webview`'s UI delegate (wry's). The class is
    /// taken from the live object, not looked up by name: wry's runtime class
    /// name embeds its version (`wry::…::WryWebViewUIDelegate0.55.1`).
    ///
    /// # Safety
    /// `wk_webview` must be a live `WKWebView*`; call on the main thread.
    pub unsafe fn install(grants: Arc<GrantState>, wk_webview: *mut AnyObject) {
        let _ = GRANTS.set(grants);
        if INSTALLED.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        if wk_webview.is_null() {
            eprintln!("[lucid] input-path capture: no webview; not installed");
            return;
        }
        let delegate: *mut AnyObject = msg_send![wk_webview, UIDelegate];
        if delegate.is_null() {
            eprintln!("[lucid] input-path capture: the webview has no UI delegate; not installed");
            return;
        }
        let cls: &AnyClass = (*delegate).class();
        let sel = sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
        let Some(method) = cls.instance_method(sel) else {
            eprintln!(
                "[lucid] input-path capture: {} has no open-panel method; not installed",
                cls.name().to_string_lossy()
            );
            return;
        };
        // SAFETY: same selector and argument types as wry's implementation
        // (object, SEL, WKWebView*, WKOpenPanelParameters*, WKFrameInfo*,
        // void (^)(NSArray<NSURL*>*)), returning void.
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(
                *mut AnyObject,
                Sel,
                *mut AnyObject,
                *mut AnyObject,
                *mut AnyObject,
                *mut Block<dyn Fn(*const AnyObject)>,
            ),
            Imp,
        >(run_open_panel);
        method.set_implementation(imp);
        INSTALLED.store(true, std::sync::atomic::Ordering::Relaxed);
        println!(
            "[lucid] input-path capture installed on {} (file inputs report their paths)",
            cls.name().to_string_lossy()
        );
    }
}

/// Start recording input picks for `window`'s webview (macOS); a no-op elsewhere.
#[allow(unused_variables)]
pub fn install<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    grants: std::sync::Arc<crate::files::GrantState>,
) {
    #[cfg(target_os = "macos")]
    {
        let r = window.with_webview(move |pv| {
            // SAFETY: `inner()` is the live WKWebView; with_webview runs on the main thread.
            unsafe { mac::install(grants, pv.inner() as *mut objc2::runtime::AnyObject) }
        });
        if let Err(e) = r {
            eprintln!("[lucid] input-path capture: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_keeps_the_newest_picks_in_order() {
        let l = PickLog::default();
        l.record(vec![], true);
        assert!(l.snapshot().is_empty(), "an empty answer is not a pick");
        for i in 0..(MAX_PICKS + 3) {
            l.record(vec![format!("/p/{i}")], i % 2 == 0);
        }
        let s = l.snapshot();
        assert_eq!(s.len(), MAX_PICKS);
        assert_eq!(s[0].paths, vec!["/p/3".to_string()]);
        assert_eq!(s.last().unwrap().seq, (MAX_PICKS + 3) as u64);
        assert!(s.windows(2).all(|w| w[0].seq < w[1].seq));
    }

    #[test]
    fn json_is_camel_case() {
        let v = serde_json::to_value(InputPicks {
            supported: true,
            picks: vec![InputPick { paths: vec!["/a".into()], directories: true, seq: 1 }],
        })
        .unwrap();
        assert_eq!(v["picks"][0]["directories"], true);
        assert_eq!(v["supported"], true);
    }
}
