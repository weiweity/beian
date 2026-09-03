param(
  [string]$Root = "",
  [string]$DataRoot = "",
  [string]$PipeName = "beian-illustrator-v1",
  [string]$HeartbeatName = "illustrator-agent.json",
  [string]$ExpectedUserSid = "",
  [string]$ReleaseVersion = "",
  [string]$BuildIdentity = "",
  [string]$ExpiresAtUtc = ""
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
$Protocol = "beian.illustrator.v1"
$MaxRequestBytes = 65536
$RequestReadTimeoutMs = 15000
$HeartbeatIntervalMs = 5000
$CleanupReserveMs = 30000
$UnattendedStallMs = 60000
$UnattendedSavingStallMs = 300000
$UnattendedMaxJobMs = 900000
$UnattendedOuterMs = 1260000
$UnattendedKillForbiddenStages = @(
  "opening",
  "inventory",
  "saving_full_pdf",
  "saving_artwork_pdf",
  "writing_result",
  "closing"
)
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$Utf8Bom = [System.Text.UTF8Encoding]::new($true, $true)
$FactoryKnifeLiteral = [string]([char]0x5200) + [char]0x7248
$FactoryCreaseLiteral = [string]([char]0x5200) + [char]0x7EBF
$AgentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$AgentSessionId = [int]$AgentProcess.SessionId
$AgentPid = [int]$AgentProcess.Id
$AgentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$AgentUser = [string]$AgentIdentity.Name
$AgentUserSid = [string]$AgentIdentity.User.Value
$AgentExpiresAt = [DateTime]::MaxValue

function Get-GitCheckoutIdentity([string]$RepositoryRoot, [string]$FailureMessage) {
  $lines = @(& git -C $RepositoryRoot rev-parse HEAD 2>$null)
  $exitCode = $LASTEXITCODE
  $values = @(
    $lines |
      ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } |
      Where-Object { $_ -ne "" }
  )
  if ($exitCode -ne 0 -or $values.Count -ne 1 -or $values[0] -notmatch '^[0-9a-f]{40}$') {
    throw $FailureMessage
  }
  return [string]$values[0]
}

if ($ExpiresAtUtc) {
  try {
    $AgentExpiresAt = [DateTimeOffset]::Parse($ExpiresAtUtc).UtcDateTime
  } catch {
    throw "Illustrator agent expiry is invalid"
  }
  if ($AgentExpiresAt -le [DateTime]::UtcNow) {
    throw "Illustrator agent expiry has already passed"
  }
}

if ($AgentSessionId -le 0) {
  throw "Illustrator agent must run in an interactive Windows session"
}
if ($PipeName -notmatch '^[A-Za-z0-9._-]{1,80}$') {
  throw "Illustrator agent pipe name is invalid"
}
if (-not $HeartbeatName -or [System.IO.Path]::GetFileName($HeartbeatName) -ne $HeartbeatName) {
  throw "Illustrator agent heartbeat name is invalid"
}
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not $DataRoot) {
  $DataRoot = if ($env:WB_DATA_DIR) { $env:WB_DATA_DIR } else { "C:\supply\data" }
}
$Root = [System.IO.Path]::GetFullPath($Root)
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$AgentScriptPath = [System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$AgentScriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $AgentScriptPath).Hash.ToLowerInvariant()
$VersionPath = Join-Path $Root "VERSION"
if (-not $ExpectedUserSid -or $AgentUserSid -ne $ExpectedUserSid) {
  throw "Illustrator agent interactive SID does not match the installed task"
}
if (-not $ReleaseVersion -or -not (Test-Path -LiteralPath $VersionPath -PathType Leaf)) {
  throw "Illustrator agent release identity is missing"
}
$CurrentReleaseVersion = ([System.IO.File]::ReadAllText($VersionPath)).Trim()
if ($CurrentReleaseVersion -ne $ReleaseVersion) {
  throw "Illustrator agent release identity does not match this checkout"
}
$CurrentBuildIdentity = Get-GitCheckoutIdentity $Root "Illustrator agent cannot resolve this checkout identity"
if (-not $BuildIdentity -or $CurrentBuildIdentity -ne $BuildIdentity) {
  throw "Illustrator agent build identity does not match this checkout"
}
$PipeHashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
  [System.Text.Encoding]::UTF8.GetBytes($PipeName)
)
$PipeHash = ([BitConverter]::ToString($PipeHashBytes)).Replace("-", "").ToLowerInvariant().Substring(0, 24)
$RuntimeDir = Join-Path $DataRoot "runtime"
$LogDir = Join-Path $DataRoot "logs"
$HeartbeatPath = Join-Path $RuntimeDir $HeartbeatName
$LogPath = Join-Path $LogDir "illustrator-agent.jsonl"
$FaultFencePath = Join-Path $RuntimeDir "illustrator-fault.json"
$RunnerPath = Join-Path $Root "workers\packaging\illustrator\run_export.vbs"
$ExporterRoot = Join-Path $Root "workers\packaging\illustrator"
$CscriptPath = Join-Path $env:SystemRoot "System32\cscript.exe"
New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null
$InstanceLockPath = Join-Path $RuntimeDir "illustrator-agent-$PipeHash.lock"
$ExecutionLockPath = Join-Path $RuntimeDir "illustrator-execution.lock"

function Throw-AgentFailure([string]$Code, [string]$Message, [object]$Details = $null) {
  $failure = [System.InvalidOperationException]::new($Message)
  $failure.Data["AgentCode"] = $Code
  if ($null -ne $Details) { $failure.Data["Details"] = $Details }
  throw $failure
}

function Get-JsonProperty([object]$Object, [string]$Name, [bool]$Required = $false) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    if ($Required) { Throw-AgentFailure "illustrator_agent_invalid_request" "$Name is required" }
    return $null
  }
  return $property.Value
}

function Write-Utf8File([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Write-Utf8BomFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8Bom)
}

function Write-AtomicJson([string]$Path, [object]$Value) {
  $temporary = "$Path.$AgentPid.tmp"
  Write-Utf8File $temporary (($Value | ConvertTo-Json -Depth 8 -Compress) + "`n")
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
      } else {
        [System.IO.File]::Move($temporary, $Path)
      }
      return
    } catch {
      if ($attempt -ge 4) {
        Remove-Item $temporary -Force -ErrorAction SilentlyContinue
        throw
      }
      Start-Sleep -Milliseconds 50
    }
  }
}

function Read-AgentFaultFence {
  if (-not (Test-Path -LiteralPath $FaultFencePath -PathType Leaf)) { return $null }
  $state = "faulted"
  $faultCode = "illustrator_fault_fence_invalid"
  $requestId = ""
  try {
    $fence = [System.IO.File]::ReadAllText($FaultFencePath, $Utf8NoBom) | ConvertFrom-Json
    if (
      [string]$fence.protocol -ne "beian.illustrator.fault.v1" -or
      [string]$fence.state -notin @("active", "faulted")
    ) {
      $faultCode = "illustrator_fault_fence_invalid"
    } else {
      $state = [string]$fence.state
      $faultCode = if ([string]$fence.code) { [string]$fence.code } else { "illustrator_execution_incomplete" }
      $requestId = [string]$fence.request_id
    }
  } catch {
    $faultCode = "illustrator_fault_fence_invalid"
  }
  return [PSCustomObject]@{
    State = $state
    Code = $faultCode
    RequestId = $requestId
  }
}

function Import-AgentFaultFence {
  $fence = Read-AgentFaultFence
  # "active" belongs to whichever Agent currently owns the shared execution
  # lock. It is a busy signal, not a permanent fault. Only a persisted faulted
  # record (or malformed record) may latch this process closed before the lock.
  if ($null -ne $fence -and [string]$fence.State -eq "faulted") {
    $script:AgentFaulted = $true
    $script:LastFaultCode = [string]$fence.Code
  }
  return $fence
}

function Set-AgentFaultedFromFence([object]$Fence) {
  $script:AgentFaulted = $true
  $script:LastFaultCode = if ([string]$Fence.Code) { [string]$Fence.Code } else { "illustrator_execution_incomplete" }
}

function Assert-AgentFenceAfterExecutionLock {
  $fence = Read-AgentFaultFence
  if ($null -eq $fence) { return }
  if ([string]$fence.State -eq "active") {
    # Holding the shared execution lock proves no healthy peer can still own an
    # active request. Persist the interrupted operation as faulted before
    # refusing new COM work.
    $staleRequestId = if ([string]$fence.RequestId) { [string]$fence.RequestId } else { "unknown" }
    try { Write-AgentFaultFence "faulted" ([string]$fence.Code) $staleRequestId } catch { }
  }
  Set-AgentFaultedFromFence $fence
  Throw-AgentFailure "illustrator_agent_faulted" "Illustrator desktop agent requires an administrator restart" @{
    last_code = $LastFaultCode
  }
}

function Get-AgentHeartbeatState {
  $fence = Import-AgentFaultFence
  if ($AgentFaulted) { return "faulted" }
  if ($null -eq $fence -or [string]$fence.State -ne "active") { return "idle" }

  $probeLock = $null
  try {
    $probeLock = [System.IO.FileStream]::new(
      $ExecutionLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    return "busy"
  }
  try {
    $fresh = Read-AgentFaultFence
    if ($null -eq $fresh) { return "idle" }
    if ([string]$fresh.State -eq "active") {
      $staleRequestId = if ([string]$fresh.RequestId) { [string]$fresh.RequestId } else { "unknown" }
      try { Write-AgentFaultFence "faulted" ([string]$fresh.Code) $staleRequestId } catch { }
    }
    Set-AgentFaultedFromFence $fresh
    return "faulted"
  } finally {
    $probeLock.Dispose()
  }
}

function Write-AgentFaultFence(
  [string]$State,
  [string]$Code,
  [string]$RequestId
) {
  Write-AtomicJson $FaultFencePath ([ordered]@{
    protocol = "beian.illustrator.fault.v1"
    state = $State
    code = $Code
    request_id = $RequestId
    pid = $AgentPid
    session_id = $AgentSessionId
    updated_at = [DateTime]::UtcNow.ToString("o")
  })
}

function Clear-AgentFaultFence {
  if (-not (Test-Path -LiteralPath $FaultFencePath -PathType Leaf)) { return }
  Remove-Item -LiteralPath $FaultFencePath -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $FaultFencePath) {
    throw "Illustrator execution fault fence could not be removed"
  }
}

function Assert-AgentNotFaulted {
  [void](Import-AgentFaultFence)
  if ($AgentFaulted) {
    Throw-AgentFailure "illustrator_agent_faulted" "Illustrator desktop agent requires an administrator restart" @{
      last_code = $LastFaultCode
    }
  }
}

function Write-Heartbeat([string]$State, [string]$LastCode = "") {
  $payload = [ordered]@{
    protocol = $Protocol
    pid = $AgentPid
    session_id = $AgentSessionId
    user = $AgentUser
    user_sid = $AgentUserSid
    pipe = $PipeName
    state = $State
    updated_at = [DateTime]::UtcNow.ToString("o")
    script_sha256 = $AgentScriptSha256
    release_version = $ReleaseVersion
    build_identity = $BuildIdentity
    root = $Root
  }
  if ($ExpiresAtUtc) { $payload.expires_at = $AgentExpiresAt.ToString("o") }
  if ($LastCode) { $payload.last_code = $LastCode }
  Write-AtomicJson $HeartbeatPath $payload
}

function Write-AgentLog([string]$Event, [string]$RequestId = "", [string]$Code = "") {
  if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 5MB) {
    $rotated = "$LogPath.1"
    if (Test-Path $rotated) { Remove-Item $rotated -Force }
    Move-Item $LogPath $rotated
  }
  $entry = [ordered]@{
    at = [DateTime]::UtcNow.ToString("o")
    event = $Event
    request_id = $RequestId
    code = $Code
    pid = $AgentPid
    session_id = $AgentSessionId
  }
  [System.IO.File]::AppendAllText(
    $LogPath,
    (($entry | ConvertTo-Json -Compress) + "`n"),
    $Utf8NoBom
  )
}

function Resolve-DataPath([string]$RawPath) {
  if (-not $RawPath) { Throw-AgentFailure "illustrator_agent_invalid_request" "config_path is required" }
  $candidate = [System.IO.Path]::GetFullPath($RawPath)
  $rootBoundary = $DataRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($rootBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
    Throw-AgentFailure "illustrator_agent_path_denied" "config_path is outside WB_DATA_DIR"
  }
  return $candidate
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Throw-AgentFailure "illustrator_agent_file_missing" "required JSON file does not exist"
  }
  try {
    return ([System.IO.File]::ReadAllText($Path, $Utf8NoBom) | ConvertFrom-Json)
  } catch {
    Throw-AgentFailure "illustrator_agent_invalid_json" "required JSON file is invalid"
  }
}

function Get-IllustratorExecutable {
  $settingsPath = Join-Path $DataRoot "settings.json"
  $settings = Read-JsonFile $settingsPath
  $executable = [string](Get-JsonProperty $settings "ILLUSTRATOR_EXECUTABLE" $true)
  if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    Throw-AgentFailure "illustrator_not_found" "ILLUSTRATOR_EXECUTABLE is missing or invalid"
  }
  return [System.IO.Path]::GetFullPath($executable)
}

function Get-RemainingMilliseconds(
  [DateTime]$Deadline,
  [int]$ReserveMs = 0,
  [string]$Message = "Illustrator request timed out"
) {
  $remaining = [int][Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds) - $ReserveMs
  if ($remaining -le 0) {
    Throw-AgentFailure "illustrator_timeout" $Message
  }
  return $remaining
}

function Get-RequestDeadline([object]$Request) {
  $timeoutMs = [Math]::Min(
    $UnattendedOuterMs,
    [Math]::Max(30000, [int](Get-JsonProperty $Request "timeout_ms" $true))
  )
  $now = [DateTime]::UtcNow
  $deadline = $now.AddMilliseconds($timeoutMs)
  if ($ExpiresAtUtc) {
    if ($now -ge $AgentExpiresAt.AddMilliseconds(-$CleanupReserveMs)) {
      Throw-AgentFailure "illustrator_agent_expiring" "Illustrator desktop agent is too close to its expiry to accept another request"
    }
    if ($deadline -gt $AgentExpiresAt) { $deadline = $AgentExpiresAt }
  }
  return $deadline
}

function Get-SessionIllustratorProcesses([string]$Executable) {
  $processName = [System.IO.Path]::GetFileNameWithoutExtension($Executable)
  $items = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
    [int]$_.SessionId -eq $AgentSessionId
  })
  return @($items | ForEach-Object {
    $actualPath = ""
    try { $actualPath = [System.IO.Path]::GetFullPath([string]$_.Path) } catch { }
    [ordered]@{
      pid = [int]$_.Id
      session_id = [int]$_.SessionId
      window_handle = [int64]$_.MainWindowHandle
      window_title = [string]$_.MainWindowTitle
      path = $actualPath
      matches_executable = [bool](
        $actualPath -and
        $actualPath.Equals($Executable, [System.StringComparison]::OrdinalIgnoreCase)
      )
    }
  })
}

function Assert-IllustratorProcessIdentity([object[]]$Processes, [string]$Executable) {
  $mismatches = @($Processes | Where-Object { -not $_.matches_executable })
  if ($mismatches.Count -gt 0) {
    Throw-AgentFailure "illustrator_process_identity_mismatch" "Illustrator process path does not match the configured executable" @{
      executable = $Executable
      processes = $mismatches
    }
  }
}

function ConvertTo-CommandLineArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-Tail([string]$Value, [int]$Limit = 12000) {
  if (-not $Value) { return "" }
  if ($Value.Length -le $Limit) { return $Value }
  return $Value.Substring($Value.Length - $Limit)
}

function Invoke-Cscript(
  [string[]]$Arguments,
  [DateTime]$Deadline,
  [int]$ReserveMs = 0
) {
  if (-not (Test-Path -LiteralPath $CscriptPath -PathType Leaf)) {
    Throw-AgentFailure "illustrator_bridge_missing" "cscript.exe was not found"
  }
  if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
    Throw-AgentFailure "illustrator_bridge_missing" "run_export.vbs was not found"
  }
  $allArguments = @("//Nologo", $RunnerPath) + $Arguments
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $CscriptPath
  $startInfo.Arguments = (($allArguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " ")
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::Default
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::Default
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $processStarted = $false
  $exitProven = $false
  try {
    if (-not $process.Start()) {
      Throw-AgentFailure "illustrator_bridge_failed" "cscript.exe did not start"
    }
    $processStarted = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $finished = $false
    while (-not $finished) {
      $remainingMs = [int][Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds) - $ReserveMs
      if ($remainingMs -le 0) { break }
      $sliceMs = [Math]::Min(5000, $remainingMs)
      $finished = $process.WaitForExit($sliceMs)
      if (-not $finished) { Write-Heartbeat "busy" }
    }
    if (-not $finished) {
      if (-not $process.HasExited) { $process.Kill() }
      if (-not $process.WaitForExit(5000)) {
        Throw-AgentFailure "illustrator_recovery_failed" "Timed-out cscript.exe did not exit after termination"
      }
    }
    $exitProven = $true
    # A finite wait above proves exit; this call only flushes asynchronous output.
    $process.WaitForExit()
    $stdout = Get-Tail ([string]$stdoutTask.Result)
    $stderr = Get-Tail ([string]$stderrTask.Result)
    $exitCode = if ($finished) { [int]$process.ExitCode } else { -1 }
    return [PSCustomObject]@{
      ExitCode = $exitCode
      Stdout = $stdout.Trim()
      Stderr = $stderr.Trim()
      TimedOut = (-not $finished)
    }
  } finally {
    if ($processStarted -and -not $exitProven) {
      $cleanupProven = $false
      try {
        if (-not $process.HasExited) { $process.Kill() }
        $cleanupProven = $process.WaitForExit(5000)
      } catch {
        $cleanupProven = $false
      }
      $process.Dispose()
      if (-not $cleanupProven) {
        Throw-AgentFailure "illustrator_recovery_failed" "cscript.exe could not be terminated safely after an agent-side failure"
      }
    } else {
      $process.Dispose()
    }
  }
}

function Convert-ProbeOutput([string]$Output) {
  $version = ""
  $documentCount = $null
  $documents = @()
  foreach ($line in ($Output -split "`r?`n")) {
    if (-not $line) { continue }
    $fields = $line -split "`t", 3
    if ($fields[0] -eq "VERSION" -and $fields.Count -ge 2) {
      $version = [string]$fields[1]
    } elseif ($fields[0] -eq "DOCUMENT_COUNT" -and $fields.Count -ge 2) {
      $documentCount = [int]$fields[1]
    } elseif ($fields[0] -eq "DOCUMENT" -and $fields.Count -ge 2) {
      $documents += [ordered]@{
        name = [string]$fields[1]
        path = if ($fields.Count -ge 3) { [string]$fields[2] } else { "" }
      }
    }
  }
  if (-not $version -or $null -eq $documentCount) {
    Throw-AgentFailure "illustrator_agent_protocol_error" "Illustrator COM probe returned an invalid contract"
  }
  return [ordered]@{
    illustrator_version = $version
    document_count = [int]$documentCount
    documents = $documents
  }
}

function Test-KillForbiddenStage([string]$Stage) {
  return [bool]($UnattendedKillForbiddenStages -contains $Stage)
}

function Read-JobSidecar([string]$Path, [string]$AttemptId) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
    if (-not $raw.Trim()) { return $null }
    $json = $raw | ConvertFrom-Json
    if ($AttemptId -and [string]$json.attempt_id -ne $AttemptId) { return $null }
    return $json
  } catch {
    return $null
  }
}

function Get-JobProgressPath([object]$Config) {
  $debugLog = [string](Get-JsonProperty $Config "debug_log")
  if (-not $debugLog) { return "" }
  return Join-Path ([System.IO.Path]::GetDirectoryName($debugLog)) "illustrator_progress.json"
}

function Invoke-JobCscript(
  [string]$RuntimePath,
  [object]$Config,
  [DateTime]$OuterDeadline
) {
  if (-not (Test-Path -LiteralPath $CscriptPath -PathType Leaf)) {
    Throw-AgentFailure "illustrator_bridge_missing" "cscript.exe was not found"
  }
  if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
    Throw-AgentFailure "illustrator_bridge_missing" "run_export.vbs was not found"
  }
  $attemptId = [string](Get-JsonProperty $Config "attempt_id" $true)
  $resultPath = [string](Get-JsonProperty $Config "result_json" $true)
  $progressPath = Get-JobProgressPath $Config
  $jobStarted = [DateTime]::UtcNow
  $allArguments = @("//Nologo", $RunnerPath, "run", $RuntimePath)
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $CscriptPath
  $startInfo.Arguments = (($allArguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " ")
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::Default
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::Default
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $processStarted = $false
  $exitProven = $false
  $allowKill = $false
  try {
    if (-not $process.Start()) {
      Throw-AgentFailure "illustrator_bridge_failed" "cscript.exe did not start"
    }
    $processStarted = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $finished = $false
    while (-not $finished) {
      $progress = Read-JobSidecar $progressPath $attemptId
      $result = Read-JobSidecar $resultPath $attemptId
      $stage = if ($progress) { [string]$progress.stage } else { "" }
      $progressAgeMs = $null
      if ($progress -and $progress.updated_at) {
        try {
          $updated = [DateTimeOffset]::Parse([string]$progress.updated_at).UtcDateTime
          $progressAgeMs = [int]([DateTime]::UtcNow - $updated).TotalMilliseconds
        } catch { $progressAgeMs = $null }
      }
      $elapsedMs = [int]([DateTime]::UtcNow - $jobStarted).TotalMilliseconds
      $hasResult = [bool]$result
      if (Test-KillForbiddenStage $stage) {
        # saving_full_pdf / saving_artwork_pdf / writing_result: forbid Kill
        $allowKill = $false
      } elseif ($hasResult) {
        $allowKill = [bool]($null -ne $progressAgeMs -and $progressAgeMs -ge $UnattendedStallMs)
      } elseif (
        ($null -ne $progressAgeMs -and $progressAgeMs -ge $UnattendedStallMs) -or
        $elapsedMs -ge $UnattendedMaxJobMs
      ) {
        $allowKill = $true
      } else {
        $allowKill = $false
      }
      $sliceMs = 2000
      if ($allowKill) { break }
      $finished = $process.WaitForExit($sliceMs)
      if (-not $finished) { Write-Heartbeat "busy" }
    }
    if (-not $finished) {
      $progress = Read-JobSidecar $progressPath $attemptId
      $stage = if ($progress) { [string]$progress.stage } else { "" }
      if (Test-KillForbiddenStage $stage) {
        $allowKill = $false
      }
      if ($allowKill -and -not $process.HasExited) { $process.Kill() }
      if ($allowKill) {
        if (-not $process.WaitForExit(5000)) {
          Throw-AgentFailure "illustrator_recovery_failed" "Timed-out cscript.exe did not exit after termination"
        }
      } else {
        while (-not $process.HasExited) {
          Write-Heartbeat "busy"
          [void]$process.WaitForExit(2000)
          $progress = Read-JobSidecar $progressPath $attemptId
          $stage = if ($progress) { [string]$progress.stage } else { "" }
          if (-not (Test-KillForbiddenStage $stage) -and $allowKill) { break }
        }
        if (-not $process.HasExited -and -not (Test-KillForbiddenStage $stage) -and $allowKill) {
          $process.Kill()
          if (-not $process.WaitForExit(5000)) {
            Throw-AgentFailure "illustrator_recovery_failed" "Timed-out cscript.exe did not exit after termination"
          }
        }
        if (-not $process.HasExited) {
          $exitProven = $true
          return [PSCustomObject]@{
            ExitCode = -1
            Stdout = ""
            Stderr = ""
            TimedOut = $true
            LeftRunning = $true
          }
        }
      }
    }
    $exitProven = $true
    $process.WaitForExit()
    $stdout = Get-Tail ([string]$stdoutTask.Result)
    $stderr = Get-Tail ([string]$stderrTask.Result)
    $exitCode = if ($finished) { [int]$process.ExitCode } else { -1 }
    return [PSCustomObject]@{
      ExitCode = $exitCode
      Stdout = $stdout.Trim()
      Stderr = $stderr.Trim()
      TimedOut = (-not $finished)
      LeftRunning = $false
    }
  } finally {
    if ($processStarted -and -not $exitProven) {
      $progress = Read-JobSidecar $progressPath $attemptId
      $stage = if ($progress) { [string]$progress.stage } else { "" }
      $cleanupProven = $true
      try {
        if (-not (Test-KillForbiddenStage $stage) -and -not $process.HasExited) {
          $process.Kill()
          $cleanupProven = $process.WaitForExit(5000)
        }
      } catch {
        $cleanupProven = $false
      }
      $process.Dispose()
      if (-not $cleanupProven -and -not (Test-KillForbiddenStage $stage)) {
        Throw-AgentFailure "illustrator_recovery_failed" "cscript.exe could not be terminated safely after an agent-side failure"
      }
    } else {
      $process.Dispose()
    }
  }
}

function Invoke-BridgeProbe([DateTime]$Deadline, [int]$ReserveMs = 0) {
  $probe = Invoke-Cscript @("probe") $Deadline $ReserveMs
  if ($probe.TimedOut) {
    Throw-AgentFailure "illustrator_timeout" "Illustrator COM probe timed out"
  }
  if ($probe.ExitCode -ne 0) {
    Throw-AgentFailure "illustrator_unavailable" ($probe.Stderr + " " + $probe.Stdout).Trim()
  }
  return Convert-ProbeOutput $probe.Stdout
}

function Ensure-Illustrator(
  [string]$Executable,
  [DateTime]$Deadline,
  [int]$ReserveMs = 0
) {
  $startedAt = [DateTime]::UtcNow
  $processes = @(Get-SessionIllustratorProcesses $Executable)
  Assert-IllustratorProcessIdentity $processes $Executable
  if ($processes.Count -gt 0 -and @($processes | Where-Object { $_.window_handle -ne 0 }).Count -eq 0) {
    Throw-AgentFailure "illustrator_no_window" "Illustrator exists in this session but has no visible window" @{
      processes = $processes
    }
  }
  if ($processes.Count -eq 0) {
    Start-Process -FilePath $Executable | Out-Null
  }
  $lastMessage = "Illustrator did not become ready"
  while (([DateTime]::UtcNow.AddMilliseconds($ReserveMs)) -lt $Deadline) {
    Write-Heartbeat "busy"
    $processes = @(Get-SessionIllustratorProcesses $Executable)
    Assert-IllustratorProcessIdentity $processes $Executable
    $visible = @($processes | Where-Object { $_.window_handle -ne 0 })
    if ($processes.Count -gt 0 -and $visible.Count -eq 0) {
      $lastMessage = "Illustrator process has no visible window"
    } elseif ($visible.Count -gt 0) {
      try {
        $probe = Invoke-BridgeProbe $Deadline $ReserveMs
        $probe["processes"] = $processes
        $probe["warmup_elapsed_ms"] = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
        return $probe
      } catch {
        $probeCode = [string]$_.Exception.Data["AgentCode"]
        if ($probeCode -eq "illustrator_recovery_failed") {
          # Invoke-Cscript could not prove that its child exited. Retrying would
          # start a second COM bridge and later downgrade the persistent fence.
          throw
        }
        $lastMessage = $_.Exception.Message
      }
    }
    $remainingMs = Get-RemainingMilliseconds $Deadline $ReserveMs "Illustrator did not become ready before the request deadline"
    Start-Sleep -Milliseconds ([Math]::Min(1000, $remainingMs))
  }
  Throw-AgentFailure "illustrator_timeout" $lastMessage @{
    session_id = $AgentSessionId
    processes = $processes
  }
}

function Assert-NoOpenDocuments([object]$Probe) {
  if ([int]$Probe.document_count -ne 0) {
    Throw-AgentFailure "illustrator_documents_open" "Illustrator has open documents" @{
      documents = @($Probe.documents)
      session_id = $AgentSessionId
      processes = @($Probe.processes)
    }
  }
}

function Bind-RuntimeJsx([string]$ExporterPath, [string]$ConfigPath) {
  if (-not (Test-Path -LiteralPath $ExporterPath -PathType Leaf)) {
    Throw-AgentFailure "illustrator_bridge_missing" "fixed JSX exporter was not found"
  }
  $runtimePath = Join-Path ([System.IO.Path]::GetDirectoryName($ConfigPath)) (([System.IO.Path]::GetFileNameWithoutExtension($ExporterPath)) + ".runtime.jsx")
  $configLiteral = ConvertTo-Json ([string]$ConfigPath) -Compress
  $source = [System.IO.File]::ReadAllText($ExporterPath, $Utf8NoBom)
  $fileName = [System.IO.Path]::GetFileName($ExporterPath)
  $includes = @()
  if ($fileName -eq "export_structure.jsx" -or $fileName -eq "export_ai.jsx") {
    $includes += [ordered]@{
      needle = '#include "unattended_host.jsx"'
      path = Join-Path $ExporterRoot "unattended_host.jsx"
      missing = "fixed unattended host binding was not found"
    }
  }
  if ($fileName -eq "export_structure.jsx") {
    $includes += [ordered]@{
      needle = '#include "curve_flatten.js"'
      path = Join-Path $ExporterRoot "curve_flatten.js"
      missing = "fixed curve helper binding was not found"
    }
  }
  foreach ($item in $includes) {
    $matches = [regex]::Matches($source, [regex]::Escape([string]$item.needle))
    if ($matches.Count -ne 1 -or -not (Test-Path -LiteralPath ([string]$item.path) -PathType Leaf)) {
      Throw-AgentFailure "illustrator_bridge_missing" ([string]$item.missing)
    }
    $helper = [System.IO.File]::ReadAllText([string]$item.path, $Utf8NoBom)
    $source = $source.Replace([string]$item.needle, $helper)
  }
  $source = "var PIPELINE_CONFIG_PATH = $configLiteral;`n" + $source
  Write-Utf8BomFile $runtimePath $source
  $header = [System.IO.File]::ReadAllBytes($runtimePath)
  if ($header.Length -lt 3 -or $header[0] -ne 0xEF -or $header[1] -ne 0xBB -or $header[2] -ne 0xBF) {
    Throw-AgentFailure "illustrator_bridge_failed" "Illustrator runtime JSX is missing UTF-8 BOM"
  }
  return $runtimePath
}

function Stop-MatchingIllustrator([string]$Executable, [DateTime]$Deadline) {
  $items = @(Get-SessionIllustratorProcesses $Executable | Where-Object { $_.matches_executable })
  foreach ($item in $items) {
    try { Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop } catch { }
  }
  while ([DateTime]::UtcNow -lt $Deadline) {
    Write-Heartbeat "busy"
    $left = @(Get-SessionIllustratorProcesses $Executable | Where-Object { $_.matches_executable })
    if ($left.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
}

function Restore-OwnedDocumentState(
  [string]$SourcePath,
  [DateTime]$Deadline,
  [string]$OriginalCode
) {
  try {
    if (-not $SourcePath) {
      Throw-AgentFailure "illustrator_recovery_failed" "Illustrator cleanup could not identify the job document" @{
        original_code = $OriginalCode
      }
    }
    $close = Invoke-Cscript @("close-owned", $SourcePath) $Deadline 0
    if ($close.TimedOut -or $close.ExitCode -ne 0) {
      Throw-AgentFailure "illustrator_recovery_failed" "Illustrator job document could not be closed safely" @{
        original_code = $OriginalCode
        exit_code = [int]$close.ExitCode
        diagnostic = ($close.Stderr + " " + $close.Stdout).Trim()
      }
    }
    $probe = Invoke-BridgeProbe $Deadline 0
    if ([int]$probe.document_count -ne 0) {
      Throw-AgentFailure "illustrator_recovery_failed" "Illustrator still has open documents after cleanup" @{
        original_code = $OriginalCode
        documents = @($probe.documents)
      }
    }
    return $probe
  } catch {
    $recoveryCode = [string]$_.Exception.Data["AgentCode"]
    if ($recoveryCode -eq "illustrator_recovery_failed") { throw }
    Throw-AgentFailure "illustrator_recovery_failed" "Illustrator cleanup could not be verified before the deadline" @{
      original_code = $OriginalCode
      recovery_code = if ($recoveryCode) { $recoveryCode } else { "illustrator_agent_internal_error" }
    }
  }
}

function Invoke-RunRequest([object]$Request, [DateTime]$Deadline) {
  $configPath = Resolve-DataPath ([string](Get-JsonProperty $Request "config_path" $true))
  $config = Read-JsonFile $configPath
  $exporter = [string](Get-JsonProperty $Request "exporter" $true)
  $expectedExporter = if (Get-JsonProperty $config "structure_json") { "structure" } else { "legacy" }
  if ($exporter -ne $expectedExporter) {
    Throw-AgentFailure "illustrator_agent_invalid_request" "exporter does not match the job config"
  }
  $executable = Get-IllustratorExecutable
  $configuredForJob = [System.IO.Path]::GetFullPath([string](Get-JsonProperty $config "application" $true))
  if (-not $configuredForJob.Equals($executable, [System.StringComparison]::OrdinalIgnoreCase)) {
    Throw-AgentFailure "illustrator_configuration_mismatch" "job and desktop agent use different Illustrator executables"
  }
  $probe = Ensure-Illustrator $executable $Deadline $CleanupReserveMs
  Assert-NoOpenDocuments $probe
  $exporterName = if ($exporter -eq "structure") { "export_structure.jsx" } else { "export_ai.jsx" }
  $runtimePath = Bind-RuntimeJsx (Join-Path $ExporterRoot $exporterName) $configPath
  $sourcePath = [string](Get-JsonProperty $config "source_ai" $true)
  $attemptId = [string](Get-JsonProperty $config "attempt_id" $true)
  $resultPath = [string](Get-JsonProperty $config "result_json" $true)
  $progressPath = Get-JobProgressPath $config
  $run = Invoke-JobCscript $runtimePath $config $Deadline
  $jobResult = Read-JobSidecar $resultPath $attemptId
  $progress = Read-JobSidecar $progressPath $attemptId
  $stage = if ($progress) { [string]$progress.stage } else { "" }
  $thisAttemptSucceeded = [bool]($jobResult -and $jobResult.success -eq $true)
  if ($thisAttemptSucceeded) {
    if ($run.LeftRunning) {
      Throw-AgentFailure "illustrator_timeout" "Illustrator JSX is still running after writing this attempt's result"
    }
  } elseif ($run.TimedOut -or $run.LeftRunning) {
    if (Test-KillForbiddenStage $stage -or $run.LeftRunning) {
      Throw-AgentFailure "illustrator_timeout" "Illustrator JSX execution timed out"
    }
    try {
      Restore-OwnedDocumentState $sourcePath $Deadline "illustrator_timeout" | Out-Null
    } catch {
      $recoveryCode = [string]$_.Exception.Data["AgentCode"]
      if ($recoveryCode -eq "illustrator_recovery_failed") {
        Stop-MatchingIllustrator $executable $Deadline
        $restarted = Ensure-Illustrator $executable $Deadline 0
        if ([int]$restarted.document_count -eq 0) {
          if ($thisAttemptSucceeded) {
            return [ordered]@{
              illustrator_version = [string]$probe.illustrator_version
              warmup_elapsed_ms = [int]$probe.warmup_elapsed_ms
              document_count = 0
              documents = @()
              session_id = $AgentSessionId
              window_title = [string](@($probe.processes | Where-Object { $_.window_handle -ne 0 })[0].window_title)
            }
          }
          Throw-AgentFailure "illustrator_timeout" "Illustrator JSX execution timed out"
        }
      }
      throw
    }
    Throw-AgentFailure "illustrator_timeout" "Illustrator JSX execution timed out"
  }
  if ($run.ExitCode -ne 0 -and -not $thisAttemptSucceeded) {
    if ($run.ExitCode -eq 12) {
      $blocked = Invoke-BridgeProbe $Deadline $CleanupReserveMs
      Throw-AgentFailure "illustrator_documents_open" "Illustrator has open documents" @{
        documents = @($blocked.documents)
      }
    }
    Restore-OwnedDocumentState $sourcePath $Deadline "illustrator_bridge_failed" | Out-Null
    Throw-AgentFailure "illustrator_bridge_failed" "Illustrator JSX execution failed" @{
      exit_code = [int]$run.ExitCode
      diagnostic = ($run.Stderr + " " + $run.Stdout).Trim()
    }
  }
  if ($thisAttemptSucceeded) {
    $Deadline = [DateTime]::UtcNow.AddSeconds(60)
  }
  try {
    $after = Invoke-BridgeProbe $Deadline $CleanupReserveMs
  } catch {
    $original = $_.Exception
    $originalCode = [string]$original.Data["AgentCode"]
    if ($originalCode -eq "illustrator_recovery_failed") {
      throw
    }
    Restore-OwnedDocumentState $sourcePath $Deadline "illustrator_agent_protocol_error" | Out-Null
    throw $original
  }
  if ([int]$after.document_count -ne 0) {
    try {
      $after = Restore-OwnedDocumentState $sourcePath $Deadline "illustrator_documents_open"
    } catch {
      Stop-MatchingIllustrator $executable $Deadline
      $restarted = Ensure-Illustrator $executable $Deadline 0
      if ([int]$restarted.document_count -eq 0) {
        $after = $restarted
      } else {
        throw
      }
    }
  }
  $after["processes"] = @(Get-SessionIllustratorProcesses $executable)
  Assert-IllustratorProcessIdentity @($after.processes) $executable
  Assert-NoOpenDocuments $after
  return [ordered]@{
    illustrator_version = [string]$probe.illustrator_version
    warmup_elapsed_ms = [int]$probe.warmup_elapsed_ms
    document_count = [int]$after.document_count
    documents = @($after.documents)
    session_id = $AgentSessionId
    window_title = [string](@($probe.processes | Where-Object { $_.window_handle -ne 0 })[0].window_title)
  }
}

function Invoke-ProbeRequest([object]$Request, [DateTime]$Deadline) {
  $executable = Get-IllustratorExecutable
  $probe = Ensure-Illustrator $executable $Deadline 0
  Assert-NoOpenDocuments $probe
  return [ordered]@{
    illustrator_version = [string]$probe.illustrator_version
    warmup_elapsed_ms = [int]$probe.warmup_elapsed_ms
    document_count = [int]$probe.document_count
    documents = @($probe.documents)
    processes = @($probe.processes)
    session_id = $AgentSessionId
  }
}

function Invoke-SmokeRequest([object]$Request, [DateTime]$Deadline) {
  $executable = Get-IllustratorExecutable
  $probe = Ensure-Illustrator $executable $Deadline 15000
  Assert-NoOpenDocuments $probe
  $smokeDir = Join-Path $RuntimeDir ("illustrator-smoke-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $smokeDir | Out-Null
  try {
    $sentinel = Join-Path $smokeDir "runner-probe.txt"
    $runtimePath = Bind-RuntimeJsx (Join-Path $ExporterRoot "runner_probe.jsx") $sentinel
    $probeSource = [System.IO.File]::ReadAllText($runtimePath, $Utf8Bom)
    if ($probeSource.IndexOf($FactoryKnifeLiteral) -lt 0 -or $probeSource.IndexOf($FactoryCreaseLiteral) -lt 0) {
      Throw-AgentFailure "illustrator_bridge_failed" "Illustrator smoke probe is missing factory knife literals"
    }
    $structureConfig = Join-Path $smokeDir "structure-bind.json"
    Write-Utf8File $structureConfig "{}"
    $structureRuntime = Bind-RuntimeJsx (Join-Path $ExporterRoot "export_structure.jsx") $structureConfig
    $structureSource = [System.IO.File]::ReadAllText($structureRuntime, $Utf8Bom)
    if ($structureSource.IndexOf($FactoryKnifeLiteral) -lt 0 -or $structureSource.IndexOf($FactoryCreaseLiteral) -lt 0) {
      Throw-AgentFailure "illustrator_bridge_failed" "Illustrator smoke structure JSX is missing factory knife literals"
    }
    $run = Invoke-Cscript @("run", $runtimePath) $Deadline 15000
    if ($run.TimedOut) { Throw-AgentFailure "illustrator_timeout" "Illustrator smoke timed out" }
    if ($run.ExitCode -ne 0) {
      Throw-AgentFailure "illustrator_bridge_failed" "Illustrator smoke failed" @{
        exit_code = [int]$run.ExitCode
        diagnostic = ($run.Stderr + " " + $run.Stdout).Trim()
      }
    }
    if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) {
      Throw-AgentFailure "illustrator_bridge_failed" "Illustrator smoke did not write its sentinel"
    }
    $sentinelValue = [System.IO.File]::ReadAllText($sentinel, $Utf8NoBom).Trim()
    if ($sentinelValue -ne "runner-ok") {
      Throw-AgentFailure "illustrator_bridge_failed" "Illustrator smoke sentinel is invalid"
    }
    $after = Invoke-BridgeProbe $Deadline 0
    $after["processes"] = @(Get-SessionIllustratorProcesses $executable)
    Assert-IllustratorProcessIdentity @($after.processes) $executable
    Assert-NoOpenDocuments $after
    return [ordered]@{
      illustrator_version = [string]$probe.illustrator_version
      document_count = 0
      session_id = $AgentSessionId
      sentinel = "runner-ok"
    }
  } finally {
    if (Test-Path $smokeDir) { Remove-Item $smokeDir -Recurse -Force }
  }
}

function Invoke-AgentRequest([object]$Request, [DateTime]$Deadline) {
  if ([string](Get-JsonProperty $Request "protocol" $true) -ne $Protocol) {
    Throw-AgentFailure "illustrator_agent_protocol_error" "request protocol does not match"
  }
  $command = [string](Get-JsonProperty $Request "command" $true)
  if ($command -eq "probe") { return Invoke-ProbeRequest $Request $Deadline }
  if ($command -eq "run") { return Invoke-RunRequest $Request $Deadline }
  if ($command -eq "smoke") { return Invoke-SmokeRequest $Request $Deadline }
  Throw-AgentFailure "illustrator_agent_invalid_request" "unsupported command"
}

function Read-PipeRequestLine([System.IO.Stream]$Stream) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($RequestReadTimeoutMs)
  $buffer = New-Object byte[] 4096
  $bytes = New-Object System.IO.MemoryStream
  try {
    Write-Heartbeat "busy"
    while ($true) {
      $readTask = $Stream.ReadAsync($buffer, 0, $buffer.Length)
      while (-not $readTask.IsCompleted) {
        $remainingMs = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if ($remainingMs -le 0) {
          Throw-AgentFailure "illustrator_agent_invalid_request" "request body timed out"
        }
        $sliceMs = [Math]::Min($HeartbeatIntervalMs, $remainingMs)
        if ($readTask.Wait($sliceMs)) { break }
        Write-Heartbeat "busy"
      }
      $count = [int]$readTask.Result
      if ($count -le 0) {
        Throw-AgentFailure "illustrator_agent_invalid_request" "request body is empty"
      }
      for ($index = 0; $index -lt $count; $index++) {
        $value = [byte]$buffer[$index]
        if ($value -eq 10) {
          if ($bytes.Length -le 0) {
            Throw-AgentFailure "illustrator_agent_invalid_request" "request body is empty"
          }
          try {
            return $Utf8NoBom.GetString($bytes.ToArray()).TrimEnd("`r")
          } catch {
            Throw-AgentFailure "illustrator_agent_invalid_request" "request body is not valid UTF-8"
          }
        }
        if ($bytes.Length -ge $MaxRequestBytes) {
          Throw-AgentFailure "illustrator_agent_invalid_request" "request body is too large"
        }
        $bytes.WriteByte($value)
      }
    }
  } finally {
    $bytes.Dispose()
  }
}

function Enter-ExecutionLock([DateTime]$Deadline) {
  Write-Heartbeat "busy"
  $nextHeartbeatAt = [DateTime]::UtcNow.AddMilliseconds($HeartbeatIntervalMs)
  while ($true) {
    $remainingMs = Get-RemainingMilliseconds $Deadline 0 "Illustrator execution slot timed out"
    try {
      $lock = [System.IO.FileStream]::new(
        $ExecutionLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $nextHeartbeatAt) {
        Write-Heartbeat "busy"
        $nextHeartbeatAt = [DateTime]::UtcNow.AddMilliseconds($HeartbeatIntervalMs)
      }
      Start-Sleep -Milliseconds ([Math]::Min(250, $remainingMs))
      continue
    }
    try {
      [void](Get-RemainingMilliseconds $Deadline 0 "Illustrator execution slot timed out")
      return $lock
    } catch {
      $lock.Dispose()
      throw
    }
  }
}

function New-PipeServer {
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.SetAccessRuleProtection($true, $false)
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $rights = [System.IO.Pipes.PipeAccessRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($currentSid, $rights, $allow))
  $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($systemSid, $rights, $allow))
  return [System.IO.Pipes.NamedPipeServerStream]::new(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,
    $MaxRequestBytes,
    $MaxRequestBytes,
    $security
  )
}

$instanceLock = $null
try {
  $instanceLock = [System.IO.FileStream]::new(
    $InstanceLockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch [System.IO.IOException] {
  exit 73
}
$AgentFaulted = $false
$LastFaultCode = ""
[void](Import-AgentFaultFence)

try {
  Write-AgentLog "started"
  $heartbeatState = Get-AgentHeartbeatState
  if ($heartbeatState -eq "faulted") {
    Write-Heartbeat "faulted" $LastFaultCode
  } else {
    Write-Heartbeat $heartbeatState
  }
  :AgentLoop while ($true) {
    if ([DateTime]::UtcNow -ge $AgentExpiresAt) { break }
    $pipe = New-PipeServer
    $wait = $pipe.BeginWaitForConnection($null, $null)
    while ($true) {
      $waitSliceMs = $HeartbeatIntervalMs
      if ($ExpiresAtUtc) {
        $expiryRemainingMs = [int][Math]::Ceiling(($AgentExpiresAt - [DateTime]::UtcNow).TotalMilliseconds)
        if ($expiryRemainingMs -le 0) {
          $pipe.Dispose()
          break AgentLoop
        }
        $waitSliceMs = [Math]::Max(1, [Math]::Min($waitSliceMs, $expiryRemainingMs))
      }
      if ($wait.AsyncWaitHandle.WaitOne($waitSliceMs)) { break }
      $heartbeatState = Get-AgentHeartbeatState
      if ($heartbeatState -eq "faulted") {
        Write-Heartbeat "faulted" $LastFaultCode
      } else {
        Write-Heartbeat $heartbeatState
      }
    }
    $pipe.EndWaitForConnection($wait)
    $reader = $null
    $writer = $null
    $requestId = ""
    $executionLock = $null
    $executionFenceArmed = $false
    try {
      $writer = [System.IO.StreamWriter]::new($pipe, $Utf8NoBom, 4096, $true)
      $writer.AutoFlush = $true
      $writer.NewLine = "`n"
      $line = Read-PipeRequestLine $pipe
      $request = $line | ConvertFrom-Json
      $requestId = [string](Get-JsonProperty $request "id" $true)
      if (-not $requestId -or $requestId.Length -gt 64) {
        Throw-AgentFailure "illustrator_agent_invalid_request" "request id is missing or too long"
      }
      Assert-AgentNotFaulted
      $deadline = Get-RequestDeadline $request
      $executionLock = Enter-ExecutionLock $deadline
      Assert-AgentFenceAfterExecutionLock
      [void](Get-RemainingMilliseconds $deadline 0 "Illustrator execution slot timed out")
      Write-AgentFaultFence "active" "illustrator_execution_incomplete" $requestId
      $executionFenceArmed = $true
      Write-Heartbeat "busy"
      Write-AgentLog "request" $requestId ([string](Get-JsonProperty $request "command" $true))
      $result = Invoke-AgentRequest $request $deadline
      try {
        Clear-AgentFaultFence
        $executionFenceArmed = $false
      } catch {
        Throw-AgentFailure "illustrator_recovery_failed" "Illustrator execution fence could not be cleared safely"
      }
      $response = [ordered]@{
        protocol = $Protocol
        id = $requestId
        ok = $true
        agent_root = $Root
        user_sid = $AgentUserSid
        script_sha256 = $AgentScriptSha256
        release_version = $ReleaseVersion
        build_identity = $BuildIdentity
      }
      foreach ($key in $result.Keys) { $response[$key] = $result[$key] }
      $writer.WriteLine(($response | ConvertTo-Json -Depth 10 -Compress))
      Write-AgentLog "completed" $requestId "ok"
      Write-Heartbeat "idle"
    } catch {
      $code = [string]$_.Exception.Data["AgentCode"]
      if (-not $code) { $code = "illustrator_agent_internal_error" }
      $message = [string]$_.Exception.Message
      $details = $_.Exception.Data["Details"]
      if ($null -eq $details) { $details = @{} }
      if ($code -ne "illustrator_recovery_failed" -and $executionFenceArmed) {
        try {
          Clear-AgentFaultFence
          $executionFenceArmed = $false
        } catch {
          $code = "illustrator_recovery_failed"
          $message = "Illustrator execution fence could not be cleared safely"
          $details = @{}
        }
      }
      if ($code -eq "illustrator_recovery_failed") {
        # The active fence is written before cscript/COM work begins. Even if this
        # state update fails, the existing active fence keeps every Agent closed.
        try { Write-AgentFaultFence "faulted" $code $requestId } catch { }
        $AgentFaulted = $true
        $LastFaultCode = $code
      }
      if ($null -ne $writer) {
        try {
          $writer.WriteLine((([ordered]@{
            protocol = $Protocol
            id = $requestId
            ok = $false
            code = $code
            message = $message
            details = $details
          }) | ConvertTo-Json -Depth 10 -Compress))
        } catch { }
      }
      Write-AgentLog "failed" $requestId $code
      if ($code -eq "illustrator_recovery_failed") {
        Write-Heartbeat "faulted" $code
      } elseif ($AgentFaulted) {
        Write-Heartbeat "faulted" $LastFaultCode
      } else {
        Write-Heartbeat "idle" $code
      }
    } finally {
      if ($executionLock) { $executionLock.Dispose() }
      if ($null -ne $writer) { $writer.Dispose() }
      $pipe.Dispose()
    }
  }
} finally {
  try { Write-AgentLog "stopped" } catch { }
  try { Remove-Item $HeartbeatPath -Force -ErrorAction SilentlyContinue } catch { }
  if ($instanceLock) { $instanceLock.Dispose() }
  try { Remove-Item $InstanceLockPath -Force -ErrorAction SilentlyContinue } catch { }
}
