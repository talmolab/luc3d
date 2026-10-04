LUCID — offline copy
====================

Everything LUCID needs is already in this folder. Nothing is downloaded when you
run it, so this works with the network switched off.


Start it
--------

  Windows    Right-click start-windows.ps1 -> "Run with PowerShell"
             (Nothing to install. PowerShell comes with Windows.)

  macOS      Right-click start-macos.command -> Open, then Open again.
             The first time, macOS says the file is "from an unidentified
             developer". That is Gatekeeper flagging a downloaded script; the
             right-click -> Open route is how you approve it. Double-clicking
             works from then on.

  Linux      ./start-linux.sh

A browser opens at http://localhost:8080/. Press Ctrl+C in the terminal window to
stop the server when you are done.

To use a different port, pass it as an argument, e.g. ./start-linux.sh 8081 or
.\start-windows.ps1 -Port 8081.


Requirements
------------

  * Google Chrome or Microsoft Edge.

    LUCID uses the File System Access and WebCodecs APIs. Firefox and Safari do
    not support them, so the app will not work there. On Windows, the Edge that
    came with your PC is fine.

  * On macOS and Linux only: Python 3 or Ruby, for the start script.

    Most machines already have one. If neither is present the start script says
    exactly what to install. Windows needs nothing extra.


Why can't I just open index.html?
---------------------------------

Browsers block module workers — which LUCID uses to read and write .slp files —
when a page is opened as a file:// URL. No browser flag changes this. The start
scripts exist to serve the folder over http://localhost, which is all LUCID needs.


What's in here
--------------

  index.html, app.js, pose/, ui/, loading/, import-export/
                        the application itself
  lib/                  its dependencies, including the four (three.js, mp4box,
                        dockview-core, yaml) that the online version streams from
                        a CDN. Here they are local, which is what makes this copy
                        work offline.
  lib/LICENSES.txt      licenses for everything in lib/
  tests/                the in-browser test suite, at /tests/test-runner.html

This copy is pinned: its dependency versions are fixed and will not change under
you. The online version at https://luc3d.sleap.ai/ is always the current release.
