# Hangzhou production CD. Run from any cwd.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1 -Restart
# Does not touch cloudflared. Does not kill random node.exe (Grok Build uses Node).
# -Restart only stops whoever is LISTENING on 8787.
# Do not assign the automatic PID variable; it is this script, not the Node listener.

param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

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

function Get-SlotRunning($HealthObj, [string]$Name) {
  if ($HealthObj -and $HealthObj.jobs -and $HealthObj.jobs.$Name) {
    return [int]$HealthObj.jobs.$Name.running
  }
  return 0
}

function Get-ListenerPid([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { return $null }
  return ($conns | Select-Object -First 1).OwningProcess
}

$health = Get-Health
if ($health) {
  $ocr = Get-SlotRunning $health "ocr"
  $blender = Get-SlotRunning $health "blender"
  $illustrator = Get-SlotRunning $health "illustrator"
  if ($ocr -gt 0 -or $blender -gt 0 -or $illustrator -gt 0) {
    throw "对照或打样在跑，禁止升版。ocr.running=$ocr blender.running=$blender illustrator.running=$illustrator"
  }
  Write-Host "preflight health ok version=$($health.version) ocr.running=$ocr blender.running=$blender illustrator.running=$illustrator"
} else {
  Write-Host "preflight: :8787 没响应，当作空闲继续 pull"
}

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

if ($Restart) {
  $health = Get-Health
  $ocr = Get-SlotRunning $health "ocr"
  $blender = Get-SlotRunning $health "blender"
  $illustrator = Get-SlotRunning $health "illustrator"
  if ($ocr -gt 0 -or $blender -gt 0 -or $illustrator -gt 0) {
    throw "编完后对照或打样已在跑，禁止重启。ocr.running=$ocr blender.running=$blender illustrator.running=$illustrator"
  }
  $pid8787 = Get-ListenerPid 8787
  if (-not $pid8787) {
    if ($health) {
      throw "health 还在但找不到 8787 监听进程，拒绝盲杀 node.exe。请手动停占用 8787 的 Node 后再加 -Restart"
    }
  } else {
    Write-Host "stop :8787 pid=$pid8787"
    Stop-Process -Id $pid8787 -ErrorAction SilentlyContinue
    $freed = $false
    for ($w = 0; $w -lt 10; $w++) {
      Start-Sleep -Seconds 1
      if (-not (Get-ListenerPid 8787)) { $freed = $true; break }
    }
    if (-not $freed) { throw "停掉 pid=$pid8787 后 8787 仍被占用，拒绝再起一个 Node" }
  }
  if (-not $env:WB_DATA_DIR) { $env:WB_DATA_DIR = "C:\supply\data" }
  $env:WB_PUBLIC = "1"
  $env:WB_DEV_DISPLAY_LOGIN = "false"
  if ($env:WB_DATA_DIR.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "WB_PUBLIC=1 时 WB_DATA_DIR 不能在仓库内，当前=$($env:WB_DATA_DIR)"
  }
  Write-Host "start beian-server WB_DATA_DIR=$($env:WB_DATA_DIR)"
  Start-Process -FilePath "npm.cmd" -ArgumentList "run","start","-w","beian-server" -WorkingDirectory $Root -WindowStyle Normal
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $health = Get-Health
    if ($health -and $health.ok) { $ok = $true; break }
  }
  if (-not $ok) { throw "重启后 :8787 /api/health 没起来" }
}

$health = Get-Health
if (-not $health) { throw "本机 :8787 无 health。若没加 -Restart，请停掉旧 Node 再 npm run start -w beian-server" }
if ($health.version -ne $ver) {
  Write-Host "警告: health.version=$($health.version) 但 VERSION=$ver。没加 -Restart 时这是预期的，请停旧 Node 再启动"
}
$logo = Invoke-WebRequest -Uri "http://127.0.0.1:8787/brand/logo-mark.png" -TimeoutSec 10 -UseBasicParsing
if ($logo.StatusCode -ne 200) { throw "logo HTTP $($logo.StatusCode)" }
Write-Host "SMOKE ok version=$($health.version) sha=$sha logo=$($logo.StatusCode) bytes=$($logo.RawContentLength)"
Write-Host "不要动 cloudflared。Mac 不要 run beian。"
Write-Host "公网核对: curl https://www.jianghua.site/api/health  （version 应等于本机）"
