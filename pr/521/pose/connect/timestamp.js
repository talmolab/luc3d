/**
 * Port of sleap-app src/lib/timestamp.ts @ 683a159.
 *
 * LUCID changes: none (the file has no header of its own; JSDoc only).
 */
/** `12s` / `3m 4s` / `1h 2m` — a short elapsed-time label for training/run UI. */
export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `YYMMDD_HHMMSS`, matching legacy SLEAP's `get_timestamp()` (sleap/gui/learning/runners.py) — used for predictions filenames and training run names. */
export function formatRunTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Extracts the leading `YYMMDD_HHMMSS` run timestamp from a worker's
 * `model_name` (the basename of a finished train job's model folder, e.g.
 * `"260922_015758.centroid.n=1"` — see `JobSummary.modelName`'s doc) —
 * `null` when absent, or the name doesn't start with one (an older worker
 * that doesn't send `model_name` in this shape). Shared by `WorkerJobs`
 * (a training run's group title/row) and `NewJobWizard`'s "Start config
 * from" dropdown (a past run's dropdown label).
 */
export function modelRunTimestamp(modelName) {
  if (!modelName) return null;
  const m = /^(\d{6}_\d{6})/.exec(modelName);
  return m ? m[1] : null;
}

/** Compact "N ago" for an ISO timestamp — mirrors WelcomeScreen's own `timeAgo` (which takes a raw `ms` elapsed instead). Shared by `WorkerJobs` (job age) and `NewJobWizard`'s Inference "Models" list (run age) — a plain import avoids a `WorkerJobs` <-> `NewJobWizard` circular dependency (the two already cross-import each other's exports). */
export function timeAgo(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}
