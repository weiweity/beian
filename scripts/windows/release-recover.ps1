param(
  [string]$JournalPath = "",
  [string]$TaskName = "beian-release-watchdog",
  [switch]$Force
)

# Encoding: UTF-8 with BOM so Windows PowerShell 5.1 parses localized netstat text.
# Standalone rollback worker for release.ps1. It is copied under WB_DATA_DIR and
# executed by Task Scheduler, so it remains available when Actions cancels the
# release process or the checkout is between two revisions.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
$Protocol = "beian.release-recovery.v1"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = $env:NO_PROXY

if (-not $JournalPath) {
  $dataRoot = if ($env:WB_DATA_DIR) { $env:WB_DATA_DIR } else { "C:\supply\data" }
  $JournalPath = Join-Path (Join-Path (Join-Path $dataRoot "runtime") "release") "release-journal.json"
}
$JournalPath = [System.IO.Path]::GetFullPath($JournalPath)
$ReleaseRuntimeDir = [System.IO.Path]::GetDirectoryName($JournalPath)
$ReleaseLockPath = Join-Path $ReleaseRuntimeDir "release.lock"

function Get-TextSha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $Utf8NoBom.GetBytes($Text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-GitMergeLockRelativePaths {
  return @(
    "index.lock",
    "ORIG_HEAD.lock",
    "HEAD.lock",
    "refs\heads\main.lock",
    "logs\HEAD.lock",
    "logs\ORIG_HEAD.lock",
    "logs\refs\heads\main.lock"
  )
}

function Get-GitMergeLockPolicySha256 {
  return Get-TextSha256 ((Get-GitMergeLockRelativePaths) -join "`n")
}

function JournalProperty([object]$Journal, [string]$Name) {
  $property = $Journal.PSObject.Properties[$Name]
  if (-not $property) { return $null }
  return $property.Value
}

function Get-DirectoryFingerprint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "release recovery UI snapshot is missing"
  }
  $base = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $records = @(
    Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop |
      Sort-Object FullName |
      ForEach-Object {
        $relative = $_.FullName.Substring($base.Length).Replace('\', '/')
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$relative`t$($_.Length)`t$hash"
      }
  )
  if ($records.Count -eq 0) { throw "release recovery UI snapshot is empty" }
  return Get-TextSha256 ($records -join "`n")
}

function Read-ReleaseJournal {
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) { return $null }
  try {
    return [System.IO.File]::ReadAllText($JournalPath, $Utf8NoBom) | ConvertFrom-Json
  } catch {
    throw "release recovery journal is unreadable"
  }
}

function Assert-ReleaseJournalContract([object]$Journal) {
  if ([string]$Journal.protocol -ne $Protocol) {
    throw "release recovery protocol mismatch"
  }
  if ([string]$Journal.release_lease_id -notmatch '^[A-Za-z0-9_-]{16,128}$') {
    throw "release recovery journal lease is invalid"
  }
}

function Write-AtomicJournal([object]$Journal) {
  $temporary = "$JournalPath.$PID.tmp"
  [System.IO.File]::WriteAllText(
    $temporary,
    (($Journal | ConvertTo-Json -Depth 8 -Compress) + "`n"),
    $Utf8NoBom
  )
  try {
    if (Test-Path -LiteralPath $JournalPath) {
      [System.IO.File]::Replace($temporary, $JournalPath, $null)
    } else {
      [System.IO.File]::Move($temporary, $JournalPath)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Test-PortListening([int]$Port) {
  $raw = @(& netstat.exe -ano 2>$null)
  $code = $LASTEXITCODE
  if ($code -ne 0 -or $raw.Count -eq 0) {
    throw "netstat failed during release recovery"
  }
  return [bool]($raw | Select-String -Pattern (":$Port\s+.+(?:LISTENING|侦听)"))
}

function Get-ListenerPid([int]$Port) {
  $raw = @(& netstat.exe -ano 2>$null)
  $code = $LASTEXITCODE
  if ($code -ne 0 -or $raw.Count -eq 0) {
    throw "netstat PID probe failed during release recovery"
  }
  $pattern = ":$Port\s+.+(?:LISTENING|侦听)\s+(\d+)\s*$"
  foreach ($line in $raw) {
    $match = [regex]::Match([string]$line, $pattern)
    if ($match.Success) {
      $listenerPid = [int]$match.Groups[1].Value
      if ($listenerPid -gt 0) { return $listenerPid }
    }
  }
  return 0
}

function Test-ReleaseControlBinding(
  [string]$DataRoot,
  [string]$ExpectedVersion,
  [bool]$AllowLegacyWithoutControl = $false
) {
  try {
    $isLegacyVersion = ([version]$ExpectedVersion -lt [version]"0.20.0.0")
  } catch {
    return $false
  }
  if ($AllowLegacyWithoutControl -and $isLegacyVersion) { return $true }

  $path = Join-Path (Join-Path $DataRoot "runtime") "release-control.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    $control = [System.IO.File]::ReadAllText($path, $Utf8NoBom) | ConvertFrom-Json
    $controlPid = [int]$control.pid
  } catch {
    return $false
  }
  if (
    [string]$control.protocol -ne "beian.release.v1" -or
    [string]$control.token -notmatch '^[A-Za-z0-9_-]{32,}$' -or
    [string]$control.instance_id -notmatch '^[A-Za-z0-9_-]{32,128}$' -or
    [string]$control.version -ne $ExpectedVersion -or
    $controlPid -le 0
  ) {
    return $false
  }
  $listenerPid = Get-ListenerPid 8787
  if ($listenerPid -le 0 -or $listenerPid -ne $controlPid) { return $false }
  $controlProcess = Get-Process -Id $controlPid -ErrorAction SilentlyContinue
  if (-not $controlProcess) { return $false }
  try {
    $identity = Invoke-RestMethod `
      -Uri "http://127.0.0.1:8787/api/internal/release/identity" `
      -Headers @{ "x-beian-release-token" = [string]$control.token } `
      -TimeoutSec 8
  } catch {
    return $false
  }
  return [bool](
    $identity.ok -and
    [string]$identity.protocol -eq [string]$control.protocol -and
    [string]$identity.instance_id -eq [string]$control.instance_id -and
    [string]$identity.version -eq $ExpectedVersion -and
    [int]$identity.pid -eq $controlPid
  )
}

function Open-ReleaseDrain(
  [string]$DataRoot,
  [string]$ExpectedVersion,
  [string]$LeaseId
) {
  if ($LeaseId -notmatch '^[A-Za-z0-9_-]{16,128}$') {
    throw "release recovery lease id is invalid"
  }
  if (-not (Test-ReleaseControlBinding $DataRoot $ExpectedVersion $false)) {
    throw "release recovery cannot bind the target service before reopening writes"
  }
  $path = Join-Path (Join-Path $DataRoot "runtime") "release-control.json"
  $control = [System.IO.File]::ReadAllText($path, $Utf8NoBom) | ConvertFrom-Json
  $state = Invoke-RestMethod `
    -Uri "http://127.0.0.1:8787/api/internal/release/drain" `
    -Method Delete `
    -Headers @{
      "x-beian-release-token" = [string]$control.token
      "x-beian-release-lease" = $LeaseId
    } `
    -TimeoutSec 8
  if (
    -not $state.ok -or
    [string]$state.protocol -ne "beian.release.v1" -or
    [string]$state.instance_id -ne [string]$control.instance_id -or
    [int]$state.pid -ne [int]$control.pid -or
    [string]$state.version -ne $ExpectedVersion -or
    [string]$state.state -ne "open"
  ) {
    throw "release recovery could not atomically reopen the verified target service"
  }
}

function Write-RecoveryStartupDrainFence(
  [string]$DataRoot,
  [string]$LeaseId
) {
  if ($LeaseId -notmatch '^[A-Za-z0-9_-]{16,128}$') {
    throw "release recovery startup lease id is invalid"
  }
  $runtimeDir = Join-Path $DataRoot "runtime"
  $path = Join-Path $runtimeDir "release-drain.json"
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  $payload = [ordered]@{
    protocol = "beian.release.v1"
    lease_id = $LeaseId
    mode = "transaction"
    entered_at = [DateTime]::UtcNow.ToString("o")
  }
  $temporary = "$path.$PID.tmp"
  [System.IO.File]::WriteAllText(
    $temporary,
    (($payload | ConvertTo-Json -Compress) + "`n"),
    $Utf8NoBom
  )
  try {
    if (Test-Path -LiteralPath $path) {
      [System.IO.File]::Replace($temporary, $path, $null)
    } else {
      [System.IO.File]::Move($temporary, $path)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Stop-BeianService {
  $service = Get-Service -Name "beian-server-8787" -ErrorAction SilentlyContinue
  if (-not $service) { throw "beian-server-8787 WinSW service is missing" }
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name "beian-server-8787" -Force -ErrorAction Stop
  }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ((Get-Service -Name "beian-server-8787" -ErrorAction Stop).Status -eq "Stopped") { break }
    Start-Sleep -Seconds 1
  }
  if ((Get-Service -Name "beian-server-8787" -ErrorAction Stop).Status -ne "Stopped") {
    throw "beian-server-8787 did not stop during recovery"
  }
  if (Test-PortListening 8787) {
    throw "8787 is still listening after WinSW stopped; refusing PID-based cleanup"
  }
}

function Enter-LegacyRecoverySafetyGate([string]$DataRoot) {
  # A pre-0.20 server cannot observe the persistent Illustrator fault fence and
  # can launch Adobe automation from Session 0. Keep 8787 stopped unless both
  # the fence and every relevant desktop automation process are absent.
  Stop-BeianService
  $faultPath = Join-Path (Join-Path $DataRoot "runtime") "illustrator-fault.json"
  if (Test-Path -LiteralPath $faultPath -PathType Leaf) {
    throw "legacy rollback is blocked by the Illustrator fault fence; 8787 remains stopped"
  }
  $unsafeProcesses = @(
    Get-Process -Name "Illustrator", "AIRobin", "cscript", "wscript" -ErrorAction SilentlyContinue
  )
  if ($unsafeProcesses.Count -gt 0) {
    $identities = @(
      $unsafeProcesses |
        Sort-Object Id |
        ForEach-Object { "$($_.ProcessName):$($_.Id)" }
    )
    throw "legacy rollback is blocked by desktop automation processes ($($identities -join ', ')); 8787 remains stopped"
  }
}

function Start-BeianService([string]$ExpectedVersion, [string]$DataRoot) {
  try {
    Restart-Service -Name "beian-server-8787" -Force -ErrorAction Stop
  } catch {
    Start-Service -Name "beian-server-8787" -ErrorAction Stop
  }
  $seenVersion = ""
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 2
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
      $seenVersion = [string]$health.version
      if (
        $health.ok -and
        $seenVersion -eq $ExpectedVersion -and
        (Test-ReleaseControlBinding $DataRoot $ExpectedVersion $true)
      ) { return }
    } catch { }
  }
  throw "recovered service health.version=$seenVersion expected=$ExpectedVersion"
}

function Assert-PathUnder([string]$Candidate, [string]$Parent, [string]$Label) {
  $full = [System.IO.Path]::GetFullPath($Candidate)
  $base = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $boundary = $base + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($boundary, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its trusted directory"
  }
  return $full
}

function Restore-UiSnapshot(
  [string]$SnapshotPath,
  [string]$ExpectedFingerprint,
  [string]$Root
) {
  $actual = Get-DirectoryFingerprint $SnapshotPath
  if ($actual -ne $ExpectedFingerprint) {
    throw "release recovery UI snapshot fingerprint does not match the journal"
  }
  $target = Join-Path $Root "apps\web\ui\dist"
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath $SnapshotPath -Force -ErrorAction Stop |
    Copy-Item -Destination $target -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $target "index.html") -PathType Leaf)) {
    throw "release recovery restored UI snapshot without index.html"
  }
  if ((Get-DirectoryFingerprint $target) -ne $ExpectedFingerprint) {
    throw "release recovery restored UI snapshot failed verification"
  }
}

function Assert-RecoveredAgentIdentity(
  [string]$Root,
  [string]$ExpectedVersion,
  [string]$ExpectedSha
) {
  $task = Get-ScheduledTask -TaskName "beian-illustrator-agent" -ErrorAction SilentlyContinue
  if ([version]$ExpectedVersion -lt [version]"0.20.0.0") {
    if ($task) { throw "legacy recovery still has the target Illustrator agent task" }
    return
  }
  if (-not $task) { throw "recovered Illustrator agent task is missing" }
  $action = @($task.Actions | Select-Object -First 1)
  if ($action.Count -ne 1) { throw "recovered Illustrator agent task action is invalid" }
  $arguments = [string]$action[0].Arguments
  if (
    -not $arguments.Contains($Root) -or
    -not $arguments.Contains($ExpectedVersion) -or
    -not $arguments.Contains($ExpectedSha)
  ) {
    throw "recovered Illustrator agent task does not match the verified checkout"
  }
}

function Assert-NativeRecoveryProbe(
  [string]$Label,
  [string]$Executable,
  [string[]]$Arguments,
  [string]$WorkingDirectory
) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Stop"
  $code = $null
  $invokeFailure = ""
  Push-Location $WorkingDirectory
  try {
    try {
      & $Executable @Arguments *> $null
      $code = $LASTEXITCODE
    } catch {
      $invokeFailure = [string]$_.Exception.Message
    }
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousPreference
  }
  if ($invokeFailure) {
    throw "$Label could not start during offline release recovery: $invokeFailure"
  }
  if ($null -eq $code -or [int]$code -ne 0) {
    throw "$Label failed during offline release recovery exit=$code"
  }
}

function Assert-RecoveryServerEntryImport([string]$Root, [string]$TsxPath) {
  $probeData = Join-Path ([System.IO.Path]::GetTempPath()) ("beian-recovery-server-probe-" + [Guid]::NewGuid().ToString("N"))
  $prior = @{}
  foreach ($name in @("VITEST", "WB_DATA_DIR", "WB_HOST", "WB_PORT")) {
    $prior[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  New-Item -ItemType Directory -Force -Path $probeData | Out-Null
  try {
    $env:VITEST = "1"
    $env:WB_DATA_DIR = $probeData
    $env:WB_HOST = "127.0.0.1"
    $env:WB_PORT = "0"
    $entryProbe = "import('./apps/web/server/src/index.ts').then((m) => { if (!m.app || typeof m.app.fetch !== 'function') throw new Error('missing Hono app export'); })"
    Assert-NativeRecoveryProbe "Hono service entry import" $TsxPath @("-e", $entryProbe) $Root
  } finally {
    foreach ($name in $prior.Keys) {
      if ($null -eq $prior[$name]) {
        Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable($name, [string]$prior[$name], "Process")
      }
    }
    Remove-Item -LiteralPath $probeData -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-RecoveryRuntimeIntegrity([string]$Root, [string]$PythonPath) {
  $node = Get-Command node.exe -ErrorAction Stop
  $npm = Get-Command npm.cmd -ErrorAction Stop
  $tsx = Join-Path $Root "node_modules\.bin\tsx.cmd"
  $vite = Join-Path $Root "node_modules\vite\bin\vite.js"
  if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw "release recovery requires the tsx service launcher"
  }
  if (-not (Test-Path -LiteralPath $vite -PathType Leaf)) {
    throw "release recovery requires the Vite build runtime"
  }
  $rollupNative = @(
    Get-ChildItem -LiteralPath (Join-Path $Root "node_modules\@rollup\rollup-win32-x64-msvc") `
      -Filter "*.node" -File -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $Root "apps\web\ui\node_modules\@rollup\rollup-win32-x64-msvc") `
      -Filter "*.node" -File -ErrorAction SilentlyContinue
  ) | Select-Object -First 1
  if (-not $rollupNative) { throw "release recovery requires the Rollup native module" }

  Assert-NativeRecoveryProbe "npm installed graph" $npm.Source @("ls", "--all", "--offline", "--ignore-scripts", "--silent") $Root
  Assert-NativeRecoveryProbe "tsx launcher" $tsx @("--version") $Root
  Assert-RecoveryServerEntryImport $Root $tsx
  Assert-NativeRecoveryProbe "Vite CLI" $node.Source @($vite, "--version") $Root
  Assert-NativeRecoveryProbe "Rollup native module" $node.Source @("-e", "require(process.argv[1])", [string]$rollupNative.FullName) $Root
  Assert-NativeRecoveryProbe "Python dependency graph" $PythonPath @("-m", "pip", "check") $Root

  $backend = Join-Path $Root "apps\web\backend"
  $priorPythonPath = [Environment]::GetEnvironmentVariable("PYTHONPATH", "Process")
  try {
    $env:PYTHONPATH = "."
    Assert-NativeRecoveryProbe `
      "review worker import" `
      $PythonPath `
      @("-c", "import app.cli; import fitz; import openpyxl") `
      $backend
  } finally {
    if ($null -eq $priorPythonPath) {
      Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    } else {
      $env:PYTHONPATH = $priorPythonPath
    }
  }
}

function Test-ReleaseProcess([object]$Journal) {
  $releasePid = [int]$Journal.release_pid
  if ($releasePid -le 0) { return $false }
  $process = Get-Process -Id $releasePid -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  try {
    $expectedFileTime = [int64]::Parse([string]$Journal.release_start_filetime_utc)
    return $process.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $expectedFileTime
  } catch {
    return $false
  }
}

function Remove-StaleReleaseGitLocks([string]$Root, [object]$Journal) {
  $gitDir = Join-Path $Root ".git"
  if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) {
    throw "release recovery cannot prove the repository git directory"
  }
  $locks = @(
    Get-GitMergeLockRelativePaths | ForEach-Object {
      $relative = [string]$_
      $absolute = Join-Path $gitDir $relative
      if (Test-Path -LiteralPath $absolute -PathType Leaf) {
        [pscustomobject]@{ relative = $relative; absolute = $absolute }
      }
    }
  )
  if ($locks.Count -eq 0) { return }
  if (Test-ReleaseProcess $Journal) {
    throw "release recovery will not clear a git lock while the recorded release process is alive"
  }
  $transactionTarget = [string](JournalProperty $Journal "git_transaction_target_sha")
  if (
    $transactionTarget -notmatch '^[0-9a-f]{40}$' -or
    $transactionTarget -ne [string](JournalProperty $Journal "target_sha")
  ) {
    throw "release recovery found Git locks without an immutable target SHA"
  }
  $expectedOwner = (
    "beian.git-merge-locks.v1|pid=$([int](JournalProperty $Journal 'release_pid'))" +
    "|start=$([string](JournalProperty $Journal 'release_start_filetime_utc'))" +
    "|op=merge-ff-only-main|target=$transactionTarget"
  )
  if (
    -not [bool](JournalProperty $Journal "git_transaction_armed") -or
    [string](JournalProperty $Journal "git_transaction_protocol") -ne "beian.git-merge-locks.v1" -or
    [string](JournalProperty $Journal "git_transaction_operation") -ne "merge-ff-only-main" -or
    [string](JournalProperty $Journal "git_transaction_ref") -ne "refs/heads/main" -or
    [string](JournalProperty $Journal "git_transaction_source_stage") -ne "stopped" -or
    [string](JournalProperty $Journal "git_transaction_baseline") -ne "all-absent" -or
    [string](JournalProperty $Journal "git_transaction_owner") -ne $expectedOwner -or
    [string](JournalProperty $Journal "git_transaction_lock_policy_sha256") -ne (Get-GitMergeLockPolicySha256)
  ) {
    throw "release recovery found Git locks without immutable merge ownership"
  }
  try {
    $releaseStartedFileTime = [int64]::Parse([string](JournalProperty $Journal "release_start_filetime_utc"))
    $transactionStartedFileTime = [int64]::Parse(
      [string](JournalProperty $Journal "git_transaction_start_filetime_utc")
    )
    $transactionStarted = [DateTime]::FromFileTimeUtc($transactionStartedFileTime)
  } catch {
    throw "release recovery cannot prove when the git transaction started"
  }
  if (
    $transactionStartedFileTime -lt $releaseStartedFileTime -or
    $transactionStarted -gt [DateTime]::UtcNow.AddMinutes(1)
  ) {
    throw "release recovery git transaction time is outside the recorded release"
  }
  $gitProcesses = @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { [string]$_.Name -match '^git(?:-.*)?\.exe$' }
  )
  if ($gitProcesses.Count -gt 0) {
    throw "release recovery is waiting for git.exe to exit before clearing owned locks"
  }
  $probes = @()
  try {
    foreach ($lock in $locks) {
      $lockInfo = Get-Item -LiteralPath $lock.absolute -ErrorAction Stop
      if ($lockInfo.LastWriteTimeUtc -lt $transactionStarted) {
        throw "release recovery will not clear a Git lock that predates this transaction: $($lock.relative)"
      }
      $probes += [System.IO.FileStream]::new(
        $lock.absolute,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    }
  } catch [System.IO.IOException] {
    throw "release recovery cannot exclusively claim every owned Git lock"
  } finally {
    foreach ($probe in $probes) {
      if ($probe) { $probe.Dispose() }
    }
  }
  foreach ($lock in $locks) {
    Remove-Item -LiteralPath $lock.absolute -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $lock.absolute) {
      throw "release recovery could not clear its owned Git lock: $($lock.relative)"
    }
  }
}

function Remove-WatchdogArtifacts([object]$Journal) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $JournalPath -Force -ErrorAction SilentlyContinue
  if ([string]$Journal.runtime_installer) {
    Remove-Item -LiteralPath ([string]$Journal.runtime_installer) -Force -ErrorAction SilentlyContinue
  }
  if ([string]$Journal.runtime_recovery) {
    Remove-Item -LiteralPath ([string]$Journal.runtime_recovery) -Force -ErrorAction SilentlyContinue
  }
  if ([string]$Journal.runtime_dependency_check) {
    Remove-Item -LiteralPath ([string]$Journal.runtime_dependency_check) -Force -ErrorAction SilentlyContinue
  }
  if ([string]$Journal.ui_snapshot) {
    Remove-Item -LiteralPath ([string]$Journal.ui_snapshot) -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$journal = Read-ReleaseJournal
if (-not $journal) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}
Assert-ReleaseJournalContract $journal
if (-not $Force -and (Test-ReleaseProcess $journal)) {
  Write-Host "RELEASE_RECOVERY waiting: release process is still alive"
  exit 0
}

$releaseLockStream = $null
try {
  try {
    $releaseLockStream = [System.IO.FileStream]::new(
      $ReleaseLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    if ($Force) { throw "release recovery cannot acquire the release lock" }
    Write-Host "RELEASE_RECOVERY waiting: release lock is still owned"
    exit 0
  }

  # The pre-lock read is advisory only. The release process may replace or
  # remove the journal while recovery waits for exclusive ownership, so every
  # trusted path and identity below comes from this locked snapshot.
  $journal = Read-ReleaseJournal
  if (-not $journal) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    exit 0
  }
  Assert-ReleaseJournalContract $journal
  if (-not $Force -and (Test-ReleaseProcess $journal)) {
    Write-Host "RELEASE_RECOVERY waiting: release process is still alive"
    exit 0
  }

  $root = [System.IO.Path]::GetFullPath([string]$journal.root).TrimEnd('\', '/')
  $rootVolume = [System.IO.Path]::GetPathRoot($root).TrimEnd('\', '/')
  if (-not $root -or $root -eq $rootVolume -or -not (Test-Path -LiteralPath (Join-Path $root ".git"))) {
    throw "release recovery root is not a repository checkout"
  }
  $dataRoot = [System.IO.Path]::GetFullPath([string]$journal.data_root).TrimEnd('\', '/')
  Assert-PathUnder $JournalPath $dataRoot "journal" | Out-Null
  $selfPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
  Assert-PathUnder $selfPath $dataRoot "recovery script" | Out-Null
  $selfHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $selfPath).Hash.ToLowerInvariant()
  if ($selfHash -ne [string]$journal.recovery_sha256) {
    throw "release recovery script hash does not match the armed journal"
  }
  $preSha = [string]$journal.pre_sha
  $preVersion = [string]$journal.pre_version
  $targetSha = [string]$journal.target_sha
  $targetVersion = [string]$journal.target_version
  if ($preSha -notmatch '^[0-9a-f]{40}$' -or $preVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "release recovery target identity is invalid"
  }
  if ($targetSha -notmatch '^[0-9a-f]{40}$' -or $targetVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "requested release identity is invalid"
  }
  if ([string]$journal.ui_snapshot_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "release recovery UI snapshot identity is invalid"
  }
  & git -C $root cat-file -e ($preSha + "^{commit}")
  if ($LASTEXITCODE -ne 0) { throw "release recovery target commit is unavailable" }
  & git -C $root cat-file -e ($targetSha + "^{commit}")
  if ($LASTEXITCODE -ne 0) { throw "requested release commit is unavailable" }

  $currentSha = [string](& git -C $root rev-parse HEAD | Select-Object -First 1)
  $service = Get-Service -Name "beian-server-8787" -ErrorAction SilentlyContinue
  if ([string]$journal.stage -eq "committed") {
    if (
      $targetSha -notmatch '^[0-9a-f]{40}$' -or
      $targetVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
      $currentSha.Trim() -ne $targetSha
    ) {
      throw "committed release identity does not match the checked-out target"
    }
    if ([string]$journal.target_ui_sha256 -notmatch '^[0-9a-f]{64}$') {
      throw "committed release UI identity is invalid"
    }
    $targetReady = $false
    if ($service -and $service.Status -eq "Running" -and (Test-PortListening 8787)) {
      try {
        $targetHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
      } catch { $targetHealth = $null }
      $targetReady = [bool](
        $targetHealth -and
        $targetHealth.ok -and
        [string]$targetHealth.version -eq $targetVersion -and
        (Test-ReleaseControlBinding $dataRoot $targetVersion $false)
      )
    }
    if (-not $targetReady) {
      # committed 以后绝不再切回旧树；目标已经在拒写状态下通过完整冒烟。
      # 若进程随后消失，重启同一 target 并由 watchdog 持续重试。
      Write-RecoveryStartupDrainFence $dataRoot ([string]$journal.release_lease_id)
      Start-BeianService $targetVersion $dataRoot
      $targetReady = $true
    }
    if ($targetReady) {
      $targetDist = Join-Path $root "apps\web\ui\dist"
      if ((Get-DirectoryFingerprint $targetDist) -ne [string]$journal.target_ui_sha256) {
        throw "committed release UI no longer matches the verified target"
      }
      Assert-RecoveredAgentIdentity $root $targetVersion $targetSha
      Open-ReleaseDrain $dataRoot $targetVersion ([string]$journal.release_lease_id)
      Remove-WatchdogArtifacts $journal
      Write-Host "RELEASE_RECOVERY finalized committed release sha=$targetSha version=$targetVersion"
      exit 0
    }
  }
  $gitTransactionArmed = [bool](JournalProperty $journal "git_transaction_armed")
  $fastRecoveryStage = (
    [string]$journal.stage -in @("armed", "stopping", "stopped", "failed", "recovery_failed") -and
    -not $gitTransactionArmed
  )
  $preDist = Join-Path $root "apps\web\ui\dist"
  $preDistMatchesSnapshot = [bool](
    (Test-Path -LiteralPath $preDist -PathType Container) -and
    (Get-DirectoryFingerprint $preDist) -eq [string]$journal.ui_snapshot_sha256
  )
  if (
    $fastRecoveryStage -and
    -not [bool]$journal.ui_mutated -and
    -not [bool]$journal.agent_mutated -and
    $preDistMatchesSnapshot -and
    $currentSha.Trim() -eq $preSha
  ) {
    $preSupportsDrain = ([version]$preVersion -ge [version]"0.20.0.0")
    if (-not $preSupportsDrain) {
      Enter-LegacyRecoverySafetyGate $dataRoot
      $service = Get-Service -Name "beian-server-8787" -ErrorAction SilentlyContinue
    }
    $preReady = $false
    if ($service -and $service.Status -eq "Running" -and (Test-PortListening 8787)) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
      } catch { $health = $null }
      $preReady = [bool](
        $health -and
        $health.ok -and
        [string]$health.version -eq $preVersion -and
        (Test-ReleaseControlBinding $dataRoot $preVersion $true)
      )
    }
    if (-not $preReady) {
      if ($preSupportsDrain) {
        Write-RecoveryStartupDrainFence $dataRoot ([string]$journal.release_lease_id)
      } else {
        Remove-Item -LiteralPath (Join-Path (Join-Path $dataRoot "runtime") "release-drain.json") -Force -ErrorAction SilentlyContinue
      }
      Start-BeianService $preVersion $dataRoot
      $preReady = $true
    }
    if ($preReady) {
      if ($preSupportsDrain) {
        Open-ReleaseDrain $dataRoot $preVersion ([string]$journal.release_lease_id)
      } else {
        Remove-Item -LiteralPath (Join-Path (Join-Path $dataRoot "runtime") "release-drain.json") -Force -ErrorAction SilentlyContinue
      }
      Remove-WatchdogArtifacts $journal
      Write-Host "RELEASE_RECOVERY no rollback needed; pre-release service is healthy"
      exit 0
    }
  }

  if ([bool]$journal.dependency_mutated -or [bool]$journal.python_mutated) {
    throw "release transaction illegally mutated dependencies; offline rollback cannot be proven"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules") -PathType Container)) {
    throw "release recovery requires the verified offline node_modules tree"
  }
  $python = Assert-PathUnder ([string]$journal.python_executable) $root "Python executable"
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "release recovery requires the verified offline Python environment"
  }
  $uiSnapshot = Assert-PathUnder ([string]$journal.ui_snapshot) $dataRoot "UI snapshot"
  if ((Get-DirectoryFingerprint $uiSnapshot) -ne [string]$journal.ui_snapshot_sha256) {
    throw "release recovery UI snapshot fingerprint does not match the armed journal"
  }
  # Lock ownership comes only from immutable fields armed after an all-absent
  # baseline; mutable retry stages can never grant deletion authority.
  Remove-StaleReleaseGitLocks $root $journal
  $journal.stage = "recovering"
  $journal.updated_at = [DateTime]::UtcNow.ToString("o")
  Write-AtomicJournal $journal
  Stop-BeianService
  Restore-UiSnapshot $uiSnapshot ([string]$journal.ui_snapshot_sha256) $root
  & git -C $root reset --hard $preSha
  if ($LASTEXITCODE -ne 0) { throw "git reset to the pre-release SHA failed" }
  $restoredSha = [string](& git -C $root rev-parse HEAD | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $restoredSha.Trim() -ne $preSha) {
    throw "restored HEAD does not match the pre-release SHA"
  }
  $treeVersion = [System.IO.File]::ReadAllText((Join-Path $root "VERSION")).Trim()
  if ($treeVersion -ne $preVersion) { throw "restored VERSION does not match the journal" }
  # Probe the tree that will actually be restarted, not whichever target was
  # checked out when recovery began.
  Assert-RecoveryRuntimeIntegrity $root $python
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue

  if ([bool]$journal.agent_mutated) {
    $treeInstaller = Join-Path $root "scripts\windows\install-illustrator-agent.ps1"
    if (Test-Path -LiteralPath $treeInstaller -PathType Leaf) {
      & $treeInstaller -Root $root -DataRoot $dataRoot -TaskName "beian-illustrator-agent"
    } else {
      $runtimeInstaller = Assert-PathUnder ([string]$journal.runtime_installer) $dataRoot "runtime installer"
      $installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtimeInstaller).Hash.ToLowerInvariant()
      if ($installerHash -ne [string]$journal.runtime_installer_sha256) {
        throw "runtime Illustrator installer hash does not match the journal"
      }
      & $runtimeInstaller -DataRoot $dataRoot -TaskName "beian-illustrator-agent" -Uninstall
    }
  }
  Assert-RecoveredAgentIdentity $root $preVersion $preSha

  $preSupportsDrain = ([version]$preVersion -ge [version]"0.20.0.0")
  if ($preSupportsDrain) {
    # A rollback generation that understands admission must inherit the same
    # lease before its first request. Verify the exact listener/version first;
    # only then may recovery atomically reopen writes.
    Write-RecoveryStartupDrainFence $dataRoot ([string]$journal.release_lease_id)
  } else {
    Enter-LegacyRecoverySafetyGate $dataRoot
    Remove-Item -LiteralPath (Join-Path (Join-Path $dataRoot "runtime") "release-drain.json") -Force -ErrorAction SilentlyContinue
  }
  Start-BeianService $preVersion $dataRoot
  if ($preSupportsDrain) {
    Open-ReleaseDrain $dataRoot $preVersion ([string]$journal.release_lease_id)
  }
  $finalSha = [string](& git -C $root rev-parse HEAD | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $finalSha.Trim() -ne $preSha) {
    throw "final recovered HEAD does not match the journal"
  }
  if ((Get-DirectoryFingerprint (Join-Path $root "apps\web\ui\dist")) -ne [string]$journal.ui_snapshot_sha256) {
    throw "final recovered UI does not match the armed snapshot"
  }
  Assert-RecoveredAgentIdentity $root $preVersion $preSha
  Remove-WatchdogArtifacts $journal
  Write-Host "RELEASE_RECOVERY ok sha=$preSha version=$preVersion"
} catch {
  try {
    $latest = Read-ReleaseJournal
    if ($latest) {
      if ([string]$latest.stage -ne "committed") {
        if (-not [string]$latest.failed_from_stage) {
          $latest.failed_from_stage = [string]$latest.stage
        }
        $latest.stage = "recovery_failed"
      }
      $latest.updated_at = [DateTime]::UtcNow.ToString("o")
      $latest.last_error = [string]$_.Exception.Message
      Write-AtomicJournal $latest
    }
  } catch { }
  Write-Error "RELEASE_RECOVERY failed: $($_.Exception.Message)"
  exit 1
} finally {
  if ($releaseLockStream) {
    try { $releaseLockStream.Dispose() } catch { }
  }
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
    Remove-Item -LiteralPath $ReleaseLockPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ReleaseRuntimeDir -Force -ErrorAction SilentlyContinue
  }
}
