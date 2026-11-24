//! Local training (the Training panel's "Local (this machine)" backend): `sleap-nn train` run by
//! Rust, never by an argv the page builds.
//!
//! Training is the first sleap-nn command whose input is a config and whose output is a pickle
//! (`best.ckpt`, which inference later `torch.load`s). Any script in the page can call these
//! commands, so:
//!   - the RUNS FOLDER comes from [`pick_runs_directory`] and is a read-only MODEL grant from the
//!     start (the page can read it, never write in it); it must not hold a writable grant (the
//!     project), and sleap-nn, a child of Rust, is the only writer. Inference can use a fresh run at
//!     once: it is already inside a model grant;
//!   - [`training_prepare`] takes each model's config as JSON and checks every leaf key against the
//!     allowlist (`train_config.rs`), writes the page's training / validation `.slp` bytes into a
//!     private staging folder (`<temp>/lucid-train-<random>/`, 0700), grant-checks each video path,
//!     and returns a single-use token. At most [`MAX_LIVE_RUNS`] tokens live at once;
//!   - [`training_run`] runs ONE model of a token, in order: it binds the two ZMQ sockets
//!     (`zmtp.rs`, OS-chosen ports), writes the config with every Rust-owned key forced (labels
//!     files, cache, runs folder, unique run name, ports, W&B off, one device), and spawns
//!     `sleap-nn train --config <staging>/config_<i>.yaml --video-paths <v>…` in its own process
//!     group, with a scrubbed environment and the staging folder as working directory;
//!   - [`training_stop`] = Stop Early: the fixed ZMQ `{"command":"stop"}`, resent every 500 ms until
//!     sleap-nn exits (a PUB drops what it sends before the SUB connects). Never SIGINT: sleap-nn
//!     deletes its run folder on KeyboardInterrupt;
//!   - [`training_cancel`] = SIGTERM to the process group, SIGKILL after 5 s (Windows: `taskkill /T
//!     /F`); then the run folder this model created is deleted (only Rust can: it is read-only to
//!     the page). The token's remaining models are refused.
//!   - a finished model counts only with a `best.ckpt` and no `${` in its YAML files (sleap-nn copies
//!     node and track names into them, and OmegaConf resolves `${…}` on a later load).
//!
//! The commands are always registered; without the `sleap-nn` feature they answer
//! `Err("SLEAP_NN_NOT_IN_THIS_BUILD")`, except [`pick_runs_directory`] (a grant, harmless).
#![cfg_attr(not(feature = "sleap-nn"), allow(dead_code, unused_imports))]

use crate::files::GrantState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Prefix of every refusal.
pub const TRAINING_NOT_ALLOWED: &str = "TRAINING_NOT_ALLOWED: ";
/// Staging folders are `<temp>/<STAGING_PREFIX><random>`; stale ones are swept at startup.
pub const STAGING_PREFIX: &str = "lucid-train-";
pub const MAX_LIVE_RUNS: usize = 2;
pub const MAX_MODELS: usize = 64;
pub const MAX_VIDEOS: usize = 250;
pub const MAX_STAGED_BYTES: usize = 512 * 1024 * 1024;

fn refuse<T>(why: impl std::fmt::Display) -> Result<T, String> {
    Err(format!("{TRAINING_NOT_ALLOWED}{why}"))
}

/// What the page reads from a progress row's events.
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum TrainEvent {
    Stdout { line: String },
    Stderr { line: String },
    /// One sleap-nn progress message, cleaned: `event` (train_begin, epoch_begin, epoch_end,
    /// batch_start, batch_end, train_end), `epoch`, `batch`, numeric `logs` (non-finite → null,
    /// `nan: true`).
    #[serde(rename_all = "camelCase")]
    Progress { name: String, epoch: Option<i64>, batch: Option<i64>, logs: serde_json::Map<String, Value>, nan: bool },
    #[serde(rename_all = "camelCase")]
    Finished {
        success: bool,
        code: Option<i32>,
        stopped: bool,
        cancelled: bool,
        model_dir: Option<String>,
        error: Option<String>,
    },
}

/// The picked runs folder and how many trained runs it already holds (they become trusted like a
/// `pick_model_directory` pick).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsFolder {
    pub path: String,
    pub existing_runs: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareModel {
    pub config: Value,
    pub run_name: String,
    /// Start from a trained model (sleap-app's Fine-tune / Resume); none = from scratch.
    #[serde(default)]
    pub init: Option<PrepareInit>,
}

/// sleap-app's training modes other than "Train from scratch". The checkpoint is a PICKLE that
/// sleap-nn loads (`torch.load`), so it must lie inside a MODEL grant: a folder the user picked as
/// read-only (`pick_model_directory` / `pick_runs_directory`), which the page can never write into.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareInit {
    /// `"resume"` (sleap-nn `trainer_config.resume_ckpt_path`: optimizer, scheduler and epoch restored)
    /// or `"finetune"` (`model_config.pretrained_backbone_weights` + `pretrained_head_weights`: a new run
    /// seeded with the weights).
    pub mode: String,
    pub checkpoint: String,
}

/// What a model starts from once checked: the resolved checkpoint path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InitFrom {
    Resume(PathBuf),
    Finetune(PathBuf),
}

/// sleap-app's rule: Resume needs a Lightning `.ckpt`; Fine-tune also takes a legacy SLEAP `.h5`.
pub fn init_from(mode: &str, resolved: PathBuf) -> Result<InitFrom, String> {
    let ext = resolved.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match mode {
        "resume" if ext == "ckpt" => Ok(InitFrom::Resume(resolved)),
        "resume" => Err("Resume training needs a .ckpt file (.h5 is only supported for Fine-tune)".into()),
        "finetune" if ext == "ckpt" || ext == "h5" => Ok(InitFrom::Finetune(resolved)),
        "finetune" => Err("Fine-tune needs a .ckpt or .h5 file".into()),
        other => Err(format!("unknown training mode {other:?}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareArgs {
    pub runs_root: String,
    pub models: Vec<PrepareModel>,
    /// The training `.slp`, base64.
    pub train_slp: String,
    /// The validation `.slp`, base64 (none: sleap-nn splits the training file).
    pub val_slp: Option<String>,
    /// Each video of the files' shared video table, in order (`--video-paths`).
    pub video_paths: Vec<String>,
}

/// Run names: letters, digits, `_ . = -`, not starting with `.`.
pub fn valid_run_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.=-".contains(&b))
}

/// Keep a progress message's numbers only; non-finite values (jsonpickle writes bare NaN /
/// Infinity) become null and flag `nan`.
/// A cleaned progress message: (event, epoch, batch, numeric logs, had a non-finite number).
pub type Progress = (String, Option<i64>, Option<i64>, serde_json::Map<String, Value>, bool);

pub fn parse_progress(raw: &[u8]) -> Option<Progress> {
    if raw.len() > crate::zmtp::MAX_MESSAGE as usize {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    // serde_json refuses bare NaN / Infinity: spell them null first, remembering it.
    let mut nan = false;
    let mut cleaned = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            cleaned.push(c as char);
            if c == b'\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_str = true;
            cleaned.push('"');
            i += 1;
            continue;
        }
        let rest = &text[i..];
        let word = ["-Infinity", "Infinity", "NaN"].iter().find(|w| rest.starts_with(**w));
        if let Some(w) = word {
            cleaned.push_str("null");
            nan = true;
            i += w.len();
            continue;
        }
        cleaned.push(c as char);
        i += 1;
    }
    let v: Value = serde_json::from_str(&cleaned).ok()?;
    // Older sleap-nn nests the payload under `py_dict` (jsonpickle).
    let v = if v.get("event").is_none() { v.get("py/state").or_else(|| v.get("py_dict")).cloned().unwrap_or(v) } else { v };
    let name = v.get("event")?.as_str()?;
    if !matches!(name, "train_begin" | "train_end" | "epoch_begin" | "epoch_end" | "batch_start" | "batch_end") {
        return None;
    }
    let int = |k: &str| v.get(k).and_then(|x| x.as_i64());
    let mut logs = serde_json::Map::new();
    if let Some(o) = v.get("logs").and_then(|l| l.as_object()) {
        for (k, x) in o.iter().take(64) {
            if k.len() > 64 {
                continue;
            }
            match x {
                Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {
                    logs.insert(k.clone(), x.clone());
                }
                Value::Null => {
                    logs.insert(k.clone(), Value::Null);
                }
                _ => {}
            }
        }
    }
    Some((name.to_string(), int("epoch"), int("batch"), logs, nan))
}

// ---------------------------------------------------------------------------------------------
// Runs folder (always available)
// ---------------------------------------------------------------------------------------------

/// Trained runs directly under `dir`: subfolders holding a `.ckpt`.
pub fn count_runs(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            std::fs::read_dir(e.path())
                .map(|r| r.filter_map(Result::ok).any(|f| f.path().extension().is_some_and(|x| x == "ckpt")))
                .unwrap_or(false)
        })
        .count()
}

/// Pick the folder trained runs go to. It becomes a read-only MODEL grant (see the module doc);
/// refused when it holds a writable grant (the open project, a folder the page writes in).
#[tauri::command]
pub async fn pick_runs_directory<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    title: Option<String>,
) -> Result<Option<RunsFolder>, String> {
    let mut builder = app.dialog().file().set_parent(&window);
    builder = builder.set_title(title.unwrap_or_else(|| "Choose the runs folder".into()));
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_folder())
        .await
        .map_err(|e| format!("pick_runs_directory: {e}"))?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| format!("pick_runs_directory: {e}"))?;
    let resolved = crate::files::resolve_request(&path.to_string_lossy())?;
    let grants = Arc::clone(&*app.state::<Arc<GrantState>>());
    if let Some(g) = grants.normal_grant_under(&resolved)? {
        return refuse(format!(
            "{} holds {}, which the app saves to. Pick (or make) a folder for the models only, such as a models folder next to the project.",
            resolved.display(),
            g.display()
        ));
    }
    grants.grant_model_dir(&resolved)?;
    let existing_runs = count_runs(&resolved);
    Ok(Some(RunsFolder { path: resolved.to_string_lossy().into_owned(), existing_runs }))
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

/// Prepared / running training runs by token (tauri-managed, behind an Arc).
#[cfg(feature = "sleap-nn")]
#[derive(Default)]
pub struct TrainingState(pub Mutex<HashMap<String, Arc<imp::Run>>>);
#[cfg(not(feature = "sleap-nn"))]
#[derive(Default)]
pub struct TrainingState(());

#[tauri::command]
pub async fn training_prepare<R: Runtime>(app: AppHandle<R>, args: PrepareArgs) -> Result<String, String> {
    #[cfg(feature = "sleap-nn")]
    {
        let grants = Arc::clone(&*app.state::<Arc<GrantState>>());
        let state = app.state::<Arc<TrainingState>>().inner().clone();
        tauri::async_runtime::spawn_blocking(move || imp::prepare(&state, &grants, args))
            .await
            .map_err(|e| format!("training_prepare: {e}"))?
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, args);
        Err(crate::sleap_nn::NOT_IN_THIS_BUILD.into())
    }
}

#[tauri::command]
pub async fn training_run<R: Runtime>(
    app: AppHandle<R>,
    token: String,
    model_index: usize,
    dry_run: Option<bool>,
    on_event: Channel<TrainEvent>,
) -> Result<bool, String> {
    #[cfg(feature = "sleap-nn")]
    {
        let state = app.state::<Arc<TrainingState>>().inner().clone();
        tauri::async_runtime::spawn_blocking(move || imp::run(&state, &token, model_index, dry_run.unwrap_or(false), &on_event))
            .await
            .map_err(|e| format!("training_run: {e}"))?
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, token, model_index, dry_run, on_event);
        Err(crate::sleap_nn::NOT_IN_THIS_BUILD.into())
    }
}

/// Stop Early: sleap-nn finishes the batch, saves, and exits 0.
#[tauri::command]
pub fn training_stop<R: Runtime>(app: AppHandle<R>, token: String) -> Result<bool, String> {
    #[cfg(feature = "sleap-nn")]
    {
        imp::stop(&app.state::<Arc<TrainingState>>(), &token)
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, token);
        Err(crate::sleap_nn::NOT_IN_THIS_BUILD.into())
    }
}

/// Cancel: the process group is terminated; nothing else of this token runs.
#[tauri::command]
pub fn training_cancel<R: Runtime>(app: AppHandle<R>, token: String) -> Result<bool, String> {
    #[cfg(feature = "sleap-nn")]
    {
        imp::cancel(&app.state::<Arc<TrainingState>>(), &token)
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, token);
        Err(crate::sleap_nn::NOT_IN_THIS_BUILD.into())
    }
}

/// Forget a token and delete its staging folder (the page is done with it).
#[tauri::command]
pub fn training_release<R: Runtime>(app: AppHandle<R>, token: String) -> Result<(), String> {
    #[cfg(feature = "sleap-nn")]
    {
        imp::release(&app.state::<Arc<TrainingState>>(), &token)
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, token);
        Err(crate::sleap_nn::NOT_IN_THIS_BUILD.into())
    }
}

/// Delete staging folders a previous app run left behind (a crash, Dock ▸ Quit).
pub fn sweep_stale_staging() {
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in rd.filter_map(Result::ok) {
        let name = e.file_name();
        if name.to_string_lossy().starts_with(STAGING_PREFIX) && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(feature = "sleap-nn")]
pub mod imp {
    use super::*;
    use crate::train_config::{self, Forced};
    use crate::zmtp::{PubServer, SubListener, STOP_MESSAGE};
    use base64::Engine;
    use std::io::BufReader;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    pub struct Run {
        pub staging: PathBuf,
        pub runs_root: PathBuf,
        pub models: Vec<(Value, String, Option<InitFrom>)>,
        pub videos: Vec<String>,
        pub has_val: bool,
        pub next: Mutex<usize>,
        pub active: Mutex<Option<Active>>,
        pub cancelled: AtomicBool,
    }

    pub struct Active {
        pub stop: Arc<AtomicBool>,
        pub cancel: Arc<AtomicBool>,
    }

    fn random_hex() -> String {
        let mut b = [0u8; 16];
        // /dev/urandom-free: hash time, pid and a counter; unguessable enough for a local token
        // and folder name, and the folder is created exclusively (0700) anyway.
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        for chunk in b.chunks_mut(8) {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            h.write_u32(std::process::id());
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn make_private_dir(p: &Path) -> std::io::Result<()> {
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(p)
    }

    pub fn prepare(state: &TrainingState, grants: &GrantState, a: PrepareArgs) -> Result<String, String> {
        if a.models.is_empty() || a.models.len() > MAX_MODELS {
            return refuse(format!("1 to {MAX_MODELS} models per run"));
        }
        if a.video_paths.is_empty() || a.video_paths.len() > MAX_VIDEOS {
            return refuse(format!("1 to {MAX_VIDEOS} videos per run (train fewer views per model)"));
        }
        // The runs folder: inside a model grant, an existing folder.
        let root = grants.check_model(&a.runs_root).map_err(|e| format!("{TRAINING_NOT_ALLOWED}runs folder: {e}"))?;
        if !root.is_dir() {
            return refuse(format!("runs folder {} does not exist", root.display()));
        }
        let cpus = std::thread::available_parallelism().map(|n| n.get() as u64).unwrap_or(4);
        let table = train_config::table();
        // A sleap-nn bump that adds a key Rust must own fails here, not silently.
        train_config::forced_keys_handled(table)?;
        let mut models = Vec::new();
        let mut names = std::collections::HashSet::new();
        for (i, m) in a.models.into_iter().enumerate() {
            if !valid_run_name(&m.run_name) {
                return refuse(format!("model {i}: run name {:?} is not allowed", m.run_name));
            }
            if !names.insert(m.run_name.clone()) || root.join(&m.run_name).exists() {
                return refuse(format!("a run named {} already exists in the runs folder", m.run_name));
            }
            train_config::check(&m.config, table, cpus).map_err(|e| format!("{TRAINING_NOT_ALLOWED}model {i}: {e}"))?;
            let init = match m.init {
                None => None,
                Some(init) => {
                    // Inside a model grant (read-only to the page), an existing file of the right kind.
                    let p = grants.check_model(&init.checkpoint).map_err(|e| format!("{TRAINING_NOT_ALLOWED}model {i} checkpoint: {e}"))?;
                    if !p.is_file() {
                        return refuse(format!("model {i}: checkpoint {} is not an existing file", p.display()));
                    }
                    Some(init_from(&init.mode, p).map_err(|e| format!("{TRAINING_NOT_ALLOWED}model {i}: {e}"))?)
                }
            };
            models.push((m.config, m.run_name, init));
        }
        let mut videos = Vec::new();
        for v in &a.video_paths {
            if v.contains("://") {
                return refuse(format!("{v} is a URL, not a video file"));
            }
            let p = grants.check_readable(v).map_err(|e| format!("{TRAINING_NOT_ALLOWED}video: {e}"))?;
            if !p.is_file() {
                return refuse(format!("{v} is not an existing file"));
            }
            videos.push(p.to_string_lossy().into_owned());
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let train = b64.decode(a.train_slp.as_bytes()).map_err(|e| format!("{TRAINING_NOT_ALLOWED}training file: {e}"))?;
        let val = match a.val_slp {
            Some(s) => Some(b64.decode(s.as_bytes()).map_err(|e| format!("{TRAINING_NOT_ALLOWED}validation file: {e}"))?),
            None => None,
        };
        if train.len() + val.as_ref().map_or(0, Vec::len) > MAX_STAGED_BYTES {
            return refuse("the training data is over 512 MB");
        }
        let mut runs = state.0.lock().map_err(|e| e.to_string())?;
        if runs.len() >= MAX_LIVE_RUNS {
            return refuse("another training run is still prepared or running");
        }
        let token = random_hex();
        let staging = std::env::temp_dir().join(format!("{STAGING_PREFIX}{token}"));
        make_private_dir(&staging).map_err(|e| format!("staging folder: {e}"))?;
        let write = |name: &str, bytes: &[u8]| std::fs::write(staging.join(name), bytes).map_err(|e| format!("staging {name}: {e}"));
        if let Err(e) = write("train.slp", &train).and_then(|_| match &val { Some(v) => write("val.slp", v), None => Ok(()) }) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        runs.insert(
            token.clone(),
            Arc::new(Run {
                staging,
                runs_root: root,
                models,
                videos,
                has_val: val.is_some(),
                next: Mutex::new(0),
                active: Mutex::new(None),
                cancelled: AtomicBool::new(false),
            }),
        );
        Ok(token)
    }

    fn get(state: &TrainingState, token: &str) -> Result<Arc<Run>, String> {
        state.0.lock().map_err(|e| e.to_string())?.get(token).cloned().ok_or_else(|| format!("{TRAINING_NOT_ALLOWED}unknown or finished training run"))
    }

    pub fn release(state: &TrainingState, token: &str) -> Result<(), String> {
        let run = state.0.lock().map_err(|e| e.to_string())?.remove(token);
        if let Some(r) = run {
            let _ = std::fs::remove_dir_all(&r.staging);
        }
        Ok(())
    }

    /// Environment variables a training child keeps (plus the augmented PATH). No tokens or
    /// credentials (HF_TOKEN, cloud keys, W&B), no PYTHONPATH / PYTHONHOME.
    pub fn keep_env(name: &str) -> bool {
        const EXACT: &[&str] = &[
            "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TZ",
            "SYSTEMROOT", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
            "PROGRAMFILES", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
            "XDG_CACHE_HOME", "TORCH_HOME", "PYTORCH_ENABLE_MPS_FALLBACK", "OMP_NUM_THREADS",
            "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
        ];
        EXACT.contains(&name) || name.starts_with("LC_") || name.starts_with("CUDA_") || name.starts_with("NVIDIA_") || name.starts_with("CUDNN_")
    }

    fn child_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        let mut env: Vec<_> = crate::sleap_nn::imp::child_env()
            .into_iter()
            .filter(|(k, _)| k == "PATH" || k.to_str().is_some_and(keep_env))
            .collect();
        env.push(("WANDB_MODE".into(), "disabled".into()));
        env.push(("PYTHONUNBUFFERED".into(), "1".into()));
        env
    }

    fn pump<T: std::io::Read + Send + 'static>(pipe: T, on_event: Channel<TrainEvent>, err: bool) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            loop {
                let mut buf = Vec::new();
                match tauri::utils::io::read_line(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        let _ = on_event.send(if err { TrainEvent::Stderr { line } } else { TrainEvent::Stdout { line } });
                    }
                }
            }
        })
    }

    fn signal_group(child: &Child, kill: bool) {
        #[cfg(unix)]
        {
            let pid = child.id() as libc::pid_t;
            // process_group(0): the group id is the child's pid.
            unsafe {
                libc::kill(-pid, if kill { libc::SIGKILL } else { libc::SIGTERM });
            }
        }
        #[cfg(windows)]
        {
            let _ = kill;
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &child.id().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    /// The run folder lives inside `root` (no `..`, no link out): safe to delete.
    fn inside(root: &Path, p: &Path) -> bool {
        match (root.canonicalize(), p.canonicalize()) {
            (Ok(r), Ok(q)) => q.starts_with(&r) && q != r,
            _ => false,
        }
    }

    /// Any `${` in the run's YAML files (the run is then not offered for use).
    fn yaml_has_interpolation(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(Result::ok).any(|e| {
                    let p = e.path();
                    p.extension().is_some_and(|x| x == "yaml" || x == "yml")
                        && std::fs::read_to_string(&p).map(|t| t.contains("${")).unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    pub fn run(state: &TrainingState, token: &str, model_index: usize, dry_run: bool, on_event: &Channel<TrainEvent>) -> Result<bool, String> {
        let run = get(state, token)?;
        {
            let mut next = run.next.lock().map_err(|e| e.to_string())?;
            if run.cancelled.load(Ordering::SeqCst) {
                return refuse("this training run was cancelled");
            }
            if model_index != *next || model_index >= run.models.len() {
                return refuse(format!("model {model_index} is not the next model of this run"));
            }
            if run.active.lock().map_err(|e| e.to_string())?.is_some() {
                return refuse("a model of this run is already training");
            }
            *next += 1;
        }
        let (config, run_name, init) = &run.models[model_index];
        let run_dir = run.runs_root.join(run_name);
        if run_dir.exists() {
            return refuse(format!("{} already exists", run_dir.display()));
        }

        let ev = on_event.clone();
        let sub = SubListener::bind_local(move |raw| {
            if let Some((name, epoch, batch, logs, nan)) = parse_progress(&raw) {
                let _ = ev.send(TrainEvent::Progress { name, epoch, batch, logs, nan });
            }
        })
        .map_err(|e| format!("progress socket: {e}"))?;
        let pubs = Arc::new(PubServer::bind_local().map_err(|e| format!("control socket: {e}"))?);

        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        let train = s(run.staging.join("train.slp"));
        let val = run.has_val.then(|| s(run.staging.join("val.slp")));
        let cache = s(run.staging.join(format!("cache_{model_index}")));
        let root = s(run.runs_root.clone());
        let (resume, finetune) = match init {
            Some(InitFrom::Resume(p)) => (Some(s(p.clone())), None),
            Some(InitFrom::Finetune(p)) => (None, Some(s(p.clone()))),
            None => (None, None),
        };
        let forced = Forced {
            train_labels: &train,
            val_labels: val.as_deref(),
            cache_dir: &cache,
            ckpt_dir: &root,
            run_name,
            resume_ckpt: resume.as_deref(),
            pretrained_backbone: finetune.as_deref(),
            pretrained_head: finetune.as_deref(),
            controller_port: pubs.port(),
            publish_port: sub.port(),
        };
        let cfg = train_config::finalize(config, &forced, train_config::table());
        let cfg_path = run.staging.join(format!("config_{model_index}.yaml"));
        std::fs::write(&cfg_path, train_config::to_yaml(&cfg)).map_err(|e| format!("config: {e}"))?;

        let (_, program) = crate::sleap_nn::imp::resolve_program("sleap-nn")?;
        let mut argv: Vec<String> = vec!["train".into(), "--config".into(), s(cfg_path)];
        for v in &run.videos {
            argv.push("--video-paths".into());
            argv.push(v.clone());
        }
        if dry_run {
            argv.push("--dry-run".into());
        }
        let mut cmd = Command::new(&program);
        cmd.args(&argv)
            .current_dir(&run.staging)
            .env_clear()
            .envs(child_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Failed to start sleap-nn: {e}"))?;
        let _ = on_event.send(TrainEvent::Stdout { line: format!("$ sleap-nn {}\n", argv.join(" ")) });
        let out = child.stdout.take().map(|p| pump(p, on_event.clone(), false));
        let err = child.stderr.take().map(|p| pump(p, on_event.clone(), true));
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        *run.active.lock().map_err(|e| e.to_string())? = Some(Active { stop: Arc::clone(&stop), cancel: Arc::clone(&cancel) });

        let mut last_stop = Instant::now() - Duration::from_secs(1);
        let mut term_at: Option<Instant> = None;
        let mut killed = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) => {}
                Err(_) => break None,
            }
            if cancel.load(Ordering::SeqCst) {
                match term_at {
                    None => {
                        signal_group(&child, false);
                        term_at = Some(Instant::now());
                    }
                    Some(t) if !killed && t.elapsed() > Duration::from_secs(5) => {
                        signal_group(&child, true);
                        killed = true;
                    }
                    _ => {}
                }
            } else if stop.load(Ordering::SeqCst) && last_stop.elapsed() >= Duration::from_millis(500) {
                pubs.send(STOP_MESSAGE);
                last_stop = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        // Make sure nothing of the group outlives the run (dataloader workers).
        if cancel.load(Ordering::SeqCst) {
            signal_group(&child, true);
        }
        for h in [out, err].into_iter().flatten() {
            let _ = h.join();
        }
        sub.close();
        pubs.close();
        *run.active.lock().map_err(|e| e.to_string())? = None;

        let code = status.and_then(|s| s.code());
        let cancelled = cancel.load(Ordering::SeqCst);
        let stopped = stop.load(Ordering::SeqCst);
        let mut success = code == Some(0) && !cancelled;
        let mut error = None;
        let mut model_dir = None;
        if cancelled {
            if run_dir.exists() && inside(&run.runs_root, &run_dir) {
                let _ = std::fs::remove_dir_all(&run_dir);
            }
        } else if success && !dry_run {
            if !run_dir.join("best.ckpt").is_file() {
                success = false;
                error = Some(if stopped {
                    "Stopped before the first checkpoint was saved: no model.".into()
                } else {
                    "sleap-nn finished without saving best.ckpt.".into()
                });
                if run_dir.exists() && inside(&run.runs_root, &run_dir) {
                    let _ = std::fs::remove_dir_all(&run_dir);
                }
            } else if yaml_has_interpolation(&run_dir) {
                success = false;
                error = Some("The run's config contains \"${\" (a config variable); it is not offered for use.".into());
            } else {
                model_dir = Some(s(run_dir.clone()));
            }
        }
        let last = model_index + 1 >= run.models.len();
        if cancelled || !success || last {
            if cancelled {
                run.cancelled.store(true, Ordering::SeqCst);
            }
            if !dry_run || last {
                let _ = release(state, token);
            }
        }
        let _ = on_event.send(TrainEvent::Finished { success, code, stopped, cancelled, model_dir, error });
        Ok(success)
    }

    pub fn stop(state: &TrainingState, token: &str) -> Result<bool, String> {
        let run = get(state, token)?;
        let a = run.active.lock().map_err(|e| e.to_string())?;
        Ok(match a.as_ref() {
            Some(x) => {
                x.stop.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        })
    }

    pub fn cancel(state: &TrainingState, token: &str) -> Result<bool, String> {
        let run = get(state, token)?;
        run.cancelled.store(true, Ordering::SeqCst);
        let a = run.active.lock().map_err(|e| e.to_string())?;
        match a.as_ref() {
            Some(x) => {
                x.cancel.store(true, Ordering::SeqCst);
                Ok(true)
            }
            None => {
                drop(a);
                release(state, token)?;
                Ok(false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_names() {
        assert!(valid_run_name("251123_142211.centroid.cam2.n=69"));
        for bad in ["", ".x", "..", "a/b", "a\\b", "a b", "x${y}"] {
            assert!(!valid_run_name(bad), "{bad}");
        }
    }

    #[test]
    fn progress_messages_keep_numbers_only_and_survive_nan() {
        let (n, e, b, logs, nan) = parse_progress(br#"{"what": "", "event": "epoch_end", "logs": {"train/loss": 0.5, "val/loss": NaN, "lr": "x"}, "epoch": 3}"#).unwrap();
        assert_eq!((n.as_str(), e, b, nan), ("epoch_end", Some(3), None, true));
        assert_eq!(logs.get("train/loss"), Some(&serde_json::json!(0.5)));
        assert_eq!(logs.get("val/loss"), Some(&Value::Null));
        assert!(logs.get("lr").is_none(), "strings are dropped");
        let (n, _, b, _, nan) = parse_progress(br#"{"event": "batch_end", "epoch": 0, "batch": 7, "logs": {"loss": -Infinity}}"#).unwrap();
        assert_eq!((n.as_str(), b, nan), ("batch_end", Some(7), true));
        // "NaN" inside a string is text, not a number.
        let (_, _, _, _, nan) = parse_progress(br#"{"event": "train_begin", "wandb_url": "NaN", "logs": null}"#).unwrap();
        assert!(!nan);
        assert!(parse_progress(br#"{"event": "rm -rf"}"#).is_none(), "unknown events are dropped");
        assert!(parse_progress(b"not json").is_none());
    }

    #[test]
    fn init_modes_follow_sleap_app() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(init_from("resume", p("/m/last.ckpt")), Ok(InitFrom::Resume(p("/m/last.ckpt"))));
        assert_eq!(init_from("finetune", p("/m/best.CKPT")), Ok(InitFrom::Finetune(p("/m/best.CKPT"))));
        assert_eq!(init_from("finetune", p("/m/best_model.h5")), Ok(InitFrom::Finetune(p("/m/best_model.h5"))));
        assert!(init_from("resume", p("/m/best_model.h5")).unwrap_err().contains("needs a .ckpt"));
        assert!(init_from("finetune", p("/m/model.pt")).is_err());
        assert!(init_from("finetune", p("/m/ckpt")).is_err(), "no extension");
        assert!(init_from("scratch", p("/m/best.ckpt")).is_err());
    }

    /// A checkpoint is a pickle sleap-nn loads: prepare takes it only from inside a MODEL grant
    /// (read-only to the page), as an existing file of the mode's kind, and keeps the resolved path.
    #[cfg(feature = "sleap-nn")]
    #[test]
    fn prepare_takes_checkpoints_only_from_model_grants() {
        let base = std::env::temp_dir().join(format!("lucid-init-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (runs, models, data) = (base.join("runs"), base.join("models"), base.join("data"));
        for d in [&runs, &models.join("m1"), &data] {
            std::fs::create_dir_all(d).unwrap();
        }
        for f in [models.join("m1/best.ckpt"), models.join("m1/best_model.h5"), data.join("x.ckpt"), data.join("v.mp4")] {
            std::fs::write(f, b"x").unwrap();
        }
        let grants = GrantState::default();
        grants.grant_model_dir(&runs).unwrap();
        grants.grant_model_dir(&models).unwrap();
        grants.0.lock().unwrap().grant_dir(&data.canonicalize().unwrap());
        let state = TrainingState::default();
        let prep = |mode: &str, ckpt: PathBuf| {
            let r = imp::prepare(
                &state,
                &grants,
                PrepareArgs {
                    runs_root: runs.to_string_lossy().into_owned(),
                    models: vec![PrepareModel {
                        config: serde_json::json!({}),
                        run_name: "r1".into(),
                        init: Some(PrepareInit { mode: mode.into(), checkpoint: ckpt.to_string_lossy().into_owned() }),
                    }],
                    train_slp: "AA==".into(),
                    val_slp: None,
                    video_paths: vec![data.join("v.mp4").to_string_lossy().into_owned()],
                },
            );
            if let Ok(t) = &r {
                imp::release(&state, t).unwrap();
            }
            r
        };
        assert!(prep("finetune", models.join("m1/best.ckpt")).is_ok());
        assert!(prep("finetune", models.join("m1/best_model.h5")).is_ok());
        assert!(prep("resume", models.join("m1/best.ckpt")).is_ok());
        let e = prep("finetune", data.join("x.ckpt")).unwrap_err();
        assert!(e.starts_with(TRAINING_NOT_ALLOWED), "a writable folder's checkpoint is refused: {e}");
        assert!(prep("resume", models.join("m1/best_model.h5")).unwrap_err().contains("needs a .ckpt"));
        assert!(prep("finetune", models.join("m1/missing.ckpt")).is_err());
        assert!(prep("finetune", models.join("m1")).is_err(), "a folder is not a checkpoint");
        // The run keeps the resolved path for the forced config.
        let t = imp::prepare(
            &state,
            &grants,
            PrepareArgs {
                runs_root: runs.to_string_lossy().into_owned(),
                models: vec![PrepareModel {
                    config: serde_json::json!({}),
                    run_name: "r2".into(),
                    init: Some(PrepareInit { mode: "resume".into(), checkpoint: models.join("m1/best.ckpt").to_string_lossy().into_owned() }),
                }],
                train_slp: "AA==".into(),
                val_slp: None,
                video_paths: vec![data.join("v.mp4").to_string_lossy().into_owned()],
            },
        )
        .unwrap();
        let run = state.0.lock().unwrap().get(&t).cloned().unwrap();
        assert_eq!(run.models[0].2, Some(InitFrom::Resume(models.join("m1/best.ckpt").canonicalize().unwrap())));
        imp::release(&state, &t).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(feature = "sleap-nn")]
    #[test]
    fn training_children_keep_no_credentials() {
        for k in ["HOME", "PATH_NOT", "LC_ALL", "CUDA_VISIBLE_DEVICES", "TMPDIR"] {
            let keep = imp::keep_env(k);
            assert_eq!(keep, k != "PATH_NOT", "{k}");
        }
        for k in ["HF_TOKEN", "WANDB_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "PYTHONPATH", "PYTHONHOME", "OPENAI_API_KEY"] {
            assert!(!imp::keep_env(k), "{k}");
        }
    }

    /// A REAL `sleap-nn train` through the whole Rust path: prepare (config check, staging,
    /// grants) → run (ZMQ progress, forced config, --video-paths) → best.ckpt; then Stop Early
    /// on a long run (ZMQ stop, model kept) and Cancel (process group, run folder deleted).
    /// Needs sleap-nn and a fixture:
    ///   ~/.local/share/uv/tools/sleap-nn/bin/python3 -I scripts/make_training_fixture.py DIR
    ///   LUCID_TRAIN_FIXTURE=DIR cargo test --features sleap-nn real_training -- --ignored --nocapture
    #[cfg(feature = "sleap-nn")]
    #[test]
    #[ignore]
    fn real_training_run_stop_and_cancel() {
        use base64::Engine;
        use std::sync::atomic::Ordering;
        let Ok(dir) = std::env::var("LUCID_TRAIN_FIXTURE") else {
            eprintln!("LUCID_TRAIN_FIXTURE not set: skipped");
            return;
        };
        let dir = PathBuf::from(dir).canonicalize().unwrap();
        let runs = dir.join("runs");
        let _ = std::fs::remove_dir_all(&runs);
        std::fs::create_dir_all(&runs).unwrap();
        let grants = GrantState::default();
        grants.grant_model_dir(&runs).unwrap();
        grants.0.lock().unwrap().grant_file(&dir.join("video.mp4"));
        let state = TrainingState::default();
        let b64 = |p: &str| base64::engine::general_purpose::STANDARD.encode(std::fs::read(dir.join(p)).unwrap());
        let config: Value = serde_json::from_slice(&std::fs::read(dir.join("config.json")).unwrap()).unwrap();
        let prepare_from = |name: &str, epochs: i64, init: Option<PrepareInit>| {
            let mut cfg = config.clone();
            cfg["trainer_config"]["max_epochs"] = Value::from(epochs);
            imp::prepare(
                &state,
                &grants,
                PrepareArgs {
                    runs_root: runs.to_string_lossy().into_owned(),
                    models: vec![PrepareModel { config: cfg, run_name: name.into(), init }],
                    train_slp: b64("train.slp"),
                    val_slp: Some(b64("val.slp")),
                    video_paths: vec![dir.join("video.mp4").to_string_lossy().into_owned()],
                },
            )
            .unwrap()
        };
        let prepare = |name: &str, epochs: i64| prepare_from(name, epochs, None);
        let recording = || {
            let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
            let sink = Arc::clone(&seen);
            let ch: Channel<TrainEvent> = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                    sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
                }
                Ok(())
            });
            (ch, seen)
        };
        let finished = |seen: &Arc<Mutex<Vec<Value>>>| seen.lock().unwrap().iter().find(|e| e["event"] == "finished").cloned().unwrap();
        let progress = |seen: &Arc<Mutex<Vec<Value>>>, name: &str| {
            seen.lock().unwrap().iter().filter(|e| e["event"] == "progress" && e["data"]["name"] == name).count()
        };

        // 1. A full short run.
        let token = prepare("run.full", 3);
        let staging = state.0.lock().unwrap().get(&token).unwrap().staging.clone();
        let (ch, seen) = recording();
        let ok = imp::run(&state, &token, 0, false, &ch).unwrap();
        let fin = finished(&seen);
        if !ok {
            for e in seen.lock().unwrap().iter().filter(|e| e["event"] == "stderr").rev().take(30) {
                eprintln!("{}", e["data"]["line"]);
            }
        }
        assert!(ok, "the run succeeded: {fin}");
        assert_eq!(progress(&seen, "epoch_end"), 3, "three epoch_end messages over ZMQ");
        assert!(progress(&seen, "batch_end") >= 3, "batch losses over ZMQ");
        assert!(progress(&seen, "train_begin") == 1);
        let model_dir = PathBuf::from(fin["data"]["modelDir"].as_str().unwrap());
        if let Ok(cap) = std::env::var("LUCID_TRAIN_CAPTURE") {
            // The e2e fixture (tests/fixtures/sleap-nn-training/): this run's events, as the page gets them.
            let events = seen.lock().unwrap().clone();
            std::fs::write(&cap, serde_json::to_string_pretty(&events).unwrap()).unwrap();
            if let Some(png) = std::fs::read_dir(model_dir.join("viz")).ok().and_then(|rd| {
                rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.to_string_lossy().contains("validation.")).max()
            }) {
                std::fs::copy(&png, PathBuf::from(&cap).with_file_name("validation-sample.png")).unwrap();
            }
        }
        assert_eq!(model_dir, runs.join("run.full"));
        assert!(model_dir.join("best.ckpt").is_file());
        assert!(model_dir.join("training_config.yaml").is_file());
        let saved = std::fs::read_to_string(model_dir.join("training_config.yaml")).unwrap();
        assert!(!saved.contains("api_key: secret") && saved.contains("run.full"));
        assert!(!staging.exists(), "the staging folder is gone after the last model");
        assert!(state.0.lock().unwrap().get(&token).is_none(), "the token is spent");
        assert!(imp::run(&state, &token, 0, false, &ch).unwrap_err().contains("unknown or finished"));

        // 2. Stop Early on a long run: the model is kept, the exit is clean.
        let token = prepare("run.stopped", 500);
        let (ch, seen) = recording();
        let st = Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::scope(|sc| {
            let st2 = Arc::clone(&st);
            let seen2 = Arc::clone(&seen);
            let state_ref = &state;
            let tok = token.clone();
            sc.spawn(move || {
                // Stop after the second epoch (a best.ckpt exists by then).
                let t0 = std::time::Instant::now();
                while t0.elapsed() < std::time::Duration::from_secs(300) {
                    let n = seen2.lock().unwrap().iter().filter(|e| e["event"] == "progress" && e["data"]["name"] == "epoch_end").count();
                    if n >= 2 {
                        st2.store(imp::stop(state_ref, &tok).unwrap(), Ordering::SeqCst);
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            });
            let ok = imp::run(&state, &token, 0, false, &ch).unwrap();
            assert!(ok, "a stopped run still succeeds: {}", finished(&seen));
        });
        assert!(st.load(Ordering::SeqCst), "stop reached the running model");
        let fin = finished(&seen);
        assert_eq!(fin["data"]["stopped"], Value::Bool(true));
        assert!(progress(&seen, "epoch_end") < 500);
        assert!(runs.join("run.stopped").join("best.ckpt").is_file(), "Stop Early keeps the model");

        // 3. Cancel: the group is terminated, the run folder removed, nothing else runs.
        let token = prepare("run.cancelled", 500);
        let (ch, seen) = recording();
        std::thread::scope(|sc| {
            let seen2 = Arc::clone(&seen);
            let state_ref = &state;
            let tok = token.clone();
            sc.spawn(move || {
                let t0 = std::time::Instant::now();
                while t0.elapsed() < std::time::Duration::from_secs(300) {
                    if seen2.lock().unwrap().iter().any(|e| e["event"] == "progress" && e["data"]["name"] == "epoch_end") {
                        imp::cancel(state_ref, &tok).unwrap();
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            });
            assert!(!imp::run(&state, &token, 0, false, &ch).unwrap());
        });
        let fin = finished(&seen);
        assert_eq!(fin["data"]["cancelled"], Value::Bool(true));
        assert!(!runs.join("run.cancelled").exists(), "the cancelled run's folder is deleted");
        assert!(state.0.lock().unwrap().is_empty(), "no token left");

        // 4. Fine-tune from run.full's checkpoint (inside the runs folder, a model grant): a new run
        //    seeded with its weights; sleap-nn records the checkpoint in the run's config.
        let ckpt = runs.join("run.full").join("best.ckpt").to_string_lossy().into_owned();
        let token = prepare_from("run.finetuned", 2, Some(PrepareInit { mode: "finetune".into(), checkpoint: ckpt.clone() }));
        let (ch, seen) = recording();
        assert!(imp::run(&state, &token, 0, false, &ch).unwrap(), "fine-tune succeeded: {}", finished(&seen));
        assert_eq!(progress(&seen, "epoch_end"), 2);
        assert!(runs.join("run.finetuned/best.ckpt").is_file());
        let saved = std::fs::read_to_string(runs.join("run.finetuned/training_config.yaml")).unwrap();
        assert!(saved.contains("pretrained_backbone_weights") && saved.contains("run.full/best.ckpt"), "the weights it started from are recorded");

        // 5. Resume run.full (3 epochs done) up to 5: sleap-nn restores the epoch and trains the rest.
        let token = prepare_from("run.resumed", 5, Some(PrepareInit { mode: "resume".into(), checkpoint: ckpt }));
        let (ch, seen) = recording();
        assert!(imp::run(&state, &token, 0, false, &ch).unwrap(), "resume succeeded: {}", finished(&seen));
        let ends = progress(&seen, "epoch_end");
        assert!((1..5).contains(&ends), "a resumed run trains only the epochs left ({ends})");
        assert!(runs.join("run.resumed/best.ckpt").is_file());
    }

    #[test]
    fn count_runs_counts_folders_with_a_checkpoint() {
        let d = std::env::temp_dir().join(format!("lucid-test-runs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("r1")).unwrap();
        std::fs::write(d.join("r1").join("best.ckpt"), b"x").unwrap();
        std::fs::create_dir_all(d.join("empty")).unwrap();
        std::fs::write(d.join("notes.txt"), b"x").unwrap();
        assert_eq!(count_runs(&d), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
