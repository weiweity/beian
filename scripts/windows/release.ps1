# Hangzhou production CD. Git hygiene while :8787 is up; refuse to stop if dirty/ahead; otherwise stop, then merge/build/start.
# Encoding: UTF-8 with BOM so Windows PowerShell 5 (GBK) can parse this file.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
# -Restart is accepted and ignored: live pull-while-serving is gone (emptyOutDir 404).
# Does not touch cloudflared. Does not kill all node.exe (Grok Build uses Node).
# Kills only the LISTENING 8787 process tree via taskkill /T /F /PID.
# Discard npm-dirty package-lock.json and refuse other tracked edits BEFORE stopping.
# If merge/build/start fails: git reset --hard to the pre-stop SHA, npm ci/build if the tree was wiped, then Restart-Service beian-server-8787.

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
# Use $args (not an advanced function) so PS5 does not eat --ff-only as a named parameter.
function Invoke-Git {
  $GitArgs = @($args)
  if ($env:GITHUB_TOKEN) {
    & git -c "http.extraheader=AUTHORIZATION: bearer $($env:GITHUB_TOKEN)" @GitArgs
  } else {
    & git @GitArgs
  }
}

function Clear-GithubToken {
  if ($env:GITHUB_TOKEN) {
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  }
}

# Windows 上 packed-refs 和零散 origin/main 拧在一起时：
# cannot lock ref 'refs/remotes/origin/main': is at A but expected B
# 只在这一条 ref 锁上才删指针。网络/401/Clash 失败不要动 origin/main。
# git fetch 把 "From https://..." 写在 stderr。PS5 + Stop 会打成 NativeCommandError，
# 即使 exit 0 也在停 8787 之前抛（0.12.17.0 hangzhou-release 8s 红）。只看 LASTEXITCODE。
function Invoke-GitFetch {
  param([string]$LogPath = "")
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($LogPath) {
      if ($env:GITHUB_TOKEN) {
        & git -c "http.extraheader=AUTHORIZATION: bearer $($env:GITHUB_TOKEN)" fetch origin *> $LogPath
      } else {
        & git fetch origin *> $LogPath
      }
    } else {
      if ($env:GITHUB_TOKEN) {
        & git -c "http.extraheader=AUTHORIZATION: bearer $($env:GITHUB_TOKEN)" fetch origin
      } else {
        & git fetch origin
      }
    }
  } catch {
    # NativeCommandError from git stderr — LASTEXITCODE is the real result
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $code = $LASTEXITCODE
  if ($null -eq $code) { return 1 }
  return [int]$code
}

function Fetch-OriginMain {
  $log = Join-Path $env:TEMP "beian-git-fetch.log"
  if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
  try {
    $code = Invoke-GitFetch -LogPath $log
    if ($code -eq 0) { return }
    $msg = ""
    foreach ($enc in @("Unicode", "UTF8", "Default")) {
      try {
        $t = Get-Content $log -Raw -Encoding $enc -ErrorAction Stop
      } catch {
        continue
      }
      if ($t -match "cannot lock ref 'refs/remotes/origin/main'") {
        $msg = $t
        break
      }
      if (-not $msg -and $t) { $msg = $t }
    }
    if ($msg -match "cannot lock ref 'refs/remotes/origin/main'") {
      Write-Host "origin/main ref 拧了，删掉再 fetch"
      git update-ref -d refs/remotes/origin/main
      $code = Invoke-GitFetch
      if ($code -eq 0) { return }
    }
    Write-Host "git fetch origin 失败"
    $global:LASTEXITCODE = $code
  } finally {
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
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

function Get-RecentIncomingUploadCount {
  $root = Join-Path $env:WB_DATA_DIR "uploads\receipts"
  if (-not (Test-Path $root)) { return 0 }
  $cutoff = [DateTime]::UtcNow.AddMinutes(-18)
  $dirs = Get-ChildItem -Path $root -Directory -Filter ".incoming-*" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -ge $cutoff }
  return @($dirs).Count
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
  if ($HealthObj.uploads) {
    $activeUploads = [int]$HealthObj.uploads.active
    $waitingUploads = [int]$HealthObj.uploads.waiting
    if ($activeUploads -gt 0 -or $waitingUploads -gt 0) {
      throw "$When : 上传仍在进行。uploads active=$activeUploads waiting=$waitingUploads"
    }
    return
  }

  # 首次部署本闸门时，旧 0.13.x health 还没有 uploads 字段。只允许它通过
  # 最近 incoming 目录的兼容检查；0.14+ 缺字段一律失败，避免永久静默降级。
  try { $healthVersion = [version]([string]$HealthObj.version) } catch {
    throw "$When : health.version 无法解析且缺少 uploads，拒绝升版"
  }
  if ($healthVersion -ge [version]"0.14.0.0") {
    throw "$When : health 缺少 uploads，拒绝升版"
  }
  $legacyUploads = Get-RecentIncomingUploadCount
  if ($legacyUploads -gt 0) {
    throw "$When : 旧版本检测到 $legacyUploads 个正在落盘的上传，拒绝升版"
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

function Start-BeianWinSwService {
  $name = "beian-server-8787"
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) {
    throw "找不到 Windows 服务 $name（WinSW）。拒绝用 schtasks ONLOGON 兜底。"
  }
  try {
    Restart-Service -Name $name -Force -ErrorAction Stop
  } catch {
    Start-Service -Name $name -ErrorAction Stop
  }
}

function Restore-BeianListener([string]$Why) {
  if (Test-PortListening 8787) {
    Write-Host "$Why : :8787 仍在听，不重复拉起"
    return
  }
  Write-Host "$Why : :8787 没听，Restart-Service beian-server-8787"
  try {
    Start-BeianWinSwService
  } catch {
    Write-Host "拉回失败 Restart-Service $($_.Exception.Message)。公网可能 502。不要动 cloudflared。"
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

# CD rollback of THIS upgrade only (the SHA we captured before taskkill).
# Not an operator git reset --hard of unknown local dirt.
function Restore-BeianUpgrade([string]$Why, [string]$PreSha, [bool]$DidCi, [bool]$DidBuild) {
  if ($PreSha) {
    $now = (git rev-parse HEAD).Trim()
    if ($now -ne $PreSha) {
      Write-Host "$Why : git reset --hard to pre-stop SHA (CD rollback of this upgrade only)"
      git reset --hard $PreSha
      if ($LASTEXITCODE -ne 0) {
        Write-Host "git reset --hard 回停机前 SHA 失败 exit=$LASTEXITCODE。公网可能 502。不要动 cloudflared。"
      }
    }
  }
  Clear-GithubToken
  $nm = Join-Path $Root "node_modules"
  if ($DidCi -or -not (Test-Path $nm)) {
    Write-Host "$Why : npm ci on restored tree"
    npm ci
    if ($LASTEXITCODE -ne 0) {
      Write-Host "restore npm ci 失败 exit=$LASTEXITCODE。公网可能 502。不要动 cloudflared。"
    }
  }
  $distIndex = Join-Path $Root "apps\web\ui\dist\index.html"
  if ($DidBuild -or -not (Test-Path $distIndex)) {
    Write-Host "$Why : rebuild UI on restored tree"
    npm run build -w beian-ui
    if ($LASTEXITCODE -ne 0) {
      Write-Host "restore UI build 失败 exit=$LASTEXITCODE。公网可能 502。不要动 cloudflared。"
    }
  }
  Restore-BeianListener $Why
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
# Actions may have copied this file from origin/main so this process is already
# the new script. Restore HEAD so porcelain can stop 8787; merge brings it back.
Write-Host "reset scripts/windows/release.ps1 to HEAD (Actions 预取的新脚本已在本进程)"
Invoke-Git checkout HEAD -- scripts/windows/release.ps1
Assert-GitOk "git checkout HEAD -- scripts/windows/release.ps1"
Fetch-OriginMain
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

$preSha = (git rev-parse HEAD).Trim()
Write-Host "pre-stop SHA=$preSha"
$didCi = $false
$didBuild = $false

# Stop the WinSW service first. taskkill of the grandchild alone looks like a crash
# and WinSW onfailure will respawn :8787 during merge/build.
Write-Host "Stop-Service beian-server-8787 so WinSW onfailure does not respawn"
$beianSvc = Get-Service -Name "beian-server-8787" -ErrorAction SilentlyContinue
if ($beianSvc) {
  Stop-Service -Name "beian-server-8787" -Force -ErrorAction SilentlyContinue
  $stopped = $false
  for ($w = 0; $w -lt 20; $w++) {
    Start-Sleep -Seconds 1
    $st = (Get-Service -Name "beian-server-8787" -ErrorAction SilentlyContinue).Status
    if ($st -eq "Stopped") { $stopped = $true; break }
  }
  if (-not $stopped) {
    Write-Host "Stop-Service 未在时限内 Stopped，继续清监听端口"
  }
}

$pid8787 = Get-ListenerPid 8787
if ($pid8787) {
  Write-Host "stop leftover :8787 tree pid=$pid8787 (taskkill /T /F /PID, not all node.exe)"
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
  Invoke-Git merge --ff-only origin/main
  Assert-GitOk "git merge --ff-only"
  $sha = (git rev-parse --short HEAD).Trim()
  $ver = (Get-Content -Raw VERSION).Trim()
  Write-Host "tree $sha VERSION=$ver"

  Clear-GithubToken
  git diff --quiet $preSha HEAD -- package-lock.json package.json apps/web/ui/package.json apps/web/server/package.json
  $lockChanged = ($LASTEXITCODE -ne 0)
  $needCi = $lockChanged -or -not (Test-Path (Join-Path $Root "node_modules"))
  if ($needCi) {
    $didCi = $true
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败 exit=$LASTEXITCODE" }
  } else {
    Write-Host "lockfile unchanged, skip npm ci"
  }

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

  $didBuild = $true
  npm run build -w beian-ui
  if ($LASTEXITCODE -ne 0) { throw "npm run build -w beian-ui 失败 exit=$LASTEXITCODE" }

  $py = $env:WB_PYTHON
  if (-not $py) {
    $py = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe"
  }
  $req = Join-Path $Root "apps\web\backend\requirements.txt"
  if (-not (Test-Path $py)) { throw "找不到 Python：$py。打样和对照共用这个解释器。" }
  if (-not (Test-Path $req)) { throw "找不到 $req" }
  Write-Host "pip install -r apps/web/backend/requirements.txt"
  & $py -m pip install -r $req --disable-pip-version-check
  if ($LASTEXITCODE -ne 0) { throw "pip install 失败 exit=$LASTEXITCODE" }

  Write-Host "start beian-server WB_DATA_DIR=$($env:WB_DATA_DIR)"
  # GitHub Actions kills the job process tree. Restart-Service beian-server-8787 is outside that tree.
  Start-BeianWinSwService
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
  Restore-BeianUpgrade "升版失败" $preSha $didCi $didBuild
  throw
}
