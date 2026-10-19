<#
.SYNOPSIS
  Serves the Anisong Dungeon app on http://localhost and opens it in the default browser.

.DESCRIPTION
  Binds to localhost only: nothing is exposed to the network and no admin rights or open
  ports are needed. Players connect to each other peer-to-peer from inside the browser.

.PARAMETER Mode
  'host' opens the page as the game server, 'join' opens the room-code screen.

.PARAMETER NoBrowser
  Serve without opening a browser window (for testing).
#>
param(
  [ValidateSet('host', 'join')]
  [string]$Mode = 'join',
  [int]$Port = 8787,
  [int]$PortAttempts = 20,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'app')).TrimEnd('\') + '\'
$LibraryDb = Join-Path $ProjectRoot 'data\library.db'
$LibraryJson = Join-Path $AppRoot 'data\library.json'

$MimeTypes = @{
  '.html'  = 'text/html; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.webp'  = 'image/webp'
  '.gif'   = 'image/gif'
  '.mp3'   = 'audio/mpeg'
  '.jpg'   = 'image/jpeg'
  '.jpeg'  = 'image/jpeg'
  '.ico'   = 'image/x-icon'
  '.woff2' = 'font/woff2'
}

$LibraryExporter = Join-Path $ProjectRoot 'tools\export-library.mjs'

function Update-Library {
  # Re-export the song library when the SQLite source or the exporter (format changes) is newer
  # than the JSON the app loads.
  if (-not (Test-Path $LibraryDb)) { return }
  $jsonTime = if (Test-Path $LibraryJson) { (Get-Item $LibraryJson).LastWriteTime } else { [datetime]::MinValue }
  $isStale = ((Get-Item $LibraryDb).LastWriteTime -gt $jsonTime) -or
    ((Test-Path $LibraryExporter) -and (Get-Item $LibraryExporter).LastWriteTime -gt $jsonTime)
  if (-not $isStale) { return }

  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host '  Updating song library from data\library.db ...'
    & node --no-warnings $LibraryExporter
  }
  elseif (-not (Test-Path $LibraryJson)) {
    Write-Warning 'No song library: data\library.db needs Node.js (22.5+) to be converted. Install Node.js, or put a ready-made library.json in app\data.'
  }
}

function Start-Listener {
  for ($candidate = $Port; $candidate -lt $Port + $PortAttempts; $candidate++) {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$candidate/")
    try {
      $listener.Start()
      return @{ Listener = $listener; Port = $candidate }
    }
    catch {
      $listener.Close()
    }
  }
  throw "No free port between $Port and $($Port + $PortAttempts - 1)."
}

$AvatarDir = Join-Path $AppRoot 'avatars'
$AvatarListPath = 'avatars/list.json'
$AvatarExtensions = @('.png', '.webp', '.jpg', '.jpeg', '.gif')

function Send-Bytes($response, [byte[]]$bytes, [string]$contentType) {
  $response.ContentType = $contentType
  $response.Headers['Cache-Control'] = 'no-cache'
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-AvatarList($response) {
  # Lists the images in appvatars so players can pick one; dropping a file in is enough.
  $names = @()
  if (Test-Path $AvatarDir) {
    $names = @(Get-ChildItem -LiteralPath $AvatarDir -File |
      Where-Object { $AvatarExtensions -contains $_.Extension.ToLowerInvariant() } |
      Sort-Object Name |
      ForEach-Object { $_.Name })
  }
  $json = ConvertTo-Json -InputObject ([string[]]$names) -Compress
  if ($names.Count -eq 0) { $json = '[]' }
  Send-Bytes $response ([System.Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8'
}

function Send-Status($response, [int]$code, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $response.StatusCode = $code
  $response.ContentType = 'text/plain; charset=utf-8'
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-File($context) {
  $response = $context.Response
  try {
    $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
    if ($relative -eq $AvatarListPath) {
      Send-AvatarList $response
      return
    }
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $AppRoot $relative))

    # Refuse anything outside the app folder (path traversal).
    $insideApp = $fullPath.StartsWith($AppRoot, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $insideApp -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      Send-Status $response 404 'Not found'
      return
    }

    $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
    $contentType = $MimeTypes[$extension]
    if (-not $contentType) { $contentType = 'application/octet-stream' }

    Send-Bytes $response ([System.IO.File]::ReadAllBytes($fullPath)) $contentType
  }
  catch {
    try { Send-Status $response 500 'Server error' } catch { }
  }
  finally {
    $response.Close()
  }
}

# The encrypted library was unlocked earlier by library.ps1; data\library.db is exported here.
if ($Mode -eq 'host') { Update-Library }

$server = Start-Listener
$url = "http://localhost:$($server.Port)/?mode=$Mode"

Write-Host ''
Write-Host "  Anisong Dungeon is running at $url"
if ($Mode -eq 'host') {
  Write-Host '  You are the HOST: share the room code shown in your browser with your friends.'
}
Write-Host '  Keep this window open while you play. Press Ctrl+C or close it to stop.'
Write-Host ''

if (-not $NoBrowser) { Start-Process $url }

try {
  while ($server.Listener.IsListening) {
    $pending = $server.Listener.GetContextAsync()
    # Short waits keep Ctrl+C responsive.
    while (-not $pending.AsyncWaitHandle.WaitOne(500)) { }
    Send-File $pending.Result
  }
}
finally {
  $server.Listener.Stop()
  $server.Listener.Close()
}
