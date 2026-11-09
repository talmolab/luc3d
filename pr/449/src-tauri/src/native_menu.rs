//! The macOS menu bar, carrying LUCID's own menus.
//!
//! The JS shim (`js/lucid-desktop.js`) reads the page's in-page menu bar
//! (`#menuBar`: File, Edit, Calibrate, Tracks, View, Hot Keys, Help) into a
//! JSON spec and sends it with `set_app_menu`, again whenever it changes. This
//! module turns the spec into the native bar
//!
//!   luc3d | <page menus…> | Window | Help
//!
//! with the page's Edit menu merged with the native text-editing items, and
//! routes a click on a page item back to the page, which clicks the same
//! element a user would have clicked.
//!
//! **Clicks reach the page by `evaluateJavaScript:`** (`WebviewWindow::eval`),
//! not by an event: WKWebView runs that call with a forced user gesture
//! (WebKit `WKWebView.mm`: `evaluateJavaScript:completionHandler:` passes
//! `forceUserGesture:YES`), so the item the shim clicks synchronously inside
//! it has transient activation, which `<input type=file>` needs to open its
//! panel (`FileInputType::handleDOMActivateEvent` consumes it). Apps linked
//! against the macOS 14+ SDK lose that activation when the script returns
//! (`EvaluateJavaScriptWithoutTransientActivation`), so a picker opened after
//! an `await` would be dropped: the shim catches that case and asks for one
//! more click in the page.
//!
//! **No page item gets a native accelerator**: LUCID's own keyboard handler
//! already handles every shortcut, and a key equivalent would fire twice or
//! steal the key. No Undo/Redo either (they would take Cmd+Z from the page).
//!
//! Updates are applied IN PLACE (text, enabled, checked) when the structure is
//! unchanged, which is the common case (a tick moving, an item enabling); the
//! bar is rebuilt only when items appear or disappear. That keeps a menu the
//! user has open from being swapped out from under them.
//!
//! The spec → model step (`build_model`) and the update plan (`plan_updates`)
//! are pure and unit-tested; `install` / `apply` only mirror a model into
//! Tauri menu objects. Everything compiles on every platform; only macOS
//! calls it (elsewhere `set_app_menu` answers `false` and the page keeps its
//! in-page menus).

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Runtime};

/// Id prefix of every item that came from the page: `lucid-page:<key>`.
pub const PAGE_ITEM_PREFIX: &str = "lucid-page:";
/// Our own Quit item (routes through the close guard; see close_guard.rs).
pub const QUIT_MENU_ID: &str = "lucid-quit";
/// The page function a click calls (defined, non-writable, by the shim).
pub const PAGE_ACTION_FN: &str = "__lucidNativeMenuAction";
/// luc3d ▸ Check for Updates… and the Update Channel items (updates.rs); a
/// click calls the shim's `window.__lucidUpdates.menu(<action>)`.
pub const UPDATE_ITEM_PREFIX: &str = "lucid-update:";
const UPDATE_CHECK_ID: &str = "lucid-update:check";
const UPDATE_CHANNELS_ID: &str = "lucid-update:channels";
const UPDATE_CHANNEL_PREFIX: &str = "lucid-update:channel:";
pub const UPDATES_FN: &str = "__lucidUpdates";
const APP_NAME: &str = "luc3d";
/// Deeper page submenus are cut off (a sane page has two levels).
const MAX_DEPTH: usize = 6;

// ---------------------------------------------------------------------------
// The spec the shim sends
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct PageMenu {
    pub label: String,
    pub items: Vec<PageItem>,
}

/// One entry of a page menu: `{separator: true}`, or an item. An item without
/// a `key` is a label only (a section heading): shown, never clickable.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct PageItem {
    pub separator: bool,
    pub key: Option<String>,
    pub label: String,
    pub enabled: bool,
    /// Some → a check item (LUCID's ✓ items: radio groups and toggles).
    pub checked: Option<bool>,
    pub submenu: Option<Vec<PageItem>>,
}

impl Default for PageItem {
    fn default() -> Self {
        PageItem {
            separator: false,
            key: None,
            label: String::new(),
            enabled: true,
            checked: None,
            submenu: None,
        }
    }
}

/// The build label the page shows beside Settings (`#menuBarVersion`): it
/// moves into About luc3d while the in-page bar is hidden.
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(default)]
pub struct AboutInfo {
    pub text: String,
    pub title: String,
}

// ---------------------------------------------------------------------------
// The model (what the native bar holds)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Native {
    About(Option<AboutInfo>),
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    CloseWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
    Check {
        id: String,
        text: String,
        enabled: bool,
        checked: bool,
    },
    Submenu {
        id: String,
        text: String,
        enabled: bool,
        children: Vec<Node>,
    },
    Separator,
    Native(Native),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    App,
    Page,
    Edit,
    Window,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopMenu {
    pub id: String,
    pub text: String,
    pub role: Role,
    pub children: Vec<Node>,
}

/// muda strips `&` as a mnemonic marker on macOS; `&&` shows one `&`
/// ("Group by Track & Triangulate All").
pub fn menu_text(label: &str) -> String {
    label.replace('&', "&&")
}

fn page_item_id(key: &str) -> String {
    format!("{PAGE_ITEM_PREFIX}{key}")
}

/// The page key of a native item id, if it is a page item.
pub fn page_key(id: &str) -> Option<&str> {
    id.strip_prefix(PAGE_ITEM_PREFIX).filter(|k| !k.is_empty())
}

/// Drop leading, trailing and repeated separators.
fn tidy_separators(nodes: Vec<Node>) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::with_capacity(nodes.len());
    for n in nodes {
        if n == Node::Separator && matches!(out.last(), None | Some(Node::Separator)) {
            continue;
        }
        out.push(n);
    }
    while out.last() == Some(&Node::Separator) {
        out.pop();
    }
    out
}

struct Ctx {
    seen: HashSet<String>,
    inert: usize,
}

impl Ctx {
    fn inert_id(&mut self, kind: &str) -> String {
        self.inert += 1;
        format!("lucid-inert:{kind}:{}", self.inert)
    }
}

fn page_nodes(items: &[PageItem], depth: usize, ctx: &mut Ctx) -> Vec<Node> {
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        if it.separator {
            out.push(Node::Separator);
            continue;
        }
        let label = it.label.trim();
        if label.is_empty() {
            continue;
        }
        let text = menu_text(label);
        // A key is used once: a repeat would make a click ambiguous, so it
        // is shown but inert.
        let key = it
            .key
            .as_deref()
            .filter(|k| !k.is_empty())
            .filter(|k| ctx.seen.insert(k.to_string()))
            .map(str::to_string);
        if let Some(sub) = &it.submenu {
            if depth + 1 >= MAX_DEPTH {
                continue;
            }
            let children = tidy_separators(page_nodes(sub, depth + 1, ctx));
            if children.is_empty() {
                continue;
            }
            let id = match &key {
                Some(k) => format!("lucid-page-sub:{k}"),
                None => ctx.inert_id("sub"),
            };
            out.push(Node::Submenu {
                id,
                text,
                enabled: it.enabled,
                children,
            });
            continue;
        }
        match (key, it.checked) {
            (Some(k), Some(checked)) => out.push(Node::Check {
                id: page_item_id(&k),
                text,
                enabled: it.enabled,
                checked,
            }),
            (Some(k), None) => out.push(Node::Item {
                id: page_item_id(&k),
                text,
                enabled: it.enabled,
            }),
            // No key: a heading (or a duplicate) — visible, never clickable.
            (None, _) => out.push(Node::Item {
                id: ctx.inert_id("label"),
                text,
                enabled: false,
            }),
        }
    }
    out
}

fn app_menu(about: Option<AboutInfo>) -> TopMenu {
    use Native::*;
    TopMenu {
        id: "lucid-top:app".into(),
        text: APP_NAME.into(),
        role: Role::App,
        children: vec![
            Node::Native(About(about)),
            Node::Item {
                id: UPDATE_CHECK_ID.into(),
                text: "Check for Updates…".into(),
                enabled: true,
            },
            Node::Submenu {
                id: UPDATE_CHANNELS_ID.into(),
                text: "Update Channel".into(),
                enabled: true,
                // Ticked by with_update_channel.
                children: [("stable", "Stable"), ("latest", "Latest"), ("dev", "Dev")]
                    .iter()
                    .map(|(c, t)| Node::Check {
                        id: format!("{UPDATE_CHANNEL_PREFIX}{c}"),
                        text: (*t).into(),
                        enabled: true,
                        checked: false,
                    })
                    .collect(),
            },
            Node::Separator,
            Node::Native(Services),
            Node::Separator,
            Node::Native(Hide),
            Node::Native(HideOthers),
            Node::Native(ShowAll),
            Node::Separator,
            Node::Native(Quit),
        ],
    }
}

/// The page's Edit items, then the native text-editing items. NEVER
/// Undo/Redo: their Cmd+Z / Cmd+Shift+Z key equivalents would eat the
/// keystroke before LUCID's own undo handler sees it.
fn edit_children(page: Vec<Node>) -> Vec<Node> {
    let mut v = page;
    v.push(Node::Separator);
    v.extend([Native::Cut, Native::Copy, Native::Paste, Native::SelectAll].map(Node::Native));
    tidy_separators(v)
}

fn window_children(page: Vec<Node>) -> Vec<Node> {
    let mut v = page;
    v.push(Node::Separator);
    v.extend([
        Node::Native(Native::Minimize),
        Node::Native(Native::Zoom),
        Node::Separator,
        Node::Native(Native::CloseWindow),
    ]);
    tidy_separators(v)
}

/// The whole native bar for a page spec (pure).
///
/// Order: the app menu; the page's menus in page order (its Edit merged with
/// the native editing items; without a page Edit, a native one right after
/// File); Window second to last; the page's Help last. Page menus with no
/// label or no items are left out.
pub fn build_model(menus: &[PageMenu], about: Option<AboutInfo>) -> Vec<TopMenu> {
    let mut ctx = Ctx {
        seen: HashSet::new(),
        inert: 0,
    };
    let mut middle: Vec<TopMenu> = Vec::new();
    let mut window_page: Vec<Node> = Vec::new();
    let mut help: Option<TopMenu> = None;
    let mut have_edit = false;
    let mut used_ids: HashSet<String> = HashSet::new();

    for m in menus {
        let label = m.label.trim();
        if label.is_empty() {
            continue;
        }
        let nodes = tidy_separators(page_nodes(&m.items, 0, &mut ctx));
        let lower = label.to_lowercase();
        if lower == "window" {
            window_page.extend(nodes);
            continue;
        }
        if lower == "edit" && !have_edit {
            have_edit = true;
            middle.push(TopMenu {
                id: "lucid-top:edit".into(),
                text: menu_text(label),
                role: Role::Edit,
                children: edit_children(nodes),
            });
            continue;
        }
        if nodes.is_empty() {
            continue;
        }
        if lower == "help" && help.is_none() {
            help = Some(TopMenu {
                id: "lucid-top:help".into(),
                text: menu_text(label),
                role: Role::Help,
                children: nodes,
            });
            continue;
        }
        let mut id = format!("lucid-top:page:{label}");
        let mut n = 1;
        while !used_ids.insert(id.clone()) {
            n += 1;
            id = format!("lucid-top:page:{label}#{n}");
        }
        middle.push(TopMenu {
            id,
            text: menu_text(label),
            role: Role::Page,
            children: nodes,
        });
    }

    if !have_edit {
        let at = middle
            .iter()
            .position(|m| m.text.eq_ignore_ascii_case("file"))
            .map(|i| i + 1)
            .unwrap_or(0);
        middle.insert(
            at,
            TopMenu {
                id: "lucid-top:edit".into(),
                text: "Edit".into(),
                role: Role::Edit,
                children: edit_children(Vec::new()),
            },
        );
    }

    let mut out = Vec::with_capacity(middle.len() + 3);
    out.push(app_menu(about));
    out.extend(middle);
    out.push(TopMenu {
        id: "lucid-top:window".into(),
        text: "Window".into(),
        role: Role::Window,
        children: window_children(tidy_separators(window_page)),
    });
    if let Some(h) = help {
        out.push(h);
    }
    out
}

/// Tick `channel` (and only it) under luc3d ▸ Update Channel.
pub fn with_update_channel(mut model: Vec<TopMenu>, channel: &str) -> Vec<TopMenu> {
    let want = format!("{UPDATE_CHANNEL_PREFIX}{channel}");
    for top in model.iter_mut().filter(|t| t.role == Role::App) {
        for node in top.children.iter_mut() {
            if let Node::Submenu { id, children, .. } = node {
                if id == UPDATE_CHANNELS_ID {
                    for c in children.iter_mut() {
                        if let Node::Check { id, checked, .. } = c {
                            *checked = *id == want;
                        }
                    }
                }
            }
        }
    }
    model
}

/// The shim action for an update item id: "check" or "channel:<name>".
pub fn update_action(id: &str) -> Option<String> {
    if id == UPDATE_CHECK_ID {
        return Some("check".into());
    }
    id.strip_prefix(UPDATE_CHANNEL_PREFIX)
        .filter(|c| crate::updates::is_channel(c))
        .map(|c| format!("channel:{c}"))
}

/// The script an update item evaluates in the page.
pub fn update_script(action: &str) -> String {
    let arg = serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into());
    format!("window.{UPDATES_FN} && window.{UPDATES_FN}.menu({arg});")
}

// ---------------------------------------------------------------------------
// In-place updates
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Update {
    pub id: String,
    pub text: Option<String>,
    pub enabled: Option<bool>,
    pub checked: Option<bool>,
}

fn diff_nodes(old: &[Node], new: &[Node], out: &mut Vec<Update>) -> bool {
    if old.len() != new.len() {
        return false;
    }
    for (o, n) in old.iter().zip(new) {
        match (o, n) {
            (Node::Separator, Node::Separator) => {}
            (Node::Native(a), Node::Native(b)) if a == b => {}
            (
                Node::Item {
                    id: ia,
                    text: ta,
                    enabled: ea,
                },
                Node::Item {
                    id: ib,
                    text: tb,
                    enabled: eb,
                },
            ) if ia == ib => push_update(out, ib, ta, tb, *ea, *eb, None),
            (
                Node::Check {
                    id: ia,
                    text: ta,
                    enabled: ea,
                    checked: ca,
                },
                Node::Check {
                    id: ib,
                    text: tb,
                    enabled: eb,
                    checked: cb,
                },
            ) if ia == ib => push_update(out, ib, ta, tb, *ea, *eb, (ca != cb).then_some(*cb)),
            (
                Node::Submenu {
                    id: ia,
                    text: ta,
                    enabled: ea,
                    children: ca,
                },
                Node::Submenu {
                    id: ib,
                    text: tb,
                    enabled: eb,
                    children: cb,
                },
            ) if ia == ib => {
                push_update(out, ib, ta, tb, *ea, *eb, None);
                if !diff_nodes(ca, cb, out) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

fn push_update(
    out: &mut Vec<Update>,
    id: &str,
    old_text: &str,
    new_text: &str,
    old_enabled: bool,
    new_enabled: bool,
    checked: Option<bool>,
) {
    let u = Update {
        id: id.to_string(),
        text: (old_text != new_text).then(|| new_text.to_string()),
        enabled: (old_enabled != new_enabled).then_some(new_enabled),
        checked,
    };
    if u.text.is_some() || u.enabled.is_some() || u.checked.is_some() {
        out.push(u);
    }
}

/// The in-place changes that turn `old` into `new`, or None when the
/// structure differs (items added, removed, moved or re-kinded; About's text
/// changed) and the bar must be rebuilt.
pub fn plan_updates(old: &[TopMenu], new: &[TopMenu]) -> Option<Vec<Update>> {
    if old.len() != new.len() {
        return None;
    }
    let mut out = Vec::new();
    for (o, n) in old.iter().zip(new) {
        if o.id != n.id || o.role != n.role {
            return None;
        }
        push_update(&mut out, &n.id, &o.text, &n.text, true, true, None);
        if !diff_nodes(&o.children, &n.children, &mut out) {
            return None;
        }
    }
    Some(out)
}

/// The checked state the model says a check item has (to undo AppKit's own
/// toggle on click: the page decides, and resends if it changed).
pub fn model_checked(model: &[TopMenu], id: &str) -> Option<bool> {
    fn find(nodes: &[Node], id: &str) -> Option<bool> {
        nodes.iter().find_map(|n| match n {
            Node::Check { id: i, checked, .. } if i == id => Some(*checked),
            Node::Submenu { children, .. } => find(children, id),
            _ => None,
        })
    }
    model.iter().find_map(|m| find(&m.children, id))
}

/// The script a click evaluates in the page.
pub fn activation_script(key: &str) -> String {
    let arg = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
    format!("window.{PAGE_ACTION_FN} && window.{PAGE_ACTION_FN}({arg});")
}

// ---------------------------------------------------------------------------
// Mirroring a model into Tauri menu objects
// ---------------------------------------------------------------------------

enum Handle<R: Runtime> {
    Item(MenuItem<R>),
    Check(CheckMenuItem<R>),
    Sub(Submenu<R>),
}

struct Installed<R: Runtime> {
    model: Vec<TopMenu>,
    handles: HashMap<String, Handle<R>>,
}

/// The installed bar (managed state).
pub struct NativeMenuState<R: Runtime>(Mutex<Option<Installed<R>>>);

impl<R: Runtime> Default for NativeMenuState<R> {
    fn default() -> Self {
        NativeMenuState(Mutex::new(None))
    }
}

fn native_item<R: Runtime>(
    app: &AppHandle<R>,
    n: &Native,
) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    Ok(match n {
        Native::About(info) => {
            let meta = info.as_ref().map(|i| AboutMetadata {
                // Shown as "Version <app> (<label>)": the label the in-page
                // bar would show, and its tooltip (with the full commit).
                short_version: Some(i.text.clone()).filter(|s| !s.is_empty()),
                credits: Some(i.title.clone()).filter(|s| !s.is_empty()),
                ..Default::default()
            });
            Box::new(PredefinedMenuItem::about(
                app,
                Some(&format!("About {APP_NAME}")),
                meta,
            )?)
        }
        Native::Services => Box::new(PredefinedMenuItem::services(app, None)?),
        Native::Hide => Box::new(PredefinedMenuItem::hide(
            app,
            Some(&format!("Hide {APP_NAME}")),
        )?),
        Native::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
        Native::ShowAll => Box::new(PredefinedMenuItem::show_all(app, None)?),
        // Not the predefined Quit: that calls NSApp terminate:, which never
        // emits CloseRequested, so unsaved work would be lost without the
        // page's check. Ours closes each window through its guard.
        Native::Quit => Box::new(MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            format!("Quit {APP_NAME}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?),
        Native::Cut => Box::new(PredefinedMenuItem::cut(app, None)?),
        Native::Copy => Box::new(PredefinedMenuItem::copy(app, None)?),
        Native::Paste => Box::new(PredefinedMenuItem::paste(app, None)?),
        Native::SelectAll => Box::new(PredefinedMenuItem::select_all(app, None)?),
        Native::Minimize => Box::new(PredefinedMenuItem::minimize(app, None)?),
        // muda's "maximize" is AppKit's performZoom: on macOS.
        Native::Zoom => Box::new(PredefinedMenuItem::maximize(app, Some("Zoom"))?),
        Native::CloseWindow => Box::new(PredefinedMenuItem::close_window(app, None)?),
    })
}

fn fill<R: Runtime>(
    app: &AppHandle<R>,
    parent: &Submenu<R>,
    nodes: &[Node],
    handles: &mut HashMap<String, Handle<R>>,
) -> tauri::Result<()> {
    for n in nodes {
        match n {
            Node::Separator => parent.append(&PredefinedMenuItem::separator(app)?)?,
            Node::Native(x) => parent.append(native_item(app, x)?.as_ref())?,
            Node::Item { id, text, enabled } => {
                let it = MenuItem::with_id(app, id.as_str(), text, *enabled, None::<&str>)?;
                parent.append(&it)?;
                handles.insert(id.clone(), Handle::Item(it));
            }
            Node::Check {
                id,
                text,
                enabled,
                checked,
            } => {
                let it = CheckMenuItem::with_id(
                    app,
                    id.as_str(),
                    text,
                    *enabled,
                    *checked,
                    None::<&str>,
                )?;
                parent.append(&it)?;
                handles.insert(id.clone(), Handle::Check(it));
            }
            Node::Submenu {
                id,
                text,
                enabled,
                children,
            } => {
                let sub = Submenu::with_id(app, id.as_str(), text, *enabled)?;
                fill(app, &sub, children, handles)?;
                parent.append(&sub)?;
                handles.insert(id.clone(), Handle::Sub(sub));
            }
        }
    }
    Ok(())
}

/// Build the whole bar and make it the app menu. The old bar stays until the
/// new one is complete, so a failure leaves it as it was.
fn install<R: Runtime>(app: &AppHandle<R>, model: Vec<TopMenu>) -> tauri::Result<Installed<R>> {
    let mut handles = HashMap::new();
    let menu = Menu::new(app)?;
    let mut roles: Vec<(Role, Submenu<R>)> = Vec::new();
    for top in &model {
        let sub = Submenu::with_id(app, top.id.as_str(), &top.text, true)?;
        fill(app, &sub, &top.children, &mut handles)?;
        menu.append(&sub)?;
        roles.push((top.role, sub.clone()));
        handles.insert(top.id.clone(), Handle::Sub(sub));
    }
    app.set_menu(menu)?;
    // Window: macOS adds the window list to it; Help: the search field.
    #[cfg(target_os = "macos")]
    for (role, sub) in &roles {
        match role {
            Role::Window => sub.set_as_windows_menu_for_nsapp()?,
            Role::Help => sub.set_as_help_menu_for_nsapp()?,
            _ => {}
        }
    }
    #[cfg(not(target_os = "macos"))]
    drop(roles);
    Ok(Installed { model, handles })
}

fn apply<R: Runtime>(inst: &Installed<R>, updates: &[Update]) -> tauri::Result<bool> {
    for u in updates {
        let Some(h) = inst.handles.get(&u.id) else {
            return Ok(false);
        };
        match h {
            Handle::Item(i) => {
                if let Some(t) = &u.text {
                    i.set_text(t)?;
                }
                if let Some(e) = u.enabled {
                    i.set_enabled(e)?;
                }
            }
            Handle::Check(i) => {
                if let Some(t) = &u.text {
                    i.set_text(t)?;
                }
                if let Some(e) = u.enabled {
                    i.set_enabled(e)?;
                }
                if let Some(c) = u.checked {
                    i.set_checked(c)?;
                }
            }
            Handle::Sub(s) => {
                if let Some(t) = &u.text {
                    s.set_text(t)?;
                }
                if let Some(e) = u.enabled {
                    s.set_enabled(e)?;
                }
            }
        }
    }
    Ok(true)
}

/// Show `model`: in place when the structure is unchanged, else rebuilt.
fn show<R: Runtime>(
    app: &AppHandle<R>,
    state: &NativeMenuState<R>,
    model: Vec<TopMenu>,
) -> tauri::Result<()> {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(inst) = guard.as_mut() {
        if let Some(updates) = plan_updates(&inst.model, &model) {
            if apply(inst, &updates)? {
                inst.model = model;
                return Ok(());
            }
        }
    }
    *guard = Some(install(app, model)?);
    Ok(())
}

/// The bar before the page has sent its menus (and if it never does):
/// luc3d, Edit (native items), Window.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install_initial<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    show(
        app,
        &app.state::<NativeMenuState<R>>(),
        with_update_channel(
            build_model(&[], None),
            &crate::updates::current_channel(app),
        ),
    )
}

/// `set_app_menu({menus, about})`: put the page's menus in the macOS menu
/// bar. Ok(true) once shown; Ok(false) on other platforms, where nothing
/// changes and the page keeps its in-page menus.
#[tauri::command]
pub fn set_app_menu<R: Runtime>(
    app: AppHandle<R>,
    menus: Vec<PageMenu>,
    about: Option<AboutInfo>,
) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        let _ = (&app, &menus, &about);
        return Ok(false);
    }
    let state = app
        .try_state::<NativeMenuState<R>>()
        .ok_or_else(|| "native menu state missing".to_string())?;
    let about = about.filter(|a| !a.text.trim().is_empty());
    let model = with_update_channel(
        build_model(&menus, about),
        &crate::updates::current_channel(&app),
    );
    show(&app, &state, model).map_err(|e| format!("set_app_menu: {e}"))?;
    Ok(true)
}

/// AppKit toggles a check item on click; put it back to what the model says
/// (the page decides, and the next spec or channel refresh sets it right).
fn restore_check<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(state) = app.try_state::<NativeMenuState<R>>() {
        // try_lock: this runs on the main thread, and a set_app_menu holding
        // the lock may be waiting for the main thread. Busy → skip; the
        // page's next spec puts the tick right.
        if let Some(inst) = state.0.try_lock().ok().as_ref().and_then(|g| g.as_ref()) {
            if let (Some(c), Some(Handle::Check(item))) =
                (model_checked(&inst.model, id), inst.handles.get(id))
            {
                let _ = item.set_checked(c);
            }
        }
    }
}

/// Evaluate `script` in the focused window (else main, else any).
fn eval_in_focused<R: Runtime>(app: &AppHandle<R>, script: String, what: &str) {
    let windows = app.webview_windows();
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next());
    if let Some(w) = target {
        if let Err(e) = w.eval(script) {
            eprintln!("[lucid] menu item {what}: {e}");
        }
    }
}

/// A click on a page item: have the page click its own element.
pub fn on_page_item<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(key) = page_key(id) else { return };
    restore_check(app, id);
    eval_in_focused(app, activation_script(key), key);
}

/// A click on luc3d ▸ Check for Updates… or an Update Channel item. The page
/// runs the flow (it owns the unsaved-work check and the dialogs) and, for a
/// channel, calls set_update_channel, which re-ticks the menu.
pub fn on_update_item<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(action) = update_action(id) else {
        return;
    };
    restore_check(app, id);
    eval_in_focused(app, update_script(&action), &action);
}

/// Re-tick Update Channel after set_update_channel (macOS; a no-op where no
/// native bar is installed).
pub fn refresh_update_channel<R: Runtime>(app: &AppHandle<R>, channel: &str) {
    let Some(state) = app.try_state::<NativeMenuState<R>>() else {
        return;
    };
    let model = match state.0.lock() {
        Ok(g) => match g.as_ref() {
            Some(inst) => inst.model.clone(),
            None => return,
        },
        Err(_) => return,
    };
    if let Err(e) = show(app, &state, with_update_channel(model, channel)) {
        eprintln!("[lucid] update channel menu: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, label: &str) -> PageItem {
        PageItem {
            key: Some(key.into()),
            label: label.into(),
            ..Default::default()
        }
    }
    fn sep() -> PageItem {
        PageItem {
            separator: true,
            ..Default::default()
        }
    }
    fn menu(label: &str, items: Vec<PageItem>) -> PageMenu {
        PageMenu {
            label: label.into(),
            items,
        }
    }
    fn lucid_menus() -> Vec<PageMenu> {
        vec![
            menu(
                "File",
                vec![
                    item("menuNewProject", "New Project"),
                    sep(),
                    item("menuLoadSlp", "Load SLP…"),
                ],
            ),
            menu("Edit", vec![item("menuAddInstance", "Add Instance")]),
            menu(
                "Calibrate",
                vec![item("menuCalibrateNewTab", "Calibrate in New Tab")],
            ),
            menu("Tracks", vec![item("menuNewTrack", "New Track…")]),
            menu("View", vec![item("menuToggle3D", "Toggle 3D Viewport")]),
            menu("Hot Keys", vec![item("menuHotkeys", "Show Hot Keys")]),
            menu(
                "Help",
                vec![
                    item("menuDocumentation", "Docs"),
                    item("menuSettings", "Settings"),
                ],
            ),
        ]
    }
    fn texts(m: &[TopMenu]) -> Vec<&str> {
        m.iter().map(|t| t.text.as_str()).collect()
    }
    fn all_nodes(nodes: &[Node]) -> Vec<&Node> {
        let mut v = Vec::new();
        for n in nodes {
            v.push(n);
            if let Node::Submenu { children, .. } = n {
                v.extend(all_nodes(children));
            }
        }
        v
    }

    #[test]
    fn order_is_app_page_menus_window_help() {
        let m = build_model(&lucid_menus(), None);
        assert_eq!(
            texts(&m),
            [
                "luc3d",
                "File",
                "Edit",
                "Calibrate",
                "Tracks",
                "View",
                "Hot Keys",
                "Window",
                "Help"
            ]
        );
        assert_eq!(m[m.len() - 2].role, Role::Window);
        assert_eq!(m.last().unwrap().role, Role::Help);
        assert_eq!(m[0].role, Role::App);
    }

    #[test]
    fn help_goes_last_even_when_the_page_puts_it_first() {
        let mut menus = lucid_menus();
        let help = menus.pop().unwrap();
        menus.insert(0, help);
        let m = build_model(&menus, None);
        assert_eq!(texts(&m).last(), Some(&"Help"));
        assert_eq!(texts(&m)[texts(&m).len() - 2], "Window");
    }

    #[test]
    fn app_menu_has_about_services_hide_and_our_quit() {
        let m = build_model(&[], None);
        let channel = |c: &str, t: &str| Node::Check {
            id: format!("lucid-update:channel:{c}"),
            text: t.into(),
            enabled: true,
            checked: false,
        };
        assert_eq!(
            m[0].children,
            vec![
                Node::Native(Native::About(None)),
                Node::Item {
                    id: "lucid-update:check".into(),
                    text: "Check for Updates…".into(),
                    enabled: true
                },
                Node::Submenu {
                    id: "lucid-update:channels".into(),
                    text: "Update Channel".into(),
                    enabled: true,
                    children: vec![
                        channel("stable", "Stable"),
                        channel("latest", "Latest"),
                        channel("dev", "Dev")
                    ],
                },
                Node::Separator,
                Node::Native(Native::Services),
                Node::Separator,
                Node::Native(Native::Hide),
                Node::Native(Native::HideOthers),
                Node::Native(Native::ShowAll),
                Node::Separator,
                Node::Native(Native::Quit),
            ]
        );
        let about = AboutInfo {
            text: "desktop 1.0.5 · abcdef12".into(),
            title: "LUCID desktop 1.0.5 build".into(),
        };
        let m = build_model(&[], Some(about.clone()));
        assert_eq!(m[0].children[0], Node::Native(Native::About(Some(about))));
    }

    /// The ticks under Update Channel, in order (stable, latest, dev).
    fn channel_ticks(m: &[TopMenu]) -> Vec<bool> {
        let app = m.iter().find(|t| t.role == Role::App).unwrap();
        app.children
            .iter()
            .find_map(|n| match n {
                Node::Submenu { id, children, .. } if id == "lucid-update:channels" => Some(
                    children
                        .iter()
                        .map(|c| matches!(c, Node::Check { checked: true, .. }))
                        .collect(),
                ),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn update_channel_has_exactly_one_tick_and_moves_in_place() {
        let base = with_update_channel(build_model(&lucid_menus(), None), "stable");
        assert_eq!(channel_ticks(&base), vec![true, false, false]);
        let dev = with_update_channel(base.clone(), "dev");
        assert_eq!(channel_ticks(&dev), vec![false, false, true]);
        assert_eq!(
            channel_ticks(&with_update_channel(dev.clone(), "latest")),
            vec![false, true, false]
        );
        // An unknown channel ticks nothing rather than a wrong one.
        assert_eq!(
            channel_ticks(&with_update_channel(dev.clone(), "nightly")),
            vec![false; 3]
        );
        // Switching is an in-place update of the two ticks, never a rebuild.
        let plan = plan_updates(&base, &dev).expect("same structure");
        let ids: Vec<&str> = plan.iter().map(|u| u.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["lucid-update:channel:stable", "lucid-update:channel:dev"]
        );
        // The page's menus never reach these items' ids, and vice versa.
        assert!(page_key("lucid-update:check").is_none());
    }

    #[test]
    fn update_items_map_to_shim_actions() {
        assert_eq!(
            update_action("lucid-update:check").as_deref(),
            Some("check")
        );
        assert_eq!(
            update_action("lucid-update:channel:latest").as_deref(),
            Some("channel:latest")
        );
        assert_eq!(update_action("lucid-update:channel:nightly"), None);
        assert_eq!(update_action("lucid-update:channels"), None);
        assert_eq!(update_action("lucid-page:menuOpen"), None);
        assert_eq!(
            update_script("channel:dev"),
            "window.__lucidUpdates && window.__lucidUpdates.menu(\"channel:dev\");"
        );
    }

    #[test]
    fn edit_merges_page_items_with_native_editing_and_never_undo_redo() {
        let m = build_model(&lucid_menus(), None);
        let edit = m.iter().find(|t| t.role == Role::Edit).unwrap();
        assert_eq!(
            edit.children,
            vec![
                Node::Item {
                    id: "lucid-page:menuAddInstance".into(),
                    text: "Add Instance".into(),
                    enabled: true
                },
                Node::Separator,
                Node::Native(Native::Cut),
                Node::Native(Native::Copy),
                Node::Native(Native::Paste),
                Node::Native(Native::SelectAll),
            ]
        );
        // There is no Undo/Redo variant to emit at all; and the only native
        // items in any page-derived menu are the editing four.
        for top in &m {
            for n in all_nodes(&top.children) {
                if let Node::Item { text, .. } | Node::Check { text, .. } = n {
                    assert!(
                        !text.to_lowercase().contains("undo")
                            && !text.to_lowercase().contains("redo")
                    );
                }
            }
        }
    }

    #[test]
    fn without_a_page_edit_a_native_edit_follows_file() {
        let menus = vec![
            menu("File", vec![item("a", "A")]),
            menu("View", vec![item("b", "B")]),
        ];
        let m = build_model(&menus, None);
        assert_eq!(texts(&m), ["luc3d", "File", "Edit", "View", "Window"]);
        let edit = &m[2];
        assert_eq!(edit.children.len(), 4);
        // No page menus at all: luc3d, Edit, Window (the startup bar).
        assert_eq!(texts(&build_model(&[], None)), ["luc3d", "Edit", "Window"]);
    }

    #[test]
    fn window_has_minimize_zoom_close_and_takes_a_page_window_menu() {
        let m = build_model(&[], None);
        let w = m.iter().find(|t| t.role == Role::Window).unwrap();
        assert_eq!(
            w.children,
            vec![
                Node::Native(Native::Minimize),
                Node::Native(Native::Zoom),
                Node::Separator,
                Node::Native(Native::CloseWindow),
            ]
        );
        let m = build_model(&[menu("Window", vec![item("tile", "Tile")])], None);
        let w = m.iter().find(|t| t.role == Role::Window).unwrap();
        assert_eq!(
            w.children[0],
            Node::Item {
                id: "lucid-page:tile".into(),
                text: "Tile".into(),
                enabled: true
            }
        );
        assert_eq!(w.children[1], Node::Separator);
        assert_eq!(m.iter().filter(|t| t.text == "Window").count(), 1);
    }

    #[test]
    fn separators_are_tidied() {
        let menus = vec![menu(
            "File",
            vec![sep(), item("a", "A"), sep(), sep(), item("b", "B"), sep()],
        )];
        let m = build_model(&menus, None);
        let file = &m[1];
        assert_eq!(file.children.len(), 3);
        assert_eq!(file.children[1], Node::Separator);
        assert!(matches!(file.children[0], Node::Item { .. }));
        assert!(matches!(file.children[2], Node::Item { .. }));
    }

    #[test]
    fn nested_submenus_disabled_and_checked_items_and_headings() {
        let trails = PageItem {
            key: Some("menuTrailsParent".into()),
            label: "Node Trails".into(),
            submenu: Some(vec![
                PageItem {
                    label: "Length".into(),
                    enabled: false,
                    ..Default::default()
                },
                PageItem {
                    checked: Some(true),
                    ..item("menuTrailsOff", "Off")
                },
                PageItem {
                    checked: Some(false),
                    ..item("menuTrails1s", "1 s")
                },
                sep(),
                PageItem {
                    label: "Deeper".into(),
                    key: Some("deep".into()),
                    submenu: Some(vec![item("leaf", "Leaf")]),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        };
        let disabled = PageItem {
            enabled: false,
            ..item("menuNewTrack", "New Track…")
        };
        let m = build_model(&[menu("Tracks", vec![disabled, trails])], None);
        let tracks = m.iter().find(|t| t.text == "Tracks").unwrap();
        assert_eq!(
            tracks.children[0],
            Node::Item {
                id: "lucid-page:menuNewTrack".into(),
                text: "New Track…".into(),
                enabled: false
            }
        );
        let Node::Submenu {
            id, text, children, ..
        } = &tracks.children[1]
        else {
            panic!("submenu")
        };
        assert_eq!(id, "lucid-page-sub:menuTrailsParent");
        assert_eq!(text, "Node Trails");
        assert!(
            matches!(&children[0], Node::Item { text, enabled: false, id } if text == "Length" && id.starts_with("lucid-inert:"))
        );
        assert_eq!(
            children[1],
            Node::Check {
                id: "lucid-page:menuTrailsOff".into(),
                text: "Off".into(),
                enabled: true,
                checked: true
            }
        );
        assert_eq!(
            children[2],
            Node::Check {
                id: "lucid-page:menuTrails1s".into(),
                text: "1 s".into(),
                enabled: true,
                checked: false
            }
        );
        assert_eq!(children[3], Node::Separator);
        let Node::Submenu { children: deep, .. } = &children[4] else {
            panic!("nested")
        };
        assert_eq!(
            deep[0],
            Node::Item {
                id: "lucid-page:leaf".into(),
                text: "Leaf".into(),
                enabled: true
            }
        );
    }

    #[test]
    fn ids_ampersands_duplicates_and_unknown_or_empty_menus() {
        let menus = vec![
            menu("", vec![item("x", "X")]),
            menu("Empty", vec![]),
            menu("Only separators", vec![sep(), sep()]),
            menu(
                "Edit",
                vec![
                    item("menuGroupByTrack", "Group by Track & Triangulate All"),
                    item("menuGroupByTrack", "Duplicate key"),
                    item("blank", "   "),
                    PageItem {
                        key: Some(String::new()),
                        label: "Empty key".into(),
                        ..Default::default()
                    },
                ],
            ),
            menu("Whatever", vec![item("w", "W")]),
        ];
        let m = build_model(&menus, None);
        assert_eq!(texts(&m), ["luc3d", "Edit", "Whatever", "Window"]);
        let edit = &m[1];
        assert_eq!(
            edit.children[0],
            Node::Item {
                id: "lucid-page:menuGroupByTrack".into(),
                text: "Group by Track && Triangulate All".into(),
                enabled: true
            }
        );
        // A repeated key is shown but inert; an empty key too; a blank label is dropped.
        assert!(
            matches!(&edit.children[1], Node::Item { id, enabled: false, .. } if id.starts_with("lucid-inert:"))
        );
        assert!(
            matches!(&edit.children[2], Node::Item { id, enabled: false, text } if id.starts_with("lucid-inert:") && text == "Empty key")
        );
        assert_eq!(edit.children[3], Node::Separator);
        assert_eq!(page_key("lucid-page:menuLoadSlp"), Some("menuLoadSlp"));
        assert_eq!(page_key("lucid-page:"), None);
        assert_eq!(page_key("lucid-quit"), None);
        assert_eq!(page_key("lucid-inert:label:1"), None);
    }

    #[test]
    fn spec_json_deserializes_with_defaults() {
        let json = r#"[{"label":"File","items":[{"key":"a","label":"A"},{"separator":true},
            {"key":"b","label":"B","enabled":false,"checked":true},
            {"label":"Sub","key":"s","submenu":[{"key":"c","label":"C"}]},
            {"label":"Heading","enabled":false}]}]"#;
        let menus: Vec<PageMenu> = serde_json::from_str(json).unwrap();
        assert_eq!(menus[0].items.len(), 5);
        assert!(menus[0].items[0].enabled);
        assert!(menus[0].items[1].separator);
        assert_eq!(menus[0].items[2].checked, Some(true));
        assert!(!menus[0].items[2].enabled);
        assert_eq!(
            menus[0].items[3].submenu.as_ref().unwrap()[0]
                .key
                .as_deref(),
            Some("c")
        );
        let m = build_model(&menus, None);
        assert_eq!(m[1].children.len(), 5);
    }

    #[test]
    fn deep_nesting_is_cut_off() {
        let mut it = item("leaf", "Leaf");
        for i in 0..20 {
            it = PageItem {
                key: Some(format!("s{i}")),
                label: format!("S{i}"),
                submenu: Some(vec![it]),
                ..Default::default()
            };
        }
        let m = build_model(&[menu("File", vec![it, item("ok", "OK")])], None);
        assert_eq!(m[1].text, "File");
        // The over-deep chain collapses (its innermost levels are dropped, so
        // every level above is empty); the sibling stays.
        assert_eq!(
            m[1].children,
            vec![Node::Item {
                id: "lucid-page:ok".into(),
                text: "OK".into(),
                enabled: true
            }]
        );
    }

    #[test]
    fn updates_in_place_when_only_text_enabled_or_checked_change() {
        let mk = |enabled: bool, checked: bool, label: &str| {
            build_model(
                &[menu(
                    "Tracks",
                    vec![
                        PageItem {
                            enabled,
                            ..item("a", "A")
                        },
                        PageItem {
                            checked: Some(checked),
                            ..item("t", label)
                        },
                        PageItem {
                            label: "Sub".into(),
                            key: Some("s".into()),
                            enabled,
                            submenu: Some(vec![item("c", "C")]),
                            ..Default::default()
                        },
                    ],
                )],
                None,
            )
        };
        let old = mk(true, false, "1 s");
        assert_eq!(plan_updates(&old, &old), Some(vec![]));
        let new = mk(false, true, "1 s (30 frames)");
        let ups = plan_updates(&old, &new).unwrap();
        assert_eq!(
            ups,
            vec![
                Update {
                    id: "lucid-page:a".into(),
                    enabled: Some(false),
                    ..Default::default()
                },
                Update {
                    id: "lucid-page:t".into(),
                    text: Some("1 s (30 frames)".into()),
                    checked: Some(true),
                    ..Default::default()
                },
                Update {
                    id: "lucid-page-sub:s".into(),
                    enabled: Some(false),
                    ..Default::default()
                },
            ]
        );
        assert_eq!(model_checked(&new, "lucid-page:t"), Some(true));
        assert_eq!(model_checked(&new, "lucid-page:a"), None);
    }

    #[test]
    fn structure_changes_force_a_rebuild() {
        let base = build_model(&lucid_menus(), None);
        let mut menus = lucid_menus();
        menus[0].items.push(item("menuNew", "New item"));
        assert_eq!(plan_updates(&base, &build_model(&menus, None)), None);
        let mut menus = lucid_menus();
        menus[0].items[0].checked = Some(false); // item became a check item
        assert_eq!(plan_updates(&base, &build_model(&menus, None)), None);
        let mut menus = lucid_menus();
        menus.remove(2);
        assert_eq!(plan_updates(&base, &build_model(&menus, None)), None);
        let about = AboutInfo {
            text: "v1".into(),
            title: String::new(),
        };
        assert_eq!(
            plan_updates(&base, &build_model(&lucid_menus(), Some(about))),
            None
        );
    }

    #[test]
    fn activation_script_quotes_the_key() {
        assert_eq!(
            activation_script("menuLoadSlp"),
            "window.__lucidNativeMenuAction && window.__lucidNativeMenuAction(\"menuLoadSlp\");"
        );
        let s = activation_script("a\"); alert(1); (\"");
        assert!(s.contains(r#"("a\"); alert(1); (\"")"#), "{s}");
    }
}
