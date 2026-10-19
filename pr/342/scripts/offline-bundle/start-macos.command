#!/bin/bash
# Start LUCID offline on macOS. Double-click this file.
#
# The FIRST time, macOS may refuse with "cannot be opened because it is from an
# unidentified developer" -- that is Gatekeeper quarantining a downloaded script,
# not a problem with the file. Right-click it and choose Open, then Open again.
#
# LUCID needs a real HTTP server: it uses module workers, which browsers block over
# file://, so opening index.html directly can never work. This tries whatever your
# Mac already has before asking you to install anything.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${1:-8080}"

open_browser() { (sleep 1; open "http://localhost:$PORT/") & }

echo ""
echo "  LUCID (offline) -> http://localhost:$PORT/"
echo "  Serving $(pwd)"
echo "  Press Ctrl+C to stop."
echo ""

# python3 first. On a Mac without Command Line Tools /usr/bin/python3 is only a
# stub, so actually run it rather than trusting that the file exists.
if python3 -c "" >/dev/null 2>&1; then
    open_browser
    exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi

# Ruby still ships with macOS and WEBrick is in its stdlib.
if ruby -e "" >/dev/null 2>&1; then
    echo "   (using Ruby -- python3 is not available)"
    open_browser
    exec ruby -run -e httpd . -p "$PORT" -b 127.0.0.1
fi

cat <<'MSG'
!! No usable web server was found on this Mac.

   LUCID cannot be opened as a file; it needs something serving it over HTTP.
   Install Apple's Command Line Tools -- one click, no account needed -- by
   running this in Terminal and accepting the dialog:

       xcode-select --install

   Then double-click this file again.
MSG
exit 1
