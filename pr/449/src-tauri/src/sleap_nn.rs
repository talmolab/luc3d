//! sleap-nn seam: run a local Python/uv process and stream its output.
//!
//! Ported from sleap-app's `environment.rs` (`run_python_command`,
//! `cancel_command`, `detect_uv`, `detect_gpu`) so its frontend code ports
//! over unchanged, but on `std::process` + threads instead of
//! tauri-plugin-shell, so the default build carries no shell plugin.
//!
//! The commands are ALWAYS registered with the same signatures; without the
//! `sleap-nn` cargo feature they answer `Err("SLEAP_NN_NOT_IN_THIS_BUILD")`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
#[cfg(feature = "sleap-nn")]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, Runtime};

#[cfg_attr(feature = "sleap-nn", allow(dead_code))]
pub const NOT_IN_THIS_BUILD: &str = "SLEAP_NN_NOT_IN_THIS_BUILD";

/// Events streamed by `run_python_command` (same JSON as sleap-app).
// Only constructed by the feature-gated implementation; the type stays in the
// default build so the command signatures do not change with the feature.
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ProcessEvent {
    Stdout { line: String },
    Stderr { line: String },
    Finished { success: bool, code: Option<i32> },
}

/// sleap-app's `UvInfo` shape.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvInfo {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub python_dir: Option<String>,
    /// None = unknown (offline, timed out, package-manager install).
    pub update_available: Option<bool>,
    pub latest_version: Option<String>,
    pub self_update_supported: Option<bool>,
}

/// What `detect_sleap_nn` reports.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleapNnInfo {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SleapNnStatus {
    pub available: bool,
    pub reason: String,
}

/// The children spawned by `run_python_command`, by job id, kept so
/// `cancel_command` can kill them. Several jobs may run at once (one per
/// camera, say), up to `MAX_CONCURRENT_JOBS`.
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
#[derive(Default)]
pub struct RunningProcess(pub Mutex<HashMap<String, std::process::Child>>);

#[tauri::command]
pub fn sleap_nn_status() -> SleapNnStatus {
    if cfg!(feature = "sleap-nn") {
        SleapNnStatus {
            available: true,
            reason: String::new(),
        }
    } else {
        SleapNnStatus {
            available: false,
            reason: "not included in this build".into(),
        }
    }
}

/// The job id used when the page passes none (sleap-app's one-command world).
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
pub const DEFAULT_JOB: &str = "default";
/// At most this many commands run at the same time.
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
pub const MAX_CONCURRENT_JOBS: usize = 4;

/// Spawn `program args...`, streaming each stdout/stderr line and a final
/// `finished` event through `on_event`. Resolves to whether it exited 0.
///
/// `program` is NOT a free path: it must name one of `ALLOWED_PROGRAMS`
/// ("uv", "sleap-nn", "sleap-nn-python") or equal the path Rust resolves for
/// one of them (what `detect_uv` reported), and Rust spawns its own
/// resolution. Any page-realm script can reach this command, so it must not
/// be a generic "run this executable" primitive: the ARGUMENTS are validated
/// too (`sleap_nn_args::validate_invocation`; refusals start `ARGS_NOT_ALLOWED: `),
/// with every path checked against the user's folder grants.
///
/// `job_id` (JS `jobId`, default "default") names the run so several can go
/// at once and `cancel_command` can stop one. Refusals: a job with that id is
/// already running ("A command is already running"), `TOO_MANY_JOBS`
/// (4 running), `INVALID_JOB_ID`.
#[tauri::command]
pub async fn run_python_command<R: Runtime>(
    app: AppHandle<R>,
    program: String,
    args: Vec<String>,
    on_event: Channel<ProcessEvent>,
    job_id: Option<String>,
) -> Result<bool, String> {
    #[cfg(feature = "sleap-nn")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let job = imp::job_id(job_id)?;
            let (logical, path) = imp::resolve_program(&program)?;
            let grants =
                std::sync::Arc::clone(&*app.state::<std::sync::Arc<crate::files::GrantState>>());
            let argv = crate::sleap_nn_args::validate_invocation(
                logical,
                &args,
                &imp::GrantPolicy(grants),
            )?;
            imp::run(
                &app.state::<RunningProcess>(),
                &job,
                &path,
                &argv,
                &on_event,
            )
        })
        .await
        .map_err(|e| format!("run_python_command: {e}"))?
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, program, args, on_event, job_id);
        Err(NOT_IN_THIS_BUILD.into())
    }
}

/// Kill the job `job_id` (JS `jobId`), or ALL running jobs when none is given.
#[tauri::command]
pub fn cancel_command(
    running: tauri::State<'_, RunningProcess>,
    job_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "sleap-nn")]
    {
        imp::cancel(&running, job_id.as_deref())
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (running, job_id);
        Err(NOT_IN_THIS_BUILD.into())
    }
}

#[tauri::command]
pub async fn detect_uv() -> Result<UvInfo, String> {
    #[cfg(feature = "sleap-nn")]
    {
        tauri::async_runtime::spawn_blocking(imp::detect_uv)
            .await
            .map_err(|e| format!("detect_uv: {e}"))
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        Err(NOT_IN_THIS_BUILD.into())
    }
}

/// Find the `sleap-nn` tool and ask it for its version.
#[tauri::command]
pub async fn detect_sleap_nn() -> Result<SleapNnInfo, String> {
    #[cfg(feature = "sleap-nn")]
    {
        tauri::async_runtime::spawn_blocking(imp::detect_sleap_nn)
            .await
            .map_err(|e| format!("detect_sleap_nn: {e}"))
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        Err(NOT_IN_THIS_BUILD.into())
    }
}

/// "cuda" if nvidia-smi sees a GPU, "mps" on Apple Silicon, else "cpu".
#[tauri::command]
pub async fn detect_gpu() -> Result<String, String> {
    #[cfg(feature = "sleap-nn")]
    {
        tauri::async_runtime::spawn_blocking(imp::detect_gpu)
            .await
            .map_err(|e| format!("detect_gpu: {e}"))
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        Err(NOT_IN_THIS_BUILD.into())
    }
}

#[cfg(feature = "sleap-nn")]
mod imp {
    use super::{
        ProcessEvent, RunningProcess, SleapNnInfo, UvInfo, DEFAULT_JOB, MAX_CONCURRENT_JOBS,
    };
    use crate::files::GrantState;
    use crate::sleap_nn_args::PathPolicy;
    use std::ffi::{OsStr, OsString};
    use std::io::BufReader;
    use std::path::PathBuf;
    use std::process::{Command, Output, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::ipc::Channel;

    // --- PATH / environment ----------------------------------------------
    //
    // The INSTALLED app is launched by the GUI layer (LaunchServices, a
    // desktop session), not a login shell, so it inherits a minimal PATH that
    // excludes ~/.local/bin, where the astral installer puts `uv` and the
    // uv-tool shims (`sleap-nn`). Under `tauri dev` the terminal's PATH hides
    // this. Hence: resolve uv to an absolute path, and prepend the well-known
    // tool dirs to every child's PATH.

    /// Directories that hold `uv` / uv-tool shims, in preference order.
    pub fn tool_bin_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
        }
        #[cfg(target_os = "macos")]
        {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        }
        dirs
    }

    fn augmented_path() -> OsString {
        let mut paths = tool_bin_dirs();
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        std::env::join_paths(&paths)
            .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
    }

    /// Parent env minus PYTHONHOME/PYTHONPATH, with the augmented PATH. The
    /// Linux AppImage's AppRun exports those two ($APPDIR-based); a spawned
    /// venv python inheriting them dies with "No module named 'encodings'".
    pub fn child_env() -> Vec<(OsString, OsString)> {
        let mut env: Vec<_> = std::env::vars_os()
            .filter(|(k, _)| {
                k != OsStr::new("PYTHONHOME")
                    && k != OsStr::new("PYTHONPATH")
                    && k != OsStr::new("PATH")
            })
            .collect();
        env.push(("PATH".into(), augmented_path()));
        env
    }

    /// A command with the child env applied and, on Windows, no console
    /// window flashing up for each spawn.
    fn command(program: &str, args: &[&str], inherit_env: bool) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null());
        if !inherit_env {
            cmd.env_clear().envs(child_env());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// `output()` with a deadline; the child is killed when it runs over.
    fn output_with_timeout(mut cmd: Command, timeout: Duration) -> Option<Output> {
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output().ok(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }

    const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

    fn trimmed_stdout(out: Output) -> Option<String> {
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    fn shell_output(program: &str, args: &[&str]) -> Option<String> {
        trimmed_stdout(output_with_timeout(
            command(program, args, false),
            PROBE_TIMEOUT,
        )?)
    }

    /// which/where with the user's OWN PATH first; then the known dirs; then
    /// the bare name (spawned with the augmented PATH; errors later if absent).
    fn resolve_tool(name: &str) -> String {
        let which = if cfg!(windows) { "where" } else { "which" };
        if let Some(out) = output_with_timeout(command(which, &[name], true), PROBE_TIMEOUT)
            .and_then(trimmed_stdout)
        {
            if let Some(line) = out.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return p.to_string_lossy().into_owned();
                }
            }
        }
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        for dir in tool_bin_dirs() {
            let candidate = dir.join(&exe);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        name.to_string()
    }

    fn resolve_uv() -> String {
        resolve_tool("uv")
    }

    /// The interpreter inside sleap-nn's uv-tool venv
    /// (`<uv tool dir>/sleap-nn/bin/python3`, `Scripts\python.exe` on Windows).
    fn sleap_nn_python() -> Option<String> {
        let tool_dir = shell_output(&resolve_uv(), &["tool", "dir"])?;
        let base = PathBuf::from(tool_dir.trim()).join("sleap-nn");
        let python = if cfg!(windows) {
            base.join("Scripts").join("python.exe")
        } else {
            base.join("bin").join("python3")
        };
        python
            .is_file()
            .then(|| python.to_string_lossy().into_owned())
    }

    /// Program names `run_python_command` accepts.
    pub const ALLOWED_PROGRAMS: &[&str] = &["uv", "sleap-nn", "sleap-nn-python"];

    /// Pure allowlist match: `requested` is an allowed name, or exactly the
    /// path Rust resolved for one. Returns the logical name (what argument
    /// validation keys on) and what to spawn.
    pub fn match_program<'a>(
        requested: &str,
        candidates: &[(&'a str, Option<String>)],
    ) -> Result<(&'a str, String), String> {
        for (name, resolved) in candidates {
            if requested == *name || resolved.as_deref() == Some(requested) {
                return resolved
                    .clone()
                    .map(|p| (*name, p))
                    .ok_or_else(|| format!("PROGRAM_NOT_FOUND: {name}"));
            }
        }
        Err(format!("PROGRAM_NOT_ALLOWED: {requested}"))
    }

    pub fn resolve_program(requested: &str) -> Result<(&'static str, String), String> {
        // Refuse anything that could not match before probing the system.
        let path_like = std::path::Path::new(requested).is_absolute();
        if !path_like && !ALLOWED_PROGRAMS.contains(&requested) {
            return Err(format!("PROGRAM_NOT_ALLOWED: {requested}"));
        }
        let candidates = [
            ("uv", Some(resolve_uv())),
            ("sleap-nn", Some(resolve_tool("sleap-nn"))),
            ("sleap-nn-python", sleap_nn_python()),
        ];
        match_program(requested, &candidates)
    }

    /// `uv self update --dry-run` (network; bounded so it cannot stall).
    fn check_uv_self_update(uv: &str) -> (Option<bool>, Option<String>, Option<bool>) {
        let Some(out) = output_with_timeout(
            command(uv, &["self", "update", "--dry-run"], false),
            Duration::from_secs(5),
        ) else {
            return (None, None, None);
        };
        parse_self_update_dry_run(out.status.success(), &String::from_utf8_lossy(&out.stderr))
    }

    /// uv prints its dry-run verdict on STDERR, in one of two wordings
    /// (standalone install) or refuses with a non-zero exit (installed via a
    /// package manager: self-update unsupported).
    pub fn parse_self_update_dry_run(
        success: bool,
        stderr: &str,
    ) -> (Option<bool>, Option<String>, Option<bool>) {
        if !success {
            return (None, None, Some(false));
        }
        if stderr.contains("already on version") || stderr.contains("on the latest version of uv") {
            return (Some(false), None, Some(true));
        }
        if let Some(rest) = stderr
            .lines()
            .find_map(|l| l.strip_prefix("Would update uv from "))
        {
            let latest = rest
                .split(" to ")
                .nth(1)
                .map(str::trim)
                .and_then(|v| v.strip_prefix('v'))
                .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(str::to_string);
            return (Some(true), latest, Some(true));
        }
        (None, None, None)
    }

    /// `uv 0.12.8 (68209e5c6 2026-08-31 aarch64-apple-darwin)` -> `0.12.8`.
    pub fn parse_uv_version(output: &str) -> String {
        let s = output.trim();
        let s = s.strip_prefix("uv ").unwrap_or(s).trim();
        s.split_whitespace().next().unwrap_or(s).to_string()
    }

    pub fn detect_uv() -> UvInfo {
        let uv = resolve_uv();
        let Some(version_output) = shell_output(&uv, &["--version"]) else {
            return UvInfo::default();
        };
        let (update_available, latest_version, self_update_supported) = check_uv_self_update(&uv);
        UvInfo {
            available: true,
            version: Some(parse_uv_version(&version_output)),
            path: (uv != "uv").then(|| uv.clone()),
            python_dir: shell_output(&uv, &["python", "dir"]),
            update_available,
            latest_version,
            self_update_supported,
        }
    }

    /// `sleap-nn 0.3.5` -> `0.3.5`. Only STDOUT is parsed: on macOS the tool
    /// prints `objc[...] Class AVF... is implemented in both` noise on stderr,
    /// and other lines may precede the version.
    pub fn parse_sleap_nn_version(stdout: &str) -> Option<String> {
        stdout
            .lines()
            .find_map(|l| l.trim().strip_prefix("sleap-nn "))
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_string)
    }

    pub fn detect_sleap_nn() -> SleapNnInfo {
        let path = resolve_tool("sleap-nn");
        let Some(out) = output_with_timeout(command(&path, &["--version"], false), PROBE_TIMEOUT)
        else {
            return SleapNnInfo::default();
        };
        if !out.status.success() {
            return SleapNnInfo::default();
        }
        let Some(version) = parse_sleap_nn_version(&String::from_utf8_lossy(&out.stdout)) else {
            return SleapNnInfo::default();
        };
        SleapNnInfo {
            available: true,
            version: Some(version),
            path: (path != "sleap-nn").then_some(path),
        }
    }

    pub fn detect_gpu() -> String {
        if shell_output("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]).is_some() {
            return "cuda".into();
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return "mps".into();
        }
        "cpu".into()
    }

    // --- streaming run -----------------------------------------------------

    /// Forward a pipe line by line. Lines end at `\n` OR `\r` (tauri's own
    /// `read_line`, which tauri-plugin-shell uses too) so tqdm-style `\r`
    /// progress updates arrive as they happen, not when the bar finishes.
    fn pump<T: std::io::Read + Send + 'static>(
        pipe: T,
        on_event: Channel<ProcessEvent>,
        wrap: fn(String) -> ProcessEvent,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            loop {
                let mut buf = Vec::new();
                match tauri::utils::io::read_line(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let _ = on_event.send(wrap(String::from_utf8_lossy(&buf).into_owned()));
                    }
                }
            }
        })
    }

    /// `^[A-Za-z0-9_.:-]{1,64}$`; None means the default job.
    pub fn job_id(raw: Option<String>) -> Result<String, String> {
        let id = raw.unwrap_or_else(|| DEFAULT_JOB.to_string());
        let ok = (1..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b));
        if ok {
            Ok(id)
        } else {
            Err("INVALID_JOB_ID: use 1-64 letters, digits or _ . : -".into())
        }
    }

    /// The real path rules, over the user's folder grants (files.rs).
    pub struct GrantPolicy(pub Arc<GrantState>);

    impl PathPolicy for GrantPolicy {
        fn readable_file(&self, raw: &str) -> Result<String, String> {
            if raw.contains("://") {
                return Err(format!("{raw} is a URL, not a local file"));
            }
            let p = self.0.check_readable(raw)?;
            if !p.is_file() {
                return Err(format!("{raw} is not an existing file"));
            }
            Ok(p.to_string_lossy().into_owned())
        }

        fn model_path(&self, raw: &str) -> Result<String, String> {
            let p = self.0.check_model(raw)?;
            if !p.exists() {
                return Err(format!("{raw} does not exist"));
            }
            Ok(p.to_string_lossy().into_owned())
        }

        fn writable_output(&self, raw: &str) -> Result<String, String> {
            let p = self.0.check_writable(raw)?;
            if p.extension().and_then(|e| e.to_str()) != Some("slp") {
                return Err(format!("{raw} is not a .slp file"));
            }
            if p.is_dir() {
                return Err(format!("{raw} is a directory"));
            }
            if !p.parent().is_some_and(|d| d.is_dir()) {
                return Err(format!("the folder of {raw} does not exist"));
            }
            Ok(p.to_string_lossy().into_owned())
        }
    }

    pub fn run(
        running: &RunningProcess,
        job: &str,
        program: &str,
        args: &[String],
        on_event: &Channel<ProcessEvent>,
    ) -> Result<bool, String> {
        let mut cmd = command(program, &[], false);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (out, err) = {
            let mut jobs = running.0.lock().map_err(|e| e.to_string())?;
            if jobs.contains_key(job) {
                return Err(if job == DEFAULT_JOB {
                    "A command is already running".into()
                } else {
                    format!("A command is already running: job {job}")
                });
            }
            if jobs.len() >= MAX_CONCURRENT_JOBS {
                return Err(format!(
                    "TOO_MANY_JOBS: at most {MAX_CONCURRENT_JOBS} commands run at once"
                ));
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn {program}: {e}"))?;
            let out = child
                .stdout
                .take()
                .map(|p| pump(p, on_event.clone(), |line| ProcessEvent::Stdout { line }));
            let err = child
                .stderr
                .take()
                .map(|p| pump(p, on_event.clone(), |line| ProcessEvent::Stderr { line }));
            jobs.insert(job.to_string(), child);
            (out, err)
        };
        let status = wait_polling(running, job);
        // Every line is delivered before `finished`.
        for h in [out, err].into_iter().flatten() {
            let _ = h.join();
        }
        let code = status.and_then(|s| s.code());
        let success = code == Some(0);
        let _ = on_event.send(ProcessEvent::Finished { success, code });
        Ok(success)
    }

    /// Wait without holding the lock, so `cancel` can reach the child.
    fn wait_polling(running: &RunningProcess, job: &str) -> Option<std::process::ExitStatus> {
        loop {
            {
                let Ok(mut jobs) = running.0.lock() else {
                    return None;
                };
                let child = jobs.get_mut(job)?;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        jobs.remove(job);
                        return Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        jobs.remove(job);
                        return None;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Kill one job, or every job when `job` is None. Kill only; `run`'s
    /// wait loop reaps the child and sends `finished`. An unknown id is fine.
    pub fn cancel(running: &RunningProcess, job: Option<&str>) -> Result<(), String> {
        let mut jobs = running.0.lock().map_err(|e| e.to_string())?;
        let mut result = Ok(());
        for (id, child) in jobs.iter_mut() {
            if job.is_none_or(|j| j == id) {
                if let Err(e) = child.kill() {
                    result = Err(format!("Failed to kill process: {e}"));
                }
            }
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::{Arc, Mutex};

        #[test]
        fn child_env_strips_appimage_python_vars_and_augments_path() {
            std::env::set_var("PYTHONHOME", "/tmp/.mount_TEST/usr/");
            std::env::set_var("PYTHONPATH", "/tmp/.mount_TEST/usr/share/pyshared/:");
            let env = child_env();
            std::env::remove_var("PYTHONHOME");
            std::env::remove_var("PYTHONPATH");
            assert!(!env.iter().any(|(k, _)| k == "PYTHONHOME"));
            assert!(!env.iter().any(|(k, _)| k == "PYTHONPATH"));
            let paths: Vec<_> = env.iter().filter(|(k, _)| k == "PATH").collect();
            assert_eq!(paths.len(), 1, "exactly one PATH");
            let first = std::env::split_paths(&paths[0].1).next().unwrap();
            assert_eq!(first, tool_bin_dirs()[0]);
        }

        #[test]
        fn program_allowlist() {
            let c = [
                ("uv", Some("/home/u/.local/bin/uv".to_string())),
                ("sleap-nn", Some("/home/u/.local/bin/sleap-nn".to_string())),
                ("sleap-nn-python", None),
            ];
            assert_eq!(
                match_program("uv", &c).unwrap(),
                ("uv", "/home/u/.local/bin/uv".to_string())
            );
            assert_eq!(
                match_program("/home/u/.local/bin/uv", &c).unwrap(),
                ("uv", "/home/u/.local/bin/uv".to_string())
            );
            assert_eq!(
                match_program("sleap-nn", &c).unwrap(),
                ("sleap-nn", "/home/u/.local/bin/sleap-nn".to_string())
            );
            assert!(match_program("sleap-nn-python", &c)
                .unwrap_err()
                .starts_with("PROGRAM_NOT_FOUND"));
            for bad in [
                "/bin/sh",
                "sh",
                "python3",
                "/home/u/.local/bin/other",
                "",
                "uv ",
            ] {
                assert!(
                    match_program(bad, &c)
                        .unwrap_err()
                        .starts_with("PROGRAM_NOT_ALLOWED"),
                    "{bad:?}"
                );
            }
            // The real resolver refuses arbitrary programs without probing.
            for bad in ["/bin/sh", "bash", "cmd.exe", "../uv"] {
                assert!(resolve_program(bad)
                    .unwrap_err()
                    .starts_with("PROGRAM_NOT_ALLOWED"));
            }
        }

        #[test]
        fn uv_version_and_self_update_parsing() {
            assert_eq!(
                parse_uv_version("uv 0.12.8 (68209e5c6 2026-08-31 aarch64-apple-darwin)"),
                "0.12.8"
            );
            assert_eq!(parse_uv_version("0.5.1"), "0.5.1");
            assert_eq!(
                parse_self_update_dry_run(false, ""),
                (None, None, Some(false))
            );
            assert_eq!(
                parse_self_update_dry_run(
                    true,
                    "info: You're already on version v0.9.0 of uv (the latest version)."
                ),
                (Some(false), None, Some(true))
            );
            assert_eq!(
                parse_self_update_dry_run(true, "Would update uv from v0.9.0 to v0.9.5"),
                (Some(true), Some("0.9.5".into()), Some(true))
            );
            assert_eq!(parse_self_update_dry_run(true, "???"), (None, None, None));
        }

        /// A Channel that records every event as JSON.
        fn recording_channel() -> (Channel<ProcessEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&seen);
            let ch = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                    sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
                }
                Ok(())
            });
            (ch, seen)
        }

        #[cfg(unix)]
        #[test]
        fn run_streams_lines_then_finished() {
            let running = RunningProcess::default();
            let (ch, seen) = recording_channel();
            let script = "printf 'one\\ntwo\\r'; printf 'err\\n' >&2; exit 3";
            let ok = run(
                &running,
                "default",
                "sh",
                &["-c".into(), script.into()],
                &ch,
            )
            .unwrap();
            assert!(!ok);
            let ev = seen.lock().unwrap().clone();
            let lines = |kind: &str| -> Vec<String> {
                ev.iter()
                    .filter(|e| e["event"] == kind)
                    .map(|e| e["data"]["line"].as_str().unwrap().to_string())
                    .collect()
            };
            assert_eq!(lines("stdout"), vec!["one\n", "two\r"]);
            assert_eq!(lines("stderr"), vec!["err\n"]);
            assert_eq!(
                ev.last().unwrap(),
                &serde_json::json!({"event": "finished", "data": {"success": false, "code": 3}})
            );
            assert!(running.0.lock().unwrap().is_empty(), "slot cleared");
        }

        type Sleeper = (
            std::thread::JoinHandle<Result<bool, String>>,
            Arc<Mutex<Vec<serde_json::Value>>>,
        );

        /// Start `sleep 30` as `job` on a thread; returns once it is running.
        #[cfg(unix)]
        fn start_sleeper(running: &Arc<RunningProcess>, job: &str) -> Sleeper {
            let (ch, seen) = recording_channel();
            let (r, j) = (Arc::clone(running), job.to_string());
            let t = std::thread::spawn(move || run(&r, &j, "sleep", &["30".into()], &ch));
            let start = Instant::now();
            while !running.0.lock().unwrap().contains_key(job) {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            (t, seen)
        }

        #[cfg(unix)]
        #[test]
        fn cancel_all_kills_every_job_and_same_id_is_refused() {
            let running = Arc::new(RunningProcess::default());
            let (t1, seen) = start_sleeper(&running, "default");
            let (t2, _) = start_sleeper(&running, "cam2");
            let start = Instant::now();
            // Two at once; the same id twice is refused.
            let (ch2, _) = recording_channel();
            let e = run(&running, "default", "true", &[], &ch2).unwrap_err();
            assert_eq!(e, "A command is already running");
            let e = run(&running, "cam2", "true", &[], &ch2).unwrap_err();
            assert!(e.starts_with("A command is already running"), "{e}");
            cancel(&running, None).unwrap();
            assert!(!t1.join().unwrap().unwrap());
            assert!(!t2.join().unwrap().unwrap());
            assert!(start.elapsed() < Duration::from_secs(10));
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last["event"], "finished");
            assert_eq!(last["data"]["success"], false);
            assert!(running.0.lock().unwrap().is_empty());
        }

        #[cfg(unix)]
        #[test]
        fn cancel_one_job_leaves_the_others_running() {
            let running = Arc::new(RunningProcess::default());
            let (t1, _) = start_sleeper(&running, "a");
            let (t2, _) = start_sleeper(&running, "b");
            cancel(&running, Some("nope")).unwrap();
            cancel(&running, Some("a")).unwrap();
            assert!(!t1.join().unwrap().unwrap());
            assert!(running.0.lock().unwrap().contains_key("b"), "b still runs");
            assert!(!t2.is_finished());
            cancel(&running, None).unwrap();
            assert!(!t2.join().unwrap().unwrap());
        }

        #[cfg(unix)]
        #[test]
        fn fifth_job_is_refused() {
            let running = Arc::new(RunningProcess::default());
            let ids = ["j1", "j2", "j3", "j4"];
            let threads: Vec<_> = ids.iter().map(|id| start_sleeper(&running, id).0).collect();
            let (ch, _) = recording_channel();
            let e = run(&running, "j5", "true", &[], &ch).unwrap_err();
            assert!(e.starts_with("TOO_MANY_JOBS"), "{e}");
            cancel(&running, None).unwrap();
            for t in threads {
                t.join().unwrap().unwrap();
            }
        }

        #[test]
        fn job_ids_are_validated() {
            assert_eq!(job_id(None).unwrap(), "default");
            assert_eq!(job_id(Some("cam-1.a:b_2".into())).unwrap(), "cam-1.a:b_2");
            for bad in ["", "a b", "a/b", "x;y", &"a".repeat(65), "é"] {
                assert!(
                    job_id(Some(bad.into()))
                        .unwrap_err()
                        .starts_with("INVALID_JOB_ID"),
                    "{bad:?}"
                );
            }
        }

        #[test]
        fn sleap_nn_version_parsing_ignores_stderr_noise() {
            assert_eq!(
                parse_sleap_nn_version("sleap-nn 0.3.5\n").as_deref(),
                Some("0.3.5")
            );
            assert_eq!(
                parse_sleap_nn_version("warming up\n  sleap-nn 0.3.5 (abc)\n").as_deref(),
                Some("0.3.5")
            );
            // The noise lives on stderr; if it ever reached here it is not a version.
            assert_eq!(
                parse_sleap_nn_version("objc[1]: Class AVFFrameReceiver is implemented in both\n"),
                None
            );
            assert_eq!(parse_sleap_nn_version(""), None);
        }

        #[test]
        fn grant_policy_follows_the_grants() {
            let base = std::env::temp_dir().join(format!("lucid-policy-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            for d in ["data", "models/run1", "out"] {
                std::fs::create_dir_all(base.join(d)).unwrap();
            }
            let base = std::fs::canonicalize(&base).unwrap();
            std::fs::write(base.join("data/a.mp4"), b"x").unwrap();
            std::fs::write(base.join("models/run1/best.ckpt"), b"x").unwrap();
            let st = Arc::new(GrantState::default());
            {
                let mut g = st.0.lock().unwrap();
                g.grant_dir(&base.join("data"));
                g.grant_dir(&base.join("out"));
                g.grant_model_dir(&base.join("models"));
            }
            let pol = GrantPolicy(st);
            let p = |rel: &str| base.join(rel).to_string_lossy().into_owned();
            assert!(pol.readable_file(&p("data/a.mp4")).is_ok());
            assert!(pol.readable_file(&p("data/missing.mp4")).is_err());
            assert!(
                pol.readable_file(&p("data")).is_err(),
                "a folder is not a file"
            );
            assert!(pol.readable_file("https://x/a.mp4").is_err());
            assert!(
                pol.readable_file(&p("models/run1/best.ckpt")).is_ok(),
                "model dirs readable"
            );
            assert!(pol.model_path(&p("models/run1")).is_ok());
            assert!(pol.model_path(&p("models/none")).is_err());
            assert!(
                pol.model_path(&p("data/a.mp4")).is_err(),
                "not a model grant"
            );
            assert!(pol.writable_output(&p("out/a.slp")).is_ok());
            assert!(pol.writable_output(&p("out/a.txt")).is_err());
            assert!(pol.writable_output(&p("out/nodir/a.slp")).is_err());
            assert!(pol.writable_output(&p("models/a.slp")).is_err());
            assert!(pol.writable_output(&p("data/../x.slp")).is_err());
            let _ = std::fs::remove_dir_all(&base);
        }

        #[cfg(unix)]
        #[test]
        fn output_with_timeout_kills_a_slow_child() {
            let t = Instant::now();
            assert!(output_with_timeout(
                command("sleep", &["5"], true),
                Duration::from_millis(200)
            )
            .is_none());
            assert!(t.elapsed() < Duration::from_secs(3));
            let out = output_with_timeout(command("echo", &["hi"], true), Duration::from_secs(5))
                .unwrap();
            assert_eq!(trimmed_stdout(out).as_deref(), Some("hi"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_event_serde_shape_matches_sleap_app() {
        let j = |e: ProcessEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            j(ProcessEvent::Stdout { line: "a\n".into() }),
            serde_json::json!({"event": "stdout", "data": {"line": "a\n"}})
        );
        assert_eq!(
            j(ProcessEvent::Stderr { line: "b".into() }),
            serde_json::json!({"event": "stderr", "data": {"line": "b"}})
        );
        assert_eq!(
            j(ProcessEvent::Finished {
                success: false,
                code: None
            }),
            serde_json::json!({"event": "finished", "data": {"success": false, "code": null}})
        );
        assert_eq!(
            j(ProcessEvent::Finished {
                success: true,
                code: Some(0)
            }),
            serde_json::json!({"event": "finished", "data": {"success": true, "code": 0}})
        );
    }

    #[test]
    fn uv_info_is_camel_case() {
        let v = serde_json::to_value(UvInfo::default()).unwrap();
        for k in [
            "available",
            "version",
            "path",
            "pythonDir",
            "updateAvailable",
            "latestVersion",
            "selfUpdateSupported",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
    }

    #[test]
    fn sleap_nn_info_is_camel_case() {
        let v = serde_json::to_value(SleapNnInfo::default()).unwrap();
        for k in ["available", "version", "path"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
    }

    #[test]
    fn status_reflects_the_build() {
        let s = sleap_nn_status();
        assert_eq!(s.available, cfg!(feature = "sleap-nn"));
        if !s.available {
            assert_eq!(s.reason, "not included in this build");
        }
    }
}
