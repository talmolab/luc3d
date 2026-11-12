# Start LUCID offline on Windows.
#
# PowerShell ships with every supported Windows, so this needs nothing installed --
# no Python, no Node. It serves this folder over http://localhost:8080/ and opens a
# browser. Press Ctrl+C in this window to stop.
#
# If Windows blocks the script, right-click it and choose "Run with PowerShell", or
# run:  powershell -ExecutionPolicy Bypass -File start-windows.ps1

param([int]$Port = 8080)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# A wrong Content-Type on .js/.mjs fails the browser's strict module MIME check and
# the app will not boot, so this table is load-bearing rather than cosmetic.
$mime = @{
    ".html" = "text/html";               ".js"   = "text/javascript"
    ".mjs"  = "text/javascript";         ".css"  = "text/css"
    ".json" = "application/json";        ".wasm" = "application/wasm"
    ".svg"  = "image/svg+xml";           ".png"  = "image/png"
    ".jpg"  = "image/jpeg";              ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif";               ".ico"  = "image/x-icon"
    ".mp4"  = "video/mp4";               ".webm" = "video/webm"
    ".txt"  = "text/plain";              ".md"   = "text/plain"
    ".h5"   = "application/octet-stream";".slp"  = "application/octet-stream"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
    $listener.Start()
} catch {
    Write-Host "!! Could not listen on port $Port." -ForegroundColor Red
    Write-Host "   Another program may be using it. Try:  .\start-windows.ps1 -Port 8081"
    exit 1
}

Write-Host ""
Write-Host "  LUCID (offline) -> http://localhost:$Port/" -ForegroundColor Green
Write-Host "  Serving $root"
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

Start-Process "http://localhost:$Port/"

try {
    while ($listener.IsListening) {
        # GetContextAsync + a polling wait, so Ctrl+C is not swallowed by a
        # blocking GetContext().
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(200)) { }
        $ctx = $task.GetAwaiter().GetResult()

        $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
        if ($rel -eq "") { $rel = "index.html" }
        $full = Join-Path $root $rel
        if (Test-Path -LiteralPath $full -PathType Container) {
            $full = Join-Path $full "index.html"
        }

        # Never serve outside this folder, whatever the request path claims.
        $resolved = [System.IO.Path]::GetFullPath($full)
        if (-not $resolved.StartsWith([System.IO.Path]::GetFullPath($root))) {
            $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue
        }

        if (Test-Path -LiteralPath $resolved -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($resolved)
            $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
            $type = $mime[$ext]
            if (-not $type) { $type = "application/octet-stream" }
            $ctx.Response.ContentType = $type
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
        $ctx.Response.Close()
    }
} finally {
    $listener.Stop()
    Write-Host "`nStopped."
}
