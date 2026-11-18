//! In-app updates over three channels: `stable`, `latest`, `dev`.
//!
//! Adapted from sleap-app's `update_channels.rs`. Endpoints are chosen here,
//! per call (`UpdaterExt::updater_builder().endpoints(..)`), never by the page:
//! the page only names a channel. Every bundle is verified against the
//! minisign public key in tauri.conf.json (`plugins.updater.pubkey`), whatever
//! manifest URL was used.
//!
//! - `stable`: the newest non-draft, non-prerelease GitHub release of
//!   talmolab/luc3d whose tag is `vX.Y.Z` and that carries a `latest.json`.
//! - `latest`: the same, pre-releases (`vX.Y.Z-N`) included.
//! - `dev`: the rolling pre-release tagged `desktop-dev` (fixed manifest URL).
//!
//! Resolving stable/latest through the releases API (rather than GitHub's
//! `releases/latest/download/...`) skips a release that has no manifest
//! (e.g. one whose installer legs failed) instead of 404ing on it.
//!
//! The channel lives in `<app config dir>/update-channel`. Default: `dev` for
//! a dev build (version contains `-dev.`), else `stable`.
//!
//! `LUCID_UPDATE_MANIFEST_URL`: replaces the manifest URL for every channel
//! (end-to-end tests against a local server; signature checks still apply,
//! and an http:// URL also needs `plugins.updater.dangerousInsecureTransportProtocol`
//! in the build's config).
//!
//! The page reaches all of this only through the `lucid` plugin commands
//! below; no `updater:*` permission is granted to it.

use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

const REPO: &str = "talmolab/luc3d";
const DEV_MANIFEST: &str =
    "https://github.com/talmolab/luc3d/releases/download/desktop-dev/latest.json";
const MANIFEST_ASSET: &str = "latest.json";
pub const CHANNELS: [&str; 3] = ["stable", "latest", "dev"];
const CHANNEL_FILE: &str = "update-channel";
const MANIFEST_OVERRIDE_ENV: &str = "LUCID_UPDATE_MANIFEST_URL";
/// Every update network call ends: a stalled connection must surface as an
/// error, not a check that never returns.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

pub fn is_channel(s: &str) -> bool {
    CHANNELS.contains(&s)
}

pub fn default_channel(current_version: &str) -> &'static str {
    if current_version.contains("-dev.") {
        "dev"
    } else {
        "stable"
    }
}

/// The persisted channel, or the default for this build.
pub fn load_channel(file: Option<&Path>, current_version: &str) -> String {
    file.and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| is_channel(s))
        .unwrap_or_else(|| default_channel(current_version).to_string())
}

pub fn save_channel(file: &Path, channel: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(file, channel).map_err(|e| format!("{}: {e}", file.display()))
}

/// Managed state: the current channel and the one-install-at-a-time latch.
pub struct UpdateState {
    channel: Mutex<String>,
    file: Option<PathBuf>,
    installing: AtomicBool,
}

impl UpdateState {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app
            .path()
            .app_config_dir()
            .ok()
            .map(|d| d.join(CHANNEL_FILE));
        let version = app.package_info().version.to_string();
        UpdateState {
            channel: Mutex::new(load_channel(file.as_deref(), &version)),
            file,
            installing: AtomicBool::new(false),
        }
    }

    pub fn channel(&self) -> String {
        self.channel
            .lock()
            .map(|c| c.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }
}

/// The channel to show in the native menu (default before setup ran).
pub fn current_channel<R: Runtime>(app: &AppHandle<R>) -> String {
    match app.try_state::<UpdateState>() {
        Some(s) => s.channel(),
        None => default_channel(&app.package_info().version.to_string()).to_string(),
    }
}

// ---------------------------------------------------------------------------
// Release selection (pure)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
pub struct GhAsset {
    pub name: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

/// `vX.Y.Z` (and, with `allow_pre`, `vX.Y.Z-N`) as a version; anything else
/// (`desktop-dev`, `v1.0.0-rc1`, `1.0.0`) is not a release tag of ours.
pub fn release_tag_version(tag: &str, allow_pre: bool) -> Option<Version> {
    let rest = tag.strip_prefix('v')?;
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if parts.len() != 3 || !parts.iter().all(|p| numeric(p)) {
        return None;
    }
    match pre {
        None => {}
        Some(p) if allow_pre && numeric(p) => {}
        Some(_) => return None,
    }
    Version::parse(rest).ok()
}

/// The release a channel installs from: newest by version among non-draft
/// releases with our tag format and a latest.json asset; `stable` takes full
/// releases only.
pub fn pick_release(releases: &[GhRelease], include_prereleases: bool) -> Option<&GhRelease> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter(|r| include_prereleases || !r.prerelease)
        .filter(|r| r.assets.iter().any(|a| a.name == MANIFEST_ASSET))
        .filter_map(|r| release_tag_version(&r.tag_name, include_prereleases).map(|v| (v, r)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, r)| r)
}

pub fn manifest_url_for_tag(tag: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/{tag}/{MANIFEST_ASSET}")
}

/// Whether to offer `remote` to a build running `current` on `channel`.
/// dev: any different build (dev versions are not ordered across bases the
/// way users expect). stable/latest: newer only, or, right after a channel
/// switch (`allow_downgrade`), any different version, so moving from dev
/// back to stable offers stable.
pub fn should_offer(
    channel: &str,
    current: &Version,
    remote: &Version,
    allow_downgrade: bool,
) -> bool {
    if channel == "dev" || allow_downgrade {
        remote != current
    } else {
        remote > current
    }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async fn fetch_releases() -> Result<Vec<GhRelease>, String> {
    let client = reqwest::Client::builder()
        .user_agent("luc3d-updater")
        .timeout(NETWORK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    // Paginate: a release past the first 100 must not go invisible.
    for page in 1..=20u32 {
        let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}");
        let batch: Vec<GhRelease> = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub releases: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GitHub releases: {e}"))?
            .json()
            .await
            .map_err(|e| format!("GitHub releases: {e}"))?;
        let n = batch.len();
        all.extend(batch);
        if n < 100 {
            break;
        }
    }
    Ok(all)
}

async fn manifest_url(channel: &str) -> Result<Url, String> {
    if let Ok(over) = std::env::var(MANIFEST_OVERRIDE_ENV) {
        if !over.trim().is_empty() {
            return Url::parse(over.trim()).map_err(|e| format!("{MANIFEST_OVERRIDE_ENV}: {e}"));
        }
    }
    let url = match channel {
        "dev" => DEV_MANIFEST.to_string(),
        "stable" | "latest" => {
            let releases = fetch_releases().await?;
            let include_pre = channel == "latest";
            let best = pick_release(&releases, include_pre).ok_or_else(|| {
                if include_pre {
                    "no luc3d release has an update manifest yet".to_string()
                } else {
                    "no full luc3d release has an update manifest yet (try the Latest or Dev channel)"
                        .to_string()
                }
            })?;
            manifest_url_for_tag(&best.tag_name)
        }
        other => return Err(format!("unknown update channel: {other}")),
    };
    Url::parse(&url).map_err(|e| e.to_string())
}

async fn build_updater<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    allow_downgrade: bool,
) -> Result<Updater, String> {
    if !updater_configured(app) {
        return Err("this build has no update signing key, so it cannot update itself".into());
    }
    let endpoint = manifest_url(channel).await?;
    let channel = channel.to_string();
    let sessions = app
        .try_state::<Arc<crate::files::WriteSessions>>()
        .map(|s| Arc::clone(&s));
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .timeout(NETWORK_TIMEOUT)
        .version_comparator(move |current, release| {
            should_offer(&channel, &current, &release.version, allow_downgrade)
        })
        // Windows: the installer is launched and this process exits at once,
        // without RunEvent::Exit; drop unfinished saves' temp files first.
        .on_before_exit(move || {
            if let Some(s) = &sessions {
                s.abort_all();
            }
        })
        .build()
        .map_err(|e| e.to_string())
}

fn updater_configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub channel: String,
    pub channels: [&'static str; 3],
    pub updater_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub current_version: String,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum InstallEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Installed,
}

#[tauri::command]
pub fn get_update_info<R: Runtime>(app: AppHandle<R>) -> UpdateInfo {
    UpdateInfo {
        current_version: app.package_info().version.to_string(),
        channel: current_channel(&app),
        channels: CHANNELS,
        updater_configured: updater_configured(&app),
    }
}

#[tauri::command]
pub async fn set_update_channel<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
    channel: String,
) -> Result<(), String> {
    if !is_channel(&channel) {
        return Err(format!("unknown update channel: {channel}"));
    }
    if let Some(file) = &state.file {
        save_channel(file, &channel)?;
    }
    *state.channel.lock().map_err(|e| e.to_string())? = channel.clone();
    crate::native_menu::refresh_update_channel(&app, &channel);
    Ok(())
}

#[tauri::command]
pub async fn check_update<R: Runtime>(
    app: AppHandle<R>,
    allow_downgrade: Option<bool>,
) -> Result<Option<AvailableUpdate>, String> {
    let channel = current_channel(&app);
    let updater = build_updater(&app, &channel, allow_downgrade.unwrap_or(false)).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| AvailableUpdate {
        version: u.version,
        notes: u.body,
        pub_date: u.date.map(|d| d.to_string()),
        current_version: u.current_version,
        channel,
    }))
}

/// Re-check, then download, verify and install `expected_version` (what the
/// user agreed to); a different version found now is refused, not installed.
#[tauri::command]
pub async fn install_update<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
    expected_version: String,
    allow_downgrade: Option<bool>,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("an update is already being installed".into());
    }
    let result = async {
        let channel = current_channel(&app);
        let updater = build_updater(&app, &channel, allow_downgrade.unwrap_or(false)).await?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no update is available any more".to_string())?;
        if update.version != expected_version {
            return Err(format!(
                "luc3d {} became available since you checked; check again",
                update.version
            ));
        }
        let mut downloaded: u64 = 0;
        let progress = on_event.clone();
        update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = progress.send(InstallEvent::Progress { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        let _ = on_event.send(InstallEvent::Installed);
        Ok(())
    }
    .await;
    state.installing.store(false, Ordering::SeqCst);
    result
}

/// Restart into the installed version. The page has already made sure there
/// is no unsaved work, so the close guard is dropped first (it would turn the
/// restart's exit request into a close prompt).
#[tauri::command]
pub fn restart_app<R: Runtime>(app: AppHandle<R>) {
    crate::close_guard::disable_all(&app);
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn channel_defaults_and_persistence() {
        assert_eq!(default_channel("1.0.5"), "stable");
        assert_eq!(default_channel("1.0.5-1"), "stable");
        assert_eq!(default_channel("1.0.5-dev.42"), "dev");

        let dir = std::env::temp_dir().join(format!("lucid-chan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("sub").join(CHANNEL_FILE);
        assert_eq!(load_channel(Some(&file), "1.0.5"), "stable");
        assert_eq!(load_channel(Some(&file), "1.0.6-dev.3"), "dev");
        assert_eq!(load_channel(None, "1.0.5"), "stable");
        save_channel(&file, "latest").unwrap();
        assert_eq!(load_channel(Some(&file), "1.0.6-dev.3"), "latest");
        std::fs::write(&file, "nightly\n").unwrap();
        assert_eq!(
            load_channel(Some(&file), "1.0.5"),
            "stable",
            "unknown → default"
        );
        std::fs::write(&file, " dev \n").unwrap();
        assert_eq!(load_channel(Some(&file), "1.0.5"), "dev");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_tags() {
        assert_eq!(release_tag_version("v1.0.5", false), Some(v("1.0.5")));
        assert_eq!(release_tag_version("v1.0.5-2", true), Some(v("1.0.5-2")));
        for (tag, pre) in [
            ("v1.0.5-2", false),
            ("desktop-dev", true),
            ("dev", true),
            ("1.0.5", true),
            ("v1.0", true),
            ("v1.0.5.1", true),
            ("v1.0.5-rc1", true),
            ("v1.0.5-dev.3", true),
            ("v01.x.5", true),
            ("v1.0.5-", true),
        ] {
            assert_eq!(release_tag_version(tag, pre), None, "{tag} pre={pre}");
        }
    }

    /// Canned `GET /repos/talmolab/luc3d/releases` (fields we read, plus noise).
    const RELEASES_JSON: &str = r#"[
      {"tag_name":"desktop-dev","draft":false,"prerelease":true,"assets":[{"name":"latest.json"},{"name":"luc3d.AppImage"}],"html_url":"x"},
      {"tag_name":"v1.1.0","draft":true,"prerelease":false,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v1.0.7-1","draft":false,"prerelease":true,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v1.0.6","draft":false,"prerelease":false,"assets":[{"name":"luc3d_1.0.6_x64-setup.exe"}]},
      {"tag_name":"v1.0.5","draft":false,"prerelease":false,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v1.0.4","draft":false,"prerelease":false,"assets":[{"name":"latest.json"}]},
      {"tag_name":"v1.0.9-rc1","draft":false,"prerelease":true,"assets":[{"name":"latest.json"}]}
    ]"#;

    #[test]
    fn release_selection_from_the_github_api() {
        let releases: Vec<GhRelease> = serde_json::from_str(RELEASES_JSON).unwrap();
        // stable: v1.1.0 is a draft, v1.0.7-1 a pre-release, v1.0.6 has no
        // manifest, desktop-dev and v1.0.9-rc1 are not our tag format.
        assert_eq!(pick_release(&releases, false).unwrap().tag_name, "v1.0.5");
        // latest: the pre-release wins.
        assert_eq!(pick_release(&releases, true).unwrap().tag_name, "v1.0.7-1");
        // A full release outranks a pre-release of the same base.
        let mut more = releases.clone();
        more.push(
            serde_json::from_str(r#"{"tag_name":"v1.0.7","assets":[{"name":"latest.json"}]}"#)
                .unwrap(),
        );
        assert_eq!(pick_release(&more, true).unwrap().tag_name, "v1.0.7");
        // Nothing installable.
        let only_dev: Vec<GhRelease> =
            serde_json::from_str(&RELEASES_JSON.replace("latest.json", "x")).unwrap();
        assert!(pick_release(&only_dev, true).is_none());
        assert_eq!(
            manifest_url_for_tag("v1.0.5"),
            "https://github.com/talmolab/luc3d/releases/download/v1.0.5/latest.json"
        );
    }

    #[test]
    fn comparator_per_channel() {
        let cur = v("1.0.5");
        // stable / latest: newer only…
        assert!(should_offer("stable", &cur, &v("1.0.6"), false));
        assert!(should_offer("latest", &cur, &v("1.0.6-1"), false));
        assert!(!should_offer("stable", &cur, &v("1.0.5"), false));
        assert!(!should_offer("stable", &cur, &v("1.0.4"), false));
        // …unless the user just switched channel.
        assert!(should_offer("stable", &cur, &v("1.0.4"), true));
        assert!(!should_offer("stable", &cur, &v("1.0.5"), true));
        // dev → stable: 1.0.6-dev.9 sorts below 1.0.6 but above 1.0.5, so
        // only allow_downgrade (set by the switch) offers 1.0.5.
        let dev = v("1.0.6-dev.9");
        assert!(!should_offer("stable", &dev, &v("1.0.5"), false));
        assert!(should_offer("stable", &dev, &v("1.0.5"), true));
        assert!(should_offer("stable", &dev, &v("1.0.6"), false));
        // dev: anything different, either way.
        assert!(should_offer("dev", &dev, &v("1.0.6-dev.10"), false));
        assert!(should_offer("dev", &dev, &v("1.0.6-dev.8"), false));
        assert!(should_offer("dev", &cur, &v("1.0.6-dev.1"), false));
        assert!(!should_offer("dev", &dev, &v("1.0.6-dev.9"), false));
    }

    #[test]
    fn install_events_serialize_like_process_events() {
        let j = |e: InstallEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            j(InstallEvent::Progress {
                downloaded: 5,
                total: Some(10)
            }),
            serde_json::json!({"event": "progress", "data": {"downloaded": 5, "total": 10}})
        );
        assert_eq!(
            j(InstallEvent::Installed),
            serde_json::json!({"event": "installed"})
        );
    }
}
