import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/windows/release.ps1"),
  "utf8",
);

describe("windows release.ps1 contract", () => {
  it("exists and is Hangzhou CD, not a product HTTP rewrite", () => {
    assert.match(script, /Hangzhou production CD/);
    assert.match(script, /\[switch\]\$Restart/);
  });

  it("does not use PowerShell automatic \$PID", () => {
    assert.doesNotMatch(script, /(?<![\w])\$PID(?![\w])/i);
    assert.match(script, /\$pid8787/);
  });

  it("drains OCR, Blender, and Illustrator before pull", () => {
    assert.match(script, /Get-SlotRunning \$health "ocr"/);
    assert.match(script, /Get-SlotRunning \$health "blender"/);
    assert.match(script, /Get-SlotRunning \$health "illustrator"/);
    assert.match(script, /对照或打样在跑，禁止升版/);
    assert.match(script, /编完后对照或打样已在跑，禁止重启/);
  });

  it("does not kill all node.exe or restart cloudflared", () => {
    assert.doesNotMatch(script, /taskkill/i);
    assert.doesNotMatch(script, /Get-Process\s+node/i);
    assert.doesNotMatch(script, /Stop-Process\s+-Name\s+node/i);
    assert.doesNotMatch(script, /cloudflared\s+tunnel/i);
    assert.match(script, /不要动 cloudflared/);
    assert.match(script, /Get-ListenerPid 8787/);
    assert.match(script, /Stop-Process -Id \$pid8787/);
    assert.match(script, /git pull --ff-only origin main/);
    assert.match(script, /8787 仍被占用，拒绝再起一个 Node/);
  });

  it("smokes loopback health and brand logo, refuses in-repo WB_DATA_DIR", () => {
    assert.match(script, /http:\/\/127\.0\.0\.1:8787\/api\/health/);
    assert.match(script, /\/brand\/logo-mark\.png/);
    assert.match(script, /WB_PUBLIC=1/);
    assert.match(script, /WB_DATA_DIR 不能在仓库内/);
    assert.match(script, /npm run start -w beian-server/);
  });

  it("keeps fail-closed copy for idle pull, missing listener, start, and version drift", () => {
    assert.match(script, /:8787 没响应，当作空闲继续 pull/);
    assert.match(script, /git fetch origin/);
    assert.match(script, /git checkout main/);
    assert.match(script, /npm install/);
    assert.match(script, /npm run build -w beian-ui/);
    assert.match(script, /health 还在但找不到 8787 监听进程，拒绝盲杀 node\.exe/);
    assert.match(script, /C:\\supply\\data/);
    assert.match(script, /WB_DEV_DISPLAY_LOGIN = "false"/);
    assert.match(script, /Start-Process -FilePath "npm\.cmd"/);
    assert.match(script, /重启后 :8787 \/api\/health 没起来/);
    assert.match(script, /本机 :8787 无 health/);
    assert.match(script, /health\.version=\$\(\$health\.version\) 但 VERSION=/);
  });
});
