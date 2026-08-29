param(
  [string]$PipeName = "beian-illustrator-v1"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $env:WB_DATA_DIR) { $env:WB_DATA_DIR = "C:\supply\data" }

function Wait-IllustratorSlotIdle {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
    } catch {
      if ($attempt -ge 2) { throw "local health unavailable; refusing Illustrator smoke" }
      Start-Sleep -Seconds 5
      continue
    }
    $running = [int]$health.jobs.illustrator.running
    $queued = [int]$health.jobs.illustrator.queued
    $agentState = [string]$health.jobs.illustrator.agent.state
    if ($agentState -eq "faulted") {
      throw "Illustrator desktop agent is faulted; an interactive administrator must verify the desktop before L1"
    }
    if ($agentState -and $agentState -notin @("idle", "busy")) {
      throw "Illustrator desktop agent state is not safe for L1: $agentState"
    }
    if (
      $running -eq 0 -and
      $queued -eq 0 -and
      $agentState -eq "idle"
    ) { return }
    Start-Sleep -Seconds 5
  }
  throw "Illustrator queue did not become idle before smoke timeout"
}

function Assert-SelectedAgentIdle([string]$HeartbeatName) {
  $heartbeatPath = Join-Path (Join-Path $env:WB_DATA_DIR "runtime") $HeartbeatName
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) {
    throw "Illustrator desktop agent heartbeat is missing before L1"
  }
  try {
    $heartbeat = [System.IO.File]::ReadAllText($heartbeatPath) | ConvertFrom-Json
  } catch {
    throw "Illustrator desktop agent heartbeat is invalid before L1"
  }
  if ([string]$heartbeat.state -ne "idle") {
    throw "Illustrator desktop agent is not explicitly idle before L1"
  }
}

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-AgentClient(
  [string]$Python,
  [string]$Client,
  [string]$NamedPipe,
  [string]$HeartbeatName
) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Python
  $startInfo.Arguments = @(
    (Quote-ProcessArgument $Client),
    "smoke",
    "--timeout", "120",
    "--pipe", (Quote-ProcessArgument $NamedPipe),
    "--heartbeat", (Quote-ProcessArgument $HeartbeatName)
  ) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $startInfo.EnvironmentVariables["PYTHONUTF8"] = "1"
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Illustrator agent client did not start" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $finished = $process.WaitForExit(150000)
  if (-not $finished) {
    try {
      $process.Kill()
    } catch {
      throw "Illustrator smoke client timed out and could not be killed: $($_.Exception.Message)"
    }
    if (-not $process.WaitForExit(5000)) {
      throw "Illustrator smoke client did not exit within 5 seconds after Kill"
    }
  } else {
    $process.WaitForExit()
  }
  $stdout = [string]$stdoutTask.Result
  $stderr = [string]$stderrTask.Result
  $code = if ($finished) { [int]$process.ExitCode } else { -1 }
  $process.Dispose()
  return [PSCustomObject]@{
    Code = $code
    Raw = ($stdout + "`n" + $stderr).Trim()
    TimedOut = (-not $finished)
  }
}

$python = [string]$env:WB_PYTHON
if (-not $python) {
  $python = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw "WB_PYTHON is missing; the smoke uses the same stdlib pipe client as packaging jobs"
}
$client = Join-Path $Root "workers\packaging\illustrator\illustrator_agent.py"
$agentScript = Join-Path $Root "scripts\windows\illustrator-agent.ps1"
$versionPath = Join-Path $Root "VERSION"
if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw "illustrator_agent.py not found" }
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) { throw "illustrator-agent.ps1 not found" }

$expectedRelease = ([System.IO.File]::ReadAllText($versionPath)).Trim()
$expectedScriptSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $agentScript).Hash.ToLowerInvariant()
$expectedBuild = [string](& git -C $Root rev-parse HEAD 2>$null | Select-Object -First 1)
$expectedBuild = $expectedBuild.Trim()
if ($LASTEXITCODE -ne 0 -or -not $expectedBuild) { throw "Illustrator smoke cannot resolve checkout identity" }

Wait-IllustratorSlotIdle
$selectedHeartbeat = "illustrator-agent.json"
Assert-SelectedAgentIdle $selectedHeartbeat
$clientResult = Invoke-AgentClient $python $client $PipeName $selectedHeartbeat
if ($clientResult.TimedOut) { throw "Illustrator desktop agent smoke timed out" }
$raw = $clientResult.Raw
$last = @($raw -split "`r?`n" | Where-Object { $_ })[-1]
try { $result = $last | ConvertFrom-Json } catch { throw "Illustrator agent smoke returned invalid JSON" }
if ($clientResult.Code -ne 0 -or -not $result.ok) {
  throw "Illustrator desktop agent smoke failed code=$($result.code) message=$($result.message)"
}
if (
  $result.sentinel -ne "runner-ok" -or
  [int]$result.session_id -le 0 -or
  [string]$result.agent_root -ne $Root -or
  [string]$result.script_sha256 -ne $expectedScriptSha -or
  [string]$result.release_version -ne $expectedRelease -or
  [string]$result.build_identity -ne $expectedBuild
) {
  throw "Illustrator desktop agent smoke returned an identity-mismatched Session 1 contract"
}
Write-Host "WINDOWS_ILLUSTRATOR_JSX_SMOKE ok version=$($result.illustrator_version) session=$($result.session_id) build=$expectedBuild"
