import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/windows/release.ps1");
const scriptBytes = readFileSync(scriptPath);
const script = scriptBytes.toString("utf8").replace(/^\uFEFF/, "");

function indexOf(re: RegExp): number {
  const m = re.exec(script);
  assert.ok(m, `missing ${re}`);
  return m.index;
}

describe("windows release.ps1 contract", () => {
  it("is Hangzhou CD that always stops 8787 before pull", () => {
    assert.equal(scriptBytes[0], 0xef);
    assert.equal(scriptBytes[1], 0xbb);
    assert.equal(scriptBytes[2], 0xbf);
    assert.match(script, /UTF-8 with BOM/);
    assert.match(script, /Hangzhou production CD/);
    assert.match(script, /live pull-while-serving is gone/);
    assert.match(script, /function Fetch-OriginMain/);
    assert.match(script, /git update-ref -d refs\/remotes\/origin\/main/);
    assert.match(script, /cannot lock ref 'refs\/remotes\/origin\/main'/);
    assert.match(script, /网络\/401\/Clash 失败不要动 origin\/main/);
    assert.match(script, /^Fetch-OriginMain$/m);
    assert.match(script, /function Invoke-GitFetch/);
    assert.match(script, /NativeCommandError from git stderr/);
    assert.match(script, /\$ErrorActionPreference = "Continue"/);
    assert.ok(indexOf(/^Fetch-OriginMain$/m) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.ok(indexOf(/function Invoke-GitFetch/) < indexOf(/fetch origin \*> \$LogPath/));
    assert.ok(indexOf(/\$ErrorActionPreference = "Continue"/) < indexOf(/fetch origin \*> \$LogPath/));
    assert.ok(indexOf(/checkout HEAD -- scripts\/windows\/release\.ps1/) < indexOf(/^Fetch-OriginMain$/m));
    assert.ok(indexOf(/function Invoke-GitFetch/) < indexOf(/^Fetch-OriginMain$/m));
    assert.doesNotMatch(script, /Write-Host \$msg/);
    assert.match(script, /Remove-Item \$log -Force/);
    assert.match(script, /Get-Content \$log -Raw -Encoding \$enc/);
    assert.match(script, /\$global:LASTEXITCODE = \$code/);
    assert.ok(indexOf(/taskkill\.exe \/T \/F \/PID/) < indexOf(/Invoke-Git merge --ff-only origin\/main/));
  });

  it("resets npm-dirty lockfile and refuses other tracked dirt before stopping 8787", () => {
    assert.ok(indexOf(/Invoke-Git checkout -- package-lock.json/) < indexOf(/工作树有未提交改动，拒绝停 8787/));
    assert.ok(indexOf(/Invoke-Git checkout -- package-lock.json/) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.ok(indexOf(/Invoke-Git checkout main/) < indexOf(/工作树有未提交改动，拒绝停 8787/));
    assert.ok(indexOf(/Invoke-Git checkout main/) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.ok(indexOf(/工作树有未提交改动，拒绝停 8787/) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.ok(indexOf(/本地 main 比 origin\/main 多/) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.match(script, /status --porcelain --untracked-files=no/);
    assert.match(script, /origin\/main\.\.HEAD/);
  });

  it("uses npm ci so the lockfile stays clean, then optional Windows Rollup", () => {
    assert.match(script, /npm ci/);
    assert.match(script, /npm ci 失败/);
    assert.match(script, /lockfile unchanged, skip npm ci/);
    assert.doesNotMatch(script, /throw "npm install 失败/);
    assert.ok(indexOf(/function Clear-GithubToken/) < indexOf(/\$didCi = \$true/));
    assert.match(script, /\$didCi = \$true/);
    assert.match(script, /--no-save --no-package-lock/);
    assert.match(script, /Remove-Item Env:GITHUB_TOKEN/);
  });

  it("restarts the last schtasks listener if upgrade fails after stop", () => {
    assert.match(script, /function Restore-BeianListener/);
    assert.match(script, /function Restore-BeianUpgrade/);
    assert.match(script, /cmd\.exe \/c "schtasks \/Run \/TN beian-server-8787"/);
    assert.match(script, /拉回失败 schtasks exit=/);
    assert.match(script, /拉回后 health 仍空/);
    assert.match(script, /已拉回 :8787/);
    assert.match(script, /:8787 没听，schtasks \/Run beian-server-8787/);
    assert.match(script, /:8787 仍在听，不重复拉起/);
    assert.match(script, /公网可能 502/);
    assert.match(script, /pre-stop SHA=/);
    assert.match(script, /git reset --hard \$PreSha/);
    assert.match(script, /Restore-BeianUpgrade "升版失败"/);
    assert.match(script, /} catch \{\s*Restore-BeianUpgrade "升版失败" \$preSha \$didCi \$didBuild\s*throw/s);
    assert.ok(indexOf(/npm ci/) < indexOf(/Restore-BeianUpgrade "升版失败"/));
    assert.ok(indexOf(/npm run build -w beian-ui/) < indexOf(/Restore-BeianUpgrade "升版失败"/));
    assert.ok(indexOf(/Invoke-Git merge --ff-only origin\/main/) < indexOf(/Restore-BeianUpgrade "升版失败"/));
  });

  it("does not use PowerShell automatic \$PID", () => {
    assert.doesNotMatch(script, /(?<![\w])\$PID(?![\w])/i);
    assert.match(script, /\$pid8787/);
  });

  it("fail-closes health and drains running plus queued", () => {
    assert.doesNotMatch(script, /当作空闲继续 pull/);
    assert.match(script, /health 没有 jobs，拒绝升版/);
    assert.match(script, /health 没有 uploads，拒绝升版/);
    assert.match(script, /function Assert-LegacyUploadsIdle/);
    assert.match(script, /\.incoming-\*/);
    assert.match(script, /AddMinutes\(-30\)/);
    assert.match(script, /health\.uploads 不完整，拒绝升版/);
    assert.match(script, /\$activeUploads -gt 0 -or \$waitingUploads -gt 0/);
    assert.match(script, /\$running -gt 0 -or \$queued -gt 0/);
    assert.match(script, /:8787 在听但 \/api\/health 失败，拒绝当空闲/);
    assert.match(script, /没有 python\/blender\/illustrator，当作空机继续/);
    assert.match(script, /Get-SlotCount \$HealthObj \$name "queued"/);
  });

  it("kills only the 8787 tree, never all node.exe, never cloudflared", () => {
    assert.doesNotMatch(script, /taskkill\s+\/IM\s+node/i);
    assert.doesNotMatch(script, /Get-Process\s+node/i);
    assert.doesNotMatch(script, /Stop-Process\s+-Name\s+node/i);
    assert.doesNotMatch(script, /cloudflared\s+tunnel/i);
    assert.match(script, /taskkill\.exe \/T \/F \/PID \$pid8787/);
    assert.match(script, /不要动 cloudflared/);
    assert.match(script, /PID 为 0 或解析失败，拒绝盲杀 node\.exe/);
    assert.match(script, /Test-PortListening 8787/);
  });

  it("validates WB_DATA_DIR with a directory boundary before taskkill", () => {
    assert.ok(indexOf(/Test-DataDirInsideRepo/) < indexOf(/taskkill\.exe \/T \/F \/PID/));
    assert.match(script, /WB_DATA_DIR 不能在仓库内/);
    assert.match(script, /DirectorySeparatorChar/);
    assert.match(script, /WB_PUBLIC = "1"/);
    assert.match(script, /WB_DEV_DISPLAY_LOGIN = "false"/);
    assert.match(script, /C:\\supply\\data/);
  });

  it("smokes version equality and PNG magic, starts beian-server", () => {
    assert.match(script, /http:\/\/127\.0\.0\.1:8787\/api\/health/);
    assert.match(script, /\/brand\/logo-mark\.png/);
    assert.match(script, /health\.version=\$\(\$health\.version\) 但 VERSION=\$ver，拒绝 SMOKE ok/);
    assert.match(script, /logo 不是 PNG/);
    assert.match(script, /0x89/);
    assert.match(script, /schtasks \/Run \/TN \$task/);
    assert.match(script, /npm\.cmd run start -w beian-server/);
    assert.match(script, /job process tree/);
    assert.ok(indexOf(/install @rollup\/rollup-win32-x64-msvc/) < indexOf(/\$didBuild = \$true/));
  });

  it("pip installs backend requirements into WB_PYTHON before start", () => {
    assert.match(script, /pip install -r apps\/web\/backend\/requirements.txt/);
    assert.match(script, /pip install 失败/);
    assert.match(script, /--disable-pip-version-check/);
    assert.match(script, /\$env:WB_PYTHON/);
    assert.match(script, /apps\\web\\backend\\.venv\\Scripts\\python\.exe/);
    assert.match(script, /& \$py -m pip install -r \$req/);
    assert.match(script, /找不到 Python/);
    assert.ok(indexOf(/npm run build -w beian-ui/) < indexOf(/pip install -r apps\/web\/backend\/requirements.txt/));
    assert.ok(indexOf(/pip install -r apps\/web\/backend\/requirements.txt/) < indexOf(/start beian-server/));
  });

  it("Actions runner drops dirty lockfile before invoking on-disk release.ps1", () => {
    const ymlPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../.github/workflows/hangzhou-release.yml");
    const yml = readFileSync(ymlPath, "utf8");
    assert.match(yml, /shell: cmd/);
    assert.match(yml, /^[^#\n]*git -C D:\\beian checkout -- package-lock\.json/m);
    assert.match(yml, /if errorlevel 1 exit \/b 1/);
    assert.match(yml, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File D:\\beian\\scripts\\windows\\release\.ps1/);
    assert.match(yml, /^\s+shell: cmd\s*$/m);
    assert.doesNotMatch(yml, /^\s+shell: powershell\s*$/m);
    assert.match(yml, /if: failure\(\)/);
    assert.match(yml, /schtasks \/Run \/TN beian-server-8787/);
    assert.match(yml, /^[^#\n]*git -C D:\\beian fetch origin/m);
    assert.match(yml, /^[^#\n]*git -C D:\\beian checkout origin\/main -- scripts\/windows\/release\.ps1/m);
    const lockIdx = yml.search(/^[^#\n]*git -C D:\\beian checkout -- package-lock\.json/m);
    const fetchIdx = yml.search(/^[^#\n]*git -C D:\\beian fetch origin/m);
    const ps1Idx = yml.search(/^[^#\n]*git -C D:\\beian checkout origin\/main -- scripts\/windows\/release\.ps1/m);
    const runIdx = yml.indexOf("D:\\beian\\scripts\\windows\\release.ps1");
    const failIdx = yml.indexOf("if: failure()");
    assert.ok(lockIdx >= 0 && fetchIdx > lockIdx && ps1Idx > fetchIdx && runIdx > ps1Idx && failIdx > runIdx);
    assert.doesNotMatch(yml, /GITHUB_TOKEN/);
  });

  it("uses GITHUB_TOKEN for git when Actions provides it, never prints the token", () => {
    assert.match(script, /function Invoke-Git/);
    assert.match(script, /http.extraheader=AUTHORIZATION: bearer/);
    assert.match(script, /function Invoke-GitFetch/);
    assert.match(script, /Invoke-GitFetch -LogPath \$log/);
    assert.match(script, /Invoke-Git merge --ff-only origin\/main/);
    assert.doesNotMatch(script, /Write-Host.*GITHUB_TOKEN/);
    assert.match(script, /GITHUB_TOKEN/);
  });
});
