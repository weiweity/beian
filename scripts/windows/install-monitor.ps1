param(
  [string]$Root = "",
  [string]$DataRoot = "",
  [string]$TaskName = "beian-monitor-local",
  [string]$NodeExe = "",
  [string]$LoopbackUrl = "http://127.0.0.1:8787/api/health",
  [string]$PublicUrl = "https://www.jianghua.site/api/health",
  [switch]$Uninstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

if ($TaskName -ne "beian-monitor-local") {
  throw "monitor task name must stay beian-monitor-local"
}
if ($TaskName -match "illustrator") {
  throw "monitor installer must not touch Illustrator tasks"
}

if (-not $DataRoot) {
  $DataRoot = if ($env:WB_DATA_DIR) { $env:WB_DATA_DIR } else { "C:\supply\data" }
}
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Host "MONITOR_TASK removed name=$TaskName"
  return
}

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$Root = [System.IO.Path]::GetFullPath($Root)
$hostJs = Join-Path $Root "scripts\monitoring\host.mjs"
if (-not (Test-Path -LiteralPath $hostJs -PathType Leaf)) {
  throw "scripts/monitoring/host.mjs not found"
}

$identityPath = Join-Path $DataRoot "monitor-identity.json"
if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
  throw "monitor identity file is missing: $identityPath"
}

# PowerShell 5.1 Set-Content -Encoding utf8 writes a UTF-8 BOM. Node JSON.parse
# rejects that prefix, so the scheduled task exits 2 while this installer still
# succeeds (ConvertFrom-Json accepts BOM). Rewrite without a BOM.
function Get-FileTextWithoutBom([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    $enc = New-Object System.Text.UTF8Encoding $false
    return $enc.GetString($bytes, 3, $bytes.Length - 3)
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
    $enc = New-Object System.Text.UnicodeEncoding $false, $false
    return $enc.GetString($bytes, 2, $bytes.Length - 2)
  }
  $enc = New-Object System.Text.UTF8Encoding $false
  return $enc.GetString($bytes)
}

$identityText = Get-FileTextWithoutBom $identityPath
try {
  $null = $identityText | ConvertFrom-Json
} catch {
  throw "monitor identity is not valid JSON: $identityPath"
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($identityPath, $identityText, $utf8NoBom)

$stateDir = Join-Path (Join-Path $DataRoot "runtime") "monitor"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "node.exe not found on PATH" }
  $NodeExe = [string]$cmd.Source
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw "NodeExe is not a file"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$argumentList = @(
  $hostJs,
  "--state-dir", $stateDir,
  "--identity", $identityPath,
  "--loopback-url", $LoopbackUrl,
  "--public-url", $PublicUrl
)
$configPath = Join-Path $DataRoot "monitor-policy.json"
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $argumentList += @("--config", $configPath)
}

function Quote-Arg([string]$Value) {
  if ($Value -match '[\s"]') { return '"' + ($Value.Replace('"', '\"')) + '"' }
  return $Value
}

$argumentString = ($argumentList | ForEach-Object { Quote-Arg $_ }) -join " "
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument $argumentString
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$settings.Hidden = $true
$settings.MultipleInstances = "IgnoreNew"

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Beian local monitor for beian-server-8787 and cloudflared" `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "MONITOR_TASK registered name=$TaskName node=$NodeExe state=$stateDir"
Write-Host "MONITOR_TASK does not stop beian-server-8787 or cloudflared and does not change Illustrator"
