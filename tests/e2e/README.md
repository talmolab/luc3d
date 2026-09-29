# LUCID end-to-end tests

Real-browser (headless Chromium via Playwright) tests that drive the actual app
and assert on runtime state (`window.__lucid.state`). These complement the
in-browser unit tests in `tests/test-runner.html` — they exercise the true
load/switch code paths (decoders, dockview panels, session bookkeeping) that a
DOM-less unit test cannot.

The app has **no build step**; this directory is a self-contained test harness
with its own `package.json`. `node_modules/` here is git-ignored.

## Setup (once)

```bash
cd tests/e2e
npm install          # installs playwright + downloads Chromium
```

On Linux you may also need system libraries for Chromium:

```bash
npx playwright install-deps chromium   # or apt-get install the libnss3/libnspr4/... set
```

## Run

From the **repo root**, start the static server, then run a test:

```bash
python3 -m http.server 8080            # terminal 1 (repo root)
node tests/e2e/session-video-scoping.mjs   # terminal 2
```

Override the base URL with `BASE=http://host:port`. Exit code `0` = pass.

## Tests

- **`session-video-scoping.mjs`** — regression guard for the multi-session
  "second session shows both videos" bug. Verifies that loading a video into one
  session never leaks its view / camera / `videoFileIndices` into another
  session, across `+`-new-session, boot-session, and session-switch flows.
  (Fails against the pre-fix `handleLoadVideos`; passes against the scoped
  `newVideoFiles` version.)
- **`occlusion-roundtrip.mjs`** — regression guard for the project-`.slp`
  round-trip bug (branch `eric/occlusion-skeleton-issue`). Builds a project with
  a grouped user instance whose node is occluded (`nulledNodes`), saves it to
  `.slp` via the real save path, assembles a session folder (project.slp +
  calibration.toml + `videos/<cam>.mp4`), then REOPENS it through
  `handleLoadSessionFolderSingleSlp` and asserts the occlusion, InstanceGroup
  grouping, and 3D points survive. (Fails against the pre-fix session-folder
  loader, which rebuilt flat poses and dropped all of it; passes with the shared
  `restoreGroupingAndUnlink` path.)

- **`export-include-user-labels.mjs`** — the "Export SLEAP File Per Session" and
  "Export SLEAP File By Cam" modals must SAY that user labels are always written
  (luc3d #194). Both always passed `instanceFilter.user = true`, but with only
  "Predicted Instances" and "Reprojections" visible under a heading reading
  *Include*, users read the silence as an exclusion; the group now says
  "✓ UserLabels are automatically saved". Pins the UI contract — the note comes
  first and is PROSE (an always-on switch was tried and is wrong: a
  control that cannot be operated misstates what the user can change), the group
  has exactly two option rows, the option ids the export handlers read survive,
  and each `.slider` actually drives its checkbox (a `.toggle-switch` not wrapped
  in a `<label>` renders identically and never toggles) — and then the claim
  itself: a Per-Session export with Predicted and Reprojections both OFF is read
  back and every user instance is still there. Also covers the Per-Session
  filename table: the output field and Download checkbox are asserted by
  COMPUTED STYLE to use the app's dark tokens and monospace stack rather than
  the browser defaults (a white box in Arial), unchecked rows dim, `title` stays
  in sync with an edited name, and a filename containing a `"` reaches the field
  intact — pre-fix it was truncated at the quote, because the rows are built by
  string concatenation. Confirmed red against the pre-fix modals.

- **`save-session-3d-typed-sink.mjs`** — guards the `luc3d #185` local patch to
  the vendored writer, which accumulates `/session_data/points_3d` and
  `pred_points_3d` into a pre-sized `Float64Array` instead of one boxed
  `Array(3|4)` per 3D keypoint (531,799 instance groups x 15 nodes = 7,976,985 of
  them, an estimated ~400 MB of V8 pointer-compressed heap, on the real
  180,210-frame x 5-camera project whose merged Save As OOM'd the renderer). Pins
  the exact values written — a fully-null 3D row, an individually-null
  coordinate, a missing point score — plus a 4,000-frame-group scenario
  interleaving user and predicted 3D instances, since the patch's sizing
  pre-pass must stay in lockstep with the write loop. Writes past the end of a
  typed array are silently discarded, so an undercount would corrupt 3D points
  with no error; the sink throws instead, and this test proves it. Every
  assertion was validated against the pre-patch writer first, so it pins
  equivalence rather than merely current behavior.
