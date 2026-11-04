//! Native file access for the desktop shell.
//!
//! Permission model (FSA-like): every path a native picker returns is GRANTED
//! for the rest of this run (a picked file grants that file; a picked
//! directory grants it and everything under it). The file commands refuse any
//! other path with `NOT_GRANTED: <path>`, so page script cannot read or write
//! arbitrary files just because it can reach the IPC bridge.
//!
//! Writes go through WRITE SESSIONS: `write_open` creates a hidden temp file
//! next to the target, chunks are written into it at explicit offsets, and
//! `write_commit` syncs it and renames it over the target. A crash, cancel or
//! failed save therefore never leaves a half-written target behind.
//!
//! The logic lives in plain functions/structs (no Tauri types) so it is unit
//! tested without a running app; the `#[tauri::command]` wrappers at the
//! bottom only adapt arguments and move blocking I/O off the IPC thread.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

// ---------------------------------------------------------------------------
// Path validation + grants
// ---------------------------------------------------------------------------

/// Parse a path coming from JS: it must be absolute and contain no `..`.
pub fn validate_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("INVALID_PATH: empty path".into());
    }
    if raw.contains('\0') {
        return Err(format!("INVALID_PATH: {raw}"));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("INVALID_PATH: not absolute: {raw}"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("INVALID_PATH: `..` not allowed: {raw}"));
    }
    Ok(path)
}

/// The real location `path` names: symlinks resolved in its longest EXISTING
/// ancestor, with the not-yet-existing remainder appended (so a save target
/// or a folder still to be made resolves too).
///
/// A dangling symlink anywhere on the way is refused: creating a file through
/// one would land wherever it points, which no grant check could see.
pub fn resolve_path(path: &Path) -> std::io::Result<PathBuf> {
    let mut existing = path;
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        match std::fs::canonicalize(existing) {
            Ok(mut real) => {
                for name in rest.iter().rev() {
                    real.push(name);
                }
                return Ok(real);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(existing).is_ok() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("dangling symlink: {}", existing.display()),
                    ));
                }
                match (existing.parent(), existing.file_name()) {
                    (Some(parent), Some(name)) => {
                        rest.push(name);
                        existing = parent;
                    }
                    _ => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// Validate a path from JS and resolve it to where it really points.
pub fn resolve_request(raw: &str) -> Result<PathBuf, String> {
    let path = validate_path(raw)?;
    resolve_path(&path).map_err(|e| format!("INVALID_PATH: {raw}: {e}"))
}

/// Paths the user handed to the app through a native picker during this run,
/// stored RESOLVED (see `resolve_path`). Requests are resolved the same way
/// before the prefix test, so a symlink inside a granted folder that points
/// outside it is refused, while one pointing elsewhere inside is fine.
#[derive(Default, Debug)]
pub struct Grants {
    files: HashSet<PathBuf>,
    dirs: HashSet<PathBuf>,
}

impl Grants {
    pub fn grant_file(&mut self, path: &Path) {
        self.files
            .insert(resolve_path(path).unwrap_or_else(|_| path.to_path_buf()));
    }

    pub fn grant_dir(&mut self, path: &Path) {
        self.dirs
            .insert(resolve_path(path).unwrap_or_else(|_| path.to_path_buf()));
    }

    /// `resolved` must come from `resolve_path`. `Path::starts_with` compares
    /// whole components, so `/a/bc` is not under a granted `/a/b`.
    pub fn is_granted(&self, resolved: &Path) -> bool {
        self.files.contains(resolved) || self.dirs.iter().any(|d| resolved.starts_with(d))
    }

    /// `GrantState::check` without the lock (tests).
    #[cfg(test)]
    pub fn check(&self, raw: &str) -> Result<PathBuf, String> {
        let resolved = resolve_request(raw)?;
        if self.is_granted(&resolved) {
            Ok(resolved)
        } else {
            Err(format!("NOT_GRANTED: {raw}"))
        }
    }

    #[cfg(test)]
    pub fn clear(&mut self) {
        self.files.clear();
        self.dirs.clear();
    }
}

/// Tauri-managed grant set (behind an Arc so checks can run on the blocking
/// pool: resolving a path is filesystem I/O).
#[derive(Default)]
pub struct GrantState(pub Mutex<Grants>);

impl GrantState {
    /// Validate, resolve and require a grant. Returns the RESOLVED path, which
    /// is what every caller must then operate on. The error prefixes are the
    /// contract the JS shim matches on.
    pub fn check(&self, raw: &str) -> Result<PathBuf, String> {
        // Resolve outside the lock: it can be slow on a network share.
        let resolved = resolve_request(raw)?;
        let grants = self.0.lock().map_err(|e| e.to_string())?;
        if grants.is_granted(&resolved) {
            Ok(resolved)
        } else {
            Err(format!("NOT_GRANTED: {raw}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Stat / list / read
// ---------------------------------------------------------------------------

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: f64,
}

pub fn path_stat_impl(path: &Path) -> Result<PathStat, String> {
    match std::fs::metadata(path) {
        Ok(m) => Ok(PathStat {
            exists: true,
            is_file: m.is_file(),
            is_dir: m.is_dir(),
            size: if m.is_file() { m.len() } else { 0 },
            mtime_ms: mtime_ms(&m),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathStat {
            exists: false,
            is_file: false,
            is_dir: false,
            size: 0,
            mtime_ms: 0.0,
        }),
        Err(e) => Err(format!("path_stat({}): {e}", path.display())),
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// "file" | "directory" (the File System Access API's handle kinds).
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: f64,
}

/// Non-recursive listing sorted by name. Symlinks are followed; entries that
/// are neither a file nor a directory once followed (broken links, sockets,
/// fifos) are skipped, as a FileSystemDirectoryHandle would not show them.
pub fn list_dir_impl(path: &Path) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(path).map_err(|e| format!("list_dir({}): {e}", path.display()))?;
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| format!("list_dir({}): {e}", path.display()))?;
        // An in-progress (or crashed) write's temp file is not a real entry:
        // listing it would let a folder export see its own half-written output.
        if is_partial_temp_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(entry.path()) else {
            continue;
        };
        let kind = if meta.is_file() {
            "file"
        } else if meta.is_dir() {
            "directory"
        } else {
            continue;
        };
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
            size: if meta.is_file() { meta.len() } else { 0 },
            mtime_ms: mtime_ms(&meta),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Positioned read that never touches a shared cursor; loops over short reads
/// and stops early at EOF.
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    let mut filled = 0usize;
    while filled < buf.len() {
        #[cfg(unix)]
        let n = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut buf[filled..], offset + filled as u64)
        };
        #[cfg(windows)]
        let n = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut buf[filled..], offset + filled as u64)
        };
        match n {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Read `[offset, offset+length)`; a range past EOF returns the bytes that
/// exist (possibly none), never an error.
pub fn read_range_impl(path: &Path, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| format!("read_range({}): {e}", path.display()))?;
    let mut buf = vec![0u8; length as usize];
    let n = read_at(&file, &mut buf, offset)
        .map_err(|e| format!("read_range({}, {offset}): {e}", path.display()))?;
    buf.truncate(n);
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Write sessions
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn write_all_at(file: &File, data: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(data, offset)
}

#[cfg(windows)]
fn write_all_at(file: &File, mut data: &[u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !data.is_empty() {
        match file.seek_write(data, offset) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "failed to write whole buffer",
                ))
            }
            Ok(n) => {
                data = &data[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// A random-enough suffix for temp names without pulling in a RNG crate:
/// std's per-process random SipHash keys, mixed with a counter and the time.
pub(crate) fn random_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

/// True for a name made by `temp_path_for` (`.<name>.lucid-partial-<random>`).
pub fn is_partial_temp_name(name: &str) -> bool {
    name.starts_with('.') && name.contains(".lucid-partial-")
}

/// `<dir>/.<name>.lucid-partial-<random>`: same directory as the target so the
/// final rename never crosses a filesystem (rename is atomic only within one),
/// and dot-prefixed so file managers hide it while the save runs.
pub fn temp_path_for(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("INVALID_PATH: no file name: {}", target.display()))?;
    let dir = target
        .parent()
        .ok_or_else(|| format!("INVALID_PATH: no parent: {}", target.display()))?;
    Ok(dir.join(format!(
        ".{}.lucid-partial-{}",
        name.to_string_lossy(),
        random_suffix()
    )))
}

struct WriteSession {
    /// `None` once committed or aborted: a write racing a commit then fails
    /// cleanly instead of reopening a renamed or deleted file.
    file: Option<File>,
    temp_path: PathBuf,
    final_path: PathBuf,
}

/// All open write sessions. Each session has its own lock, so concurrent
/// writers to different files never wait on each other; the map lock is only
/// held to look a session up.
#[derive(Default)]
pub struct WriteSessions {
    next_id: AtomicU32,
    map: Mutex<HashMap<u32, Arc<Mutex<WriteSession>>>>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct WriteOpened {
    pub id: u32,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct WriteCommitted {
    pub size: u64,
}

impl WriteSessions {
    fn get(&self, id: u32) -> Result<Arc<Mutex<WriteSession>>, String> {
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("NO_SUCH_WRITE: {id}"))
    }

    fn take(&self, id: u32) -> Result<Arc<Mutex<WriteSession>>, String> {
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id)
            .ok_or_else(|| format!("NO_SUCH_WRITE: {id}"))
    }

    /// Open a session for `target`. With `keep_existing_data` an existing
    /// target is copied into the temp first (FSA `keepExistingData: true`);
    /// otherwise the temp starts empty.
    pub fn open(&self, target: &Path, keep_existing_data: bool) -> Result<WriteOpened, String> {
        let parent = target
            .parent()
            .ok_or_else(|| format!("INVALID_PATH: no parent: {}", target.display()))?;
        if !parent.is_dir() {
            return Err(format!("NOT_FOUND: {}", parent.display()));
        }
        if target.is_dir() {
            return Err(format!("IS_A_DIRECTORY: {}", target.display()));
        }
        // Refuse up front rather than at the final rename: on Windows the
        // rename over a read-only file fails, and copying its attributes
        // would make the temp read-only too.
        if std::fs::metadata(target).is_ok_and(|m| m.permissions().readonly()) {
            return Err(format!("READ_ONLY: {}", target.display()));
        }

        // create_new reserves the name; retry on the (unlikely) collision.
        let (temp_path, file) = {
            let mut attempt = 0;
            loop {
                let temp = temp_path_for(target)?;
                match OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                {
                    Ok(f) => break (temp, f),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => {
                        attempt += 1;
                    }
                    Err(e) => return Err(format!("write_open({}): {e}", target.display())),
                }
            }
        };

        if keep_existing_data && target.is_file() {
            let copy = File::open(target).and_then(|mut src| {
                let mut dst = &file;
                std::io::copy(&mut src, &mut dst)
            });
            if let Err(e) = copy {
                drop(file);
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!(
                    "write_open({}): copy existing: {e}",
                    target.display()
                ));
            }
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let session = WriteSession {
            file: Some(file),
            temp_path,
            final_path: target.to_path_buf(),
        };
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, Arc::new(Mutex::new(session)));
        Ok(WriteOpened { id })
    }

    pub fn write(&self, id: u32, offset: u64, data: &[u8]) -> Result<(), String> {
        let s = self.get(id)?;
        let s = s.lock().map_err(|e| e.to_string())?;
        let file = s
            .file
            .as_ref()
            .ok_or_else(|| format!("NO_SUCH_WRITE: {id}"))?;
        write_all_at(file, data, offset).map_err(|e| format!("write_chunk({id}, {offset}): {e}"))
    }

    pub fn truncate(&self, id: u32, size: u64) -> Result<(), String> {
        let s = self.get(id)?;
        let s = s.lock().map_err(|e| e.to_string())?;
        let file = s
            .file
            .as_ref()
            .ok_or_else(|| format!("NO_SUCH_WRITE: {id}"))?;
        file.set_len(size)
            .map_err(|e| format!("write_truncate({id}, {size}): {e}"))
    }

    /// Flush to disk, then rename the temp over the target. The target is only
    /// ever replaced by this rename, so any earlier failure leaves it intact.
    pub fn commit(&self, id: u32) -> Result<WriteCommitted, String> {
        let s = self.take(id)?;
        let mut s = s.lock().map_err(|e| e.to_string())?;
        let file = s
            .file
            .take()
            .ok_or_else(|| format!("NO_SUCH_WRITE: {id}"))?;
        let fail = |s: &WriteSession, what: &str, e: std::io::Error| {
            let _ = std::fs::remove_file(&s.temp_path);
            format!("write_commit({}): {what}: {e}", s.final_path.display())
        };
        if let Err(e) = file.sync_all() {
            drop(file);
            return Err(fail(&s, "sync", e));
        }
        let size = match file.metadata() {
            Ok(m) => m.len(),
            Err(e) => {
                drop(file);
                return Err(fail(&s, "stat", e));
            }
        };
        // Windows cannot rename a file that is still open.
        drop(file);
        // A replaced file keeps its permission bits (the temp was created
        // with the process umask defaults). Best-effort.
        if let Ok(meta) = std::fs::metadata(&s.final_path) {
            let _ = std::fs::set_permissions(&s.temp_path, meta.permissions());
        }
        if let Err(e) = std::fs::rename(&s.temp_path, &s.final_path) {
            return Err(fail(&s, "rename", e));
        }
        // Make the rename itself durable (POSIX needs the directory synced).
        #[cfg(unix)]
        if let Some(parent) = s.final_path.parent() {
            if let Ok(d) = File::open(parent) {
                let _ = d.sync_all();
            }
        }
        Ok(WriteCommitted { size })
    }

    pub fn abort(&self, id: u32) -> Result<(), String> {
        let s = self.take(id)?;
        let mut s = s.lock().map_err(|e| e.to_string())?;
        drop(s.file.take());
        remove_if_exists(&s.temp_path)
    }

    /// Abort every open session (app exit). Errors are ignored: this runs on
    /// the way out and has nobody to report to.
    pub fn abort_all(&self) {
        let ids: Vec<u32> = match self.map.lock() {
            Ok(m) => m.keys().copied().collect(),
            Err(_) => return,
        };
        for id in ids {
            let _ = self.abort(id);
        }
    }

    #[cfg(test)]
    fn temp_path(&self, id: u32) -> PathBuf {
        self.get(id).unwrap().lock().unwrap().temp_path.clone()
    }
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove({}): {e}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// Reveal / external URLs
// ---------------------------------------------------------------------------

/// Schemes `open_external_url` hands to the OS. Anything else (file:,
/// javascript:, custom app schemes, ...) could launch arbitrary handlers.
const EXTERNAL_URL_SCHEMES: &[&str] = &["http", "https", "mailto"];

/// Parse and allowlist an external URL; returns the normalized string that is
/// passed to the OS opener.
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|e| format!("INVALID_URL: {raw}: {e}"))?;
    if !EXTERNAL_URL_SCHEMES.contains(&url.scheme()) {
        return Err(format!("URL_SCHEME_NOT_ALLOWED: {}", url.scheme()));
    }
    if matches!(url.scheme(), "http" | "https") && url.host_str().unwrap_or("").is_empty() {
        return Err(format!("INVALID_URL: {raw}"));
    }
    Ok(url.into())
}

fn spawn_detached(cmd: &mut std::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn open_external(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        spawn_detached(std::process::Command::new("open").arg(url))
    }
    #[cfg(target_os = "windows")]
    {
        // Not `cmd /C start`: cmd re-parses `&`, `|`, `^` in the URL, which
        // would let a crafted link run commands. url.dll takes it verbatim.
        spawn_detached(
            std::process::Command::new("rundll32")
                .arg("url.dll,FileProtocolHandler")
                .arg(url),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        spawn_detached(std::process::Command::new("xdg-open").arg(url))
    }
}

pub fn reveal(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("NOT_FOUND: {}", path.display()));
    }
    #[cfg(target_os = "macos")]
    {
        spawn_detached(std::process::Command::new("open").arg("-R").arg(path))
    }
    #[cfg(target_os = "windows")]
    {
        // explorer parses its own command line: the path must be quoted
        // inside the `/select,` switch, which std's argument quoting would
        // not produce, so pass it raw.
        use std::os::windows::process::CommandExt;
        spawn_detached(
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", path.display())),
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // No portable "select this file" on Linux; open the containing folder.
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        spawn_detached(std::process::Command::new("xdg-open").arg(target))
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Run blocking file I/O on the blocking pool. Sync commands run on the main
/// thread on macOS, so a slow disk (network share, cloud placeholder) would
/// freeze the whole UI for the duration of the call.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task: {e}"))?
}

/// The managed grant set is an Arc so a check (filesystem I/O) can move onto
/// the blocking pool together with the operation it guards.
fn grants_of(state: &tauri::State<'_, Arc<GrantState>>) -> Arc<GrantState> {
    Arc::clone(state)
}

#[tauri::command]
pub async fn path_stat(
    grants: tauri::State<'_, Arc<GrantState>>,
    path: String,
) -> Result<PathStat, String> {
    let grants = grants_of(&grants);
    blocking(move || path_stat_impl(&grants.check(&path)?)).await
}

#[tauri::command]
pub async fn read_range(
    grants: tauri::State<'_, Arc<GrantState>>,
    path: String,
    offset: u64,
    length: u32,
) -> Result<tauri::ipc::Response, String> {
    let grants = grants_of(&grants);
    let bytes = blocking(move || read_range_impl(&grants.check(&path)?, offset, length)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn list_dir(
    grants: tauri::State<'_, Arc<GrantState>>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let grants = grants_of(&grants);
    blocking(move || list_dir_impl(&grants.check(&path)?)).await
}

#[tauri::command]
pub async fn make_dir(
    grants: tauri::State<'_, Arc<GrantState>>,
    path: String,
) -> Result<(), String> {
    let grants = grants_of(&grants);
    blocking(move || {
        let p = grants.check(&path)?;
        std::fs::create_dir_all(&p).map_err(|e| format!("make_dir({}): {e}", p.display()))
    })
    .await
}

/// The session writes to the RESOLVED target: its temp is made in the real
/// parent directory and a symlinked target is written through, not replaced.
#[tauri::command]
pub async fn write_open(
    grants: tauri::State<'_, Arc<GrantState>>,
    sessions: tauri::State<'_, Arc<WriteSessions>>,
    path: String,
    keep_existing_data: bool,
) -> Result<WriteOpened, String> {
    let grants = grants_of(&grants);
    let sessions = Arc::clone(&sessions);
    blocking(move || sessions.open(&grants.check(&path)?, keep_existing_data)).await
}

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("write_chunk: missing header {name}"))?
        .to_str()
        .map_err(|e| format!("write_chunk: bad header {name}: {e}"))
}

/// Raw-body command: the bytes travel over the binary IPC channel (a JSON
/// number array would be ~4x larger and slow to parse), and the session id
/// and offset ride in headers because a command gets either JSON args or a
/// raw body, not both.
#[tauri::command]
pub async fn write_chunk(
    sessions: tauri::State<'_, Arc<WriteSessions>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id: u32 = header(&request, "x-lucid-write-id")?
        .trim()
        .parse()
        .map_err(|e| format!("write_chunk: x-lucid-write-id: {e}"))?;
    let offset: u64 = header(&request, "x-lucid-offset")?
        .trim()
        .parse()
        .map_err(|e| format!("write_chunk: x-lucid-offset: {e}"))?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("write_chunk: expected a raw binary body, got JSON".into())
        }
    };
    let sessions = Arc::clone(&sessions);
    blocking(move || sessions.write(id, offset, &data)).await
}

#[tauri::command]
pub async fn write_truncate(
    sessions: tauri::State<'_, Arc<WriteSessions>>,
    id: u32,
    size: u64,
) -> Result<(), String> {
    let sessions = Arc::clone(&sessions);
    blocking(move || sessions.truncate(id, size)).await
}

#[tauri::command]
pub async fn write_commit(
    sessions: tauri::State<'_, Arc<WriteSessions>>,
    id: u32,
) -> Result<WriteCommitted, String> {
    let sessions = Arc::clone(&sessions);
    blocking(move || sessions.commit(id)).await
}

#[tauri::command]
pub async fn write_abort(
    sessions: tauri::State<'_, Arc<WriteSessions>>,
    id: u32,
) -> Result<(), String> {
    let sessions = Arc::clone(&sessions);
    blocking(move || sessions.abort(id)).await
}

/// Grant-checked like the file commands: even "show in folder" must not
/// let the page probe for or open arbitrary locations.
#[tauri::command]
pub async fn reveal_path(
    grants: tauri::State<'_, Arc<GrantState>>,
    path: String,
) -> Result<(), String> {
    let grants = grants_of(&grants);
    blocking(move || {
        grants.check(&path)?;
        // Reveal the path as the user knows it (on Windows the resolved form
        // is a `\\?\` verbatim path, which Explorer does not accept).
        reveal(&validate_path(&path)?)
    })
    .await
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    open_external(&url)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch directory per test, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("lucid-test-{tag}-{}", random_suffix()));
            std::fs::create_dir_all(&dir).unwrap();
            // Canonical so macOS /var -> /private/var cannot skew prefix tests.
            Scratch(std::fs::canonicalize(&dir).unwrap())
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn entries(&self) -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    // --- grants -------------------------------------------------------------

    #[test]
    fn granted_file_is_allowed_and_siblings_are_not() {
        let d = Scratch::new("grant-file");
        let mut g = Grants::default();
        g.grant_file(&d.path("a.slp"));
        assert_eq!(g.check(&s(&d.path("a.slp"))).unwrap(), d.path("a.slp"));
        let err = g.check(&s(&d.path("b.slp"))).unwrap_err();
        assert!(err.starts_with("NOT_GRANTED: "), "{err}");
        // A granted file does not grant its directory.
        assert!(g.check(&s(&d.0)).unwrap_err().starts_with("NOT_GRANTED"));
    }

    #[test]
    fn granted_dir_covers_descendants_only() {
        let d = Scratch::new("grant-dir");
        let mut g = Grants::default();
        g.grant_dir(&d.path("proj"));
        assert!(g.check(&s(&d.path("proj"))).is_ok());
        assert!(g
            .check(&s(&d.path("proj").join("cam1").join("0.mp4")))
            .is_ok());
        // Component-wise prefix: `proj2` is not inside `proj`.
        assert!(g
            .check(&s(&d.path("proj2")))
            .unwrap_err()
            .starts_with("NOT_GRANTED"));
        assert!(g.check(&s(&d.0)).unwrap_err().starts_with("NOT_GRANTED"));
        g.clear();
        assert!(g.check(&s(&d.path("proj"))).is_err());
    }

    #[test]
    fn dot_dot_is_rejected_even_inside_a_grant() {
        let d = Scratch::new("grant-dotdot");
        let mut g = Grants::default();
        g.grant_dir(&d.path("proj"));
        let escape = format!("{}/../secret.txt", s(&d.path("proj")));
        let err = g.check(&escape).unwrap_err();
        assert!(err.starts_with("INVALID_PATH"), "{err}");
        let inner = format!("{}/x/../y", s(&d.path("proj")));
        assert!(g.check(&inner).unwrap_err().starts_with("INVALID_PATH"));
    }

    #[test]
    fn relative_and_empty_paths_are_rejected() {
        let mut g = Grants::default();
        g.grant_dir(&std::env::current_dir().unwrap());
        for p in ["a.slp", "./a.slp", "proj/a.slp", ""] {
            let err = g.check(p).unwrap_err();
            assert!(err.starts_with("INVALID_PATH"), "{p}: {err}");
        }
        assert!(validate_path("/tmp/a\0b").is_err());
    }

    #[test]
    fn not_yet_existing_paths_in_a_granted_dir_resolve() {
        let d = Scratch::new("grant-new");
        std::fs::create_dir(d.path("proj")).unwrap();
        let mut g = Grants::default();
        g.grant_dir(&d.path("proj"));
        let deep = d.path("proj").join("new-dir").join("sub").join("out.slp");
        assert_eq!(g.check(&s(&deep)).unwrap(), deep);
        // A save-dialog grant for a file that does not exist yet.
        let mut g = Grants::default();
        g.grant_file(&d.path("new.slp"));
        assert_eq!(g.check(&s(&d.path("new.slp"))).unwrap(), d.path("new.slp"));
    }

    #[cfg(unix)]
    mod symlinks {
        use super::*;
        use std::os::unix::fs::symlink;

        /// `<scratch>/proj` granted, `<scratch>/outside` not.
        fn setup(tag: &str) -> (Scratch, Grants) {
            let d = Scratch::new(tag);
            std::fs::create_dir(d.path("proj")).unwrap();
            std::fs::create_dir(d.path("outside")).unwrap();
            std::fs::write(d.path("outside").join("secret.txt"), b"secret").unwrap();
            let mut g = Grants::default();
            g.grant_dir(&d.path("proj"));
            (d, g)
        }

        #[test]
        fn symlinked_dir_pointing_outside_is_refused() {
            let (d, g) = setup("ln-dir");
            symlink(d.path("outside"), d.path("proj").join("link")).unwrap();
            for p in ["link", "link/secret.txt", "link/new.txt", "link/newdir/x"] {
                let err = g.check(&s(&d.path("proj").join(p))).unwrap_err();
                assert!(err.starts_with("NOT_GRANTED"), "{p}: {err}");
            }
        }

        #[test]
        fn symlinked_file_pointing_outside_is_refused() {
            let (d, g) = setup("ln-file");
            symlink(
                d.path("outside").join("secret.txt"),
                d.path("proj").join("f.txt"),
            )
            .unwrap();
            let err = g.check(&s(&d.path("proj").join("f.txt"))).unwrap_err();
            assert!(err.starts_with("NOT_GRANTED"), "{err}");
        }

        #[test]
        fn dangling_symlink_is_refused() {
            let (d, g) = setup("ln-dangling");
            symlink(d.path("outside").join("nope"), d.path("proj").join("dl")).unwrap();
            for p in ["dl", "dl/x.txt"] {
                let err = g.check(&s(&d.path("proj").join(p))).unwrap_err();
                assert!(err.starts_with("INVALID_PATH"), "{p}: {err}");
            }
        }

        #[test]
        fn symlink_pointing_inside_the_grant_is_allowed_and_resolved() {
            let (d, g) = setup("ln-inside");
            std::fs::create_dir(d.path("proj").join("real")).unwrap();
            std::fs::write(d.path("proj").join("real").join("a.txt"), b"a").unwrap();
            symlink(d.path("proj").join("real"), d.path("proj").join("alias")).unwrap();
            let got = g
                .check(&s(&d.path("proj").join("alias").join("a.txt")))
                .unwrap();
            assert_eq!(got, d.path("proj").join("real").join("a.txt"));
        }

        #[test]
        fn granted_dir_reached_through_a_symlink_still_matches() {
            let d = Scratch::new("ln-grant");
            std::fs::create_dir(d.path("real")).unwrap();
            symlink(d.path("real"), d.path("via")).unwrap();
            let mut g = Grants::default();
            g.grant_dir(&d.path("via")); // the picker returned the link
            assert!(g.check(&s(&d.path("via").join("x.slp"))).is_ok());
            assert!(g.check(&s(&d.path("real").join("x.slp"))).is_ok());
        }

        #[test]
        fn commit_writes_through_a_symlinked_target() {
            let (d, g) = setup("ln-commit");
            std::fs::write(d.path("proj").join("real.slp"), b"old").unwrap();
            symlink(
                d.path("proj").join("real.slp"),
                d.path("proj").join("link.slp"),
            )
            .unwrap();
            let target = g.check(&s(&d.path("proj").join("link.slp"))).unwrap();
            assert_eq!(target, d.path("proj").join("real.slp"));
            let ws = WriteSessions::default();
            let id = ws.open(&target, true).unwrap().id;
            ws.write(id, 0, b"NEW").unwrap();
            ws.commit(id).unwrap();
            assert_eq!(
                std::fs::read(d.path("proj").join("real.slp")).unwrap(),
                b"NEW"
            );
            let link_meta = std::fs::symlink_metadata(d.path("proj").join("link.slp")).unwrap();
            assert!(
                link_meta.file_type().is_symlink(),
                "the link itself is kept"
            );
            assert_eq!(
                std::fs::read(d.path("proj").join("link.slp")).unwrap(),
                b"NEW"
            );
        }
    }

    // --- stat / list / read -------------------------------------------------

    #[test]
    fn stat_list_and_read_range() {
        let d = Scratch::new("io");
        std::fs::write(d.path("b.bin"), (0u8..100).collect::<Vec<_>>()).unwrap();
        std::fs::write(d.path("a.txt"), b"hello").unwrap();
        std::fs::create_dir(d.path("sub")).unwrap();
        // An in-progress write's temp file must not be listed.
        std::fs::write(d.path(".out.slp.lucid-partial-abc123"), b"x").unwrap();

        let st = path_stat_impl(&d.path("b.bin")).unwrap();
        assert!(st.exists && st.is_file && !st.is_dir);
        assert_eq!(st.size, 100);
        assert!(st.mtime_ms > 0.0);
        let missing = path_stat_impl(&d.path("nope")).unwrap();
        assert!(!missing.exists);
        assert!(path_stat_impl(&d.path("sub")).unwrap().is_dir);

        let names: Vec<(String, &str)> = list_dir_impl(&d.0)
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                ("a.txt".into(), "file"),
                ("b.bin".into(), "file"),
                ("sub".into(), "directory")
            ]
        );

        assert_eq!(
            read_range_impl(&d.path("b.bin"), 10, 5).unwrap(),
            vec![10, 11, 12, 13, 14]
        );
        // Short read at EOF, empty past EOF.
        assert_eq!(
            read_range_impl(&d.path("b.bin"), 95, 50).unwrap(),
            vec![95, 96, 97, 98, 99]
        );
        assert!(read_range_impl(&d.path("b.bin"), 500, 10)
            .unwrap()
            .is_empty());
    }

    // --- write sessions -----------------------------------------------------

    #[test]
    fn temp_file_is_a_hidden_sibling_of_the_target() {
        let d = Scratch::new("tempname");
        let target = d.path("project.slp");
        let t1 = temp_path_for(&target).unwrap();
        let t2 = temp_path_for(&target).unwrap();
        assert_eq!(t1.parent(), target.parent());
        let name = t1.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".project.slp.lucid-partial-"), "{name}");
        assert_ne!(t1, t2, "temp names must not repeat");

        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        assert_eq!(ws.temp_path(id).parent(), Some(d.0.as_path()));
        assert!(ws.temp_path(id).exists());
        assert!(!target.exists(), "target must not exist before commit");
        ws.abort(id).unwrap();
    }

    #[test]
    fn positioned_writes_out_of_order_then_commit() {
        let d = Scratch::new("ooo");
        let target = d.path("out.bin");
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 6, b"world").unwrap();
        ws.write(id, 0, b"hello ").unwrap();
        ws.write(id, 11, b"!").unwrap();
        assert_eq!(ws.commit(id).unwrap(), WriteCommitted { size: 12 });
        assert_eq!(std::fs::read(&target).unwrap(), b"hello world!");
        assert_eq!(
            d.entries(),
            vec!["out.bin".to_string()],
            "no temp left behind"
        );
        // The session is gone after commit.
        assert!(ws
            .write(id, 0, b"x")
            .unwrap_err()
            .starts_with("NO_SUCH_WRITE"));
        assert!(ws.commit(id).unwrap_err().starts_with("NO_SUCH_WRITE"));
    }

    #[test]
    fn truncate_shrinks_and_extends() {
        let d = Scratch::new("trunc");
        let target = d.path("t.bin");
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 0, b"0123456789").unwrap();
        ws.truncate(id, 4).unwrap();
        ws.write(id, 6, b"X").unwrap(); // gap is zero-filled
        assert_eq!(ws.commit(id).unwrap().size, 7);
        assert_eq!(std::fs::read(&target).unwrap(), b"0123\0\0X");
    }

    #[test]
    fn commit_replaces_existing_target_atomically() {
        let d = Scratch::new("replace");
        let target = d.path("p.slp");
        std::fs::write(&target, b"OLD CONTENT THAT IS LONGER").unwrap();
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 0, b"new").unwrap();
        // Until commit the target is untouched.
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"OLD CONTENT THAT IS LONGER"
        );
        ws.commit(id).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(d.entries(), vec!["p.slp".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn commit_keeps_the_replaced_files_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let d = Scratch::new("perms");
        let target = d.path("p.slp");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 0, b"new").unwrap();
        ws.commit(id).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn abort_deletes_temp_and_leaves_target_untouched() {
        let d = Scratch::new("abort");
        let target = d.path("keep.slp");
        std::fs::write(&target, b"original").unwrap();
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        let temp = ws.temp_path(id);
        ws.write(id, 0, b"garbage garbage").unwrap();
        ws.abort(id).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(d.entries(), vec!["keep.slp".to_string()]);
        assert!(ws.abort(id).unwrap_err().starts_with("NO_SUCH_WRITE"));
    }

    #[test]
    fn read_only_target_is_refused_before_any_temp_exists() {
        let d = Scratch::new("readonly");
        let target = d.path("ro.slp");
        std::fs::write(&target, b"keep").unwrap();
        let mut perms = std::fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&target, perms.clone()).unwrap();
        let ws = WriteSessions::default();
        let err = ws.open(&target, true).unwrap_err();
        assert!(err.starts_with("READ_ONLY"), "{err}");
        assert_eq!(d.entries(), vec!["ro.slp".to_string()], "no temp created");
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&target, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_rename_removes_the_temp() {
        let d = Scratch::new("renamefail");
        let target = d.path("t.slp");
        let ws = WriteSessions::default();
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 0, b"x").unwrap();
        // A directory now sits where the file should go: rename must fail.
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("child"), b"c").unwrap();
        let err = ws.commit(id).unwrap_err();
        assert!(err.contains("rename"), "{err}");
        assert_eq!(d.entries(), vec!["t.slp".to_string()], "temp removed");
    }

    #[test]
    fn keep_existing_data_copies_the_target_first() {
        let d = Scratch::new("keep");
        let target = d.path("k.txt");
        std::fs::write(&target, b"abcdefgh").unwrap();
        let ws = WriteSessions::default();
        let id = ws.open(&target, true).unwrap().id;
        assert_eq!(std::fs::read(ws.temp_path(id)).unwrap(), b"abcdefgh");
        ws.write(id, 2, b"XY").unwrap();
        ws.commit(id).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"abXYefgh");

        // Without the flag the temp starts empty even though the target exists.
        let id = ws.open(&target, false).unwrap().id;
        ws.write(id, 0, b"z").unwrap();
        ws.commit(id).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"z");

        // keepExistingData on a missing target is just an empty start.
        let fresh = d.path("fresh.txt");
        let id = ws.open(&fresh, true).unwrap().id;
        assert_eq!(ws.commit(id).unwrap().size, 0);
        assert!(fresh.exists());
    }

    #[test]
    fn concurrent_sessions_are_independent_and_abort_all_cleans_up() {
        let d = Scratch::new("multi");
        let ws = WriteSessions::default();
        let a = ws.open(&d.path("a"), false).unwrap().id;
        let b = ws.open(&d.path("b"), false).unwrap().id;
        assert_ne!(a, b);
        ws.write(b, 0, b"B").unwrap();
        ws.write(a, 0, b"A").unwrap();
        ws.commit(a).unwrap();
        let c = ws.open(&d.path("c"), false).unwrap().id;
        ws.abort_all();
        assert_eq!(std::fs::read(d.path("a")).unwrap(), b"A");
        assert_eq!(d.entries(), vec!["a".to_string()], "b and c temps removed");
        assert!(ws.write(c, 0, b"x").is_err());
    }

    #[test]
    fn open_rejects_missing_parent_and_directory_target() {
        let d = Scratch::new("openerr");
        let ws = WriteSessions::default();
        assert!(ws
            .open(&d.path("no-such-dir").join("x"), false)
            .unwrap_err()
            .starts_with("NOT_FOUND"));
        std::fs::create_dir(d.path("dir")).unwrap();
        assert!(ws
            .open(&d.path("dir"), false)
            .unwrap_err()
            .starts_with("IS_A_DIRECTORY"));
        assert!(
            d.entries() == vec!["dir".to_string()],
            "no temp left on failure"
        );
    }

    // --- URLs ---------------------------------------------------------------

    #[test]
    fn external_url_scheme_allowlist() {
        assert_eq!(
            validate_external_url("https://luc3d.sleap.ai/docs").unwrap(),
            "https://luc3d.sleap.ai/docs"
        );
        assert!(validate_external_url("http://example.com").is_ok());
        assert!(validate_external_url("HTTPS://EXAMPLE.com/a").is_ok());
        assert!(validate_external_url("mailto:someone@example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "smb://server/share",
            "tauri://localhost",
            "ms-settings:privacy",
            "vscode://file/x",
            "not a url",
            "/relative/path",
            "http://",
        ] {
            assert!(validate_external_url(bad).is_err(), "{bad} must be refused");
        }
    }
}
