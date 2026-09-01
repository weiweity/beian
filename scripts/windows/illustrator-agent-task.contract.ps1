# Windows PowerShell 5.1 contract for the InteractiveToken Illustrator agent task.
# Does not register, start, stop, or disable any production task.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$installerPath = Join-Path $PSScriptRoot "install-illustrator-agent.ps1"
$releasePath = Join-Path $PSScriptRoot "release.ps1"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "install-illustrator-agent.ps1 not found"
}
if (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
  throw "release.ps1 not found"
}

$installer = [System.IO.File]::ReadAllText($installerPath)
$release = [System.IO.File]::ReadAllText($releasePath)

function Assert-SourceContains([string]$Source, [string]$Needle, [string]$Label) {
  if ($Source.IndexOf($Needle) -lt 0) {
    throw ("missing " + $Label)
  }
}

Assert-SourceContains $installer '"-NonInteractive"' "NonInteractive engine flag"
Assert-SourceContains $installer '"-WindowStyle", "Hidden"' "hidden PowerShell window"
Assert-SourceContains $installer "New-ScheduledTaskSettingsSet @settingsArguments -Hidden" "hidden scheduled task"
Assert-SourceContains $installer 'MultipleInstances = "IgnoreNew"' "IgnoreNew instance policy"
Assert-SourceContains $installer "Disable-ScheduledTask -TaskName `$Name -ErrorAction Stop" "maintenance disable"
Assert-SourceContains $installer "New-ScheduledTaskTrigger -AtLogOn -User `$InteractiveUser" "AtLogOn trigger"
Assert-SourceContains $installer "-RepetitionInterval (New-TimeSpan -Minutes 1)" "keep-alive interval"
Assert-SourceContains $installer "[DateTime]::MinValue" "persistent-task keep-alive guard"

$nonInteractiveAt = $installer.IndexOf('"-NonInteractive"')
$windowStyleAt = $installer.IndexOf('"-WindowStyle", "Hidden"')
$fileAt = $installer.IndexOf('"-File"')
if ($nonInteractiveAt -lt 0 -or $windowStyleAt -lt 0 -or $fileAt -le $nonInteractiveAt -or $fileAt -le $windowStyleAt) {
  throw "-NonInteractive and -WindowStyle Hidden must precede -File"
}

$disableAt = $installer.IndexOf("Disable-ScheduledTask -TaskName `$Name -ErrorAction Stop")
$stopAt = $installer.IndexOf("Stop-ScheduledTask -TaskName `$Name -ErrorAction Stop")
if ($disableAt -lt 0 -or $stopAt -le $disableAt) {
  throw "Stop-AgentTaskAndWait must Disable the task before Stop"
}

$keepAliveGuardAt = $installer.IndexOf("Temporary L1 tasks keep AtLogOn only")
$keepAliveTriggerAt = $installer.IndexOf("-RepetitionInterval (New-TimeSpan -Minutes 1)")
$expiresBranchAt = $installer.IndexOf("if (`$ExpiresAt -ne [DateTime]::MinValue)")
if ($keepAliveGuardAt -lt 0 -or $keepAliveTriggerAt -lt 0 -or $expiresBranchAt -lt 0) {
  throw "persistent keep-alive trigger is missing"
}
if ($keepAliveTriggerAt -le $expiresBranchAt) {
  throw "keep-alive trigger must stay in the persistent-task else branch"
}

$releaseDisableAt = $release.IndexOf("Disable-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue")
$releaseStopAt = $release.IndexOf("Stop-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue")
if ($releaseDisableAt -lt 0 -or $releaseStopAt -le $releaseDisableAt) {
  throw "release fallback must Disable the Illustrator agent task before Stop"
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 60 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Hidden
if (-not $settings.Hidden) {
  throw "PowerShell 5.1 did not apply -Hidden to the task settings"
}
if ([string]$settings.MultipleInstances -ne "IgnoreNew") {
  throw "PowerShell 5.1 did not keep IgnoreNew"
}

$keepAlive = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
$interval = [string]$keepAlive.Repetition.Interval
if ($interval -ne "PT1M") {
  throw ("keep-alive repetition interval is " + $interval + ", expected PT1M")
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\beian-contract-dummy.ps1"
$arguments = [string]$action.Arguments
if ($arguments -notmatch "-NonInteractive") {
  throw "task action dropped -NonInteractive"
}
if ($arguments -notmatch "-WindowStyle Hidden") {
  throw "task action dropped -WindowStyle Hidden"
}
$fileArgumentAt = $arguments.IndexOf("-File")
$hiddenArgumentAt = $arguments.IndexOf("-WindowStyle Hidden")
$nonInteractiveArgumentAt = $arguments.IndexOf("-NonInteractive")
if (
  $fileArgumentAt -lt 0 -or
  $hiddenArgumentAt -lt 0 -or
  $nonInteractiveArgumentAt -lt 0 -or
  $fileArgumentAt -le $hiddenArgumentAt -or
  $fileArgumentAt -le $nonInteractiveArgumentAt
) {
  throw "hidden window flags must precede -File in the live task action"
}

Write-Host "ILLUSTRATOR_AGENT_TASK_CONTRACT ok"
