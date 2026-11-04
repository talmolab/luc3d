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

#[derive(Debug, Serialize)]
pub struct SleapNnStatus {
    pub available: bool,
    pub reason: String,
}

/// The child spawned by `run_python_command`, kept so `cancel_command` can
/// kill it. One command at a time.
#[cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]
#[derive(Default)]
pub struct RunningProcess(pub Mutex<Option<std::process::Child>>);

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

/// Spawn `program args...`, streaming each stdout/stderr line and a final
/// `finished` event through `on_event`. Resolves to whether it exited 0.
#[tauri::command]
pub async fn run_python_command<R: Runtime>(
    app: AppHandle<R>,
    program: String,
    args: Vec<String>,
    on_event: Channel<ProcessEvent>,
) -> Result<bool, String> {
    #[cfg(feature = "sleap-nn")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            imp::run(&app.state::<RunningProcess>(), &program, &args, &on_event)
        })
        .await
        .map_err(|e| format!("run_python_command: {e}"))?
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = (app, program, args, on_event);
        Err(NOT_IN_THIS_BUILD.into())
    }
}

/// Kill the process started by `run_python_command`, if any.
#[tauri::command]
pub fn cancel_command(running: tauri::State<'_, RunningProcess>) -> Result<(), String> {
    #[cfg(feature = "sleap-nn")]
    {
        imp::cancel(&running)
    }
    #[cfg(not(feature = "sleap-nn"))]
    {
        let _ = running;
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
    use super::{ProcessEvent, RunningProcess, UvInfo};
    use std::ffi::{OsStr, OsString};
    use std::io::BufReader;
    use std::path::PathBuf;
    use std::process::{Command, Output, Stdio};
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

    #[cfg(windows)]
    const UV_EXE: &str = "uv.exe";
    #[cfg(not(windows))]
    const UV_EXE: &str = "uv";

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
    /// bare "uv" (errors later exactly as before if uv is absent).
    fn resolve_uv() -> String {
        let which = if cfg!(windows) { "where" } else { "which" };
        if let Some(out) = output_with_timeout(command(which, &["uv"], true), PROBE_TIMEOUT)
            .and_then(trimmed_stdout)
        {
            if let Some(line) = out.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return p.to_string_lossy().into_owned();
                }
            }
        }
        for dir in tool_bin_dirs() {
            let candidate = dir.join(UV_EXE);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        "uv".to_string()
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

    pub fn run(
        running: &RunningProcess,
        program: &str,
        args: &[String],
        on_event: &Channel<ProcessEvent>,
    ) -> Result<bool, String> {
        let mut cmd = command(program, &[], false);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (out, err) = {
            let mut slot = running.0.lock().map_err(|e| e.to_string())?;
            if slot.is_some() {
                return Err("A command is already running".into());
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
            *slot = Some(child);
            (out, err)
        };
        let status = wait_polling(running);
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
    fn wait_polling(running: &RunningProcess) -> Option<std::process::ExitStatus> {
        loop {
            {
                let Ok(mut slot) = running.0.lock() else {
                    return None;
                };
                let child = slot.as_mut()?;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *slot = None;
                        return Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *slot = None;
                        return None;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Kill only; `run`'s wait loop reaps the child and sends `finished`.
    pub fn cancel(running: &RunningProcess) -> Result<(), String> {
        let mut slot = running.0.lock().map_err(|e| e.to_string())?;
        if let Some(child) = slot.as_mut() {
            child
                .kill()
                .map_err(|e| format!("Failed to kill process: {e}"))?;
        }
        Ok(())
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
            let ok = run(&running, "sh", &["-c".into(), script.into()], &ch).unwrap();
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
            assert!(running.0.lock().unwrap().is_none(), "slot cleared");
        }

        #[cfg(unix)]
        #[test]
        fn cancel_kills_the_running_command() {
            let running = Arc::new(RunningProcess::default());
            let (ch, seen) = recording_channel();
            let r = Arc::clone(&running);
            let t = std::thread::spawn(move || run(&r, "sleep", &["30".into()], &ch));
            let start = Instant::now();
            while running.0.lock().unwrap().is_none() {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            // A second command is refused while one runs.
            let (ch2, _) = recording_channel();
            assert!(run(&running, "true", &[], &ch2).is_err());
            cancel(&running).unwrap();
            assert!(!t.join().unwrap().unwrap());
            assert!(start.elapsed() < Duration::from_secs(10));
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last["event"], "finished");
            assert_eq!(last["data"]["success"], false);
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
    fn status_reflects_the_build() {
        let s = sleap_nn_status();
        assert_eq!(s.available, cfg!(feature = "sleap-nn"));
        if !s.available {
            assert_eq!(s.reason, "not included in this build");
        }
    }
}
