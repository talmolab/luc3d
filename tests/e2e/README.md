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

Each file serves the app itself, so there is nothing to start first:

```bash
node tests/run-e2e-tests.mjs                # every file, several at a time
node tests/run-e2e-tests.mjs plane save-    # files whose name contains a filter
node tests/run-e2e-tests.mjs --failed       # what failed last time in this checkout
node tests/e2e/session-video-scoping.mjs    # one file on its own
```

Exit code `0` = pass. The runner (`tests/run-e2e-tests.mjs`, `--help` for its
options):

- runs files several at a time (half the cores the current load leaves idle,
  1 to 8; `-j N` to choose), slowest first, from the last runs' times;
- stops a file after `--timeout` seconds (default 600) with the browser and any
  server it started;
- runs every failure again ALONE: one that then passes is reported as "passed
  alone" (load or timing) and does not fail the run;
- reports a file that prints a line starting with `SKIP` as skipped, not passed;
- runs the files in `known-failures.json` (red on main for a stated reason)
  without failing the run, and says when one passes again;
- keeps each file's output in a log folder named at the start and the end.

`HEADED=1` runs one file at a time (a visible window: see `scripts/browser-lock.mjs`).

Environment switches (any file, through `lib/harness.mjs`):

- `LUC3D_E2E_CHANNEL=chrome` runs Google Chrome instead of Playwright's
  Chromium (CI does).
- `LUC3D_E2E_TRACE=1` logs each page's console errors, uncaught errors,
  crashes, navigations, failed requests and downloads to stderr. The runner
  sets it when it reruns a failure alone.

## CI

`.github/workflows/tests.yml` runs on every pull request and every push to
`main`: the Node and browser unit suites in one job, and these files in four
shards (`node tests/run-e2e-tests.mjs --shard I/4 -j 2`) in Google Chrome, with
ffmpeg and the offline packages installed. Each shard's summary is on the run's
page, each failure is an annotation on its file, and a failed shard's logs
(with the traced rerun) are a run artifact for a week.

The shards are split by `timings.json` (committed), so every machine computes
the same split. After adding a slow file, refresh it:
`node tests/run-e2e-tests.mjs --write-timings`. A stale entry only costs
balance, never coverage.

## Writing a test

Serve the app and open the browser through `lib/harness.mjs`:

```js
import { startServer, launchBrowser } from './lib/harness.mjs';

const server = await startServer(repoRoot);   // a free port, ready when this resolves
const PORT = server.port;                      // or server.url
const browser = await launchBrowser();         // chromium.launch(), plus the CDN cache
// ... page.goto(`http://localhost:${PORT}/index.html`) ...
// finally: await browser.close(); server.close();
```

- **`startServer(root)`** serves `root` from the test's own process and answers
  like `python3 -m http.server` (same types and headers, no Range support;
  `tests/test-e2e-harness.mjs` compares the two). Never spawn a Python server
  or pick a fixed port: a port another session's server already held made a
  test run against that worktree's code. `PORT=` still picks the port, and
  fails loudly when it is taken. `{ cors: true }` makes a second, cross-origin
  server (as `image-model-package.mjs` does for a model package).
- **`launchBrowser(options)`** keeps jsdelivr and Hugging Face downloads in a
  disk cache shared by every worktree (`LUC3D_E2E_CACHE`, default
  `<tmp>/luc3d-e2e-cache`; `LUC3D_E2E_CDN_CACHE=0` turns it off). A versioned
  URL is reused as is; the model's `resolve/main/…` files are reused only while
  their ETag is unchanged. A test's own `route()` still runs first, so tests
  that cut the network (`image-check-offline.mjs`) still do.
- A test that cannot run here (no Brave, no network) prints a line starting
  with `SKIP` and exits 0.
- `offline-server.mjs` is the one file that still starts a Python server:
  `server.py --offline` is what it tests.

## Tests

- **`move-video-lazy-members.mjs`** — moving a view to another session must
  re-solve the origin session's groups from REAL 2D on a lazy project. A
  synthetic 4-camera project is reopened lazily (so non-resident frames' group
  members are `_lazy2d` placeholders, as after Track All since #280), a second
  session is added, and one camera is moved through the real "Move videos"
  modal. Each probed group's 3D must equal the app's own solve on its hydrated
  2D without that camera — on non-resident frames and on the resident current
  frame — no group may keep its stale 3D, and the members must be placeholders
  again afterwards. (Fails against `moveVideosToSession` without the hydration:
  0/10 non-resident groups re-solved, all 10 kept their stale 3D.)
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
- **`panel-rail.mjs`** — the info panel's panels are an accordion stack of
  collapsible sections driven by an icon rail on the window's right edge
  (`ui/panel-rail.js`, sleap-app's sidebar in its multi-panel mode); it
  replaced the horizontal tab bar. Asserts one Lucide icon per panel in the old
  tab order (sleap-app's glyphs where the panels match; ArrowLeftRight for ID
  Switches), each named, and one section per pane with a fold chevron and ✕;
  that hover widens the rail to show names without reflow and that the label
  strip never covers the panel's controls; sleap-app's accordion rules (a rail
  click opens + expands and folds the others, the expanded one folds, header
  chevrons fold only their own section, ✕ closes, closing the last hides the
  info panel and showing it reopens Instances); that the info panel is the one
  scroller with sticky section headers; that `I`, the Panel button, View ▸
  Toggle Info Panel and the rail's top button hide/show it keeping the stack;
  Tab/Enter on icons and headers; that `openIdSwitchPanel` opens + expands
  without hiding or folding; that Define Planes hides the stack and locks the
  icons; and that open/folded sections survive a reload.
- **`videos-panel-buttons.mjs`** — the Videos tab's two buttons (luc3d #216).
  Clicks **Load Videos** on a FRESH page with no session loaded (the bug: both
  handlers were assigned inside `updateInfoPanel`, which returns early when
  `state.session` is null, so the button carried no handler at all while
  `File ▸ Load Videos…` worked), then selects a row and clicks **Remove Video**
  and asserts the whole video goes: no dockview pane, no `.video-cell`, no
  view-strip thumbnail, the decoder `close()`d and out of the pool, and
  `session.videoFileIndices` remapped across the `state.videoFiles` splice —
  with the second video keeping all of it as the control. Generates its own
  tiny H.264 clips with ffmpeg (headless Chromium cannot decode the HEVC the
  real sessions ship) and skips cleanly if ffmpeg is absent. §7 then covers the
  solo-mode edge case: with `v` active, removing a *different* video used to
  (a) leave the removed view in `savedGridLayout`, so `g` rebuilt an empty pane
  wearing its name, and (b) drift `state.singleViewIndex`, which is positional,
  onto the next camera along; removing the solo'd view itself (c) closed the
  only pane and left the dock empty. Every behavioural assertion was confirmed
  to fail on the pre-fix build.
- **`fragmented-mp4-load.mjs`** — a FRAGMENTED MP4 (campy's default output)
  loads whole. `_initMp4box` stopped at mp4box's `onReady`, which fires on the
  empty moov, so only the first chunk's fragments were counted (a 1,200-frame
  60 fps rig video: 420 frames at 21 fps in HTML5 mode; 1,200 frames but
  `state.fps` 30 with mediabunny). Loads
  `tests/fixtures/fragmented-60/fragmented-60.mp4` (1,200 barcode frames at
  60 fps, campy's muxer flags) with small read sizes, in HTML5 and mediabunny
  modes, and asserts the frame count, the fps, `updateTotalFrames`' fps, that
  mdat payloads were skipped while mp4box held no earlier chunk, frames past
  the first chunk by barcode, that a copy cut off mid-fragment counts only the
  frames whose bytes are in the file (1,165, as ffprobe decodes), and that a
  regular MP4 does no fragment scan. `RIG_VIDEO=<path>` (HEVC: with
  `CHANNEL=chrome`) also loads a real recording. Fails 8 checks on the pre-fix
  build.
- **`info-panel-many-tracks.mjs`** — the Instances panel must not cost
  O(rows x tracks) per update. Its Track `<select>`s are rebuilt on every
  `updateFrameInfo` (~10 Hz in playback), and each used to hold an `<option>`
  per session track: 863 tracks x ~40 rows on a real prediction project capped
  playback at ~5 fps. Drives the real `updateFrameInfo` on 8 cameras with 10 and
  with 1,000 tracks and asserts the same `<option>` count for both (at most 3
  per closed Track select), that every closed select shows what the eager build
  did, that a real click (and focus, the keyboard path) fills head + every track
  in order + tail without resizing the select, and that picking a track (with
  its swap), `(none)` on a group and `(+) New Track` still work. Confirmed to
  fail on the eager build (43,387 options, ~228 ms per update, against 421 and
  ~7 ms); the behaviour checks pass on both, so they pin equivalence.
