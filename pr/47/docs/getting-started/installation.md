# Installation

LUC3D is a static web application — there is no build step or package to install. You just need a local HTTP server to serve the files.

## Clone the Repository

```bash
git clone https://github.com/erl-ang/lucid.git
cd lucid
```

## Serve Locally

=== "Python (recommended)"

    ```bash
    python3 -m http.server 8080
    ```

    Or use the included server script:

    ```bash
    python3 server.py
    ```

=== "Node.js"

    ```bash
    npx serve .
    ```

=== "Any static server"

    Point any static file server at the repository root. LUC3D has no server-side dependencies.

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## Browser Requirements

LUC3D requires a modern browser with **WebCodecs** support for hardware-accelerated video decoding:

| Browser | Minimum Version | Status |
|---------|----------------|--------|
| Chrome  | 94+            | Full support |
| Edge    | 94+            | Full support |
| Firefox | —              | Not yet supported (falls back to HTML5 video) |
| Safari  | —              | Not yet supported (falls back to HTML5 video) |

!!! tip
    Chrome or Edge is strongly recommended for the best experience with frame-accurate video seeking and multi-view playback.

## Dependencies

All dependencies are loaded from CDN via script tags — no `npm install` needed:

- **Three.js 0.147** — 3D viewport rendering
- **mp4box.js** — MP4 container parsing for WebCodecs
- **h5wasm 0.8.8** — WebAssembly HDF5 reading/writing
- **sleap-io.js 0.2.1** — Client-side SLEAP `.slp` file export

## Running Tests

Open the test runner in your browser:

```
http://localhost:8080/tests/test-runner.html
```
