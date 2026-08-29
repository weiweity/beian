param(
  [string]$Root = "",
  [string]$DataRoot = "",
  [string]$PipeName = "beian-illustrator-v1",
  [string]$HeartbeatName = "illustrator-agent.json",
  [string]$TaskName = "beian-illustrator-agent",
  [string]$InteractiveUser = "",
  [DateTime]$ExpiresAt = [DateTime]::MinValue,
  [switch]$ClearFaultFence,
  [switch]$Uninstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

if (-not $DataRoot) {
  $DataRoot = if ($env:WB_DATA_DIR) { $env:WB_DATA_DIR } else { "C:\supply\data" }
}
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
if (-not $HeartbeatName -or [System.IO.Path]::GetFileName($HeartbeatName) -ne $HeartbeatName) {
  throw "Illustrator agent heartbeat name is invalid"
}
if ($ClearFaultFence -and $Uninstall) {
  throw "ClearFaultFence and Uninstall cannot be used together"
}

function Get-AgentHeartbeatPid([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  try { return [int]((Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json).pid) } catch { return 0 }
}

function Stop-AgentTaskAndWait([string]$Name, [string]$HeartbeatPath) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  $heartbeatPid = Get-AgentHeartbeatPid $HeartbeatPath
  if ($task -and $task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $Name -ErrorAction Stop
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $state = (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue).State
    $processAlive = $heartbeatPid -gt 0 -and [bool](Get-Process -Id $heartbeatPid -ErrorAction SilentlyContinue)
    if ($state -ne "Running" -and -not $processAlive) { return $heartbeatPid }
    Start-Sleep -Milliseconds 250
  }
  $finalState = (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue).State
  $finalProcess = $heartbeatPid -gt 0 -and [bool](Get-Process -Id $heartbeatPid -ErrorAction SilentlyContinue)
  if ($finalState -eq "Running" -or $finalProcess) {
    throw "Illustrator agent task or process did not stop"
  }
  return $heartbeatPid
}

function Assert-FaultClearAuthority {
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ([int]$process.SessionId -le 0 -or [string]$identity.User.Value -eq "S-1-5-18") {
    throw "Illustrator fault fence must be cleared by an interactive administrator"
  }
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Illustrator fault fence requires an elevated local administrator"
  }
}

function Assert-FaultClearWorkspaceIdle([string]$RuntimePath) {
  $runningTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -like "beian-illustrator-agent*" -and $_.State -eq "Running"
  })
  if ($runningTasks.Count -gt 0) {
    throw "Another Illustrator agent task is still running"
  }
  foreach ($stateFile in @(Get-ChildItem -LiteralPath $RuntimePath -Filter "illustrator-agent*.json" -File -ErrorAction SilentlyContinue)) {
    $heartbeatPid = Get-AgentHeartbeatPid $stateFile.FullName
    if ($heartbeatPid -gt 0 -and (Get-Process -Id $heartbeatPid -ErrorAction SilentlyContinue)) {
      throw "Another Illustrator agent process is still running"
    }
  }
  $desktopProcesses = @(Get-Process -Name "Illustrator", "AIRobin", "cscript", "wscript" -ErrorAction SilentlyContinue)
  if ($desktopProcesses.Count -gt 0) {
    throw "Illustrator/cscript recovery is not empty; close or verify those processes before clearing the fault fence"
  }
}

if ($Uninstall) {
  $heartbeat = Join-Path (Join-Path $DataRoot "runtime") $HeartbeatName
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-AgentTaskAndWait $TaskName $heartbeat | Out-Null
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  } else {
    $orphanPid = Get-AgentHeartbeatPid $heartbeat
    if ($orphanPid -gt 0 -and (Get-Process -Id $orphanPid -ErrorAction SilentlyContinue)) {
      throw "Illustrator agent heartbeat points to a live process without its scheduled task"
    }
  }
  Remove-Item $heartbeat -Force -ErrorAction SilentlyContinue
  Write-Host "ILLUSTRATOR_AGENT_TASK removed name=$TaskName"
  return
}

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$Root = [System.IO.Path]::GetFullPath($Root)
$agent = Join-Path $Root "scripts\windows\illustrator-agent.ps1"
if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) {
  throw "illustrator-agent.ps1 not found"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$activeUser = ""
try { $activeUser = [string](Get-CimInstance Win32_ComputerSystem).UserName } catch { }
if (-not $InteractiveUser) { $InteractiveUser = [string]$env:WB_ILLUSTRATOR_INTERACTIVE_USER }
if (-not $InteractiveUser -and $existing) {
  $InteractiveUser = [string]$existing.Principal.UserId
}
if (-not $InteractiveUser -and $activeUser) { $InteractiveUser = $activeUser }
if (-not $InteractiveUser) {
  throw "Illustrator agent requires an explicit or previously registered interactive administrator"
}

function Resolve-AccountSid([string]$Account) {
  try {
    if ($Account -match '^S-\d(?:-\d+)+$') {
      return [System.Security.Principal.SecurityIdentifier]::new($Account)
    }
    return ([System.Security.Principal.NTAccount]::new($Account)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    )
  } catch {
    throw "Illustrator agent interactive account does not exist"
  }
}

function Assert-LocalAdministrator([System.Security.Principal.SecurityIdentifier]$Sid) {
  try {
    $adminSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    $memberSids = @(Get-LocalGroupMember -SID $adminSid -ErrorAction Stop | ForEach-Object {
      if ($_.SID) { [string]$_.SID.Value }
    })
  } catch {
    throw "Cannot verify the Illustrator agent account against local Administrators"
  }
  if ($memberSids -notcontains [string]$Sid.Value) {
    throw "Illustrator agent interactive account is not a local administrator"
  }
}

function Set-AgentRuntimeAcl(
  [string]$Path,
  [System.Security.Principal.SecurityIdentifier]$InteractiveSid
) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sid in @(
    $InteractiveSid,
    [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  )) {
    $security.AddAccessRule(
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        $rights,
        $inheritance,
        $propagation,
        $allow
      )
    )
  }
  [System.IO.Directory]::SetAccessControl($Path, $security)
}

$interactiveSid = Resolve-AccountSid $InteractiveUser
Assert-LocalAdministrator $interactiveSid
$runtimeDir = Join-Path $DataRoot "runtime"
Set-AgentRuntimeAcl $runtimeDir $interactiveSid
$heartbeat = Join-Path $runtimeDir $HeartbeatName
$oldPid = Get-AgentHeartbeatPid $heartbeat
$releaseVersionPath = Join-Path $Root "VERSION"
if (-not (Test-Path -LiteralPath $releaseVersionPath -PathType Leaf)) {
  throw "VERSION not found for Illustrator agent"
}
$releaseVersion = ([System.IO.File]::ReadAllText($releaseVersionPath)).Trim()
$scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $agent).Hash.ToLowerInvariant()
$buildIdentity = [string](& git -C $Root rev-parse HEAD 2>$null | Select-Object -First 1)
$buildIdentity = $buildIdentity.Trim()
if ($LASTEXITCODE -ne 0 -or -not $buildIdentity) {
  throw "Cannot resolve checkout identity for Illustrator agent"
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", (Quote-TaskArgument $agent),
  "-Root", (Quote-TaskArgument $Root),
  "-DataRoot", (Quote-TaskArgument $DataRoot),
  "-PipeName", (Quote-TaskArgument $PipeName),
  "-HeartbeatName", (Quote-TaskArgument $HeartbeatName),
  "-ExpectedUserSid", (Quote-TaskArgument ([string]$interactiveSid.Value)),
  "-ReleaseVersion", (Quote-TaskArgument $releaseVersion),
  "-BuildIdentity", (Quote-TaskArgument $buildIdentity)
)
if ($ExpiresAt -ne [DateTime]::MinValue) {
  $arguments += @("-ExpiresAtUtc", (Quote-TaskArgument $ExpiresAt.ToUniversalTime().ToString("o")))
}
$arguments = $arguments -join " "

if ($ClearFaultFence) { Assert-FaultClearAuthority }
if ($existing) {
  Stop-AgentTaskAndWait $TaskName $heartbeat | Out-Null
}
Remove-Item $heartbeat -Force -ErrorAction SilentlyContinue
if ($ClearFaultFence) {
  Assert-FaultClearWorkspaceIdle $runtimeDir
  $faultFence = Join-Path $runtimeDir "illustrator-fault.json"
  Remove-Item -LiteralPath $faultFence -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $faultFence) {
    throw "Illustrator fault fence could not be cleared"
  }
  Write-Host "ILLUSTRATOR_AGENT_FAULT cleared after interactive administrator confirmation"
}

$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $InteractiveUser
if ($ExpiresAt -ne [DateTime]::MinValue) {
  if ($ExpiresAt -le (Get-Date)) { throw "Illustrator agent task expiry must be in the future" }
  # Task Scheduler removes abandoned L1 bootstrap tasks even when Actions is
  # cancelled or the machine loses power before the smoke script's finally block.
  $trigger.EndBoundary = $ExpiresAt.ToString("yyyy-MM-ddTHH:mm:ss")
}
# ScheduledTasks calls this Interactive; Task Scheduler persists it as InteractiveToken.
$principal = New-ScheduledTaskPrincipal -UserId $InteractiveUser -LogonType Interactive -RunLevel Highest
$settingsArguments = @{
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
  StartWhenAvailable = $true
  ExecutionTimeLimit = [TimeSpan]::Zero
  MultipleInstances = "IgnoreNew"
  RestartCount = 3
  RestartInterval = (New-TimeSpan -Minutes 1)
}
if ($ExpiresAt -ne [DateTime]::MinValue) {
  # EndBoundary only prevents future triggers. The agent receives the same
  # absolute deadline and exits itself while idle; this finite scheduler limit
  # is the backstop for a wedged process. Deletion happens after both windows.
  $temporaryLimit = ($ExpiresAt - (Get-Date)).Add((New-TimeSpan -Minutes 5))
  if ($temporaryLimit -lt (New-TimeSpan -Minutes 1)) {
    $temporaryLimit = New-TimeSpan -Minutes 1
  }
  $settingsArguments.ExecutionTimeLimit = $temporaryLimit
  $settingsArguments.DeleteExpiredTaskAfter = New-TimeSpan -Minutes 10
}
$settings = New-ScheduledTaskSettingsSet @settingsArguments

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Beian Session 1 Illustrator named-pipe agent" `
  -Force | Out-Null

$started = $false
$activeSid = $null
if ($activeUser) {
  try { $activeSid = Resolve-AccountSid $activeUser } catch { $activeSid = $null }
}
if ($activeSid -and $activeSid.Value -eq $interactiveSid.Value) {
  Start-ScheduledTask -TaskName $TaskName
  $started = $true
}
if ($started) {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Path -LiteralPath $heartbeat -PathType Leaf) {
      try {
        $state = Get-Content -Raw -LiteralPath $heartbeat | ConvertFrom-Json
        $ready = (
          [string]$state.user_sid -eq [string]$interactiveSid.Value -and
          [string]$state.script_sha256 -eq $scriptSha256 -and
          [string]$state.release_version -eq $releaseVersion -and
          [string]$state.build_identity -eq $buildIdentity -and
          [string]$state.pipe -eq $PipeName -and
          [string]$state.root -eq $Root -and
          [int]$state.pid -gt 0 -and
          [int]$state.pid -ne $oldPid
        )
      } catch { $ready = $false }
    }
    if ($ready) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) {
    throw "New Illustrator agent heartbeat did not match this checkout"
  }
}
Write-Host "ILLUSTRATOR_AGENT_TASK installed name=$TaskName user=$InteractiveUser logon_type=InteractiveToken started=$started"
