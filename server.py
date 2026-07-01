#!/usr/bin/env python3
"""
LUCID development server.

Serves static files WITH HTTP Range (206 Partial Content) support, so large
videos and .slp files stream to the browser via sleap-io.js instead of being
downloaded whole into memory (which crashes the tab on multi-GB videos).

NOTE: plain `python3 -m http.server` does NOT support Range requests — it
returns the entire file for every request. Use THIS server (or nginx / Caddy /
`npx http-server`) when serving videos/SLPs to LUCID, otherwise sleap-io.js
streaming falls back to a full download.

SLP export is handled client-side via sleap-io.js. A legacy /convert-slp
endpoint is still available if h5py is installed.

Usage:
    python server.py [port]
"""

import io
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer

# Try to import h5py for legacy /convert-slp endpoint
try:
    import h5py

    sys.path.insert(0, "scripts")
    from json_to_slp import write_slp_data

    HAS_H5PY = True
except ImportError:
    HAS_H5PY = False


class LucidHandler(SimpleHTTPRequestHandler):
    # HTTP/1.1 so Range/keep-alive behave; every response sets Content-Length.
    protocol_version = "HTTP/1.1"

    # Byte offsets for the current single-range GET, set by send_head().
    _range = None

    def end_headers(self):
        # Advertise Range support + allow cross-origin streaming (sleap-io fetch
        # from a different origin needs these exposed to read Content-Range).
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length",
        )
        super().end_headers()

    def send_head(self):
        """Serve 206 Partial Content for a single `Range: bytes=` request.

        Falls back to the stdlib full-file 200 path for directory listings,
        missing files, or requests without a (simple, single) Range header.
        """
        self._range = None
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        m = re.match(r"bytes=(\d*)-(\d*)\s*$", range_header.strip())
        if not m or (m.group(1) == "" and m.group(2) == ""):
            # Unsatisfiable / multi-range / malformed → serve the whole file.
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            file_len = os.fstat(f.fileno()).st_size
            start_s, end_s = m.group(1), m.group(2)
            if start_s == "":
                # Suffix range: last N bytes.
                length = min(int(end_s), file_len)
                start = file_len - length
                end = file_len - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s != "" else file_len - 1
                end = min(end, file_len - 1)

            if start >= file_len or start > end:
                self.send_response(416, "Requested Range Not Satisfiable")
                self.send_header("Content-Range", f"bytes */{file_len}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                f.close()
                return None

            self.send_response(206, "Partial Content")
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_len}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header(
                "Last-Modified", self.date_time_string(os.fstat(f.fileno()).st_mtime)
            )
            self.end_headers()
            self._range = (start, end)
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        """Copy only the requested byte range when serving a 206."""
        if not self._range:
            return super().copyfile(source, outputfile)
        start, end = self._range
        source.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

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
        # Access-Control-Allow-Origin is added globally in end_headers().
        self.end_headers()
        self.wfile.write(slp_bytes)

    def do_OPTIONS(self):
        # Access-Control-Allow-Origin is added globally in end_headers().
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = HTTPServer(("0.0.0.0", port), LucidHandler)
    print(f"LUCID server on http://0.0.0.0:{port}/")
    print("  SLP export: client-side via sleap-io.js (no server dependency)")
    if HAS_H5PY:
        print("  Legacy /convert-slp endpoint: available (h5py found)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
