#!/bin/bash
# Start LUCID offline on Linux:  ./start-linux.sh [port]
#
# LUCID needs a real HTTP server: it uses module workers, which browsers block over
# file://, so opening index.html directly can never work.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${1:-8080}"

open_browser() {
    if command -v xdg-open >/dev/null 2>&1; then
        (sleep 1; xdg-open "http://localhost:$PORT/" >/dev/null 2>&1) &
    fi
}

echo ""
echo "  LUCID (offline) -> http://localhost:$PORT/"
echo "  Serving $(pwd)"
echo "  Press Ctrl+C to stop."
echo ""

if python3 -c "" >/dev/null 2>&1; then
    open_browser
    exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi

if ruby -e "" >/dev/null 2>&1; then
    echo "   (using Ruby -- python3 is not available)"
    open_browser
    exec ruby -run -e httpd . -p "$PORT" -b 127.0.0.1
fi

cat <<'MSG'
!! No usable web server was found.

   Install Python 3 with your package manager, for example:
       sudo apt install python3          # Debian / Ubuntu
       sudo dnf install python3          # Fedora

   Then run this script again.
MSG
exit 1
