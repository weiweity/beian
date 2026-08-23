# Hangzhou production CD. Git hygiene while :8787 is up; refuse to stop if dirty/ahead; otherwise stop, then pull/build/start.
# Encoding: UTF-8 with BOM so Windows PowerShell 5 (GBK) can parse this file.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
# -Restart is accepted and ignored: live pull-while-serving is gone (emptyOutDir 404).
# Does not touch cloudflared. Does not kill all node.exe (Grok Build uses Node).
# Kills only the LISTENING 8787 process tree via taskkill /T /F /PID.
# Discard npm-dirty package-lock.json and refuse other tracked edits BEFORE stopping.
# If pull/build/start fails and :8787 is down, schtasks /Run the last start task.

param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root
$env:NO_PROXY = "127.0.0.1,localhost"
if ($env:no_proxy) { $env:no_proxy = $env:NO_PROXY }

function Assert-GitOk([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What 失败 exit=$LASTEXITCODE" }
}

# Actions runner may not have Git Credential Manager. Never print GITHUB_TOKEN.
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  if ($env:GITHUB_TOKEN) {
    & git -c "http.extraheader=AUTHORIZATION: bearer $($env:GITHUB_TOKEN)" @GitArgs
  } else {
    & git @GitArgs
  }
}

function Get-Health {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
  } catch {
    return $null
  }
}

function Get-SlotCount($HealthObj, [string]$Name, [string]$Field) {
  if ($HealthObj -and $HealthObj.jobs -and $HealthObj.jobs.$Name) {
    return [int]$HealthObj.jobs.$Name.$Field
  }
  return 0
}

function Test-PortListening([int]$Port) {
  $raw = netstat -ano 2>$null
  if (-not $raw) { return $false }
  $pat = ":$Port\s+.+(LISTENING|侦听)"
  return [bool]($raw | Select-String -Pattern $pat)
}

function Get-ListenerPid([int]$Port) {
  $raw = netstat -ano 2>$null
  if (-not $raw) { return $null }
  $pat = ":$Port\s+.+(LISTENING|侦听)\s+(\d+)\s*$"
  foreach ($line in $raw) {
    $m = [regex]::Match([string]$line, $pat)
    if ($m.Success) {
      $n = [int]$m.Groups[2].Value
      if ($n -gt 0) { return $n }
    }
  }
  return $null
}

function Test-WorkerProcesses {
  $names = @("python", "pythonw", "python3", "blender", "illustrator")
  $hits = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $names -contains $_.ProcessName.ToLowerInvariant()
  }
  if ($hits) { return @($hits | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) }
  return @()
}

function Test-DataDirInsideRepo([string]$DataDir, [string]$RepoRoot) {
  $d = [System.IO.Path]::GetFullPath($DataDir).TrimEnd("\", "/")
  $r = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd("\", "/")
  if ([string]::Equals($d, $r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = $r + [IO.Path]::DirectorySeparatorChar
  return $d.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SlotsIdle($HealthObj, [string]$When) {
  if (-not $HealthObj) { throw "$When : health 为空，拒绝升版" }
  if (-not $HealthObj.jobs) { throw "$When : health 没有 jobs，拒绝升版" }
  foreach ($name in @("ocr", "blender", "illustrator")) {
    if (-not $HealthObj.jobs.$name) { throw "$When : health.jobs.$name 缺失，拒绝升版" }
    $running = Get-SlotCount $HealthObj $name "running"
    $queued = Get-SlotCount $HealthObj $name "queued"
    if ($running -gt 0 -or $queued -gt 0) {
      throw "$When : 对照或打样在跑或排队。$name running=$running queued=$queued"
    }
  }
}

function Assert-IdleOrThrow {
  $health = Get-Health
  if ($health) {
    Assert-SlotsIdle $health "preflight"
    Write-Host "preflight health ok version=$($health.version)"
    return
  }
  if (Test-PortListening 8787) {
    throw "preflight: :8787 在听但 /api/health 失败，拒绝当空闲。检查代理/Clash 后重试"
  }
  $workers = Test-WorkerProcesses
  if ($workers.Count -gt 0) {
    throw "preflight: :8787 没 health，但还有 worker $($workers -join ','). 拒绝升版"
  }
  Write-Host "preflight: :8787 没听且没有 python/blender/illustrator，当作空机继续"
}

function Restore-BeianListener([string]$Why) {
  if (Test-PortListening 8787) {
    Write-Host "$Why : :8787 仍在听，不重复拉起"
    return
  }
  Write-Host "$Why : :8787 没听，schtasks /Run beian-server-8787"
  cmd.exe /c "schtasks /Run /TN beian-server-8787" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "拉回失败 schtasks exit=$LASTEXITCODE。公网可能 502。不要动 cloudflared。"
    return
  }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $h = Get-Health
    if ($h -and $h.ok) {
      Write-Host "已拉回 :8787 version=$($h.version)"
      return
    }
  }
  Write-Host "拉回后 health 仍空。公网可能 502。不要动 cloudflared。"
}

if ($Restart) {
  Write-Host "-Restart 已隐含：脚本总是先停 8787 再 pull"
}

Assert-IdleOrThrow

if (-not $env:WB_DATA_DIR) { $env:WB_DATA_DIR = "C:\supply\data" }
$env:WB_PUBLIC = "1"
$env:WB_DEV_DISPLAY_LOGIN = "false"
if (Test-DataDirInsideRepo $env:WB_DATA_DIR $Root) {
  throw "WB_PUBLIC=1 时 WB_DATA_DIR 不能在仓库内，当前=$($env:WB_DATA_DIR)"
}

# Git hygiene while :8787 is still up. npm install used to dirty package-lock.json;
# pull then aborted after taskkill and left Cloudflare 502.
Invoke-Git fetch origin
Assert-GitOk "git fetch"
Write-Host "reset package-lock.json to HEAD (npm 不得把锁文件改脏带进 pull)"
Invoke-Git checkout -- package-lock.json
Assert-GitOk "git checkout -- package-lock.json"
Invoke-Git checkout main
Assert-GitOk "git checkout main"
$rawStatus = Invoke-Git status --porcelain --untracked-files=no
Assert-GitOk "git status"
$dirty = @($rawStatus | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() -ne "" })
if ($dirty.Count -gt 0) {
  throw "工作树有未提交改动，拒绝停 8787:`n$($dirty -join "`n")"
}
$ahead = (git rev-list --count origin/main..HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "git rev-list 失败 exit=$LASTEXITCODE" }
if ($ahead -ne "0") {
  throw "本地 main 比 origin/main 多 $ahead 个 commit，拒绝停 8787"
}

$pid8787 = Get-ListenerPid 8787
if ($pid8787) {
  Write-Host "stop :8787 tree pid=$pid8787 (taskkill /T /F /PID, not all node.exe)"
  & taskkill.exe /T /F /PID $pid8787 | Out-Null
  $freed = $false
  for ($w = 0; $w -lt 15; $w++) {
    Start-Sleep -Seconds 1
    if (-not (Test-PortListening 8787)) { $freed = $true; break }
  }
  if (-not $freed) { throw "停掉 pid=$pid8787 后 8787 仍在听，拒绝再起一个 Node" }
} else {
  if (Test-PortListening 8787) {
    throw "8787 在听但 PID 为 0 或解析失败，拒绝盲杀 node.exe"
  }
  Write-Host "no :8787 listener"
}

# Re-check workers after stop: drain window.
$health = Get-Health
if ($health) { Assert-SlotsIdle $health "after-stop" }

try {
  Invoke-Git pull --ff-only origin main
  Assert-GitOk "git pull --ff-only"
  $sha = (git rev-parse --short HEAD).Trim()
  $ver = (Get-Content -Raw VERSION).Trim()
  Write-Host "tree $sha VERSION=$ver"

  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci 失败 exit=$LASTEXITCODE" }

  # Mac lockfile does not drop the Windows Rollup native optional. Vite build needs it.
  $rollupWin = @(
    (Join-Path $Root "node_modules\@rollup\rollup-win32-x64-msvc"),
    (Join-Path $Root "apps\web\ui\node_modules\@rollup\rollup-win32-x64-msvc")
  ) | Where-Object { Test-Path $_ }
  if (-not $rollupWin) {
    Write-Host "install @rollup/rollup-win32-x64-msvc for Vite build"
    npm install -w beian-ui --no-save --no-package-lock "@rollup/rollup-win32-x64-msvc@4.62.4"
    if ($LASTEXITCODE -ne 0) { throw "Windows Rollup optional 安装失败 exit=$LASTEXITCODE" }
  }

  npm run build -w beian-ui
  if ($LASTEXITCODE -ne 0) { throw "npm run build -w beian-ui 失败 exit=$LASTEXITCODE" }

  Write-Host "start beian-server WB_DATA_DIR=$($env:WB_DATA_DIR)"
  # GitHub Actions kills the job process tree. schtasks /Run is outside that tree.
  $bat = Join-Path $env:TEMP "beian-start-prod.cmd"
  @(
    "@echo off",
    "cd /d `"$Root`"",
    "set WB_DATA_DIR=$($env:WB_DATA_DIR)",
    "set WB_PUBLIC=1",
    "set WB_DEV_DISPLAY_LOGIN=false"
  ) + $(if ($env:WB_PYTHON) { @("set WB_PYTHON=$($env:WB_PYTHON)") } else { @() }) + @(
    "call npm.cmd run start -w beian-server"
  ) | Set-Content -Path $bat -Encoding ASCII
  $task = "beian-server-8787"
  cmd.exe /c "schtasks /Create /TN $task /SC ONLOGON /RL LIMITED /TR `"$bat`" /F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks /Create $task 失败 exit=$LASTEXITCODE" }
  cmd.exe /c "schtasks /Run /TN $task" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks /Run $task 失败 exit=$LASTEXITCODE" }
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $health = Get-Health
    if ($health -and $health.ok) { $ok = $true; break }
  }
  if (-not $ok) { throw "重启后 :8787 /api/health 没起来" }
  if ($health.version -ne $ver) {
    throw "health.version=$($health.version) 但 VERSION=$ver，拒绝 SMOKE ok"
  }

  $logo = Invoke-WebRequest -Uri "http://127.0.0.1:8787/brand/logo-mark.png" -TimeoutSec 10 -UseBasicParsing
  if ($logo.StatusCode -ne 200) { throw "logo HTTP $($logo.StatusCode)" }
  $png = $null
  if ($logo.Content -is [byte[]]) {
    $png = $logo.Content
  } elseif ($logo.RawContentStream) {
    $ms = New-Object System.IO.MemoryStream
    $logo.RawContentStream.CopyTo($ms)
    $png = $ms.ToArray()
  }
  if (-not $png -or $png.Length -lt 8 -or $png[0] -ne 0x89 -or $png[1] -ne 0x50) {
    throw "logo 不是 PNG"
  }
  Write-Host "SMOKE ok version=$($health.version) sha=$sha logo=$($logo.StatusCode) bytes=$($png.Length)"
  Write-Host "不要动 cloudflared。Mac 不要 run beian。不要并行跑本脚本。"
  Write-Host "公网核对: curl https://www.jianghua.site/api/health  （version 应等于本机）"
} catch {
  Restore-BeianListener "升版失败"
  throw
}
