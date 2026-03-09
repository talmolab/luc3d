#!/usr/bin/env python3
"""
LUCID development server.

Serves static files and provides a /convert-slp endpoint that converts
JSON export data to SLEAP .slp (HDF5) format using h5py.

Usage:
    python server.py [port]

Requires: h5py, numpy (for SLP conversion)
    pip install h5py numpy
"""

import io
import json
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer

# Try to import h5py and the conversion function
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
                503, "h5py not installed. Run: pip install h5py numpy"
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
    if HAS_H5PY:
        print("  /convert-slp endpoint: ready (h5py available)")
    else:
        print("  /convert-slp endpoint: unavailable (pip install h5py numpy)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
