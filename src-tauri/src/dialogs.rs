//! Native pickers and message dialogs.
//!
//! Every path a picker returns is added to the run's grant set (see
//! `files.rs`): that is the only way a path becomes readable or writable.
//! The `blocking_*` dialog calls run on the blocking pool, never on the IPC
//! thread (which on macOS is the main thread the dialog itself needs).

use crate::files::GrantState;
use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Debug, Deserialize)]
pub struct FileFilter {
    pub name: String,
    /// Extensions without the leading dot.
    pub extensions: Vec<String>,
}

/// A suggested name is only a file name: drop any directory part so the page
/// cannot steer the save dialog somewhere through `../../x` or `/etc/x`.
pub fn sanitize_suggested_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    (!base.is_empty() && base != "." && base != "..").then(|| base.to_string())
}

fn clean_extensions(exts: &[String]) -> Vec<String> {
    exts.iter()
        .map(|e| e.trim().trim_start_matches('.').to_string())
        .filter(|e| !e.is_empty())
        .collect()
}

fn grant<R: Runtime>(app: &AppHandle<R>, path: &Path, dir: bool) -> Result<(), String> {
    let state = app.state::<GrantState>();
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if dir {
        g.grant_dir(path.to_path_buf());
    } else {
        g.grant_file(path.to_path_buf());
    }
    Ok(())
}

#[tauri::command]
pub async fn pick_save_path<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    suggested_name: Option<String>,
    filters: Option<Vec<FileFilter>>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().set_parent(&window);
    if let Some(name) = suggested_name.as_deref().and_then(sanitize_suggested_name) {
        builder = builder.set_file_name(name);
    }
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    for f in filters.unwrap_or_default() {
        let exts = clean_extensions(&f.extensions);
        if exts.is_empty() {
            continue;
        }
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        builder = builder.add_filter(f.name, &refs);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|e| format!("pick_save_path: {e}"))?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| format!("pick_save_path: {e}"))?;
    grant(&app, &path, false)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_directory<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_can_create_directories(true);
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_folder())
        .await
        .map_err(|e| format!("pick_directory: {e}"))?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| format!("pick_directory: {e}"))?;
    grant(&app, &path, true)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// OK/Cancel question with custom labels; true = OK.
#[tauri::command]
pub async fn ask_dialog<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    title: String,
    message: String,
    ok_label: String,
    cancel_label: String,
) -> Result<bool, String> {
    let dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label));
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|e| format!("ask_dialog: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_name_keeps_only_the_file_name() {
        assert_eq!(
            sanitize_suggested_name("labels.slp").as_deref(),
            Some("labels.slp")
        );
        assert_eq!(
            sanitize_suggested_name("../../etc/passwd").as_deref(),
            Some("passwd")
        );
        assert_eq!(
            sanitize_suggested_name("C:\\x\\y.csv").as_deref(),
            Some("y.csv")
        );
        assert_eq!(sanitize_suggested_name("dir/"), None);
        assert_eq!(sanitize_suggested_name(".."), None);
        assert_eq!(sanitize_suggested_name("  "), None);
    }

    #[test]
    fn filter_extensions_lose_dots_and_blanks() {
        let v = clean_extensions(&[".slp".into(), "h5".into(), " ".into()]);
        assert_eq!(v, vec!["slp".to_string(), "h5".to_string()]);
    }
}
