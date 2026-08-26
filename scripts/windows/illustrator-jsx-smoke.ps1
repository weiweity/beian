param(
  [string]$IllustratorExecutable = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $env:WB_DATA_DIR) { $env:WB_DATA_DIR = "C:\supply\data" }

function Invoke-Cscript([string[]]$Arguments) {
  $cscript = Join-Path $env:SystemRoot "System32\cscript.exe"
  if (-not (Test-Path $cscript)) { throw "cscript.exe not found" }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $text = (& $cscript @Arguments 2>&1 | Out-String).Trim()
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [PSCustomObject]@{ Code = [int]$code; Text = [string]$text }
}

function Wait-IllustratorSlotIdle {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
      $running = [int]$health.jobs.illustrator.running
      $queued = [int]$health.jobs.illustrator.queued
      if ($running -eq 0 -and $queued -eq 0) { return }
    } catch {
      if ($attempt -ge 2) { throw "local health unavailable; refusing Illustrator smoke" }
    }
    Start-Sleep -Seconds 5
  }
  throw "Illustrator queue did not become idle before smoke timeout"
}

if (-not $IllustratorExecutable) {
  $settingsPath = Join-Path $env:WB_DATA_DIR "settings.json"
  if (-not (Test-Path $settingsPath)) { throw "settings.json not found" }
  $settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  $IllustratorExecutable = [string]$settings.ILLUSTRATOR_EXECUTABLE
}
if (-not $IllustratorExecutable -or -not (Test-Path $IllustratorExecutable)) {
  throw "ILLUSTRATOR_EXECUTABLE is missing or invalid"
}

$runner = Join-Path $Root "workers\packaging\illustrator\run_export.vbs"
if (-not (Test-Path $runner)) { throw "run_export.vbs not found" }
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$runDir = Join-Path $tempRoot ("beian-illustrator-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $runDir | Out-Null
$runtimeJsx = Join-Path $runDir "smoke.runtime.jsx"
$sentinel = Join-Path $runDir "jsx-result.txt"

try {
  Wait-IllustratorSlotIdle
  Start-Process -FilePath $IllustratorExecutable -WindowStyle Minimized | Out-Null

  $probe = $null
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $candidate = Invoke-Cscript @("//Nologo", $runner, "probe")
    if ($candidate.Code -eq 0 -and $candidate.Text -match "^([^\t]+)\t(\d+)$") {
      if ([int]$Matches[2] -ne 0) {
        throw "Illustrator has an open document; refusing smoke"
      }
      $probe = $candidate
      break
    }
    Start-Sleep -Seconds 2
  }
  if (-not $probe) { throw "Illustrator COM probe did not become ready" }

  $sentinelLiteral = ConvertTo-Json ([string]$sentinel) -Compress
  $jsx = "(function(){var target=new File($sentinelLiteral);target.encoding='UTF-8';if(!target.open('w')){throw new Error('sentinel open failed');}target.write(String(app.version));target.close();return 'ok';}());"
  Set-Content -Path $runtimeJsx -Value $jsx -Encoding UTF8
  $run = Invoke-Cscript @("//Nologo", $runner, "run", $runtimeJsx)
  if ($run.Code -ne 0) { throw "Illustrator JSX bridge failed: $($run.Text)" }
  if (-not (Test-Path $sentinel)) { throw "Illustrator JSX did not write sentinel" }
  $jsxVersion = (Get-Content -Raw -Path $sentinel).Trim()
  if (-not $jsxVersion) { throw "Illustrator JSX returned an empty version" }
  Write-Host "WINDOWS_ILLUSTRATOR_JSX_SMOKE ok version=$jsxVersion"
} finally {
  if (Test-Path $runDir) { Remove-Item -Path $runDir -Recurse -Force }
}
