#!/usr/bin/env python3
"""
LUCID development server.

Serves static files. SLP export is now handled client-side via sleap-io.js.
A legacy /convert-slp endpoint is still available if h5py is installed.

Usage:
    python3 server.py [port]             # normal: dependencies load from a CDN
    python3 server.py --offline          # serve the vendored copies in lib/
    # or simply: python3 -m http.server 8080   (online only)

On Windows use `py` in place of `python3`.

--offline rewrites the CDN URLs in .html/.js/.mjs responses to point at lib/, so
the working tree keeps its CDN URLs and nothing is committed by accident. It is
for developing against the offline path; to hand someone a copy that runs offline
under any static server, build a pre-rewritten zip instead:

    python3 scripts/offline_deps.py bundle
"""

import argparse
import io
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import offline_deps  # noqa: E402  (needs the path above)

# Set from the CLI in main(); {} means "serve the CDN URLs unchanged".
REWRITES = {}

# Try to import h5py for the legacy /convert-slp endpoint. Nothing else needs it:
# serving the app -- online or offline -- never touches h5py, so a broken install
# must not take the server down with it.
#
# Deliberately `Exception`, not `ImportError`: a mismatched h5py/numpy pair raises
# ValueError("numpy.dtype size changed, may indicate binary incompatibility") from
# inside h5py's Cython init, which an ImportError-only guard lets through. That is
# routine in a conda environment, and it used to kill the server at startup for a
# feature the user was not asking for.
try:
    import h5py

    sys.path.insert(0, "scripts")
    from json_to_slp import write_slp_data

    HAS_H5PY = True
except Exception as exc:                                        # noqa: BLE001
    HAS_H5PY = False
    print("note: /convert-slp disabled (h5py unavailable: %s: %s)"
          % (type(exc).__name__, exc))


class LucidHandler(SimpleHTTPRequestHandler):
    # Keep-alive, so a cold load reuses ~6 connections instead of opening one per
    # file. Safe only because the server is threaded (above): single-threaded
    # keep-alive deadlocks, since the server sits waiting for the next request on
    # one connection while the browser waits for responses on the others. Every
    # response here carries an accurate Content-Length, which HTTP/1.1 requires.
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        rewritten = self._rewritten_body()
        if rewritten is None:
            super().do_GET()
            return
        self._send_rewritten(*rewritten, include_body=True)

    def do_HEAD(self):
        rewritten = self._rewritten_body()
        if rewritten is None:
            super().do_HEAD()
            return
        self._send_rewritten(*rewritten, include_body=False)

    def _rewritten_body(self):
        """(bytes, fs_path) for this request, or None to serve the file as-is."""
        if not REWRITES:
            return None

        url_path = self.path.split("?", 1)[0].split("#", 1)[0]
        fs_path = self.translate_path(self.path)
        if os.path.isdir(fs_path):
            fs_path = os.path.join(fs_path, "index.html")
            url_path = url_path.rstrip("/") + "/index.html"
        # Which files get rewritten is offline_deps' call, so the served tree and
        # `bundle`'s zip cannot drift. .js matters as much as .html: two of the CDN
        # references are ESM imports inside ui/sessions-panes.js and
        # ui/overlay-export-modal.js, not script tags.
        if not offline_deps.is_rewritable(url_path.lstrip("/")):
            return None
        if not os.path.isfile(fs_path):
            return None

        try:
            text = Path(fs_path).read_text(encoding="utf-8", errors="surrogateescape")
        except OSError:
            return None

        # Depth of the requested file below the site root decides how many ../
        # the local path needs: /index.html -> ./lib/..., /ui/x.js -> ../lib/...
        depth = max(0, len([p for p in url_path.split("/") if p]) - 1)
        new = offline_deps.rewrite_text(text, REWRITES, depth)
        if new == text:
            return None
        # fs_path, not self.path: for "/" the latter names the DIRECTORY, whose
        # guessed type is application/octet-stream -- which makes the browser
        # download the page instead of rendering it.
        return new.encode("utf-8", "surrogateescape"), fs_path

    def _send_rewritten(self, body, fs_path, include_body):
        ctype = self.guess_type(fs_path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # These were the only responses with no validator at all -- every other
        # file gets Last-Modified from send_head() -- which left them uncacheable
        # rather than merely revalidated.
        #
        # Deliberately NOT answering If-Modified-Since with a 304: mtime does not
        # change when --offline is toggled, but the body does, so an mtime-only
        # 304 would hand the browser a cached CDN body while serving offline (or
        # the reverse) and half the app would point at the wrong place. Keep
        # no-cache + a full 200 on revalidation; a 304 here needs a validator that
        # includes the mode.
        self.send_header("Last-Modified", self.date_time_string(os.stat(fs_path).st_mtime))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def do_POST(self):
        if self.path == "/convert-slp":
            self._handle_convert_slp()
        else:
            self.send_error(404, "Not Found")

    def _handle_convert_slp(self):
        if not HAS_H5PY:
            self.send_error(
                503, "Legacy endpoint: h5py not installed. Use client-side export instead."
            )
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self.send_error(400, "Empty request body")
            return

        try:
            body = self.rfile.read(content_length)
            data = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self.send_error(400, f"Invalid JSON: {e}")
            return

        try:
            buf = io.BytesIO()
            with h5py.File(buf, "w") as h5:
                write_slp_data(data, h5)
            slp_bytes = buf.getvalue()
        except Exception as e:
            self.send_error(500, f"Conversion failed: {e}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-hdf5")
        self.send_header("Content-Length", str(len(slp_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(slp_bytes)

    def do_OPTIONS(self):
        if self.path == "/convert-slp":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
        else:
            # SimpleHTTPRequestHandler has no do_OPTIONS, so deferring to super()
            # here raised AttributeError -> 500 on any other OPTIONS request.
            self.send_error(501, "Unsupported method (OPTIONS)")


def enable_offline():
    """Load the rewrite table, refusing to start if the packages are missing.

    Failing loudly matters more than usual here: a half-offline page looks like it
    worked, then dies on the first missing import with a console error nobody sees.
    """
    manifest = offline_deps.load_manifest()
    missing = [
        name for name, spec in manifest["packages"].items()
        if not offline_deps.package_status(name, spec)[0]
    ]
    if missing:
        print("!! Cannot serve offline: %s not installed." % ", ".join(missing),
              file=sys.stderr)
        print("   Run this once, while connected:", file=sys.stderr)
        print("       python3 scripts/offline_deps.py install", file=sys.stderr)
        return None
    return offline_deps.replacement_map(manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(description="LUCID development server.")
    parser.add_argument("port", nargs="?", type=int, default=8080,
                        help="port to listen on (default: 8080)")
    parser.add_argument("--offline", action="store_true",
                        default=os.environ.get("LUCID_OFFLINE") == "1",
                        help="serve lib/ instead of the CDN (also: LUCID_OFFLINE=1)")
    args = parser.parse_args(argv)

    global REWRITES
    if args.offline:
        REWRITES = enable_offline()
        if REWRITES is None:
            return 1

    # Threaded + keep-alive, which is what `python -m http.server` itself does.
    # A cold load pulls ~70 ES modules plus lib/, and offline mode adds the four
    # that normally come from a CDN on a separate host -- so ALL of it funnels
    # through here. Single-threaded HTTP/1.0 gave that one TCP connection per
    # file, handled strictly one at a time, behind a listen backlog of 5 that
    # Chrome's 6 parallel connections already overflow. A plain reload mostly
    # revalidates (304s) and survives it; a hard refresh or a fresh tab re-fetches
    # everything and does not.
    server = ThreadingHTTPServer(("0.0.0.0", args.port), LucidHandler)
    server.daemon_threads = True
    mode = "OFFLINE (dependencies from lib/)" if args.offline else "online (dependencies from CDN)"
    print(f"LUCID server on http://0.0.0.0:{args.port}/")
    print(f"  Mode: {mode}")
    print("  SLP export: client-side via sleap-io.js (no server dependency)")
    if HAS_H5PY:
        print("  Legacy /convert-slp endpoint: available (h5py found)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
