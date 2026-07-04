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

- **`sleap-video-streaming.mjs`** — crash-fix proof for the sleap-io.js video
  loader. Drives `SleapVideoDecoder` against a URL and asserts the memory-safe
  behavior that fixes the "Aw Snap" OOM on large / server-mounted videos: it
  streams over **HTTP Range (206)**, creates **no HTML5 `<video>` element**, and
  decodes a frame via WebCodecs. **Requires a Range-capable server** — run
  `python server.py 8085` (NOT `python -m http.server`, which ignores Range):
  ```bash
  python server.py 8085                                   # repo root
  BASE=http://localhost:8085 node tests/e2e/sleap-video-streaming.mjs
  ```
