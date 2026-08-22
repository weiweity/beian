# Hangzhou production CD. Always stop :8787, then pull/build/start.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
# -Restart is accepted and ignored: live pull-while-serving is gone (emptyOutDir 404).
# Does not touch cloudflared. Does not kill all node.exe (Grok Build uses Node).
# Kills only the LISTENING 8787 process tree via taskkill /T /F /PID.

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

git fetch origin
Assert-GitOk "git fetch"
git checkout main
Assert-GitOk "git checkout main"
git pull --ff-only origin main
Assert-GitOk "git pull --ff-only"
$sha = (git rev-parse --short HEAD).Trim()
$ver = (Get-Content -Raw VERSION).Trim()
Write-Host "tree $sha VERSION=$ver"

npm install
if ($LASTEXITCODE -ne 0) { throw "npm install 失败 exit=$LASTEXITCODE" }
npm run build -w beian-ui
if ($LASTEXITCODE -ne 0) { throw "npm run build -w beian-ui 失败 exit=$LASTEXITCODE" }

Write-Host "start beian-server WB_DATA_DIR=$($env:WB_DATA_DIR)"
Start-Process -FilePath "npm.cmd" -ArgumentList "run","start","-w","beian-server" -WorkingDirectory $Root -WindowStyle Normal
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
