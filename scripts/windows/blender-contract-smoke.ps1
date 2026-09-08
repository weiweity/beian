param(
  [int]$TimeoutMs = 90000
)

$ErrorActionPreference = "Stop"
# RF-11 candidate budget: 90s is not a Hangzhou-frozen number.
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
  throw "RUNNER_TEMP is required; Blender contract smoke must not write customer or repo paths"
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = $env:WB_PYTHON
if (-not $Python) { throw "WB_PYTHON is missing; reuse the packaging Python, do not copy generation checks into PowerShell" }
$Smoke = Join-Path $Root "workers\packaging\tools\blender_contract_smoke.py"
if (-not (Test-Path -LiteralPath $Smoke -PathType Leaf)) {
  throw "blender_contract_smoke.py is missing"
}
$Blender = $env:WB_BLENDER
$argList = @($Smoke)
if ($Blender) { $argList += @("--blender", $Blender) }

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $Python
$startInfo.Arguments = ($argList | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
$startInfo.WorkingDirectory = $Root
$startInfo.Environment["RUNNER_TEMP"] = $env:RUNNER_TEMP
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $startInfo
[void]$proc.Start()
if (-not $proc.WaitForExit($TimeoutMs)) {
  try { $proc.Kill() } catch {}
  if (-not $proc.WaitForExit(5000)) {
    throw "Blender contract smoke timed out and could not be killed"
  }
  throw "Blender contract smoke timed out (candidate 90s budget, not Hangzhou-frozen)"
}
$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()
if ($stdout) { Write-Output $stdout.Trim() }
if ($proc.ExitCode -ne 0) {
  throw "Blender contract smoke failed exit=$($proc.ExitCode)"
}
Write-Output "WINDOWS_BLENDER_CONTRACT_SMOKE ok"
