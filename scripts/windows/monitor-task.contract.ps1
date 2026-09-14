# Windows PowerShell 5.1 contract for the SYSTEM monitor task.
# Does not register, start, stop, or disable any production task.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$installerPath = Join-Path $PSScriptRoot "install-monitor.ps1"
$releasePath = Join-Path $PSScriptRoot "release.ps1"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "install-monitor.ps1 not found"
}

$installer = [System.IO.File]::ReadAllText($installerPath).Replace("`r`n", "`n")
$release = [System.IO.File]::ReadAllText($releasePath).Replace("`r`n", "`n")

function Assert-SourceContains([string]$Source, [string]$Needle, [string]$Label) {
  if ($Source.IndexOf($Needle) -lt 0) {
    throw ("missing " + $Label)
  }
}

function Assert-SourceOmits([string]$Source, [string]$Needle, [string]$Label) {
  if ($Source.IndexOf($Needle) -ge 0) {
    throw ("forbidden " + $Label)
  }
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  $installer,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "install-monitor.ps1 did not parse cleanly"
}

Assert-SourceContains $installer 'TaskName = "beian-monitor-local"' "fixed task name"
Assert-SourceContains $installer 'UserId "SYSTEM"' "SYSTEM principal"
Assert-SourceContains $installer "New-ScheduledTaskTrigger -AtStartup" "AtStartup trigger"
Assert-SourceContains $installer 'MultipleInstances = "IgnoreNew"' "IgnoreNew"
Assert-SourceContains $installer "scripts\monitoring\host.mjs" "host entry"
Assert-SourceContains $installer "monitor-identity.json" "out-of-tree identity"
Assert-SourceContains $installer "[switch]`$Uninstall" "uninstall"
Assert-SourceOmits $installer "Stop-Service" "must not stop Windows services"
Assert-SourceOmits $installer "beian-illustrator-agent" "must not name Illustrator agent task"
Assert-SourceOmits $installer "InteractiveToken" "must not use Illustrator logon token"

if ($release.IndexOf("install-monitor.ps1") -ge 0) {
  throw "release.ps1 must not auto-install the monitor task"
}

Write-Host "MONITOR_TASK_CONTRACT ok"
