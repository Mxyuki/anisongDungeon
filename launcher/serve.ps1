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

# ---------------------------------------------------------------- password-protected library
# library\library.enc is published on GitHub; only people with the password can open it.
# Format: see tools\encrypt-library.mjs.

$EncryptedLibrary = Join-Path $ProjectRoot 'library\library.enc'
$LibrarySourceMark = Join-Path $AppRoot 'data\library.source'
$SavedPasswordFile = Join-Path $ProjectRoot 'data\library.password'
$PasswordAttempts = 3

function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}

function Test-BytesEqual([byte[]]$a, [byte[]]$b) {
  # Constant time: every byte is compared even after a difference.
  if ($a.Length -ne $b.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
  return $diff -eq 0
}

function Expand-Library([byte[]]$data, [string]$password) {
  # Returns the gzip-compressed JSON, or $null when the password is wrong or the file is damaged.
  $magic = [System.Text.Encoding]::ASCII.GetBytes('ADLIB1')
  $headerLength = $magic.Length + 4 + 16 + 16
  if ($data.Length -lt $headerLength + 32 -or -not (Test-BytesEqual $data[0..5] $magic)) {
    throw 'library.enc is not an Anisong Dungeon library.'
  }
  $iterations = ([int]$data[6] -shl 24) -bor ([int]$data[7] -shl 16) -bor ([int]$data[8] -shl 8) -bor [int]$data[9]
  $salt = [byte[]]$data[10..25]
  $iv = [byte[]]$data[26..41]
  $macStart = $data.Length - 32

  $derive = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
    [System.Text.Encoding]::UTF8.GetBytes($password), $salt, $iterations,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $keys = $derive.GetBytes(64)
  $derive.Dispose()

  $hmac = New-Object System.Security.Cryptography.HMACSHA256(, [byte[]]$keys[32..63])
  $expected = $hmac.ComputeHash($data, 0, $macStart)
  $hmac.Dispose()
  if (-not (Test-BytesEqual $expected ([byte[]]$data[$macStart..($data.Length - 1)]))) { return $null }

  $aes = [System.Security.Cryptography.Aes]::Create()
  try {
    $aes.Mode = 'CBC'
    $aes.Padding = 'PKCS7'
    $decryptor = $aes.CreateDecryptor([byte[]]$keys[0..31], $iv)
    return $decryptor.TransformFinalBlock($data, $headerLength, $macStart - $headerLength)
  }
  finally { $aes.Dispose() }
}

function Save-Gunzipped([byte[]]$compressed, [string]$path) {
  $source = New-Object System.IO.MemoryStream(, $compressed)
  $gzip = New-Object System.IO.Compression.GZipStream($source, [System.IO.Compression.CompressionMode]::Decompress)
  $output = [System.IO.File]::Create($path)
  try { $gzip.CopyTo($output) }
  finally { $output.Dispose(); $gzip.Dispose(); $source.Dispose() }
}

function Read-LibraryPassword {
  $secure = Read-Host '  Song library password (Enter to skip)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Unlock-Library {
  # Decrypts library.enc into app\data\library.json when it changed since the last unlock.
  if (-not (Test-Path $EncryptedLibrary)) { return }
  $data = [System.IO.File]::ReadAllBytes($EncryptedLibrary)
  $hash = Get-Sha256Hex $data
  $isCurrent = (Test-Path $LibraryJson) -and (Test-Path $LibrarySourceMark) -and
    ((Get-Content -Raw $LibrarySourceMark).Trim() -eq $hash)
  if ($isCurrent) { return }

  $hadLibrary = Test-Path $LibraryJson
  Write-Host ''
  Write-Host $(if ($hadLibrary) { '  A new song library is available.' } else { '  This game includes a password-protected song library.' })
  $saved = if (Test-Path $SavedPasswordFile) { (Get-Content -Raw $SavedPasswordFile).Trim() } else { '' }
  for ($attempt = 0; $attempt -lt $PasswordAttempts; $attempt++) {
    $typed = -not ($saved -and $attempt -eq 0)
    $password = if ($typed) { Read-LibraryPassword } else { $saved }
    if (-not $password) { break }
    Write-Host '  Unlocking...'
    $compressed = Expand-Library $data $password
    if ($null -eq $compressed) {
      Write-Host '  Wrong password.'
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LibraryJson) | Out-Null
    Save-Gunzipped $compressed $LibraryJson
    Set-Content -Path $LibrarySourceMark -Value $hash -Encoding ascii
    Write-Host '  Song library unlocked.'
    if ($typed -and $password -ne $saved) {
      $answer = Read-Host '  Remember this password on this PC? [Y/n]'
      if ([string]::IsNullOrWhiteSpace($answer) -or $answer.Trim().ToLowerInvariant().StartsWith('y')) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SavedPasswordFile) | Out-Null
        Set-Content -Path $SavedPasswordFile -Value $password -Encoding utf8
      }
    }
    return
  }
  if ($hadLibrary) { Write-Host '  Keeping your current song library.' }
  else { Write-Host '  No song library unlocked: hosting needs one (see README).' }
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

if ($Mode -eq 'host') {
  # Your own data\library.db wins; otherwise the shared encrypted library is used.
  if (Test-Path $LibraryDb) { Update-Library } else { Unlock-Library }
}

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
