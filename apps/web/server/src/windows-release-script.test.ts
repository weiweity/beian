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
    assert.ok(indexOf(/taskkill\.exe \/T \/F \/PID/) < indexOf(/git pull --ff-only origin main/));
  });

  it("does not use PowerShell automatic \$PID", () => {
    assert.doesNotMatch(script, /(?<![\w])\$PID(?![\w])/i);
    assert.match(script, /\$pid8787/);
  });

  it("fail-closes health and drains running plus queued", () => {
    assert.doesNotMatch(script, /当作空闲继续 pull/);
    assert.match(script, /health 没有 jobs，拒绝升版/);
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
    assert.ok(indexOf(/@rollup\/rollup-win32-x64-msvc/) < indexOf(/npm run build -w beian-ui/));
  });

  it("uses GITHUB_TOKEN for git when Actions provides it, never prints the token", () => {
    assert.match(script, /function Invoke-Git/);
    assert.match(script, /http.extraheader=AUTHORIZATION: bearer/);
    assert.match(script, /Invoke-Git fetch origin/);
    assert.match(script, /Invoke-Git pull --ff-only origin main/);
    assert.doesNotMatch(script, /Write-Host.*GITHUB_TOKEN/);
    assert.match(script, /GITHUB_TOKEN/);
  });
});
