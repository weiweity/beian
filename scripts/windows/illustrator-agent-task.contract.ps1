# Windows PowerShell 5.1 contract for the InteractiveToken Illustrator agent task.
# Does not register, start, stop, or disable any production task.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$installerPath = Join-Path $PSScriptRoot "install-illustrator-agent.ps1"
$releasePath = Join-Path $PSScriptRoot "release.ps1"
$recoveryPath = Join-Path $PSScriptRoot "release-recover.ps1"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "install-illustrator-agent.ps1 not found"
}
if (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
  throw "release.ps1 not found"
}
if (-not (Test-Path -LiteralPath $recoveryPath -PathType Leaf)) {
  throw "release-recover.ps1 not found"
}

$installer = [System.IO.File]::ReadAllText($installerPath).Replace("`r`n", "`n")
$release = [System.IO.File]::ReadAllText($releasePath).Replace("`r`n", "`n")
$recovery = [System.IO.File]::ReadAllText($recoveryPath).Replace("`r`n", "`n")

function Assert-SourceContains([string]$Source, [string]$Needle, [string]$Label) {
  if ($Source.IndexOf($Needle) -lt 0) {
    throw ("missing " + $Label)
  }
}

function ConvertTo-WindowsPowerShell5Ast([string]$Source, [string]$Label) {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $Source,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if (@($parseErrors).Count -ne 0) {
    throw ($Label + " did not parse cleanly")
  }
  return $ast
}

$installerAst = ConvertTo-WindowsPowerShell5Ast $installer "installer"
$releaseAst = ConvertTo-WindowsPowerShell5Ast $release "release"
$recoveryAst = ConvertTo-WindowsPowerShell5Ast $recovery "recovery"

Assert-SourceContains $installer '"-NonInteractive"' "NonInteractive engine flag"
Assert-SourceContains $installer '"-WindowStyle", "Hidden"' "hidden PowerShell window"
Assert-SourceContains $installer "New-ScheduledTaskSettingsSet @settingsArguments -Hidden" "hidden scheduled task"
Assert-SourceContains $installer 'MultipleInstances = "IgnoreNew"' "IgnoreNew instance policy"
Assert-SourceContains $installer "Disable-ScheduledTask -TaskName `$Name -ErrorAction Stop" "maintenance disable"
Assert-SourceContains $installer "[switch]`$Quiesce" "quiesce lifecycle mode"
Assert-SourceContains $installer "New-ScheduledTaskTrigger -AtLogOn -User `$InteractiveUser" "AtLogOn trigger"
Assert-SourceContains $installer "`$taskTriggers = @(`$logonTrigger)" "trigger collection"
Assert-SourceContains $installer "-Trigger `$taskTriggers" "registered trigger collection"
Assert-SourceContains $installer "`$logonTrigger.EndBoundary" "temporary trigger expiry"
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

$triggerBranches = @($installerAst.FindAll({
  param($node)
  if ($node -isnot [System.Management.Automation.Language.IfStatementAst]) { return $false }
  $text = [string]$node.Extent.Text
  return [bool](
    $text.IndexOf('$logonTrigger.EndBoundary') -ge 0 -and
    $text.IndexOf('-RepetitionInterval (New-TimeSpan -Minutes 1)') -ge 0
  )
}, $true))
if ($triggerBranches.Count -ne 1) {
  throw "installer must have one explicit temporary/persistent trigger branch"
}
$triggerBranch = $triggerBranches[0]
if ($triggerBranch.Clauses.Count -ne 1 -or -not $triggerBranch.ElseClause) {
  throw "trigger branch must have one temporary clause and one persistent else"
}
$triggerCondition = [string]$triggerBranch.Clauses[0].Item1.Extent.Text
$temporaryTriggerBody = [string]$triggerBranch.Clauses[0].Item2.Extent.Text
$persistentTriggerBody = [string]$triggerBranch.ElseClause.Extent.Text
if ($triggerCondition.IndexOf('$ExpiresAt -ne [DateTime]::MinValue') -lt 0) {
  throw "temporary trigger branch must be selected by ExpiresAt"
}
if (
  $temporaryTriggerBody.IndexOf('$logonTrigger.EndBoundary') -lt 0 -or
  $temporaryTriggerBody.IndexOf('-RepetitionInterval') -ge 0
) {
  throw "temporary task must keep only its bounded AtLogOn trigger"
}
if (
  $persistentTriggerBody.IndexOf('-RepetitionInterval (New-TimeSpan -Minutes 1)') -lt 0 -or
  $persistentTriggerBody.IndexOf('$logonTrigger.EndBoundary') -ge 0
) {
  throw "persistent keep-alive trigger must stay in the ExpiresAt else branch"
}

$releaseDisableAt = $release.IndexOf("Disable-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue")
$releaseStopAt = $release.IndexOf("Stop-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue")
if ($releaseDisableAt -lt 0 -or $releaseStopAt -le $releaseDisableAt) {
  throw "release fallback must Disable the Illustrator agent task before Stop"
}

$releaseAgentMutatedAt = $release.IndexOf("`$ReleaseJournalState.agent_mutated = `$true")
$releaseQuiesceStageAt = $release.IndexOf('Set-ReleaseJournalStage "agent_quiesce"')
$releaseQuiesceAt = $release.IndexOf("-Quiesce", $releaseQuiesceStageAt)
$releaseArmGitAt = $release.IndexOf("`n  Arm-GitMergeTransaction`n")
if (
  $releaseAgentMutatedAt -lt 0 -or
  $releaseQuiesceStageAt -le $releaseAgentMutatedAt -or
  $releaseQuiesceAt -le $releaseQuiesceStageAt -or
  $releaseArmGitAt -le $releaseQuiesceAt
) {
  throw "release must persist Agent ownership and quiesce it before arming Git"
}

$recoveryQuiesceAt = $recovery.IndexOf("-Quiesce")
$recoveryResetAt = $recovery.IndexOf('"reset", "--hard", $preSha')
if (
  $recoveryQuiesceAt -lt 0 -or
  $recoveryResetAt -le $recoveryQuiesceAt
) {
  throw "release recovery must quiesce the Agent before restoring the old tree"
}

$parseTokens = $null
$parseErrors = $null
$contractAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $PSCommandPath,
  [ref]$parseTokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "contract script did not parse cleanly"
}
$forbiddenTaskCommands = @(
  "Register-ScheduledTask",
  "Start-ScheduledTask",
  "Stop-ScheduledTask",
  "Disable-ScheduledTask",
  "Enable-ScheduledTask",
  "Unregister-ScheduledTask"
)
$mutatingTaskCalls = @($contractAst.FindAll({
  param($node)
  if ($node -isnot [System.Management.Automation.Language.CommandAst]) { return $false }
  $commandName = $node.GetCommandName()
  return [bool]($commandName -and $forbiddenTaskCommands -contains $commandName)
}, $true))
if ($mutatingTaskCalls.Count -ne 0) {
  throw "contract script must not mutate scheduled tasks"
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

$contractUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$persistentLogon = New-ScheduledTaskTrigger -AtLogOn -User $contractUser
$persistentTriggers = @($persistentLogon, $keepAlive)
if ($persistentTriggers.Count -ne 2) {
  throw "persistent task must have exactly two triggers"
}

$temporaryLogon = New-ScheduledTaskTrigger -AtLogOn -User $contractUser
$temporaryLogon.EndBoundary = (Get-Date).AddMinutes(10).ToString("yyyy-MM-ddTHH:mm:ss")
$temporaryTriggers = @($temporaryLogon)
if ($temporaryTriggers.Count -ne 1 -or -not [string]$temporaryTriggers[0].EndBoundary) {
  throw "temporary task must have exactly one AtLogOn trigger"
}
$temporaryRepetition = $temporaryTriggers[0].Repetition
if ($temporaryRepetition -and [string]$temporaryRepetition.Interval) {
  throw "temporary task must not have a repetition interval"
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
