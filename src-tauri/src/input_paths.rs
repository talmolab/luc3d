//! Learn the DISK PATHS of files the user picks through the page's own
//! `<input type=file>` dialogs.
//!
//! Why: LUCID opens sessions and projects through file inputs, which hand the
//! page `File` objects (disk-backed, what h5wasm and the video decoder need)
//! but never their paths. Native tools such as sleap-nn need paths. The webview
//! itself shows the native dialog, and Tauri has no hook to learn its answer.
//! Every path learned here is GRANTED (the user chose it in a native dialog,
//! the same rule as every grant in `files.rs`) and, for dialogs, RECORDED in
//! the pick log that `input_picks` reports; the shim's
//! `lucidDesktop.fs.pathOfFile(file)` maps a File to its path from that.
//!
//! macOS: wry shows that dialog in ONE Objective-C method of its WKWebView UI
//! delegate, `webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:`.
//! `install` takes that delegate's class from the live webview (its runtime
//! name embeds wry's version) and swaps that method's body for `run_open_panel` below, which does
//! exactly what wry's does (an `NSOpenPanel` with the same options, the chosen
//! URLs handed to WebKit) and ALSO records the chosen paths and grants them.
//! If wry ever drops or renames the method, `install` finds
//! nothing, logs it and changes nothing: the page keeps working and the
//! Inference panel falls back to its Choose folder button.
//!
//! Linux (WebKitGTK): the webview's `run-file-chooser` signal (wry connects
//! none, so WebKitGTK's default runs: a files-only "Select File" dialog, even
//! for a `webkitdirectory` input). `gtk_chooser` handles it instead: it shows
//! the native chooser itself (a FOLDER chooser for a folder input), records +
//! grants the answer and hands the paths to WebKit with `select_files`, which
//! makes the same disk-backed Files (for a folder: every file in it, with
//! `webkitRelativePath` = `<folder>/<sub>/<file>`, as on macOS). WebKitGTK's
//! request does not say whether the input is a folder input, so the shim
//! leaves a one-shot hint on each file-input click (`__lucidTakeFileInputHint`,
//! shim §7b) that the handler reads first.
//!
//! Windows (WebView2): Chromium's own picker, with no hook at all (WebView2
//! has no file-chooser event). Instead WebView2 can hand the host a real DOM
//! `File` or `FileSystemHandle` that the page posts with
//! `chrome.webview.postMessageWithAdditionalObjects`, as `ICoreWebView2File` /
//! `ICoreWebView2FileSystemHandle`, which carry the disk path. `webview2`
//! answers such a post (`{lucidPathOf: id}`) with the paths, granting them.
//! A page cannot make a disk-backed File or handle for a path the user did not
//! give it, so this is still "the user picked it". Folders picked with
//! `showDirectoryPicker` (LUCID's read-side folder picker on Windows, which has
//! the File System Access API) are posted by the shim right after the pick and
//! recorded as folder picks; a File's answer carries the newest recorded
//! folder holding it as its `root` (where predictions are written).

use serde::Serialize;
use std::sync::Mutex;

/// How many recent picks are kept (each is one dialog's answer).
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", windows)),
    allow(dead_code)
)] // only the platform captures record
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
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "linux", windows)),
        allow(dead_code)
    )] // only the platform captures record
    seq: Mutex<u64>,
}

impl PickLog {
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "linux", windows)),
        allow(dead_code)
    )] // only the platform captures record
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
        p.push(InputPick {
            paths,
            directories,
            seq,
        });
        let excess = p.len().saturating_sub(MAX_PICKS);
        p.drain(..excess);
    }

    pub fn snapshot(&self) -> Vec<InputPick> {
        self.picks.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Process-wide log: the native callbacks have no Tauri state to reach.
pub fn log() -> &'static PickLog {
    static LOG: std::sync::OnceLock<PickLog> = std::sync::OnceLock::new();
    LOG.get_or_init(PickLog::default)
}

/// The paths picked through the page's file inputs this run (newest last),
/// and whether this platform records them at all.
#[tauri::command]
pub fn input_picks() -> InputPicks {
    InputPicks {
        supported: cfg!(any(target_os = "macos", target_os = "linux", windows)) && installed(),
        picks: log().snapshot(),
    }
}

fn installed() -> bool {
    INSTALLED.load(std::sync::atomic::Ordering::Relaxed)
}
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Grant every path of one dialog's answer and record it as one pick.
///
/// The paths are recorded AS PICKED (the shim matches a File by its name, and
/// a picked symlink keeps its own name), while the grants resolve them
/// (`Grants::grant_*`), so a link inside a picked folder still cannot reach
/// outside it.
#[cfg(any(target_os = "linux", windows, test))]
fn grant_and_record(
    grants: &crate::files::GrantState,
    log: &PickLog,
    paths: Vec<String>,
    directories: bool,
) {
    if paths.is_empty() {
        return;
    }
    grant_all(grants, &paths);
    log.record(paths, directories);
}

/// Grant each path: a folder as a folder, anything else as a file.
#[cfg(any(target_os = "linux", windows, test))]
fn grant_all(grants: &crate::files::GrantState, paths: &[String]) {
    let mut g = grants.0.lock().unwrap_or_else(|e| e.into_inner());
    for p in paths {
        let path = std::path::Path::new(p);
        if path.is_dir() {
            g.grant_dir(path);
        } else {
            g.grant_file(path);
        }
    }
}

/// What the shim's hint says about the file input that opened the chooser
/// (Linux): whether it is a folder input. (Single vs multiple comes from
/// WebKit's own request.)
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default, PartialEq, serde::Deserialize)]
struct ChooserHint {
    #[serde(default)]
    dir: bool,
}

/// The hint as `__lucidTakeFileInputHint()` returns it (a JSON string, or
/// `null` when no fresh hint is there): anything unreadable means "a plain
/// file input".
#[cfg(any(target_os = "linux", test))]
fn parse_hint(json: &str) -> ChooserHint {
    serde_json::from_str::<Option<ChooserHint>>(json)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// One path learned from a posted File / handle (Windows).
#[cfg(any(windows, test))]
#[derive(Debug, Serialize, PartialEq)]
struct PathItem {
    path: String,
    /// "file" or "directory".
    kind: &'static str,
}

/// The request id of a `{lucidPathOf: "<id>"}` web message, or None for any
/// other message (those belong to wry / Tauri).
#[cfg(any(windows, test))]
fn path_request_id(json: &str) -> Option<String> {
    // wry's IPC messages are JSON strings (`"…"`, possibly large): never parsed here.
    if !json.trim_start().starts_with('{') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = v.get("lucidPathOf")?.as_str()?;
    let ok = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| id.to_string())
}

/// The newest picked FOLDER that holds `file`, as it was picked. Both sides
/// are resolved first, so letter case (Windows) and symlinks do not matter.
#[cfg(any(windows, test))]
fn root_for(picks: &[InputPick], file: &std::path::Path) -> Option<String> {
    use crate::files::resolve_path;
    let real = resolve_path(file).ok()?;
    picks
        .iter()
        .rev()
        .filter(|p| p.directories)
        .flat_map(|p| p.paths.iter())
        .find(|d| {
            resolve_path(std::path::Path::new(d))
                .map(|r| real != r && real.starts_with(&r))
                .unwrap_or(false)
        })
        .cloned()
}

/// Answer one `{lucidPathOf: id}` post (Windows): `found` holds the paths of
/// the posted objects (`true` = a folder handle). Each one that exists as
/// that kind is granted; folders are also recorded as a folder pick (files are
/// not: every pathOfFile lookup posts one, and they would push the folder
/// picks out of the log). The reply's `root` is the newest picked folder
/// holding the first file.
#[cfg(any(windows, test))]
fn answer_path_request(
    grants: &crate::files::GrantState,
    log: &PickLog,
    id: &str,
    found: Vec<(String, bool)>,
) -> String {
    let mut items = Vec::new();
    let (mut dirs, mut files) = (Vec::new(), Vec::new());
    for (p, is_dir) in found {
        let path = std::path::Path::new(&p);
        if !path.is_absolute() {
            continue;
        }
        if is_dir && path.is_dir() {
            dirs.push(p.clone());
            items.push(PathItem {
                path: p,
                kind: "directory",
            });
        } else if !is_dir && path.is_file() {
            files.push(p.clone());
            items.push(PathItem {
                path: p,
                kind: "file",
            });
        }
    }
    grant_and_record(grants, log, dirs, true);
    grant_all(grants, &files);
    let root = items
        .iter()
        .find(|i| i.kind == "file")
        .and_then(|i| root_for(&log.snapshot(), std::path::Path::new(&i.path)));
    serde_json::json!({ "lucidPathOfReply": id, "items": items, "root": root }).to_string()
}

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

#[cfg(target_os = "linux")]
mod gtk_chooser {
    use super::{grant_and_record, log, parse_hint, ChooserHint, INSTALLED};
    use crate::files::GrantState;
    use gtk::prelude::*;
    use javascriptcore::ValueExt;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use webkit2gtk::{FileChooserRequest, FileChooserRequestExt, WebView, WebViewExt};

    /// Reads (and clears) the shim's hint about the input that was clicked.
    const TAKE_HINT_JS: &str = "(typeof window.__lucidTakeFileInputHint === 'function') \
        ? window.__lucidTakeFileInputHint() : 'null'";

    /// Handle `webview`'s `run-file-chooser` from now on. Main thread (GTK).
    pub fn install(grants: Arc<GrantState>, webview: &WebView) {
        if INSTALLED.swap(true, Ordering::Relaxed) {
            return;
        }
        webview.connect_run_file_chooser(move |wv, req| {
            let grants = Arc::clone(&grants);
            let req = req.clone();
            let view = wv.clone();
            // Ask the page which input this is, THEN show the chooser. WebKit
            // waits for the request's answer (select_files / cancel), and the
            // hint was set synchronously in the click that opened it.
            wv.evaluate_javascript(
                TAKE_HINT_JS,
                None,
                None,
                None::<&gtk::gio::Cancellable>,
                move |r| {
                    let hint = r.map(|v| parse_hint(&v.to_str())).unwrap_or_default();
                    show_chooser(&view, req, hint, grants);
                },
            );
            true // handled: WebKitGTK's own files-only dialog does not open
        });
        println!("[lucid] input-path capture installed (WebKitGTK file chooser)");
    }

    fn show_chooser(
        view: &WebView,
        req: FileChooserRequest,
        hint: ChooserHint,
        grants: Arc<GrantState>,
    ) {
        let dir = hint.dir;
        let multi = req.selects_multiple();
        let (action, title) = match (dir, multi) {
            (true, true) => (gtk::FileChooserAction::SelectFolder, "Select Folders"),
            (true, false) => (gtk::FileChooserAction::SelectFolder, "Select Folder"),
            (false, true) => (gtk::FileChooserAction::Open, "Select Files"),
            (false, false) => (gtk::FileChooserAction::Open, "Select File"),
        };
        let parent = view
            .toplevel()
            .and_then(|w| w.downcast::<gtk::Window>().ok());
        let dialog = gtk::FileChooserNative::new(Some(title), parent.as_ref(), action, None, None);
        dialog.set_modal(true);
        dialog.set_select_multiple(multi);
        if !dir {
            // WebKit's filter keeps only the MIME types of `accept` (it drops
            // extensions such as `.json`), so "All files" is always offered too.
            if let Some(filter) = req.mime_types_filter() {
                dialog.add_filter(filter);
            }
            let all = gtk::FileFilter::new();
            all.set_name(Some("All files"));
            all.add_pattern("*");
            dialog.add_filter(all);
        }
        if let Some(first) = req.selected_files().first() {
            let _ = dialog.set_filename(first.as_str());
        }
        // A FileChooserNative is not a widget: nothing else holds it, so keep
        // it alive until it answers (the response handler lets go).
        let keep: Rc<RefCell<Option<gtk::FileChooserNative>>> = Rc::new(RefCell::new(None));
        let release = Rc::clone(&keep);
        dialog.connect_response(move |d, resp| {
            let paths: Vec<String> = if resp == gtk::ResponseType::Accept {
                d.filenames()
                    .into_iter()
                    // select_files takes UTF-8; a non-UTF-8 name cannot be passed on
                    .filter_map(|p| p.into_os_string().into_string().ok())
                    .collect()
            } else {
                Vec::new()
            };
            if paths.is_empty() {
                req.cancel();
            } else {
                // Grant BEFORE the page gets the Files, so it can stat them at once.
                grant_and_record(&grants, log(), paths.clone(), dir);
                let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
                req.select_files(&refs);
            }
            release.borrow_mut().take();
        });
        *keep.borrow_mut() = Some(dialog.clone());
        dialog.show();
    }
}

#[cfg(windows)]
mod webview2 {
    use super::{answer_path_request, log, path_request_id, INSTALLED};
    use crate::files::GrantState;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2File, ICoreWebView2FileSystemHandle,
        ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventArgs2,
        COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND, COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_DIRECTORY,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, HSTRING, PWSTR};

    /// At most this many objects are read from one post.
    const MAX_OBJECTS: u32 = 64;

    /// Answer `{lucidPathOf}` posts from now on. A second handler next to
    /// wry's: wry's skips them (they are not strings: its
    /// `TryGetWebMessageAsString` fails, so Tauri never sees them).
    ///
    /// # Safety
    /// `webview` must be the live ICoreWebView2; call on its UI thread.
    pub unsafe fn install(
        grants: Arc<GrantState>,
        webview: &ICoreWebView2,
    ) -> windows_core::Result<()> {
        if INSTALLED.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut token = 0i64;
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                if let (Some(sender), Some(args)) = (sender, args) {
                    on_message(&grants, &sender, &args);
                }
                Ok(())
            })),
            &mut token,
        )?;
        INSTALLED.store(true, Ordering::Relaxed);
        println!("[lucid] input-path capture installed (WebView2 posted Files)");
        Ok(())
    }

    fn on_message(
        grants: &GrantState,
        sender: &ICoreWebView2,
        args: &ICoreWebView2WebMessageReceivedEventArgs,
    ) {
        // SAFETY: COM calls on live interfaces handed to this event, on the UI
        // thread that raised it; every PWSTR is taken (and freed) once.
        unsafe {
            let mut json = PWSTR::null();
            if args.WebMessageAsJson(&mut json).is_err() {
                return;
            }
            let Some(id) = path_request_id(&take_pwstr(json)) else {
                return;
            };
            let mut found = Vec::new();
            if let Ok(objects) = args
                .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                .and_then(|a| a.AdditionalObjects())
            {
                let mut n = 0u32;
                let _ = objects.Count(&mut n);
                for i in 0..n.min(MAX_OBJECTS) {
                    let Ok(obj) = objects.GetValueAtIndex(i) else {
                        continue;
                    };
                    if let Ok(file) = obj.cast::<ICoreWebView2File>() {
                        let mut p = PWSTR::null();
                        if file.Path(&mut p).is_ok() {
                            found.push((take_pwstr(p), false));
                        }
                    } else if let Ok(handle) = obj.cast::<ICoreWebView2FileSystemHandle>() {
                        let mut kind = COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND::default();
                        let mut p = PWSTR::null();
                        if handle.Kind(&mut kind).is_ok() && handle.Path(&mut p).is_ok() {
                            let is_dir = kind == COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_DIRECTORY;
                            found.push((take_pwstr(p), is_dir));
                        }
                    }
                }
            }
            let reply = answer_path_request(grants, log(), &id, found);
            if let Err(e) = sender.PostWebMessageAsJson(&HSTRING::from(reply)) {
                eprintln!("[lucid] input-path capture: reply failed: {e}");
            }
        }
    }
}

/// Start learning input paths for `window`'s webview (macOS, Linux, Windows).
#[allow(unused_variables)]
pub fn install<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    grants: std::sync::Arc<crate::files::GrantState>,
) {
    #[cfg(target_os = "macos")]
    let r = window.with_webview(move |pv| {
        // SAFETY: `inner()` is the live WKWebView; with_webview runs on the main thread.
        unsafe { mac::install(grants, pv.inner() as *mut objc2::runtime::AnyObject) }
    });
    #[cfg(target_os = "linux")]
    let r = window.with_webview(move |pv| {
        // with_webview runs on the GTK main thread.
        gtk_chooser::install(grants, &pv.inner())
    });
    #[cfg(windows)]
    let r = window.with_webview(move |pv| {
        // SAFETY: the controller's live webview; with_webview runs on its UI thread.
        let res = unsafe {
            pv.controller()
                .CoreWebView2()
                .and_then(|wv| webview2::install(grants, &wv))
        };
        if let Err(e) = res {
            eprintln!("[lucid] input-path capture: {e}");
        }
    });
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    if let Err(e) = r {
        eprintln!("[lucid] input-path capture: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{resolve_path, GrantState};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "lucid-input-paths-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(p: &std::path::Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn granted(g: &GrantState, p: &std::path::Path) -> bool {
        g.0.lock().unwrap().is_granted(&resolve_path(p).unwrap())
    }

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
            picks: vec![InputPick {
                paths: vec!["/a".into()],
                directories: true,
                seq: 1,
            }],
        })
        .unwrap();
        assert_eq!(v["picks"][0]["directories"], true);
        assert_eq!(v["supported"], true);
    }

    #[test]
    fn a_picked_folder_is_granted_and_recorded_as_picked() {
        let d = temp_dir("folder");
        let sess = d.join("Sess");
        std::fs::create_dir_all(sess.join("cam1")).unwrap();
        std::fs::write(sess.join("cam1").join("v.mp4"), b"abc").unwrap();
        let (g, l) = (GrantState::default(), PickLog::default());
        grant_and_record(&g, &l, vec![s(&sess)], true);
        assert!(granted(&g, &sess.join("cam1").join("v.mp4")));
        assert!(
            granted(&g, &sess.join("predictions")),
            "a folder still to be made inside"
        );
        assert!(!granted(&g, &d.join("other.mp4")));
        let picks = l.snapshot();
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].paths, vec![s(&sess)]);
        assert!(picks[0].directories);
        // Cancel / nothing chosen: no grant, no pick.
        grant_and_record(&g, &l, vec![], false);
        assert_eq!(l.snapshot().len(), 1);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn several_picked_files_are_one_pick() {
        let d = temp_dir("files");
        let (a, b) = (d.join("a.slp"), d.join("b.mp4"));
        std::fs::write(&a, b"1").unwrap();
        std::fs::write(&b, b"22").unwrap();
        let (g, l) = (GrantState::default(), PickLog::default());
        grant_and_record(&g, &l, vec![s(&a), s(&b)], false);
        assert!(granted(&g, &a) && granted(&g, &b));
        assert!(
            !granted(&g, &d.join("c.mp4")),
            "a file pick grants only the files"
        );
        assert_eq!(l.snapshot()[0].paths.len(), 2);
        std::fs::remove_dir_all(&d).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_picked_symlink_is_recorded_by_its_name_and_granted_where_it_points() {
        let d = temp_dir("link");
        let real = d.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("v.mp4"), b"x").unwrap();
        let link = d.join("Session");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // A link inside the picked folder that points OUTSIDE it.
        let outside = temp_dir("outside");
        std::fs::write(outside.join("secret"), b"s").unwrap();
        std::os::unix::fs::symlink(&outside, real.join("escape")).unwrap();
        let (g, l) = (GrantState::default(), PickLog::default());
        grant_and_record(&g, &l, vec![s(&link)], true);
        assert_eq!(l.snapshot()[0].paths, vec![s(&link)], "recorded as picked");
        assert!(granted(&g, &link.join("v.mp4")));
        assert!(granted(&g, &real.join("v.mp4")));
        assert!(
            !granted(&g, &link.join("escape").join("secret")),
            "a link inside the picked folder cannot reach outside it"
        );
        std::fs::remove_dir_all(&d).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn hints_default_to_a_plain_file_input() {
        assert_eq!(
            parse_hint(r#"{"dir":true,"multiple":false}"#),
            ChooserHint { dir: true }
        );
        assert!(parse_hint(r#"{"dir":true}"#).dir);
        for junk in ["null", "", "undefined", "42", "{\"dir\":\"yes\"}", "[1]"] {
            assert_eq!(parse_hint(junk), ChooserHint::default(), "{junk:?}");
        }
    }

    #[test]
    fn only_lucid_path_requests_with_safe_ids_are_answered() {
        assert_eq!(
            path_request_id(r#"{"lucidPathOf":"p-1_a"}"#),
            Some("p-1_a".into())
        );
        for other in [
            r#""a string""#,
            r#"{"cmd":"x"}"#,
            r#"{"lucidPathOf":""}"#,
            r#"{"lucidPathOf":"a b"}"#,
            r#"{"lucidPathOf":"<x>"}"#,
            r#"{"lucidPathOf":7}"#,
            "not json",
        ] {
            assert_eq!(path_request_id(other), None, "{other}");
        }
        let long = format!(r#"{{"lucidPathOf":"{}"}}"#, "a".repeat(65));
        assert_eq!(path_request_id(&long), None);
    }

    #[test]
    fn a_posted_file_gets_its_path_and_the_newest_folder_holding_it() {
        let d = temp_dir("posted");
        let sess = d.join("Sess");
        let other = d.join("Other");
        std::fs::create_dir_all(sess.join("cam1")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let video = sess.join("cam1").join("v.mp4");
        std::fs::write(&video, b"abc").unwrap();
        let (g, l) = (GrantState::default(), PickLog::default());

        // The shim posts the folder picked with showDirectoryPicker…
        let r: serde_json::Value =
            serde_json::from_str(&answer_path_request(&g, &l, "d1", vec![(s(&sess), true)]))
                .unwrap();
        assert_eq!(r["lucidPathOfReply"], "d1");
        assert_eq!(r["items"][0]["kind"], "directory");
        assert!(r["root"].is_null(), "no file asked for");
        assert!(granted(&g, &sess.join("predictions")));
        // …a later, unrelated folder pick does not hold the video…
        answer_path_request(&g, &l, "d2", vec![(s(&other), true)]);
        assert_eq!(l.snapshot().len(), 2);

        // …then pathOfFile posts the video's File.
        let r: serde_json::Value =
            serde_json::from_str(&answer_path_request(&g, &l, "f1", vec![(s(&video), false)]))
                .unwrap();
        assert_eq!(r["items"][0]["path"], s(&video));
        assert_eq!(r["items"][0]["kind"], "file");
        assert_eq!(r["root"], s(&sess));
        assert_eq!(
            l.snapshot().len(),
            2,
            "file lookups are not recorded as picks"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn posted_objects_must_exist_as_what_they_claim() {
        let d = temp_dir("claims");
        let f = d.join("f.mp4");
        std::fs::write(&f, b"x").unwrap();
        let (g, l) = (GrantState::default(), PickLog::default());
        let r: serde_json::Value = serde_json::from_str(&answer_path_request(
            &g,
            &l,
            "x",
            vec![
                (s(&d.join("missing.mp4")), false), // gone
                (s(&f), true),                      // a file posing as a folder
                (s(&d), false),                     // a folder posing as a file
                ("relative.mp4".into(), false),     // not absolute
                (String::new(), false),             // a memory-backed File has no path
            ],
        ))
        .unwrap();
        assert_eq!(r["items"].as_array().unwrap().len(), 0);
        assert!(!granted(&g, &f) && !granted(&g, &d.join("x")));
        assert!(l.snapshot().is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn root_needs_a_folder_pick_strictly_above_the_file() {
        let d = temp_dir("root");
        let sess = d.join("Sess");
        std::fs::create_dir_all(&sess).unwrap();
        let v = sess.join("v.mp4");
        std::fs::write(&v, b"x").unwrap();
        let pick = |paths: Vec<String>, directories: bool, seq: u64| InputPick {
            paths,
            directories,
            seq,
        };
        // A FILE pick of the folder's path does not count; nor does a sibling
        // whose name merely starts the same ("Sess" vs "Sess2").
        let sib = d.join("Sess2");
        std::fs::create_dir_all(&sib).unwrap();
        let picks = vec![pick(vec![s(&sess)], false, 1), pick(vec![s(&sib)], true, 2)];
        assert_eq!(root_for(&picks, &v), None);
        let picks = vec![pick(vec![s(&d)], true, 1), pick(vec![s(&sess)], true, 2)];
        assert_eq!(root_for(&picks, &v), Some(s(&sess)), "the newest wins");
        assert_eq!(
            root_for(&picks, &sess),
            Some(s(&d)),
            "never the folder itself"
        );
        std::fs::remove_dir_all(&d).ok();
    }
}
