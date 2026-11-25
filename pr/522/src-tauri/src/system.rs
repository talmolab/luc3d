//! Host facts for the page (About box, diagnostics, sizing worker pools).

use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// `std::env::consts::OS`: "macos" | "windows" | "linux" | ...
    pub os: &'static str,
    /// `std::env::consts::ARCH`: "aarch64" | "x86_64" | ...
    pub arch: &'static str,
    pub cpus: usize,
    /// None when the platform query fails.
    pub total_memory_bytes: Option<u64>,
    pub app_version: String,
    pub tauri_version: &'static str,
    pub desktop: bool,
}

#[cfg(target_os = "linux")]
fn total_memory_bytes() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    parse_meminfo_total(&info)
}

/// `MemTotal:       16318412 kB` -> bytes.
#[cfg(any(target_os = "linux", test))]
fn parse_meminfo_total(info: &str) -> Option<u64> {
    let line = info.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

#[cfg(target_os = "macos")]
fn total_memory_bytes() -> Option<u64> {
    let mut value: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: "hw.memsize" is a NUL-terminated name; `value`/`len` describe a
    // valid u64 out-buffer, which is the type this sysctl returns.
    let rc = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0 && value > 0).then_some(value)
}

#[cfg(target_os = "windows")]
fn total_memory_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is plain data; dwLength must be set before the call.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status.ullTotalPhys)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn total_memory_bytes() -> Option<u64> {
    None
}

#[tauri::command]
pub fn system_info<R: Runtime>(app: AppHandle<R>) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        cpus: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        total_memory_bytes: total_memory_bytes(),
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION,
        desktop: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo_total_is_parsed_as_bytes() {
        let sample = "MemTotal:       16318412 kB\nMemFree:         1000 kB\n";
        assert_eq!(parse_meminfo_total(sample), Some(16318412 * 1024));
        assert_eq!(parse_meminfo_total("garbage"), None);
    }

    #[test]
    fn this_host_reports_memory() {
        assert!(total_memory_bytes().unwrap_or(0) > 0);
    }
}
