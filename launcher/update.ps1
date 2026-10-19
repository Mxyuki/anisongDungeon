<#
.SYNOPSIS
  Checks the GitHub repository for a newer Anisong Dungeon and offers to install it.

.DESCRIPTION
  Downloaded copies (ZIP): every local file is compared with the repository's latest version
  (git blob hashes from the GitHub API), and only files that changed are downloaded.
  Files that exist only locally (avatars you added, data\library.db...) are never touched.
  Git clones: uses git fetch / git pull --ff-only instead.

  Offline or when GitHub cannot be reached, the check is skipped and the game starts anyway.

  Exit codes: 0 = nothing installed, 10 = files were updated (the launcher restarts itself).
#>
param(
  [string]$Owner = 'Mxyuki',
  [string]$Repo = 'anisongDungeon',
  [string]$Branch = 'main',
  [int]$TimeoutSec = 8
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$ExitUpdated = 10
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ApiRoot = "https://api.github.com/repos/$Owner/$Repo"
$RawRoot = "https://raw.githubusercontent.com/$Owner/$Repo"
$Headers = @{ 'User-Agent' = 'AnisongDungeon-Updater'; Accept = 'application/vnd.github+json' }

function Confirm-Update([string]$question) {
  $answer = Read-Host "  $question [Y/n]"
  return [string]::IsNullOrWhiteSpace($answer) -or $answer.Trim().ToLowerInvariant().StartsWith('y')
}

function Get-FirstLine([string]$text) {
  return ($text -split "`n")[0].Trim()
}

# ---------------------------------------------------------------- git clones

function Update-GitClone {
  # PowerShell 5.1 turns git's stderr into errors under 'Stop'; exit codes are checked instead.
  $ErrorActionPreference = 'Continue'
  Push-Location $ProjectRoot
  try {
    & git fetch --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host '  Could not reach GitHub, update check skipped.'; return 0 }
    $behind = (& git rev-list --count 'HEAD..@{u}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or [int]$behind -eq 0) { return 0 }
    $latest = (& git log -1 --format=%s '@{u}')
    Write-Host ''
    Write-Host "  An update is available ($behind new commit(s)): $latest"
    if (-not (Confirm-Update 'Update now?')) { return 0 }
    & git pull --ff-only | Out-Host # keep git's output out of the function's return value
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'git pull failed (local changes?). Update manually with git.'
      return 0
    }
    return $ExitUpdated
  }
  finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------- downloaded copies

function Get-GitBlobHash([string]$path) {
  # Same hash git uses for file contents: SHA-1 of "blob <size>\0" + bytes.
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $header = [System.Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
  $sha = [System.Security.Cryptography.SHA1]::Create()
  try {
    [void]$sha.TransformBlock($header, 0, $header.Length, $null, 0)
    [void]$sha.TransformFinalBlock($bytes, 0, $bytes.Length)
    return -join ($sha.Hash | ForEach-Object { $_.ToString('x2') })
  }
  finally {
    $sha.Dispose()
  }
}

function Test-FileOutdated($entry) {
  $localPath = Join-Path $ProjectRoot ($entry.path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) { return $true }
  if ((Get-Item -LiteralPath $localPath).Length -ne $entry.size) { return $true }
  return (Get-GitBlobHash $localPath) -ne $entry.sha
}

function Get-OutdatedFiles($commitSha) {
  $tree = Invoke-RestMethod -Uri "$ApiRoot/git/trees/$($commitSha)?recursive=1" -Headers $Headers -TimeoutSec $TimeoutSec
  # mode 100644/100755 = regular files (skips symlinks and submodules).
  $files = @($tree.tree | Where-Object { $_.type -eq 'blob' -and ($_.mode -eq '100644' -or $_.mode -eq '100755') })
  return @($files | Where-Object { Test-FileOutdated $_ })
}

function Install-Files($entries, $commitSha) {
  $staging = Join-Path ([System.IO.Path]::GetTempPath()) "anisong-update-$commitSha"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    # Download everything first so a failed download leaves the game untouched.
    $index = 0
    foreach ($entry in $entries) {
      $index++
      Write-Host "  [$index/$($entries.Count)] $($entry.path)"
      $encoded = ($entry.path -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
      $target = Join-Path $staging ($entry.path -replace '/', '\')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Invoke-WebRequest -Uri "$RawRoot/$commitSha/$encoded" -OutFile $target -UseBasicParsing -TimeoutSec 120
      if ((Get-GitBlobHash $target) -ne $entry.sha) { throw "Download of $($entry.path) is corrupted." }
    }
    foreach ($entry in $entries) {
      $relative = $entry.path -replace '/', '\'
      $destination = Join-Path $ProjectRoot $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath (Join-Path $staging $relative) -Destination $destination -Force
    }
  }
  finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Update-Download {
  try {
    $head = Invoke-RestMethod -Uri "$ApiRoot/commits/$Branch" -Headers $Headers -TimeoutSec $TimeoutSec
    $outdated = @(Get-OutdatedFiles $head.sha) # @() keeps a single file an array
  }
  catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 409) { return 0 } # the repository has no commit yet
    Write-Host "  Could not check for updates ($($_.Exception.Message)). Starting anyway."
    return 0
  }
  if ($outdated.Count -eq 0) { return 0 }

  Write-Host ''
  Write-Host "  An update is available: $(Get-FirstLine $head.commit.message)"
  Write-Host "  $($outdated.Count) file(s) will be downloaded. Game files you edited yourself are replaced;"
  Write-Host '  your own avatars and other extra files are kept.'
  if (-not (Confirm-Update 'Update now?')) { return 0 }
  try {
    Install-Files $outdated $head.sha
  }
  catch {
    Write-Warning "Update failed, nothing was changed: $($_.Exception.Message)"
    return 0
  }
  Write-Host '  Update installed.'
  return $ExitUpdated
}

Write-Host '  Checking for updates...'
$hasGit = (Test-Path (Join-Path $ProjectRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)
if ($hasGit) { exit (Update-GitClone) }
exit (Update-Download)
