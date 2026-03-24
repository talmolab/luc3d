#!/usr/bin/env python3
"""
LUCID development server.

Serves static files. SLP export is now handled client-side via sleap-io.js.
A legacy /convert-slp endpoint is still available if h5py is installed.

Usage:
    python server.py [port]
    # or simply: python3 -m http.server 8080
"""

import io
import json
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
            super().do_OPTIONS()


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
