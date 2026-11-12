/**
 * Port of sleap-app src/lib/protocolV1/deviceName.ts @ 683a159.
 *
 * The name this device reports to sleap-connect workers (`hello`'s
 * `agent.device_name`), shown to everyone who can see the worker's paired
 * devices. The user can rename it; this is only the default.
 *
 * Desktop asks the OS (the `computer_name` command: macOS Computer Name,
 * Windows COMPUTERNAME, Linux pretty/kernel hostname). A browser can't read
 * the computer's name at all, so it gets "<Browser> on <OS>" from the user
 * agent — as does desktop if the OS lookup comes back empty.
 *
 * LUCID changes:
 *  - `defaultDeviceName` no longer imports `isTauri` / `@tauri-apps/api` /
 *    `sleapCmd`. The caller injects the desktop lookup as
 *    `opts.computerName` (an async function returning the OS computer name,
 *    e.g. a wrapper over the shell's `computer_name` command; omit it in a
 *    plain browser) and may inject `opts.userAgent`. `navigator` is read at
 *    call time only, never at import time.
 */

/** Longest name sent; the worker truncates too, this just keeps the UI sane. */
export const DEVICE_NAME_MAX = 64;

/**
 * Trims and caps a user- or OS-supplied name; null if nothing's left.
 * @param {string | null | undefined} name
 * @returns {string | null}
 */
export function normalizeDeviceName(name) {
  const s = (name ?? "").replace(/\s+/g, " ").trim().slice(0, DEVICE_NAME_MAX).trim();
  return s ? s : null;
}

/**
 * "Chrome on macOS" etc. from a user-agent string.
 * @param {string} ua
 * @returns {string}
 */
export function browserDeviceName(ua) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * This device's default name: the OS computer name when `opts.computerName`
 * is given and returns something, else "<Browser> on <OS>".
 * @param {{ computerName?: (() => Promise<string | null | undefined>) | null, userAgent?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function defaultDeviceName(opts = {}) {
  if (opts.computerName) {
    try {
      const name = normalizeDeviceName(await opts.computerName());
      if (name) return name;
    } catch {
      // Older shell without the command, or the lookup failed — fall through.
    }
  }
  const ua = opts.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return browserDeviceName(ua);
}
