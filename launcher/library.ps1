<#
.SYNOPSIS
  Library gate, run by AnisongDungeon.cmd right after the update check.

.DESCRIPTION
  Without a data\library.db of your own, the game needs the password of library\library.enc,
  the encrypted song library published on GitHub (format: tools\encrypt-library.mjs).
  - data\library.db present, or a library.json of your own (not decrypted from library.enc): OK.
  - library.enc already unlocked and unchanged: OK, no question.
  - Otherwise the remembered password (data\library.password) is tried, then the player is asked.
    Right password: the library is decrypted into app\data\library.json.

  Exit codes: 0 = the game can start, 1 = no access (the launcher closes).
#>
param(
  [int]$PasswordAttempts = 3,
  [int]$CloseDelaySec = 4
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LibraryDb = Join-Path $ProjectRoot 'data\library.db'
$LibraryJson = Join-Path $ProjectRoot 'app\data\library.json'
$LibrarySourceMark = Join-Path $ProjectRoot 'app\data\library.source'
$EncryptedLibrary = Join-Path $ProjectRoot 'library\library.enc'
$SavedPasswordFile = Join-Path $ProjectRoot 'data\library.password'

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
    # The comma keeps the byte[] whole instead of unrolling it into the pipeline.
    return , $decryptor.TransformFinalBlock($data, $headerLength, $macStart - $headerLength)
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
  $secure = Read-Host '  Password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Save-Password([string]$password) {
  $answer = Read-Host '  Remember this password on this PC? [Y/n]'
  if ([string]::IsNullOrWhiteSpace($answer) -or $answer.Trim().ToLowerInvariant().StartsWith('y')) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SavedPasswordFile) | Out-Null
    Set-Content -Path $SavedPasswordFile -Value $password -Encoding utf8
  }
}

function Open-Library([string]$password) {
  try { $result = Expand-Library $data $password }
  catch { Close-Launcher "The song library file is damaged ($($_.Exception.Message)). Update the game again." }
  if ($null -eq $result) { return $null } # wrong password
  return , $result
}

function Close-Launcher([string]$message) {
  Write-Host ''
  Write-Host "  $message"
  Write-Host '  Closing...'
  Start-Sleep -Seconds $CloseDelaySec
  exit 1
}

# ---------------------------------------------------------------- gate

if (Test-Path $LibraryDb) { exit 0 }
$unlockedBefore = Test-Path $LibrarySourceMark
if ((Test-Path $LibraryJson) -and -not $unlockedBefore) { exit 0 } # a library.json of your own

if (-not (Test-Path $EncryptedLibrary)) {
  if ((Test-Path $LibraryJson) -and $unlockedBefore) { exit 0 }
  Close-Launcher 'No song library found. Accept the update, or build your own library (see README).'
}

$data = [System.IO.File]::ReadAllBytes($EncryptedLibrary)
$hash = Get-Sha256Hex $data
if ((Test-Path $LibraryJson) -and $unlockedBefore -and (Get-Content -Raw $LibrarySourceMark).Trim() -eq $hash) {
  exit 0
}

$saved = if (Test-Path $SavedPasswordFile) { (Get-Content -Raw $SavedPasswordFile).Trim() } else { '' }
$compressed = if ($saved) { Open-Library $saved } else { $null }
$typed = ''
if ($null -eq $compressed) {
  Write-Host ''
  Write-Host $(if ($unlockedBefore) { '  The song library was updated: enter the password to unlock it.' }
    else { '  Anisong Dungeon needs the song library password.' })
  for ($attempt = 1; $attempt -le $PasswordAttempts -and $null -eq $compressed; $attempt++) {
    $typed = Read-LibraryPassword
    if (-not $typed) { break }
    Write-Host '  Unlocking...'
    $compressed = Open-Library $typed
    if ($null -eq $compressed -and $attempt -lt $PasswordAttempts) { Write-Host '  Wrong password, try again.' }
  }
  if ($null -eq $compressed) { Close-Launcher $(if ($typed) { 'Wrong password.' } else { 'No password entered.' }) }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LibraryJson) | Out-Null
Save-Gunzipped $compressed $LibraryJson
Set-Content -Path $LibrarySourceMark -Value $hash -Encoding ascii
Write-Host '  Song library unlocked.'
if ($typed) { Save-Password $typed }
exit 0
