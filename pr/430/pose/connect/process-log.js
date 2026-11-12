/**
 * Port of sleap-app src/lib/processLog.ts @ 683a159.
 *
 * LUCID changes: none (types dropped; `logLineClassName` keeps sleap-app's Tailwind class strings verbatim, the LUCID UI maps them to its own CSS).
 */
/**
 * Shared helpers for the training / inference subprocess log + error surfacing.
 *
 * - {@link appendLogLine} keeps the log bounded so a long run (e.g. inference over
 *   a large video) can't grow the array/DOM without limit.
 * - {@link subprocessFailureMessage} lifts the last stderr line into the error
 *   banner so a failure shows the actual cause, not just "exit code N".
 */

/** Max lines retained in a subprocess log (matches PyQt-era behavior). */
export const MAX_LOG_LINES = 1000;

/**
 * Append `line` to `log`, dropping the oldest lines so the result never exceeds
 * `max`. Returns a new array (safe for store `set`).
 */
export function appendLogLine(
  log,
  line,
  max = MAX_LOG_LINES,
) {
  const next = [...log, line];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The last non-empty (trimmed) line of `lines`, or null if there is none. */
export function lastErrorLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim();
    if (t) return t;
  }
  return null;
}

/**
 * Build a human error message for a failed subprocess: `"{what} failed (exit code
 * {code})"`, plus the last stderr line as the likely cause when one is available.
 */
export function subprocessFailureMessage(
  what,
  code,
  stderrTail,
) {
  const base = `${what} failed (exit code ${code ?? "unknown"})`;
  const cause = lastErrorLine(stderrTail);
  return cause ? `${base}: ${cause}` : base;
}

/**
 * Whether a log line looks like an error/warning — used by the log terminal's
 * "errors only" filter. Broader than the coloring check so a traceback body is
 * kept alongside the exception line.
 */
export function isErrorLine(line) {
  return /error|traceback|exception|fail|\bwarn/i.test(line);
}

/**
 * Tailwind text class for a log line by content, matching the training panel's
 * coloring: best epoch → green, error → red, section marker (`—`) → yellow,
 * otherwise unstyled. Shared by the inline log and the log terminal modal.
 */
export function logLineClassName(line) {
  if (line.includes("*** best ***")) return "text-green-400";
  if (/error/i.test(line)) return "text-destructive";
  if (line.startsWith("—")) return "text-yellow-400";
  return "";
}
