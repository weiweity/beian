param(
  [int]$TimeoutMs = 90000,
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
# RF-11 candidate budget: 90s is not a Hangzhou-frozen number.
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
  throw "RUNNER_TEMP is required; Blender contract smoke must not write customer or repo paths"
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Python) { $Python = [string]$env:WB_PYTHON }
if (-not $Python) {
  $Python = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw "WB_PYTHON is missing; reuse the packaging Python, do not copy generation checks into PowerShell"
}
$Smoke = Join-Path $Root "workers\packaging\tools\blender_contract_smoke.py"
if (-not (Test-Path -LiteralPath $Smoke -PathType Leaf)) {
  throw "blender_contract_smoke.py is missing"
}
$Blender = $env:WB_BLENDER
if (-not $Blender) { $Blender = $env:BLENDER_EXECUTABLE }
$argList = @($Smoke)
if ($Blender) { $argList += @("--blender", $Blender) }

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Stop-SmokeProcessTree([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  $pidValue = $Process.Id
  try {
    & taskkill.exe /PID $pidValue /T /F | Out-Null
  } catch {}
  try { $Process.Kill() } catch {}
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $Python
$startInfo.Arguments = ($argList | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
$startInfo.WorkingDirectory = $Root
$startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$startInfo.EnvironmentVariables["RUNNER_TEMP"] = $env:RUNNER_TEMP
$startInfo.EnvironmentVariables["PYTHONUTF8"] = "1"
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $startInfo
if (-not $proc.Start()) { throw "Blender contract smoke did not start" }
$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()
if (-not $proc.WaitForExit($TimeoutMs)) {
  Stop-SmokeProcessTree $proc
  if (-not $proc.WaitForExit(5000)) {
    throw "Blender contract smoke timed out and could not be killed"
  }
  throw "Blender contract smoke timed out (candidate 90s budget, not Hangzhou-frozen)"
} else {
  $proc.WaitForExit()
}
$stdout = [string]$stdoutTask.Result
$stderr = [string]$stderrTask.Result
if ($stdout) { Write-Output $stdout.Trim() }
if ($stderr) { Write-Host $stderr.Trim() }
$code = [int]$proc.ExitCode
$proc.Dispose()
if ($code -ne 0) {
  throw "Blender contract smoke failed exit=$code"
}
Write-Output "WINDOWS_BLENDER_CONTRACT_SMOKE ok"
